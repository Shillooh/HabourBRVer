import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowseApi, type BrowseClient } from '../src/browse-api';
import type { Item } from '../src/types';

type Request={path:string;query:Record<string,string|number|boolean>};
const item=(Id:string,Type='MusicAlbum',extra:Partial<Item>={}):Item=>({Id,Name:Id,Type,...extra});
function setup(handler:(request:Request)=>unknown,overrides:Partial<BrowseClient>={}) {
  const requests:Request[]=[];
  const client:BrowseClient={
    getUrl:(path,query={})=>JSON.stringify({path,query}),
    getJSON:async url=>{const request=JSON.parse(url) as Request;requests.push(request);return handler(request);},
    getItems:async(user,query)=>{assert.equal(user,'user');const request={path:'Items',query};requests.push(request);return handler(request) as never;},
    ...overrides
  };
  return {api:createBrowseApi(client,'user',action=>action()),client,requests};
}

test('Music queries use native artists endpoints and scoped server filters',async()=>{
  const {api,requests}=setup(({path})=>({Items:[item('artist',path==='Items'?'MusicAlbum':'MusicArtist')],TotalRecordCount:1}));
  await api.getMusic({kind:'albumArtists',parentId:'music',search:'  Moss ',favorite:true,genreId:'ambient',letter:'m'});
  await api.getMusic({kind:'artists',parentId:'music',letter:'#'});
  assert.equal(requests[0].path,'Artists/AlbumArtists');assert.equal(requests[1].path,'Artists');
  assert.equal(requests[0].query.ParentId,'music');assert.equal(requests[0].query.UserId,'user');
  assert.equal(requests[0].query.SearchTerm,'Moss');assert.equal(requests[0].query.GenreIds,'ambient');
  assert.equal(requests[0].query.IsFavorite,true);assert.equal(requests[0].query.NameStartsWith,'M');
  assert.equal(requests[1].query.NameLessThan,'A');assert.ok(!('IncludeItemTypes' in requests[0].query));
});

test('Music album contents use disc/track order and artist albums use native contributing-artist filtering',async()=>{
  const {api,requests}=setup(({query})=>({Items:[item('one',String(query.IncludeItemTypes)),item('missing',String(query.IncludeItemTypes),{PlayAccess:'None'})],TotalRecordCount:20}));
  const tracks=await api.getMusic({kind:'songs',parentId:'music',albumId:'album',startIndex:10,limit:20});
  assert.deepEqual(tracks.items.map(i=>i.Id),['one']);assert.equal(tracks.nextStartIndex,12);assert.equal(tracks.total,20);
  assert.equal(requests[0].query.ParentId,'album');assert.equal(requests[0].query.SortBy,'ParentIndexNumber,IndexNumber,SortName');
  assert.equal(requests[0].query.IncludeItemTypes,'Audio');
  await api.getMusic({kind:'albums',parentId:'music',artistId:'artist'});
  assert.equal(requests[1].query.ContributingArtistIds,'artist');assert.equal(requests[1].query.ParentId,'music');
  assert.equal(requests[1].query.IncludeItemTypes,'MusicAlbum');
});

test('Music page bounds and malformed totals cannot produce false empty states',async()=>{
  const {api,requests}=setup(()=>({Items:[],TotalRecordCount:0}));
  await api.getMusic({kind:'albums',limit:1000,startIndex:-4});
  assert.equal(requests[0].query.Limit,100);assert.equal(requests[0].query.StartIndex,0);
  await assert.rejects(api.getMusic({kind:'songs',letter:'XX'}),/choose a letter/i);
  const broken=setup(()=>({Items:[],TotalRecordCount:1}));
  await assert.rejects(broken.api.getMusic({kind:'albums'}),/incomplete music page/i);
});

test('Music genres paginate and suggestions retain native latest/listening-history sources',async()=>{
  const {api,requests}=setup(({path,query})=>{
    if(path==='MusicGenres')return{Items:[item(query.StartIndex?'jazz':'ambient','Genre')],TotalRecordCount:2};
    if(path.endsWith('/Latest'))return[item('album'),item('song','Audio')];
    return{Items:[item(String(query.SortBy),'Audio')]};
  });
  assert.deepEqual((await api.getMusicGenres('music')).map(i=>i.Id),['ambient','jazz']);
  assert.ok(requests.filter(r=>r.path==='MusicGenres').every(r=>r.query.ParentId==='music'&&r.query.IncludeItemTypes==='MusicAlbum'));
  const sections=await api.getMusicSuggestions('music');
  assert.deepEqual(sections.map(s=>s.title),['Adicionados recentemente','Tocadas recentemente','Mais tocadas']);
  assert.deepEqual(sections[0].items.map(i=>i.Type),['MusicAlbum','Audio']);
  assert.ok(requests.filter(r=>r.path==='Items').every(r=>r.query.ParentId==='music'&&r.query.Filters==='IsPlayed'&&r.query.IncludeItemTypes==='Audio'));
});

