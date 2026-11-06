/**
 * GET /feeds/interests, against a real MongoDB.
 *
 * The Interests tab reads its own topic-stratified pool (utils/interestPool.js):
 * every entry already carries a winning topic, so the route keeps the entries whose
 * topic the viewer picked, ranks them (base x recency tilt x jitter, plus follow /
 * engagement boosts) and applies the viewer's dismissals.
 */
jest.mock('../../utils/hive', () => require('./_hiveMock').create());

const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const F = require('./_fixtures');
const { getInterestPool } = require('../../utils/interestPool');
const { DISCOVER_POOL_CACHE_MS } = require('../../utils/config');
const hive = require('../../utils/hive');

const db = testDb.use();
const app = buildApp(['/feeds', require('../../routes/feeds')]);
const interests = (query = {}) => request(app).get('/feeds/interests').query({ seed: 9, ...query });

beforeEach(async () => {
  F.pinClock();
  hive.__reset();
  await F.resetFeedCaches(db());
});
afterEach(() => jest.useRealTimers());

/** Pool videos v0..v(n-1) with the given winning topics, v0 newest. */
async function seedTopics(topics, over = () => ({})) {
  for (let i = 0; i < topics.length; i += 1) {
    const extra = over(i);
    await F.seedPooled(db(), {
      pool: 'interest-pool',
      video: { owner: extra.owner || `maker${i}`, permlink: `v${i}`, createdAt: F.hoursAgo(i + 1) },
      entry: { winnerTag: topics[i], ...extra.entry },
    });
  }
}

describe('without interests or without a pool', () => {
  test('no ?interests= is an empty feed (the tab only makes sense with them)', async () => {
    await seedTopics(['music']);
    const res = await interests().expect(200);
    expect(res.body).toEqual({ success: true, feed: 'interests', page: 1, limit: 30, total: 0, totalPages: 0, videos: [] });
  });

  test('an interest pool the worker has not built yet is an empty feed, not an error', async () => {
    const res = await interests({ interests: 'music' }).expect(200);
    expect(res.body).toMatchObject({ total: 0, seed: 9, videos: [] });
  });
});

describe('matching', () => {
  test('only entries whose winning topic is one of the picks are shown', async () => {
    await seedTopics(['music', 'gaming', 'music', 'food']);

    const res = await interests({ interests: 'Music, FOOD' }).expect(200);

    expect(res.body.interests).toEqual(['music', 'food']);
    expect(res.body.total).toBe(3);
    expect(F.permlinks(res.body.videos).sort()).toEqual(['hive-v0', 'hive-v2', 'hive-v3']);
  });

  test('NSFW entries need the viewer\'s opt-in', async () => {
    await seedTopics(['music', 'music'], (i) => ({ entry: { nsfw: i === 0 } }));

    expect((await interests({ interests: 'music' }).expect(200)).body.total).toBe(1);
    expect((await interests({ interests: 'music', nsfw: 'true' }).expect(200)).body.total).toBe(2);
  });

  // The frontend sends the viewer's raw picks (HomeGrouped.jsx), and a pick can be a
  // CATEGORY. /feeds/discover?interestsOnly=1 expands a category to its topics for
  // exactly this reason ("otherwise a category pick matches only the handful of
  // videos tagged with the bare category itself ... and the tab looks empty").
  // This dedicated endpoint replaced that variant but matches the pick literally
  // (routes/feeds.js:101-103), so a viewer who picked "tech-science" gets nothing
  // tagged technology / science / education / programming.
  test.skip('BUG: a CATEGORY pick does not keep the videos of its topics (literal match)', async () => {
    await seedTopics(['technology', 'science', 'music']);
    const res = await interests({ interests: 'tech-science' }).expect(200);
    expect(F.permlinks(res.body.videos).sort()).toEqual(['hive-v0', 'hive-v1']);
  });
});

