using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Jellyfin.Data.Enums;
#if JELLYFIN_1010
using User = Jellyfin.Data.Entities.User;
#else
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Enums;
using User = Jellyfin.Database.Implementations.Entities.User;
#endif
using Jellyfin.Plugin.TvItemLayout.Providers;
using Jellyfin.Plugin.TvItemLayout.Watchlists;
using MediaBrowser.Common.Extensions;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller.Devices;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Net;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.TvItemLayout.Api;

[ApiController]
[Route("TvItemLayout/Providers")]
[Authorize]
[ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
public sealed class ProviderItemsController(
    IAuthorizationContext authorizationContext,
    ISessionManager sessionManager,
    IUserManager userManager,
    IDeviceManager deviceManager,
    INetworkManager networkManager,
    ILibraryManager libraryManager,
    IDtoService dtoService,
    IProviderAvailability availability,
    IApplicationPaths paths,
    TmdbProviderSource source,
    WatchlistService watchlists,
    TmdbLibraryIndex? libraryIndex = null,
    TrendingPrewarmService? prewarmService = null) : ControllerBase
{
    private async Task<User?> CurrentUser()
    {
        var authorization = await authorizationContext.GetAuthorizationInfo(HttpContext);
        if (string.IsNullOrWhiteSpace(authorization.Token) || string.IsNullOrWhiteSpace(authorization.DeviceId)
            || authorization.UserId == Guid.Empty || authorization.IsApiKey) return null;
        var remoteIp = HttpContext.GetNormalizedRemoteIP();
        var session = await sessionManager.GetSessionByAuthenticationToken(authorization.Token,
            authorization.DeviceId, remoteIp.ToString());
        if (session is null || session.UserId != authorization.UserId
            || !string.Equals(session.DeviceId, authorization.DeviceId, StringComparison.Ordinal)) return null;
        var caller = userManager.GetUserById(authorization.UserId);
        if (caller is null || caller.HasPermission(PermissionKind.IsDisabled) || !caller.IsParentalScheduleAllowed()
            || !deviceManager.CanAccessDevice(caller, authorization.DeviceId)
            || (!networkManager.IsInLocalNetwork(remoteIp) && !caller.HasPermission(PermissionKind.EnableRemoteAccess))) return null;
        return caller;
    }

    [HttpGet("Catalogue")]
    public async Task<IActionResult> GetProviderDirectory(CancellationToken cancellationToken = default)
    {
        if (await CurrentUser() is null) return Unauthorized();
        try { return Ok(await source.DirectoryAsync(cancellationToken)); }
        catch (ProviderLookupException) { return StatusCode(503, "Streaming service list is temporarily unavailable. Try again."); }
    }

    [HttpGet("{providerId}/Items")]
    public async Task<IActionResult> GetProviderItems(string providerId, [FromQuery] string type = "Movie",
        [FromQuery] int startIndex = 0, [FromQuery] int limit = 60, [FromQuery] string sort = "title",
        CancellationToken cancellationToken = default, [FromQuery] bool watchlist = false)
    {
        var user = await CurrentUser();
        if (user is null) return Unauthorized();
        if (!ProviderHomesSchema.ValidProvider(providerId) || !ValidQuery(type, startIndex, limit, sort))
            return BadRequest("Invalid provider catalogue query.");
        var settings = await ProviderHomesController.ReadForUser(paths, user.Id, cancellationToken);
        var configured = ProviderHomesSchema.Resolve(settings.Settings, providerId);
        if (configured is null || !configured.Enabled) return NotFound("This streaming service is not enabled for the current account.");
        return await Items(user, configured, type, startIndex, limit, sort, watchlist, cancellationToken);
    }

    [HttpPost("Preview")]
    [RequestSizeLimit(ProviderHomesController.MaximumBytes)]
    public async Task<IActionResult> PreviewProviderItems([FromBody] JsonElement provider, [FromQuery] string mediaType = "Movie",
        [FromQuery] int startIndex = 0, [FromQuery] int limit = 60, [FromQuery] string sort = "title",
        CancellationToken cancellationToken = default, [FromQuery] bool watchlist = false)
    {
        var user = await CurrentUser();
        if (user is null) return Unauthorized();
        if (!ValidQuery(mediaType, startIndex, limit, sort)) return BadRequest("Invalid provider preview query.");
        if (provider.ValueKind == JsonValueKind.Undefined) return BadRequest("Invalid provider preview settings.");
        if (Encoding.UTF8.GetByteCount(provider.GetRawText()) > ProviderHomesController.MaximumBytes - 1024)
            return StatusCode(413, "Provider preview settings are too large.");
        var draft = JsonSerializer.SerializeToElement(new { version = 2, enabled = true, title = "", placement = "start", tileScale = 100, showNames = true, providers = new[] { provider } });
        if (!ProviderHomesSchema.ValidSettings(draft)) return BadRequest("Invalid provider preview settings.");
        var configured = ProviderHomesSchema.Resolve(draft, provider.GetProperty("id").GetString()!)!;
        return await Items(user, configured, mediaType, startIndex, limit, sort, watchlist, cancellationToken);
    }

    [HttpGet("{providerId}/Trending")]
    public async Task<IActionResult> GetProviderTrending(string providerId, [FromQuery] string type = "Movie",
        [FromQuery] int limit = 20, CancellationToken cancellationToken = default)
    {
        var user = await CurrentUser();
        if (user is null) return Unauthorized();
        if (!ProviderHomesSchema.ValidProvider(providerId) || type is not ("Movie" or "Series") || limit is < 1 or > 100)
            return BadRequest("Invalid provider trending query.");
        var settings = await ProviderHomesController.ReadForUser(paths, user.Id, cancellationToken);
        var configured = ProviderHomesSchema.Resolve(settings.Settings, providerId);
        if (configured is null || !configured.Enabled) return NotFound("This streaming service is not enabled for the current account.");
        return Ok(await TrendingItemsCore(providerId, user, configured, type, limit, cancellationToken));
    }

    [HttpGet("{providerId}/TrendingBatch")]
    public async Task<IActionResult> GetProviderTrendingBatch(string providerId, [FromQuery] int limit = 20, CancellationToken cancellationToken = default)
    {
        var user = await CurrentUser();
        if (user is null) return Unauthorized();
        if (!ProviderHomesSchema.ValidProvider(providerId) || limit is < 1 or > 100)
            return BadRequest("Invalid provider trending batch query.");
        var settings = await ProviderHomesController.ReadForUser(paths, user.Id, cancellationToken);
        var configured = ProviderHomesSchema.Resolve(settings.Settings, providerId);
        if (configured is null || !configured.Enabled) return NotFound("This streaming service is not enabled for the current account.");

        var moviesTask = TrendingItemsCore(providerId, user, configured, "Movie", limit, cancellationToken);
        var seriesTask = TrendingItemsCore(providerId, user, configured, "Series", limit, cancellationToken);
        await Task.WhenAll(moviesTask, seriesTask);

        return Ok(new ProviderTrendingBatchResponse(moviesTask.Result, seriesTask.Result));
    }

    [HttpPost("Trending/Preview")]
    [RequestSizeLimit(ProviderHomesController.MaximumBytes)]
    public async Task<IActionResult> PreviewProviderTrending([FromBody] JsonElement provider, [FromQuery] string mediaType = "Movie",
        [FromQuery] int limit = 20, CancellationToken cancellationToken = default)
    {
        var user = await CurrentUser();
        if (user is null) return Unauthorized();
        if (mediaType is not ("Movie" or "Series") || limit is < 1 or > 100) return BadRequest("Invalid provider trending preview query.");
        if (provider.ValueKind == JsonValueKind.Undefined) return BadRequest("Invalid provider preview settings.");
        if (Encoding.UTF8.GetByteCount(provider.GetRawText()) > ProviderHomesController.MaximumBytes - 1024)
            return StatusCode(413, "Provider preview settings are too large.");
        var draft = JsonSerializer.SerializeToElement(new { version = 2, enabled = true, title = "", placement = "start", tileScale = 100, showNames = true, providers = new[] { provider } });
        if (!ProviderHomesSchema.ValidSettings(draft)) return BadRequest("Invalid provider preview settings.");
        var providerId = provider.GetProperty("id").GetString()!;
        var configured = ProviderHomesSchema.Resolve(draft, providerId)!;
        return Ok(await TrendingItemsCore(providerId, user, configured, mediaType, limit, cancellationToken));
    }

    [HttpPost("TrendingBatch/Preview")]
    [RequestSizeLimit(ProviderHomesController.MaximumBytes)]
    public async Task<IActionResult> PreviewProviderTrendingBatch([FromBody] JsonElement provider,
        [FromQuery] int limit = 20, CancellationToken cancellationToken = default)
    {
        var user = await CurrentUser();
        if (user is null) return Unauthorized();
        if (limit is < 1 or > 100) return BadRequest("Invalid provider trending preview query.");
        if (provider.ValueKind == JsonValueKind.Undefined) return BadRequest("Invalid provider preview settings.");
        if (Encoding.UTF8.GetByteCount(provider.GetRawText()) > ProviderHomesController.MaximumBytes - 1024)
            return StatusCode(413, "Provider preview settings are too large.");
        var draft = JsonSerializer.SerializeToElement(new { version = 2, enabled = true, title = "", placement = "start", tileScale = 100, showNames = true, providers = new[] { provider } });
        if (!ProviderHomesSchema.ValidSettings(draft)) return BadRequest("Invalid provider preview settings.");
        var providerId = provider.GetProperty("id").GetString()!;
        var configured = ProviderHomesSchema.Resolve(draft, providerId)!;

        var moviesTask = TrendingItemsCore(providerId, user, configured, "Movie", limit, cancellationToken);
        var seriesTask = TrendingItemsCore(providerId, user, configured, "Series", limit, cancellationToken);
        await Task.WhenAll(moviesTask, seriesTask);

        return Ok(new ProviderTrendingBatchResponse(moviesTask.Result, seriesTask.Result));
    }

    private async Task<ProviderItemsResponse> TrendingItemsCore(string providerId, User user, ConfiguredProvider configured, string type, int limit, CancellationToken cancellationToken)
    {
        var providerIds = type == "Movie" ? configured.MovieProviderIds : configured.ShowProviderIds;
        if (providerIds.Length == 0)
            return new ProviderItemsResponse([], 0, 0, 0, DateTimeOffset.UtcNow, "ready", TmdbProviderSource.Region, 0, 0);

        var options = new DtoOptions(false)
        {
            EnableImages = true,
            EnableUserData = true,
            Fields = [ItemFields.Overview, ItemFields.Genres, ItemFields.DateCreated, ItemFields.PrimaryImageAspectRatio, ItemFields.ProviderIds]
        };

        var matched = new List<BaseItem>();

        // Fast path 1: Check precomputed matches from TrendingPrewarmService
        if (prewarmService is not null && prewarmService.TryGetPrecomputedGuids(providerId, type, out var precomputedGuids))
        {
            foreach (var itemId in precomputedGuids)
            {
                var item = libraryManager.GetItemById(itemId);
                if (item is not null && !item.IsVirtualItem && item.IsVisibleStandalone(user))
                {
                    matched.Add(item);
                    if (matched.Count >= limit) break;
                }
            }

            if (matched.Count > 0)
            {
                var precomputedItems = matched.Select(item => dtoService.GetBaseItemDto(item, options, user)).ToArray();
                return new ProviderItemsResponse(precomputedItems, precomputedItems.Length, 0, precomputedItems.Length, DateTimeOffset.UtcNow, "ready", TmdbProviderSource.Region, 0, 0);
            }
        }

        int[] tmdbTrendingIds;
        try
        {
            tmdbTrendingIds = await source.DiscoverTrendingTmdbIdsAsync(type, providerIds, cancellationToken);
        }
        catch (ProviderLookupException)
        {
            return new ProviderItemsResponse([], 0, 0, 0, DateTimeOffset.UtcNow, "unavailable", TmdbProviderSource.Region, 0, 0);
        }

        if (tmdbTrendingIds.Length == 0)
            return new ProviderItemsResponse([], 0, 0, 0, DateTimeOffset.UtcNow, "ready", TmdbProviderSource.Region, 0, 0);

        var isMovie = type == "Movie";

        if (libraryIndex is not null)
        {
            foreach (var tmdbId in tmdbTrendingIds)
            {
                Guid itemId;
                var found = isMovie ? libraryIndex.TryGetMovie(tmdbId, out itemId) : libraryIndex.TryGetSeries(tmdbId, out itemId);
                if (found)
                {
                    var item = libraryManager.GetItemById(itemId);
                    if (item is not null && !item.IsVirtualItem && item.IsVisibleStandalone(user))
                    {
                        matched.Add(item);
                        if (matched.Count >= limit) break;
                    }
                }
            }
        }
        else
        {
            var query = new InternalItemsQuery(user)
            {
                IncludeItemTypes = [isMovie ? BaseItemKind.Movie : BaseItemKind.Series],
                Recursive = true,
                IsVirtualItem = false,
                IsMissing = false,
                EnableTotalRecordCount = false
            };
            var permitted = libraryManager.GetItemList(query);
            cancellationToken.ThrowIfCancellationRequested();

            var localByTmdbId = new Dictionary<int, BaseItem>();
            foreach (var item in permitted)
            {
                if (item.ProviderIds.TryGetValue("Tmdb", out var idStr) && int.TryParse(idStr, out var id) && !localByTmdbId.ContainsKey(id))
                {
                    localByTmdbId[id] = item;
                }
            }

            foreach (var tmdbId in tmdbTrendingIds)
            {
                if (localByTmdbId.TryGetValue(tmdbId, out var localItem))
                {
                    matched.Add(localItem);
                    if (matched.Count >= limit) break;
                }
            }
        }

        var items = matched.Select(item => dtoService.GetBaseItemDto(item, options, user)).ToArray();
        return new ProviderItemsResponse(items, items.Length, 0, items.Length, DateTimeOffset.UtcNow, "ready", TmdbProviderSource.Region, 0, 0);
    }

    private static bool ValidQuery(string type, int startIndex, int limit, string sort) => type is "Movie" or "Series" or "Mixed"
        && startIndex >= 0 && limit is >= 1 and <= 200 && sort is "title" or "title-desc" or "newest" or "oldest";

    private async Task<IActionResult> Items(User user, ConfiguredProvider configured, string type, int startIndex, int limit, string sort, bool watchlist, CancellationToken cancellationToken)
    {
        if (type == "Movie" && configured.MovieProviderIds.Length == 0 || type == "Series" && configured.ShowProviderIds.Length == 0
            || type == "Mixed" && configured.MovieProviderIds.Length == 0 && configured.ShowProviderIds.Length == 0)
            return Ok(new ProviderItemsResponse([], 0, 0, 0, null, "unavailable", TmdbProviderSource.Region, 0, 0));
        // Construct with the current User (not merely UserId) to apply parental ratings,
        // blocked/unrated content and tags. Leave all explicit item/parent constraints empty:
        // ILibraryManager then applies that user's permitted library roots on every request.
        var query = new InternalItemsQuery(user)
        {
            IncludeItemTypes = type == "Mixed" ? [BaseItemKind.Movie, BaseItemKind.Series] : [type == "Movie" ? BaseItemKind.Movie : BaseItemKind.Series],
            Recursive = true, IsVirtualItem = false, IsMissing = false,
            EnableTotalRecordCount = false
        };
        IEnumerable<BaseItem> permitted = libraryManager.GetItemList(query);
        cancellationToken.ThrowIfCancellationRequested();
        if (watchlist)
        {
            HashSet<Guid> saved;
            try { saved = await watchlists.ReadIds(user, cancellationToken); }
            catch (WatchlistException error) { return UnprocessableEntity(error.Message); }
            permitted = permitted.Where(item => saved.Contains(item.Id));
        }
        var identified = permitted.Select(item => (Item: item, Affiliated: ProviderStudioAffiliation.Includes(item, configured), Key: LookupKey(item,
            type == "Mixed" ? item is MediaBrowser.Controller.Entities.TV.Series ? "Series" : "Movie" : type))).ToArray();
        // A known studio affiliation needs no availability lookup or matching metadata.
        // Other titles still use regional offers, including licensed Disney+ content.
        var snapshot = await availability.ReadAsync(identified.Where(item => !item.Affiliated && item.Key is not null).Select(item => item.Key!), cancellationToken);
        var matching = identified.Where(item => item.Affiliated || item.Key is not null && snapshot.Memberships.TryGetValue(item.Key, out var providers)
            && providers.Includes(item.Item is MediaBrowser.Controller.Entities.TV.Series ? configured.ShowProviderIds : configured.MovieProviderIds, configured.OfferTypes)).Select(item => item.Item);
        IOrderedEnumerable<BaseItem> ordered = sort switch
        {
            "title-desc" => matching.OrderByDescending(item => item.SortName, StringComparer.OrdinalIgnoreCase),
            "newest" => matching.OrderBy(item => item.ProductionYear is null).ThenByDescending(item => item.ProductionYear),
            "oldest" => matching.OrderBy(item => item.ProductionYear is null).ThenBy(item => item.ProductionYear),
            _ => matching.OrderBy(item => item.SortName, StringComparer.OrdinalIgnoreCase)
        };
        var sorted = ordered.ThenBy(item => item.SortName, StringComparer.OrdinalIgnoreCase).ThenBy(item => item.Id).ToArray();
        var options = new DtoOptions(false)
        {
            EnableImages = true, EnableUserData = true,
            Fields = [ItemFields.Overview, ItemFields.Genres, ItemFields.DateCreated, ItemFields.PrimaryImageAspectRatio, ItemFields.ProviderIds]
        };
        var items = sorted.Skip(startIndex).Take(limit).Select(item => dtoService.GetBaseItemDto(item, options, user)).ToArray();
        var missingIds = identified.Count(item => !item.Affiliated && item.Key is null);
        var status = sorted.Length == 0 && snapshot.Total == 0 && missingIds > 0 ? "unavailable" : snapshot.Status;
        return Ok(new ProviderItemsResponse(items, sorted.Length, snapshot.Pending, snapshot.Total, snapshot.UpdatedAt,
            status, TmdbProviderSource.Region, missingIds, snapshot.FailedIds));
    }

    public static string? LookupKey(BaseItem item, string type)
    {
        if (!item.ProviderIds.TryGetValue("Tmdb", out var value) || !long.TryParse(value, out var id) || id <= 0 || id > 9999999999) return null;
        return (type == "Movie" ? "movie:" : "tv:") + id.ToString(System.Globalization.CultureInfo.InvariantCulture);
    }
}

public sealed record ProviderItemsResponse(
    [property: JsonPropertyName("Items")] BaseItemDto[] Items,
    [property: JsonPropertyName("TotalRecordCount")] int TotalRecordCount,
    [property: JsonPropertyName("Pending")] int Pending,
    [property: JsonPropertyName("Total")] int Total,
    [property: JsonPropertyName("UpdatedAt"), JsonIgnore(Condition = JsonIgnoreCondition.Never)] DateTimeOffset? UpdatedAt,
    [property: JsonPropertyName("Status")] string Status,
    [property: JsonPropertyName("Region")] string Region,
    [property: JsonPropertyName("MissingIds")] int MissingIds,
    [property: JsonPropertyName("FailedIds")] int FailedIds);

public sealed record ProviderTrendingBatchResponse(
    [property: JsonPropertyName("Movies")] ProviderItemsResponse Movies,
    [property: JsonPropertyName("Series")] ProviderItemsResponse Series);
