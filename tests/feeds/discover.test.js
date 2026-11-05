/**
 * GET /feeds/discover, against a real MongoDB.
 *
 * Discover ranks the precomputed discover pool (utils/discoverPool.js) with a
 * seeded weighted draw, composes the page by age band and interest share, then
 * hydrates only the page slice into cards. These tests pin what a viewer can rely
 * on: what is never shown, that a seed gives stable pages, and which per-viewer
 * signals apply.
 */
jest.mock('../../utils/hive', () => require('./_hiveMock').create());

const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const F = require('./_fixtures');
const { DISCOVER_POOL_CACHE_MS } = require('../../utils/config');
const { getFollowSet } = require('../../utils/followBoost');
const hive = require('../../utils/hive');

const db = testDb.use();
const app = buildApp(['/feeds', require('../../routes/feeds')]);
const discover = (query = {}) => request(app).get('/feeds/discover').query({ seed: 42, ...query });

beforeEach(async () => {
  F.pinClock();
  hive.__reset();
  await F.resetFeedCaches(db());
});
afterEach(() => jest.useRealTimers());

/** n pooled embed videos named v0..v(n-1), created one hour apart (v0 newest). */
async function seedMany(n, over = () => ({})) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const extra = over(i);
    out.push(await F.seedPooled(db(), {
      video: { owner: extra.owner || `creator${i}`, permlink: `v${i}`, createdAt: F.hoursAgo(i + 1), ...extra.video },
      entry: extra.entry || {},
    }));
  }
  return out;
}

describe('an empty or missing pool', () => {
  test('answers an empty feed with the seed, not an error', async () => {
    const res = await discover().expect(200);
    expect(res.body).toMatchObject({ success: true, feed: 'discover', total: 0, totalPages: 0, seed: 42, videos: [] });
  });
});

describe('cards', () => {
  test('a pooled embed video is hydrated into a feed card keyed by its Hive post', async () => {
    await F.seedPooled(db(), { video: { owner: 'alice', permlink: 'asset-a', hive_title: 'Hello', gated: true } });

    const res = await discover().expect(200);

    expect(res.body.poolSize).toBe(1);
    expect(res.body.total).toBe(1);
    const [card] = res.body.videos;
    expect(card).toMatchObject({
      owner: 'alice',
      author: 'alice',
      permlink: 'hive-asset-a',
      title: 'Hello',
      status: 'published',
      gated: true,
      spkvideo: { video_v2: 'asset-a', play_url: 'https://ipfs.3speak.tv/ipfs/cid-asset-a' },
    });
    expect(card).not.toHaveProperty('_pool');
    expect(card).not.toHaveProperty('discover_score'); // scoring internals only with debug=1
  });

  test('a pooled legacy video comes back as its own videos doc', async () => {
    await db().collection('videos').insertOne(F.legacyVideo({ owner: 'bob', permlink: 'old-one', title: 'Legacy' }));
    await db().collection('discover-pool').insertOne(F.legacyPoolEntry({ owner: 'bob', permlink: 'old-one' }));

    const res = await discover().expect(200);

    expect(res.body.videos).toHaveLength(1);
    expect(res.body.videos[0]).toMatchObject({ owner: 'bob', permlink: 'old-one', title: 'Legacy' });
  });

  test('a pool entry whose video has since vanished is skipped rather than rendered empty', async () => {
    await db().collection('discover-pool').insertOne(F.poolEntry({ assetPermlink: 'gone' }));
    const res = await discover().expect(200);
    expect(res.body.videos).toEqual([]);
  });

  test('debug=1 exposes the scoring inputs of every card', async () => {
    await F.seedPooled(db(), { entry: { base: 0.8, winnerTag: 'music', src: 'random-old', curationBoost: 1.2 } });

    const [card] = (await discover({ debug: 1 }).expect(200)).body.videos;

    expect(card.discover_score).toEqual(expect.any(Number));
    expect(card).toMatchObject({ base: 0.8, winnerTag: 'music', pool_src: 'random-old', curation_boost: 1.2, follow_match: false });
    expect(card.age_hours).toBeCloseTo(1, 0);
  });
});

