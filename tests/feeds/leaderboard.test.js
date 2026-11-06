/**
 * The leaderboards (routes/leaderboard.js) over the rollup collections
 * `leaderboard` (one row per window + user) and `leaderboard-topics-v2` (one row
 * per window + topic + user), against a real MongoDB.
 *
 * A board ranks by one metric, highest first and then by name, leaves out zero
 * rows, and never places a moderation-hidden or leaderboard-excluded account
 * (LEADERBOARD_EXCLUDED_USERS, default badadib and e2etestobs), not even as
 * someone "ahead" of you.
 *
 * The topic list and the badges are cached in module scope, so each test runs a
 * day after the previous one.
 */
jest.mock('../../utils/hive', () => require('./_hiveMock').create());

const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const F = require('./_fixtures');

const db = testDb.use();
const app = buildApp(['/', require('../../routes/leaderboard')]);
const get = (path, query = {}) => request(app).get(path).query(query);
const board = () => db().collection('leaderboard');
const topics = () => db().collection('leaderboard-topics-v2');
const row = (user, window, metrics = {}) => ({
  user, window, from: '2026-10-25T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T06:00:00.000Z', ...metrics,
});

let day = 0;
beforeEach(async () => {
  day += 1;
  F.pinClock(new Date(F.NOW.getTime() + day * F.DAY));
  await F.resetFeedCaches(db());
});
afterEach(() => jest.useRealTimers());

describe('GET /leaderboard', () => {
  beforeEach(async () => {
    await board().insertMany([
      row('bea', '7d', { video_uploads: 5, short_uploads: 1 }),
      row('abe', '7d', { video_uploads: 5 }),
      row('cal', '7d', { video_uploads: 9 }),
      row('zero', '7d', { video_uploads: 0, tags_given: 3 }),
      row('badadib', '7d', { video_uploads: 50 }),          // leaderboard-excluded
      row('hush', '7d', { video_uploads: 40 }),             // moderation-hidden
      row('cal', '30d', { video_uploads: 20 }),
    ]);
    await F.hideCreator(db(), 'hush');
  });

  test('ranks by the metric, ties by name, without zero rows or excluded accounts', async () => {
    const res = await get('/leaderboard').expect(200);

    expect(res.body).toMatchObject({
      success: true, window: '7d', metric: 'video_uploads', page: 1, limit: 50, total: 3, has_more: false,
      from: '2026-10-25T00:00:00.000Z', updated_at: '2026-11-01T06:00:00.000Z', watch_tracked_since: '2026-07-06', partial_watch_data: false,
    });
    expect(res.body.entries.map((e) => [e.rank, e.user, e.video_uploads])).toEqual([[1, 'cal', 9], [2, 'abe', 5], [3, 'bea', 5]]);
    // Every metric is on every row: absent means zero.
    expect(res.body.entries[2]).toMatchObject({ short_uploads: 1, streams: 0, story_streak: 0 });
  });

  test('another window and metric', async () => {
    expect((await get('/leaderboard', { window: '30d' }).expect(200)).body.entries.map((e) => e.user)).toEqual(['cal']);
    expect((await get('/leaderboard', { metric: 'tags_given' }).expect(200)).body.entries.map((e) => e.user)).toEqual(['zero']);
  });

  test('an unknown window or metric falls back to the defaults', async () => {
    const res = await get('/leaderboard', { window: '1d', metric: 'likes' }).expect(200);
    expect(res.body).toMatchObject({ window: '7d', metric: 'video_uploads' });
  });

  test('pagination continues the ranks; limit is clamped', async () => {
    const res = await get('/leaderboard', { limit: 2, page: 2 }).expect(200);
    expect(res.body).toMatchObject({ limit: 2, page: 2, total: 3, has_more: false });
    expect(res.body.entries.map((e) => [e.rank, e.user])).toEqual([[3, 'bea']]);
    expect((await get('/leaderboard', { limit: 2 }).expect(200)).body.has_more).toBe(true);
    expect((await get('/leaderboard', { limit: 1000 }).expect(200)).body.limit).toBe(100);
    expect((await get('/leaderboard', { limit: 0 }).expect(200)).body.limit).toBe(50);
  });

  test('an empty board has no dates', async () => {
    expect((await get('/leaderboard', { window: 'all' }).expect(200)).body).toMatchObject({ total: 0, entries: [], from: null, updated_at: null });
  });

  test.each([
    ['all', null, true],
    ['365d', '2026-03-01T00:00:00.000Z', true],    // reaches back past the start of watch tracking
    ['30d', '2026-10-02T00:00:00.000Z', false],
  ])('watch boards say whether they are partial: window %s from %s', async (window, from, partial) => {
    await board().insertOne({ ...row('watcher', window, { video_watch_secs: 100 }), from });
    expect((await get('/leaderboard', { window, metric: 'video_watch_secs' }).expect(200)).body.partial_watch_data).toBe(partial);
  });
});

