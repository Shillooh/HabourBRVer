import { LoadingSettingsEditor } from './loading-settings-editor';
import { HomeCollectionEditor } from './home-collection-editor';
import { InterfaceBranding } from './interface-branding';
import loadingAnimationStyles from './loading-animation.css';
import loadingSettingsStyles from './loading-settings.css';
import adminItemActionStyles from './admin-item-actions.css';
import styles from './style.css';
import { isCinemaLayout, isDesktopLayout } from './layout';
import { DesktopPlayer } from './desktop-player';
import guideStyles from './guide.css';
import themeVideoStyles from './theme-video.css';
import collectionStyles from './collection.css';
import libraryStyles from './library.css';
import nativeHostStyles from './native-host.css';
import browseStyles from './browse.css';
import recordingsStyles from './recordings.css';
import musicPlayerStyles from './music-player.css';
import { NativeRecordingsTheme } from './native-recordings';
import { ProfileMenu } from './profile-menu';
import profileMenuStyles from './profile-menu.css';
import { NativeFolderTheme } from './native-folder';
import nativeFolderStyles from './native-folder.css';
import { NativeLoginTheme } from './native-login';
import loginStyles from './login.css';
import { NativeUserPages } from './native-user-pages';
import nativeUserPageStyles from './native-user-pages.css';
import homeStyles from './home.css';
import homeCollectionStyles from './home-collections.css';
import seasonalAppearanceStyles from './home-seasonal-appearance.css';
import seasonalEditorStyles from './home-seasonal-editor.css';
import { HomeCollections, clearHomeSession } from './home-collections';
import { ProviderHomeView, type ProviderHomeState } from './provider-home';
import { ProviderSettingsEditor } from './provider-settings-editor';
import { ProviderData } from './provider-data';
import { validProviderId, type ProviderId } from './provider-settings';
import providerHomeStyles from './provider-home.css';
import providerSettingsStyles from './provider-settings.css';
import pauseStyles from './pause-screen.css';
import playerStyles from './player-browser.css';
import { NativeHostMask } from './native-host';
import { observeThemeVideo } from './theme-video';
import { createJellyfinApi } from './api';
import { DetailView } from './view';
import { GuideView } from './guide-view';
import { CollectionView } from './collection-view';
import { LibraryView, type LibraryTab, type LibraryBrowseState } from './library-view';
import { BrowseView, type BrowseTab, type BrowseState } from './browse-view';
import { createPlayerContext } from './player-context';
import { PlayerBrowser } from './player-browser';
import { ChannelZapper } from './channel-zapper';
import channelZapperStyles from './channel-zapper.css';
import { TrailerActions } from './trailer-actions';
import trailerActionStyles from './trailer-actions.css';
import { startPauseScreen } from './pause-screen';
import type { MediaApi, Item } from './types';

