using System.Collections.Concurrent;
using System.Text.Json;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.TvItemLayout.Providers;

public sealed class TrendingPrewarmService : IHostedService, IDisposable
{
    private readonly TmdbProviderSource _source;
    private readonly TmdbLibraryIndex _libraryIndex;
    private readonly IApplicationPaths _paths;
    private readonly ILogger<TrendingPrewarmService> _logger;

    private readonly ConcurrentDictionary<string, Guid[]> _precomputedMatches = new(StringComparer.Ordinal);
    private readonly CancellationTokenSource _cts = new();
    private readonly SemaphoreSlim _diskSaveLock = new(1, 1);
    private Task? _backgroundTask;
    private bool _disposed;

    public TrendingPrewarmService(
        TmdbProviderSource source,
        TmdbLibraryIndex libraryIndex,
        IApplicationPaths paths,
        ILogger<TrendingPrewarmService> logger)
    {
        _source = source;
        _libraryIndex = libraryIndex;
        _paths = paths;
        _logger = logger;

        _source.CacheUpdated += OnCacheUpdated;
    }

    private string CacheFilePath => Path.Combine(_paths.DataPath, "jellyfin-cinema", "cache", "trending-cache.json");

    public Task StartAsync(CancellationToken cancellationToken)
    {
        // 1. Immediately load from disk synchronously to ensure 0s response time even on fresh start
        LoadFromDisk();

        // 2. Start background prewarming loop (non-blocking)
        _backgroundTask = Task.Run(() => BackgroundLoopAsync(_cts.Token));

        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        _cts.Cancel();
        if (_backgroundTask is not null)
        {
            try
            {
                await _backgroundTask.WaitAsync(TimeSpan.FromSeconds(5), cancellationToken).ConfigureAwait(false);
            }
            catch { }
        }
    }

    private void LoadFromDisk()
    {
        try
        {
            var path = CacheFilePath;
            if (!File.Exists(path)) return;

            var json = File.ReadAllText(path);
            var entries = JsonSerializer.Deserialize<Dictionary<string, TrendingDiskEntry>>(json);
            if (entries is { Count: > 0 })
            {
                _source.ImportCache(entries);
                _logger.LogInformation("TrendingPrewarmService: Loaded {Count} cached trending lists from disk.", entries.Count);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "TrendingPrewarmService: Could not load trending cache from disk.");
        }
    }

    public async Task SaveToDiskAsync(CancellationToken cancellationToken = default)
    {
        await _diskSaveLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var path = CacheFilePath;
            var dir = Path.GetDirectoryName(path)!;
            if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);

