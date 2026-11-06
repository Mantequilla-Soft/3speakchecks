/**
 * GET /playlists-feed (routes/playlistsFeed.js): recently changed public playlists
 * for the home feed, against a real MongoDB. The whole candidate set is cached
 * once (utils/feedCache.js); the age window, the viewer's own playlists, their
 * dismissed creators and the `following` scope are applied per request.
 */
jest.mock('../../utils/hive', () => require('./_hiveMock').create());

const request = require('supertest');
const { Binary } = require('mongodb');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const F = require('./_fixtures');
const hive = require('../../utils/hive');

const db = testDb.use();
const app = buildApp(['/', require('../../routes/playlistsFeed')]);
const feed = (query = {}) => request(app).get('/playlists-feed').query(query);
const playlists = () => db().collection('playlists');
const items = (n) => Array.from({ length: n }, (_, i) => ({ author: 'a', permlink: `p${i}`, position: n - i }));
const playlist = (name, over = {}) => ({ name, owner: 'curator', access: 'public', items: items(2), updated_at: F.hoursAgo(1), ...over });
const names = (res) => res.body.playlists.map((p) => p.name);

beforeEach(async () => {
  F.pinClock();
  hive.__reset();
  await F.resetFeedCaches(db());
});
afterEach(() => jest.useRealTimers());

describe('which playlists are candidates', () => {
  test('public, non-audio, two or more items, changed in the last 7 days, newest change first', async () => {
    await playlists().insertMany([
      playlist('older change', { updated_at: F.daysAgo(3) }),
      playlist('newest change', { updated_at: F.hoursAgo(1) }),
      playlist('private', { access: 'private' }),
      playlist('an album', { type: 'audio' }),
      playlist('thin', { items: items(1) }),
      playlist('stale', { updated_at: F.daysAgo(8) }),
      playlist('ownerless', { owner: '' }),
      playlist('odd owner', { owner: 42 }),
    ]);
    expect(names(await feed().expect(200))).toEqual(['newest change', 'older change']);
  });

  test('a card names its first item by position and a stored thumbnail, else null', async () => {
    await playlists().insertMany([
      playlist('with thumb', { thumbnail: 'https://t/1.png' }),
      playlist('album meta', { metadata: Buffer.from(JSON.stringify({ album: { thumbnail: 'https://t/album.png' } })).toString('base64'), updated_at: F.hoursAgo(2) }),
      playlist('binary meta', { metadata: new Binary(Buffer.from(JSON.stringify({ album: { thumbnail: 'https://t/bin.png' } }))), updated_at: F.hoursAgo(3) }),
      playlist('bare', { name: null, updated_at: F.hoursAgo(4) }),
    ]);

    const res = await feed().expect(200);
    const [withThumb, album, binary, bare] = res.body.playlists;

    expect(withThumb).toMatchObject({ name: 'with thumb', owner: 'curator', itemCount: 2, thumbnail: 'https://t/1.png', firstItem: { author: 'a', permlink: 'p1' } });
    expect(withThumb.id).toEqual(expect.any(String));
    expect(album.thumbnail).toBe('https://t/album.png');
    expect(binary.thumbnail).toBe('https://t/bin.png');
    expect(bare).toMatchObject({ name: 'Untitled playlist', thumbnail: null });
  });

  // A moderation-hidden creator's content is removed from every discovery surface
  // (utils/hiddenCreators.js), and the other home-feed rails all drop them. This
  // rail only drops the VIEWER's own dismissals (routes/playlistsFeed.js:117-124),
  // so a hidden creator's playlists keep appearing on everyone's home feed.
  test('a moderation-hidden creator\'s playlists are not on the home feed', async () => {
    await F.hideCreator(db(), 'hush');
    await playlists().insertMany([playlist('hidden one', { owner: 'hush' }), playlist('fine')]);
    expect(names(await feed().expect(200))).toEqual(['fine']);
  });
});

describe('per request', () => {
  test('maxAgeHours narrows the window but never widens it', async () => {
    await playlists().insertMany([playlist('today', { updated_at: F.hoursAgo(2) }), playlist('this week', { updated_at: F.daysAgo(4) })]);
    expect(names(await feed({ maxAgeHours: 24 }).expect(200))).toEqual(['today']);
    expect(names(await feed({ maxAgeHours: 1000 }).expect(200))).toEqual(['today', 'this week']);
    expect(names(await feed({ maxAgeHours: 'x' }).expect(200))).toHaveLength(2);
  });

  test('the viewer\'s own playlists and their dismissed creators are left out', async () => {
    await playlists().insertMany([playlist('mine', { owner: 'Viewer' }), playlist('muted', { owner: 'muted' }), playlist('ok')]);
    await F.dismissCreator(db(), 'viewer', 'muted');
    expect(names(await feed({ currentuser: 'VIEWER' }).expect(200))).toEqual(['ok']);
  });

  test('scope=following: empty without a viewer or follows, else only followed owners', async () => {
    await playlists().insertMany([playlist('friend list', { owner: 'friend' }), playlist('stranger list', { owner: 'stranger' })]);
    expect((await feed({ scope: 'following' }).expect(200)).body).toMatchObject({ playlists: [], hasMore: false });
    expect((await feed({ scope: 'following', currentuser: 'loner' }).expect(200)).body.playlists).toEqual([]);

    hive.__state.following.set('viewer', ['Friend']);
    expect(names(await feed({ scope: 'following', currentuser: 'viewer' }).expect(200))).toEqual(['friend list']);
  });

  test('pagination, and limit clamped to 1..30', async () => {
    await playlists().insertMany([1, 2, 3].map((i) => playlist(`p${i}`, { updated_at: F.hoursAgo(i) })));
    const p2 = await feed({ limit: 2, page: 2 }).expect(200);
    expect(p2.body).toMatchObject({ page: 2, limit: 2, hasMore: false });
    expect(names(p2)).toEqual(['p3']);
    expect((await feed({ limit: 2 }).expect(200)).body.hasMore).toBe(true);
    expect((await feed({ limit: 500 }).expect(200)).body.limit).toBe(30);
    expect((await feed({ limit: -2 }).expect(200)).body.limit).toBe(1);
  });

  test('the candidate set is cached; a change shows after the cache TTL', async () => {
    await feed().expect(200);
    await playlists().insertOne(playlist('late'));
    expect((await feed().expect(200)).body.playlists).toEqual([]);
    F.advanceClock(60 * 1000);
    expect((await feed().expect(200)).body.playlists).toEqual([]);   // stale: served, refreshing behind it
    await F.waitFor(async () => names(await feed()).length === 1);
    expect(names(await feed().expect(200))).toEqual(['late']);
  });
});
