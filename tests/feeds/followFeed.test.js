/**
 * The follow feed: GET /feed/:username (routes/videos.js) and the shared builder
 * behind it and the badge feed (utils/followFeed.js buildFollowFeed), against a
 * real MongoDB.
 *
 * The feed is a bounded recent-candidate pool from the followed accounts, ranked by
 * a recency half-life (96h) nudged by comment counts, interests and retention,
 * then paginated in memory so `total` stays exact even with hide-watched on.
 */
jest.mock('../../utils/hive', () => require('./_hiveMock').create());
// Butter Auth's hosted incubation store: who an off-chain (not yet on Hive) user follows.
const mockOffChain = new Map();
jest.mock('../../utils/incubationHosted', () => ({ followingOf: async (u) => mockOffChain.get(u) || [] }));

const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const F = require('./_fixtures');
const { buildFollowFeed } = require('../../utils/followFeed');
const hive = require('../../utils/hive');

const db = testDb.use();
const app = buildApp(['/', require('../../routes/videos')]);
const feed = (user, query = {}) => request(app).get(`/feed/${user}`).query(query);
const videos = () => db().collection('videos');
const embeds = () => db().collection('embed-video');

beforeEach(async () => {
  F.pinClock();
  hive.__reset();
  mockOffChain.clear();
  await F.resetFeedCaches(db());
});
afterEach(() => jest.useRealTimers());

describe('a viewer who follows people', () => {
  beforeEach(async () => {
    hive.__state.following.set('fan', ['leo', 'emma']);
    await videos().insertMany([
      F.legacyVideo({ owner: 'leo', permlink: 'leo-1', created: F.hoursAgo(5) }),
      F.legacyVideo({ owner: 'stranger', permlink: 'x-1', created: F.hoursAgo(1) }),
    ]);
    await embeds().insertMany([
      F.embedVideo({ owner: 'emma', permlink: 'emma-1', createdAt: F.hoursAgo(2) }),
      F.shortVideo({ owner: 'emma', permlink: 'emma-short', hive_author: 'emma', hive_permlink: 'p' }),
    ]);
  });

  test('sees only the followed accounts\' top-level videos, newest first', async () => {
    const res = await feed('fan').expect(200);

    expect(res.body).toMatchObject({ username: 'fan', feedType: 'personalized', following: 2, page: 1, limit: 20, total: 2, totalPages: 1 });
    expect(F.permlinks(res.body.videos)).toEqual(['hive-emma-1', 'leo-1']);
  });

  test('cards carry no ranking internals', async () => {
    const res = await feed('fan').expect(200);
    for (const v of res.body.videos) {
      for (const k of ['_sortDate', '_source', '_rankScore', '_embedPermlink', 'retention_mult', 'interest_match']) {
        expect(v).not.toHaveProperty(k);
      }
    }
  });

  test('watched videos are hidden, dismissed ones always', async () => {
    await db().collection('watch_history').insertOne(F.watched('fan', 'leo', 'leo-1'));
    expect(F.permlinks((await feed('fan', { currentuser: 'fan' }).expect(200)).body.videos)).toEqual(['hive-emma-1']);

    await F.dismissVideo(db(), 'fan', 'emma', 'hive-emma-1');
    const res = await feed('fan', { currentuser: 'fan', hidewatched: 0 }).expect(200);
    expect(F.permlinks(res.body.videos)).toEqual(['leo-1']);
    expect(res.body.total).toBe(1);
  });

  test('a much-discussed video outranks a slightly newer one', async () => {
    await videos().insertOne(F.legacyVideo({ owner: 'leo', permlink: 'leo-talked', created: F.hoursAgo(6) }));
    // 6h vs 2h old is a 0.97 recency ratio; a lively comment section is worth up to x1.8.
    await db().collection('video-comment-counts').insertOne({ _id: 'leo/leo-talked', comments: 40, effective: 40 });

    const res = await feed('fan').expect(200);

    expect(F.permlinks(res.body.videos)[0]).toBe('leo-talked');
  });
});