// TV Item Layout uses the remote and local-playback patterns from
// jampez77/InPlayerEpisodePreview-TV and Namo2/InPlayerEpisodePreview (MIT).
window.TvItemLayout?.destroy();
const sheet=document.createElement('style');sheet.dataset.tvItemLayout='';sheet.textContent=styles+guideStyles+themeVideoStyles+collectionStyles+libraryStyles+nativeHostStyles+browseStyles+recordingsStyles+musicPlayerStyles+homeStyles+homeCollectionStyles+seasonalAppearanceStyles+seasonalEditorStyles+pauseStyles+playerStyles+profileMenuStyles+nativeFolderStyles+loginStyles+nativeUserPageStyles+channelZapperStyles+providerHomeStyles+providerSettingsStyles+trailerActionStyles+loadingAnimationStyles+loadingSettingsStyles+adminItemActionStyles;document.head.append(sheet);
let view:DetailView|GuideView|CollectionView|LibraryView|BrowseView|ProviderHomeView|ProviderSettingsEditor|LoadingSettingsEditor|HomeCollectionEditor|null=null;
let providerPreview:ProviderData|undefined;
let homeCollections:HomeCollections|null=null;
let homeSessionCurrent:(()=>boolean)|undefined;
let activeKey='';let openedHash='';let dismissed='';let previousFocus:HTMLElement|null=null;
let timer:number|undefined;
let disposed=false;
let accountScope:string|null|undefined;
const nativeHostMask=new NativeHostMask();
const nativeRecordingsTheme=new NativeRecordingsTheme();
const profileMenu=new ProfileMenu();
const desktopPlayer=new DesktopPlayer();
const nativeFolderTheme=new NativeFolderTheme();
const nativeLoginTheme=new NativeLoginTheme();
const nativeUserPages=new NativeUserPages();
const interfaceBranding=new InterfaceBranding();
const returnFocus=new Map<string,string>();
let pendingHash='';let probeRevision=0;
const libraryStates=new Map<string,LibraryBrowseState>();
const browseStates=new Map<string,BrowseState>();
const providerStates=new Map<string,ProviderHomeState>();
const recordingOrigins=new Set<string>();
const movieCollectionOrigins=new Map<string,string>();
const detailOrigins=new Set<string>();
const providerHistoryKey='jellyfinCinemaProviderVisit';
type ProviderVisit={version:1;scope:string;provider:ProviderId;home:string};
let pendingProviderVisit:(ProviderVisit&{hash:string})|undefined;
// Classification only: item data and access are still fetched for each view.
const verifiedLibraries=new Map<string,'collections'|'recordings'|'playlists'>();
let stopThemeVideo: (() => void) | undefined;
const nativePages='.itemDetailPage, #itemDetailPage, .liveTvPage, #liveTvSuggestedPage, .mainAnimatedPage, #boxsetsPage, #moviesPage, #tvRecommendedPage, #indexPage, #musicRecommendedPage';
type CollectionRoute = {kind:'collections';parentId?:string;scope:'list'|'boxsets'|'movies';verifyParent?:boolean};
type BrowseRoute = ({kind:'home'}|{kind:'music'}|{kind:'recordings'}) & {parentId?:string;tab?:BrowseTab;scope?:'list'|'livetv'|'playlists'};
type Route = {kind:'collection-settings';scope?:'user'|'global';targetUserId?:string}|{kind:'loading-settings';scope?:'user'|'global';targetUserId?:string}|{kind:'detail';id:string}|{kind:'guide'}|{kind:'provider';provider:ProviderId;rowId?:string}|{kind:'provider-settings';providerId?:ProviderId;scope?:'user'|'global';targetUserId?:string}|{kind:'movies';parentId?:string;tab:LibraryTab}|{kind:'shows';parentId?:string;tab:LibraryTab}|CollectionRoute|BrowseRoute;
function close(restore=true,destroyHome=false):void{
  // Jellyfin keeps its native Home mounted during detail/playback navigation.
  // Keep our rows alongside it so Back can reuse their artwork and controls.
  if(destroyHome){homeCollections?.destroy();homeCollections=null;homeSessionCurrent=undefined;}
  else homeCollections?.suspend();
  providerPreview?.destroy();providerPreview=undefined;
  stopThemeVideo?.();stopThemeVideo=undefined;
  view?.destroy();view=null;activeKey='';openedHash='';
  nativeHostMask.clear();
  if(document.body.classList.contains('tvl-open'))document.body.classList.remove('tvl-open');
  if(document.body.classList.contains('tvl-home'))document.body.classList.remove('tvl-home');
  if(restore&&previousFocus?.isConnected&&!previousFocus.closest('#homeTab'))previousFocus.focus({preventScroll:true});
}
function parseRouteInfo():{path:string;params:URLSearchParams}{
  const cleanHash=location.hash.replace(/^#[!/]*/,'');
  const [hashPath,hashQuery='']=cleanHash.split('?');
  const params=new URLSearchParams(hashQuery);
  let path=hashPath.replace(/^\/+|\/+$/g,'');
  if(!path&&location.pathname){
    const segments=location.pathname.split('/').filter(Boolean);
    const last=(segments[segments.length-1]||'').toLowerCase();
    if(/^(?:details|item|items|itemdetailpage|home|movies|tv|music|livetv|boxsets|list)$/i.test(last)){
      path=last;
      new URLSearchParams(location.search).forEach((v,k)=>{if(!params.has(k))params.set(k,v);});
    }
  }
  return {path,params};
}
function currentRoute():Route|null{
  const {path,params}=parseRouteInfo();
  if(/^mypreferencesmenu\/?$/i.test(path)&&params.get('cinemaCollections')==='1'
    &&onlyParams(params,['cinemaCollections','serverId','cinemaGlobal','targetUserId'])&&isDesktopLayout())
    return {kind:'collection-settings',scope:params.get('cinemaGlobal')==='1'?'global':'user',targetUserId:params.get('targetUserId')||undefined};
  if(/^mypreferencesmenu\/?$/i.test(path)&&params.get('cinemaLoading')==='1'
    &&onlyParams(params,['cinemaLoading','serverId','cinemaGlobal','targetUserId']))
    return {kind:'loading-settings',scope:params.get('cinemaGlobal')==='1'?'global':'user',targetUserId:params.get('targetUserId')||undefined};
  if(/^mypreferencesmenu\/?$/i.test(path)&&params.get('cinemaProviders')==='1'
    &&onlyParams(params,['cinemaProviders','cinemaService','serverId','cinemaGlobal','targetUserId'])
    &&(!params.has('cinemaService')||validProviderId(params.get('cinemaService'))))
    return {kind:'provider-settings',providerId:params.get('cinemaService')||undefined,scope:params.get('cinemaGlobal')==='1'?'global':'user',targetUserId:params.get('targetUserId')||undefined};
  if(/^home\/?$/i.test(path)){
    const provider=params.get('cinemaProvider');
    if(provider&&validProviderId(provider)&&onlyParams(params,['serverId','cinemaProvider','cinemaRow']))
      return {kind:'provider',provider:provider as ProviderId,rowId:params.get('cinemaRow')||undefined};
    // Home/Favourites switch native controllers without changing the URL.
    // Both retain their native tabs, focus handling and content ownership.
    if(!onlyParams(params,['serverId','tab'])||(params.has('tab')&&!['0','1'].includes(params.get('tab')!)))return null;
    return {kind:'home'};
  }
  if(/^music\/?$/i.test(path)){
    if(!onlyParams(params,['topParentId','serverId','collectionType','tab']))return null;
    const tabs:Record<string,BrowseTab>={'0':'albums','1':'suggestions','2':'albumArtists','3':'artists','4':'playlists','5':'songs','6':'genres'};
    const tab=tabs[params.get('tab')||'0'];
    return tab?{kind:'music',parentId:params.get('topParentId')||undefined,tab}:null;
  }
  if(/^playlists\/?$/i.test(path)){
    // Modern Jellyfin's standalone playlist library has its own route. Its
    // Favourites tab remains native rather than showing an unfiltered list.
    if(!onlyParams(params,['topParentId','serverId','collectionType','tab'])
      ||params.has('collectionType')&&params.get('collectionType')!=='playlists'
      ||params.has('tab')&&params.get('tab')!=='0')return null;
    return {kind:'music',tab:'playlists',scope:'playlists'};
  }
  if(/^livetv\/?$/i.test(path)){
    if(!onlyParams(params,['topParentId','serverId','collectionType','tab']))return null;
    const tab=params.get('tab')||'0';
    if(tab==='3')return {kind:'recordings',scope:'livetv'};
    return tab==='0'||tab==='1'?{kind:'guide'}:null;
  }
  if(/^boxsets\/?$/i.test(path)){
    if(!onlyParams(params,['topParentId','serverId','collectionType','tab'])||(params.has('tab')&&params.get('tab')!=='0'))return null;
    return {kind:'collections',scope:'boxsets',parentId:params.get('topParentId')||undefined};
  }
  if(/^list\/?$/i.test(path)){
    // Do not replace a filtered search or an unrelated generic library list.
    const supported=['parentId','serverId','collectionType','type'];
    if(!onlyParams(params,supported))return null;
    if(params.get('type')==='Recordings')return {kind:'recordings',scope:'list',parentId:params.get('parentId')||undefined};
    if(params.get('type')&&params.get('type')!=='BoxSet')return null;
    const parentId=params.get('parentId')||undefined;
    if(params.get('type')==='BoxSet')return {kind:'collections',scope:'list',parentId};
    if(parentId)return {kind:'collections',scope:'list',parentId,verifyParent:true};
  }
  if(/^movies\/?$/i.test(path)){
    if(!onlyParams(params,['topParentId','serverId','collectionType','tab']))return null;
    const parentId=params.get('topParentId')||undefined;
    const tab=params.get('tab')||'1';
    if(tab==='3')return {kind:'collections',scope:'movies',parentId};
    const tabs:Record<string,LibraryTab>={'0':'all','1':'suggestions','2':'favorites','4':'genres','watchlist':'watchlist'};
    if(tabs[tab])return {kind:'movies',parentId,tab:tabs[tab]};
  }
  if(/^tv\/?$/i.test(path)){
    if(!onlyParams(params,['topParentId','serverId','collectionType','tab']))return null;
    const tabs:Record<string,LibraryTab>={'0':'all','1':'suggestions','3':'genres','watchlist':'watchlist'};
    const tab=tabs[params.get('tab')||'1'];
    if(tab)return {kind:'shows',parentId:params.get('topParentId')||undefined,tab};
  }
  const parts=path.split('/');
  const isDetail=/^(?:details|item|items|itemdetailpage)$/i.test(parts[0]);
  if(isDetail){
    const id=params.get('id')||params.get('itemId')||(parts.length>1&&parts[1]?parts[1]:undefined);
    if(id)return {kind:'detail',id};
  }
  const nativeDetail=document.querySelector<HTMLElement>('.itemDetailPage:not(.tvl-native-hidden):not(.hide):not([hidden]), #itemDetailPage:not(.tvl-native-hidden):not(.hide):not([hidden])');
  if(nativeDetail){
    const identity=nativeDetail.querySelector<HTMLElement>('[data-id], [data-itemid]');
    const id=identity?.dataset.id||identity?.dataset.itemid||nativeDetail.dataset.id||nativeDetail.dataset.itemid;
    if(id)return {kind:'detail',id};
  }
  return null;
}
function onlyParams(params:URLSearchParams,allowed:string[]):boolean{
  let supported=true;params.forEach((_value,key)=>{if(!allowed.includes(key))supported=false;});return supported;
}
function dismiss():void{dismissed=location.hash;close();}
function back():void{
  if(history.length>1)history.back();
  else location.hash='/home';
}
function nativeHistoryState():Record<string,unknown>{
  return history.state&&typeof history.state==='object'?history.state:{};
}
function providerVisit(api:MediaApi,provider:ProviderId):ProviderVisit|undefined{
  const visit=nativeHistoryState()[providerHistoryKey] as Partial<ProviderVisit>|undefined;
  if(!visit||visit.version!==1||visit.scope!==scopeOf(api)||visit.provider!==provider||typeof visit.home!=='string')return;
  const [path,query='']=visit.home.split('?');const params=new URLSearchParams(query);
  if(!/^#\/?home\/?$/i.test(path)||!onlyParams(params,['serverId','tab'])||params.has('tab')&&!['0','1'].includes(params.get('tab')!))return;
  return visit as ProviderVisit;
}
function markProviderVisit(api:MediaApi,provider:ProviderId,home:string):void{
  const visit:ProviderVisit={version:1,scope:scopeOf(api)!,provider,home};
  history.replaceState({...nativeHistoryState(),[providerHistoryKey]:visit},'',location.href);
}
function ensureProviderVisit(api:MediaApi,provider:ProviderId):void{
  // Chromium may deliver popstate synchronously while assigning the hash,
  // before the caller can attach state to the new entry.
  if(pendingProviderVisit?.hash===location.hash&&pendingProviderVisit.scope===scopeOf(api)&&pendingProviderVisit.provider===provider){
    markProviderVisit(api,provider,pendingProviderVisit.home);pendingProviderVisit=undefined;return;
  }
  if(providerVisit(api,provider))return;
  // Bookmarks and externally opened provider links need an in-app destination
  // for browser Back too. Seed it once, without emitting native route events:
  // Jellyfin already owns /home and should not rebuild it for our section tabs.
  const hash=location.hash;const params=new URLSearchParams();
  const serverId=new URLSearchParams(hash.split('?')[1]||'').get('serverId')||api.serverId;
  if(serverId)params.set('serverId',serverId);
  const home=`#/home${params.toString()?`?${params}`:''}`;
  const state={...nativeHistoryState()};delete state[providerHistoryKey];
  history.replaceState(state,'',home);
  const next={...state};
  // React Router stores its position and location key here. The replacement
  // keeps every native field; the newly inserted entry has its own position.
  if(typeof next.idx==='number')next.idx++;
  if(typeof next.key==='string')next.key=Math.random().toString(36).slice(2,10);
  history.pushState(next,'',hash);markProviderVisit(api,provider,home);
}
function hideNativeHost(route:Route):void{
  if(route.kind==='home')return;
  if(route.kind==='provider'||route.kind==='provider-settings'||route.kind==='loading-settings'||route.kind==='collection-settings'){
    nativeHostMask.setSelector(route.kind==='provider'?'#indexPage':'#myPreferencesMenuPage');return;
  }
  const selector=route.kind==='music'&&!route.scope?'#musicRecommendedPage':route.kind==='guide'||route.kind==='recordings'&&route.scope==='livetv'?'.liveTvPage, #liveTvSuggestedPage':route.kind==='detail'?'.itemDetailPage, #itemDetailPage':route.kind==='shows'?'#tvRecommendedPage':route.kind==='movies'||route.kind==='collections'&&route.scope==='movies'?'#moviesPage':route.kind==='collections'&&route.scope==='boxsets'?'#boxsetsPage':'.mainAnimatedPage, [data-role="page"].libraryPage';
  nativeHostMask.setSelector(selector);
}
function scopeOf(api:MediaApi|null):string|null{
  return api?JSON.stringify([api.serverId||'',api.userId||'']):null;
}
function updateAccount(api:MediaApi|null):void{
  const scope=scopeOf(api);
  if(accountScope===scope)return;
  // Dispose first: views save their final state during destruction. Clear that
  // outgoing account's state afterwards, before mounting any new account view.
  probeRevision++;pendingHash='';close(false,true);accountScope=scope;dismissed='';previousFocus=null;
  clearHomeSession();
  returnFocus.clear();libraryStates.clear();browseStates.clear();providerStates.clear();
  recordingOrigins.clear();movieCollectionOrigins.clear();detailOrigins.clear();verifiedLibraries.clear();
  pendingProviderVisit=undefined;
}
function refresh():void{
  if(disposed)return;
  const api=getPlayerApi();
  updateAccount(api);
  const cinema=isCinemaLayout();
  interfaceBranding.update(api,cinema);
  if(document.body.classList.contains('tvl-layout')!==cinema)document.body.classList.toggle('tvl-layout',cinema);
  nativeRecordingsTheme.update(cinema && !!api);
  profileMenu.update(cinema && !!api, scopeOf(api));
  nativeFolderTheme.update(cinema && !!api, scopeOf(api));
  nativeLoginTheme.update(cinema);
  nativeUserPages.update(cinema && !!api, scopeOf(api));
  const route=currentRoute();
  if(pendingHash && pendingHash!==location.hash){pendingHash='';probeRevision++;}
  if(!cinema||!route){
    dismissed='';pendingHash='';probeRevision++;
    if(view instanceof HomeCollectionEditor && cinema && /^#\/?mypreferencesmenu\/?(?:\?|$)/i.test(location.hash)) nativeUserPages.restoreCollectionsFocus();
    if(view instanceof HomeCollectionEditor && !isDesktopLayout() && /^#\/?mypreferencesmenu\/?(?:\?|$)/i.test(location.hash)){
      const params=new URLSearchParams(location.hash.split('?')[1]||'');params.delete('cinemaCollections');
      history.replaceState(history.state,'',`#/mypreferencesmenu${params.toString()?`?${params}`:''}`);
    }
    // Authentication routes can appear before Jellyfin clears its old client.
    const authentication=/^#\/?(?:login|selectserver)\/?(?:\?|$)/i.test(location.hash);
    close(false,!cinema||!api||authentication);return;
  }
  if(dismissed===location.hash && route.kind!=='detail')return;
  if(!api){close(false,true);return;}
  const scope=scopeOf(api);
  const key=`${scope}:${route.kind}:${location.hash}`;
  if(activeKey===key&&(view||route.kind==='home')){
    if(view)hideNativeHost(route);
    // Native Home stays mounted across refreshes. Reassert our route marker if
    // a native/extension class update replaced it, without rebuilding rows or
    // disturbing the native page's focus and handlers.
    else if(!document.body.classList.contains('tvl-home'))document.body.classList.add('tvl-home');
    return;
  }
  if(route.kind==='collections'&&route.verifyParent){
    const verified=verifiedLibraries.get(route.parentId!);
    if(verified){
      openRoute(verified==='playlists'?{kind:'music',tab:'playlists',scope:'list'}:verified==='recordings'?{kind:'recordings',scope:'list',parentId:route.parentId}:route,api,key);return;
    }
    if(pendingHash===location.hash)return;
    close(false);
    const hash=location.hash;pendingHash=hash;const revision=++probeRevision;
    void api.getItem(route.parentId!).then(async parent=>{
      if(revision!==probeRevision||location.hash!==hash||scopeOf(getPlayerApi())!==scope)return;
      if(parent.CollectionType==='boxsets'){
        pendingHash='';rememberLibrary(parent.Id,'collections');openRoute(route,api,key);return;
      }
      if(parent.CollectionType==='playlists'){
        // The virtual library is a navigation root, not a music album parent.
        // Match native Jellyfin's account-wide playlist query.
        pendingHash='';rememberLibrary(parent.Id,'playlists');openRoute({kind:'music',tab:'playlists',scope:'list'},api,key);return;
      }
      // DVR recognition can be unavailable to a library-only account. The
      // ordinary native folder still gets styling without gaining DVR access.
      let recordingFolder=false;
      try { recordingFolder=!!await api.isRecordingFolder?.(parent.Id); } catch { /* Retain the native folder. */ }
      if(revision!==probeRevision||location.hash!==hash||scopeOf(getPlayerApi())!==scope)return;
      pendingHash='';
      if(recordingFolder){rememberLibrary(parent.Id,'recordings');openRoute({kind:'recordings',scope:'list',parentId:parent.Id},api,key);}
      else {
        if(parent.IsFolder || ['Folder','CollectionFolder','UserView'].includes(parent.Type || '')) nativeFolderTheme.show(parent.Id,parent.Name);
        dismissed=hash;
      }
    }).catch(()=>{if(revision===probeRevision){pendingHash='';dismissed=hash;}});
    return;
  }
  openRoute(route,api,key);
}
function rememberLibrary(id:string,kind:'collections'|'recordings'|'playlists'):void{
  verifiedLibraries.set(id,kind);
  if(verifiedLibraries.size>100)verifiedLibraries.delete(verifiedLibraries.keys().next().value!);
}
function rememberFocus(id=(document.activeElement as HTMLElement)?.dataset.focusId):void{
  if(id)returnFocus.set(location.hash,id);
  if(returnFocus.size>100)returnFocus.delete(returnFocus.keys().next().value!);
}
function navigate(next:string,activeServerId?:string,fromRecording=false):void{
  rememberFocus();
  const params=new URLSearchParams({id:next});
  const serverId=new URLSearchParams(location.hash.split('?')[1]||'').get('serverId')||activeServerId;
  if(serverId)params.set('serverId',serverId);
  detailOrigins.add(`#/details?${params}`);
  if(fromRecording)recordingOrigins.add(`#/details?${params}`);
  else recordingOrigins.delete(`#/details?${params}`);
  if(recordingOrigins.size>100)recordingOrigins.delete(recordingOrigins.values().next().value!);
  if(detailOrigins.size>100)detailOrigins.delete(detailOrigins.values().next().value!);
  location.hash=`/details?${params}`;
}
function collectionBack(route:CollectionRoute):void{
  if(route.scope==='movies'){
    if(movieCollectionOrigins.has(location.hash)){back();return;}
    const params=new URLSearchParams(location.hash.split('?')[1]||'');params.set('tab','0');
    history.replaceState(null,'',`#/movies?${params}`);schedule();return;
  }
  back();
}
function openRoute(route:Route,api:MediaApi,key:string):void{
  close(false);activeKey=key;openedHash=location.hash;previousFocus=document.activeElement as HTMLElement;
  const focusId=returnFocus.get(location.hash);returnFocus.delete(location.hash);
  const openProvider=(provider:ProviderId,rowId?:string)=>{
    const params=new URLSearchParams({cinemaProvider:provider});
    if(rowId)params.set('cinemaRow',rowId);
    const serverId=new URLSearchParams(location.hash.split('?')[1]||'').get('serverId')||api.serverId;
    if(serverId)params.set('serverId',serverId);
    const hash=`#/home?${params}`;if(hash===location.hash)return;
    rememberFocus();
    if(route.kind==='provider'){
      // A provider's tabs share one history entry. Keep Jellyfin's history
      // state intact and only refresh our overlay, not the native Home route.
      history.replaceState(history.state,'',hash);refreshNavigation();
    }else{
      const home=location.hash;
      pendingProviderVisit={version:1,scope:scopeOf(api)!,provider,home,hash};
      location.hash=hash;markProviderVisit(api,provider,home);pendingProviderVisit=undefined;
    }
  };
  if(route.kind==='home'){
    // Keep Jellyfin's Home in place. Its controllers own user/device settings,
    // section order, hidden libraries, focus and Featured's carousel lifecycle.
    // Styling alone also works when the native page arrives after this route.
    document.body.classList.add('tvl-home');
    // A reconnect can replace ApiClient without changing the account IDs.
    // Never resume an adapter whose authenticated transport is no longer live.
    if(homeCollections&&homeSessionCurrent&&!homeSessionCurrent()){
      homeCollections.destroy();homeCollections=null;homeSessionCurrent=undefined;
    }
    if(homeCollections)homeCollections.resume();
    else{
      homeSessionCurrent=()=> (!api.homeCollections||api.homeCollections.isCurrent())&&(!api.providerHomes||api.providerHomes.isCurrent());
      homeCollections=new HomeCollections(api,id=>navigate(id,api.serverId),focusId,openProvider);
    }
    return;
  }
  hideNativeHost(route);
  document.body.classList.add('tvl-open');
  const go=(id:string)=>navigate(id,api.serverId,route.kind==='recordings');
  const openNative=(item:Item)=>{
    const params=new URLSearchParams({id:item.Id});
    const serverId=new URLSearchParams(location.hash.split('?')[1]||'').get('serverId')||api.serverId;
    if(serverId)params.set('serverId',serverId);
    const target=`#/details?${params}`;dismissed=target;close(false);
    if(location.hash!==target)location.hash=target;
  };
  const navigateRoute=(hash:string)=>{
    rememberFocus();
    const [path,query='']=hash.replace(/^#/,'').split('?');
    const params=new URLSearchParams(query);
    const serverId=new URLSearchParams(location.hash.split('?')[1]||'').get('serverId')||api.serverId;
    if(serverId&&!params.has('serverId'))params.set('serverId',serverId);
    location.hash=path+(params.toString()?`?${params}`:'');
  };
  if(route.kind==='provider'){
    ensureProviderVisit(api,route.provider);
    const hash=location.hash;
    view=new ProviderHomeView(api,{provider:route.provider,rowId:route.rowId,focusId,back,navigate:go,
      edit:document.body.classList.contains('layout-desktop')?()=>navigateRoute(`#/mypreferencesmenu?cinemaProviders=1&cinemaService=${encodeURIComponent(route.provider)}`):undefined,
      openRow:id=>openProvider(route.provider,id),state:providerStates.get(hash),onState:state=>{
      providerStates.set(hash,state);if(providerStates.size>100)providerStates.delete(providerStates.keys().next().value!);
    }});
  }
  else if(route.kind==='provider-settings'){
    const data=new ProviderData(api);providerPreview=data;
    view=new ProviderSettingsEditor(api,{onBack:back,providerId:route.providerId,scope:route.scope,targetUserId:route.targetUserId,loadPreview:async(provider,row)=>(await data.load(provider,row,0,8,true)).items});
  }
  else if(route.kind==='loading-settings')view=new LoadingSettingsEditor(api,{onBack:back,scope:route.scope,targetUserId:route.targetUserId});
  else if(route.kind==='collection-settings'){
    const fromSettings=!!previousFocus?.matches('.tvl-settings-collections-link');
    view=new HomeCollectionEditor(api,restore=>{
      if(!restore)return;
      nativeUserPages.restoreCollectionsFocus();
      if(fromSettings){back();return;}
      // A bookmarked editor still closes into Settings, without leaving an
      // editor entry for Back to reopen after Save or Cancel.
      const params=new URLSearchParams();
      const serverId=new URLSearchParams(location.hash.split('?')[1]||'').get('serverId')||api.serverId;
      if(serverId)params.set('serverId',serverId);
      history.replaceState(history.state,'',`#/mypreferencesmenu${params.toString()?`?${params}`:''}`);refreshNavigation();
    },route.scope,route.targetUserId);
  }
  else if(route.kind==='guide')view=new GuideView(api,{back});
  else if(route.kind==='collections')view=new CollectionView(api,{openNative,parentId:route.parentId,back:()=>collectionBack(route),navigate:go,focusId});
  else if(route.kind==='movies'||route.kind==='shows'){
    const hash=location.hash;
    view=new LibraryView(api,{kind:route.kind,parentId:route.parentId,initialTab:route.tab,back,navigate:go,focusId,state:libraryStates.get(hash),onState:state=>{
      libraryStates.set(hash,state);
      if(libraryStates.size>100)libraryStates.delete(libraryStates.keys().next().value!);
    },openCollections:()=>{
      rememberFocus('collections');
      const params=new URLSearchParams(hash.split('?')[1]||'');
      if(route.kind==='shows'){
        const collections=new URLSearchParams();
        if(route.parentId)collections.set('parentId',route.parentId);
        collections.set('type','BoxSet');
        const serverId=params.get('serverId')||api.serverId;
        if(serverId)collections.set('serverId',serverId);
        location.hash=`/list?${collections}`;return;
      }
      params.set('tab','3');
      const target=`#/movies?${params}`;movieCollectionOrigins.set(target,hash);
      if(movieCollectionOrigins.size>100)movieCollectionOrigins.delete(movieCollectionOrigins.keys().next().value!);
      location.hash=target;
    }});
  }
  else if(route.kind==='music'||route.kind==='recordings'){
    const hash=location.hash;
    view=new BrowseView(api,{openNative,...route,back,navigate:go,navigateRoute,focusId,state:browseStates.get(hash),onState:state=>{
      browseStates.set(hash,state);
      if(browseStates.size>100)browseStates.delete(browseStates.keys().next().value!);
    }});
  }
  else {
    const openCollection=(item:Item)=>{
      stopThemeVideo?.();stopThemeVideo=undefined;view?.destroy();
      view=new CollectionView(api,{openNative,item,back,navigate:go,focusId});
      document.body.append(view.element);void view.load();
    };
    const openAdditional=(item:Item):boolean=>{
      const kind=['MusicAlbum','MusicArtist','Audio','Playlist'].includes(item.Type||'')?'music'
        :recordingOrigins.has(location.hash)||['Video','Recording'].includes(item.Type||'')||item.Type==='Episode'&&!item.SeriesId?'recordings':null;
      if(!kind)return false;
      stopThemeVideo?.();stopThemeVideo=undefined;view?.destroy();
      const hash=location.hash;
      view=new BrowseView(api,{openNative,kind,item,back,navigate:go,navigateRoute,focusId,state:browseStates.get(hash),onState:state=>{
        browseStates.set(hash,state);
        if(browseStates.size>100)browseStates.delete(browseStates.keys().next().value!);
      }});
      document.body.append(view.element);void view.load();return true;
    };
    view=new DetailView(api,{openNative,id:route.id,close:dismiss,back:()=>{if(window.TvItemLayoutDemo&&!detailOrigins.has(location.hash))dismiss();else back();},focusId,navigate:go,openCollection,openAdditional,openGuide:()=>{
      rememberFocus('guide');
      const params=new URLSearchParams({collectionType:'livetv'});
      const serverId=new URLSearchParams(location.hash.split('?')[1]||'').get('serverId')||api.serverId;
      if(serverId)params.set('serverId',serverId);
      location.hash=`/livetv?${params}`;
    }});
  }
  document.body.append(view.element);
  if(route.kind==='detail')stopThemeVideo=observeThemeVideo(view.element);
  void view.load();
}
const schedule=()=>{if(disposed)return;window.clearTimeout(timer);timer=window.setTimeout(refresh,30);};
// Route events must take ownership in the same task, before a restored native
// page can paint. Debounce only noisy mutation notifications.
const refreshNavigation=()=>{
  window.clearTimeout(timer);
  if(/^#!?\/(?:details|item)/i.test(location.hash)){
    const clean='#/'+location.hash.replace(/^#[!/]*/,'');
    if(location.hash!==clean)history.replaceState(history.state,'',clean);
  }
  refresh();
};
// Native cached pages rotate DOM slots, so DOM order cannot identify the owner.
// A hide event on the overlay's current route belongs to an outgoing native
// transition. Release the overlay once navigation has actually left its route.
const hide=(event:Event)=>{if(location.hash!==openedHash&&nativeHostMask.owns(event.target))refreshNavigation();};
const show=(event:Event)=>{
  const target=event.target as HTMLElement;
  if(target.matches?.(nativePages)||target.matches?.('.itemDetailPage, #itemDetailPage')||target.querySelector?.('.itemDetailPage, #itemDetailPage')){
    if(isCinemaLayout()&&(target.matches?.('.itemDetailPage, #itemDetailPage')||target.querySelector?.('.itemDetailPage, #itemDetailPage'))){
      target.classList.add('tvl-native-hidden');
      target.setAttribute('aria-hidden','true');
    }
    refreshNavigation();
    if(document.body.classList.contains('tvl-home'))void homeCollections?.refreshSettings();
  }
};
const hashChanged=(event:HashChangeEvent)=>{
  if(dismissed!==location.hash)dismissed='';
  // The offline preview also has native Home/Featured links. Distinguish those
  // entries from a direct detail preview, whose Back dismisses the demo overlay.
  if(window.TvItemLayoutDemo&&/^#[!]?\/home(?:\?|$)/.test(new URL(event.oldURL,location.href).hash)&&/^#[!]?\/details(?:\?|$)/.test(location.hash)){
    detailOrigins.add(location.hash);
    if(detailOrigins.size>100)detailOrigins.delete(detailOrigins.values().next().value!);
  }
  if(/^#!?\/(?:details|item)/i.test(location.hash)){
    const clean='#/'+location.hash.replace(/^#[!/]*/,'');
    if(location.hash!==clean)history.replaceState(history.state,'',clean);
  }
  refreshNavigation();
};
let longPressActive=false;
let longPressTimer:number|undefined;
let pointerDownTimestamp=0;
let pointerStartX=0;
let pointerStartY=0;
const onPointerDown=(event:PointerEvent|MouseEvent)=>{
  if(event.button!==0)return;
  window.clearTimeout(longPressTimer);
  longPressActive=false;
  pointerDownTimestamp=Date.now();
  pointerStartX=(event as MouseEvent).clientX||0;
  pointerStartY=(event as MouseEvent).clientY||0;
  const target=event.target as HTMLElement|null;
  const card=target?.closest<HTMLElement>('.card[data-id], .card[data-itemid], [data-action="link"]');
  if(card){
    longPressTimer=window.setTimeout(()=>{longPressActive=true;},350);
  }
};
const onPointerMove=(event:PointerEvent|MouseEvent)=>{
  if(!pointerDownTimestamp)return;
  const deltaX=Math.abs(((event as MouseEvent).clientX||0)-pointerStartX);
  const deltaY=Math.abs(((event as MouseEvent).clientY||0)-pointerStartY);
  if(deltaX>=10||deltaY>=10){
    window.clearTimeout(longPressTimer);
    longPressActive=false;
    pointerDownTimestamp=0;
  }
};
const onPointerUp=()=>{
  window.clearTimeout(longPressTimer);
  const wasLong=longPressActive||(pointerDownTimestamp>0&&Date.now()-pointerDownTimestamp>=350);
  if(wasLong){
    longPressActive=true;
    window.setTimeout(()=>{longPressActive=false;pointerDownTimestamp=0;},400);
  }else{
    longPressActive=false;
    pointerDownTimestamp=0;
  }
};
const onPointerCancel=()=>{
  window.clearTimeout(longPressTimer);
  longPressActive=false;
  pointerDownTimestamp=0;
};
const isMultiSelectActive=(target?:HTMLElement|null):boolean=>{
  if(document.querySelector('.selectionCommandsPanel, .itemSelectionPanel, .withMultiSelect, .chkItemSelect, [data-multiselect="true"]'))return true;
  if(target){
    if(target.closest('.itemSelectionPanel, .selectionCommandsPanel, .chkItemSelect, .checkboxContainer, .multiSelectCheckboxOutline, .withMultiSelect, [data-multiselect="true"]'))return true;
    const card=target.closest<HTMLElement>('.card');
    if(card){
      if(card.querySelector('.itemSelectionPanel, .chkItemSelect, .withMultiSelect'))return true;
      if(card.classList.contains('withMultiSelect')||card.classList.contains('selected')||card.classList.contains('itemSelection-selected'))return true;
      if(card.getAttribute('aria-selected')==='true')return true;
    }
    const container=target.closest<HTMLElement>('.itemsContainer, [data-multiselect]');
    if(container&&(container.dataset.multiselect==='true'||container.getAttribute('data-multiselect')==='true'||container.classList.contains('withMultiSelect')))return true;
  }
  return false;
};
const isCardActionControl=(target:HTMLElement|null):HTMLElement|null=>{
  if(!target)return null;
  return target.closest<HTMLElement>(
    'button:not(.card):not(.tvl-home-row-card):not(.tvl-library-card):not(.tvl-collection-card):not(.tvl-browse-card), '+
    '[role="button"]:not(.card):not(.tvl-home-row-card):not(.tvl-library-card):not(.tvl-collection-card):not(.tvl-browse-card), '+
    '.cardOverlayButton, .cardOverlayFab, .cardOverlayContainer, '+
    '.itemAction:not(.card), [data-action]:not([data-action="link"]), '+
    '.btnPlay, .btnUserData, .btnUserRating, .btnCardOptions, .btnPlaystate, .btnMoreCommands, '+
    '.itemSelectionPanel, .chkItemSelect, .checkboxContainer, .multiSelectCheckboxOutline, '+
    '.selectionCommandsPanel, .btnCloseSelectionPanel, .btnSelectionPanelOptions, '+
    '.tvl-admin-item, [data-admin-item]'
  );
};
const interceptClicks=(event:MouseEvent)=>{
  if(!isCinemaLayout())return;
  if(longPressActive||isMultiSelectActive(event.target as HTMLElement|null))return;
  const target=event.target as HTMLElement|null;
  if(!target||target.closest('#tv-layout, .tvl-root'))return;
  if(isCardActionControl(target))return;
  const anchor=target.closest<HTMLAnchorElement>('a[href]');
  if(anchor){
    if(isCardActionControl(target))return;
    const href=anchor.getAttribute('href')||'';
    const match=href.match(/#[!]?\/(?:details|item|items|itemdetailpage)(?:[\/?]([^\s]+))?/i);
    if(match){
      const queryStr=match[1]||'';
      const params=new URLSearchParams(queryStr.startsWith('?')?queryStr.slice(1):queryStr);
      const id=params.get('id')||params.get('itemId')||(match[1]&&!match[1].startsWith('?')?match[1]:null);
      if(id){
        event.preventDefault();
        event.stopPropagation();
        navigate(id);
        return;
      }
    }
  }
  const card=target.closest<HTMLElement>('.card[data-id], .card[data-itemid], [data-action="link"][data-id], [data-action="link"][data-itemid]');
  if(card){
    if(isCardActionControl(target))return;
    const id=card.dataset.id||card.dataset.itemid;
    const type=card.dataset.type;
    if(id&&(!type||['Movie','Series','Episode','Season','TvChannel','Program','BoxSet'].includes(type))){
      event.preventDefault();
      event.stopPropagation();
      navigate(id);
      return;
    }
  }
};
const nativeDetailObserver=new MutationObserver(mutations=>{
  if(!isCinemaLayout())return;
  for(const mutation of mutations){
    for(const node of Array.from(mutation.addedNodes)){
      if(node instanceof HTMLElement){
        if(node.matches?.('.itemDetailPage, #itemDetailPage')||node.querySelector?.('.itemDetailPage, #itemDetailPage')){
          const detail=node.matches?.('.itemDetailPage, #itemDetailPage')?node:node.querySelector<HTMLElement>('.itemDetailPage, #itemDetailPage')!;
          detail.classList.add('tvl-native-hidden');
          detail.setAttribute('aria-hidden','true');
          refreshNavigation();
          return;
        }
      }
    }
    if(mutation.target instanceof HTMLElement){
      if(mutation.target.matches?.('.itemDetailPage:not(.tvl-native-hidden):not(.hide):not([hidden]), #itemDetailPage:not(.tvl-native-hidden):not(.hide):not([hidden])')){
        mutation.target.classList.add('tvl-native-hidden');
        mutation.target.setAttribute('aria-hidden','true');
        refreshNavigation();
        return;
      }
    }
  }
});
nativeDetailObserver.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class','style','hidden']});
const pointerDownEvent=typeof window!=='undefined'&&'PointerEvent' in window?'pointerdown':'mousedown';
const pointerUpEvent=typeof window!=='undefined'&&'PointerEvent' in window?'pointerup':'mouseup';
const pointerCancelEvent=typeof window!=='undefined'&&'PointerEvent' in window?'pointercancel':'mouseleave';
const pointerMoveEvent=typeof window!=='undefined'&&'PointerEvent' in window?'pointermove':'mousemove';
document.addEventListener(pointerDownEvent,onPointerDown,true);
document.addEventListener(pointerMoveEvent,onPointerMove,true);
window.addEventListener(pointerUpEvent,onPointerUp,true);
window.addEventListener(pointerCancelEvent,onPointerCancel,true);
window.addEventListener('hashchange',hashChanged);window.addEventListener('popstate',refreshNavigation);
document.addEventListener('viewshow',show,true);
document.addEventListener('pageshow',show,true);
document.addEventListener('viewbeforeshow',show,true);
document.addEventListener('pagebeforeshow',show,true);
document.addEventListener('viewbeforehide',hide,true);
document.addEventListener('tabchange',refreshNavigation,true);
document.addEventListener('click',interceptClicks,true);
const observer=new MutationObserver(schedule);
observer.observe(document.documentElement,{attributes:true,attributeFilter:['class']});
observer.observe(document.body,{attributes:true,attributeFilter:['class']});
const getPlayerApi=()=>window.TvItemLayoutDemo?.api||createJellyfinApi();
const playerContext=createPlayerContext(getPlayerApi);
const playerBrowser=new PlayerBrowser(playerContext,getPlayerApi);
const channelZapper=new ChannelZapper(playerContext,getPlayerApi);
const trailerActions=new TrailerActions(playerContext,getPlayerApi);
const stopPauseScreen=startPauseScreen({getApi:getPlayerApi,getPlayback:playerContext.getSnapshot,subscribe:playerContext.subscribe});
// Jellyfin's account events live on its private module event bus. Poll only
// identity so sign-out/server switches also clear non-player pages promptly.
const scopeTimer=window.setInterval(()=>{
  const api=getPlayerApi();
  if(scopeOf(api)!==accountScope)refresh();
  else if(!api)interfaceBranding.update(null,isCinemaLayout());
},1000);
window.TvItemLayout={refresh,destroy(){disposed=true;probeRevision++;pendingHash='';stopPauseScreen();nativeRecordingsTheme.destroy();profileMenu.destroy();desktopPlayer.destroy();nativeFolderTheme.destroy();nativeLoginTheme.destroy();nativeUserPages.destroy();interfaceBranding.destroy();trailerActions.destroy();channelZapper.destroy();playerBrowser.destroy();playerContext.destroy();close(true,true);clearHomeSession();sheet.remove();observer.disconnect();nativeDetailObserver.disconnect();document.body.classList.remove('tvl-layout');window.clearTimeout(timer);window.clearTimeout(longPressTimer);window.clearInterval(scopeTimer);document.removeEventListener(pointerDownEvent,onPointerDown,true);document.removeEventListener(pointerMoveEvent,onPointerMove,true);window.removeEventListener(pointerUpEvent,onPointerUp,true);window.removeEventListener(pointerCancelEvent,onPointerCancel,true);window.removeEventListener('hashchange',hashChanged);window.removeEventListener('popstate',refreshNavigation);document.removeEventListener('viewshow',show,true);document.removeEventListener('pageshow',show,true);document.removeEventListener('viewbeforeshow',show,true);document.removeEventListener('pagebeforeshow',show,true);document.removeEventListener('viewbeforehide',hide,true);document.removeEventListener('tabchange',refreshNavigation,true);document.removeEventListener('click',interceptClicks,true);}};
refreshNavigation();
