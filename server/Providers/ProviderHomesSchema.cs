using System.Text.Json;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.TvItemLayout.Providers;

public sealed record ConfiguredProvider(int[] MovieProviderIds, int[] ShowProviderIds, string[] OfferTypes, bool Enabled);

/// <summary>Strict versioned account preferences; availability IDs never become upstream URLs.</summary>
public static class ProviderHomesSchema
{
    public static bool KnownBrand(string id) => id is "netflix" or "prime" or "max" or "globoplay" or "disney" or "crunchyroll" or "apple"
        or "paramount" or "discovery" or "wetv" or "brasilparalelo" or "viki";
    public static bool LegacyProvider(string id) => KnownBrand(id) || id is "now";
    public static bool BroadcastProvider(string id) => id is "bbc" or "itvx" or "channel4";
    public static bool ValidProvider(string id) => KnownBrand(id) || LegacyProvider(id) || BroadcastProvider(id)
        || Regex.IsMatch(id, @"\Acustom-[a-z0-9-]{1,57}\z", RegexOptions.CultureInvariant);
    public static int[] DefaultIds(string id, bool series = false) => id switch
    {
        "netflix" => [8, 175, 1796],
        "prime" => [119, 9, 2100],
        "max" => [1899],
        "globoplay" => [307],
        "disney" => [337],
        "crunchyroll" => [283],
        "apple" => [350],
        "paramount" => [531, 2303, 2304],
        "discovery" => [524],
        "wetv" => [623],
        "brasilparalelo" => [6265],
        "viki" => [344, 1390],
        "now" => series ? [39] : [591],
        "bbc" => [38], "itvx" => [41], "channel4" => [103], _ => []
    };
    public static ConfiguredProvider? Resolve(JsonElement? settings, string id)
    {
        ConfiguredProvider? Default() => LegacyProvider(id) || BroadcastProvider(id)
            ? new(DefaultIds(id), DefaultIds(id, true), BroadcastProvider(id) ? ["free", "ads"] : ["flatrate"], true) : null;
        if (settings is null) return Default();
        var value = settings.Value;
        var providers = value.GetProperty("providers");
        var legacy = value.GetProperty("version").GetInt32() == 1;
        foreach (var provider in providers.EnumerateArray())
        {
            if (provider.GetProperty("id").GetString() != id) continue;
            var enabled = provider.GetProperty("enabled").GetBoolean();
            return legacy ? Default()! with { Enabled = enabled } : new(
                provider.GetProperty("movieProviderIds").EnumerateArray().Select(item => item.GetInt32()).ToArray(),
                provider.GetProperty("showProviderIds").EnumerateArray().Select(item => item.GetInt32()).ToArray(),
                provider.GetProperty("offerTypes").EnumerateArray().Select(item => item.GetString()!).ToArray(), enabled);
        }
        // Match the client migration: append new broadcasters to populated v1
        // preferences, while an explicitly empty provider list remains empty.
        return legacy && providers.GetArrayLength() > 0 && BroadcastProvider(id) ? Default() : null;
    }

    private static bool Properties(JsonElement value, params string[] allowed) => value.ValueKind == JsonValueKind.Object
        && value.EnumerateObject().All(property => allowed.Contains(property.Name, StringComparer.Ordinal))
        && value.EnumerateObject().Select(property => property.Name).Distinct().Count() == value.EnumerateObject().Count();
    private static bool Text(JsonElement value, string key, int maximum, bool empty = true) => value.TryGetProperty(key, out var text)
        && text.ValueKind == JsonValueKind.String && text.GetString()!.Length <= maximum && (empty || text.GetString()!.Length > 0);
    private static bool Boolean(JsonElement value, string key) => value.TryGetProperty(key, out var boolean)
        && boolean.ValueKind is JsonValueKind.True or JsonValueKind.False;
    private static bool Choice(JsonElement value, string key, params string[] choices) => value.TryGetProperty(key, out var choice)
        && choice.ValueKind == JsonValueKind.String && choices.Contains(choice.GetString(), StringComparer.Ordinal);
    private static bool Ids(JsonElement value, string key) => value.TryGetProperty(key, out var ids) && ids.ValueKind == JsonValueKind.Array
        && ids.GetArrayLength() <= 20 && ids.EnumerateArray().All(id => id.ValueKind == JsonValueKind.Number && id.TryGetInt32(out var number) && number is > 0 and <= 1000000)
        && ids.EnumerateArray().Select(id => id.GetInt32()).Distinct().Count() == ids.GetArrayLength();
    private static bool Logo(JsonElement value)
    {
        if (!Text(value, "logoUrl", 2048)) return false;
        var url = value.GetProperty("logoUrl").GetString()!;
        return url.Length == 0 || !url.Any(char.IsWhiteSpace) && Regex.IsMatch(url, "^https?://", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)
            && Uri.TryCreate(url, UriKind.Absolute, out var parsed) && parsed.Scheme is "http" or "https"
            && parsed.Host.Length > 0 && parsed.UserInfo.Length == 0;
    }
    private static bool Offers(JsonElement value) => value.TryGetProperty("offerTypes", out var offers) && offers.ValueKind == JsonValueKind.Array
        && offers.GetArrayLength() is >= 1 and <= 3 && offers.EnumerateArray().All(offer => offer.ValueKind == JsonValueKind.String && offer.GetString() is "flatrate" or "free" or "ads")
        && offers.EnumerateArray().Select(offer => offer.GetString()).Distinct().Count() == offers.GetArrayLength();

