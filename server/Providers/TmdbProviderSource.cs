using System.Collections.Concurrent;
using System.Net;
using System.Reflection;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.TvItemLayout.Providers;

/// <summary>Streaming availability is supplied by TMDB/JustWatch, not studio or network names.</summary>
public sealed partial class TmdbProviderSource(IHttpClientFactory clients, TimeProvider? directoryClock = null)
{
    public const string Region = "BR";
    private readonly ConcurrentDictionary<string, (DateTimeOffset Expires, int[] TmdbIds)> trendingCache = new(StringComparer.Ordinal);
    private long rateLimitedUntil;
    public static bool ValidProvider(string id) => ProviderHomesSchema.ValidProvider(id);
    public static bool Includes(string provider, string type, IEnumerable<int> ids)
        => ids.Any(ProviderHomesSchema.DefaultIds(provider, type == "Series").Contains);

    // Reuse Jellyfin's installed TMDB integration. Reflection keeps this plugin compatible
    // with all supported servers without bundling a second TMDB plugin or copying its key.
    public static string? NativeApiKey()
    {
        foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
        {
            var plugin = assembly.GetType("MediaBrowser.Providers.Plugins.Tmdb.Plugin", false);
            try
            {
                var instance = plugin?.GetProperty("Instance", BindingFlags.Static | BindingFlags.Public)?.GetValue(null);
                var configuration = instance?.GetType().GetProperty("Configuration")?.GetValue(instance);
                var configured = configuration?.GetType().GetProperty("TmdbApiKey")?.GetValue(configuration) as string;
                if (!string.IsNullOrWhiteSpace(configured)) return configured.Trim();
                var utils = assembly.GetType("MediaBrowser.Providers.Plugins.Tmdb.TmdbUtils", false);
                var fallback = utils?.GetField("ApiKey", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)?.GetValue(null) as string;
                if (!string.IsNullOrWhiteSpace(fallback)) return fallback.Trim();
            }
            catch (Exception exception) when (exception is TargetInvocationException or MemberAccessException or ArgumentException) { }
        }
        return null;
    }

