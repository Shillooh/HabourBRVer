import type { Item, LibraryQuery, MediaApi, PlaybackContext, TrailerActionsContext, TrailerIdentity } from '../src/types';
import { el, picture, replace } from '../src/dom';
import { providerBrands, type ProviderBrandId } from '../src/provider-brands';
import { defaultProviderHomes, defaultProviderConfig, parseProviderHomes, providerHomesKey, type ProviderHomeConfig } from '../src/provider-settings';
import type { ProviderItemsQuery, ProviderItemsPage } from '../src/provider-data';
import { orderHomeItems } from '../src/home-collection-settings';
import { notifyWatchlistChanged } from '../src/watchlist';
import { demoAdventDate, demoUserForShowcase, readDemoShowcase, seedDemoShowcase, showcaseCollectionId } from './showcases';

// This file belongs to the preview only. It is never included in the installer bundle.
const MINUTE = 60 * 10_000_000;
const scenario = new URLSearchParams(location.search).get('scenario');
const showcase = readDemoShowcase(location.search);
const demoUserId = demoUserForShowcase(showcase);
seedDemoShowcase(localStorage, location.origin, showcase);
if (new URLSearchParams(location.search).get('layout') === 'desktop') document.body.classList.replace('layout-tv', 'layout-desktop');
const library = new Map<string, Item>();
const artwork = new Map<string, string>();
// Resolve from the fixture script so localhost and project-hosted demos share
// the same artwork paths, including the direct /demo/index.html entry point.
const assetBase = new URL('../demo/assets/', (document.currentScript as HTMLScriptElement).src).pathname;
const asset = (name: string) => `${assetBase}${name}.jpg`;
// Real servers distinguish portrait primary artwork from landscape thumbnails.
// Keep that distinction in the fixture, especially inside seasonal door frames.
const moviePosters: Record<string, string> = {
  'movie-tide': 'after-the-tide',
  'movie-silence': 'the-shape-of-silence',
  'movie-higher': 'higher-ground',
  'movie-wild': 'where-the-wild-things-wait',
  'movie-blue': 'a-kind-of-blue',
};
const seasons: Item[] = [];
const episodes = new Map<string, Item[]>();
const channels: Item[] = [];
const schedules = new Map<string, Item[]>();
const favorites = new Set<string>(['movie-blue', 'series-harbour', 'album-nightlines']);
let watchedFailures = 0;

function register(item: Item, photo: string): Item {
  library.set(item.Id, item);
  artwork.set(item.Id, asset(photo));
  return item;
}

const cast = [
  { Name: 'Mara Ellison', Type: 'Actor', Role: 'Elin Ward' },
  { Name: 'Jonas Reed', Type: 'Actor', Role: 'Tom Vale' },
  { Name: 'Sofia Arden', Type: 'Actor', Role: 'June Mercer' },
  { Name: 'Theo Linden', Type: 'Actor', Role: 'Daniel Ward' },
];
const streams = [
  { Type: 'Video', Width: 3840, DisplayTitle: '4K HEVC' },
  { Type: 'Audio', DisplayTitle: 'English · Dolby Digital 5.1', Language: 'eng' },
  { Type: 'Subtitle', DisplayTitle: 'English CC', Language: 'eng' },
];

register({
  Id: 'series-north', Type: 'Series', Name: 'North of Nowhere', ProductionYear: 2024,
  OfficialRating: 'TV-14', CommunityRating: 8.6, Genres: ['Drama', 'Mystery', 'Adventure'],
  Tags: ['Atmospheric', 'Slow burn'], Taglines: ['Some places never let you go.'],
  Overview: 'When a missing hiker returns after twenty years, a quiet mountain town begins to unravel. For ranger Elin Ward, finding the truth means facing the one place she swore she would never go back to.',
  People: [...cast, { Name: 'Ada Voss', Type: 'Director' }], ChildCount: 3, RecursiveItemCount: 18,
  MediaStreams: streams, ImageTags: { Primary: 'demo' }, BackdropImageTags: ['demo'],
}, 'mountains');

const seasonStories = [
  [
    ['The Long Way Home', 'Elin returns to the valley for a routine search. A discovery on the old north trail turns a rescue into something far more personal.', 49],
    ['A Line in the Snow', 'A storm closes the mountain pass. While the town waits for answers, Elin follows a trail that should have disappeared years ago.', 47],
    ['The Other Side', 'An unexpected visitor knows more about the missing hiker than they admit. June uncovers a photograph with a familiar face.', 52],
    ['Still Water', 'A search at the abandoned reservoir brings old loyalties into question. Tom must decide how much of the past to share.', 46],
    ['What We Leave Behind', 'As the first thaw opens a forgotten route, Elin learns why her father never spoke about his final winter on the mountain.', 51],
    ['North of Nowhere', 'With the town divided and another storm approaching, Elin takes the north trail one last time. The truth is closer than she thinks.', 57],
  ],
  [
    ['First Light', 'Six months after the search, a letter from across the border draws Elin back into the valley’s unfinished story.', 48],
    ['The Crossing', 'A journey to the coast reveals an unlikely connection. Back home, June finds that someone has been listening.', 50],
    ['Undertow', 'An old friend offers shelter and a warning. Tom follows a lead that puts him at odds with the rest of the team.', 46],
    ['The Quiet Hours', 'One night at the isolated station changes everything. Elin must trust a stranger to keep her promise.', 51],
    ['A Place to Stay', 'As the valley prepares for winter, a familiar voice brings news from the north. June chooses her own way forward.', 49],
    ['All That Remains', 'Elin and Tom piece together the final hours before the disappearance, but there is one account they have not heard.', 56],
  ],
  [
    ['Open Country', 'A year of calm ends with a call from the highlands. Elin returns to the work she knows, carrying a secret she cannot leave behind.', 50],
    ['Weather Coming', 'New evidence sends the team beyond the marked paths. At the station, June makes a discovery of her own.', 48],
    ['The Distance Between', 'A difficult reunion gives Tom a chance to make amends. Elin begins to question what it means to come home.', 53],
    ['Into the Blue', 'With the search widening, an unexpected ally leads the team toward the coast and a house that has stood empty for years.', 47],
    ['The Last Winter', 'The valley gathers as the first snow arrives. Before the pass closes, Elin has one final promise to keep.', 54],
    ['Here, at Last', 'On the longest night of the year, the people of the valley find their way back to one another.', 61],
  ],
] as const;

seasonStories.forEach((stories, seasonIndex) => {
  const number = seasonIndex + 1;
  const season = register({
    Id: `season-north-${number}`, Type: 'Season', Name: `Season ${number}`, IndexNumber: number,
    SeriesId: 'series-north', SeriesName: 'North of Nowhere', ChildCount: stories.length,
    ProductionYear: 2023 + number,
  }, 'mountains');
  seasons.push(season);
  episodes.set(season.Id, stories.map(([name, overview, minutes], index) => register({
    Id: `episode-north-${number}-${index + 1}`, Type: 'Episode', Name: name, Overview: overview,
    SeriesId: 'series-north', SeriesName: 'North of Nowhere', SeasonId: season.Id,
    IndexNumber: index + 1, ParentIndexNumber: number, RunTimeTicks: minutes * MINUTE,
    OfficialRating: 'TV-14', ProductionYear: 2023 + number, Genres: ['Drama', 'Mystery'],
    People: cast, MediaStreams: streams, ImageTags: { Primary: 'demo' },
    UserData: seasonIndex === 0 && index === 0 ? { Played: true, PlayedPercentage: 100 }
      : seasonIndex === 0 && index === 1 ? { PlaybackPositionTicks: 18.5 * MINUTE, PlayedPercentage: 39.4 } : {},
  }, number === 1 ? ['mountains', 'forest', 'mountains', 'ocean', 'forest', 'mountains'][index]!
    : ['forest', 'ocean', 'mountains', 'forest', 'mountains', 'ocean'][index]!)));
});

const seriesIds = ['series-north'];
const moreShows = [
  { id:'series-harbour', name:'The Last Harbour', year:2025, photo:'ocean', genres:['Drama', 'Mystery'],
    overview:'A harbourmaster returns to her island home to find a ship nobody remembers arriving. Each tide reveals another part of the town’s unfinished story.',
    episodes:['A Ship in the Night', 'Low Tide', 'The Lantern Room'] },
  { id:'series-signal', name:'Signal 24', year:2024, photo:'mountains', genres:['Mystery', 'Sci-Fi'],
    overview:'An isolated radio station begins receiving messages from tomorrow. Its small crew must decide which warnings to trust and which futures to change.',
    episodes:['The First Transmission', 'Dead Air', 'Tomorrow’s Voice'] },
  { id:'series-1999', name:'1999', year:2023, photo:'forest', genres:['Drama', 'History'],
    overview:'Four friends reunite in the town where they grew up, on the eve of a new millennium. A summer they thought forgotten connects the lives they lead today.',
    episodes:['The Reunion', 'Summer on Tape', 'Midnight'] },
  { id:'series-wild', name:'Wild Country', year:2025, photo:'forest', genres:['Documentary', 'Adventure'],
    overview:'Follow the changing seasons across mountains, forests and remote coastlines, through the lives of the animals and people who call them home.',
    episodes:['Mountain Spring', 'Under the Canopy', 'The Living Coast'] },
];
for (const spec of moreShows) {
  seriesIds.push(spec.id);
  register({ Id:spec.id, Type:'Series', Name:spec.name, Overview:spec.overview, ProductionYear:spec.year,
    OfficialRating:'TV-14', Genres:spec.genres, ChildCount:1, RecursiveItemCount:spec.episodes.length,
    ImageTags:{Primary:'demo'}, BackdropImageTags:['demo'] }, spec.photo);
  const season = register({ Id:`season-${spec.id.slice(7)}-1`, Type:'Season', Name:'Season 1',
    SeriesId:spec.id, SeriesName:spec.name, IndexNumber:1, ChildCount:spec.episodes.length }, spec.photo);
  seasons.push(season);
  episodes.set(season.Id, spec.episodes.map((name, index) => register({
    Id:`episode-${spec.id.slice(7)}-1-${index+1}`, Type:'Episode', Name:name, Overview:spec.overview,
    SeriesId:spec.id, SeriesName:spec.name, SeasonId:season.Id, ParentIndexNumber:1, IndexNumber:index+1,
    RunTimeTicks:(44+index*3)*MINUTE, ProductionYear:spec.year, OfficialRating:'TV-14', Genres:spec.genres,
    ImageTags:{Primary:'demo'}, UserData:spec.id==='series-harbour' && index===0
      ? {PlaybackPositionTicks:12*MINUTE, PlayedPercentage:27.3} : {},
  }, spec.photo)));
}

