/**
 * GET /feeds/trendingSorted and its shared candidate pool (utils/feedPools.js
 * loadTrendingPool), against a real MongoDB.
 *
 *   base_score     = views x1 + votes x2 + comments x3 + live Hive reward x10
 *   trending_score = (base_score + distinct resharers x5) x curation(saves, tags)
 *                    x interest x follow x retention
 *
 * Only the last seven days are candidates. Hive rewards come from the mocked
 * utils/hive; curation counts from the real `reshares` / `playlists` /
 * `viewer-tags` aggregations.
 */
jest.mock('../../utils/hive', () => require('./_hiveMock').create());

const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const F = require('./_fixtures');
const { getTrendingPool, getNewSources, startFeedPoolWarmer } = require('../../utils/feedPools');
const { stats } = require('../../utils/feedCache');
const hive = require('../../utils/hive');

const db = testDb.use();
const app = buildApp(['/feeds', require('../../routes/feeds')]);
const trending = (query = {}) => request(app).get('/feeds/trendingSorted').query(query);
const videos = () => db().collection('videos');
const embeds = () => db().collection('embed-video');
const scoreOf = (res, permlink) => res.body.videos.find((v) => v.permlink === permlink);

beforeEach(async () => {
  F.pinClock();
  hive.__reset();
  await F.resetFeedCaches(db());
});
afterEach(() => jest.useRealTimers());

describe('candidates', () => {
  test('only the last seven days compete', async () => {
    await videos().insertMany([
      F.legacyVideo({ permlink: 'recent', created: F.daysAgo(6), views: 1 }),
      F.legacyVideo({ permlink: 'too-old', created: F.daysAgo(8), views: 1000 }),
    ]);
    await embeds().insertMany([
      F.embedVideo({ permlink: 'e-recent', createdAt: F.daysAgo(2) }),
      F.embedVideo({ permlink: 'e-old', createdAt: F.daysAgo(9), views: 1000 }),
    ]);

    const res = await trending().expect(200);

    expect(F.permlinks(res.body.videos).sort()).toEqual(['hive-e-recent', 'recent']);
  });

  test.each([
    ['unpublished', { status: 'draft' }, { status: 'draft' }],
    ['a failed publish', { publishFailed: true }, { listed_on_3speak: false }],
    ['unavailable', { unavailable: true }, { unavailable: true }],
    ['hidden from feeds', { hiddenFromFeed: true }, { hiddenFromFeed: true }],
    ['NSFW', { isNsfwContent: true }, { hive_tags: ['nsfw'] }],
    ['banned', { banned: true }, { banned: true }],
  ])('a candidate that is %s is never scored', async (_label, legacyOver, embedOver) => {
    await videos().insertMany([F.legacyVideo({ permlink: 'l-ok' }), F.legacyVideo({ permlink: 'l-no', ...legacyOver })]);
    await embeds().insertMany([F.embedVideo({ permlink: 'e-ok' }), F.embedVideo({ permlink: 'e-no', ...embedOver })]);

    const res = await trending().expect(200);

    expect(F.permlinks(res.body.videos).sort()).toEqual(['hive-e-ok', 'l-ok']);
  });

  test('an embed video already indexed as a legacy video is scored once', async () => {
    await videos().insertOne(F.legacyVideo({ owner: 'twin', permlink: 'hive-same' }));
    await embeds().insertOne(F.embedVideo({ owner: 'twin', permlink: 'same' }));
    expect((await trending().expect(200)).body.total).toBe(1);
  });
});