describe('what discover never shows', () => {
  test('NSFW entries are dropped unless the viewer opted in', async () => {
    await seedMany(3, (i) => ({ entry: { nsfw: i === 1 } }));

    const sfw = await discover().expect(200);
    const all = await discover({ nsfw: 'true' }).expect(200);

    expect(F.permlinks(sfw.body.videos).sort()).toEqual(['hive-v0', 'hive-v2']);
    expect(all.body.total).toBe(3);
  });

  test.each([
    // Functions, so the dates are taken from the pinned clock, not at load time.
    ['unavailable media', () => ({ unavailable: true })],
    ['the author hid it from feeds', () => ({ hiddenFromFeed: true })],
    ['an expired story', () => ({ story: true, story_expires_at: F.hoursAgo(1) })],
    ['older than the one-year recommendation bound', () => ({ created: F.daysAgo(400) })],
  ])('a pool entry is excluded when %s', async (_label, entryFields) => {
    await seedMany(2, (i) => ({ entry: i === 0 ? entryFields() : {} }));

    const res = await discover().expect(200);

    expect(F.permlinks(res.body.videos)).toEqual(['hive-v1']);
    expect(res.body.poolSize).toBe(1);
  });

  test('a video the author hides AFTER the pool was built is dropped at hydrate time', async () => {
    await seedMany(2);
    await db().collection('embed-video').updateOne({ permlink: 'v0' }, { $set: { hiddenFromFeed: true } });

    const res = await discover().expect(200);

    expect(F.permlinks(res.body.videos)).toEqual(['hive-v1']);
  });

  test('a creator hidden by moderation disappears on the next request, without a pool rebuild', async () => {
    await seedMany(2, (i) => ({ owner: i === 0 ? 'spammer' : 'fine' }));
    expect((await discover().expect(200)).body.total).toBe(2);

    await F.hideCreator(db(), 'spammer');

    const res = await discover().expect(200);
    expect(res.body.videos.map((v) => v.owner)).toEqual(['fine']);
  });
});

describe('per-viewer filtering (?currentuser=)', () => {
  beforeEach(async () => {
    await seedMany(4, (i) => ({ owner: ['ann', 'ben', 'cat', 'dan'][i] }));
  });

  test('dismissed creators and dismissed videos are always removed, before pagination', async () => {
    await F.dismissCreator(db(), 'viewer', 'ann');
    await F.dismissVideo(db(), 'viewer', 'ben', 'hive-v1');

    const res = await discover({ currentuser: 'viewer', hidewatched: 0 }).expect(200);

    expect(res.body.total).toBe(2);
    expect(res.body.videos.map((v) => v.owner).sort()).toEqual(['cat', 'dan']);
  });

  test('watched videos are hidden by default and kept with hidewatched=0', async () => {
    await db().collection('watch_history').insertOne(F.watched('viewer', 'cat', 'hive-v2'));

    const hidden = await discover({ currentuser: 'viewer' }).expect(200);
    const kept = await discover({ currentuser: 'viewer', hidewatched: '0' }).expect(200);

    expect(hidden.body.videos.map((v) => v.owner)).not.toContain('cat');
    expect(hidden.body.total).toBe(3);
    expect(kept.body.total).toBe(4);
  });

  test('a viewer\'s dismissals never leak into another viewer\'s feed', async () => {
    await F.dismissCreator(db(), 'someone-else', 'ann');
    const res = await discover({ currentuser: 'viewer' }).expect(200);
    expect(res.body.total).toBe(4);
  });

  test('a followed creator is boosted, never filtered in or out', async () => {
    hive.__state.following.set('viewer', ['dan']);
    getFollowSet('viewer');          // a cold miss warms the follow set in the background
    await F.flushPromises();

    const res = await discover({ currentuser: 'viewer', hidewatched: 0, debug: 1 }).expect(200);

    expect(res.body.total).toBe(4);
    const byOwner = Object.fromEntries(res.body.videos.map((v) => [v.owner, v]));
    expect(byOwner.dan.follow_match).toBe(true);
    expect(byOwner.ann.follow_match).toBe(false);
    // Equal base: the x1.6 follow boost outweighs the widest possible jitter gap.
    for (const other of ['ann', 'ben', 'cat']) {
      expect(byOwner.dan.discover_score).toBeGreaterThan(byOwner[other].discover_score);
    }
  });
});