    public bool Available => NativeApiKey() is not null;
    public async Task<ProviderMembership> FetchAsync(string key, CancellationToken cancellationToken)
    {
        if (!Regex.IsMatch(key, "^(movie|tv):[1-9][0-9]{0,9}$", RegexOptions.CultureInvariant))
            throw new ArgumentException("Invalid provider lookup key.", nameof(key));
        var apiKey = NativeApiKey() ?? throw new ProviderLookupException("TMDB is unavailable.");
        while (true)
        {
            var remaining = new DateTimeOffset(Interlocked.Read(ref rateLimitedUntil), TimeSpan.Zero) - DateTimeOffset.UtcNow;
            if (remaining <= TimeSpan.Zero) break;
            await Task.Delay(remaining, cancellationToken);
            // Another in-flight response can extend the cooldown while this worker waits.
        }
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(15));
        var requestToken = timeout.Token;
        var pieces = key.Split(':');
        // Never log this URI, exception text from HttpClient, or any credential.
        using var request = new HttpRequestMessage(HttpMethod.Get,
            $"https://api.themoviedb.org/3/{pieces[0]}/{pieces[1]}/watch/providers?api_key={Uri.EscapeDataString(apiKey)}");
        using var response = await clients.CreateClient("JellyfinCinemaProviders").SendAsync(request, HttpCompletionOption.ResponseHeadersRead, requestToken);
        if (!response.IsSuccessStatusCode)
        {
            // Deleted TMDB IDs are an authoritative negative, but transient failures must not erase cached availability.
            if (response.StatusCode == HttpStatusCode.NotFound) return ProviderMembership.Empty;
            var delay = response.Headers.RetryAfter?.Delta ?? (response.Headers.RetryAfter?.Date - DateTimeOffset.UtcNow);
            if (response.StatusCode == HttpStatusCode.TooManyRequests)
            {
                var pause = delay is { } retry && retry > TimeSpan.FromSeconds(30) ? retry : TimeSpan.FromSeconds(30);
                if (pause > TimeSpan.FromHours(6)) pause = TimeSpan.FromHours(6);
                // A server-wide rate limit must also pause the other workers, not just this title.
                ExtendCooldown((DateTimeOffset.UtcNow + pause).Ticks);
            }
            throw new ProviderLookupException("TMDB availability request failed.", delay);
        }
        await using var stream = await response.Content.ReadAsStreamAsync(requestToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: requestToken);
        return Parse(document.RootElement);
    }

    private void ExtendCooldown(long deadline)
    {
        var observed = Interlocked.Read(ref rateLimitedUntil);
        while (deadline > observed)
        {
            var current = Interlocked.CompareExchange(ref rateLimitedUntil, deadline, observed);
            if (current == observed) return;
            observed = current;
        }
    }

    public static ProviderMembership Parse(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Object)
            throw new ProviderLookupException("TMDB returned invalid availability data.");
        if (!results.TryGetProperty(Region, out var country)) return ProviderMembership.Empty;
        if (country.ValueKind != JsonValueKind.Object) throw new ProviderLookupException("TMDB returned invalid regional availability.");
        return new(ParseOffers(country, "flatrate"), ParseOffers(country, "free"), ParseOffers(country, "ads"));
    }

    private static int[] ParseOffers(JsonElement country, string category)
    {
        if (!country.TryGetProperty(category, out var rates)) return [];
        if (rates.ValueKind != JsonValueKind.Array) throw new ProviderLookupException("TMDB returned invalid streaming availability.");
        var ids = new HashSet<int>();
        foreach (var rate in rates.EnumerateArray())
        {
            if (rate.ValueKind != JsonValueKind.Object || !rate.TryGetProperty("provider_id", out var id)
                || id.ValueKind != JsonValueKind.Number || !id.TryGetInt32(out var number) || number <= 0)
                throw new ProviderLookupException("TMDB returned invalid streaming provider.");
            ids.Add(number);
        }
        return ids.Order().ToArray();
    }

    public async Task<int[]> DiscoverTrendingTmdbIdsAsync(string mediaType, int[] providerIds, CancellationToken cancellationToken)
    {
        var validIds = providerIds.Where(id => id > 0 && id <= 1000000).Distinct().ToArray();
        if (validIds.Length == 0) return [];
        var endpointType = mediaType.Equals("Series", StringComparison.OrdinalIgnoreCase) ? "tv" : "movie";
        var cacheKey = $"{endpointType}:{Region}:{string.Join("|", validIds.OrderBy(id => id))}";

        if (trendingCache.TryGetValue(cacheKey, out var cached) && DateTimeOffset.UtcNow < cached.Expires)
        {
            return cached.TmdbIds;
        }

        var apiKey = NativeApiKey() ?? throw new ProviderLookupException("TMDB is unavailable.");
        var providersParam = Uri.EscapeDataString(string.Join("|", validIds));
        var baseUri = $"https://api.themoviedb.org/3/discover/{endpointType}?watch_region={Region}&with_watch_providers={providersParam}&with_watch_monetization_types=flatrate|free|ads&sort_by=popularity.desc&language=pt-BR&api_key={Uri.EscapeDataString(apiKey)}";

        // Query up to 3 pages in parallel for a rich top 60 sample
        var pageTasks = Enumerable.Range(1, 3).Select(page => FetchDiscoverPageAsync($"{baseUri}&page={page}", cancellationToken)).ToArray();
        var pageResults = await Task.WhenAll(pageTasks);

        var orderedIds = new List<int>();
        var seen = new HashSet<int>();
        foreach (var page in pageResults)
        {
            foreach (var id in page)
            {
                if (seen.Add(id)) orderedIds.Add(id);
            }
        }

        var result = orderedIds.ToArray();
        if (result.Length > 0)
        {
            trendingCache[cacheKey] = (DateTimeOffset.UtcNow.AddHours(6), result);
        }
        return result;
    }

    private async Task<int[]> FetchDiscoverPageAsync(string url, CancellationToken cancellationToken)
    {
        while (true)
        {
            var remaining = new DateTimeOffset(Interlocked.Read(ref rateLimitedUntil), TimeSpan.Zero) - DateTimeOffset.UtcNow;
            if (remaining <= TimeSpan.Zero) break;
            await Task.Delay(remaining, cancellationToken);
        }

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(15));
        var requestToken = timeout.Token;

        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        using var response = await clients.CreateClient("JellyfinCinemaProviders").SendAsync(request, HttpCompletionOption.ResponseHeadersRead, requestToken);
        if (!response.IsSuccessStatusCode)
        {
            if (response.StatusCode == HttpStatusCode.NotFound) return [];
            var delay = response.Headers.RetryAfter?.Delta ?? (response.Headers.RetryAfter?.Date - DateTimeOffset.UtcNow);
            if (response.StatusCode == HttpStatusCode.TooManyRequests)
            {
                var pause = delay is { } retry && retry > TimeSpan.FromSeconds(30) ? retry : TimeSpan.FromSeconds(30);
                if (pause > TimeSpan.FromHours(6)) pause = TimeSpan.FromHours(6);
                ExtendCooldown((DateTimeOffset.UtcNow + pause).Ticks);
            }
            return [];
        }

        await using var stream = await response.Content.ReadAsStreamAsync(requestToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: requestToken);
        if (!document.RootElement.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Array)
            return [];

        var ids = new List<int>();
        foreach (var item in results.EnumerateArray())
        {
            if (item.TryGetProperty("id", out var idProp) && idProp.TryGetInt32(out var id) && id > 0)
            {
                ids.Add(id);
            }
        }
        return ids.ToArray();
    }
}

public sealed class ProviderLookupException(string message, TimeSpan? retryAfter = null) : Exception(message)
{
    public TimeSpan? RetryAfter { get; } = retryAfter;
}