const movieCast = [
  { Name: 'Romy Bell', Type: 'Actor', Role: 'Wren' },
  { Name: 'Elias North', Type: 'Actor', Role: 'Miles' },
  { Name: 'Leah Vale', Type: 'Actor', Role: 'Nora' },
  { Name: 'Noah Arlen', Type: 'Director' },
  { Name: 'Freya Moss', Type: 'Writer' },
];
const movieIds: string[] = [];
function movie(id: string, name: string, overview: string, year: number, minutes: number, photo: string, genres: string[]) {
  movieIds.push(id);
  return register({
    Id: id, Type: 'Movie', Name: name, Overview: overview, ProductionYear: year,
    RunTimeTicks: minutes * MINUTE, OfficialRating: 'PG-13', CommunityRating: id === 'movie-tide' ? 8.1 : 7.7,
    Genres: genres, Taglines: ['Everything finds its way home.'], People: movieCast,
    MediaStreams: streams, ImageTags: { Primary: 'demo' }, BackdropImageTags: ['demo'],
    UserData: id === 'movie-tide' ? { PlaybackPositionTicks: 28.25 * MINUTE, PlayedPercentage: 24.8 } : {},
  }, photo);
}
movie('movie-tide', 'After the Tide', 'Returning to the island she left behind, a young photographer discovers a box of letters that changes everything she remembers about her family. Across one unforgettable summer, she learns that finding your way forward sometimes means going back.', 2025, 114, 'ocean', ['Drama', 'Adventure']);
movie('movie-silence', 'The Shape of Silence', 'An architect inherits a remote woodland cabin and the unfinished recordings of a life she never knew. A quiet story about the things we keep, and the things we finally let go.', 2024, 106, 'forest', ['Drama', 'Mystery']);
movie('movie-higher', 'Higher Ground', 'Two estranged brothers reunite for the mountain expedition their father never completed. On the journey to the summit, the distance between them proves the hardest climb.', 2023, 122, 'mountains', ['Adventure', 'Drama']);
movie('movie-wild', 'Where the Wild Things Wait', 'A naturalist and a restless teenager spend a summer tracking a rare bird through an ancient forest. An unlikely friendship takes root far from the world they know.', 2025, 98, 'forest', ['Adventure', 'Drama']);
movie('movie-blue', 'A Kind of Blue', 'On the last ferry of the season, a musician meets a stranger who is travelling with no destination. As the coastline slips away, their stories begin to change.', 2024, 109, 'ocean', ['Drama', 'Romance']);

const collectionMembers = new Map<string, string[]>([
  ['collection-coast', ['movie-tide', 'movie-blue']],
  ['collection-wilderness', ['series-north', 'movie-higher', 'movie-wild']],
]);
register({ Id:'library-collections', Type:'CollectionFolder', CollectionType:'boxsets', Name:'Collections' }, 'mountains');
register({ Id:'library-movies', Type:'CollectionFolder', CollectionType:'movies', Name:'Movies' }, 'ocean');
register({ Id:'library-tv', Type:'CollectionFolder', CollectionType:'tvshows', Name:'TV Shows' }, 'mountains');
register({ Id:'collection-coast', Type:'BoxSet', Name:'Coastal Stories', Overview:'Journeys shaped by the sea. Discover stories of homecoming, chance encounters and life along the coast.', ChildCount:2 }, 'ocean');
register({ Id:'collection-wilderness', Type:'BoxSet', Name:'Into the Wilderness', Overview:'Step beyond the familiar. Mountain mysteries and open-country adventures from your library.', ChildCount:3 }, 'mountains');
if (showcase) {
  collectionMembers.set(showcaseCollectionId, movieIds.slice());
  register({ Id:showcaseCollectionId, Type:'BoxSet', Name:'Demo film selection',
    Overview:'Five fictional films for exploring ranked rows, seasonal artwork and opening doors.', ChildCount:movieIds.length }, 'forest');
}

const providerCatalogues: Record<ProviderBrandId, { movies: string[]; shows: string[] }> = {
  netflix: { movies: ['movie-tide','movie-silence','movie-higher','movie-blue'], shows: ['series-north','series-harbour','series-signal'] },
  prime: { movies: ['movie-wild','movie-blue','movie-higher'], shows: ['series-wild','series-1999','series-harbour'] },
  max: { movies: ['movie-blue','movie-silence','movie-wild'], shows: ['series-1999','series-harbour'] },
  globoplay: { movies: ['movie-tide','movie-silence'], shows: ['series-north','series-harbour'] },
  disney: { movies: ['movie-tide','movie-wild'], shows: ['series-wild','series-north'] },
  crunchyroll: { movies: ['movie-wild','movie-blue'], shows: ['series-1999','series-harbour'] },
  apple: { movies: ['movie-silence','movie-higher'], shows: ['series-signal','series-harbour'] },
  paramount: { movies: ['movie-higher','movie-tide','movie-wild'], shows: ['series-north','series-signal'] },
  discovery: { movies: ['movie-blue','movie-higher'], shows: ['series-signal','series-wild'] },
  wetv: { movies: ['movie-tide','movie-silence'], shows: ['series-north','series-harbour'] },
  brasilparalelo: { movies: ['movie-wild','movie-blue'], shows: ['series-1999','series-harbour'] },
  viki: { movies: ['movie-wild','movie-blue'], shows: ['series-1999','series-harbour'] }
};
for (const brand of providerBrands) for (const kind of ['movies','shows'] as const) {
  const id = `provider-chart-${brand.id}-${kind}`;
  const members = brand.id === 'netflix' ? kind === 'movies' ? ['movie-blue','movie-tide'] : ['series-signal','series-north']
    : providerCatalogues[brand.id][kind].slice(0,2).reverse();
  collectionMembers.set(id,members);
  register({ Id:id, Type:'BoxSet', Name:`${brand.name} — Em Alta ${kind === 'movies' ? 'Filmes' : 'Séries'} (Brasil)`, ChildCount:members.length }, 'ocean');
}
// The preview account has explicitly selected its fictional chart collections.
// Production settings never infer a collection ID from a display name.
if (!localStorage.getItem(providerHomesKey(location.origin, demoUserId))) {
  const settings = defaultProviderHomes();
  for (const provider of settings.providers) for (const row of provider.rows) {
    if (row.source === 'trending-movies' || row.source === 'trending-shows') row.collectionId = `provider-chart-${provider.id}-${row.source === 'trending-movies' ? 'movies' : 'shows'}`;
  }
  localStorage.setItem(providerHomesKey(location.origin, demoUserId), JSON.stringify(settings));
}

const movieGenres = [...new Set(movieIds.flatMap(id=>library.get(id)!.Genres || []))].sort().map(name=>({Id:`genre-${name.toLowerCase()}`,Name:name,Type:'Genre'}));
const showGenres = [...new Set(seriesIds.flatMap(id=>library.get(id)!.Genres || []))].sort().map(name=>({Id:`genre-${name.toLowerCase()}`,Name:name,Type:'Genre'}));
const movieSortName = (item:Item) => item.Name.replace(/^(the|an|a)\s+/i,'').toLocaleLowerCase();