describe('interests', () => {
  test('interestsOnly without interests is an empty Interests feed', async () => {
    await seedMany(2);
    const res = await discover({ interestsOnly: 1 }).expect(200);
    expect(res.body).toMatchObject({ feed: 'interests', total: 0, videos: [] });
  });

  test('interestsOnly keeps only matches, and a CATEGORY pick keeps its topics', async () => {
    const tags = ['technology', 'science', 'music', null];
    await seedMany(4, (i) => ({ entry: { winnerTag: tags[i] } }));

    const byTopic = await discover({ interestsOnly: 1, interests: 'music' }).expect(200);
    const byCategory = await discover({ interestsOnly: 'true', interests: 'tech-science' }).expect(200);

    expect(F.permlinks(byTopic.body.videos)).toEqual(['hive-v2']);
    expect(byCategory.body.feed).toBe('interests');
    expect(F.permlinks(byCategory.body.videos).sort()).toEqual(['hive-v0', 'hive-v1']);
  });

  test('without interestsOnly, matches lead the page but nothing is filtered out', async () => {
    // Ten videos, the only music one is the OLDEST and has the weakest base. The
    // others are about food: outside music's neighbourhood, so not even a sibling.
    await seedMany(10, (i) => ({ entry: { winnerTag: i === 9 ? 'music' : 'food', base: i === 9 ? 0.2 : 1 } }));

    const res = await discover({ interests: 'music', debug: 1 }).expect(200);

    expect(res.body.total).toBe(10);
    expect(res.body.videos[0].winnerTag).toBe('music');   // the interest share claims slot 1
    expect(res.body.videos[0].interest_match).toBe(true);
  });
});

describe('ordering and pagination', () => {
  test('one seed gives stable, disjoint pages that together cover the whole feed', async () => {
    await seedMany(7);

    const pages = [];
    for (const page of [1, 2, 3]) pages.push((await discover({ seed: 7, limit: 3, page }).expect(200)).body);

    expect(pages.map((p) => p.videos.length)).toEqual([3, 3, 1]);
    expect(pages[0]).toMatchObject({ total: 7, totalPages: 3, page: 1, limit: 3, seed: 7 });
    const seen = pages.flatMap((p) => F.permlinks(p.videos));
    expect(new Set(seen).size).toBe(7);
    // The same request again is the same page.
    const again = (await discover({ seed: 7, limit: 3, page: 2 }).expect(200)).body;
    expect(F.permlinks(again.videos)).toEqual(F.permlinks(pages[1].videos));
  });

  test('a page past the end is empty but still reports the real total', async () => {
    await seedMany(2);
    const res = await discover({ page: 5, limit: 10 }).expect(200);
    expect(res.body).toMatchObject({ total: 2, totalPages: 1, page: 5, videos: [] });
  });

  test('chrono=1 turns the algorithm off: strictly newest first', async () => {
    await seedMany(5, (i) => ({ entry: { base: i } }));   // the OLDEST has the highest base
    const res = await discover({ chrono: 1 }).expect(200);
    expect(F.permlinks(res.body.videos)).toEqual(['hive-v0', 'hive-v1', 'hive-v2', 'hive-v3', 'hive-v4']);
  });

  test('without ?seed a five-minute bucket is used, so a refresh keeps the order', async () => {
    await seedMany(3);
    const a = await request(app).get('/feeds/discover').expect(200);
    const b = await request(app).get('/feeds/discover').expect(200);
    expect(a.body.seed).toBe(Math.floor(Date.now() / (5 * 60 * 1000)));
    expect(F.permlinks(b.body.videos)).toEqual(F.permlinks(a.body.videos));
  });

  test.each([
    [{ limit: 1000 }, 100, 1],
    [{ limit: 0 }, 30, 1],
    [{ limit: -4 }, 1, 1],
    [{ limit: 'abc', page: 'x' }, 30, 1],
    [{ page: -3 }, 30, 1],
  ])('query %j is clamped to limit %i, page %i', async (query, limit, page) => {
    const res = await discover(query).expect(200);
    expect(res.body).toMatchObject({ limit, page });
  });
});

describe('the in-process pool cache', () => {
  test('a pool rebuild becomes visible once the cache TTL has passed', async () => {
    await seedMany(1);
    expect((await discover().expect(200)).body.total).toBe(1);

    await F.seedPooled(db(), { video: { owner: 'late', permlink: 'late-one' } });
    expect((await discover().expect(200)).body.total).toBe(1);   // still the cached pool

    F.advanceClock(DISCOVER_POOL_CACHE_MS);
    expect((await discover().expect(200)).body.total).toBe(2);
  });
});