test('Recording status uses native unbounded active IDs and never relies on the unsupported false filter',async()=>{
  const recordings=[item('episode','Episode'),item('video','Video'),item('live','Movie',{Status:'InProgress'})];
  const {api,requests}=setup(({query})=>query.IsInProgress===true
    ?{Items:[recordings[2]],TotalRecordCount:1}
    :{Items:recordings.slice(Number(query.StartIndex),Number(query.StartIndex)+Number(query.Limit)),TotalRecordCount:3});
  const active=await api.getRecordings({status:'active',limit:1});
  assert.deepEqual(active,{items:[{...recordings[2],IsInProgress:true}],total:1,nextStartIndex:1});
  assert.equal(requests[0].path,'LiveTv/Recordings');assert.equal(requests[0].query.IsInProgress,true);
  assert.equal(requests[0].query.UserId,'user');assert.equal(requests[0].query.StartIndex,0);assert.ok(!('Limit' in requests[0].query));
  const completed=await api.getRecordings({status:'completed',startIndex:1,limit:1});
  assert.deepEqual(completed,{items:[{...recordings[1],IsInProgress:false}],total:2,nextStartIndex:2});
  const all=await api.getRecordings({startIndex:1,limit:2});
  assert.deepEqual(all.items.map(i=>[i.Id,i.IsInProgress]),[['video',false],['live',true]]);
  assert.equal(all.nextStartIndex,3);assert.equal(all.total,3);
  assert.ok(requests.every(r=>r.path==='LiveTv/Recordings'&&r.query.IsInProgress!==false));
});

test('Recording libraries use configured DVR IDs and descendants, never a folder name',async()=>{
  const recordingId='79a2726d3c50e769a8af1e4184e4fccf';
  const {api,requests}=setup(({path})=>path==='LiveTv/Recordings/Folders'
    ? {Items:[item('79A2726D-3C50-E769-A8AF-1E4184E4FCCF','CollectionFolder',{Name:'Saved TV'})],TotalRecordCount:1}
    : path==='Items/recorded-series/Ancestors'?[item(recordingId,'CollectionFolder')]
    : [item('ordinary-library','CollectionFolder',{Name:'Recordings'})]);
  assert.equal(await api.isRecordingFolder!(recordingId),true);
  assert.equal(requests.length,1);
  assert.equal(await api.isRecordingFolder!('recorded-series'),true);
  assert.equal(await api.isRecordingFolder!('ordinary-library'),false);
  assert.ok(requests.every(request=>request.query.UserId==='user'));
  const noDvr=setup(()=>({Items:[],TotalRecordCount:0}));
  assert.equal(await noDvr.api.isRecordingFolder!('ordinary-library'),false);
  assert.equal(noDvr.requests.length,1);
  const invalid=setup(({path})=>path.endsWith('/Folders')?{Items:[item(recordingId)]}:{});
  await assert.rejects(invalid.api.isRecordingFolder!('child'),/invalid recording folder ancestry/i);
});

test('Recording library and subfolder pages query only their descendants, including active/completed filters',async()=>{
  const local=[item('saved','Episode'),item('active-local','Video')];
  const {api,requests}=setup(({path,query})=>path==='LiveTv/Recordings'
    ? {Items:[local[1],item('active-elsewhere','Video')],TotalRecordCount:2}
    : {Items:local.slice(Number(query.StartIndex),Number(query.StartIndex)+Number(query.Limit)),TotalRecordCount:2});
  const all=await api.getRecordings({parentId:'recorded-series'});
  assert.deepEqual(all.items.map(item=>[item.Id,item.IsInProgress]),[['saved',false],['active-local',true]]);
  const active=await api.getRecordings({parentId:'recorded-series',status:'active'});
  assert.deepEqual(active.items.map(item=>item.Id),['active-local']);assert.equal(active.total,1);
  const completed=await api.getRecordings({parentId:'recorded-series',status:'completed'});
  assert.deepEqual(completed.items.map(item=>item.Id),['saved']);assert.equal(completed.total,1);
  assert.ok(requests.filter(request=>request.path==='Items').every(request=>request.query.ParentId==='recorded-series'
    &&request.query.Recursive===true&&request.query.IncludeItemTypes==='Movie,Episode,Video'));
  assert.ok(requests.filter(request=>request.path==='LiveTv/Recordings').every(request=>request.query.IsInProgress===true));
});