const artists = [
  register({Id:'artist-moss',Type:'MusicArtist',Name:'Freya Moss',Overview:'Warm piano, field recordings and the quiet spaces between notes.',Genres:['Ambient','Instrumental'],ImageTags:{Primary:'demo'}},'forest'),
  register({Id:'artist-reed',Type:'MusicArtist',Name:'Jonas Reed',Overview:'After-hours jazz from the edge of the city.',Genres:['Jazz'],ImageTags:{Primary:'demo'}},'ocean'),
  register({Id:'artist-vale',Type:'MusicArtist',Name:'Leah Vale',Overview:'Acoustic songs about journeys, memory and finding a place to stay.',Genres:['Folk'],ImageTags:{Primary:'demo'}},'mountains'),
];
const albums: Item[] = [];
const songs: Item[] = [];
const albumArtistIds = new Map<string,string>();
for (const spec of [
  {id:'album-tidelight',name:'Tidelight',artist:artists[0],photo:'ocean',genre:'Ambient',tracks:['First Light','A Quiet Shore','Before the Tide']},
  {id:'album-nightlines',name:'Nightlines',artist:artists[1],photo:'ocean',genre:'Jazz',tracks:['Last Ferry','Blue Windows','After Hours']},
  {id:'album-openfields',name:'Open Fields',artist:artists[0],photo:'forest',genre:'Instrumental',tracks:['Morning Path','Open Country','The Long Way']},
  {id:'album-slowwater',name:'Slow Water',artist:artists[2],photo:'mountains',genre:'Folk',tracks:['Home Again','Northbound','Still Here']},
]) {
  const album=register({Id:spec.id,Type:'MusicAlbum',Name:spec.name,AlbumArtist:spec.artist.Name,Artists:[spec.artist.Name],
    ProductionYear:2025,Genres:[spec.genre],Overview:spec.artist.Overview,ChildCount:spec.tracks.length,RunTimeTicks:12*MINUTE,
    ImageTags:{Primary:'demo'},BackdropImageTags:['demo'],MediaType:'Audio',IsFolder:true},spec.photo);
  albums.push(album);albumArtistIds.set(album.Id,spec.artist.Id);
  spec.tracks.forEach((name,index)=>songs.push(register({Id:`song-${spec.id.slice(6)}-${index+1}`,Type:'Audio',Name:name,
    Album:album.Name,AlbumId:album.Id,AlbumArtist:spec.artist.Name,Artists:[spec.artist.Name],IndexNumber:index+1,ParentIndexNumber:1,
    ProductionYear:2025,Genres:[spec.genre],RunTimeTicks:(3.5+index*.25)*MINUTE,MediaType:'Audio',ImageTags:{Primary:'demo'}},spec.photo)));
}
const playlists = [
  register({Id:'playlist-quiet',Type:'Playlist',Name:'Quiet moments',MediaType:'Audio',IsFolder:true,ChildCount:3,Overview:'Slow mornings and quiet shores.',ImageTags:{Primary:'demo'}},'ocean'),
  register({Id:'playlist-night',Type:'Playlist',Name:'After hours',MediaType:'Audio',IsFolder:true,ChildCount:2,Overview:'Music for the last ferry home.',ImageTags:{Primary:'demo'}},'forest'),
];
const playlistMembers = new Map<string, Item[]>([
  ['playlist-quiet', [songs[0], songs[1], songs[0]].map((item, index) => ({...item, PlaylistItemId:`quiet-entry-${index + 1}`}))],
  ['playlist-night', [songs[3], songs[4]].map((item, index) => ({...item, PlaylistItemId:`night-entry-${index + 1}`}))],
]);
// Preview-only storage belongs to the fictional demo account, never a Jellyfin user.
const watchlistStorageKey = `screenharbour-demo:${demoUserId}:trailer-watchlist`;
const watchlistId = 'playlist-demo-watchlist';
const watchlistItems = new Set<string>();
try {
  const saved: unknown = JSON.parse(localStorage.getItem(watchlistStorageKey) || '[]');
  if (Array.isArray(saved)) for (const id of saved) if (typeof id === 'string' && (movieIds.includes(id) || seriesIds.includes(id))) watchlistItems.add(id);
} catch { /* An unavailable or invalid preview store starts empty. */ }
function syncDemoWatchlist(): void {
  if (!watchlistItems.size && scenario !== 'cinema-trailers' && !library.has(watchlistId)) return;
  let item = library.get(watchlistId);
  if (!item) {
    item = register({ Id:watchlistId, Type:'Playlist', Name:'Watchlist', MediaType:'Video', IsFolder:true,
      Overview:'Films saved from the fictional trailer preview. This watchlist is stored only in this browser.', ImageTags:{Primary:'demo'} }, 'forest');
    playlists.push(item);
  }
  const movies = [...watchlistItems].filter(id => movieIds.includes(id));
  item.ChildCount = movies.length;
  playlistMembers.set(watchlistId, movies.map(id => ({ ...library.get(id)!, PlaylistItemId:`watchlist-${id}` })));
}
syncDemoWatchlist();
register({Id:'library-music',Type:'CollectionFolder',Name:'Music',CollectionType:'music'},'forest');
register({Id:'library-playlists',Type:'UserView',Name:'Playlists',CollectionType:'playlists',IsFolder:true},'forest');
register({Id:'library-live',Type:'CollectionFolder',Name:'Live TV',CollectionType:'livetv'},'ocean');
const musicGenres=[...new Set(albums.flatMap(item=>item.Genres||[]))].sort().map(Name=>({Id:`music-genre-${Name.toLowerCase()}`,Type:'Genre',Name}));
const recordings=[
  register({Id:'recording-forest',Type:'Video',Name:'The Secret Life of Forests',Overview:'A closer look at the hidden life beneath an ancient canopy.',ProductionYear:2025,RunTimeTicks:54*MINUTE,MediaType:'Video',IsInProgress:false,ImageTags:{Primary:'demo'}},'forest'),
  register({Id:'recording-coast',Type:'Recording',Name:'Coast to Coast',Overview:'Follow a changing shoreline from first light to the last ferry home.',ProductionYear:2025,RunTimeTicks:60*MINUTE,MediaType:'Video',IsInProgress:true,ImageTags:{Primary:'demo'}},'ocean'),
  register({Id:'recording-mountain',Type:'Episode',Name:'Above the Clouds',SeriesName:'Wild Horizons',Overview:'Life at the edge of the world, among the highest peaks.',ParentIndexNumber:1,IndexNumber:3,ProductionYear:2025,RunTimeTicks:48*MINUTE,MediaType:'Video',IsInProgress:false,ImageTags:{Primary:'demo'}},'mountains'),
];

// Anchor each schedule to the current half hour, so the fixture always has a live show.
const now = Date.now();
const scheduleStart = Math.floor(now / (30 * 60_000)) * 30 * 60_000 - 15 * 60_000;
const channelSpecs = [
  { id: 'channel-field', name: 'Field Notes', number: '101', photo: 'forest', genre: 'Nature', programs: [
    ['The Secret Life of Forests', 'Journey beneath the canopy of Europe’s oldest woodlands, where every tree is connected and the smallest creatures shape an extraordinary world.'],
    ['Wild Water', 'From mountain streams to open ocean, follow the hidden journeys that connect life on our planet.', 'ocean'],
    ['Above the Clouds', 'A new perspective on the animals and people who make their homes in the world’s highest places.', 'mountains'],
    ['Earth After Dark', 'As daylight fades, a remarkable cast of nocturnal creatures begins its day.'],
  ] },
  { id: 'channel-horizon', name: 'Horizon', number: '102', photo: 'mountains', genre: 'Travel', programs: [
    ['The Long Way North', 'A slow journey through the northern wilderness, meeting the people who call this remarkable landscape home.'],
    ['Coastal Roads', 'Along a remote coastline, old traditions meet a new generation of travellers.', 'ocean'],
    ['The Mountain Kitchen', 'Discover the ingredients and family recipes that connect isolated mountain communities.'],
    ['A World Away', 'Small stories from places far beyond the familiar.'],
  ] },
  { id: 'channel-drift', name: 'Drift', number: '103', photo: 'ocean', genre: 'Documentary', programs: [
    ['Oceans Between Us', 'Scientists and sailors share their encounters with the living world beneath the surface.'],
    ['Islands of Tomorrow', 'Meet the communities imagining a different future for their island homes.'],
    ['Under Open Skies', 'An unhurried exploration of the world’s most extraordinary coastlines.'],
    ['At the Water’s Edge', 'A portrait of the people whose lives follow the rhythm of the tide.'],
  ] },
  { id: 'channel-outside', name: 'Outside', number: '104', photo: 'mountains', genre: 'Adventure', programs: [
    ['Beyond the Trail', 'Three friends leave the mapped trails behind for a week in the high country.'],
    ['First Ascent', 'A new generation of climbers prepares for its biggest challenge.'],
    ['The Open Road', 'Follow a photographer finding unexpected stories at every stop.', 'forest'],
    ['One More Mile', 'The people and places that make a long journey worth taking.'],
  ] },
];
channelSpecs.forEach((spec, channelIndex) => {
  // Varied durations make the common timeline easy to compare across channels.
  const durations = [[60,30,90,60],[90,30,60,60],[60,90,30,60],[75,45,90,30]][channelIndex]!;
  const programs = spec.programs.map(([name, overview, photo], index) => register({
    Id: `${spec.id}-program-${index + 1}`, Type: 'Program', Name: name!, Overview: overview!,
    ChannelId: spec.id, ChannelName: spec.name,
    StartDate: new Date(scheduleStart + durations.slice(0,index).reduce((sum,minutes)=>sum+minutes,0) * 60_000).toISOString(),
    EndDate: new Date(scheduleStart + durations.slice(0,index+1).reduce((sum,minutes)=>sum+minutes,0) * 60_000).toISOString(), RunTimeTicks: durations[index]! * MINUTE,
    OfficialRating: 'TV-G', Genres: [spec.genre], ProductionYear: 2025,
    MediaStreams: [{ Type: 'Video', Width: 1920, DisplayTitle: '1080p' }, { Type: 'Audio', DisplayTitle: 'English · Stereo', Language: 'eng' }],
  }, photo || spec.photo));
  schedules.set(spec.id, programs);
  channels.push(register({
    Id: spec.id, Type: 'TvChannel', Name: spec.name, ChannelNumber: spec.number, Number: spec.number,
    CurrentProgram: programs[0], Genres: [spec.genre],
    Overview: spec.id === 'channel-field' ? 'Extraordinary stories from the natural world. Get closer to the wild, every day.' : `A fresh perspective on ${spec.genre.toLowerCase()}, all day.`,
    ImageTags: { Primary: 'demo' }, BackdropImageTags: ['demo'],
  }, spec.photo));
});

function copy(item: Item): Item {
  return { ...item, UserData: { ...item.UserData, IsFavorite: favorites.has(item.Id) } };
}
async function respond<T>(value: () => T, id?: string): Promise<T> {
  // Alternating durations make rapid switches in the slow scenario finish out of order.
  const delay = scenario === 'slow' ? (id?.includes('-2') ? 1700 : 800) : 90;
  await new Promise((resolve) => setTimeout(resolve, delay));
  if (scenario === 'error') throw new Error('The demo server could not be reached. Remove ?scenario=error to restore the preview.');
  return value();
}
function list(items: Item[]): Item[] { return scenario === 'empty' ? [] : items.map(copy); }