describe('what the interest pool never serves', () => {
  test.each([
    ['unavailable media', () => ({ unavailable: true })],
    ['the author hid it from feeds', () => ({ hiddenFromFeed: true })],
    ['older than a year', () => ({ created: F.daysAgo(366) })],
  ])('an entry is excluded when %s', async (_label, fields) => {
    await seedTopics(['music', 'music'], (i) => ({ entry: i === 0 ? fields() : {} }));
    const res = await interests({ interests: 'music' }).expect(200);
    expect(F.permlinks(res.body.videos)).toEqual(['hive-v1']);
  });

  test('a moderation-hidden creator is filtered on read', async () => {
    await seedTopics(['music', 'music'], (i) => ({ owner: i === 0 ? 'hidden1' : 'shown1' }));
    await F.hideCreator(db(), 'hidden1');
    const res = await interests({ interests: 'music' }).expect(200);
    expect(res.body.videos.map((v) => v.owner)).toEqual(['shown1']);
  });
});

describe('per-viewer filtering and ordering', () => {
  test('dismissals always apply; watched videos only while hide-watched is on', async () => {
    await seedTopics(['music', 'music', 'music'], (i) => ({ owner: ['amy', 'bo', 'cy'][i] }));
    await F.dismissCreator(db(), 'fan', 'amy');
    await db().collection('watch_history').insertOne(F.watched('fan', 'bo', 'hive-v1'));

    const hideWatched = await interests({ interests: 'music', currentuser: 'fan' }).expect(200);
    const showWatched = await interests({ interests: 'music', currentuser: 'fan', hidewatched: 'false' }).expect(200);

    expect(hideWatched.body.videos.map((v) => v.owner)).toEqual(['cy']);
    expect(showWatched.body.videos.map((v) => v.owner).sort()).toEqual(['bo', 'cy']);
  });

  test('chrono=1 sorts newest first regardless of base', async () => {
    await seedTopics(['music', 'music', 'music'], (i) => ({ entry: { base: i * 10 } }));
    const res = await interests({ interests: 'music', chrono: 'true' }).expect(200);
    expect(F.permlinks(res.body.videos)).toEqual(['hive-v0', 'hive-v1', 'hive-v2']);
  });

  test('ranked mode puts a much stronger base first', async () => {
    await seedTopics(['music', 'music', 'music'], (i) => ({ entry: { base: i === 2 ? 50 : 1 } }));
    const res = await interests({ interests: 'music' }).expect(200);
    expect(res.body.videos[0].permlink).toBe('hive-v2');
  });

  test('pages are stable for a seed and the totals describe the whole feed', async () => {
    await seedTopics(Array(5).fill('music'));
    const p1 = (await interests({ interests: 'music', limit: 2, page: 1 }).expect(200)).body;
    const p3 = (await interests({ interests: 'music', limit: 2, page: 3 }).expect(200)).body;
    expect(p1).toMatchObject({ total: 5, totalPages: 3, limit: 2 });
    expect(p3.videos).toHaveLength(1);
    expect(F.permlinks(p1.videos)).not.toContain(p3.videos[0].permlink);
  });
});

describe('getInterestPool', () => {
  test('is cached for DISCOVER_POOL_CACHE_MS and re-read after it, or on force', async () => {
    await seedTopics(['music']);
    expect(await getInterestPool(db())).toHaveLength(1);

    await seedTopics(['music', 'food']);   // a second worker run adds an entry (v0 is a duplicate key)
    expect(await getInterestPool(db())).toHaveLength(1);
    expect(await getInterestPool(db(), { force: true })).toHaveLength(3);

    await db().collection('interest-pool').deleteMany({});
    F.advanceClock(DISCOVER_POOL_CACHE_MS);
    expect(await getInterestPool(db())).toEqual([]);
  });

  test('a failed read keeps serving the last good pool', async () => {
    await seedTopics(['music']);
    expect(await getInterestPool(db())).toHaveLength(1);

    const broken = { collection: () => ({ find: () => ({ toArray: async () => { throw new Error('mongo timeout'); } }) }) };
    expect(await getInterestPool(broken, { force: true })).toHaveLength(1);
  });
});