describe('GET /leaderboard/summary', () => {
  test('the top N of every metric in one call', async () => {
    await board().insertMany([
      row('a1', '7d', { video_uploads: 3, streams: 1 }),
      row('a2', '7d', { video_uploads: 1, boosts_given: 4 }),
    ]);

    const res = await get('/leaderboard/summary', { limit: 1 }).expect(200);

    expect(res.body).toMatchObject({ success: true, window: '7d', limit: 1, watch_tracked_since: '2026-07-06' });
    expect(Object.keys(res.body.boards)).toHaveLength(15);
    expect(res.body.boards.video_uploads.entries.map((e) => e.user)).toEqual(['a1']);
    expect(res.body.boards.boosts_given.entries.map((e) => e.user)).toEqual(['a2']);
    expect(res.body.boards.story_uploads.entries).toEqual([]);
  });

  test('limit is capped at 50, and an empty window has no updated_at', async () => {
    const res = await get('/leaderboard/summary', { limit: 999, window: '365d' }).expect(200);
    expect(res.body).toMatchObject({ limit: 50, updated_at: null });
  });

  // `updated_at` is read off the first board entry (routes/leaderboard.js:233-239),
  // but entries are built by normalize(), which keeps only the user and the metrics.
  // So a non-empty summary never says when the rollup last ran: the field is
  // undefined and drops out of the JSON.
  test('a non-empty summary reports when the rollup last ran (updated_at)', async () => {
    await board().insertOne(row('a1', '7d', { video_uploads: 3 }));
    const res = await get('/leaderboard/summary').expect(200);
    expect(res.body.updated_at).toBe('2026-11-01T06:00:00.000Z');
  });
});

describe('GET /leaderboard/user/:username', () => {
  test('a creator\'s stat line with their rank per metric; excluded accounts never count as ahead', async () => {
    await board().insertMany([
      row('myself', '7d', { video_uploads: 4, short_uploads: 0, tags_given: 2 }),
      row('top', '7d', { video_uploads: 10 }),
      row('badadib', '7d', { video_uploads: 99, tags_given: 99 }),
      row('tie', '7d', { tags_given: 2 }),
    ]);

    const res = await get('/leaderboard/user/MYSELF').expect(200);

    expect(res.body).toMatchObject({ success: true, window: '7d', found: true, from: '2026-10-25T00:00:00.000Z' });
    expect(res.body.stats).toMatchObject({ user: 'myself', video_uploads: 4, tags_given: 2, short_uploads: 0 });
    expect(res.body.ranks).toMatchObject({ video_uploads: 2, tags_given: 1, short_uploads: null });
  });

  test('no row in the window is all zeros with no ranks, not a 404', async () => {
    const res = await get('/leaderboard/user/newbie', { window: 'all' }).expect(200);
    expect(res.body).toMatchObject({ found: false, window: 'all', stats: { user: 'newbie', video_uploads: 0 }, ranks: { video_uploads: null } });
  });

  test('a malformed username is a 400', async () => {
    await get('/leaderboard/user/x').expect(400);
  });
});

