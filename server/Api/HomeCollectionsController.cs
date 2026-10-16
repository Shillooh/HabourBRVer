using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
#if JELLYFIN_1010
using Jellyfin.Data.Enums;
#else
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Enums;
#endif
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Extensions;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller.Devices;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Net;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.TvItemLayout.Api;

[ApiController]
[Route("TvItemLayout/HomeCollections")]
[Authorize]
[ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
public sealed class HomeCollectionsController(
    IAuthorizationContext authorizationContext,
    ISessionManager sessionManager,
    IUserManager userManager,
    IApplicationPaths paths) : ControllerBase
{
    public const int MaximumBytes = 512 * 1024;
    // Shared by every controller instance, including competing first-use migrations.
    private static readonly SemaphoreSlim StoreLock = new(1, 1);

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

    private string StorePath(Guid user) => Path.Combine(paths.DataPath, "jellyfin-cinema", "home-collections", user.ToString("N") + ".json");
    private string GlobalStorePath() => Path.Combine(paths.DataPath, "jellyfin-cinema", "home-collections", "_global.json");

    private static async Task<HomeCollectionsResponse> Read(string path, CancellationToken cancellationToken)
    {
        if (!System.IO.File.Exists(path)) return new(null, null);
        if (new FileInfo(path).Length > MaximumBytes + 1024) throw new InvalidDataException("Saved Home rows exceed the size limit.");
        var data = await System.IO.File.ReadAllTextAsync(path, cancellationToken);
        var saved = JsonSerializer.Deserialize<HomeCollectionsResponse>(data);
        if (saved?.Revision is null || !Guid.TryParseExact(saved.Revision, "N", out _)
            || saved.Settings is not JsonElement settings || !ValidSettings(settings))
            throw new InvalidDataException("Saved Home rows are invalid.");
        return saved;
    }

    [HttpGet]
    public async Task<IActionResult> GetHomeCollections(CancellationToken cancellationToken = default)
    {
        var (user, _) = await CurrentUser();
        if (user is null) return Unauthorized();
        await StoreLock.WaitAsync(cancellationToken);
        try
        {
            var userResponse = await Read(StorePath(user.Value), cancellationToken);
            var globalResponse = await Read(GlobalStorePath(), cancellationToken);
            if (userResponse.Settings is not null)
            {
                return Ok(userResponse with { HasUserOverride = true, GlobalRevision = globalResponse.Revision });
            }
            if (globalResponse.Settings is not null)
            {
                return Ok(globalResponse with { HasUserOverride = false, GlobalRevision = globalResponse.Revision });
            }
            return Ok(new HomeCollectionsResponse(null, null, HasUserOverride: false, GlobalRevision: null));
        }
        finally { StoreLock.Release(); }
    }

    [HttpGet("Global")]
    public async Task<IActionResult> GetGlobalHomeCollections(CancellationToken cancellationToken = default)
    {
        var (user, isAdmin) = await CurrentUser();
        if (user is null) return Unauthorized();
        await StoreLock.WaitAsync(cancellationToken);
        try
        {
            var globalResponse = await Read(GlobalStorePath(), cancellationToken);
            if (globalResponse.Settings is not null) return Ok(globalResponse with { HasUserOverride = false, GlobalRevision = globalResponse.Revision });
            return Ok(new HomeCollectionsResponse(null, null, HasUserOverride: false, GlobalRevision: null));
        }
        finally { StoreLock.Release(); }
    }

    [HttpPut]
    [RequestSizeLimit(MaximumBytes)]
    public async Task<IActionResult> PutHomeCollections([FromBody] HomeCollectionsRequest request, CancellationToken cancellationToken = default)
    {
        var (user, _) = await CurrentUser();
        if (user is null) return Unauthorized();
        var reqRevision = string.IsNullOrWhiteSpace(request.Revision) ? null : request.Revision;
        if ((reqRevision is not null && !Guid.TryParseExact(reqRevision, "N", out _)) || !ValidSettings(request.Settings))
            return BadRequest("Invalid Home collection settings.");
        if (Encoding.UTF8.GetByteCount(request.Settings.GetRawText()) > MaximumBytes - 1024)
            return StatusCode(413, "Home collection settings are too large.");
        await StoreLock.WaitAsync(cancellationToken);
        try
        {
            var path = StorePath(user.Value);
            var current = await Read(path, cancellationToken);
            var globalCurrent = await Read(GlobalStorePath(), cancellationToken);
            bool revisionMatches = string.Equals(reqRevision, current.Revision, StringComparison.Ordinal)
                || (current.Revision is null && string.Equals(reqRevision, globalCurrent.Revision, StringComparison.Ordinal));
            if (!revisionMatches)
                return Conflict("Home rows changed on another device. Reload them before saving.");
            // Earlier clients normalize unknown row fields away. Check the saved
            // settings, not the incoming draft, so an old client cannot strip them.
            if (current.Settings is JsonElement currentSettings)
            {
                var capability = Request.Headers["X-ScreenHarbour-Home-Rows"].ToString();
                if (UsesSeasonalFullscreen(currentSettings) && capability != "6")
                    return Conflict("These Home rows use full-screen seasonal artwork. Reload ScreenHarbour on this device before saving.");
                if (UsesSeasonalAdvent(currentSettings) && capability is not ("5" or "6"))
                    return Conflict("These Home rows use advent calendar doors. Reload ScreenHarbour on this device before saving.");
                if (UsesSeasonalRankStyle(currentSettings) && capability is not ("4" or "5" or "6"))
                    return Conflict("These Home rows use seasonal ranking artwork. Reload ScreenHarbour on this device before saving.");
                if (UsesSeasonalAppearance(currentSettings) && capability is not ("3" or "4" or "5" or "6"))
                    return Conflict("These Home rows use seasonal appearance settings. Reload ScreenHarbour on this device before saving.");
                if (UsesSeasonalOrShuffle(currentSettings) && capability is not ("2" or "3" or "4" or "5" or "6"))
                    return Conflict("These Home rows use seasonal or shuffle settings. Reload ScreenHarbour on this device before saving.");
            }
            var saved = new HomeCollectionsResponse(Guid.NewGuid().ToString("N"), request.Settings.Clone(), HasUserOverride: true, GlobalRevision: globalCurrent.Revision);
            var serialized = JsonSerializer.Serialize(saved);
            if (Encoding.UTF8.GetByteCount(serialized) > MaximumBytes)
                return StatusCode(413, "Home collection settings are too large.");
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                await System.IO.File.WriteAllTextAsync(temporary, serialized, cancellationToken);
                // Publish only complete files; a failed write never discards the previous revision.
                System.IO.File.Move(temporary, path, true);
            }
            finally { if (System.IO.File.Exists(temporary)) System.IO.File.Delete(temporary); }
            return Ok(saved);
        }
        finally { StoreLock.Release(); }
    }

    [HttpPut("Global")]
    [RequestSizeLimit(MaximumBytes)]
    public async Task<IActionResult> PutGlobalHomeCollections([FromBody] HomeCollectionsRequest request, CancellationToken cancellationToken = default)
    {
        var (user, isAdmin) = await CurrentUser();
        if (user is null) return Unauthorized();
        if (!isAdmin) return StatusCode(403, "Apenas administradores podem alterar as configurações globais.");
        var reqRevision = string.IsNullOrWhiteSpace(request.Revision) ? null : request.Revision;
        if ((reqRevision is not null && !Guid.TryParseExact(reqRevision, "N", out _)) || !ValidSettings(request.Settings))
            return BadRequest("Invalid Home collection settings.");
        if (Encoding.UTF8.GetByteCount(request.Settings.GetRawText()) > MaximumBytes - 1024)
            return StatusCode(413, "Home collection settings are too large.");
        await StoreLock.WaitAsync(cancellationToken);
        try
        {
            var path = GlobalStorePath();
            var current = await Read(path, cancellationToken);
            if (reqRevision is not null && !string.Equals(reqRevision, current.Revision, StringComparison.Ordinal))
                return Conflict("Home rows global settings changed on another device. Reload them before saving.");
            var newRev = Guid.NewGuid().ToString("N");
            var saved = new HomeCollectionsResponse(newRev, request.Settings.Clone(), HasUserOverride: false, GlobalRevision: newRev);
            var serialized = JsonSerializer.Serialize(saved);
            if (Encoding.UTF8.GetByteCount(serialized) > MaximumBytes)
                return StatusCode(413, "Home collection settings are too large.");
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                await System.IO.File.WriteAllTextAsync(temporary, serialized, cancellationToken);
                System.IO.File.Move(temporary, path, true);
            }
            finally { if (System.IO.File.Exists(temporary)) System.IO.File.Delete(temporary); }
            return Ok(saved);
        }
        finally { StoreLock.Release(); }
    }

    [HttpGet("Users")]
    public async Task<IActionResult> GetUsers(CancellationToken cancellationToken = default)
    {
        try
        {
            var (callerId, isAdmin) = await CurrentUser();
            if (callerId is null || !isAdmin) return StatusCode(403, "Apenas administradores podem listar usuários.");
#if JELLYFIN_12
            var rawUsers = userManager.GetUsers();
#else
            var rawUsers = userManager.Users;
#endif
            var list = rawUsers
                .Where(u => !u.HasPermission(PermissionKind.IsDisabled))
                .Select(u => new { Id = u.Id.ToString("N"), Name = u.Username, Username = u.Username })
                .OrderBy(u => u.Name)
                .ToList();
            return Ok(list);
        }
        catch
        {
            return Ok(Array.Empty<object>());
        }
    }

    [HttpGet("User/{targetUserId}")]
    public async Task<IActionResult> GetTargetUserHomeCollections([FromRoute] string targetUserId, CancellationToken cancellationToken = default)
    {
        var (callerId, isAdmin) = await CurrentUser();
        if (callerId is null || !isAdmin) return StatusCode(403, "Apenas administradores podem acessar configurações de outros usuários.");
        if (!Guid.TryParse(targetUserId, out var targetGuid)) return BadRequest("ID de usuário inválido.");
        await StoreLock.WaitAsync(cancellationToken);
        try
        {
            var userResponse = await Read(StorePath(targetGuid), cancellationToken);
            var globalResponse = await Read(GlobalStorePath(), cancellationToken);
            if (userResponse.Settings is not null)
            {
                return Ok(userResponse with { HasUserOverride = true, GlobalRevision = globalResponse.Revision });
            }
            if (globalResponse.Settings is not null)
            {
                return Ok(globalResponse with { HasUserOverride = false, GlobalRevision = globalResponse.Revision });
            }
            return Ok(new HomeCollectionsResponse(null, null, HasUserOverride: false, GlobalRevision: null));
        }
        finally { StoreLock.Release(); }
    }

    [HttpPut("User/{targetUserId}")]
    [RequestSizeLimit(MaximumBytes)]
    public async Task<IActionResult> PutTargetUserHomeCollections([FromRoute] string targetUserId, [FromBody] HomeCollectionsRequest request, CancellationToken cancellationToken = default)
    {
        var (callerId, isAdmin) = await CurrentUser();
        if (callerId is null || !isAdmin) return StatusCode(403, "Apenas administradores podem salvar configurações de outros usuários.");
        if (!Guid.TryParse(targetUserId, out var targetGuid)) return BadRequest("ID de usuário inválido.");
        var reqRevision = string.IsNullOrWhiteSpace(request.Revision) ? null : request.Revision;
        if ((reqRevision is not null && !Guid.TryParseExact(reqRevision, "N", out _)) || !ValidSettings(request.Settings))
            return BadRequest("Invalid Home collection settings.");
        if (Encoding.UTF8.GetByteCount(request.Settings.GetRawText()) > MaximumBytes - 1024)
            return StatusCode(413, "Home collection settings are too large.");
        await StoreLock.WaitAsync(cancellationToken);
        try
        {
            var path = StorePath(targetGuid);
            var current = await Read(path, cancellationToken);
            var globalCurrent = await Read(GlobalStorePath(), cancellationToken);
            bool revisionMatches = string.Equals(reqRevision, current.Revision, StringComparison.Ordinal)
                || (current.Revision is null && string.Equals(reqRevision, globalCurrent.Revision, StringComparison.Ordinal))
                || reqRevision is null;
            if (!revisionMatches)
                return Conflict("Home rows changed on another device. Reload them before saving.");
            var saved = new HomeCollectionsResponse(Guid.NewGuid().ToString("N"), request.Settings.Clone(), HasUserOverride: true, GlobalRevision: globalCurrent.Revision);
            var serialized = JsonSerializer.Serialize(saved);
            if (Encoding.UTF8.GetByteCount(serialized) > MaximumBytes)
                return StatusCode(413, "Home collection settings are too large.");
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                await System.IO.File.WriteAllTextAsync(temporary, serialized, cancellationToken);
                System.IO.File.Move(temporary, path, true);
            }
            finally { if (System.IO.File.Exists(temporary)) System.IO.File.Delete(temporary); }
            return Ok(saved);
        }
        finally { StoreLock.Release(); }
    }

    [HttpDelete("User/{targetUserId}")]
    public async Task<IActionResult> DeleteTargetUserHomeCollections([FromRoute] string targetUserId, CancellationToken cancellationToken = default)
    {
        var (callerId, isAdmin) = await CurrentUser();
        if (callerId is null || !isAdmin) return StatusCode(403, "Apenas administradores podem redefinir configurações de outros usuários.");
        if (!Guid.TryParse(targetUserId, out var targetGuid)) return BadRequest("ID de usuário inválido.");
        await StoreLock.WaitAsync(cancellationToken);
        try
        {
            var path = StorePath(targetGuid);
            if (System.IO.File.Exists(path)) System.IO.File.Delete(path);
            var globalResponse = await Read(GlobalStorePath(), cancellationToken);
            if (globalResponse.Settings is not null)
            {
                return Ok(globalResponse with { HasUserOverride = false, GlobalRevision = globalResponse.Revision });
            }
            return Ok(new HomeCollectionsResponse(null, null, HasUserOverride: false, GlobalRevision: null));
        }
        finally { StoreLock.Release(); }
    }

    [HttpDelete("User")]
    public async Task<IActionResult> DeleteUserHomeCollections(CancellationToken cancellationToken = default)
    {
        var (user, _) = await CurrentUser();
        if (user is null) return Unauthorized();
        await StoreLock.WaitAsync(cancellationToken);
        try
        {
            var path = StorePath(user.Value);
            if (System.IO.File.Exists(path)) System.IO.File.Delete(path);
            var globalResponse = await Read(GlobalStorePath(), cancellationToken);
            if (globalResponse.Settings is not null)
            {
                return Ok(globalResponse with { HasUserOverride = false, GlobalRevision = globalResponse.Revision });
            }
            return Ok(new HomeCollectionsResponse(null, null, HasUserOverride: false, GlobalRevision: null));
        }
        finally { StoreLock.Release(); }
    }

    [HttpPost("ResetAllUsers")]
    public async Task<IActionResult> ResetAllUsers(CancellationToken cancellationToken = default)
    {
        var (user, isAdmin) = await CurrentUser();
        if (user is null) return Unauthorized();
        if (!isAdmin) return StatusCode(403, "Apenas administradores podem redefinir as configurações de todos os usuários.");
        await StoreLock.WaitAsync(cancellationToken);
        try
        {
            var directory = Path.GetDirectoryName(GlobalStorePath())!;
            if (Directory.Exists(directory))
            {
                foreach (var file in Directory.GetFiles(directory, "*.json"))
                {
                    var name = Path.GetFileName(file);
                    if (!string.Equals(name, "_global.json", StringComparison.OrdinalIgnoreCase))
                    {
                        try { System.IO.File.Delete(file); } catch { /* Ignore locked files */ }
                    }
                }
            }
            return Ok(new { success = true });
        }
        finally { StoreLock.Release(); }
    }

    private static bool Properties(JsonElement value, params string[] allowed) => value.ValueKind == JsonValueKind.Object
        && value.EnumerateObject().All(property => allowed.Contains(property.Name, StringComparer.Ordinal))
        && value.EnumerateObject().Select(property => property.Name).Distinct().Count() == value.EnumerateObject().Count();
    private static bool Text(JsonElement value, string key, int maximum, bool empty = true) => value.TryGetProperty(key, out var text)
        && text.ValueKind == JsonValueKind.String && text.GetString()!.Length <= maximum && (empty || text.GetString()!.Length > 0);
    private static bool Strings(JsonElement value, string key, int maximum) => value.TryGetProperty(key, out var array)
        && array.ValueKind == JsonValueKind.Array && array.GetArrayLength() <= maximum
        && array.EnumerateArray().All(item => item.ValueKind == JsonValueKind.String && item.GetString()!.Length is > 0 and < 200);
    private static bool Sort(JsonElement value) => value.TryGetProperty("itemSort", out var sort) && sort.ValueKind == JsonValueKind.String
        && new[] { "collection", "title", "title-desc", "newest", "oldest", "custom" }.Contains(sort.GetString());
    private static bool UsesSeasonalOrShuffle(JsonElement settings) => settings.GetProperty("rows").EnumerateArray().Any(row =>
        row.GetProperty("kind").GetString() == "seasonal" || row.TryGetProperty("shuffle", out var shuffle) && shuffle.ValueKind == JsonValueKind.True);
    private static bool UsesSeasonalAppearance(JsonElement settings) => settings.GetProperty("rows").EnumerateArray().Any(row =>
        row.GetProperty("kind").GetString() == "seasonal" && row.GetProperty("children").EnumerateArray().Any(child => child.TryGetProperty("appearance", out _)));
    private static bool UsesSeasonalRankStyle(JsonElement settings) => settings.GetProperty("rows").EnumerateArray().Any(row =>
        row.GetProperty("kind").GetString() == "seasonal" && row.GetProperty("children").EnumerateArray().Any(child =>
            child.TryGetProperty("appearance", out var appearance) && appearance.TryGetProperty("rankStyle", out _)));
    private static bool UsesSeasonalAdvent(JsonElement settings) => settings.GetProperty("rows").EnumerateArray().Any(row =>
        row.GetProperty("kind").GetString() == "seasonal" && row.GetProperty("children").EnumerateArray().Any(child =>
            child.TryGetProperty("appearance", out var appearance)
                && (appearance.GetProperty("reveal").GetString() == "advent" || appearance.TryGetProperty("adventUnlock", out _))));
    private static bool UsesSeasonalFullscreen(JsonElement settings) => settings.GetProperty("rows").EnumerateArray().Any(row =>
        row.GetProperty("kind").GetString() == "seasonal" && row.GetProperty("children").EnumerateArray().Any(child =>
            child.TryGetProperty("appearance", out var appearance) && appearance.GetProperty("expansion").GetString() == "fullscreen"));
    private static bool Choice(JsonElement value, string key, params string[] choices) => value.TryGetProperty(key, out var choice)
        && choice.ValueKind == JsonValueKind.String && choices.Contains(choice.GetString(), StringComparer.Ordinal);
    private static bool ValidAppearance(JsonElement appearance) => Properties(appearance, "theme", "background", "expansion", "frame", "reveal", "backgroundStyle", "frameStyle", "coverStyle", "rankStyle", "adventUnlock")
        && Choice(appearance, "theme", "halloween", "christmas") && Choice(appearance, "background", "none", "static", "parallax")
        && Choice(appearance, "expansion", "none", "medium", "large", "fullscreen") && Choice(appearance, "reveal", "none", "doors", "curtains", "shutters", "advent")
        && (appearance.GetProperty("reveal").GetString() != "advent" || appearance.GetProperty("theme").GetString() == "christmas")
        && (!appearance.TryGetProperty("adventUnlock", out _) || appearance.GetProperty("reveal").GetString() == "advent"
            && Choice(appearance, "adventUnlock", "focus", "daily"))
        && appearance.TryGetProperty("frame", out var frame) && frame.ValueKind is JsonValueKind.True or JsonValueKind.False
        && new[] { "backgroundStyle", "frameStyle", "coverStyle" }.All(key => !appearance.TryGetProperty(key, out var style)
            || Choice(appearance, key, "classic", "storybook", "photoreal", "nightmare")
                && (style.GetString() != "nightmare" || appearance.GetProperty("theme").GetString() == "halloween"))
        && (!appearance.TryGetProperty("rankStyle", out var rankStyle)
            || Choice(appearance, "rankStyle", "standard", "classic", "storybook", "photoreal", "nightmare")
                && (rankStyle.GetString() != "nightmare" || appearance.GetProperty("theme").GetString() == "halloween"));
    private static bool SeasonDate(JsonElement season, string key)
    {
        if (!Text(season, key, 5, false)) return false;
        var value = season.GetProperty(key).GetString()!;
        if (value.Length != 5 || value[2] != '-' || value.Where((_, index) => index != 2).Any(character => character is < '0' or > '9')) return false;
        var month = (value[0] - '0') * 10 + value[1] - '0';
        var day = (value[3] - '0') * 10 + value[4] - '0';
        // Recurring ranges may cross New Year. A leap-year calendar also permits
        // February 29 without inventing a date in non-leap years.
        return month is >= 1 and <= 12 && day >= 1 && day <= DateTime.DaysInMonth(2000, month);
    }
    private static bool ValidRow(JsonElement row, HashSet<string> ids, bool child = false)
    {
        if (!Properties(row, "id", "kind", "title", "collectionIds", "ranked", "placement", "itemSort", "itemOrder", "tabs", "children", "season", "shuffle", "appearance")
            || !Text(row, "id", 100, false) || !ids.Add(row.GetProperty("id").GetString()!) || !Text(row, "title", 80)
            || !row.TryGetProperty("kind", out var kindValue) || kindValue.ValueKind != JsonValueKind.String
            || kindValue.GetString() is not ("collections" or "items" or "watchlist" or "seasonal")
            || !row.TryGetProperty("ranked", out var ranked) || ranked.ValueKind is not (JsonValueKind.True or JsonValueKind.False)
            || !Text(row, "placement", 240, false) || !Sort(row) || !Strings(row, "itemOrder", 2000)) return false;
        var kind = kindValue.GetString();
        if (!Strings(row, "collectionIds", kind is "watchlist" or "seasonal" ? 0 : kind == "items" ? 1 : 40)) return false;
        var placement = row.GetProperty("placement").GetString()!;
        if (placement is not ("start" or "end") && !placement.StartsWith("native:", StringComparison.Ordinal)) return false;
        if (row.TryGetProperty("shuffle", out var shuffle) && shuffle.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return false;
        var hasSeason = row.TryGetProperty("season", out var season);
        if (child != hasSeason || hasSeason && (!Properties(season, "start", "end") || !SeasonDate(season, "start") || !SeasonDate(season, "end"))) return false;
        if (row.TryGetProperty("appearance", out var appearance) && (!child || !ValidAppearance(appearance)
            || appearance.GetProperty("reveal").GetString() == "advent" && kind != "items")) return false;
        if (kind == "seasonal")
        {
            if (child || row.GetProperty("title").GetString()!.Length != 0 || ranked.GetBoolean()
                || row.GetProperty("itemSort").GetString() != "collection" || row.GetProperty("itemOrder").GetArrayLength() != 0
                || shuffle.ValueKind == JsonValueKind.True || row.TryGetProperty("tabs", out _)
                || !row.TryGetProperty("children", out var children) || children.ValueKind != JsonValueKind.Array || children.GetArrayLength() > 12) return false;
            return children.EnumerateArray().All(value => ValidRow(value, ids, child: true));
        }
        if (row.TryGetProperty("children", out _) || kind == "watchlist" && (ranked.GetBoolean() || row.TryGetProperty("tabs", out _))) return false;
        if (!row.TryGetProperty("tabs", out var tabs)) return true;
        if (kind != "items" || tabs.ValueKind != JsonValueKind.Array || tabs.GetArrayLength() > 6) return false;
        var tabIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var tab in tabs.EnumerateArray())
            if (!Properties(tab, "id", "label", "collectionId", "itemSort", "itemOrder") || !Text(tab, "id", 100, false)
                || !tabIds.Add(tab.GetProperty("id").GetString()!) || !Text(tab, "label", 40)
                || !Text(tab, "collectionId", 199) || !Sort(tab) || !Strings(tab, "itemOrder", 2000)) return false;
        return true;
    }
    private static bool ValidSettings(JsonElement settings)
    {
        if (!Properties(settings, "version", "rows") || !settings.TryGetProperty("version", out var version)
            || version.ValueKind != JsonValueKind.Number || !version.TryGetInt32(out var number) || number != 1 || !settings.TryGetProperty("rows", out var rows)
            || rows.ValueKind != JsonValueKind.Array || rows.GetArrayLength() > 12) return false;
        var ids = new HashSet<string>(StringComparer.Ordinal);
        return rows.EnumerateArray().All(row => ValidRow(row, ids));
    }
}

public sealed record HomeCollectionsRequest(
    [property: JsonPropertyName("Revision")] string? Revision,
    [property: JsonPropertyName("Settings")] JsonElement Settings);

public sealed record HomeCollectionsResponse(
    // Jellyfin globally omits null JSON properties. Missing settings must keep
    // both fields so clients can distinguish first use from a malformed reply.
    [property: JsonPropertyName("Revision"), JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Revision,
    [property: JsonPropertyName("Settings"), JsonIgnore(Condition = JsonIgnoreCondition.Never)] JsonElement? Settings,
    [property: JsonPropertyName("HasUserOverride"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] bool HasUserOverride = false,
    [property: JsonPropertyName("GlobalRevision"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? GlobalRevision = null);