let lastDetailHash = '#/details?id=series-north';
let player: HTMLElement | null = null;
let cinemaCleanup: (() => void) | null = null;
let cinemaPlayback: PlaybackContext | null = null;
const cinemaTrailers = new Map<string, string>();
if (scenario === 'cinema-trailers') for (const id of ['movie-silence', 'movie-higher']) {
  const movie = library.get(id)!;
  const trailerId = `demo-trailer-${id}`;
  library.set(trailerId, { ...movie, Id:trailerId, Type:'Trailer', ExtraType:'Trailer', UserData:{}, RunTimeTicks:MINUTE });
  artwork.set(trailerId, artwork.get(id)!);
  cinemaTrailers.set(trailerId, id);
}
function closePlayer() {
  cinemaCleanup?.(); cinemaCleanup = null; cinemaPlayback = null;
  player?.remove();
  player = null;
  document.body.classList.remove('demo-is-playing');
}
function returnToDetails() { location.hash = lastDetailHash; }
function trailerActions(expected: TrailerIdentity): TrailerActionsContext | null {
  const playback = cinemaPlayback;
  if (!playback || playback.PlayingItemId !== expected.PlayingItemId || playback.PlaylistItemId !== expected.PlaylistItemId) return null;
  const movieId = cinemaTrailers.get(playback.PlayingItemId);
  const movie = movieId ? library.get(movieId) : null;
  if (!movie) return null;
  return { PlayingItemId:playback.PlayingItemId, PlaylistItemId:playback.PlaylistItemId,
    Movie:{Id:movie.Id, Name:movie.Name}, InWatchlist:watchlistItems.has(movie.Id), WatchlistId:watchlistId };
}