describe('topic boards', () => {
  beforeEach(async () => {
    await topics().insertMany([
      { window: '7d', topic: 'technology', user: 'dev', uploads: 3, video_uploads: 3, watch_secs: 50, from: 'f1', to: 't1', updated_at: 'u1' },
      { window: '7d', topic: 'science', user: 'dev', uploads: 2, video_uploads: 2, watch_secs: 10, from: 'f0', to: 't2', updated_at: 'u2' },
      { window: '7d', topic: 'science', user: 'labrat', uploads: 4, video_uploads: 4 },
      { window: '7d', topic: 'technology', user: 'zero', uploads: 0 },
      { window: '7d', topic: 'technology', user: 'e2etestobs', uploads: 9 },
      { window: '30d', topic: 'music', user: 'singer', uploads: 1 },
    ]);
  });

  test('GET /leaderboard/topics lists every topic once, sorted, and caches the list', async () => {
    expect((await get('/leaderboard/topics').expect(200)).body).toEqual({ success: true, topics: ['music', 'science', 'technology'] });
    await topics().insertOne({ window: '7d', topic: 'art', user: 'painter', uploads: 1 });
    expect((await get('/leaderboard/topics').expect(200)).body).toMatchObject({ cached: true, topics: ['music', 'science', 'technology'] });
  });

  test('a plain topic board ranks by uploads by default, minus zero rows and excluded accounts', async () => {
    const res = await get('/leaderboard/topic', { topic: 'Technology' }).expect(200);
    expect(res.body).toMatchObject({ success: true, topic: 'technology', metric: 'uploads', total: 1, rolled_up: false, approx: false, rolled_up_topics: null, from: 'f1' });
    expect(res.body.entries).toEqual([expect.objectContaining({ rank: 1, user: 'dev', uploads: 3, short_uploads: 0 })]);
  });

  test('a category rolls up its topics, summing per creator (approximate)', async () => {
    const res = await get('/leaderboard/topic', { topic: 'tech-science' }).expect(200);
    expect(res.body).toMatchObject({ rolled_up: true, approx: true, total: 2, from: 'f0' });
    expect(res.body.rolled_up_topics).toEqual(['tech-science', 'technology', 'education', 'science', 'programming']);
    expect(res.body.entries.map((e) => [e.rank, e.user, e.uploads])).toEqual([[1, 'dev', 5], [2, 'labrat', 4]]);
  });

  test('roll-up pages and metrics', async () => {
    const p2 = await get('/leaderboard/topic', { topic: 'tech-science', limit: 1, page: 2 }).expect(200);
    expect(p2.body).toMatchObject({ total: 2, has_more: false });
    expect(p2.body.entries.map((e) => [e.rank, e.user])).toEqual([[2, 'labrat']]);
    const watch = await get('/leaderboard/topic', { topic: 'tech-science', metric: 'watch_secs' }).expect(200);
    expect(watch.body).toMatchObject({ metric: 'watch_secs', window: '7d', partial_watch_data: false });
    expect(watch.body.entries.map((e) => [e.user, e.watch_secs])).toEqual([['dev', 60]]);
  });

  // The main boards measure "partial" against the window's real start, because
  // "the old `window !== '7d'` was true forever and kept telling people the 30d
  // board was short of data long after it wasn't" (routes/leaderboard.js:80-90).
  // The topic boards still use exactly that rule (:420), so in November 2026 a 30d
  // topic watch board, which starts in October, still claims partial data.
  test('a 30d topic watch board is not flagged partial once its window starts after tracking began', async () => {
    const res = await get('/leaderboard/topic', { topic: 'music', metric: 'watch_secs', window: '30d' }).expect(200);
    expect(res.body.partial_watch_data).toBe(false);
  });

  test('an unknown metric falls back to uploads; a malformed topic is a 400', async () => {
    expect((await get('/leaderboard/topic', { topic: 'science', metric: 'nope' }).expect(200)).body.metric).toBe('uploads');
    await get('/leaderboard/topic', { topic: 'x' }).expect(400);
    await get('/leaderboard/topic').expect(400);
  });
});

describe('GET /leaderboard/badges/:username', () => {
  test('the best tier per metric across all windows, best rank first, the longer window on a tie', async () => {
    const others = (window, metric, n) => Array.from({ length: n }, (_, i) => row(`other${i}`, window, { [metric]: 1000 - i }));
    await board().insertMany([
      // video_uploads: #1 in 7d AND #1 all-time -> the all-time one is kept
      row('star', '7d', { video_uploads: 5, short_uploads: 1 }),
      row('star', 'all', { video_uploads: 500, tags_given: 1 }),
      // short_uploads: 7d rank 4 (three ahead) -> Top 10
      ...others('7d', 'short_uploads', 3),
      // tags_given all-time: 150 ahead -> no badge
      ...others('all', 'tags_given', 150),
    ]);

    const res = await get('/leaderboard/badges/Star').expect(200);

    expect(res.body).toMatchObject({ success: true, username: 'star', watch_tracked_since: '2026-07-06' });
    expect(res.body.badges).toEqual([
      { metric: 'video_uploads', window: 'all', rank: 1, value: 500, tier: 'top1', tier_label: '#1' },
      { metric: 'short_uploads', window: '7d', rank: 4, value: 1, tier: 'top10', tier_label: 'Top 10' },
    ]);
  });

  test('is cached for a few minutes; a malformed name is a 400', async () => {
    await board().insertOne(row('cachey', '7d', { video_uploads: 1 }));
    await get('/leaderboard/badges/cachey').expect(200);
    const again = await get('/leaderboard/badges/cachey').expect(200);
    expect(again.body.cached).toBe(true);
    await get('/leaderboard/badges/!!').expect(400);
  });

  test('a creator with no rows has no badges', async () => {
    expect((await get('/leaderboard/badges/nobody').expect(200)).body.badges).toEqual([]);
  });
});