describe('who counts as followed', () => {
  test('nobody followed: the whole site, so the home page is never blank', async () => {
    await videos().insertOne(F.legacyVideo({ owner: 'anyone', permlink: 'a' }));
    await embeds().insertOne(F.embedVideo({ owner: 'someone', permlink: 's' }));

    const res = await feed('newbie').expect(200);

    expect(res.body).toMatchObject({ feedType: 'all', following: 0, total: 2 });
  });

  test('an off-chain account\'s follows come from the incubation store', async () => {
    mockOffChain.set('incubee', ['mentor']);
    await videos().insertMany([F.legacyVideo({ owner: 'mentor', permlink: 'm' }), F.legacyVideo({ owner: 'other', permlink: 'o' })]);

    const res = await feed('incubee').expect(200);

    expect(res.body).toMatchObject({ feedType: 'personalized', following: 1 });
    expect(F.permlinks(res.body.videos)).toEqual(['m']);
  });

  test.each([
    ['unpublished', { status: 'encoding' }],
    ['unlisted', { listed_on_3speak: false }],
    ['NSFW', { hive_tags: ['nsfw'] }],
    ['unavailable', { unavailable: true }],
    ['hidden from feeds', { hiddenFromFeed: true }],
    ['by a moderation-hidden creator', { owner: 'hidden1', hive_author: 'hidden1' }],
  ])('a followed creator\'s embed video that is %s is not in the feed', async (_label, over) => {
    hive.__state.following.set('fan', ['maker', 'hidden1']);
    await F.hideCreator(db(), 'hidden1');
    await embeds().insertMany([F.embedVideo({ owner: 'maker', permlink: 'ok' }), F.embedVideo({ owner: 'maker', permlink: 'no', ...over })]);
    expect(F.permlinks((await feed('fan').expect(200)).body.videos)).toEqual(['hive-ok']);
  });
});

describe('pagination', () => {
  beforeEach(async () => {
    hive.__state.following.set('fan', ['leo']);
    await videos().insertMany(Array.from({ length: 5 }, (_, i) =>
      F.legacyVideo({ owner: 'leo', permlink: `p${i}`, created: F.hoursAgo(i + 1) })));
  });

  test('pages through the ranked pool with a stable total', async () => {
    const res = await feed('fan', { limit: 2, page: 3 }).expect(200);
    expect(res.body).toMatchObject({ total: 5, totalPages: 3, page: 3, limit: 2 });
    expect(F.permlinks(res.body.videos)).toEqual(['p4']);
  });

  test.each([
    [{ limit: 500 }, 100],
    [{ limit: 0 }, 20],
    [{ limit: -1 }, 1],
  ])('limit %j is clamped to %i', async (query, limit) => {
    expect((await feed('fan', query).expect(200)).body.limit).toBe(limit);
  });
});

describe('buildFollowFeed for a badge (no fallback, chronological)', () => {
  const req = (query = {}) => ({ query, headers: {} });

  test('a badge account that follows nobody yet has an EMPTY feed, never the whole site', async () => {
    await videos().insertOne(F.legacyVideo({ owner: 'anyone', permlink: 'a' }));
    const out = await buildFollowFeed(req({ page: '2', limit: '5' }), 'badge-account', { allowFallback: false });
    expect(out).toEqual({ username: 'badge-account', feedType: 'empty', following: 0, page: 2, limit: 5, total: 0, totalPages: 0, videos: [] });
  });

  test('chronological: strictly by date, whatever the engagement nudges say', async () => {
    hive.__state.following.set('badge-account', ['holder']);
    await videos().insertMany([
      F.legacyVideo({ owner: 'holder', permlink: 'newer', created: F.hoursAgo(2) }),
      F.legacyVideo({ owner: 'holder', permlink: 'older-but-loved', created: F.hoursAgo(6) }),
    ]);
    await db().collection('video-comment-counts').insertOne({ _id: 'holder/older-but-loved', effective: 50 });

    const ranked = await buildFollowFeed(req(), 'badge-account', { allowFallback: false });
    const chrono = await buildFollowFeed(req(), 'badge-account', { allowFallback: false, chronological: true });

    expect(F.permlinks(ranked.videos)).toEqual(['older-but-loved', 'newer']);
    expect(F.permlinks(chrono.videos)).toEqual(['newer', 'older-but-loved']);
  });
});
