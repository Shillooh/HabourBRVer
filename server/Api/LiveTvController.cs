using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Jellyfin.Data.Enums;
#if JELLYFIN_1010
#else
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Enums;
#endif
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Extensions;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Devices;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Net;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.LiveTv;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.TvItemLayout.Api;

[ApiController]
[Route("TvItemLayout/LiveTv")]
[Authorize]
[ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
public sealed class LiveTvController(
    IAuthorizationContext authorizationContext,
    ISessionManager sessionManager,
    IUserManager userManager,
    IApplicationPaths paths,
    IServerConfigurationManager configurationManager,
    ILiveTvManager liveTvManager,
    IHttpClientFactory httpClientFactory) : ControllerBase
{
    public const int MaximumBytes = 32 * 1024;
    private static readonly SemaphoreSlim StoreLock = new(1, 1);
    private static readonly object CacheLock = new();
    private static LiveTvCatalogResponse? CachedCatalog;
    private static DateTime LastCatalogFetch = DateTime.MinValue;

    private static readonly Regex GroupTitleRegex = new(@"group-title=(?:""([^""]*)""|'([^']*)'|([^, ]+))", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly Regex TvgIdRegex = new(@"tvg-id=(?:""([^""]*)""|'([^']*)'|([^, ]+))", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly Regex TvgNameRegex = new(@"tvg-name=(?:""([^""]*)""|'([^']*)'|([^, ]+))", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly Regex TvgChnoRegex = new(@"tvg-chno=(?:""([^""]*)""|'([^']*)'|([^, ]+))", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly Regex TvgLogoRegex = new(@"tvg-logo=(?:""([^""]*)""|'([^']*)'|([^, ]+))", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static readonly Regex BrazilianPremiereRegex = new(
        @"^(?:(?:BR|BRASIL)[\s:\-\]]*)?(?:CANAL\s+)?PREMIERE(?:\s*(?:\d+|CLUBES|HD|FHD|UHD|4K|MOSAICO|INTERATIVO|24H|FUTEBOL))?(?:\s*(?:HD|FHD|UHD|4K|SD))?$",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static readonly Regex InternationalIndicatorRegex = new(
        @"^(?:\|[A-Z]{2,3}\||\([A-Z]{2,3}\)|\[[A-Z]{2,3}\]|[A-Z]{2,3}[\-:]|\b(?:UK|FR|DE|US|ES|IT|PT|COL|ARG|CHILE|PARIS|SKY|CINEMA)\b)",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static readonly Regex BrazilPrefixRegex = new(
        @"^(?:BR|BRASIL)[\s:\-\]]",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    internal static bool IsBrazilianPremiere(string? name, string groupTitle)
    {
        if (string.IsNullOrWhiteSpace(name)) return false;
        var trimmed = name.Trim();
        if (groupTitle.StartsWith("▶", StringComparison.OrdinalIgnoreCase)) return false;
        if (InternationalIndicatorRegex.IsMatch(trimmed) && !BrazilPrefixRegex.IsMatch(trimmed))
            return false;
        return BrazilianPremiereRegex.IsMatch(trimmed);
    }

    private static string? MatchAttribute(Regex regex, string line)
    {
        var match = regex.Match(line);
        if (!match.Success) return null;
        for (int i = 1; i < match.Groups.Count; i++)
        {
            if (match.Groups[i].Success && !string.IsNullOrWhiteSpace(match.Groups[i].Value))
                return match.Groups[i].Value.Trim();
        }
        return null;
    }

    private static string? GetChannelNumber(BaseItem item)
    {
        var prop = item.GetType().GetProperty("ChannelNumber");
        return prop?.GetValue(item)?.ToString();
    }

    private async Task<(Guid? UserId, bool IsAdmin)> CurrentUser()
    {
        try
        {
            var authorization = await authorizationContext.GetAuthorizationInfo(HttpContext);
            Guid userId = authorization.UserId;
            if (userId == Guid.Empty && !string.IsNullOrWhiteSpace(authorization.Token))
            {
                var remoteIp = HttpContext.GetNormalizedRemoteIP();
                try
                {
                    var session = await sessionManager.GetSessionByAuthenticationToken(authorization.Token,
                        authorization.DeviceId, remoteIp?.ToString());
                    if (session is not null && session.UserId != Guid.Empty)
                    {
                        userId = session.UserId;
                    }
                }
                catch { }

                if (userId == Guid.Empty)
                {
                    try
                    {
                        var session = await sessionManager.GetSessionByAuthenticationToken(authorization.Token,
                            authorization.DeviceId, null);
                        if (session is not null && session.UserId != Guid.Empty)
                        {
                            userId = session.UserId;
                        }
                    }
                    catch { }
                }
            }
            if (userId == Guid.Empty && User?.Identity?.IsAuthenticated == true)
            {
                var claim = User.Claims.FirstOrDefault(c => c.Type == System.Security.Claims.ClaimTypes.NameIdentifier);
                if (claim is not null && Guid.TryParse(claim.Value, out var claimGuid))
                {
                    userId = claimGuid;
                }
            }
            if (userId == Guid.Empty) return (null, false);
            var caller = userManager.GetUserById(userId);
            if (caller is null || caller.HasPermission(PermissionKind.IsDisabled)) return (null, false);
            return (caller.Id, caller.HasPermission(PermissionKind.IsAdministrator));
        }
        catch
        {
            return (null, false);
        }
    }

    private static string GlobalStorePath(IApplicationPaths paths) =>
        Path.Combine(paths.DataPath, "jellyfin-cinema", "livetv-settings", "_global.json");

    private static async Task<LiveTvSettingsResponse> ReadSettings(string path, CancellationToken cancellationToken)
    {
        FileStream stream;
        try { stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 4096, FileOptions.Asynchronous | FileOptions.SequentialScan); }
        catch (FileNotFoundException) { return new(null, null); }
        catch (DirectoryNotFoundException) { return new(null, null); }

        await using var file = stream;
        if (file.Length > MaximumBytes + 1024) throw new InvalidDataException("Saved LiveTV settings exceed size limit.");
        using var reader = new StreamReader(file);
        var data = await reader.ReadToEndAsync(cancellationToken);
        var saved = JsonSerializer.Deserialize<LiveTvSettingsResponse>(data);
        if (saved?.Revision is null || !Guid.TryParseExact(saved.Revision, "N", out _)
            || saved.Settings is not JsonElement settings || !ValidSettings(settings))
            throw new InvalidDataException("Saved LiveTV settings are invalid.");
        return saved;
    }

    internal static bool ValidSettings(JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Object) return false;
        if (!element.TryGetProperty("version", out var v) || v.GetInt32() != 1) return false;
        return true;
    }

    [HttpGet("Settings")]
    [HttpGet("Settings/Global")]
    public async Task<IActionResult> GetSettings(CancellationToken cancellationToken = default)
    {
        var (user, _) = await CurrentUser();
        if (user is null) return Unauthorized();

        await StoreLock.WaitAsync(cancellationToken);
        try
        {
            var globalResponse = await ReadSettings(GlobalStorePath(paths), cancellationToken);
            if (globalResponse.Settings is not null)
            {
                return Ok(globalResponse with { HasUserOverride = false, GlobalRevision = globalResponse.Revision });
            }

            var defaultSettings = LiveTvSettings.CreateDefault();
            var serialized = JsonSerializer.SerializeToElement(defaultSettings);
            return Ok(new LiveTvSettingsResponse(null, serialized, HasUserOverride: false, GlobalRevision: null));
        }
        finally
        {
            StoreLock.Release();
        }
    }

    [HttpPut("Settings")]
    [HttpPut("Settings/Global")]
    [RequestSizeLimit(MaximumBytes)]
    public async Task<IActionResult> PutGlobalSettings([FromBody] LiveTvSettingsRequest request, CancellationToken cancellationToken = default)
    {
        var (user, isAdmin) = await CurrentUser();
        if (user is null) return Unauthorized();
        if (!isAdmin) return StatusCode(403, "Apenas administradores podem alterar as configurações globais de TV Ao Vivo.");

        var reqRevision = string.IsNullOrWhiteSpace(request.Revision) ? null : request.Revision;
        if ((reqRevision is not null && !Guid.TryParseExact(reqRevision, "N", out _)) || !ValidSettings(request.Settings))
            return BadRequest("Invalid LiveTV settings.");

        await StoreLock.WaitAsync(cancellationToken);
        try
        {
            var path = GlobalStorePath(paths);
            var current = await ReadSettings(path, cancellationToken);
            if (reqRevision is not null && current.Revision is not null && !string.Equals(reqRevision, current.Revision, StringComparison.Ordinal))
                return Conflict("LiveTV settings changed on another device. Reload before saving.");

            var newRev = Guid.NewGuid().ToString("N");
            var saved = new LiveTvSettingsResponse(newRev, request.Settings.Clone(), HasUserOverride: false, GlobalRevision: newRev);
            var serialized = JsonSerializer.Serialize(saved);

            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                await System.IO.File.WriteAllTextAsync(temporary, serialized, cancellationToken);
                System.IO.File.Move(temporary, path, true);
            }
            finally
            {
                if (System.IO.File.Exists(temporary)) System.IO.File.Delete(temporary);
            }

            lock (CacheLock) { CachedCatalog = null; }
            return Ok(saved);
        }
        finally
        {
            StoreLock.Release();
        }
    }

    [HttpPost("Settings/ResetDefaults")]
    public async Task<IActionResult> ResetDefaults(CancellationToken cancellationToken = default)
    {
        var (user, isAdmin) = await CurrentUser();
        if (user is null) return Unauthorized();
        if (!isAdmin) return StatusCode(403, "Apenas administradores podem restaurar os padrões de TV Ao Vivo.");

        await StoreLock.WaitAsync(cancellationToken);
        try
        {
            var defaultSettings = LiveTvSettings.CreateDefault();
            var serializedElement = JsonSerializer.SerializeToElement(defaultSettings);
            var newRev = Guid.NewGuid().ToString("N");
            var saved = new LiveTvSettingsResponse(newRev, serializedElement, HasUserOverride: false, GlobalRevision: newRev);
            var serialized = JsonSerializer.Serialize(saved);

            var path = GlobalStorePath(paths);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                await System.IO.File.WriteAllTextAsync(temporary, serialized, cancellationToken);
                System.IO.File.Move(temporary, path, true);
            }
            finally
            {
                if (System.IO.File.Exists(temporary)) System.IO.File.Delete(temporary);
            }

            lock (CacheLock) { CachedCatalog = null; }
            return Ok(saved);
        }
        finally
        {
            StoreLock.Release();
        }
    }

    [HttpGet("Catalog")]
    public async Task<IActionResult> GetCatalog([FromQuery] bool refresh = false, CancellationToken cancellationToken = default)
    {
        var (user, _) = await CurrentUser();
        if (user is null) return Unauthorized();

        if (!refresh)
        {
            lock (CacheLock)
            {
                if (CachedCatalog is not null && (DateTime.UtcNow - LastCatalogFetch).TotalMinutes < 15)
                {
                    return Ok(CachedCatalog);
                }
            }
        }

        // Read LiveTv settings to find custom M3U and localRegion
        var globalSettingsResp = await ReadSettings(GlobalStorePath(paths), cancellationToken);
        var customM3u = string.Empty;
        var localRegion = "none";
        if (globalSettingsResp.Settings is JsonElement el)
        {
            if (el.TryGetProperty("customM3uPathOrUrl", out var customProp))
                customM3u = customProp.GetString() ?? string.Empty;
            if (el.TryGetProperty("localRegion", out var regProp))
                localRegion = regProp.GetString() ?? "none";
        }

        // Collect M3U sources
        var m3uSources = new List<string>();
        if (!string.IsNullOrWhiteSpace(customM3u))
        {
            m3uSources.Add(customM3u.Trim());
        }

        try
        {
            var liveTvOptions = configurationManager.GetConfiguration<LiveTvOptions>("livetv");
            if (liveTvOptions?.TunerHosts is not null)
            {
                foreach (var host in liveTvOptions.TunerHosts)
                {
                    if (string.Equals(host.Type, "m3u", StringComparison.OrdinalIgnoreCase))
                    {
                        foreach (var propName in new[] { "Url", "Path", "Source", "File" })
                        {
                            var val = host.GetType().GetProperty(propName)?.GetValue(host)?.ToString();
                            if (!string.IsNullOrWhiteSpace(val) && !m3uSources.Contains(val, StringComparer.OrdinalIgnoreCase))
                            {
                                m3uSources.Add(val);
                            }
                        }
                    }
                }
            }
        }
        catch { /* LiveTvOptions not configured or empty */ }

        // Fetch Jellyfin live TV channels from LiveTvManager
        IReadOnlyList<BaseItem> jellyfinChannels;
        try
        {
            var channelQuery = new LiveTvChannelQuery { UserId = user.Value };
            var result = liveTvManager.GetInternalChannels(channelQuery, new MediaBrowser.Controller.Dto.DtoOptions(), cancellationToken);
            jellyfinChannels = result.Items;
        }
        catch
        {
            jellyfinChannels = [];
        }

        var parsedChannels = new List<LiveTvCatalogChannel>();
        var httpClient = httpClientFactory.CreateClient("LiveTvProxy");

        foreach (var source in m3uSources)
        {
            try
            {
                var sourceClean = source.Trim().Trim('"', '\'');
                if (sourceClean.StartsWith("file://", StringComparison.OrdinalIgnoreCase))
                {
                    sourceClean = sourceClean[7..];
                    if (sourceClean.StartsWith('/') && sourceClean.Length > 2 && sourceClean[2] == ':')
                    {
                        sourceClean = sourceClean[1..];
                    }
                }

                sourceClean = WebUtility.UrlDecode(sourceClean);

                byte[] bytes;
                if (Uri.TryCreate(sourceClean, UriKind.Absolute, out var uri) && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps))
                {
                    bytes = await httpClient.GetByteArrayAsync(uri, cancellationToken);
                }
                else if (System.IO.File.Exists(sourceClean))
                {
                    bytes = await System.IO.File.ReadAllBytesAsync(sourceClean, cancellationToken);
                }
                else continue;

                string content;
                try
                {
                    var utf8Strict = new UTF8Encoding(false, true);
                    content = utf8Strict.GetString(bytes);
                }
                catch
                {
                    content = Encoding.Latin1.GetString(bytes);
                }

                using var reader = new StringReader(content);
                string? line;
                string? currentGroup = null;
                string? currentLogo = null;
                string? currentName = null;
                string? currentChno = null;
                string? currentId = null;

                while ((line = await reader.ReadLineAsync(cancellationToken)) != null)
                {
                    line = line.Trim();
                    if (string.IsNullOrEmpty(line)) continue;

                    if (line.StartsWith("#EXTINF", StringComparison.OrdinalIgnoreCase))
                    {
                        var matchedGroup = MatchAttribute(GroupTitleRegex, line);
                        if (!string.IsNullOrWhiteSpace(matchedGroup)) currentGroup = matchedGroup;
                        currentLogo = MatchAttribute(TvgLogoRegex, line);
                        currentId = MatchAttribute(TvgIdRegex, line);
                        currentChno = MatchAttribute(TvgChnoRegex, line);
                        var tvgName = MatchAttribute(TvgNameRegex, line);

                        var commaIdx = line.IndexOf(',');
                        if (commaIdx >= 0 && commaIdx < line.Length - 1)
                        {
                            currentName = line[(commaIdx + 1)..].Trim();
                        }
                        else
                        {
                            currentName = tvgName;
                        }
                    }
                    else if (line.StartsWith("#EXTGRP:", StringComparison.OrdinalIgnoreCase))
                    {
                        var extGrp = line[8..].Trim();
                        if (!string.IsNullOrWhiteSpace(extGrp))
                        {
                            currentGroup = extGrp;
                        }
                    }
                    else if (!line.StartsWith('#') && currentName != null)
                    {
                        var streamUrl = line;
                        var group = string.IsNullOrWhiteSpace(currentGroup) ? "Canais - Aberto" : currentGroup.Trim();
                        // Normaliza qualquer categoria "Local - ..." do fornecedor (ex: "Local - Bahia") para "TV Aberta".
                        // Os canais regionais do estado configurado são destacados dinamicamente em "Canais Locais (Estado)".
                        if (group.StartsWith("Local - ", StringComparison.OrdinalIgnoreCase) || string.Equals(group, "Local", StringComparison.OrdinalIgnoreCase))
                        {
                            group = "TV Aberta";
                        }

                        if (IsBrazilianPremiere(currentName, group))
                        {
                            group = "Premiere";
                        }

                        parsedChannels.Add(new LiveTvCatalogChannel
                        {
                            Id = Guid.NewGuid().ToString("N"),
                            EpgId = currentId,
                            Name = currentName,
                            GroupTitle = group,
                            ChannelNumber = currentChno ?? (parsedChannels.Count + 1).ToString(),
                            LogoUrl = currentLogo,
                            StreamUrl = streamUrl
                        });

                        currentGroup = null;
                        currentLogo = null;
                        currentName = null;
                        currentChno = null;
                        currentId = null;
                    }
                }
            }
            catch { /* Skip unreadable source */ }
        }

        // Cross reference with Jellyfin channels
        foreach (var parsed in parsedChannels)
        {
            var match = jellyfinChannels.FirstOrDefault(j =>
                string.Equals(j.Name, parsed.Name, StringComparison.OrdinalIgnoreCase)
                || (parsed.ChannelNumber != null && string.Equals(GetChannelNumber(j), parsed.ChannelNumber, StringComparison.OrdinalIgnoreCase)));

            if (match is not null)
            {
                parsed.JellyfinId = match.Id.ToString("N");
                if (string.IsNullOrEmpty(parsed.LogoUrl))
                {
                    parsed.LogoUrl = $"/Items/{match.Id}/Images/Primary";
                }
            }
        }

        // If no channels parsed from M3U, build directly from Jellyfin channels
        if (parsedChannels.Count == 0 && jellyfinChannels.Count > 0)
        {
            foreach (var jf in jellyfinChannels)
            {
                var chNumber = GetChannelNumber(jf) ?? (parsedChannels.Count + 1).ToString();
                parsedChannels.Add(new LiveTvCatalogChannel
                {
                    Id = jf.Id.ToString("N"),
                    JellyfinId = jf.Id.ToString("N"),
                    Name = jf.Name,
                    ChannelNumber = chNumber,
                    GroupTitle = "📡 Todos os Canais",
                    LogoUrl = $"/Items/{jf.Id}/Images/Primary"
                });
            }
        }

        // Group into categories preserving the exact M3U file appearance order
        var categoriesDict = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        var groupOrder = new List<string>();
        foreach (var ch in parsedChannels)
        {
            var cat = string.IsNullOrWhiteSpace(ch.GroupTitle) ? "Canais - Aberto" : ch.GroupTitle;
            if (!categoriesDict.ContainsKey(cat))
            {
                groupOrder.Add(cat);
                categoriesDict[cat] = 0;
            }
            categoriesDict[cat]++;
        }

        // Garante que "Premiere" fique posicionado imediatamente acima de "Esportes"
        if (categoriesDict.ContainsKey("Premiere"))
        {
            groupOrder.Remove("Premiere");
            var esportesIdx = groupOrder.FindIndex(g => string.Equals(g, "Esportes", StringComparison.OrdinalIgnoreCase));
            if (esportesIdx >= 0)
            {
                groupOrder.Insert(esportesIdx, "Premiere");
            }
            else
            {
                var abertaIdx = groupOrder.FindIndex(g => g.Contains("Aberta", StringComparison.OrdinalIgnoreCase));
                if (abertaIdx >= 0) groupOrder.Insert(abertaIdx + 1, "Premiere");
                else groupOrder.Insert(0, "Premiere");
            }
        }

        var categories = new List<LiveTvCatalogCategory>();
        if (parsedChannels.Count > 0)
        {
            categories.Add(new LiveTvCatalogCategory
            {
                Id = "all-channels",
                Name = "📡 Todos os Canais",
                Icon = "tv",
                Count = parsedChannels.Count
            });
        }

        foreach (var name in groupOrder)
        {
            if (string.Equals(name, "📡 Todos os Canais", StringComparison.OrdinalIgnoreCase)) continue;
            var count = categoriesDict[name];
            categories.Add(new LiveTvCatalogCategory
            {
                Id = "cat-" + Math.Abs(name.GetHashCode()).ToString("x"),
                Name = name,
                Icon = name.Equals("Premiere", StringComparison.OrdinalIgnoreCase) ? "sports_soccer"
                     : name.Contains("4k", StringComparison.OrdinalIgnoreCase) ? "high_quality"
                     : name.Contains("filme", StringComparison.OrdinalIgnoreCase) || name.Contains("serie", StringComparison.OrdinalIgnoreCase) ? "movie"
                     : name.Contains("esporte", StringComparison.OrdinalIgnoreCase) || name.Contains("futebol", StringComparison.OrdinalIgnoreCase) ? "sports_soccer"
                     : name.Contains("noticia", StringComparison.OrdinalIgnoreCase) ? "newspaper"
                     : name.Contains("infantil", StringComparison.OrdinalIgnoreCase) || name.Contains("kids", StringComparison.OrdinalIgnoreCase) ? "child_care"
                     : "live_tv",
                Count = count
            });
        }

        var catalog = new LiveTvCatalogResponse
        {
            Categories = categories,
            Channels = parsedChannels
        };

        lock (CacheLock)
        {
            CachedCatalog = catalog;
            LastCatalogFetch = DateTime.UtcNow;
        }

        return Ok(catalog);
    }
}