function showCinemaPlayer(): void {
  closePlayer();
  lastDetailHash = '#/details?id=movie-tide';
  const queue = [...cinemaTrailers.keys(), 'movie-tide'].map((Id, index) => ({ Id, PlaylistItemId:`demo-cinema-entry-${index}` }));
  let index = 0, elapsed = 0, stopped = false;
  const root = el('main', 'demo-cinema-player videoPlayerContainer');
  root.setAttribute('aria-label', 'Cinema trailer preview');
  const video = el('video', 'htmlvideoplayer'); video.muted = true; video.playsInline = true;
  const canvas = el('canvas'); canvas.width = 1280; canvas.height = 720;
  const context = canvas.getContext('2d')!;
  const art = new Image(); let artReady = false;
  art.onload = () => { artReady = true; draw(); };
  const draw = () => {
    context.fillStyle = '#101512'; context.fillRect(0, 0, canvas.width, canvas.height);
    if (!artReady) return;
    const scale = Math.max(canvas.width / art.naturalWidth, canvas.height / art.naturalHeight);
    const width = art.naturalWidth * scale, height = art.naturalHeight * scale;
    context.drawImage(art, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
  };
  draw();
  const stream = canvas.captureStream(10); video.srcObject = stream;
  const osd = el('div', 'demo-cinema-osd'); osd.id = 'videoOsdPage'; osd.dataset.type = 'video-osd';
  const header = el('div', 'demo-cinema-header');
  const back = el('button', 'demo-cinema-control btnBack', '← Back'); back.type = 'button'; back.addEventListener('click', returnToDetails);
  const watchlist = el('a', 'demo-cinema-control', 'View watchlist'); watchlist.href = `#/details?id=${watchlistId}`;
  header.append(back, watchlist);
  const copy = el('div', 'demo-cinema-copy');
  const eyebrow = el('p', 'demo-cinema-eyebrow'), title = el('h1'), metadata = el('p', 'demo-cinema-meta');
  const description = el('p', 'demo-cinema-description');
  copy.append(eyebrow, title, metadata, description);
  const bottom = el('div', 'videoOsdBottom');
  const controls = el('div', 'osdControls'), buttons = el('div', 'buttons');
  const play = el('button', 'demo-cinema-control btnPause', 'Pause'); play.type = 'button';
  const next = el('button', 'demo-cinema-control btnNextTrack', 'Next'); next.type = 'button'; next.setAttribute('aria-label', 'Next preview');
  const rating = el('button', 'btnUserRating'); rating.type = 'button'; rating.hidden = true;
  const progress = el('progress', 'demo-cinema-progress'); progress.max = 60; progress.value = 0; progress.setAttribute('aria-label', 'Preview progress');
  const timing = el('span', 'demo-cinema-timing');
  const note = el('span', 'demo-cinema-note', 'Fictional titles · Artwork simulation');
  buttons.append(play, next, timing, note, rating); controls.append(progress, buttons); bottom.append(controls);
  osd.append(header, copy, bottom); root.append(video, osd); document.body.append(root);
  player = root; document.body.classList.add('demo-is-playing');

  function renderEntry(): void {
    elapsed = 0; progress.value = 0; artReady = false;
    const entry = queue[index], item = library.get(entry.Id)!;
    const trailer = cinemaTrailers.has(entry.Id);
    cinemaPlayback = { PlayingItemId:item.Id, PlayingItemType:item.Type, PlayingItemExtraType:item.ExtraType,
      PlaylistItemId:entry.PlaylistItemId, Queue:queue.map(value => ({...value})) };
    root.dataset.cinemaIndex = String(index); rating.dataset.id = item.Id;
    eyebrow.textContent = trailer ? `Trailer preview ${index + 1} of 2` : 'Feature preview';
    title.textContent = item.Name; metadata.textContent = `${item.ProductionYear} · ${item.OfficialRating} · ${item.Genres?.join(' / ')}`;
    description.textContent = item.Overview || '';
    next.disabled = !trailer; progress.hidden = !trailer;
    timing.textContent = trailer ? '0:00 / 1:00' : 'Your film begins here';
    art.src = artwork.get(item.Id)!; draw();
    osd.dispatchEvent(new CustomEvent('viewshow', { bubbles:true }));
  }
  function advance(): void {
    if (index >= queue.length - 1) return;
    index++; renderEntry();
    if (video.paused) void video.play().catch(() => { play.textContent = 'Play'; });
  }
  next.addEventListener('click', advance);
  play.addEventListener('click', () => { if (video.paused) void video.play().catch(() => { play.textContent = 'Play'; }); else video.pause(); });
  video.addEventListener('pause', () => { play.textContent = 'Play'; root.classList.add('demo-cinema-paused'); });
  video.addEventListener('playing', () => { play.textContent = 'Pause'; root.classList.remove('demo-cinema-paused'); });
  // Model native spatial navigation only for this fixture's controls. The real
  // TrailerActions component retains ownership once focus reaches its buttons.
  root.addEventListener('keydown', event => {
    if (event.defaultPrevented || !['ArrowLeft', 'ArrowRight', 'ArrowUp'].includes(event.key)
      || !(event.target instanceof HTMLElement) || event.target.closest('#tvl-trailer-actions, #tvl-player-browser')) return;
    const items = Array.from(osd.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]')).filter(item => !item.hidden && !!item.getClientRects().length);
    const current = items.indexOf(document.activeElement as HTMLElement);
    const destination = event.key === 'ArrowUp' ? osd.querySelector<HTMLElement>('#tvl-trailer-actions button:not(:disabled)')
      : items[(current + (event.key === 'ArrowLeft' ? items.length - 1 : 1)) % items.length];
    if (destination) { event.preventDefault(); destination.focus(); }
  });
  let lastTick = performance.now();
  const timer = window.setInterval(() => {
    if (stopped) return;
    draw(); const tick = performance.now();
    if (!video.paused && index < queue.length - 1) {
      const previousSecond = Math.floor(elapsed);
      elapsed += (tick - lastTick) / 1000;
      if (elapsed >= 60) advance();
      else if (Math.floor(elapsed) !== previousSecond) {
        progress.value = elapsed; timing.textContent = `0:${String(Math.floor(elapsed)).padStart(2, '0')} / 1:00`;
      }
    }
    lastTick = tick;
  }, 100);
  cinemaCleanup = () => {
    stopped = true; window.clearInterval(timer); art.onload = null;
    osd.dispatchEvent(new CustomEvent('viewbeforehide', { bubbles:true }));
    video.pause(); stream.getTracks().forEach(track => track.stop()); video.srcObject = null;
  };
  renderEntry();
  void video.play().catch(() => { play.textContent = 'Play'; });
  requestAnimationFrame(() => { if (root.isConnected) play.focus({preventScroll:true}); });
}
function showPlayer(item: Item, ticks: number) {
  closePlayer();
  if (/^#\/(details|livetv)(\?|$)/.test(location.hash)) lastDetailHash = location.hash;
  player = document.createElement('main');
  player.className = 'demo-player';
  player.setAttribute('aria-label', 'Demo playback');
  const art = document.createElement('div');
  art.className = 'demo-player-art';
  art.style.backgroundImage = `url("${artwork.get(item.Id) || artwork.get(item.ChannelId || '') || asset('mountains')}")`;
  const content = document.createElement('div');
  content.className = 'demo-player-content';
  content.setAttribute('role','dialog');
  content.setAttribute('aria-modal','true');
  content.setAttribute('aria-label','Playback controls');
  content.innerHTML = '<div class="demo-player-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 3v18l15-9z"/></svg></div><p class="demo-player-eyebrow">Demo playback</p><h1></h1><p class="demo-player-info"></p><button type="button">Back to details</button><span class="demo-player-key">Press Escape to return</span>';
  content.querySelector('h1')!.textContent = item.Type === 'Episode' ? `${item.SeriesName} · ${item.Name}` : item.Name;
  const resumeTime = `${Math.floor(ticks / MINUTE)}:${String(Math.floor(ticks / 10_000_000) % 60).padStart(2, '0')}`;
  const playbackNote = item.Type === 'Trailer' ? ' Trailer playback would start from the beginning.'
    : item.Type === 'TvChannel' || item.Type === 'Program' ? ' The live channel would begin playing.'
    : ticks > 0 ? ` Playback would resume at ${resumeTime}.` : ' Playback would start from the beginning.';
  content.querySelector('.demo-player-info')!.textContent = `This is a simulated player. No actual stream is playing.${playbackNote}`;
  const back = content.querySelector('button')!;
  if(lastDetailHash.startsWith('#/livetv'))back.textContent='Back to guide';
  back.addEventListener('click', returnToDetails);
  player.append(art, content);
  document.body.append(player);
  document.body.classList.add('demo-is-playing');
  location.hash = '#/video';
  requestAnimationFrame(() => back.focus());
}

function browseLibrary(ids: string[], genres: Item[], parentId: string, query: LibraryQuery) {
  if (query.parentId && query.parentId !== parentId) return {items:[],total:0,nextStartIndex:query.startIndex||0};
  const genre=genres.find(item=>item.Id===query.genreId)?.Name;
  const items=list(ids.map(id=>library.get(id)!)).filter(item=>
    (!query.search || item.Name.toLocaleLowerCase().includes(query.search.trim().toLocaleLowerCase()))
    && (!query.favorite || favorites.has(item.Id))
    && (!query.genreId || !!genre&&item.Genres?.includes(genre))
    && (!query.letter || (query.letter==='#'?movieSortName(item).charAt(0)<'a':movieSortName(item).startsWith(query.letter.toLocaleLowerCase())))
  ).sort((a,b)=>movieSortName(a).localeCompare(movieSortName(b)));
  const start=query.startIndex||0;const page=items.slice(start,start+(query.limit||60));
  return {items:page,total:items.length,nextStartIndex:start+page.length};
}

function providerPage(config: ProviderHomeConfig | undefined, query: ProviderItemsQuery): ProviderItemsPage {
  const types = query.type === 'Mixed' ? ['Movie', 'Series'] : [query.type];
  const ids = new Set<string>();
  let configured = false;
  for (const type of types) {
    const sourceIds = config ? type === 'Movie' ? config.movieProviderIds : config.showProviderIds : [];
    configured ||= !!sourceIds.length;
    const matched = providerBrands.filter(brand => {
      const preset = defaultProviderConfig(brand.id);
      return preset.offerTypes.some(offer => config?.offerTypes.includes(offer))
        && (type === 'Movie' ? preset.movieProviderIds : preset.showProviderIds).some(id => sourceIds.includes(id));
    });
    for (const id of matched.flatMap(brand => providerCatalogues[brand.id][type === 'Movie' ? 'movies' : 'shows'])) {
      if (!query.watchlist || watchlistItems.has(id)) ids.add(id);
    }
  }
  const items = orderHomeItems(list([...ids].map(id => library.get(id)!)), { itemSort: query.sort || 'title', itemOrder: [] });
  const start = query.startIndex || 0;
  return { Items: items.slice(start, start + (query.limit || 60)), TotalRecordCount: items.length, Pending: 0, Total: items.length,
    Status: configured ? 'ready' : 'unavailable', Region: 'BR', UpdatedAt: new Date().toISOString(), MissingIds: 0, FailedIds: 0 };
}
function providerTrendingPage(config: ProviderHomeConfig | undefined, type: 'Movie' | 'Series', limit = 20): ProviderItemsPage {
  const page = providerPage(config, { type, limit, sort: 'title' });
  const items = page.Items.slice(0, Math.min(limit, page.Items.length));
  return { ...page, Items: items, TotalRecordCount: items.length, Total: items.length };
}
const api: MediaApi = {
  ...(showcase ? { userId: demoUserId } : {}),
  ...(showcase === 'advent' ? { getSeasonalDate: () => demoAdventDate(location.search) } : {}),
  getPlaybackContext: () => respond(() => cinemaPlayback ? { ...cinemaPlayback, Queue:cinemaPlayback.Queue.map(entry => ({...entry})) } : null),
  getTrailerDetails: expected => respond(() => {
    const model = trailerActions(expected);
    return model ? { PlayingItemId: model.PlayingItemId, PlaylistItemId: model.PlaylistItemId, Movie: model.Movie } : null;
  }),
  getTrailerActions: expected => respond(() => trailerActions(expected)),
  addTrailerToWatchlist: expected => respond(() => {
    const model = trailerActions(expected);
    if (!model?.Movie) throw new Error('The trailer changed. Try again.');
    const ids = new Set(watchlistItems); ids.add(model.Movie.Id);
    // Persist before changing the UI: unavailable browser storage is a real failure.
    localStorage.setItem(watchlistStorageKey, JSON.stringify([...ids]));
    watchlistItems.add(model.Movie.Id); syncDemoWatchlist();
    notifyWatchlistChanged(api, { ItemId: model.Movie.Id, InWatchlist: true });
    return { ...model, InWatchlist:true };
  }),
  getWatchlist: (query = {}) => respond(() => {
    const type = query.type || 'All';
    const ids = [...watchlistItems].filter(id => (type === 'All' || library.get(id)?.Type === type)
      && (!query.parentId || query.parentId === 'library-movies' && movieIds.includes(id)
        || query.parentId === 'library-tv' && seriesIds.includes(id)));
    const filtered = browseLibrary(ids, [...movieGenres, ...showGenres], '', { ...query, parentId: undefined, startIndex: 0, limit: 10000 });
    const filteredIds = new Set(filtered.items.map(item => item.Id));
    const ordered = query.sort === 'collection' ? list(ids.filter(id => filteredIds.has(id)).map(id => library.get(id)!))
      : orderHomeItems(filtered.items, { itemSort: query.sort || 'title', itemOrder: [] });
    const start = query.startIndex || 0, page = ordered.slice(start, start + (query.limit || 60));
    return { items: page, total: ordered.length, nextStartIndex: start + page.length };
  }),
  getWatchlistState: id => respond(() => {
    if (!movieIds.includes(id) && !seriesIds.includes(id)) throw new Error('This title is not available.');
    return { ItemId: id, InWatchlist: watchlistItems.has(id) };
  }),
  setWatchlist: (id, saved) => respond(() => {
    if (!movieIds.includes(id) && !seriesIds.includes(id)) throw new Error('This title is not available.');
    const ids = new Set(watchlistItems);
    if (saved) ids.add(id); else ids.delete(id);
    localStorage.setItem(watchlistStorageKey, JSON.stringify([...ids]));
    if (saved) watchlistItems.add(id); else watchlistItems.delete(id);
    syncDemoWatchlist();
    const state = { ItemId: id, InWatchlist: saved };
    notifyWatchlistChanged(api, state);
    return state;
  }),
  getProviderDirectory: () => respond(() => {
    const common = [
      { Id:8, Name:'Netflix' }, { Id:175, Name:'Netflix Kids' }, { Id:1796, Name:'Netflix Standard with Ads' },
      { Id:119, Name:'Prime Video' }, { Id:9, Name:'Amazon Prime Video' }, { Id:1899, Name:'Max' },
      { Id:307, Name:'Globoplay' }, { Id:337, Name:'Disney+' }, { Id:283, Name:'Crunchyroll' },
      { Id:350, Name:'Apple TV+' }, { Id:531, Name:'Paramount+' }, { Id:524, Name:'Discovery+' },
      { Id:623, Name:'WeTV' }, { Id:6265, Name:'Brasil Paralelo' }, { Id:344, Name:'Rakuten Viki' }
    ];
    return { Region:'BR' as const, Movies:[...common], Shows:[...common] };
  }),
  getProviderItems: (provider, query) => respond(() => {
    let settings = defaultProviderHomes();
    try { const raw = localStorage.getItem(providerHomesKey(location.origin, demoUserId)); if (raw) settings = parseProviderHomes(JSON.parse(raw)); } catch { /* Use preview defaults. */ }
    return providerPage(settings.providers.find(config => config.id === provider && config.enabled), query);
  }),
  previewProviderItems: (provider, query) => respond(() => providerPage(provider, query)),
  getProviderTrending: (provider, type, limit = 20) => respond(() => {
    let settings = defaultProviderHomes();
    try { const raw = localStorage.getItem(providerHomesKey(location.origin, demoUserId)); if (raw) settings = parseProviderHomes(JSON.parse(raw)); } catch { /* Use preview defaults. */ }
    return providerTrendingPage(settings.providers.find(config => config.id === provider && config.enabled), type, limit);
  }),
  previewProviderTrending: (provider, type, limit = 20) => respond(() => providerTrendingPage(provider, type, limit)),
  getMusic: query => respond(() => {
    const genre=musicGenres.find(item=>item.Id===query.genreId)?.Name;
    let found=list(query.kind==='artists'||query.kind==='albumArtists'?artists:query.kind==='songs'?songs:query.kind==='playlists'?playlists:albums);
    if(query.kind!=='playlists'&&query.parentId&&query.parentId!=='library-music')found=[];
    found=found.filter(item=>(!query.albumId||item.AlbumId===query.albumId)
      &&(!query.artistId||albumArtistIds.get(item.AlbumId||item.Id)===query.artistId)
      &&(!query.search||item.Name.toLocaleLowerCase().includes(query.search.trim().toLocaleLowerCase()))
      &&(!query.genreId||!!genre&&item.Genres?.includes(genre))&&(!query.favorite||favorites.has(item.Id))
      &&(!query.letter||(query.letter==='#'?movieSortName(item).charAt(0)<'a':movieSortName(item).startsWith(query.letter.toLowerCase()))));
    found.sort((a,b)=>query.albumId?(a.IndexNumber||0)-(b.IndexNumber||0):movieSortName(a).localeCompare(movieSortName(b)));
    const start=query.startIndex||0;const items=found.slice(start,start+(query.limit||48));return{items,total:found.length,nextStartIndex:start+items.length};
  },query.search),
  getPlaylistItems: (id, query={}) => respond(() => {
    const found = list(playlistMembers.get(id) || []); const start = query.startIndex || 0;
    const items = found.slice(start, start + (query.limit || 48)); return {items, total:found.length, nextStartIndex:start + items.length};
  }, id),
  getMusicGenres: () => respond(()=>list(musicGenres)),
  getMusicSuggestions: () => respond(()=>scenario==='empty'?[]:[{title:'Recently added',items:list(albums)},
    {title:'Recently played',items:list(songs.slice(0,3))},{title:'Frequently played',items:list(songs.slice(3,6))}]),
  getRecordings: (query={}) => respond(()=>{
    const found=list(recordings).filter(item=>(query.status!=='active'||item.IsInProgress)&&(query.status!=='completed'||!item.IsInProgress)
      &&(!query.search||`${item.Name} ${item.SeriesName||''}`.toLowerCase().includes(query.search.trim().toLowerCase())));
    const start=query.startIndex||0;const items=found.slice(start,start+(query.limit||48));return{items,total:found.length,nextStartIndex:start+items.length};
  },query.search),
  getItem: (id) => respond(() => {
    const item = library.get(id);
    if (!item) throw new Error('This item is not available in the local preview.');
    const result = copy(item);
    if (scenario === 'empty' && result.Type === 'TvChannel') delete result.CurrentProgram;
    return result;
  }, id),
  getSeasons: (seriesId) => respond(() => list(seasons.filter(season=>season.SeriesId===seriesId)), seriesId),
  getEpisodes: (_seriesId, seasonId) => respond(() => list(episodes.get(seasonId) || []), seasonId),
  getNextEpisode: (seriesId) => respond(() => {
    if (scenario==='empty') return null;
    const item = seriesId==='series-north' ? library.get('episode-north-1-2')
      : episodes.get(seasons.find(season=>season.SeriesId===seriesId)?.Id||'')?.[0];
    return item ? copy(item) : null;
  }, seriesId),
  getSimilar: (id) => respond(() => list(movieIds.filter((movieId) => movieId !== id).map((movieId) => library.get(movieId)!)), id),
  getCollections: (id) => respond(() => list([...collectionMembers].filter(([,members]) => members.includes(id)).map(([collectionId]) => library.get(collectionId)!)), id),
  getCollectionList: (parentId) => respond(() => list([...collectionMembers].filter(([,members])=>parentId!=='library-tv'||members.some(id=>seriesIds.includes(id))).map(([id])=>library.get(id)!))),
  getCollectionItems: (id) => respond(() => list((collectionMembers.get(id) || []).map(member=>library.get(member)!)),id),
  canManageCollections: () => respond(() => true),
  addToCollection: (collectionId, itemId) => respond(() => {
    const members = collectionMembers.get(collectionId);
    if (!members || !library.has(itemId)) throw new Error('This collection or title is no longer available.');
    if (!members.includes(itemId)) members.push(itemId);
  }),
  createCollection: (name, itemId) => respond(() => {
    const trimmed = name.trim();
    if (!trimmed || !library.has(itemId)) throw new Error('Enter a collection name first.');
    const id = `collection-demo-${collectionMembers.size + 1}`;
    const item: Item = { Id:id, Name:trimmed, Type:'BoxSet', ChildCount:1 };
    library.set(id,item); collectionMembers.set(id,[itemId]);
    return copy(item);
  }),
  getMovies: (query) => respond(() => browseLibrary(movieIds, movieGenres, 'library-movies', query), query.search),
  getShows: (query) => respond(() => browseLibrary(seriesIds, showGenres, 'library-tv', query), query.search),
  getShowGenres: (parentId) => respond(() => list(!parentId || parentId==='library-tv' ? showGenres : [])),
  getShowSuggestions: (parentId) => respond(() => scenario==='empty' || parentId && parentId!=='library-tv' ? [] : [
    {title:'Continue watching',items:['episode-north-1-2','episode-harbour-1-1'].map(id=>copy(library.get(id)!))},
    {title:'Next up',items:['episode-signal-1-1','episode-wild-1-1'].map(id=>copy(library.get(id)!))},
    {title:'Recently added',items:['series-1999','series-wild','episode-north-3-6'].map(id=>copy(library.get(id)!))},
  ]),
  getMovieGenres: () => respond(()=>list(movieGenres)),
  getMovieSuggestions: () => respond(()=>scenario==='empty'?[]:[
    {title:'Continue watching',items:[copy(library.get('movie-tide')!)]},
    {title:'Recently added',items:movieIds.slice().reverse().map(id=>copy(library.get(id)!))},
    {title:'Because you like A Kind of Blue',items:['movie-tide','movie-silence'].map(id=>copy(library.get(id)!))}
  ]),
  getChannels: () => respond(() => list(channels)),
  getPrograms: (channelId) => respond(() => list(schedules.get(channelId) || []), channelId),
  setFavorite: (id, favorite) => respond(() => { if (favorite) favorites.add(id); else favorites.delete(id); }, id),
  setPlayed: (id, played) => respond(() => {
    const failure = new URLSearchParams(location.search).get('watchedError');
    if (failure === '1' || failure === 'once' && watchedFailures++ === 0) throw new Error('Watched status could not be saved.');
    const item = library.get(id); if (!item) throw new Error('This item is not available.');
    const update = (subject: Item) => { subject.UserData = { ...subject.UserData, Played:played, PlaybackPositionTicks:0,
      PlayedPercentage:played ? 100 : 0, PlayCount:played ? Math.max(1, subject.UserData?.PlayCount || 0) : 0 }; };
    update(item);
    if (item.Type === 'Series' || item.Type === 'Season') {
      for (const child of library.values()) if (item.Type === 'Series' ? child.SeriesId === id : child.SeasonId === id) update(child);
    }
    for (const season of seasons) {
      const children = episodes.get(season.Id) || [];
      season.UserData = { ...season.UserData, Played:children.length > 0 && children.every(child => child.UserData?.Played) };
    }
    for (const seriesId of seriesIds) {
      const series = library.get(seriesId)!; const children = seasons.filter(season => season.SeriesId === seriesId);
      series.UserData = { ...series.UserData, Played:children.length > 0 && children.every(child => child.UserData?.Played) };
    }
    return { ...copy(item).UserData!, ItemId:id };
  }, id),
  play: async (item, ticks, isCurrent) => { await respond(() => undefined, item.Id); if (isCurrent()) showPlayer(item, ticks); },
  playPlaylist: async (playlist, entryId, isCurrent) => {
    const items = await respond(() => list(playlistMembers.get(playlist.Id) || []), playlist.Id);
    if (!isCurrent()) return;
    const item = entryId ? items.find(item => item.PlaylistItemId === entryId) : items[0];
    if (!item) throw new Error('This playlist has no playable tracks.');
    document.body.dataset.playlistEntry = item.PlaylistItemId || '';
    showPlayer(item, 0);
  },
  playTrailer: async (item, isCurrent) => {
    await respond(() => undefined, item.Id);
    if (!isCurrent()) return;
    if (item.Type !== 'Movie' || scenario === 'empty') throw new Error('No trailer is available for this film.');
    showPlayer({ ...item, Type:'Trailer', Name:`${item.Name} · Official trailer`, UserData:{} },0);
  },
  image: (item, kind) => kind === 'logo' ? null
    : kind === 'poster' && moviePosters[item.Id] ? `${assetBase}posters/${moviePosters[item.Id]}.svg`
    : artwork.get(item.Id) || artwork.get(item.SeriesId || '') || artwork.get(item.ChannelId || '') || null,
};

const nativePage = document.querySelector<HTMLElement>('.demo-native-page')!;
const originalNativeContent = nativePage.innerHTML;
// A small native-shaped Home fixture: production keeps Jellyfin's real Home DOM,
// settings, item listeners and extensions. This preview does not emulate its API.
type HomePreviewPreferences = { sections: string[]; hiddenLibraries: string[]; hiddenLatest: string[]; libraryOrder: string[]; featured: boolean };
const homeQuery = new URLSearchParams(location.search);
const homePreferences: HomePreviewPreferences = {
  sections: (homeQuery.get('homeSections') || 'smalllibrarytiles,resume,resumeaudio,livetv,nextup,latestmedia').split(','),
  hiddenLibraries: (homeQuery.get('hiddenLibraries') || '').split(',').filter(Boolean),
  hiddenLatest: (homeQuery.get('hiddenLatest') || '').split(',').filter(Boolean),
  libraryOrder: (homeQuery.get('libraryOrder') || 'library-movies,library-tv,library-music,library-collections,library-live').split(','),
  featured: homeQuery.get('featured') !== '0'
};
const nativeHeader=el('header','skinHeader demo-home-header hide');
nativeHeader.setAttribute('aria-label','Library navigation');
const nativeBack=el('button','headerBackButton','Back');nativeBack.type='button';nativeBack.addEventListener('click',()=>history.back());
const nativeTabs=el('nav','headerTabs');nativeTabs.setAttribute('aria-label','Home tabs');nativeTabs.setAttribute('is','emby-tabs');
for(const [name,index] of [['Home','0'],['Favourites','1']]){
  const tab=el('button','emby-tab-button',name);tab.type='button';tab.dataset.index=index;
  tab.addEventListener('click',()=>selectNativeHomeTab(Number(index),true));nativeTabs.append(tab);
}
const nativeGlobals=el('nav','demo-home-globals');nativeGlobals.setAttribute('aria-label','Library navigation');
for(const [name,hash] of [['Search','#/search'],['Now playing','#/queue'],['Settings','#/mypreferencesmenu']]){
  const link=el('a','emby-button',name);link.href=hash;nativeGlobals.append(link);
}
nativeHeader.append(nativeBack,nativeTabs,nativeGlobals);
const nativeHome=el('main','page homePage libraryPage demo-native-home-page hide');nativeHome.id='indexPage';
nativeHome.dataset.role='page';nativeHome.dataset.domCache='true';
const homeTab=el('section','tabContent pageTabContent is-active');homeTab.id='homeTab';homeTab.dataset.index='0';homeTab.setAttribute('aria-label','Home');
const homeSections=el('div','sections homeSectionsContainer');homeTab.append(homeSections);
const favoritesTab=el('section','tabContent pageTabContent hide');favoritesTab.id='favoritesTab';favoritesTab.dataset.index='1';favoritesTab.setAttribute('aria-label','Favourites');
favoritesTab.append(el('h1','','Favourites'),el('p','','Your saved films, shows and albums.'));
nativeHome.append(homeTab,favoritesTab);document.body.insertBefore(nativeHeader,nativePage);document.body.insertBefore(nativeHome,nativePage);
const nativeSettings = el('main', 'page libraryPage userPreferencesPage demo-settings-page hide'); nativeSettings.id = 'myPreferencesMenuPage';
const settingsHeader = el('header', 'demo-settings-header');
const settingsHeading = el('div');
settingsHeading.append(el('p', 'demo-settings-eyebrow', 'MAKE IT YOURS'), el('h1', '', 'Settings'),
  el('p', 'demo-settings-description', 'Try your own Home rows, streaming services and loading screen. Preview changes stay in this browser.'));
const settingsHome = el('a', 'demo-settings-home', 'Back to Home'); settingsHome.href = '#/home';
settingsHeader.append(settingsHeading, settingsHome);
const settingsContent = el('div', 'readOnlyContent');
const settingsPreview = el('section', 'demo-settings-preview'); settingsPreview.setAttribute('aria-label', 'Preview options');
settingsPreview.append(el('h2', '', 'Explore the preview'));
const settingsLayouts = el('div', 'demo-settings-options'); settingsLayouts.setAttribute('aria-label', 'Preview layout');
for (const [layout, name] of [['desktop', 'Desktop preview'], ['tv', 'TV preview']]) {
  const url = new URL(location.href); url.searchParams.set('layout', layout); url.hash = '/mypreferencesmenu';
  const link = el('a', 'demo-settings-option', name); link.href = url.href;
  if ((new URLSearchParams(location.search).get('layout') === 'desktop' ? 'desktop' : 'tv') === layout) link.setAttribute('aria-current', 'true');
  settingsLayouts.append(link);
}
settingsPreview.append(el('p', '', 'Collection rows are configured in the desktop layout. Switch to TV to try the same saved choices.'), settingsLayouts);
const settingsShowcases = el('div', 'demo-settings-options'); settingsShowcases.setAttribute('aria-label', 'Home examples');
for (const [showcase, name] of [['latest', 'Latest features Home'], ['halloween', 'Halloween Home'], ['christmas', 'Christmas Home'], ['advent', 'Dated Christmas Advent']]) {
  const url = new URL(location.href); url.searchParams.set('showcase', showcase); url.searchParams.set('featured', '0'); url.hash = '/home';
  const link = el('a', 'demo-settings-option', name); link.href = url.href; settingsShowcases.append(link);
}
settingsPreview.append(el('h3', '', 'Home examples'), el('p', '', 'Explore themed backgrounds, frames and opening doors with sample Home rows.'), settingsShowcases);
nativeSettings.append(settingsHeader, settingsContent, settingsPreview); document.body.insertBefore(nativeSettings, nativePage);
const adventCalendar = showcase === 'advent' ? el('aside', 'demo-advent-calendar hide') : null;
if (adventCalendar) {
  adventCalendar.setAttribute('aria-label', 'Advent demo calendar');
  const label = el('label', '', 'Preview date');
  const day = el('select'); day.setAttribute('aria-label', 'Advent preview date');
  for (let value = 1; value <= 24; value++) {
    const option = el('option', '', `${value} December`); option.value = String(value); day.append(option);
  }
  day.value = String(demoAdventDate(location.search).getDate());
  day.addEventListener('change', () => {
    const url = new URL(location.href); url.searchParams.set('adventDay', day.value); location.href = url.href;
  });
  label.append(day); adventCalendar.append(label, el('span', '', 'Five sample films · one door unlocks each day'));
  document.body.append(adventCalendar);
}
function selectNativeHomeTab(index:number,notify=false):void{
  const previousIndex=homeTab.classList.contains('is-active')?0:1;
  homeTab.classList.toggle('hide',index!==0);homeTab.classList.toggle('is-active',index===0);
  favoritesTab.classList.toggle('hide',index!==1);favoritesTab.classList.toggle('is-active',index===1);
  (nativeTabs as HTMLElement&{selectedTabIndex:number}).selectedTabIndex=index;
  nativeTabs.querySelectorAll<HTMLElement>('[data-index]').forEach(tab=>tab.classList.toggle('emby-tab-button-active',Number(tab.dataset.index)===index));
  if(notify)nativeTabs.dispatchEvent(new CustomEvent('tabchange',{detail:{selectedTabIndex:index,previousIndex}}));
}
let homeFocused: HTMLElement|null=null;
homeTab.addEventListener('focusin',event=>{homeFocused=event.target as HTMLElement;});

function nativeLibraryRoute(item:Item):string{
  if(item.CollectionType==='livetv')return '#/livetv?collectionType=livetv';
  if(item.CollectionType==='boxsets'||item.CollectionType==='playlists')return `#/list?parentId=${item.Id}`;
  const path=item.CollectionType==='tvshows'?'tv':item.CollectionType;
  return `#/${path}?topParentId=${item.Id}&collectionType=${item.CollectionType}`;
}
function homeCard(item:Item,shape='backdropCard',isLibrary=false):HTMLElement{
  const card=el('button',`card ${shape} card-hoverable card-withuserdata`);card.type='button';
  card.dataset.id=item.Id;card.dataset.type=item.Type||'';card.dataset.action='link';card.dataset.context='home';
  if(item.CollectionType)card.dataset.collectiontype=item.CollectionType;
  card.setAttribute('aria-label',item.Name);
  const box=el('div','cardBox');const scalable=el('div','cardScalable');
  const image=el('div','cardImageContainer coveredImage');image.style.backgroundImage=`url("${artwork.get(item.Id)||artwork.get(item.SeriesId||'')||''}")`;
  scalable.append(el('div',`cardPadder cardPadder-${shape.startsWith('portrait')?'portrait':shape.startsWith('square')?'square':'backdrop'}`),image);
  const text=el('div','cardText cardText-first',item.Type==='Episode'?item.SeriesName||item.Name:item.Name);
  box.append(scalable,text);
  if(item.Type==='Episode')box.append(el('div','cardText cardText-secondary',`S${item.ParentIndexNumber} · E${item.IndexNumber} · ${item.Name}`));
  else if(!isLibrary)box.append(el('div','cardText cardText-secondary',item.AlbumArtist||String(item.ProductionYear||'')));
  if(item.UserData?.PlayedPercentage){const progress=el('div','itemProgressBar');const value=el('div','itemProgressBarForeground');value.style.width=`${item.UserData.PlayedPercentage}%`;progress.append(value);image.append(progress);}
  card.append(box);card.addEventListener('click',()=>{location.hash=isLibrary?nativeLibraryRoute(item):`#/details?id=${item.Id}`;});return card;
}
function homeRow(title:string,items:Item[],shape='backdropCard',isLibrary=false):HTMLElement{
  const row=el('section','verticalSection');row.setAttribute('aria-label',title);
  row.append(el('h2','sectionTitle sectionTitle-cards padded-left',title));
  const scroller=el('div','emby-scroller padded-top-focusscale padded-bottom-focusscale');scroller.setAttribute('is','emby-scroller');scroller.dataset.centerfocus='true';
  const container=el('div','itemsContainer scrollSlider focuscontainer-x');container.setAttribute('is','emby-itemscontainer');
  for(const item of items)container.append(homeCard(item,shape,isLibrary));scroller.append(container);row.append(scroller);
  if(!items.length)row.classList.add('hide');return row;
}
function featuredPreview():HTMLElement{
  const item=library.get('movie-tide')!;
  const root=el('section','ec-root demo-featured-preview');root.setAttribute('aria-label','Fictional featured preview');
  root.style.backgroundImage=`linear-gradient(90deg,#08090bea,#08090b20),linear-gradient(0deg,#08090b,transparent 65%),url("${artwork.get(item.Id)}")`;
  const copy=el('div','demo-featured-copy');copy.append(el('p','demo-native-eyebrow','FICTIONAL FEATURED PREVIEW'),el('h1','',item.Name),el('p','',item.Overview));
  const actions=el('div','demo-featured-actions');const play=el('button','demo-featured-play','Resume');play.type='button';play.addEventListener('click',()=>showPlayer(item,item.UserData?.PlaybackPositionTicks||0));
  const detail=el('a','demo-featured-details','Details');detail.href=`#/details?id=${item.Id}`;actions.append(play,detail);copy.append(actions);root.append(copy);
  // A visible demo of an independently owned plugin listener, not upstream code.
  root.addEventListener('keydown',event=>{if(event.key==='ArrowRight'){root.dataset.featuredKey='ArrowRight';detail.focus();event.stopPropagation();event.preventDefault();}});
  return root;
}
function renderNativeHome():void{
  const views=homePreferences.libraryOrder.filter(id=>!homePreferences.hiddenLibraries.includes(id)).map(id=>library.get(id)).filter((item):item is Item=>!!item);
  const sectionNames=[...homePreferences.sections];
  if(!sectionNames.some(name=>['smalllibrarytiles','librarybuttons'].includes(name)))sectionNames.unshift('smalllibrarytiles');
  const fragments:HTMLElement[]=[];
  if(homePreferences.featured)fragments.push(featuredPreview());
  const found=(ids:string[])=>scenario==='empty'?[]:ids.map(id=>library.get(id)!).filter(Boolean);
  for(const [index,name] of sectionNames.entries()){
    const slot=el('div',`section${index}`);slot.dataset.homeSection=name;
    if(name==='smalllibrarytiles')slot.append(homeRow('My Media',views,'backdropCard',true));
    else if(name==='librarybuttons'){
      const row=el('section','verticalSection');row.setAttribute('aria-label','My Media');row.append(el('h2','sectionTitle sectionTitle-cards padded-left','My Media'));
      const buttons=el('div','homeLibraryButtonContainer itemsContainer focuscontainer-x');buttons.setAttribute('is','emby-itemscontainer');
      for(const item of views){const button=el('a','raised homeLibraryButton',item.Name);button.href=nativeLibraryRoute(item);button.dataset.id=item.Id;buttons.append(button);}row.append(buttons);slot.append(row);
    }else if(name==='resume')slot.append(homeRow('Continue watching',found(['movie-tide','episode-north-1-2'])));
    else if(name==='resumeaudio')slot.append(homeRow('Continue listening',found(['song-tidelight-1','song-nightlines-2']),'squareCard'));
    else if(name==='nextup')slot.append(homeRow('Next up',found(['episode-signal-1-1','episode-wild-1-1'])));
    else if(name==='activerecordings')slot.append(homeRow('Active recordings',found(['recording-coast'])));
    else if(name==='livetv'&&views.some(item=>item.CollectionType==='livetv')){
      const row=el('section','verticalSection');row.setAttribute('aria-label','Live TV');row.append(el('h2','sectionTitle sectionTitle-cards padded-left','Live TV'));
      const links=el('div','focuscontainer-x demo-home-live-links');
      for(const [name,tab]of[['Guide','1'],['Recordings','3'],['Schedule','4']]){const link=el('a','raised',name);link.href=`#/livetv?tab=${tab}&collectionType=livetv`;links.append(link);}row.append(links);slot.append(row);
    }else if(name==='latestmedia'){
      for(const view of views){if(homePreferences.hiddenLatest.includes(view.Id))continue;
        const ids=view.CollectionType==='movies'?movieIds.slice().reverse():view.CollectionType==='tvshows'?seriesIds.slice().reverse():view.CollectionType==='music'?albums.map(item=>item.Id):[];
        if(ids.length)slot.append(homeRow(`Latest in ${view.Name}`,found(ids),view.CollectionType==='music'?'squareCard':'portraitCard'));
      }
    }
    fragments.push(slot);
  }
  replace(homeSections,...fragments);
  replace(favoritesTab,el('h1','','Favourites'),homeRow('Favourites', [...favorites].map(id=>library.get(id)!).filter(Boolean)));
}
document.addEventListener('demo-home-settings',((event:CustomEvent<Partial<HomePreviewPreferences>>)=>{
  const prefs=event.detail;for(const key of ['sections','hiddenLibraries','hiddenLatest','libraryOrder'] as const){if(Array.isArray(prefs[key]))homePreferences[key]=prefs[key]!.filter(value=>typeof value==='string');}
  if(typeof prefs.featured==='boolean')homePreferences.featured=prefs.featured;renderNativeHome();
}) as EventListener);
// Stand in for native Jellyfin's keyboard handler only inside this demo Home.
nativeHome.addEventListener('keydown',event=>{
  if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)||document.querySelector('#tv-layout')||(event.target as Element).closest('.ec-root'))return;
  const focused=document.activeElement as HTMLElement;const row=focused.closest('.focuscontainer-x');if(!row)return;
  const selectors='button,a[href]';const rows=Array.from(homeTab.querySelectorAll<HTMLElement>('.focuscontainer-x')).filter(node=>!node.closest('.hide'));
  const items=Array.from(row.querySelectorAll<HTMLElement>(selectors));const index=items.indexOf(focused);let next:HTMLElement|undefined;
  if(event.key==='ArrowLeft'||event.key==='ArrowRight')next=items[Math.max(0,Math.min(items.length-1,index+(event.key==='ArrowLeft'?-1:1)))];
  else{const target=rows[rows.indexOf(row as HTMLElement)+(event.key==='ArrowUp'?-1:1)];const cards=target?.querySelectorAll<HTMLElement>(selectors);if(cards?.length)next=cards[Math.min(index,cards.length-1)];}
  if(next){event.preventDefault();next.focus();next.scrollIntoView({block:'nearest',inline:'nearest'});}
});
renderNativeHome();
function syncRoute() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const current = library.get(params.get('id') || 'series-north');
  const guide = location.hash.startsWith('#/livetv');
  const movies = location.hash.startsWith('#/movies');
  const shows = /^#\/tv(?:\?|$)/.test(location.hash);
  const music = /^#\/music(?:\?|$)/.test(location.hash);
  const playlists = /^#\/playlists(?:\?|$)/.test(location.hash) || /^#\/list(?:\?|$)/.test(location.hash) && params.get('parentId')==='library-playlists';
  const home = /^#\/home(?:\?|$)/.test(location.hash);
  adventCalendar?.classList.toggle('hide', !home || params.has('cinemaProvider'));
  const preferences = /^#\/mypreferencesmenu(?:\?|$)/.test(location.hash);
  document.querySelector('.demo-switcher')?.classList.toggle('hide', params.has('cinemaProvider') || params.has('cinemaProviders') || params.has('cinemaCollections') || params.has('cinemaLoading'));
  nativeSettings.classList.toggle('hide', !preferences);
  nativePage.id=movies?'moviesPage':shows?'tvRecommendedPage':music?'musicRecommendedPage':/^#\/playlists(?:\?|$)/.test(location.hash)?'playlistsPage':guide?'liveTvSuggestedPage':'';
  const homeActive=home&&params.get('tab')!=='1';
  nativeHome.classList.toggle('hide',!home);nativeHeader.classList.toggle('hide',!home);nativePage.classList.toggle('hide',home || preferences);
  selectNativeHomeTab(homeActive?0:1);
  if(homeActive)setTimeout(function restoreHomeFocus(attempt=0){if(!/^#\/home(?:\?|$)/.test(location.hash)||!homeTab.classList.contains('is-active')||!nativeHome.isConnected)return;
    if(document.querySelector('.tvl-root')){if(attempt<20)requestAnimationFrame(()=>restoreHomeFocus(attempt+1));return;}
    const focus=homeFocused?.isConnected?homeFocused:homeTab.querySelector<HTMLElement>('.itemsContainer button,.homeLibraryButton');
    if(focus&&(!document.activeElement||document.activeElement===document.body||!nativeHome.contains(document.activeElement)))focus.focus({preventScroll:true});
  },30);
  const collection = location.hash.startsWith('#/details') && current?.Type === 'BoxSet';
  const collectionList = /^#\/(list|boxsets)\?/.test(location.hash) && (params.get('parentId')==='library-collections'||location.hash.startsWith('#/boxsets')||params.get('type')==='BoxSet');
  nativePage.classList.toggle('mainAnimatedPage',collectionList || playlists);
  nativePage.classList.toggle('libraryPage',collectionList || playlists);
  nativePage.classList.toggle('demo-collection-page',collection);
  if (collection) {
    const content = el('div','demo-collection-content');
    const back = el('button','','← Back');back.type='button';back.addEventListener('click',()=>history.back());
    content.append(back,el('p','demo-native-eyebrow','COLLECTION'),el('h1','',current.Name));
    const grid = el('div','demo-collection-grid');
    for (const id of collectionMembers.get(current.Id) || []) {
      const member = library.get(id)!;
      const link = el('a');link.href=`#/details?id=${encodeURIComponent(id)}`;
      link.append(picture(artwork.get(id) || null,'demo-collection-art'),el('h2','',member.Name));
      grid.append(link);
    }
    content.append(grid);replace(nativePage,content);
  } else if (collectionList || playlists) {
    const content=el('div','demo-collection-content');content.append(el('h1','',playlists?'Playlists':'Collections'));
    const items=el('div','itemsContainer');items.dataset.parentid=params.get('parentId')||'';content.append(items);replace(nativePage,content);
  } else if (nativePage.querySelector('.demo-collection-content')) nativePage.innerHTML=originalNativeContent;
  const recordingPage = guide && params.get('tab')==='3' || /^#\/list(?:\?|$)/.test(location.hash) && params.get('type')==='Recordings';
  const type = preferences?'settings':home?'home':music||playlists||['MusicAlbum','MusicArtist','Audio','Playlist'].includes(current?.Type||'')?'music':recordingPage||recordings.some(item=>item.Id===current?.Id)?'recordings':collection||collectionList?'collections':movies?'movie':guide ? 'live' : current?.Type === 'Movie' ? 'movie' : current?.Type === 'TvChannel' || current?.Type === 'Program' ? 'live' : 'series';
  document.querySelectorAll<HTMLAnchorElement>('[data-demo-type]').forEach((link) => {
    if (link.dataset.demoType === type && (preferences || home || music || playlists || guide || movies || shows || recordingPage || collectionList || location.hash.startsWith('#/details'))) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  if (!location.hash.startsWith('#/video')) closePlayer();
  else if (scenario === 'cinema-trailers' && !player) showCinemaPlayer();
}

window.addEventListener('hashchange', syncRoute);
window.addEventListener('keydown', (event) => {
  if (player && ['Escape', 'BrowserBack', 'GoBack', 'MediaStop'].includes(event.key)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    returnToDetails();
  }
}, true);
if (!location.hash) history.replaceState(null, '', `${location.pathname}${location.search}#/details?id=series-north`);
window.TvItemLayoutDemo = { api, initialItem: 'series-north' };
syncRoute();
