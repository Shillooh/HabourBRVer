using System.Text.Json;
using System.Threading.Channels;
using Microsoft.Extensions.Hosting;
using MediaBrowser.Common.Configuration;

namespace Jellyfin.Plugin.TvItemLayout.Providers;

public sealed record ProviderCacheEntry(ProviderMembership? Providers, DateTimeOffset? UpdatedAt, DateTimeOffset RetryAt, int Failures, bool Complete = true);
public sealed record ProviderCacheSnapshot(IReadOnlyDictionary<string, ProviderMembership> Memberships, int Pending, int FailedIds, int Total, DateTimeOffset? UpdatedAt, string Status);

/// <summary>A shared cache of public TMDB availability; it never stores user library IDs or permissions.</summary>
public sealed class ProviderAvailabilityCache(
    string path,
    Func<string, CancellationToken, Task<ProviderMembership>> fetch,
    Func<bool> available,
    Func<DateTimeOffset>? clock = null,
    string? legacyPath = null)
{
    public static readonly TimeSpan Lifetime = TimeSpan.FromDays(7);
    private readonly Func<DateTimeOffset> now = clock ?? (() => DateTimeOffset.UtcNow);
    private readonly object gate = new();
    private readonly Dictionary<string, ProviderCacheEntry> entries = new(StringComparer.Ordinal);
    private readonly HashSet<string> queued = new(StringComparer.Ordinal);
    private readonly Channel<string> jobs = Channel.CreateUnbounded<string>(new UnboundedChannelOptions { SingleWriter = false, SingleReader = false });
    private Task? loading;
    private long revision;
    private long savedRevision;
    private readonly SemaphoreSlim saving = new(1, 1);

    private Task Load()
    {
        lock (gate) return loading ??= LoadCore();
    }
    private async Task LoadCore()
    {
        try
        {
            if (!File.Exists(path)) { await ImportLegacy(); return; }
            // Cache is disposable. A corrupt/oversized cache is rebuilt, never allowed to block Home.
            if (new FileInfo(path).Length > 64 * 1024 * 1024) return;
            var saved = JsonSerializer.Deserialize<Dictionary<string, ProviderCacheEntry>>(await File.ReadAllTextAsync(path));
            if (saved is null) return;
            lock (gate)
                foreach (var (key, entry) in saved)
                    if (ValidKey(key) && entry is not null && entry.Providers is not null && entry.Providers.Valid && entry.UpdatedAt is not null && entry.UpdatedAt <= now().AddMinutes(5))
                        entries[key] = entry with { Failures = Math.Clamp(entry.Failures, 0, 10), RetryAt = entry.RetryAt > now().AddHours(6) ? now().AddHours(6) : entry.RetryAt };
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException) { }
    }

    private sealed record LegacyEntry(int[]? Providers, DateTimeOffset? UpdatedAt, DateTimeOffset RetryAt, int Failures);
    private async Task ImportLegacy()
    {
        if (legacyPath is null || !File.Exists(legacyPath) || new FileInfo(legacyPath).Length > 64 * 1024 * 1024) return;
        var saved = JsonSerializer.Deserialize<Dictionary<string, LegacyEntry>>(await File.ReadAllTextAsync(legacyPath));
        if (saved is null) return;
        lock (gate)
        {
            foreach (var (key, entry) in saved)
                if (ValidKey(key) && entry is not null && entry.Providers is { Length: <= 1000 } && entry.Providers.All(id => id > 0)
                    && entry.UpdatedAt is not null && entry.UpdatedAt <= now().AddMinutes(5))
                    entries[key] = new(new(entry.Providers.Distinct().Order().ToArray(), [], []), entry.UpdatedAt,
                        entry.RetryAt > now().AddHours(6) ? now().AddHours(6) : entry.RetryAt, Math.Clamp(entry.Failures, 0, 10), false);
            if (entries.Count > 0) revision++;
        }
        // Complete=false survives a restart. Retain known subscriptions, but
        // refresh unknown free/ad categories even when the old timestamp is new.
    }

    public static bool ValidKey(string key) => System.Text.RegularExpressions.Regex.IsMatch(key, "^(movie|tv):[1-9][0-9]{0,9}$", System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    public async Task<ProviderCacheSnapshot> ReadAsync(IEnumerable<string> requested, CancellationToken cancellationToken)
    {
        await Load().WaitAsync(cancellationToken);
        var keys = requested.Where(ValidKey).Distinct(StringComparer.Ordinal).ToArray();
        var canFetch = available();
        lock (gate)
        {
            var current = now();
            foreach (var key in keys)
            {
                entries.TryGetValue(key, out var entry);
                if (canFetch && (entry?.UpdatedAt is null || !entry.Complete || current - entry.UpdatedAt >= Lifetime)
                    && (entry is null || entry.RetryAt <= current) && queued.Add(key)) jobs.Writer.TryWrite(key);
            }
            var memberships = new Dictionary<string, ProviderMembership>(StringComparer.Ordinal);
            var pending = 0;
            var failedIds = 0;
            var active = false;
            var failed = false;
            DateTimeOffset? oldest = null;
            foreach (var key in keys)
            {
                entries.TryGetValue(key, out var entry);
                if (entry?.Providers is not null && entry.UpdatedAt is not null)
                {
                    memberships[key] = entry.Providers;
                    if (oldest is null || entry.UpdatedAt < oldest) oldest = entry.UpdatedAt;
                }
                else if (queued.Contains(key)) pending++;
                else failedIds++;
                active |= queued.Contains(key);
                failed |= entry?.Failures > 0 || entry?.Complete == false || (!canFetch && (entry?.UpdatedAt is null || !entry.Complete || current - entry.UpdatedAt >= Lifetime));
            }
            return new(memberships, pending, failedIds, keys.Length, oldest, active ? "refreshing" : failed ? "unavailable" : "ready");
        }
    }

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        await Load();
        var workers = Enumerable.Range(0, 3).Select(_ => Worker(cancellationToken)).Append(PersistLoop(cancellationToken));
        try { await Task.WhenAll(workers); }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
        finally { await FlushAsync(CancellationToken.None); }
    }

    private async Task Worker(CancellationToken cancellationToken)
    {
        await foreach (var key in jobs.Reader.ReadAllAsync(cancellationToken))
        {
            try
            {
                var providers = await fetch(key, cancellationToken);
                if (!providers.Valid) throw new ProviderLookupException("Invalid cached provider membership.");
                lock (gate) { entries[key] = new(providers, now(), DateTimeOffset.MinValue, 0); revision++; }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
            catch (Exception exception)
            {
                // Deliberately do not log exception details: upstream HTTP errors may include the API credential.
                lock (gate)
                {
                    entries.TryGetValue(key, out var prior);
                    var failures = Math.Min((prior?.Failures ?? 0) + 1, 10);
                    var retry = TimeSpan.FromSeconds(Math.Min(21600, 30 * Math.Pow(2, failures - 1)));
                    if (exception is ProviderLookupException { RetryAfter: { } requestedRetry } && requestedRetry > retry)
                        retry = requestedRetry > TimeSpan.FromHours(6) ? TimeSpan.FromHours(6) : requestedRetry;
                    entries[key] = new(prior?.Providers, prior?.UpdatedAt, now() + retry, failures, prior?.Complete ?? true);
                    revision++;
                }
            }
            finally { lock (gate) queued.Remove(key); }
            // Keep aggregate lookup throughput below TMDB's normal request ceiling.
            await Task.Delay(150, cancellationToken);
        }
    }

    private async Task PersistLoop(CancellationToken cancellationToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(2));
        while (await timer.WaitForNextTickAsync(cancellationToken)) await FlushAsync(cancellationToken);
    }

    public async Task FlushAsync(CancellationToken cancellationToken)
    {
        await saving.WaitAsync(cancellationToken);
        string? temporary = null;
        try
        {
            Dictionary<string, ProviderCacheEntry> snapshot;
            long currentRevision;
            lock (gate)
            {
                if (revision == savedRevision) return;
                currentRevision = revision;
                // Failed first attempts need not survive a server restart; successful stale data must.
                snapshot = entries.Where(pair => pair.Value.UpdatedAt is not null).ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
            }
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            await File.WriteAllTextAsync(temporary, JsonSerializer.Serialize(snapshot), cancellationToken);
            File.Move(temporary, path, true);
            lock (gate) savedRevision = currentRevision;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { }
        finally
        {
            if (temporary is not null)
                try { if (File.Exists(temporary)) File.Delete(temporary); }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { }
            saving.Release();
        }
    }
}

public interface IProviderAvailability
{
    Task<ProviderCacheSnapshot> ReadAsync(IEnumerable<string> keys, CancellationToken cancellationToken);
}

public sealed class ProviderAvailabilityService : BackgroundService, IProviderAvailability
{
    private readonly ProviderAvailabilityCache cache;
    public ProviderAvailabilityService(IApplicationPaths paths, TmdbProviderSource source)
        => cache = new(Path.Combine(paths.DataPath, "jellyfin-cinema", "providers", "BR-v2.json"), source.FetchAsync, () => source.Available,
            legacyPath: Path.Combine(paths.DataPath, "jellyfin-cinema", "providers", "BR-v1.json"));
    public Task<ProviderCacheSnapshot> ReadAsync(IEnumerable<string> keys, CancellationToken cancellationToken) => cache.ReadAsync(keys, cancellationToken);
    protected override Task ExecuteAsync(CancellationToken stoppingToken) => cache.RunAsync(stoppingToken);
}
