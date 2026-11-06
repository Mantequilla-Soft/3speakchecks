/**
 * Community snaps (routes/snaps.js): short written posts, indexed from Hive and
 * interleaved into the home feed. Against a real MongoDB, with the Hive read
 * (condenser get_content) answered by the fake chain.
 *
 * The snaps feed holds its three small collections in feedCache; every write here
 * drops its own cache entry, so a hide or an interaction applies on the very next
 * request. Those are the behaviours that matter most and are tested end to end.
 */
jest.mock('../../utils/hive', () => require('./_hiveMock').create());

const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const { fakeHiveChain } = require('../helpers/hive');
const F = require('./_fixtures');
const hive = require('../../utils/hive');

const db = testDb.use();
const app = buildApp(['/', require('../../routes/snaps')]);
const snaps = () => db().collection('community-snaps');
const feed = (query = {}) => request(app).get('/snaps-feed').query(query);

/** A snap as it is stored once indexed. */
const snap = (owner, permlink, over = {}) => ({ _id: `${owner}/${permlink}`, owner, permlink, title: '', body: `snap ${permlink}`, nsfw: false, community: null, created: F.hoursAgo(1), ...over });

/** The Hive post a client just broadcast. */
const chainPost = (over = {}, meta = {}) => ({
  author: 'writer', permlink: 'my-snap', title: 'Hello', body: 'A short post', created: '2026-11-01T11:00:00',
  parent_author: 'peak.snaps', parent_permlink: 'snaps-container',
  json_metadata: JSON.stringify({ app: '3speak/snap', tags: ['life', 'nsfw', 7], image: ['https://img/1.png'], community: 'hive-777777', ...meta }),
  ...over,
});

beforeEach(async () => {
  F.pinClock();
  hive.__reset();
  await F.resetFeedCaches(db());
});
afterEach(() => jest.useRealTimers());

describe('POST /snaps (index a snap from the chain)', () => {
  const index = (body) => request(app).post('/snaps').send(body);

  test('needs author and permlink', async () => {
    await index({ author: 'writer' }).expect(400);
  });

  test('stores OUR read of the post, never the client\'s', async () => {
    fakeHiveChain([], { get_content: ([a, p]) => (a === 'writer' && p === 'my-snap' ? chainPost() : null) });

    const res = await index({ author: 'Writer', permlink: 'my-snap', body: 'forged body' }).expect(200);

    expect(res.body.snap).toMatchObject({
      _id: 'writer/my-snap', owner: 'writer', title: 'Hello', body: 'A short post', tags: ['life', 'nsfw'],
      image: 'https://img/1.png', nsfw: true, community: 'hive-777777', parentAuthor: 'peak.snaps',
      created: '2026-11-01T11:00:00.000Z',
    });
    expect(await snaps().findOne({ _id: 'writer/my-snap' })).toMatchObject({ body: 'A short post' });
  });

  test('a post by someone else cannot be filed under this account', async () => {
    fakeHiveChain([], { get_content: () => chainPost({ author: 'impostor' }) });
    expect((await index({ author: 'writer', permlink: 'my-snap' }).expect(403)).body.error).toBe('author mismatch');
    expect(await snaps().countDocuments()).toBe(0);
  });

  test('a post that is not a 3Speak snap is refused', async () => {
    fakeHiveChain([], { get_content: () => chainPost({}, { app: 'peakd/2024' }) });
    expect((await index({ author: 'writer', permlink: 'my-snap' }).expect(400)).body.error).toBe('not a 3Speak snap');
  });

  test('a community that is not a Hive community id is dropped', async () => {
    fakeHiveChain([], { get_content: () => chainPost({}, { community: 'my-own-thing', tags: 'not-an-array' }) });
    const res = await index({ author: 'writer', permlink: 'my-snap' }).expect(200);
    expect(res.body.snap).toMatchObject({ community: null, tags: [], nsfw: false });
  });

  test('a freshly indexed snap is in the feed on the very next request', async () => {
    expect((await feed().expect(200)).body.snaps).toEqual([]);   // warms the snaps cache
    fakeHiveChain([], { get_content: () => chainPost({ created: new Date(Date.now() - 60000).toISOString().slice(0, 19) }, { tags: [] }) });
    await index({ author: 'writer', permlink: 'my-snap' }).expect(200);
    expect((await feed().expect(200)).body.snaps.map((s) => s._id)).toEqual(['writer/my-snap']);
  });

  test('a post the chain does not have yet is a 404 after the retries', async () => {
    fakeHiveChain([], { get_content: () => { throw new Error('rpc down'); } });
    // The fetch retries across ~1.5s block times; run those waits instantly.
    const realSetTimeout = global.setTimeout;
    jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms, ...args) => realSetTimeout(fn, ms === 1500 ? 0 : ms, ...args));
    await index({ author: 'writer', permlink: 'my-snap' }).expect(404);
  });
});

