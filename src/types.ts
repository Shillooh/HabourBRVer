import type { LoadingScreenTransport } from './loading-settings-store';
import type { BrowseApi } from './browse-api';
import type { HomeCollectionTransport } from './home-collection-store';
import type { ProviderHomesTransport } from './provider-settings-store';
import type { ProviderId, ProviderHomeConfig } from './provider-settings';
import type { ProviderItemsQuery, ProviderItemsPage } from './provider-data';
import type { LiveTvTransport } from './livetv-settings-store';

export type ProviderDirectoryEntry = { Id: number; Name: string };
export type ProviderDirectory = { Region: 'BR'; Movies: ProviderDirectoryEntry[]; Shows: ProviderDirectoryEntry[] };

export type ItemUserData = {
  ItemId?: string; Key?: string;
  PlaybackPositionTicks?: number; Played?: boolean; IsFavorite?: boolean; PlayedPercentage?: number | null;
  PlayCount?: number; LastPlayedDate?: string | null; UnplayedItemCount?: number | null;
  Rating?: number | null; Likes?: boolean | null;
};

export type Item = {
  Id: string; Name: string; Type?: string; Overview?: string; OriginalTitle?: string;
  CollectionType?: string;
  Artists?: string[]; AlbumArtist?: string; Album?: string; AlbumId?: string;
  PlaylistItemId?: string;
  IsInProgress?: boolean; Status?: string; MediaType?: string; IsFolder?: boolean;
  ExtraType?: string;
  ProductionYear?: number; OfficialRating?: string; CommunityRating?: number;
  RunTimeTicks?: number; Genres?: string[]; Tags?: string[]; Taglines?: string[];
  LocalTrailerCount?: number; RemoteTrailers?: { Url?: string; Name?: string }[];
  People?: { Name?: string; Type?: string; Role?: string }[];
  IndexNumber?: number; ParentIndexNumber?: number; SeriesId?: string; SeriesName?: string;
  SeasonId?: string; ChildCount?: number; RecursiveItemCount?: number;
  ChannelId?: string; ChannelName?: string; ChannelNumber?: string; Number?: string;
  StartDate?: string; EndDate?: string; CurrentProgram?: Item;
  PremiereDate?: string; LocationType?: string; PlayAccess?: string;
  IsMissing?: boolean; IsVirtualItem?: boolean; IsPlaceHolder?: boolean;
  ImageTags?: Record<string, string>; BackdropImageTags?: string[];
  ParentBackdropItemId?: string; ParentBackdropImageTags?: string[];
  SeriesPrimaryImageTag?: string; MediaStreams?: { Type?: string; Width?: number; DisplayTitle?: string; Language?: string }[];
  UserData?: ItemUserData;
};

export type LibraryQuery = {
  parentId?: string; search?: string; letter?: string; genreId?: string;
  favorite?: boolean; startIndex?: number; limit?: number;
};
export type MovieQuery = LibraryQuery;
export type ItemPage = { items: Item[]; total: number; nextStartIndex: number };
export type WatchlistQuery = LibraryQuery & { type?: 'Movie' | 'Series' | 'All'; sort?: 'collection' | 'title' | 'title-desc' | 'newest' | 'oldest' };
export type WatchlistState = { ItemId: string; InWatchlist: boolean };
export type SuggestionSection = { title: string; items: Item[] };

export type PlaybackContext = {
  PlayingItemId: string;
  PlayingItemType?: string;
  PlayingItemExtraType?: string;
  PlaylistItemId?: string;
  Queue: { Id: string; PlaylistItemId?: string }[];
};

export type TrailerIdentity = { PlayingItemId: string; PlaylistItemId?: string };
export type TrailerDetailsContext = TrailerIdentity & {
  Movie: { Id: string; Name: string } | null;
};
export type TrailerActionsContext = TrailerDetailsContext & {
  InWatchlist: boolean;
  WatchlistId?: string;
};

export interface MediaApi extends BrowseApi {
  serverId?: string;
  userId?: string;
  homeCollections?: HomeCollectionTransport;
  providerHomes?: ProviderHomesTransport;
  loadingScreen?: LoadingScreenTransport;
  liveTv?: LiveTvTransport;
  /** Optional seasonal-calendar preview; omitted by real servers. Never changes the wall clock. */
  getSeasonalDate?(): Date;
  getHomeLibraryExclusions?(): Promise<string[]>;
  getProviderDirectory?(): Promise<ProviderDirectory>;
  getProviderItems?(provider: ProviderId, query: ProviderItemsQuery): Promise<ProviderItemsPage>;
  previewProviderItems?(provider: ProviderHomeConfig, query: ProviderItemsQuery): Promise<ProviderItemsPage>;
  getProviderTrending?(provider: ProviderId, type: 'Movie' | 'Series', limit?: number): Promise<ProviderItemsPage>;
  previewProviderTrending?(provider: ProviderHomeConfig, type: 'Movie' | 'Series', limit?: number): Promise<ProviderItemsPage>;
  getItem(id: string): Promise<Item>;
  getPlaybackContext?(): Promise<PlaybackContext | null>;
  getTrailerDetails?(expected: TrailerIdentity): Promise<TrailerDetailsContext | null>;
  getTrailerActions?(expected: TrailerIdentity): Promise<TrailerActionsContext | null>;
  addTrailerToWatchlist?(expected: TrailerIdentity): Promise<TrailerActionsContext>;
  getWatchlist?(query?: WatchlistQuery): Promise<ItemPage>;
  getWatchlistState?(id: string): Promise<WatchlistState>;
  setWatchlist?(id: string, saved: boolean): Promise<WatchlistState>;
  getMovies(query: MovieQuery): Promise<ItemPage>;
  getMovieGenres(parentId?: string): Promise<Item[]>;
  getMovieSuggestions(parentId?: string): Promise<SuggestionSection[]>;
  getShows(query: LibraryQuery): Promise<ItemPage>;
  getShowGenres(parentId?: string): Promise<Item[]>;
  getShowSuggestions(parentId?: string): Promise<SuggestionSection[]>;
  getSeasons(seriesId: string): Promise<Item[]>;
  getEpisodes(seriesId: string, seasonId: string): Promise<Item[]>;
  getNextEpisode(seriesId: string): Promise<Item | null>;
  getSimilar(id: string): Promise<Item[]>;
  getCollections(itemId: string): Promise<Item[]>;
  getCollectionList(parentId?: string): Promise<Item[]>;
  getCollectionItems(collectionId: string): Promise<Item[]>;
  canManageCollections?(): Promise<boolean>;
  addToCollection?(collectionId: string, itemId: string): Promise<void>;
  createCollection?(name: string, itemId: string): Promise<Item>;
  getChannels(): Promise<Item[]>;
  getPrograms(channelId: string): Promise<Item[]>;
  setFavorite(id: string, favorite: boolean): Promise<void>;
  setPlayed?(id: string, played: boolean): Promise<ItemUserData>;
  play(item: Item, ticks: number, isCurrent: () => boolean): Promise<void>;
  playPlaylist(playlist: Item, entryId: string | undefined, isCurrent: () => boolean): Promise<void>;
  playTrailer(item: Item, isCurrent: () => boolean): Promise<void>;
  image(item: Item, kind: 'backdrop' | 'thumb' | 'logo' | 'disc' | 'poster'): string | null;
}

declare global {
  interface Window {
    TvItemLayoutDemo?: { api: MediaApi; initialItem: string };
    TvItemLayout?: { refresh(): void; destroy(): void };
  }
}
