# Install ScreenHarbour Brasil on Jellyfin

ScreenHarbour Brasil is an independent server plugin hard fork that loads the bundled client into **Jellyfin Web**. The layout activates in the web client's TV and desktop display modes; mobile retains its native pages. ScreenHarbour Brasil is maintained by **Shillooh** and is not affiliated with or endorsed by Jellyfin.

The current release is **1.5**, available through the catalogue and manual downloads below. Returning from a movie restores the selected Home item to its previous position on screen. Position restoration follows delayed native scrolling and layout changes, and finds the current scrolling container if Jellyfin has replaced it. The same row, tab, shuffle order and loaded artwork are retained; new navigation stays responsive. All saved settings, seasonal effects and compatibility identifiers remain unchanged.

The integration is adapted from [InPlayerEpisodePreview-TV](https://github.com/jampez77/InPlayerEpisodePreview-TV) and [ScreenHarbour](https://github.com/jampez77/ScreenHarbour). It has a separate name, assembly, API route, and plugin ID (`1a06b74f-7609-4af9-899d-430c9b5a52b1`), so it can be installed alongside that plugin. The inherited MIT notice is included in every archive. Archives also include the optional Jellyfin loading icon's source SVG, attribution and CC BY-SA 4.0 licence under `assets/loading/`; the icon identifies Jellyfin and is not ScreenHarbour branding. Seasonal title fonts and their SIL Open Font License notices are embedded in the DLL; readable licenses and provenance are also included under `assets/seasonal-fonts/`.

ScreenHarbour Brasil retains the existing plugin ID, `Jellyfin.Plugin.TvItemLayout.dll`, API endpoints, script and archive filenames. Its public repository is [Shillooh/HabourBRVer](https://github.com/Shillooh/HabourBRVer). Add the catalogue repository entry with the URL below.

## Install from the catalogue

1. In **Dashboard → Plugins → Repositories**, add **ScreenHarbour Brasil** with this URL:

   ```text
   https://raw.githubusercontent.com/Shillooh/HabourBRVer/main/manifest.json
   ```

2. Add the **File Transformation** repository from its [installation instructions](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation#installation): `https://www.iamparadox.dev/jellyfin/plugins/manifest.json`.
3. From the catalogue, install the compatible build of **ScreenHarbour Brasil** and **File Transformation**. File Transformation is a separate dependency and is not installed automatically. If it is already installed, keep the compatible version.
4. Restart Jellyfin. Check Dashboard → Plugins for **ScreenHarbour Brasil**. The server log should contain `ScreenHarbour registered with File Transformation`.
5. Reload Jellyfin Web, using **Desktop** or **TV** display mode in your user's display settings. Fully close and reopen a web-based TV app to clear its loaded client. Open a movie, series, or Live TV item.

Choose the build from the [v1.5 release](https://github.com/Shillooh/HabourBRVer/releases/tag/v1.5) that matches your Jellyfin server:

| Jellyfin server | ScreenHarbour Brasil version |
| --- | --- |
| 10.10.7 | `1.5` |
| 10.11.x | `1.5` |
| 12.x | `1.5` |

The repository lists all three targets and Jellyfin filters them by server compatibility.

If a newly published version is missing, Jellyfin 12’s dashboard can reuse its [cached catalogue for 15 minutes](https://github.com/jellyfin/jellyfin-web/blob/v12.0/src/apps/dashboard/features/plugins/api/usePackages.ts#L19-L25), even after a page reload. Leave and reopen **Catalogue** after that interval. To refresh immediately, remove only the **ScreenHarbour Brasil repository entry** from **Repositories**, then add it again using the same catalogue URL above. This refreshes the listing without uninstalling the plugin or clearing your Home row preferences.

If Jellyfin Cinema or TV Item Layout is already installed, open **Dashboard → Plugins → Repositories** and replace its catalogue entry with the ScreenHarbour Brasil URL above. Update the existing plugin to the matching 1.5.0.0 build, restart Jellyfin and fully reopen the client. Do not uninstall it or add a second copy: the unchanged GUID identifies the update. In TV and desktop display modes, **Live TV** opens our guide at `web/#/livetv?collectionType=livetv`, and **Channels & guide** on channel details links to the same page. Mobile layouts retain Jellyfin's normal pages.

Theme videos use Jellyfin’s existing background player and follow its theme-video preference. If there is no playable theme video, the static backdrop remains. Collections list actual membership and open styled collection pages. The Collections library, explicit BoxSet list, and Movies → Collections tab also use the new layout. The Movies and TV Shows libraries also use the new style, including Jellyfin suggestions, favourites, genres, search and A–Z/# browsing. Native Upcoming, Networks and Episodes TV routes remain available through Jellyfin. Unrelated library lists and unsupported URL filters retain their native pages.

Movie and episode details show **Ends at** beside the ratings when a usable runtime is available. The estimate uses the current local clock plus the remaining runtime for **Resume**, or the full runtime when **Play** starts a watched title from the beginning. It updates when its displayed finish minute changes. The series hero uses its selected episode’s duration and playback position.

## Build a matching archive

Install the repository's Node dependencies and a .NET SDK that supports the selected target. Run from the repository root:

```sh
npm ci
bash scripts/package-plugin.sh 10.11.0
```

| Jellyfin server | Build argument | Framework |
| --- | --- | --- |
| 10.10.7 | `10.10.7` | .NET 8 |
| 10.11.x | `10.11.0` (default) | .NET 9 |
| 12.x | `12.0.0` | .NET 10 |

To compile all three baseline targets and preserve their archives in a single run:

```sh
bash scripts/package-plugin.sh all
```

The script builds the client first, embeds it in the plugin DLL, and creates ZIP files and SHA-256 checksums in `dist/releases/`. The published packages and this source tree use `0.2.55.1` for Jellyfin 10.10.7, `0.2.55.2` for 10.11.x and `0.2.55.3` for 12.x. The target labels describe the Jellyfin API packages compiled against; test on your actual server before relying on a different patch release. Compilation alone does not establish compatibility with every client or server configuration.

## Install manually

1. In Dashboard → Plugins → Repositories, add the repository from the [File Transformation installation instructions](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation#installation): `https://www.iamparadox.dev/jellyfin/plugins/manifest.json`.
2. Install **File Transformation** from the catalogue, choosing a release compatible with your Jellyfin version.
3. Download the matching archive from the [0.2.55 release assets](https://github.com/jampez77/ScreenHarbour/releases/tag/v0.2.55), or use a matching local archive from `dist/releases/`. Stop Jellyfin. Extract the ZIP into a versioned folder inside your server's configured `plugins` directory, such as `TV Item Layout_0.2.55.3` for Jellyfin 12. Keep the DLL directly inside this folder and replace the previous version when upgrading manually. Common plugin locations are `/config/plugins` for the official container and `/var/lib/jellyfin/plugins` for a Linux package installation; use the location belonging to your installation.
4. Start Jellyfin. Check Dashboard → Plugins for **ScreenHarbour** and the File Transformation registration message.
5. Reload Jellyfin Web, using Desktop or TV display mode in your user's display settings. Open a movie, series, or Live TV item.

## If automatic injection is unavailable

ScreenHarbour never modifies Jellyfin's installed web files itself. When a compatible File Transformation plugin is unavailable, it logs a warning and leaves the client script endpoint available.

An administrator who already maintains a custom web client or HTML injection setup can explicitly add the following element immediately before `</body>` in Jellyfin Web's `index.html`:

```html
<script data-tv-item-layout="true" defer src="/TvItemLayout/ClientScript"></script>
```

If the Jellyfin base URL is `/jellyfin`, use `src="/jellyfin/TvItemLayout/ClientScript"`. A web client hosted on another origin needs the correct server origin in this URL. The unversioned endpoint revalidates its ETag on each load. File Transformation injection adds a content-derived version automatically, allowing immutable caching until the embedded bundle changes.

Keep a backup before making a manual HTML change. Reapply it after replacing the web client, and remove it during uninstallation. Custom CSS alone cannot load this JavaScript.

## Verify or troubleshoot

The server checks start a temporary loopback HTTP host to verify script delivery, cache headers, conditional requests, and HTML injection. They require the matching .NET runtime and the built client (.NET 8 for Jellyfin 10.10.7, .NET 9 for 10.11.x, .NET 10 for 12.x):

```sh
npm run build
dotnet run --project server/verification/TvItemLayout.ServerChecks.csproj --configuration Release
# To verify the Jellyfin 12 target:
dotnet run --project server/verification/TvItemLayout.ServerChecks.csproj --configuration Release -p:JellyfinVersion=12.0.0
```

They also check profile-switch eligibility and session boundaries using real version-specific Jellyfin entity types and controlled service stubs. They do not start a Jellyfin server or establish native client compatibility.


- Open `<server base URL>/TvItemLayout/ClientScript`. It should return JavaScript with content type `application/javascript`. This static asset is intentionally public; library data and playback still use Jellyfin's authenticated APIs.
- If the endpoint returns 404, check the plugin DLL location, installed target version, and startup logs, then restart Jellyfin.
- If the endpoint works but the layout does not appear, inspect the served web `index.html` for `data-tv-item-layout`. The scheduled task **ScreenHarbour startup** can retry registration after File Transformation is available.
- Clear the browser's stored cache or fully close and reopen the web client after replacing the plugin. For a custom Content Security Policy, allow the script's origin.
- The plugin changes media detail views and the main Live TV page in the web TV and desktop layouts. Native Android TV, Roku, and other clients with their own UI are outside this integration.

To uninstall, remove **ScreenHarbour** (or **Jellyfin Cinema** / **TV Item Layout** on older builds) through Dashboard → Plugins and restart, or stop Jellyfin and remove its versioned plugin folder manually. Reload the web client and remove any manually inserted script tag. File Transformation can remain installed for other plugins.

## Home preferences and Featured

Home retains its charcoal background. On login, ScreenHarbour leaves the native or installed theme backdrop visible while styling the existing user chooser and password form.

Home styles Jellyfin’s existing sections in place, with titles and subtitles sharing its charcoal surface. Native sections, streaming-service tiles and custom collection rows are revealed together once their initial content is ready. A bounded fallback keeps Home usable if a request stalls, and background refreshes keep existing rows visible while replacements load. Custom and native cards highlight their thumbnails; titles and rank images remain outside the border. Collection rows use matching section spacing, hidden horizontal scrollbars and focus gutters at both ends. Set the native sections and their order in your normal Jellyfin Home settings; user/device overrides, library exclusions, Next up options and saved destinations remain owned by Jellyfin.

If [Jellyfin Featured](https://github.com/spkesDE/jellyfin-featured-plugin) is installed, its carousel remains in the native Home container. ScreenHarbour matches its colours and typography to the rest of the layout. Its display settings, height and layout, personalization, trailers and input handling remain under Featured’s control. Keep Featured enabled.

In desktop display mode, open **Settings → ScreenHarbour → Collection rows**, alongside **Streaming services** and **Loading screen**. The Settings section uses your configured interface title if you have renamed ScreenHarbour. TV displays the saved account rows without an editing control. Select a row from the row list and use its **Content**, **Item order** and **Home position** tabs in the adjacent workspace. Add a Collections row for several selected collections, or separate collection items rows for individual collections. Choose titles and optional **Ranked artwork**, then choose **Save rows**. Choose **Add collection tabs** for up to six tabs on an item row, each with an editable label, its own source collection and item order. The first tab opens by default. Use **Movies** and **Shows** tabs to keep separate collections under one row title, or choose any labels and collections that suit your library. Existing single-collection rows keep working.

Choose **Add seasonal group** for one Home position containing up to 12 named sub-rows. Add collection, collection-items or Watchlist sub-rows; set their inclusive start/end month and day, and configure their normal content, tabs, ranks and ordering. Dates repeat each year in the viewing device's local calendar and can cross New Year. Overlapping sub-rows appear together in their configured order. Only active sub-rows appear on Home; the group itself has no heading or empty placeholder. The preview remains available when editing an out-of-season row. Under **Item order**, **Shuffle on load** randomises a row's displayed items on each fresh Home visit without altering the saved sort or the Jellyfin collection. Back from a film opened in that row preserves the current shuffle and returns to the originating row and tab’s selected card, even when the same film appears elsewhere on Home. One final correction after Jellyfin’s delayed focus scrolling keeps the saved position; new navigation, pointer input or wheel scrolling cancels that correction. Background updates also preserve the current shuffled order.


Each seasonal sub-row has an **Appearance** tab with **Normal**, **Halloween** and **Christmas** themes. Backgrounds can be disabled, remain static behind scrolling cards, or pan with horizontal navigation using parallax; their top and bottom blend into Home. Parallax moves the existing scenery layer, keeping the same image and graphics-surface dimensions. Choose standard height, roomier (up to 1.5×), immersive (up to 2×), or **Full screen** when an item is focused. Full screen expands below the Jellyfin header and transforms the title into larger themed lettering matched to the scenery style. Seven locally served OFL fonts cover the Halloween and Christmas styles; only the selected font loads. Growth is capped to fit the screen, leaves poster sizes unchanged and closes when focus leaves the row. Optional frames add spooky windows or advent-style decoration. Doors, shutters or curtains cover each item's artwork and title until focused or hovered; Christmas door numbers follow item positions and do not restrict playback by date. Reduced-motion preferences disable transitions and parallax movement.

Choose **Scenery style**, **Frame style** and **Door or shutter style** independently. Illustrated is the default; Playful / family and Photorealistic are available for both seasons. Halloween additionally offers **Nightmare — very scary** for adult horror collections; switching to Christmas removes Nightmare choices without changing the other options. Photorealistic and horror artwork is generated, bundled locally with the plugin/demo and requested only from their own assets, without contacting an external image service.

The live preview includes these focus and reveal effects. **Normal** removes the optional appearance while preserving the row's content, dates and position. Appearance settings follow the account through the existing Home collections endpoint and storage path. They are optional fields on seasonal children, so existing version-1 settings need no migration; ordinary rows and out-of-season visibility are unchanged.

**Home preview** shows the row’s title, artwork, active collection tab and selected order as you edit. Ranked rows show the same outlined number images used on Home, while position context places the draft row among your Home sections. Missing-artwork placeholders remain contained in the choice and order thumbnails, keeping the editor usable. These are unsaved changes: **Save rows** applies them and **Cancel** keeps your previous settings.

**Item order** can retain Jellyfin’s collection order, sort by title or year, or use a manual order. The change is local to that Home row and does not edit the server’s collection metadata. Number images beside posters follow this chosen order, not a popularity calculation. **Home position** places custom rows among native sections, including Featured and each library’s Latest row, while Jellyfin and Featured keep control of their own sections. Visit Home once to make its sections available in the editor. If a chosen section is hidden or unavailable, its custom row appears at the end.

Custom row settings sync through the server for the signed-in account. **When upgrading from an older device-only release, open Home once in the original desktop browser to migrate its saved rows**, then reopen Home on the TV with the same account. This release requires no additional migration. Home also refreshes while visible every minute and on returning to the app. The server copy is authoritative, including deliberately empty rows; a fresh device cannot erase existing settings. If two editors change rows together, the later save asks you to reload saved rows before trying again. Home sync failures keep the last cached rows and retry silently, without a warning banner or Retry button. The editor still reports failed loads and saves; failed saves keep the draft open. Local storage caches the last saved rows for offline display; the standalone demo still saves locally. Existing version-1 settings are preserved: rows keep collection order and end-of-Home placement until edited. Limits are 12 rows, 40 selected collections per Collections row, 2,000 saved item IDs per manual order, and 60 displayed members per item row, followed by **View full collection** when more members are available. The complete sync request is limited to 512 KiB; unusually large combined manual orders show an error instead of being truncated. Native Home settings and Featured preferences remain separate. The authenticated `GET/PUT TvItemLayout/HomeCollections` endpoint resolves the user from the current device session, rejects API keys and uses conditional revisions to prevent stale writes. Settings are stored under the server data directory at `jellyfin-cinema/home-collections/<user-id>.json`; include this directory in server backups.

The optional [UK platform trending guide](https://github.com/jampez77/ScreenHarbour/blob/main/docs/platform-trending.md) explains how SmartLists 12.0.3.0 or newer on Jellyfin 12 can maintain weekly UK JustWatch collections through MDBList. ScreenHarbour displays the matching items already in your library. It can show these as six platform rows with **Movies**/**Shows** tabs, or use any existing collections without external list plugins.

Use **Add to collection** on a media detail page to choose an existing collection or create one. This writes to Jellyfin and requires your account’s collection-management permission. Existing memberships are marked to avoid duplicate additions; successful saves refresh the item’s collection links.

## Personal loading screen

In TV or desktop display mode, open **Settings → ScreenHarbour → Loading screen**. Choose **Film projector**, **Clapperboard**, **Film reel**, **Cinema countdown**, **Spotlights** or **Jellyfin logo** and preview your own title and message. The title accepts up to 60 characters and the message up to 120; either can be empty. **Save** applies the choices to the current account. **Restore defaults** changes only the preview until saved; **Cancel** keeps the previous saved choices.

The saved **Title** also replaces the interface wordmarks in the Settings section, loading editor, streaming-service editor, profile chooser and profile-switching screen. The Settings section therefore uses your chosen name after saving. An empty title hides these labels without leaving their spacing. Draft text stays in the preview until **Save**, and text is displayed literally rather than interpreted as markup. Account changes select that account's title; an account without saved choices uses the default.

Before sign-in, the login screen uses this device's last confirmed display title for the selected server. Only that title is cached separately for login; the loading-screen settings endpoint still requires authentication and no account settings are exposed publicly. The login title survives a client restart and is isolated from other servers. A new device shows the default until an account has synced on that device. Existing saved titles are picked up automatically after updating; there is no need to save them again.

The authenticated, uncached `GET/PUT TvItemLayout/LoadingScreen` endpoint reads and saves only the current user/device session's settings and rejects API keys. Its response is `{ "Revision": string | null, "Settings": object | null }`; a new account receives null fields and uses the default animation without a background write. PUT accepts the same envelope, with the revision returned by GET and settings `{ "version": 1, "animation": "projector" | "clapperboard" | "film-reel" | "countdown" | "spotlights" | "jellyfin", "brandText": string, "message": string }`. Unknown settings fields, unsupported animations, control characters and excessive text are rejected. Requests are limited to 8 KiB. A conflicting edit returns HTTP 409; the editor keeps its draft and asks to reload before saving again.

Settings are stored at `jellyfin-cinema/loading-screen/<user-id>.json` under the server data directory. **Include this directory in backups** alongside `home-collections` and `provider-homes`; those existing settings remain separate. The account-scoped local cache displays immediately, and fresh preferences load independently of Home content. Failed background reads retain the cached choice and stay quiet; the editor reports failed reads or saves. Changing animation preferences does not add a delay or force an animation on return visits. The standalone demo stores its choices only in the browser.

## Desktop item administration

Signed-in administrators can select **More** on supported media pages to open Jellyfin's native item menu. Available actions depend on the item and server, including **Edit metadata**, **Edit images**, **Refresh metadata** and **Identify**. Jellyfin supplies the editor forms, refresh choices, permission checks and confirmations. Successfully edited metadata and artwork refresh the current ScreenHarbour view. If a client cannot open the native menu, ScreenHarbour opens the original item page so its controls remain available.

Administrator permission is checked again when the button is selected. The controls are hidden for non-administrator accounts and TV display mode. The demo has no native Jellyfin editors; use an installed server to verify these actions.

## Provider Home data and settings

Home includes branded streaming-service tiles for Netflix, Prime Video, Disney+, Apple TV+, NOW, Paramount+, BBC iPlayer, ITVX and Channel 4, plus custom services. Each opens its configured rows; broadcaster presets begin with Films and TV shows. Configure the tile row and provider pages in **Settings → ScreenHarbour → Streaming services**. This is a personal account preference, not an administrator-only dashboard action. Desktop provider pages offer **Edit service**, which opens that service directly in Settings; TV pages keep browsing controls only. The [provider Home guide](https://github.com/jampez77/ScreenHarbour/blob/main/docs/provider-homes.md) covers row sources, overrides, sorting, rank artwork and previews.

Availability-based catalogue matching needs Jellyfin's installed TMDB integration, outbound HTTPS access to `api.themoviedb.org`, and usable TMDB metadata IDs on library movies/series. Disney studio matches use existing local metadata and do not require these lookups. ScreenHarbour reuses the native TMDB integration's configured or bundled key on the server. It does not expose that key through the client or settings endpoints. Availability requests send movie/TV TMDB IDs to TMDB; they do not include Jellyfin user IDs, file paths or watch history. Catalogue lookups do not use MDBList and need no additional browser credential.

Catalogues match permitted library titles against **Brazil availability** (`BR`) for configured TMDB watch-provider IDs and offer types. Preset providers include Globoplay, Max, Prime Video, Netflix, Brasil Paralelo, Disney+, Paramount+, Discovery+, Rakuten Viki and custom services. When Disney+ is selected for films or shows, recognised Disney studio metadata also qualifies that media type independently of current offers. In addition, ScreenHarbour Brasil features automated daily TMDB trending rows that query the top popular movies and TV series in Brazil directly from TMDB and automatically match them against your local library items.

Disney studio matches appear immediately and require no availability request or TMDB ID. Other candidates fill rows progressively as the background worker checks missing availability. Successful responses are cached for seven days in `jellyfin-cinema/providers/BR-v2.json` under the Jellyfin data directory. The cache is shared by provider pages, contains TMDB lookup keys/provider memberships rather than user preferences, and is disposable. Stale successful entries remain usable during refresh failures; failed requests retry with backoff. Newly added titles are checked when their permitted library contents are next requested. An open provider page checks pending work every five seconds, otherwise every minute, and refreshes when it regains focus.

The authenticated endpoints are:

| Endpoint | Purpose |
| --- | --- |
| `GET/PUT TvItemLayout/ProviderHomes` | Read/save the current account's service order, tile size/name labels, Home position, provider names/artwork/colours, source IDs/offer types and rows using `{ Revision, Settings }` with conditional revisions |
| `GET TvItemLayout/Providers/Catalogue` | Named Brazil film/TV services for configuration; the server caches the public directory for 24 hours and keeps stale results on temporary failures |
| `POST TvItemLayout/Providers/Preview` | Read-only authenticated draft catalogue preview: complete version-2 provider object in JSON body, `mediaType=Movie` or `Series` plus the same paging/sort query; never saves preferences |
| `GET TvItemLayout/Providers/{providerId}/Items` | Paginated matching library items with `type=Movie` or `Series`, `startIndex`, `limit` and `sort=title`, `title-desc`, `newest` or `oldest` |

Built-in provider IDs include `globoplay`, `max`, `prime`, `netflix`, `brasilparalelo`, `disney`, `paramount`, `discovery`, `viki`; additional services use validated `custom-…` IDs. The saved account configuration determines each service’s source mappings; unknown, removed or disabled services return 404. These endpoints require the current user/device session, reject API keys and return uncached HTTP responses. The items endpoint also reports readiness, pending lookup counts, missing metadata IDs and upstream lookup failures so clients can distinguish incomplete/unavailable data from a valid empty result. Cached provider memberships never substitute for current user access checks.

Settings are stored at `jellyfin-cinema/provider-homes/<user-id>.json` under the server data directory; include this directory in backups. They are independent of `home-collections` settings. The request limit is 128 KiB, with up to 24 services and 12 rows per service.

For missing provider content:

- **Checking availability** is progress, not a stalled library scan. Let the background checks complete; the same cached results serve all service pages.
- **Availability is temporarily unavailable** means the native TMDB integration, connectivity or upstream data is unavailable. Verify the TMDB plugin is installed and loaded and that Jellyfin can reach its API. Previously known matches remain visible when possible.
- A **needs TMDB metadata** message identifies library entries that cannot be matched yet. Correct their metadata IDs in Jellyfin; ScreenHarbour does not guess by title.
- A settings endpoint 404 usually means the client and server plugin versions differ. Update the matching package, restart Jellyfin and fully reopen the client. A row request error offers **Retry** without replacing existing results with a misleading empty row.

## Music and recordings refinements in 0.2.1

Choose **Playlists** from My Media or Jellyfin’s navigation menu, or **Music → Playlists**, to browse your account’s playlists, search or filter them, and open their track rows. **Play playlist** starts the complete playlist; selecting a track starts the complete queue at that entry. The saved order and repeated tracks are preserved through Jellyfin’s authenticated APIs and native playback. More tracks load through **Show more**, and Back restores the selected card and filters. Album Play buttons have extra room for their focus highlight.

Jellyfin’s native music player and Now playing queue receive a larger album-art layout, clear track details and matching queue styling; their queue actions, playback state and permissions remain native. In desktop mode, the existing compact audio bar stays accessible below ScreenHarbour’s full-page views. Its mouse controls and slider keys remain native, and the page reserves room for the visible bar. The current DVR library’s **Recordings** tile on Home uses ScreenHarbour’s recordings layout, scoped to that folder. An older recording library may remain a separate mixed-content folder after the DVR destination changes. Since 0.2.6, those folders also receive ScreenHarbour headings, controls and cards while keeping their native contents and filters. No folders are merged or redirected. Recordings’ **Schedule**, **Series recordings**, details and DVR dialogs retain Jellyfin’s scheduling, editing and permission checks.

## Search, settings and profiles

In TV and desktop modes, Search, Settings and the signed-out login page share the ScreenHarbour styling. Their native search controls, preference forms, Quick Connect and authentication behavior remain active. Mobile keeps Jellyfin’s native pages and account menu.

Select the user avatar to open **Who’s watching?** directly. Large square profile artwork, names and clear focus states make the chooser easy to use with a remote. Select the current profile or **Back** to return. **Settings**, **Use login screen**, and **Dashboard** for the signed-in administrator appear below the profile tiles. Dashboard permission is checked again when selected; Settings also includes the shortcut.

**Who’s watching?** shows Jellyfin’s public profiles. An eligible passwordless profile opens Home after Jellyfin finishes signing out the old session. Profiles marked **Sign in** and **Use login screen** open native sign-in; hidden accounts can sign in there manually. Login styling follows the saved device TV or desktop display mode even while signed out. Version 0.2.9 keeps ScreenHarbour-initiated webOS switches on the current server: native logout still clears credentials, queries and views, then its public server-selection callback opens the same server’s login route instead of unloading the web frame. Normal native logout remains unchanged.

Version 0.2.7 replaced the obsolete `HasPassword` flag, which Jellyfin 12 always reports as true, with the authenticated `TvItemLayout/ProfileSwitchEligibility` endpoint. It returns only eligible profile IDs to the current signed-in user/device session, rejects API keys and is not cached. Candidates must be visible, enabled, non-administrator accounts using Jellyfin’s default authentication provider with an empty stored password, and satisfy device/network rules. The client intersects these IDs with Jellyfin’s public users and checks again before logout. An unavailable or incompatible endpoint falls back to native sign-in. ScreenHarbour does not guess blank passwords to discover accounts, store extra credentials, or change passwords, roles or server policies.

To allow one-click switching in both directions, each viewing account must be eligible and passwordless; keep a separate password-protected administrator. An administrator can use **Dashboard → Users → account → Password → Reset Password** for a non-admin viewing account and make it visible on login screens. Do this only for accounts you intend to make passwordless. If a password or access rule changes between the check and sign-in, Jellyfin can reject the single normal authentication attempt; ScreenHarbour offers native login without retrying.

## Integrated player features

In TV and desktop display modes, press Down from the bottom playback control or choose the desktop Browse icon to open the episode/film/channel browser. Version 0.2.13 restores this when the seek slider is below the buttons, as in ElegantFin. Moving down from the header or any control with another focusable control below it keeps native navigation available. In 0.2.1 the mouse control is a compact icon with a tooltip and accessible label, without changing the native player bar’s sizing. The season selector previews that season’s first available episode without changing playback; Play/Resume starts the selected episode. Version 0.2.0 fixes Down opening the integrated preview when a standalone preview script is present but failed to initialise. Pause video to show its artwork and synopsis. Working standalone preview controls retain priority. The standalone PauseScreen plugin retains priority over the integrated pause treatment.

During live video, **ChannelUp / ChannelDown** commands and channel keys exposed by the client step through the same permitted channel order as the guide. Held repeats and pending tunes are ignored. Movies, episodes, audio, text fields and modal dialogs keep their normal controls. [LG’s key table](https://webostv.developer.lge.com/develop/guides/magic-remote) lists programme +/− as unavailable to web apps; ScreenHarbour cannot receive a key reserved by the TV. Use **Down → Channels** if your remote does not deliver it. This release does not remap Page Up/Down, which Jellyfin uses for chapter controls.

`TvItemLayout/PlaybackContext` is an authenticated, uncached read endpoint. It resolves only the request’s current user and device and returns playing identity and queue, without credentials or unrelated session data. It supports cinema intro resolution; browsing can still use the native player’s identity if this endpoint is unavailable. Native playback and user media permissions remain controlled by Jellyfin.

## Cinema trailer controls

During Cinema Mode trailers before a film, **Skip trailer** advances one entry through Jellyfin’s existing playback queue, preserving the queued film’s media source, audio and subtitle selections. **Add to watchlist** saves the advertised library film to the current account’s private native **Watchlist** video playlist, available in **Movies → Watchlist** and under **Playlists**. The button changes to **In watchlist** after a successful save. Repeated saves do not create duplicate entries; mouse, keyboard and TV focus navigation are supported. Controls appear from the first trailer and remain available over the pause screen. Skip starts the next queue entry playing, including when the outgoing trailer is paused.

The advertised film comes from Jellyfin’s trailer-owner metadata. Standalone trailers, theme videos and custom cinema bumpers keep their normal controls. If a pre-film trailer cannot be linked to an available movie, Skip remains available and Add to watchlist is disabled. The controls work with Cinema Mode’s local movie trailers; they do not guess movie identities from trailer titles.

The authenticated, uncached `GET TvItemLayout/TrailerActions` endpoint validates the current user/device playback and queue. `POST TvItemLayout/TrailerActions/Watchlist` accepts that trailer identity and resolves the advertised film on the server. It creates or reuses an owner-only, unshared video playlist named Watchlist. Public/shared, audio and SmartLists-managed playlists are excluded. If more than one eligible Watchlist exists, rename one in Playlists before adding films.

## Personal Watchlist

Movie and TV-show details offer **Add to watchlist** / **In watchlist**; selecting a saved title’s button removes it. Movies and TV Shows each have a **Watchlist** tab with search, alphabet filters and paging. Favourites remain separate. Films already saved from trailers appear automatically.

On desktop, use **Settings → ScreenHarbour → Collection rows → Add Watchlist row** for a mixed film/show Home row. Set its title, placement and item order, preview it, and save. In **Settings → ScreenHarbour → Streaming services**, select a service and **Add Watchlist row** for saved films and shows matched to that service’s catalogue. Disney+ includes recognised Disney studio titles even without a current UK streaming match. These rows are optional and appear only when they contain items; no existing row order is changed automatically. An empty service Watchlist section button is hidden too. Saved rows remain configured and appear when matching items become available. Services with no configured movie/TV availability IDs need those matching options set before their Watchlist row can populate.

The authenticated, uncached `TvItemLayout/Watchlist` endpoints read and modify only the current session’s account. Movie saves reuse its private native Watchlist playlist. Whole-series references are stored atomically under `data/jellyfin-cinema/watchlists/<user-id>.json`, without adding every episode to the playlist. Back up that directory along with Jellyfin data and playlists. All reads reapply native user library and parental permissions; account, device and remote-access eligibility are checked before changes.

Paused trailers use the authenticated, uncached `GET TvItemLayout/TrailerDetails` endpoint to resolve their verified advertised movie, then load that film’s metadata and artwork. It validates the current user/device playback identity and native movie visibility without requiring a following film in the queue. This also supports standalone trailers and cinema trailers reported by Jellyfin as a single-item queue; it does not grant Skip or Save controls. A late mapping is retried; an unresolvable trailer retains its own metadata. The queued feature’s details are never substituted for an unknown advertised movie.

### Home library visibility

The authenticated, uncached `GET TvItemLayout/HomeLibraryExclusions` endpoint reads the current account's native Home visibility preferences and resolves excluded user views to their underlying folder IDs using Jellyfin's own view relationships. The response contains `UserId` and `ExcludedLibraryIds`. It accepts no target-user parameter and never writes preferences. The client rejects results from a changed account or server and keeps the last successful exclusions through temporary failures.
