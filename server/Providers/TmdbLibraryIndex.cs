using System.Collections.Concurrent;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.TvItemLayout.Providers;

public sealed class TmdbLibraryIndex : IDisposable
{
    private readonly ILibraryManager _libraryManager;
    private readonly ILogger<TmdbLibraryIndex> _logger;
    private readonly ConcurrentDictionary<int, Guid> _moviesByTmdb = new();
    private readonly ConcurrentDictionary<Guid, int> _tmdbByMovieId = new();
    private readonly ConcurrentDictionary<int, Guid> _seriesByTmdb = new();
    private readonly ConcurrentDictionary<Guid, int> _tmdbBySeriesId = new();

    private readonly SemaphoreSlim _initLock = new(1, 1);
    private volatile bool _initialized;
    private readonly Timer? _periodicTimer;
    private bool _disposed;

    public TmdbLibraryIndex(ILibraryManager libraryManager, ILogger<TmdbLibraryIndex> logger)
    {
        _libraryManager = libraryManager;
        _logger = logger;

        try
        {
            _libraryManager.ItemAdded += OnItemAdded;
            _libraryManager.ItemUpdated += OnItemUpdated;
            _libraryManager.ItemRemoved += OnItemRemoved;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to subscribe to ILibraryManager item events.");
        }

        _periodicTimer = new Timer(_ => _ = RebuildIndexAsync(CancellationToken.None), null, TimeSpan.FromMinutes(30), TimeSpan.FromMinutes(30));
    }

    public bool IsInitialized => _initialized;

    public async Task EnsureInitializedAsync(CancellationToken cancellationToken = default)
    {
        if (_initialized) return;
        await _initLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (_initialized) return;
            await RebuildIndexCoreAsync(cancellationToken).ConfigureAwait(false);
            _initialized = true;
        }
        finally
        {
            _initLock.Release();
        }
    }

    public Task RebuildIndexAsync(CancellationToken cancellationToken)
    {
        return RebuildIndexCoreAsync(cancellationToken);
    }

    private Task RebuildIndexCoreAsync(CancellationToken cancellationToken)
    {
        try
        {
            _logger.LogInformation("Building TmdbLibraryIndex from local acervo...");
            var movieQuery = new InternalItemsQuery
            {
                IncludeItemTypes = [BaseItemKind.Movie],
                Recursive = true,
                IsVirtualItem = false,
                IsMissing = false,
                EnableTotalRecordCount = false
            };
            var movies = _libraryManager.GetItemList(movieQuery);
            cancellationToken.ThrowIfCancellationRequested();

            var currentMovies = new HashSet<Guid>();
            foreach (var item in movies)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (TryGetTmdbId(item, out var tmdbId))
                {
                    _moviesByTmdb[tmdbId] = item.Id;
                    _tmdbByMovieId[item.Id] = tmdbId;
                    currentMovies.Add(item.Id);
                }
            }

            // Cleanup any deleted movies
            foreach (var (itemId, tmdbId) in _tmdbByMovieId)
            {
                if (!currentMovies.Contains(itemId))
                {
                    _tmdbByMovieId.TryRemove(itemId, out _);
                    _moviesByTmdb.TryRemove(tmdbId, out _);
                }
            }

            var seriesQuery = new InternalItemsQuery
            {
                IncludeItemTypes = [BaseItemKind.Series],
                Recursive = true,
                IsVirtualItem = false,
                IsMissing = false,
                EnableTotalRecordCount = false
            };
            var seriesList = _libraryManager.GetItemList(seriesQuery);
            cancellationToken.ThrowIfCancellationRequested();

            var currentSeries = new HashSet<Guid>();
            foreach (var item in seriesList)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (TryGetTmdbId(item, out var tmdbId))
                {
                    _seriesByTmdb[tmdbId] = item.Id;
                    _tmdbBySeriesId[item.Id] = tmdbId;
                    currentSeries.Add(item.Id);
                }
            }

            // Cleanup any deleted series
            foreach (var (itemId, tmdbId) in _tmdbBySeriesId)
            {
                if (!currentSeries.Contains(itemId))
                {
                    _tmdbBySeriesId.TryRemove(itemId, out _);
                    _seriesByTmdb.TryRemove(tmdbId, out _);
                }
            }

            _logger.LogInformation("TmdbLibraryIndex built successfully: {MovieCount} movies, {SeriesCount} series.",
                _moviesByTmdb.Count, _seriesByTmdb.Count);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogError(ex, "Failed to build TmdbLibraryIndex.");
        }

        return Task.CompletedTask;
    }

    public bool TryGetMovie(int tmdbId, out Guid itemId) => _moviesByTmdb.TryGetValue(tmdbId, out itemId);

    public bool TryGetSeries(int tmdbId, out Guid itemId) => _seriesByTmdb.TryGetValue(tmdbId, out itemId);

    public bool TryGetTmdbByMovieId(Guid itemId, out int tmdbId) => _tmdbByMovieId.TryGetValue(itemId, out tmdbId);

    public bool TryGetTmdbBySeriesId(Guid itemId, out int tmdbId) => _tmdbBySeriesId.TryGetValue(itemId, out tmdbId);

    private void OnItemAdded(object? sender, ItemChangeEventArgs e) => IndexItem(e.Item);

    private void OnItemUpdated(object? sender, ItemChangeEventArgs e) => IndexItem(e.Item);

    private void OnItemRemoved(object? sender, ItemChangeEventArgs e) => UnindexItem(e.Item);

    private void IndexItem(BaseItem? item)
    {
        if (item is null || item.IsVirtualItem) return;

        if (item is Movie movie)
        {
            if (TryGetTmdbId(movie, out var tmdbId))
            {
                if (_tmdbByMovieId.TryGetValue(movie.Id, out var oldTmdbId) && oldTmdbId != tmdbId)
                {
                    _moviesByTmdb.TryRemove(oldTmdbId, out _);
                }
                _moviesByTmdb[tmdbId] = movie.Id;
                _tmdbByMovieId[movie.Id] = tmdbId;
            }
        }
        else if (item is Series series)
        {
            if (TryGetTmdbId(series, out var tmdbId))
            {
                if (_tmdbBySeriesId.TryGetValue(series.Id, out var oldTmdbId) && oldTmdbId != tmdbId)
                {
                    _seriesByTmdb.TryRemove(oldTmdbId, out _);
                }
                _seriesByTmdb[tmdbId] = series.Id;
                _tmdbBySeriesId[series.Id] = tmdbId;
            }
        }
    }

    private void UnindexItem(BaseItem? item)
    {
        if (item is null) return;
        if (_tmdbByMovieId.TryRemove(item.Id, out var movieTmdbId))
        {
            _moviesByTmdb.TryRemove(movieTmdbId, out _);
        }
        if (_tmdbBySeriesId.TryRemove(item.Id, out var seriesTmdbId))
        {
            _seriesByTmdb.TryRemove(seriesTmdbId, out _);
        }
    }

    public static bool TryGetTmdbId(BaseItem item, out int tmdbId)
    {
        tmdbId = 0;
        return item.ProviderIds != null
            && item.ProviderIds.TryGetValue("Tmdb", out var idStr)
            && int.TryParse(idStr, out tmdbId)
            && tmdbId > 0;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _periodicTimer?.Dispose();
        _initLock.Dispose();
        try
        {
            _libraryManager.ItemAdded -= OnItemAdded;
            _libraryManager.ItemUpdated -= OnItemUpdated;
            _libraryManager.ItemRemoved -= OnItemRemoved;
        }
        catch { }
    }
}