test('An empty recording library stays empty even when another DVR folder has recordings',async()=>{
  const {api}=setup(({path})=>path==='Items'?{Items:[],TotalRecordCount:0}
    : {Items:[item('elsewhere','Video')],TotalRecordCount:1});
  for(const status of ['all','active','completed'] as const){
    assert.deepEqual(await api.getRecordings({parentId:'empty-recordings',status}),{items:[],total:0,nextStartIndex:0});
  }
});

test('Active recordings paginate locally when Jellyfin ignores Limit and return honest filtered totals',async()=>{
  const recordings=Array.from({length:60},(_,i)=>item(`active-${i}`,'Video',{Name:i%2?'Mountain':'Forest'}));
  const {api,requests}=setup(()=>({Items:recordings,TotalRecordCount:recordings.length}));
  const active=await api.getRecordings({status:'active',startIndex:48,limit:48});
  assert.equal(active.items.length,12);assert.equal(active.total,60);assert.equal(active.nextStartIndex,60);
  assert.equal(active.items[0].Id,'active-48');assert.equal(requests.length,1);assert.equal(requests[0].query.StartIndex,0);
  const searched=await api.getRecordings({status:'active',search:'mountain',startIndex:5,limit:3});
  assert.equal(searched.total,30);assert.equal(searched.nextStartIndex,8);assert.equal(searched.items[0].Id,'active-11');
  const incomplete=setup(()=>({Items:[item('one','Video')],TotalRecordCount:2}));
  await assert.rejects(incomplete.api.getRecordings({status:'active'}),/incomplete active recording/i);
});

test('Recording search traverses every server page instead of filtering only the visible page',async()=>{
  const {api,requests}=setup(({query})=>query.IsInProgress===true?{Items:[],TotalRecordCount:0}:{Items:[item(`recording-${query.StartIndex}`,'Recording',{Name:query.StartIndex===2?'Mountain trail':'Forest'})],TotalRecordCount:3});
  const result=await api.getRecordings({search:'mountain'});
  assert.equal(result.total,1);assert.equal(result.nextStartIndex,1);assert.equal(result.items[0].Id,'recording-2');
  assert.deepEqual(requests.filter(r=>r.query.IsInProgress!==true).map(r=>r.query.StartIndex),[0,1,2]);
  assert.ok(requests.every(r=>(r.query.IsInProgress===true||r.query.Limit===100)&&!('SearchTerm' in r.query)));
});

test('Recording search rejects repeated/incomplete reads without returning partial results',async()=>{
  const repeated=setup(({query})=>query.IsInProgress===true?{Items:[],TotalRecordCount:0}:{Items:[item('same','Recording')],TotalRecordCount:2});
  await assert.rejects(repeated.api.getRecordings({search:'same'}),/repeated a recording page/i);
  const partial=setup(({query})=>query.IsInProgress===true?{Items:[],TotalRecordCount:0}:query.StartIndex?{Items:[],TotalRecordCount:2}:{Items:[item('one','Recording')],TotalRecordCount:2});
  await assert.rejects(partial.api.getRecordings({search:'one'}),/incomplete recording page/i);
});

test('All browse reads use the caller session guard and reject failed sources',async()=>{
  let signedIn=true;
  const {client}=setup(()=>({Items:[],TotalRecordCount:0}));
  const api=createBrowseApi(client,'user',async action=>{if(!signedIn)throw new Error('Account changed');const value=await action();if(!signedIn)throw new Error('Account changed');return value;});
  signedIn=false;
  await assert.rejects(api.getMusic({kind:'albums'}),/Account changed/);
  await assert.rejects(api.getMusicGenres(),/Account changed/);
  await assert.rejects(api.getMusicSuggestions(),/Account changed/);
  await assert.rejects(api.getRecordings(),/Account changed/);
  await assert.rejects(api.isRecordingFolder!('recordings'),/Account changed/);
  const invalid=setup(()=>null);await assert.rejects(invalid.api.getMusic({kind:'albums'}),/invalid music/i);
});
