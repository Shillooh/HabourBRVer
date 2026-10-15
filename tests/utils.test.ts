import test from 'node:test';
import assert from 'node:assert/strict';
import { episodeCode, isLive, isWatched, playable, playbackEnd, programmeProgress, progress, resumePosition, runtime, seasonName, time } from '../src/utils';
import type { Item } from '../src/types';

const item = (extra: Partial<Item> = {}): Item => ({ Id: 'item', Name: '', ...extra });

test('duration labels cover unknown, minute, and hour runtimes', () => {
  assert.equal(runtime(), '');
  assert.equal(runtime(-1), '');
  assert.equal(runtime(45 * 600_000_000), '45m');
  assert.equal(runtime(60 * 600_000_000), '1h');
  assert.equal(runtime(125 * 600_000_000), '2h 5m');
});

test('watch progress is bounded and a current rewatch takes priority over an earlier completion', () => {
  assert.equal(progress(item()), 0);
  assert.equal(progress(item({ RunTimeTicks: 100, UserData: { PlaybackPositionTicks: 25 } })), 25);
  assert.equal(progress(item({ RunTimeTicks: 100, UserData: { PlaybackPositionTicks: -5 } })), 0);
  assert.equal(progress(item({ RunTimeTicks: 100, UserData: { PlaybackPositionTicks: 150 } })), 100);
  assert.equal(progress(item({ UserData: { Played: true } })), 100);
  assert.equal(progress(item({ RunTimeTicks: 100, UserData: { Played: true, PlayedPercentage: 100, PlaybackPositionTicks: 25 } })), 25);
  assert.equal(progress(item({ UserData: { PlaybackPositionTicks: 25, PlayedPercentage: 40 } })), 40);
  assert.equal(progress(item({ UserData: { PlayedPercentage: Infinity } })), 0);
});

test('resume positions preserve a rewatch without changing its watched history', () => {
  const rewatch = item({ UserData: { Played: true, PlaybackPositionTicks: 25, PlayCount: 5 } });
  assert.equal(resumePosition(rewatch), 25);
  assert.deepEqual(rewatch.UserData, { Played: true, PlaybackPositionTicks: 25, PlayCount: 5 });
  for (const PlaybackPositionTicks of [undefined, -1, NaN, Infinity]) assert.equal(resumePosition(item({ UserData: { PlaybackPositionTicks } })), 0);
});

test('leaf watched indicators describe the current viewing while container status remains server-controlled', () => {
  for (const Type of ['Movie', 'Episode']) {
    assert.equal(isWatched(item({ Type, UserData: { Played: true, PlaybackPositionTicks: 25 } })), false);
    assert.equal(isWatched(item({ Type, UserData: { Played: true, PlaybackPositionTicks: 0 } })), true);
    assert.equal(isWatched(item({ Type, UserData: { Played: false, PlaybackPositionTicks: 0 } })), false);
  }
  assert.equal(isWatched(item({ Type: 'Series', UserData: { Played: true, PlaybackPositionTicks: 25 } })), true);
  assert.equal(isWatched(item({ Type: 'Season', UserData: { Played: true, PlaybackPositionTicks: 25 } })), true);
});

test('finish estimates use the current time and the duration that Play or Resume will play', () => {
  const now = Date.parse('2026-09-23T23:30:00Z');
  const movie = item({ Type: 'Movie', RunTimeTicks: 90 * 600_000_000 });
  assert.equal(playbackEnd(movie, now)?.toISOString(), '2026-09-24T01:00:00.000Z');
  const episode = { ...movie, Type: 'Episode', UserData: { PlaybackPositionTicks: 30.5 * 600_000_000 } };
  assert.equal(playbackEnd(episode, now)?.toISOString(), '2026-09-24T00:29:30.000Z');
  assert.equal(playbackEnd({ ...episode, UserData: { ...episode.UserData, Played: true } }, now)?.toISOString(), '2026-09-24T00:29:30.000Z');
  assert.equal(playbackEnd(movie, now + 60_000)?.getTime(), playbackEnd(movie, now)!.getTime() + 60_000);
});

test('finish estimates omit unavailable durations and clamp malformed resume positions', () => {
  const now = Date.parse('2026-09-23T12:00:00Z');
  const movie = item({ Type: 'Movie', RunTimeTicks: 60 * 600_000_000 });
  for (const RunTimeTicks of [undefined, 0, -1, NaN, Infinity, Number.MAX_VALUE]) {
    assert.equal(playbackEnd({ ...movie, RunTimeTicks }, now), null);
  }
  for (const Type of ['Series', 'MusicAlbum', 'Audio', 'TvChannel']) {
    assert.equal(playbackEnd({ ...movie, Type }, now), null);
  }
  assert.equal(playbackEnd({ ...movie, PlayAccess: 'None' }, now), null);
  assert.equal(playbackEnd(movie, NaN), null);
  for (const PlaybackPositionTicks of [-1, NaN, Infinity]) {
    assert.equal(playbackEnd({ ...movie, UserData: { PlaybackPositionTicks } }, now)?.getTime(), now + 3_600_000);
  }
  assert.equal(playbackEnd({ ...movie, UserData: { PlaybackPositionTicks: 90 * 600_000_000 } }, now)?.getTime(), now);
});

test('specials and descriptive season names stay distinct from generic labels', () => {
  assert.equal(seasonName(item({ Name: 'Series 0', IndexNumber: 0 })), 'Especiais');
  assert.equal(seasonName(item({ Name: ' Chapter 2 ', IndexNumber: 2 })), 'Temporada 2');
  assert.equal(seasonName(item({ Name: 'The Northern Passage', IndexNumber: 2 })), 'The Northern Passage');
  assert.equal(seasonName(item()), 'Episódios');
});

test('episode labels preserve zero and gracefully omit unknown numbering', () => {
  assert.equal(episodeCode(item({ ParentIndexNumber: 0, IndexNumber: 1 })), 'S0 · E1');
  assert.equal(episodeCode(item({ IndexNumber: 4 })), 'E4');
  assert.equal(episodeCode(item()), '');
});

test('live status and guide progress agree at programme boundaries', () => {
  const programme = item({ StartDate: '2026-09-22T12:00:00Z', EndDate: '2026-09-22T13:00:00Z' });
  const start = Date.parse(programme.StartDate!);
  const end = Date.parse(programme.EndDate!);
  assert.equal(isLive(programme, start - 1), false);
  assert.equal(isLive(programme, start), true);
  assert.equal(isLive(programme, end - 1), true);
  assert.equal(isLive(programme, end), false);
  assert.equal(programmeProgress(programme, start - 1), 0);
  assert.equal(programmeProgress(programme, (start + end) / 2), 50);
  assert.equal(programmeProgress(programme, end + 1), 100);
  assert.equal(programmeProgress(item()), 0);
  assert.equal(isLive(item(), start), false);
  assert.equal(programmeProgress(item({ StartDate: programme.EndDate, EndDate: programme.StartDate })), 0);
});

test('unavailable media cannot expose a working playback action', () => {
  assert.equal(playable(item()), true);
  for (const restriction of [{ Id: '' }, { PlayAccess: 'None' }, { IsMissing: true }, { IsVirtualItem: true }, { IsPlaceHolder: true }, { LocationType: 'Virtual' }]) {
    assert.equal(playable(item(restriction)), false);
  }
});

test('invalid schedule dates do not leak Invalid Date into the interface', () => {
  assert.equal(time(), '');
  assert.equal(time('not-a-date'), '');
  assert.ok(time('2026-09-22T13:00:00Z').length > 0);
});