describe('listing snaps', () => {
  beforeEach(async () => {
    await snaps().insertMany([
      snap('writer', 's1', { created: F.hoursAgo(3), community: 'hive-1' }),
      snap('writer', 's2', { created: F.hoursAgo(1) }),
      snap('other', 'o1', { community: 'hive-1', created: F.hoursAgo(2) }),
    ]);
  });

  test('GET /snaps/:owner: newest first, paginated', async () => {
    const res = await request(app).get('/snaps/Writer').query({ limit: 1 }).expect(200);
    expect(res.body).toMatchObject({ success: true, total: 2, hasMore: true, limit: 1, page: 1 });
    expect(res.body.snaps.map((s) => s.permlink)).toEqual(['s2']);
  });

  test('GET /snaps/community/:id: every author\'s snaps filed under the community', async () => {
    const res = await request(app).get('/snaps/community/hive-1').expect(200);
    expect(res.body.snaps.map((s) => s.permlink)).toEqual(['o1', 's1']);
    expect(res.body.hasMore).toBe(false);
    await request(app).get('/snaps/community/not-a-community').expect(400);
  });
});

describe('GET /snaps-feed', () => {
  test('fresh snaps only (7 days), narrowed further by maxAgeHours but never widened', async () => {
    await snaps().insertMany([
      snap('a', 'today', { created: F.hoursAgo(2) }),
      snap('b', 'days', { created: F.daysAgo(5) }),
      snap('c', 'stale', { created: F.daysAgo(8) }),
    ]);

    expect((await feed().expect(200)).body.snaps.map((s) => s.permlink)).toEqual(['today', 'days']);
    expect((await feed({ maxAgeHours: 24 }).expect(200)).body.snaps.map((s) => s.permlink)).toEqual(['today']);
    expect((await feed({ maxAgeHours: 10000 }).expect(200)).body.snaps).toHaveLength(2);
    expect((await feed({ maxAgeHours: -1 }).expect(200)).body.snaps).toHaveLength(2);
  });

  test('NSFW snaps need the opt-in', async () => {
    await snaps().insertMany([snap('a', 'safe'), snap('b', 'spicy', { nsfw: true })]);
    expect((await feed().expect(200)).body.snaps.map((s) => s.permlink)).toEqual(['safe']);
    expect((await feed({ nsfw: 'true' }).expect(200)).body.snaps).toHaveLength(2);
  });

  test('scope=following: empty without a viewer or follows, else only followed authors', async () => {
    await snaps().insertMany([snap('friend', 'f'), snap('stranger', 's')]);
    expect((await feed({ scope: 'following' }).expect(200)).body.snaps).toEqual([]);
    expect((await feed({ scope: 'following', currentuser: 'loner' }).expect(200)).body.snaps).toEqual([]);

    hive.__state.following.set('viewer', ['friend']);
    expect((await feed({ scope: 'following', currentuser: 'viewer' }).expect(200)).body.snaps.map((s) => s.owner)).toEqual(['friend']);
  });

  test('scope=all drops authors under the follower threshold, unless the viewer follows them or the count is unknown', async () => {
    await snaps().insertMany([
      snap('popular', 'p', { created: F.hoursAgo(1) }),
      snap('tiny', 't', { created: F.hoursAgo(2) }),
      snap('tinyfriend', 'tf', { created: F.hoursAgo(3) }),
      snap('unknown', 'u', { created: F.hoursAgo(4) }),
    ]);
    hive.__state.followers.set('popular', 5000);
    hive.__state.followers.set('tiny', 12);
    hive.__state.followers.set('tinyfriend', 3);
    hive.__state.following.set('viewer', ['tinyfriend']);

    expect((await feed().expect(200)).body.snaps.map((s) => s.owner)).toEqual(['popular', 'unknown']);
    expect((await feed({ currentuser: 'viewer' }).expect(200)).body.snaps.map((s) => s.owner)).toEqual(['popular', 'tinyfriend', 'unknown']);
  });

  // utils/hiddenCreators.js removes a moderation-hidden creator from every feed,
  // but the snaps feed only drops the VIEWER's own snap hides (routes/snaps.js:
  // 254-264); it never consults the hidden-creator set, so their posts stay on
  // everyone's home feed.
  test('a moderation-hidden creator\'s snaps are not on the home feed', async () => {
    await F.hideCreator(db(), 'hush');
    await snaps().insertMany([snap('hush', 'h'), snap('fine', 'f')]);
    expect((await feed().expect(200)).body.snaps.map((s) => s.owner)).toEqual(['fine']);
  });

  test('a viewer never sees their own snaps', async () => {
    await snaps().insertMany([snap('viewer', 'mine'), snap('a', 'theirs')]);
    expect((await feed({ currentuser: 'Viewer' }).expect(200)).body.snaps.map((s) => s.permlink)).toEqual(['theirs']);
  });

  test('pagination', async () => {
    await snaps().insertMany([1, 2, 3].map((i) => snap(`a${i}`, `s${i}`, { created: F.hoursAgo(i) })));
    const res = await feed({ limit: 2, page: 2 }).expect(200);
    expect(res.body).toMatchObject({ page: 2, limit: 2, hasMore: false });
    expect(res.body.snaps.map((s) => s.permlink)).toEqual(['s3']);
    expect((await feed({ limit: 2 }).expect(200)).body.hasMore).toBe(true);
  });
});