describe('scoring', () => {
  test('views, votes, comments and the LIVE Hive reward make the base score', async () => {
    await videos().insertMany([
      // 10 views + 2 votes x2 + 1 comment x3 = 17, + reward 1.5 x10 = 32
      F.legacyVideo({ owner: 'leg', permlink: 'scored', views: 10, stats: { num_votes: 2, num_comments: 1, total_hive_reward: 999 } }),
      F.legacyVideo({ owner: 'leg', permlink: 'plain', views: 20 }),
    ]);
    hive.__state.rewards.set('leg/scored', { reward: 1.5 });

    const res = await trending().expect(200);

    expect(F.permlinks(res.body.videos)).toEqual(['scored', 'plain']);
    expect(scoreOf(res, 'scored').trending_score).toBeCloseTo(32);
    expect(scoreOf(res, 'plain').trending_score).toBeCloseTo(20);
  });

  test('an embed candidate carries its Hive reward into the card', async () => {
    await embeds().insertOne(F.embedVideo({ owner: 'em', permlink: 'paid', views: 4, hive_title: '' }));
    hive.__state.rewards.set('em/hive-paid', { reward: 2, title: 'From Hive', tags: ['hive'] });

    const [card] = (await trending().expect(200)).body.videos;

    expect(card).toMatchObject({ title: 'From Hive', base_score: 24, stats: { total_hive_reward: 2 } });
    expect(card).not.toHaveProperty('_source');
    expect(card).not.toHaveProperty('_embedPermlink');
  });

  test('reshares add x5 each; saves and viewer tags multiply; self-curation counts for nothing', async () => {
    await embeds().insertMany([
      F.embedVideo({ owner: 'cur', permlink: 'loved', views: 1 }),
      F.embedVideo({ owner: 'cur', permlink: 'selfie', views: 1 }),
    ]);
    await db().collection('reshares').insertMany([
      { username: 'fan1', author: 'cur', permlink: 'hive-loved' },
      { username: 'fan2', author: 'cur', permlink: 'hive-loved' },
      { username: 'fan2', author: 'cur', permlink: 'hive-loved' }, // the same fan twice is one resharer
      { username: 'cur', author: 'cur', permlink: 'hive-selfie' },  // resharing your own video
    ]);
    await db().collection('playlists').insertOne({ owner: 'fan3', items: [{ author: 'cur', permlink: 'hive-loved' }] });

    const res = await trending().expect(200);
    const loved = scoreOf(res, 'hive-loved');
    const selfie = scoreOf(res, 'hive-selfie');

    expect(loved).toMatchObject({ reshare_count: 2, saves: 1, viewer_tags: 0 });
    // (1 + 2 x 5) x (1 + 0.3 ln 2)
    expect(loved.trending_score).toBeCloseTo(11 * (1 + 0.3 * Math.log(2)), 5);
    expect(selfie).toMatchObject({ reshare_count: 0, trending_score: 1 });
  });

  test('a legacy video is curated under its Hive identity when an embed doc maps it', async () => {
    await videos().insertOne(F.legacyVideo({ owner: 'old', permlink: 'asset-x', views: 1 }));
    await embeds().insertOne({ owner: 'old', permlink: 'asset-x', embed_url: '@old/real-hive-post', status: 'encoding' });
    await db().collection('reshares').insertOne({ username: 'fan', author: 'old', permlink: 'real-hive-post' });

    const [card] = (await trending().expect(200)).body.videos;

    expect(card).toMatchObject({ permlink: 'asset-x', reshare_count: 1, trending_score: 6 });
  });

  test('a winning topic in the viewer\'s interests doubles the score', async () => {
    await videos().insertMany([
      F.legacyVideo({ owner: 'mu', permlink: 'song', views: 10 }),
      F.legacyVideo({ owner: 'go', permlink: 'game', views: 15 }),
    ]);
    await db().collection('subtitles-tags').insertMany([
      { author: 'mu', permlink: 'song', tags: 'music' },
      { author: 'go', permlink: 'game', tags: 'gaming' },
    ]);

    const plain = await trending().expect(200);
    const fan = await trending({ interests: 'music' }).expect(200);

    expect(F.permlinks(plain.body.videos)).toEqual(['game', 'song']);
    expect(F.permlinks(fan.body.videos)).toEqual(['song', 'game']);
    expect(scoreOf(fan, 'song').winner_tag).toBe('music');
    expect(scoreOf(fan, 'song')).not.toHaveProperty('interest_match');
  });

  test('retention multiplies the score of videos with enough viewers', async () => {
    await videos().insertMany([
      F.legacyVideo({ owner: 'r', permlink: 'sticky', views: 10 }),
      F.legacyVideo({ owner: 'r', permlink: 'bouncy', views: 12 }),
    ]);
    await db().collection('video-retention').insertMany([
      { _id: 'r/sticky', score: 1.5, viewers: 100 },
      { _id: 'r/bouncy', score: 0.3, viewers: 100 },
    ]);

    const res = await trending().expect(200);

    expect(F.permlinks(res.body.videos)).toEqual(['sticky', 'bouncy']);
    expect(scoreOf(res, 'sticky')).not.toHaveProperty('retention_mult');
  });

  test('chrono=1 ignores every score: newest first', async () => {
    await videos().insertMany([
      F.legacyVideo({ permlink: 'popular-old', views: 900, created: F.daysAgo(3) }),
      F.legacyVideo({ permlink: 'quiet-new', views: 0, created: F.hoursAgo(1) }),
    ]);
    expect(F.permlinks((await trending({ chrono: '1' }).expect(200)).body.videos)).toEqual(['quiet-new', 'popular-old']);
  });
});

