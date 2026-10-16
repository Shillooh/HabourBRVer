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
[Route("TvItemLayout/LoadingScreen")]
[Authorize]
[ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
public sealed class LoadingScreenController(
    IAuthorizationContext authorizationContext,
    ISessionManager sessionManager,
    IUserManager userManager,
    IApplicationPaths paths) : ControllerBase
{
    public const int MaximumBytes = 8 * 1024;
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

    private string StorePath(Guid user) => Path.Combine(paths.DataPath, "jellyfin-cinema", "loading-screen", user.ToString("N") + ".json");
    private string GlobalStorePath() => Path.Combine(paths.DataPath, "jellyfin-cinema", "loading-screen", "_global.json");

    private static bool Text(JsonElement value, string key, int maximum) => value.TryGetProperty(key, out var field)
        && field.ValueKind == JsonValueKind.String && field.GetString() is string text
        && text.Length <= maximum && !text.Any(char.IsControl);

    private static bool ValidSettings(JsonElement value) => value.ValueKind == JsonValueKind.Object
        && value.EnumerateObject().All(property => property.Name is "version" or "animation" or "brandText" or "message")
        && value.EnumerateObject().Select(property => property.Name).Distinct(StringComparer.Ordinal).Count() == value.EnumerateObject().Count()
        && value.TryGetProperty("version", out var version) && version.ValueKind == JsonValueKind.Number && version.TryGetInt32(out var number) && number == 1
        && value.TryGetProperty("animation", out var animation) && animation.ValueKind == JsonValueKind.String
        && animation.GetString() is "projector" or "clapperboard" or "film-reel" or "countdown" or "spotlights" or "jellyfin"
        && Text(value, "brandText", 60) && Text(value, "message", 120);

    private static async Task<LoadingScreenResponse> Read(string path, CancellationToken cancellationToken)
    {
        FileStream stream;
        try { stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 4096, FileOptions.Asynchronous | FileOptions.SequentialScan); }
        catch (FileNotFoundException) { return new(null, null); }
        catch (DirectoryNotFoundException) { return new(null, null); }
        await using var file = stream;
        if (file.Length > MaximumBytes) throw new InvalidDataException("Saved loading screen settings exceed the size limit.");
        using var reader = new StreamReader(file);
        var saved = JsonSerializer.Deserialize<LoadingScreenResponse>(await reader.ReadToEndAsync(cancellationToken));
        if (saved?.Revision is null || !Guid.TryParseExact(saved.Revision, "N", out _)
            || saved.Settings is not JsonElement settings || !ValidSettings(settings))
            throw new InvalidDataException("Saved loading screen settings are invalid.");
        return saved;
    }

    [HttpGet]
    public async Task<IActionResult> GetLoadingScreen(CancellationToken cancellationToken = default)
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
            return Ok(new LoadingScreenResponse(null, null, HasUserOverride: false, GlobalRevision: null));
        }
        finally { StoreLock.Release(); }
    }

    [HttpGet("Global")]
    public async Task<IActionResult> GetGlobalLoadingScreen(CancellationToken cancellationToken = default)
    {
        var (user, isAdmin) = await CurrentUser();
        if (user is null) return Unauthorized();
        await StoreLock.WaitAsync(cancellationToken);
        try
        {
            var globalResponse = await Read(GlobalStorePath(), cancellationToken);
            if (globalResponse.Settings is not null) return Ok(globalResponse with { HasUserOverride = false, GlobalRevision = globalResponse.Revision });
            return Ok(new LoadingScreenResponse(null, null, HasUserOverride: false, GlobalRevision: null));
        }
        finally { StoreLock.Release(); }
    }

    [HttpPut]
    [RequestSizeLimit(MaximumBytes)]
    public async Task<IActionResult> PutLoadingScreen([FromBody] LoadingScreenRequest request, CancellationToken cancellationToken = default)
    {
        var (user, _) = await CurrentUser();
        if (user is null) return Unauthorized();
        var reqRevision = string.IsNullOrWhiteSpace(request?.Revision) ? null : request.Revision;
        if (request is null || (reqRevision is not null && !Guid.TryParseExact(reqRevision, "N", out _))
            || !ValidSettings(request.Settings)) return BadRequest("Invalid loading screen settings.");
        if (Encoding.UTF8.GetByteCount(request.Settings.GetRawText()) > MaximumBytes - 1024)
            return StatusCode(413, "Loading screen settings are too large.");
        await StoreLock.WaitAsync(cancellationToken);
        try
        {
            var path = StorePath(user.Value);
            var current = await Read(path, cancellationToken);
            var globalCurrent = await Read(GlobalStorePath(), cancellationToken);
            bool revisionMatches = string.Equals(reqRevision, current.Revision, StringComparison.Ordinal)
                || (current.Revision is null && string.Equals(reqRevision, globalCurrent.Revision, StringComparison.Ordinal));
            if (!revisionMatches)
                return Conflict("Loading screen settings changed on another device. Reload them before saving.");
            var saved = new LoadingScreenResponse(Guid.NewGuid().ToString("N"), request.Settings.Clone(), HasUserOverride: true, GlobalRevision: globalCurrent.Revision);
            var serialized = JsonSerializer.Serialize(saved);
            if (Encoding.UTF8.GetByteCount(serialized) > MaximumBytes)
                return StatusCode(413, "Loading screen settings are too large.");
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

    [HttpPut("Global")]
    [RequestSizeLimit(MaximumBytes)]
    public async Task<IActionResult> PutGlobalLoadingScreen([FromBody] LoadingScreenRequest request, CancellationToken cancellationToken = default)
    {
        var (user, isAdmin) = await CurrentUser();
        if (user is null) return Unauthorized();
        if (!isAdmin) return StatusCode(403, "Apenas administradores podem alterar as configurações globais.");
        var reqRevision = string.IsNullOrWhiteSpace(request?.Revision) ? null : request.Revision;
        if (request is null || (reqRevision is not null && !Guid.TryParseExact(reqRevision, "N", out _))
            || !ValidSettings(request.Settings)) return BadRequest("Invalid loading screen settings.");
        if (Encoding.UTF8.GetByteCount(request.Settings.GetRawText()) > MaximumBytes - 1024)
            return StatusCode(413, "Loading screen settings are too large.");
        await StoreLock.WaitAsync(cancellationToken);
        try
        {
            var path = GlobalStorePath();
            var current = await Read(path, cancellationToken);
            if (reqRevision is not null && !string.Equals(reqRevision, current.Revision, StringComparison.Ordinal))
                return Conflict("Loading screen global settings changed on another device. Reload them before saving.");
            var newRev = Guid.NewGuid().ToString("N");
            var saved = new LoadingScreenResponse(newRev, request.Settings.Clone(), HasUserOverride: false, GlobalRevision: newRev);
            var serialized = JsonSerializer.Serialize(saved);
            if (Encoding.UTF8.GetByteCount(serialized) > MaximumBytes)
                return StatusCode(413, "Loading screen settings are too large.");
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
    public async Task<IActionResult> GetTargetUserLoadingScreen([FromRoute] string targetUserId, CancellationToken cancellationToken = default)
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
            return Ok(new LoadingScreenResponse(null, null, HasUserOverride: false, GlobalRevision: null));
        }
        finally { StoreLock.Release(); }
    }

    [HttpPut("User/{targetUserId}")]
    [RequestSizeLimit(MaximumBytes)]
    public async Task<IActionResult> PutTargetUserLoadingScreen([FromRoute] string targetUserId, [FromBody] LoadingScreenRequest request, CancellationToken cancellationToken = default)
    {
        var (callerId, isAdmin) = await CurrentUser();
        if (callerId is null || !isAdmin) return StatusCode(403, "Apenas administradores podem salvar configurações de outros usuários.");
        if (!Guid.TryParse(targetUserId, out var targetGuid)) return BadRequest("ID de usuário inválido.");
        var reqRevision = string.IsNullOrWhiteSpace(request?.Revision) ? null : request.Revision;
        if (request is null || (reqRevision is not null && !Guid.TryParseExact(reqRevision, "N", out _))
            || !ValidSettings(request.Settings)) return BadRequest("Invalid loading screen settings.");
        if (Encoding.UTF8.GetByteCount(request.Settings.GetRawText()) > MaximumBytes - 1024)
            return StatusCode(413, "Loading screen settings are too large.");
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
                return Conflict("Loading screen settings changed on another device. Reload them before saving.");
            var saved = new LoadingScreenResponse(Guid.NewGuid().ToString("N"), request.Settings.Clone(), HasUserOverride: true, GlobalRevision: globalCurrent.Revision);
            var serialized = JsonSerializer.Serialize(saved);
            if (Encoding.UTF8.GetByteCount(serialized) > MaximumBytes)
                return StatusCode(413, "Loading screen settings are too large.");
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
    public async Task<IActionResult> DeleteTargetUserLoadingScreen([FromRoute] string targetUserId, CancellationToken cancellationToken = default)
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
            return Ok(new LoadingScreenResponse(null, null, HasUserOverride: false, GlobalRevision: null));
        }
        finally { StoreLock.Release(); }
    }

    [HttpDelete("User")]
    public async Task<IActionResult> DeleteUserLoadingScreen(CancellationToken cancellationToken = default)
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
            return Ok(new LoadingScreenResponse(null, null, HasUserOverride: false, GlobalRevision: null));
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
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record LoadingScreenRequest(
    [property: JsonPropertyName("Revision")] string? Revision,
    [property: JsonPropertyName("Settings")] JsonElement Settings);

public sealed record LoadingScreenResponse(
    [property: JsonPropertyName("Revision"), JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Revision,
    [property: JsonPropertyName("Settings"), JsonIgnore(Condition = JsonIgnoreCondition.Never)] JsonElement? Settings,
    [property: JsonPropertyName("HasUserOverride"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] bool HasUserOverride = false,
    [property: JsonPropertyName("GlobalRevision"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? GlobalRevision = null);
