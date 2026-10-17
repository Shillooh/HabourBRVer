using System.Text.Json;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.TvItemLayout.Api;

public sealed class LiveTvSettings
{
    public const int CurrentVersion = 1;

    [JsonPropertyName("version")]
    public int Version { get; set; } = CurrentVersion;

    [JsonPropertyName("enabled")]
    public bool Enabled { get; set; } = true;

    [JsonPropertyName("defaultChannelEnabled")]
    public bool DefaultChannelEnabled { get; set; } = true;

    [JsonPropertyName("defaultChannelName")]
    public string DefaultChannelName { get; set; } = "TV Senado";

    [JsonPropertyName("defaultChannelDescription")]
    public string DefaultChannelDescription { get; set; } = "Canal de Boas-Vindas · Ao Vivo 24h";

    [JsonPropertyName("defaultChannelUrls")]
    public List<string> DefaultChannelUrls { get; set; } =
    [
        "http://45.162.64.114/TV_SENADO/index.m3u8",
        "http://168.197.104.22/TV_SENADO/index.m3u8",
        "http://170.83.16.50/TV_SENADO/index.m3u8",
        "http://170.83.49.66:8083/TVSENADOHD/index.m3u8",
        "http://186.219.52.187/tv_senado/index.m3u8"
    ];

    [JsonPropertyName("customM3uPathOrUrl")]
    public string CustomM3uPathOrUrl { get; set; } = string.Empty;

    [JsonPropertyName("userAgent")]
    public string UserAgent { get; set; } = "VLC/3.0.20 LibVLC/3.0.20";

    [JsonPropertyName("localRegion")]
    public string LocalRegion { get; set; } = "none";

    public static LiveTvSettings CreateDefault() => new();
}

public sealed record LiveTvSettingsRequest(
    [property: JsonPropertyName("Revision")] string? Revision,
    [property: JsonPropertyName("Settings")] JsonElement Settings);

public sealed record LiveTvSettingsResponse(
    [property: JsonPropertyName("Revision"), JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Revision,
    [property: JsonPropertyName("Settings"), JsonIgnore(Condition = JsonIgnoreCondition.Never)] JsonElement? Settings,
    [property: JsonPropertyName("HasUserOverride"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] bool HasUserOverride = false,
    [property: JsonPropertyName("GlobalRevision"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? GlobalRevision = null);

public sealed class LiveTvCatalogCategory
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    [JsonPropertyName("icon")]
    public string Icon { get; set; } = "live_tv";

    [JsonPropertyName("count")]
    public int Count { get; set; }
}

public sealed class LiveTvCatalogChannel
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("jellyfinId")]
    public string? JellyfinId { get; set; }

    [JsonPropertyName("epgId")]
    public string? EpgId { get; set; }

    [JsonPropertyName("channelNumber")]
    public string ChannelNumber { get; set; } = string.Empty;

    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    [JsonPropertyName("groupTitle")]
    public string GroupTitle { get; set; } = string.Empty;

    [JsonPropertyName("logoUrl")]
    public string? LogoUrl { get; set; }

    [JsonPropertyName("streamUrl")]
    public string? StreamUrl { get; set; }
}

public sealed class LiveTvCatalogResponse
{
    [JsonPropertyName("categories")]
    public List<LiveTvCatalogCategory> Categories { get; set; } = [];

    [JsonPropertyName("channels")]
    public List<LiveTvCatalogChannel> Channels { get; set; } = [];
}