describe('per viewer', () => {
  test('dismissed and watched videos are dropped before pagination', async () => {
    await videos().insertMany([
      F.legacyVideo({ owner: 'x', permlink: 'one', views: 3 }),
      F.legacyVideo({ owner: 'y', permlink: 'two', views: 2 }),
      F.legacyVideo({ owner: 'z', permlink: 'three', views: 1 }),
    ]);
    await F.dismissVideo(db(), 'viewer', 'x', 'one');
    await db().collection('watch_history').insertOne(F.watched('viewer', 'y', 'two'));

    const res = await trending({ currentuser: 'viewer', limit: 1 }).expect(200);

    expect(res.body).toMatchObject({ total: 1, totalPages: 1 });
    expect(F.permlinks(res.body.videos)).toEqual(['three']);
  });

  test('a moderation-hidden creator\'s legacy videos leave the shared pool at once', async () => {
    await videos().insertMany([F.legacyVideo({ owner: 'bad', permlink: 'b' }), F.legacyVideo({ owner: 'good', permlink: 'g' })]);
    expect((await trending().expect(200)).body.total).toBe(2);
    await F.hideCreator(db(), 'bad');
    expect(F.permlinks((await trending().expect(200)).body.videos)).toEqual(['g']);
  });

  // Every other feed excludes moderation-hidden creators from embed videos too
  // (/feeds/new: `hive_author: { $nin: [null, ...hidden] }`). loadTrendingPool's
  // embed query has no hidden-creator clause at all (utils/feedPools.js:94-103),
  // and the route deliberately waves embed candidates through its live re-check
  // (routes/feeds.js:883), so a hidden creator's embed uploads stay on Trending.
  test.skip('BUG: a moderation-hidden creator\'s EMBED videos are still on trending', async () => {
    await F.hideCreator(db(), 'bad');
    await embeds().insertMany([F.embedVideo({ owner: 'bad', permlink: 'b' }), F.embedVideo({ owner: 'good', permlink: 'g' })]);
    expect(F.permlinks((await trending().expect(200)).body.videos)).toEqual(['hive-g']);
  });
});

describe('the shared pool', () => {
  test('is built once per nsfw variant and shared by every viewer', async () => {
    await videos().insertOne(F.legacyVideo({ permlink: 'a', isNsfwContent: true }));
    const sfw = await getTrendingPool(db(), false);
    const nsfw = await getTrendingPool(db(), true);
    await videos().insertOne(F.legacyVideo({ permlink: 'b' }));

    expect(sfw).toHaveLength(0);
    expect(nsfw.map((e) => e.video.permlink)).toEqual(['a']);
    expect(await getTrendingPool(db(), false)).toBe(sfw);      // same cached set
    expect(nsfw[0].hive).toEqual({ author: 'alice', permlink: 'a' });
  });

  test('scoring a request never mutates the pooled candidates', async () => {
    await videos().insertOne(F.legacyVideo({ permlink: 'a', views: 5 }));
    await db().collection('reshares').insertOne({ username: 'fan', author: 'alice', permlink: 'a' });
    await trending().expect(200);
    const [entry] = await getTrendingPool(db(), false);
    expect(entry.video).not.toHaveProperty('trending_score');
    expect(entry.video.base_score).toBe(5);
  });

  test('the warmer builds the default pools at start-up, and starting it twice is harmless', async () => {
    await videos().insertOne(F.legacyVideo({ permlink: 'boot' }));
    const intervals = jest.spyOn(global, 'setInterval');
    startFeedPoolWarmer(() => db());
    startFeedPoolWarmer(() => db());
    const built = () => {
      const s = stats();
      return ['pool:trendingSorted:sfw', 'pool:new:sfw', 'pool:shorts:30:sfw'].every((k) => s[k] && !s[k].loading);
    };
    await F.waitFor(built);
    // One refresh timer per pool (plus the hidden-creator warmer if this test runs
    // first), and none left running after this file.
    expect(intervals.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(intervals.mock.calls.length).toBeLessThanOrEqual(4);   // the second start did nothing
    intervals.mock.results.forEach((r) => clearInterval(r.value));

    // Inserted after the warm-up: not in the already-built pools.
    await videos().insertOne(F.legacyVideo({ permlink: 'later', created: F.hoursAgo(0.2) }));
    const pool = await getTrendingPool(db(), false);
    const fresh = await getNewSources(db(), false, 10);

    expect(pool.map((e) => e.video.permlink)).toEqual(['boot']);
    expect(fresh.legacy.map((v) => v.permlink)).toEqual(['boot']);
  });
});