    public static bool ValidSettings(JsonElement settings)
    {
        if (settings.ValueKind != JsonValueKind.Object || !settings.TryGetProperty("version", out var version) || version.ValueKind != JsonValueKind.Number
            || !version.TryGetInt32(out var number) || number is not (1 or 2)) return false;
        var legacy = number == 1;
        if (!Properties(settings, legacy ? ["version", "enabled", "title", "placement", "providers"]
            : ["version", "enabled", "title", "placement", "tileScale", "showNames", "providers"])
            || !Boolean(settings, "enabled") || !Text(settings, "title", 80) || !Text(settings, "placement", 240, false)
            || !settings.TryGetProperty("providers", out var providers) || providers.ValueKind != JsonValueKind.Array
            || providers.GetArrayLength() > (legacy ? 6 : 24)) return false;
        if (!legacy && (!Boolean(settings, "showNames") || !settings.TryGetProperty("tileScale", out var scale)
            || scale.ValueKind != JsonValueKind.Number || !scale.TryGetInt32(out var scaleNumber) || scaleNumber is < 70 or > 150)) return false;
        var placement = settings.GetProperty("placement").GetString()!;
        if (placement is not ("start" or "end") && (!placement.StartsWith("native:", StringComparison.Ordinal) || placement.Length == 7)) return false;
        var providerIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var provider in providers.EnumerateArray())
        {
            if (!Properties(provider, legacy ? ["id", "enabled", "hero", "rows"]
                : ["id", "name", "logoUrl", "accent", "movieProviderIds", "showProviderIds", "offerTypes", "enabled", "hero", "rows"])
                || !Text(provider, "id", 64, false) || !(legacy ? LegacyProvider(provider.GetProperty("id").GetString()!) : ValidProvider(provider.GetProperty("id").GetString()!))
                || !providerIds.Add(provider.GetProperty("id").GetString()!) || !Boolean(provider, "enabled") || !Boolean(provider, "hero")
                || !provider.TryGetProperty("rows", out var rows) || rows.ValueKind != JsonValueKind.Array || rows.GetArrayLength() > 12) return false;
            if (!legacy && (!Text(provider, "name", 80, false) || string.IsNullOrWhiteSpace(provider.GetProperty("name").GetString()) || !Logo(provider) || !Text(provider, "accent", 7, false)
                || !Regex.IsMatch(provider.GetProperty("accent").GetString()!, "^#[0-9a-fA-F]{6}$", RegexOptions.CultureInvariant)
                || !Ids(provider, "movieProviderIds") || !Ids(provider, "showProviderIds") || !Offers(provider))) return false;
            var rowIds = new HashSet<string>(StringComparer.Ordinal);
            foreach (var row in rows.EnumerateArray())
                if (!Properties(row, "id", "title", "source", "collectionId", "enabled", "ranked", "itemSort")
                    || !Text(row, "id", 100, false) || !rowIds.Add(row.GetProperty("id").GetString()!) || !Text(row, "title", 80)
                    || !Choice(row, "source", "movies", "shows", "trending-movies", "trending-shows", "collection", "watchlist")
                    || !Text(row, "collectionId", 199) || !Boolean(row, "enabled") || !Boolean(row, "ranked")
                    || !Choice(row, "itemSort", "collection", "title", "title-desc", "newest", "oldest")) return false;
        }
        return true;
    }
}