describe('per-viewer hides and interactions apply on the next request', () => {
  beforeEach(async () => {
    await snaps().insertMany([snap('a', 'one', { created: F.hoursAgo(1) }), snap('a', 'two', { created: F.hoursAgo(2) }), snap('b', 'three', { created: F.hoursAgo(3) })]);
    await feed({ currentuser: 'viewer' }).expect(200);   // warm every cache first
  });
  const visible = async () => (await feed({ currentuser: 'viewer' }).expect(200)).body.snaps.map((s) => s.permlink);

  test('hiding a post, then un-hiding it', async () => {
    await request(app).post('/snaps/hide').send({ user: 'Viewer', author: 'a', permlink: 'one' }).expect(200);
    expect(await visible()).toEqual(['two', 'three']);
    await request(app).delete('/snaps/hide').send({ user: 'viewer', author: 'a', permlink: 'one' }).expect(200);
    expect(await visible()).toEqual(['one', 'two', 'three']);
  });

  test('hiding a creator, then un-hiding them', async () => {
    await request(app).post('/snaps/hide-creator').send({ user: 'viewer', author: 'A' }).expect(200);
    expect(await visible()).toEqual(['three']);
    await request(app).delete('/snaps/hide-creator').send({ user: 'viewer', owner: 'a' }).expect(200);
    expect(await visible()).toEqual(['one', 'two', 'three']);
  });

  test('a snap the viewer voted on or replied to stops surfacing, for them only', async () => {
    await request(app).post('/snaps/interaction').send({ user: 'viewer', author: 'b', permlink: 'three' }).expect(200);
    expect(await visible()).toEqual(['one', 'two']);
    expect((await feed({ currentuser: 'someone' }).expect(200)).body.snaps).toHaveLength(3);
  });

  test.each([
    ['post', '/snaps/hide', { user: 'viewer', author: 'a' }],
    ['post', '/snaps/hide-creator', { user: 'viewer' }],
    ['post', '/snaps/interaction', { user: 'viewer', author: 'a' }],
  ])('%s %s with missing fields is a 400', async (method, path, body) => {
    await request(app)[method](path).send(body).expect(400);
  });
});