            var data = _source.ExportCache();
            var json = JsonSerializer.Serialize(data, new JsonSerializerOptions { WriteIndented = true });
            var tmp = path + ".tmp";
            await File.WriteAllTextAsync(tmp, json, cancellationToken).ConfigureAwait(false);
            File.Move(tmp, path, overwrite: true);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "TrendingPrewarmService: Failed to save trending cache to disk.");
        }
        finally
        {
            _diskSaveLock.Release();
        }
    }

    private void OnCacheUpdated()
    {
        _ = Task.Run(async () =>
        {
            try
            {
                await SaveToDiskAsync(_cts.Token).ConfigureAwait(false);
            }
            catch { }
        });
    }

    private async Task BackgroundLoopAsync(CancellationToken token)
    {
        try
        {
            // First: wait a couple seconds for server boot, then ensure TmdbLibraryIndex is populated
            await Task.Delay(TimeSpan.FromSeconds(2), token).ConfigureAwait(false);
            await _libraryIndex.EnsureInitializedAsync(token).ConfigureAwait(false);

            // Prewarm all configured and default providers
            await PrewarmAllAsync(token, forceRefresh: false).ConfigureAwait(false);

            // 6-hour recurring loop (Stale-While-Revalidate refresh)
            while (!token.IsCancellationRequested)
            {
                await Task.Delay(TimeSpan.FromHours(6), token).ConfigureAwait(false);
                await PrewarmAllAsync(token, forceRefresh: true).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            _logger.LogError(ex, "TrendingPrewarmService: Error in background loop.");
        }
    }

    public async Task PrewarmAllAsync(CancellationToken token, bool forceRefresh)
    {
        _logger.LogInformation("TrendingPrewarmService: Pre-warming trending lists (forceRefresh={ForceRefresh})...", forceRefresh);
        var providersToWarm = GetProvidersToPrewarm();

        foreach (var (providerId, movieIds, showIds) in providersToWarm)
        {
            if (token.IsCancellationRequested) break;

            if (movieIds.Length > 0)
            {
                try
                {
                    var tmdbIds = await _source.DiscoverTrendingTmdbIdsAsync("Movie", movieIds, token, forceRefresh).ConfigureAwait(false);
                    UpdatePrecomputedMatches(providerId, "Movie", tmdbIds);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    _logger.LogDebug(ex, "Trending prewarm failed for {Provider} (Movie).", providerId);
                }
            }

            if (showIds.Length > 0)
            {
                try
                {
                    var tmdbIds = await _source.DiscoverTrendingTmdbIdsAsync("Series", showIds, token, forceRefresh).ConfigureAwait(false);
                    UpdatePrecomputedMatches(providerId, "Series", tmdbIds);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    _logger.LogDebug(ex, "Trending prewarm failed for {Provider} (Series).", providerId);
                }
            }
        }

        await SaveToDiskAsync(token).ConfigureAwait(false);
        _logger.LogInformation("TrendingPrewarmService: Pre-warming complete.");
    }

    private void UpdatePrecomputedMatches(string providerId, string mediaType, int[] tmdbIds)
    {
        var matched = new List<Guid>();
        var isMovie = mediaType == "Movie";
        foreach (var tmdbId in tmdbIds)
        {
            if (isMovie)
            {
                if (_libraryIndex.TryGetMovie(tmdbId, out var id)) matched.Add(id);
            }
            else
            {
                if (_libraryIndex.TryGetSeries(tmdbId, out var id)) matched.Add(id);
            }
        }
        _precomputedMatches[$"{providerId}:{mediaType}"] = matched.ToArray();
    }

    public bool TryGetPrecomputedGuids(string providerId, string mediaType, out Guid[] guids)
    {
        return _precomputedMatches.TryGetValue($"{providerId}:{mediaType}", out guids!);
    }

    private List<(string ProviderId, int[] MovieIds, int[] ShowIds)> GetProvidersToPrewarm()
    {
        var results = new Dictionary<string, (int[] MovieIds, int[] ShowIds)>(StringComparer.OrdinalIgnoreCase);

        // 1. Read from _global.json if it exists
        try
        {
            var globalPath = Path.Combine(_paths.DataPath, "jellyfin-cinema", "provider-homes", "_global.json");
            if (File.Exists(globalPath))
            {
                var doc = JsonDocument.Parse(File.ReadAllText(globalPath));
                if (doc.RootElement.TryGetProperty("Settings", out var settings)
                    && settings.TryGetProperty("providers", out var providers)
                    && providers.ValueKind == JsonValueKind.Array)
                {
                    foreach (var provider in providers.EnumerateArray())
                    {
                        var id = provider.GetProperty("id").GetString();
                        if (string.IsNullOrWhiteSpace(id)) continue;
                        var movieIds = provider.TryGetProperty("movieProviderIds", out var m) && m.ValueKind == JsonValueKind.Array
                            ? m.EnumerateArray().Select(x => x.GetInt32()).ToArray() : [];
                        var showIds = provider.TryGetProperty("showProviderIds", out var s) && s.ValueKind == JsonValueKind.Array
                            ? s.EnumerateArray().Select(x => x.GetInt32()).ToArray() : [];
                        results[id] = (movieIds, showIds);
                    }
                }
            }
        }
        catch { }

        // 2. Include all known preset brands
        var presets = new[] { "netflix", "prime", "max", "globoplay", "disney", "crunchyroll", "apple", "paramount", "discovery", "wetv", "brasilparalelo", "viki" };
        foreach (var preset in presets)
        {
            if (!results.ContainsKey(preset))
            {
                results[preset] = (ProviderHomesSchema.DefaultIds(preset, false), ProviderHomesSchema.DefaultIds(preset, true));
            }
        }

        return results.Select(kv => (kv.Key, kv.Value.MovieIds, kv.Value.ShowIds)).ToList();
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _cts.Cancel();
        _cts.Dispose();
        _diskSaveLock.Dispose();
        _source.CacheUpdated -= OnCacheUpdated;
    }
}
