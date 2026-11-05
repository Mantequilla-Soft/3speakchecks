/**
 * GET /feeds/watched/:username (routes/watchedFeed.js) against a real MongoDB:
 * a viewer's watch history as feed cards, with Videos / Shorts / Audio tabs.
 *
 * Rows written before the playlists service knew what it was recording carry no
 * `short` / `audio` flag; the route settles each one ONCE from our own collections,
 * and never overwrites a flag the player sent. (tests/watchedFeed.test.js covers
 * the audio split with a hand-written fake; this proves the real queries.)
 */
jest.mock('../../utils/hive', () => require('./_hiveMock').create());

const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const F = require('./_fixtures');

const db = testDb.use();
const app = buildApp(['/feeds', require('../../routes/watchedFeed')]);
const watchedFeed = (user, query = {}) => request(app).get(`/feeds/watched/${user}`).query(query);
const history = () => db().collection('watch_history');
const row = (permlink, author, hoursAgo, over = {}) => F.watched('fan', author, permlink, { last_watched_at: F.hoursAgo(hoursAgo), ...over });

beforeEach(async () => {
  F.pinClock();
  await F.resetFeedCaches(db());
});
afterEach(() => jest.useRealTimers());

describe('input', () => {
  test('a username longer than 64 characters is a 400', async () => {
    await watchedFeed('x'.repeat(65)).expect(400);
  });

  test('an empty history is an empty first page', async () => {
    expect((await watchedFeed('fan').expect(200)).body).toEqual({
      success: true, page: 1, limit: 20, total: 0, totalPages: 1, counts: { videos: 0, shorts: 0, audio: 0 }, videos: [],
    });
  });
});

describe('classifying unflagged rows', () => {
  test('shorts and audio are recognised from our own collections, once, and a player-sent flag is never overwritten', async () => {
    await db().collection('embed-video').insertMany([
      F.embedVideo({ owner: 'cr', permlink: 'long-asset' }),
      F.shortVideo({ owner: 'cr', permlink: 'short-asset', hive_permlink: 'short-post' }),
    ]);
    await db().collection('embed-audio').insertOne({ owner: 'pod', permlink: 'ep1', post_permlink: 'ep1-post', title: 'Episode 1', status: 'published' });
    await db().collection('videos').insertOne(F.legacyVideo({ owner: 'leg', permlink: 'old' }));
    await history().insertMany([
      row('hive-long-asset', 'cr', 1),
      row('short-post', 'cr', 2),          // a short, by its Hive permlink
      row('ep1-post', 'pod', 3),            // an audio listen, by its Hive post
      row('old', 'leg', 4),                 // legacy predates shorts
      row('gone', 'ghost', 5),              // nothing we hold
      row('short-asset', 'cr', 6, { short: false }),   // the player said "not a short": its word stands
    ]);

    await watchedFeed('fan').expect(200);

    const flags = Object.fromEntries((await history().find().toArray()).map((r) => [r.permlink, [r.short, r.audio]]));
    expect(flags).toEqual({
      'hive-long-asset': [false, false],
      'short-post': [true, false],
      'ep1-post': [false, true],
      old: [false, false],
      gone: [false, false],
      'short-asset': [false, false],
    });
  });
});

describe('tabs', () => {
  beforeEach(async () => {
    await db().collection('embed-video').insertMany([
      F.embedVideo({ owner: 'cr', permlink: 'v1', gated: true }),
      F.embedVideo({ owner: 'cr', permlink: 'v2', hive_permlink: null, hive_title: null, originalFilename: 'raw-upload.mp4' }), // never linked to a post
      F.shortVideo({ owner: 'cr', permlink: 's1', originalFilename: 'IMG_1.mov', embed_title: null }),
    ]);
    await db().collection('embed-audio').insertOne({ owner: 'pod', permlink: 'ep', title: 'Episode', status: 'published' });
    await db().collection('videos').insertOne(F.legacyVideo({ owner: 'leg', permlink: 'old', title: 'Legacy' }));
    await history().insertMany([
      row('hive-v1', 'cr', 1, { watch_count: 3 }),
      row('v2', 'cr', 2),
      row('s1', 'cr', 3, { short: true }),
      row('ep', 'pod', 4, { audio: true }),
      row('old', 'leg', 30),
    ]);
  });

  test('all tabs, newest watch first, each in the card shape its tab renders', async () => {
    const res = await watchedFeed('fan').expect(200);

    expect(res.body).toMatchObject({ total: 5, counts: { videos: 3, shorts: 1, audio: 1 } });
    expect(res.body.videos.map((v) => v._historyKey)).toEqual(['cr/hive-v1', 'cr/v2', 'cr/s1', 'pod/ep', 'leg/old']);
    const [v1, v2, s1, ep, old] = res.body.videos;
    expect(v1).toMatchObject({ permlink: 'hive-v1', author: 'cr', gated: true, watch_count: 3, watched_at: Math.floor(F.hoursAgo(1).getTime() / 1000) });
    expect(v2).toMatchObject({ permlink: 'v2', title: '', _unlinked: true });   // never the upload's filename
    expect(s1).toMatchObject({ permlink: 's1', author: 'cr', title: 'IMG_1.mov', _short: true });
    expect(ep).toMatchObject({ title: 'Episode', _audio: true, watch_count: 1 });
    expect(old).toMatchObject({ title: 'Legacy', author: 'leg' });
  });

  test.each([
    ['videos', ['cr/hive-v1', 'cr/v2', 'leg/old'], 3],
    ['shorts', ['cr/s1'], 1],
    ['audio', ['pod/ep'], 1],
    ['bogus', ['cr/hive-v1', 'cr/v2', 'cr/s1', 'pod/ep', 'leg/old'], 5],
  ])('type=%s', async (type, keys, total) => {
    const res = await watchedFeed('fan', { type }).expect(200);
    expect(res.body.videos.map((v) => v._historyKey)).toEqual(keys);
    expect(res.body.total).toBe(total);
  });

  test('since= keeps entries last watched at or after it, and the tab counts follow', async () => {
    const since = Math.floor(F.hoursAgo(10).getTime() / 1000);
    const res = await watchedFeed('fan', { since }).expect(200);
    expect(res.body.counts).toEqual({ videos: 2, shorts: 1, audio: 1 });
    expect(res.body.videos.map((v) => v._historyKey)).not.toContain('leg/old');
  });

  test('pagination, limit capped at 50', async () => {
    const res = await watchedFeed('fan', { limit: 2, page: 2 }).expect(200);
    expect(res.body).toMatchObject({ page: 2, limit: 2, totalPages: 3 });
    expect(res.body.videos.map((v) => v._historyKey)).toEqual(['cr/s1', 'pod/ep']);
    expect((await watchedFeed('fan', { limit: 999 }).expect(200)).body.limit).toBe(50);
  });
});

describe('entries that no longer resolve', () => {
  test('a video we no longer hold, an unpublished track and an expired story are left out; counts still include them', async () => {
    await db().collection('embed-video').insertOne(F.storyVideo({ owner: 'cr', permlink: 'story', story_posted_at: F.hoursAgo(30) }));
    await db().collection('embed-audio').insertOne({ owner: 'pod', permlink: 'draft', title: 'Draft', status: 'draft' });
    await history().insertMany([
      row('story', 'cr', 1, { short: true }),
      row('draft', 'pod', 2, { audio: true }),
      row('vanished', 'ghost', 3),
    ]);

    const res = await watchedFeed('fan').expect(200);

    expect(res.body.videos).toEqual([]);
    expect(res.body.counts).toEqual({ videos: 1, shorts: 1, audio: 1 });
  });
});
