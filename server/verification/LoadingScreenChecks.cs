using System.Net;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
#if JELLYFIN_1010
using Jellyfin.Data.Entities;
using Jellyfin.Data.Enums;
#else
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
#endif
using Jellyfin.Plugin.TvItemLayout.Api;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller.Devices;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Net;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;

public static class LoadingScreenChecks
{
    public static JsonElement Settings(string animation = "projector", string brandText = "HarbourBR", string message = "Preparing your Home…")
        => JsonSerializer.SerializeToElement(new { version = 1, animation, brandText, message });

    public static async Task Run(Action<bool, string> assert)
    {
        var directory = Path.Combine(Path.GetTempPath(), "screenharbour-loading-check-" + Guid.NewGuid().ToString("N"));
        var user = new User("loading-check", "default", "reset") { Id = Guid.NewGuid() };
        user.SetPermission(PermissionKind.IsDisabled, false); user.SetPermission(PermissionKind.EnableRemoteAccess, true);
        var auth = new AuthorizationInfo { Token = "loading-token", DeviceId = "loading-device", User = user };
        var authorization = InterfaceStub.Create<IAuthorizationContext>((_, _) => Task.FromResult(auth));
        SessionInfo? session = null;
        var sessions = InterfaceStub.Create<ISessionManager>((method, args) => method.Name == "GetSessionByAuthenticationToken"
            && (string)args![0]! == auth.Token && (string)args[1]! == auth.DeviceId ? Task.FromResult(session!) : throw new Exception("Unexpected loading screen session lookup"));
        session = new SessionInfo(sessions, NullLogger.Instance) { UserId = user.Id, DeviceId = auth.DeviceId };
        var users = InterfaceStub.Create<IUserManager>((method, args) => method.Name == "GetUserById" && (Guid)args![0]! == user.Id
            ? user : throw new Exception("Loading screen settings cannot inspect another account"));
        var allowedDevice = true; var local = true;
        var devices = InterfaceStub.Create<IDeviceManager>((_, _) => allowedDevice);
        var network = InterfaceStub.Create<INetworkManager>((_, _) => local);
        var paths = InterfaceStub.Create<IApplicationPaths>((method, _) => method.Name == "get_DataPath" ? directory : throw new Exception("Unexpected loading screen storage path"));
        LoadingScreenController Controller()
        {
            var controller = new LoadingScreenController(authorization, sessions, users, devices, network, paths)
            { ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() } };
            controller.HttpContext.Connection.RemoteIpAddress = IPAddress.Loopback; return controller;
        }
        var controller = Controller(); var second = Controller();
        LoadingScreenResponse Value(IActionResult result) => (LoadingScreenResponse)((OkObjectResult)result).Value!;
        var originalUser = user.Id;
        var file = Path.Combine(directory, "jellyfin-cinema", "loading-screen", originalUser.ToString("N") + ".json");
        try
        {
            assert(typeof(LoadingScreenController).GetCustomAttribute<AuthorizeAttribute>() is not null
                && typeof(LoadingScreenController).GetCustomAttribute<ResponseCacheAttribute>() is { NoStore: true, Location: ResponseCacheLocation.None },
                "Loading screen preferences require authentication and prohibit shared caches");
            assert(Value(await controller.GetLoadingScreen()) is { Revision: null, Settings: null } && !Directory.Exists(directory),
                "First loading screen read returns explicit missing settings without writing defaults");
            var race = await Task.WhenAll(controller.PutLoadingScreen(new(null, Settings())), second.PutLoadingScreen(new(null, Settings("countdown"))));
            assert(race.Count(result => result is OkObjectResult) == 1 && race.Count(result => result is ConflictObjectResult) == 1,
                "Simultaneous first loading screen saves have exactly one winner");
            var saved = Value(await second.GetLoadingScreen());
            assert(Guid.TryParseExact(saved.Revision, "N", out _) && saved.Settings is not null && File.Exists(file),
                "Another device reads the persisted loading screen and revision from the stable account path");
            var initialRevision = saved.Revision;
            foreach (var animation in new[] { "projector", "clapperboard", "film-reel", "countdown", "spotlights", "jellyfin" })
            {
                var settings = Settings(animation, "", "");
                saved = Value(await controller.PutLoadingScreen(new(saved.Revision, settings)));
                assert(saved.Settings!.Value.GetRawText() == settings.GetRawText(), "Loading screen animation accepts saved empty text: " + animation);
            }
            var maximumText = Settings("spotlights", new string('中', 60), new string('é', 120));
            saved = Value(await controller.PutLoadingScreen(new(saved.Revision, maximumText)));
            assert(saved.Settings!.Value.GetRawText() == maximumText.GetRawText(), "Loading screen text preserves valid Unicode at both maximum lengths");
            var literal = Settings("film-reel", " <b>Family cinema</b> ", "The show starts soon 🎬");
            saved = Value(await controller.PutLoadingScreen(new(saved.Revision, literal)));
            assert(saved.Settings!.Value.GetRawText() == literal.GetRawText(), "Loading screen text remains literal and preserves intentional spacing and symbols");
            assert(await controller.PutLoadingScreen(new(initialRevision, Settings())) is ConflictObjectResult
                && await controller.PutLoadingScreen(new(null, Settings())) is ConflictObjectResult
                && Value(await controller.GetLoadingScreen()).Revision == saved.Revision,
                "Stale and first-use loading screen saves cannot overwrite a newer customization");
            var bytes = await File.ReadAllBytesAsync(file);
            var otherSettings = Path.Combine(directory, "unrelated-settings.json");
            await File.WriteAllTextAsync(otherSettings, "preserve other preferences");
            user.Id = Guid.NewGuid(); session.UserId = user.Id;
            assert(Value(await controller.GetLoadingScreen()) is { Revision: null, Settings: null }, "Loading screen settings are isolated for another profile");
            var other = Value(await controller.PutLoadingScreen(new(null, Settings("jellyfin", "Other profile", ""))));
            user.Id = originalUser; session.UserId = user.Id;
            assert(Value(await controller.GetLoadingScreen()).Revision == saved.Revision && other.Revision != saved.Revision
                && (await File.ReadAllBytesAsync(file)).SequenceEqual(bytes) && await File.ReadAllTextAsync(otherSettings) == "preserve other preferences",
                "Another profile's save and returning Home preserve existing account and unrelated settings");
            var invalid = new List<string> { "null", "[]", "{}", "true",
                "{\"version\":1,\"animation\":\"projector\",\"brandText\":\"\",\"message\":\"\",\"message\":\"duplicate\"}" };
            foreach (var mutate in new Action<JsonNode>[] {
                node => node["version"] = 0, node => node["version"] = 2, node => node["version"] = "1", node => node["version"] = null,
                node => node["animation"] = "unknown", node => node["animation"] = "Projector", node => node["animation"] = null,
                node => node["brandText"] = null, node => node["brandText"] = new string('a', 61), node => node["message"] = new string('a', 121),
                node => node["brandText"] = "line\nline", node => node["message"] = "line\tline", node => node["message"] = "bad\0text",
                node => node["brandText"] = "bad\u007ftext", node => node["message"] = "bad\u0085text", node => node["message"] = true,
                node => node["UserId"] = Guid.NewGuid().ToString("N"), node => node.AsObject().Remove("message"),
                node => { node["BrandText"] = node["brandText"]!.GetValue<string>(); node.AsObject().Remove("brandText"); }
            })
            {
                var node = JsonNode.Parse(Settings().GetRawText())!; mutate(node); invalid.Add(node.ToJsonString());
            }
            assert((await Task.WhenAll(invalid.Select(async json => await controller.PutLoadingScreen(new(saved.Revision,
                JsonDocument.Parse(json).RootElement.Clone())) is BadRequestObjectResult))).All(rejected => rejected),
                "Loading screen validation rejects unsupported versions/animations, missing/duplicate/unknown fields, invalid text types, length overflow and controls");
            assert(await controller.PutLoadingScreen(new("../not-a-revision", Settings())) is BadRequestObjectResult
                && await controller.PutLoadingScreen(new(saved.Revision, default)) is BadRequestObjectResult
                && Value(await controller.GetLoadingScreen()).Revision == saved.Revision,
                "Malformed loading screen revisions and missing settings cannot alter persisted state");
            var padded = JsonDocument.Parse("{ " + new string(' ', LoadingScreenController.MaximumBytes) + Settings().GetRawText()[1..]).RootElement.Clone();
            assert(await controller.PutLoadingScreen(new(saved.Revision, padded)) is ObjectResult { StatusCode: 413 }
                && (await File.ReadAllBytesAsync(file)).SequenceEqual(bytes), "Excessive loading screen request bytes cannot replace valid settings");
            using var cancellation = new CancellationTokenSource(); cancellation.Cancel();
            var cancelled = false;
            try { await controller.PutLoadingScreen(new(saved.Revision, Settings()), cancellation.Token); } catch (OperationCanceledException) { cancelled = true; }
            assert(cancelled && (await File.ReadAllBytesAsync(file)).SequenceEqual(bytes), "Cancelled loading screen saves leave the complete last revision intact");
            auth.IsApiKey = true;
            assert(await controller.GetLoadingScreen() is UnauthorizedResult && await controller.PutLoadingScreen(new(saved.Revision, Settings())) is UnauthorizedResult,
                "API keys cannot read or write personal loading screen preferences");
            auth.IsApiKey = false; auth.Token = " ";
            assert(await controller.GetLoadingScreen() is UnauthorizedResult, "Missing tokens cannot read loading screen settings");
            auth.Token = "loading-token"; auth.DeviceId = " ";
            assert(await controller.GetLoadingScreen() is UnauthorizedResult, "Missing device identity cannot read loading screen settings");
            auth.DeviceId = "loading-device"; auth.User = null;
            assert(await controller.GetLoadingScreen() is UnauthorizedResult, "Signed-out clients cannot read loading screen settings");
            auth.User = user; var validSession = session; session = null;
            assert(await controller.GetLoadingScreen() is UnauthorizedResult, "Revoked sessions cannot read loading screen settings");
            session = validSession; session.UserId = Guid.NewGuid();
            assert(await controller.GetLoadingScreen() is UnauthorizedResult, "Another profile's session cannot read loading screen settings");
            session.UserId = user.Id; session.DeviceId = "different-device";
            assert(await controller.GetLoadingScreen() is UnauthorizedResult, "Another device's session cannot read loading screen settings");
            session.DeviceId = auth.DeviceId; allowedDevice = false;
            assert(await controller.PutLoadingScreen(new(saved.Revision, Settings())) is UnauthorizedResult, "Revoked device access prevents loading screen writes");
            allowedDevice = true; user.SetPermission(PermissionKind.IsDisabled, true);
            assert(await controller.GetLoadingScreen() is UnauthorizedResult, "Disabled users cannot read loading screen settings");
            user.SetPermission(PermissionKind.IsDisabled, false);
            user.AccessSchedules.Add(new AccessSchedule(DynamicDayOfWeek.Everyday, 24, 24, user.Id));
            assert(await controller.GetLoadingScreen() is UnauthorizedResult, "Parental access schedules apply to loading screen preferences");
            user.AccessSchedules.Clear(); local = false; user.SetPermission(PermissionKind.EnableRemoteAccess, false);
            assert(await controller.PutLoadingScreen(new(saved.Revision, Settings())) is UnauthorizedResult, "Remote access restrictions prevent loading screen writes");
            local = true;
            assert(Value(await controller.GetLoadingScreen()).Revision == saved.Revision && (await File.ReadAllBytesAsync(file)).SequenceEqual(bytes)
                && !Directory.GetFiles(directory, "*.tmp", SearchOption.AllDirectories).Any(), "Rejected loading screen changes preserve the last revision and leave no temporary files");
            await File.WriteAllTextAsync(file, "{\"Revision\":\"invalid\",\"Settings\":null}");
            var corrupt = false;
            try { await controller.GetLoadingScreen(); } catch (InvalidDataException) { corrupt = true; }
            assert(corrupt, "Damaged loading screen storage reports failure instead of returning first-use defaults");
            await File.WriteAllBytesAsync(file, bytes);
            assert(Value(await Controller().GetLoadingScreen()).Revision == saved.Revision, "Restoring loading screen storage recovers the saved settings without a stuck lock");
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
        await LoadingScreenHttpChecks.Run(assert);
    }
}
