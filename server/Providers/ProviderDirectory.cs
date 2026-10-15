using System.Text.Json;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.TvItemLayout.Providers;

public sealed record ProviderDirectoryEntry(
    [property: JsonPropertyName("Id")] int Id,
    [property: JsonPropertyName("Name")] string Name);

public sealed record ProviderDirectory(
    [property: JsonPropertyName("Region")] string Region,
    [property: JsonPropertyName("Movies")] ProviderDirectoryEntry[] Movies,
    [property: JsonPropertyName("Shows")] ProviderDirectoryEntry[] Shows);

public sealed partial class TmdbProviderSource
{
    private readonly SemaphoreSlim directoryGate = new(1, 1);
    private readonly TimeProvider directoryTime = directoryClock ?? TimeProvider.System;
    private ProviderDirectory? directory;
    private DateTimeOffset directoryRefreshAfter;

    public async Task<ProviderDirectory> DirectoryAsync(CancellationToken cancellationToken)
    {
        await directoryGate.WaitAsync(cancellationToken);
        try
        {
            if (directoryTime.GetUtcNow() < directoryRefreshAfter)
                return directory ?? throw new ProviderLookupException("Streaming service list is temporarily unavailable. Try again.");
            try
            {
                var apiKey = NativeApiKey() ?? throw new ProviderLookupException("Streaming service list is unavailable.");
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                timeout.CancelAfter(TimeSpan.FromSeconds(15));
                var lists = await Task.WhenAll(DirectoryForType("movie", apiKey, timeout.Token), DirectoryForType("tv", apiKey, timeout.Token));
                directory = new(Region, lists[0], lists[1]);
                directoryRefreshAfter = directoryTime.GetUtcNow().AddHours(24);
                return directory;
            }
            catch (Exception error) when (!cancellationToken.IsCancellationRequested
                && error is ProviderLookupException or HttpRequestException or IOException or JsonException or OperationCanceledException)
            {
                // Names and IDs are public metadata. Keep the last complete BR list
                // during a temporary upstream failure; never expose an HTTP URI/key.
                directoryRefreshAfter = directoryTime.GetUtcNow().AddMinutes(5);
                if (directory is not null) return directory;
                throw new ProviderLookupException("Streaming service list is temporarily unavailable. Try again.");
            }
        }
        finally { directoryGate.Release(); }
    }

    private async Task<ProviderDirectoryEntry[]> DirectoryForType(string type, string apiKey, CancellationToken cancellationToken)
    {
        // Both documented endpoints support watch_region; film and TV IDs must
        // remain separate because a provider can use different regional IDs.
        using var request = new HttpRequestMessage(HttpMethod.Get,
            $"https://api.themoviedb.org/3/watch/providers/{type}?watch_region={Region}&language=pt-BR&api_key={Uri.EscapeDataString(apiKey)}");
        using var response = await clients.CreateClient("JellyfinCinemaProviders").SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        if (!response.IsSuccessStatusCode) throw new ProviderLookupException("Streaming service list request failed.");
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, new JsonDocumentOptions { MaxDepth = 16 }, cancellationToken);
        return ParseDirectory(document.RootElement);
    }

    public static ProviderDirectoryEntry[] ParseDirectory(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("results", out var results)
            || results.ValueKind != JsonValueKind.Array || results.GetArrayLength() > 2000)
            throw new ProviderLookupException("Invalid streaming service list.");
        var entries = new Dictionary<int, ProviderDirectoryEntry>();
        foreach (var value in results.EnumerateArray())
        {
            if (value.ValueKind != JsonValueKind.Object || !value.TryGetProperty("provider_id", out var id)
                || id.ValueKind != JsonValueKind.Number || !id.TryGetInt32(out var number) || number is <= 0 or > 1000000
                || !value.TryGetProperty("provider_name", out var name) || name.ValueKind != JsonValueKind.String)
                throw new ProviderLookupException("Invalid streaming service name or identifier.");
            var rawName = name.GetString()!;
            var label = rawName.Trim();
            if (rawName.Length > 120 || label.Length < 1 || rawName.Any(char.IsControl))
                throw new ProviderLookupException("Invalid streaming service name.");
            if (value.TryGetProperty("display_priorities", out var priorities))
            {
                if (priorities.ValueKind != JsonValueKind.Object) throw new ProviderLookupException("Invalid streaming service region.");
                if (!priorities.TryGetProperty(Region, out _)) continue;
            }
            if (!entries.TryAdd(number, new(number, label))) throw new ProviderLookupException("Duplicate streaming service identifier.");
        }
        return entries.Values.OrderBy(entry => entry.Name, StringComparer.OrdinalIgnoreCase).ThenBy(entry => entry.Id).ToArray();
    }
}
