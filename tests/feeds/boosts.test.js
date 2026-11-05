/**
 * The per-request ranking signals the feeds multiply in:
 *   utils/followBoost.js    creators you follow (x1.6), never blocking on Hive
 *   utils/retentionRank.js  the precomputed retention multiplier per video
 *   utils/curation.js       distinct people who reshared / saved / tagged a video
 * Mongo-backed parts run against a real MongoDB; Hive is the in-memory mock.
 */
jest.mock('../../utils/hive', () => require('./_hiveMock').create());

const testDb = require('../helpers/db');
const F = require('./_fixtures');
const hive = require('../../utils/hive');
const followBoost = require('../../utils/followBoost');
const { applyRetention, defaultKey } = require('../../utils/retentionRank');
const { getCurationCounts, keyOf } = require('../../utils/curation');
const { FOLLOW_BOOST_TTL_MS, CURATION_CACHE_MS } = require('../../utils/config');

const db = testDb.use();

beforeEach(async () => {
  F.pinClock();
  hive.__reset();
  await F.resetFeedCaches(db());
});
afterEach(() => jest.useRealTimers());

const rpcCount = () => hive.__state.calls.filter(([n]) => n === 'getFollowingList').length;

describe('getFollowSet', () => {
  test.each(['', 'ab', '1abc', 'way-too-long-for-hive', 'has space', 'UNDER_score'])(
    'the unauthenticated name %p is rejected before any Hive call', (name) => {
      expect(followBoost.getFollowSet(name)).toBeNull();
      expect(rpcCount()).toBe(0);
    },
  );

  test('a cold miss answers null at once and warms in the background, one RPC per user', async () => {
    hive.__state.following.set('viewer', ['Alice', '@bob']);

    expect(followBoost.getFollowSet('@Viewer')).toBeNull();
    expect(followBoost.getFollowSet('viewer')).toBeNull();        // still warming: no second RPC
    await F.flushPromises();

    expect([...followBoost.getFollowSet('viewer')]).toEqual(['alice', 'bob']);
    expect(rpcCount()).toBe(1);
    expect(followBoost.getFollowSetForReq({ query: { currentuser: 'viewer' } })).toEqual(new Set(['alice', 'bob']));
  });

  test('a stale set is served while it refreshes', async () => {
    hive.__state.following.set('viewer', ['alice']);
    followBoost.getFollowSet('viewer');
    await F.flushPromises();

    hive.__state.following.set('viewer', ['alice', 'carol']);
    F.advanceClock(FOLLOW_BOOST_TTL_MS);
    expect([...followBoost.getFollowSet('viewer')]).toEqual(['alice']);   // stale, instantly
    await F.flushPromises();
    expect([...followBoost.getFollowSet('viewer')]).toEqual(['alice', 'carol']);
  });

  test('Hive being down means no boost, never an error', async () => {
    hive.__state.failFollowing = true;
    expect(followBoost.getFollowSet('viewer')).toBeNull();
    await F.flushPromises();
    expect(followBoost.getFollowSet('viewer')).toBeNull();
  });

  test('the cache is an LRU capped at FOLLOW_BOOST_MAX_USERS', async () => {
    let isolated;
    let isolatedHive;
    process.env.FOLLOW_BOOST_MAX_USERS = '2';
    jest.isolateModules(() => {
      isolated = require('../../utils/followBoost');
      isolatedHive = require('../../utils/hive');
    });
    delete process.env.FOLLOW_BOOST_MAX_USERS;
    for (const u of ['user1', 'user2', 'user3']) isolatedHive.__state.following.set(u, ['x']);

    for (const u of ['user1', 'user2']) isolated.getFollowSet(u);
    await F.flushPromises();
    isolated.getFollowSet('user1');          // touch: user1 is now the most recent
    isolated.getFollowSet('user3');          // a third user evicts the least recently used (user2)
    await F.flushPromises();

    expect(isolated.getFollowSet('user1')).not.toBeNull();
    expect(isolated.getFollowSet('user3')).not.toBeNull();
    expect(isolated.getFollowSet('user2')).toBeNull();
  });
});

describe('applyFollowBoost', () => {
  const videos = () => [
    { author: 'Alice', trending_score: 10 },
    { hive_author: 'bob', owner: 'uploader', trending_score: 10 },
    { owner: 'carol', trending_score: 10 },
  ];

  test('multiplies the followed Hive authors\' scores and marks them', () => {
    const v = videos();
    expect(followBoost.applyFollowBoost(v, new Set(['alice', 'bob']))).toBe(2);
    expect(v.map((x) => [x.trending_score, !!x.follow_match])).toEqual([[16, true], [16, true], [10, false]]);
  });

  test('custom score field, custom author, and the no-op cases', () => {
    const v = [{ who: 'X', s: 2 }];
    expect(followBoost.applyFollowBoost(v, new Set(['x']), { scoreField: 's', authorOf: (o) => o.who.toLowerCase(), mult: 3 })).toBe(1);
    expect(v[0].s).toBe(6);
    expect(followBoost.applyFollowBoost(videos(), null)).toBe(0);
    expect(followBoost.applyFollowBoost([], new Set(['alice']))).toBe(0);
    expect(followBoost.applyFollowBoost(videos(), new Set(['alice']), { mult: 1 })).toBe(0);
  });
});

describe('applyRetention', () => {
  test('multiplies by each video\'s bounded retention factor, keyed by owner + ASSET permlink', async () => {
    await db().collection('video-retention').insertMany([
      { _id: 'alice/asset', score: 1.5, viewers: 200 },
      { _id: 'bob/legacy', score: 0.3, viewers: 200 },
      { _id: 'carol/thin', score: null },
    ]);
    const embed = { owner: 'alice', permlink: 'hive-post', _source: 'embed', _embedPermlink: 'asset', trending_score: 10 };
    const legacy = { owner: 'bob', permlink: 'legacy', trending_score: 10 };
    const noRecord = { owner: 'dan', permlink: 'x', trending_score: 10 };
    const nullScore = { owner: 'carol', permlink: 'thin', trending_score: 10 };

    const matched = await applyRetention(db(), [embed, legacy, noRecord, nullScore]);

    expect(matched).toBe(2);
    expect(embed.trending_score).toBeGreaterThan(10);
    expect(embed).toMatchObject({ retention_relq: 1.5, retention_viewers: 200 });
    expect(legacy.trending_score).toBeLessThan(10);
    expect([noRecord, nullScore].map((v) => [v.trending_score, v.retention_mult])).toEqual([[10, 1], [10, 1]]);
  });

  test('no worker output, no keys, or a broken read: the order is left alone', async () => {
    const v = [{ owner: 'a', permlink: 'b', s: 5 }];
    expect(await applyRetention(db(), v, { scoreField: 's' })).toBe(0);
    expect(await applyRetention(db(), [{ s: 1 }])).toBe(0);
    expect(await applyRetention(db(), [])).toBe(0);
    const broken = { collection: () => ({ find: () => ({ toArray: async () => { throw new Error('down'); } }) }) };
    expect(await applyRetention(broken, v, { scoreField: 's' })).toBe(0);
    expect(v[0].s).toBe(5);
  });

  test('defaultKey uses the Hive author when there is no owner', () => {
    expect(defaultKey({ author: 'x', permlink: 'p' })).toBe('x/p');
    expect(defaultKey({ permlink: 'p' })).toBeNull();
  });
});

describe('getCurationCounts', () => {
  test('distinct people per video, self-curation dropped, author case folded', async () => {
    await db().collection('reshares').insertMany([
      { username: 'fan1', author: 'Alice', permlink: 'v' },
      { username: 'FAN1', author: 'alice', permlink: 'v' },       // the same person again
      { username: 'fan2', author: 'alice', permlink: 'v' },
      { username: 'alice', author: 'alice', permlink: 'v' },      // resharing your own
    ]);
    await db().collection('playlists').insertMany([
      { owner: 'saver', items: [{ author: 'alice', permlink: 'v' }, { author: 'saver', permlink: 'own' }] },
      { owner: 'saver', items: [{ author: 'alice', permlink: 'v' }] },     // second playlist, same saver
      { owner: 'empty', items: [] },
    ]);
    await db().collection('viewer-tags').insertMany([
      { voter: 'tagger', author: 'alice', permlink: 'v', 'viewer-tag': 'music' },
      { voter: 'alice', author: 'alice', permlink: 'v', 'viewer-tag': 'music' },
    ]);

    const map = await getCurationCounts(db());

    expect(map.get(keyOf('ALICE', 'v'))).toEqual({ reshares: 2, saves: 1, tags: 1 });
    expect(map.has('saver/own')).toBe(false);
  });

  test('cached for CURATION_CACHE_MS, re-read on force or after it', async () => {
    await db().collection('reshares').insertOne({ username: 'fan', author: 'a', permlink: 'v' });
    expect((await getCurationCounts(db())).get('a/v').reshares).toBe(1);

    await db().collection('reshares').insertOne({ username: 'fan2', author: 'a', permlink: 'v' });
    expect((await getCurationCounts(db())).get('a/v').reshares).toBe(1);
    expect((await getCurationCounts(db(), { force: true })).get('a/v').reshares).toBe(2);

    await db().collection('reshares').insertOne({ username: 'fan3', author: 'a', permlink: 'v' });
    F.advanceClock(CURATION_CACHE_MS);
    expect((await getCurationCounts(db())).get('a/v').reshares).toBe(3);
  });

  test('a broken aggregation keeps the last good map (empty when cold)', async () => {
    const warned = F.quietWarnings();
    const broken = { collection: () => ({ aggregate: () => ({ toArray: async () => { throw new Error('down'); } }) }) };
    expect((await getCurationCounts(broken)).size).toBe(0);

    await db().collection('reshares').insertOne({ username: 'fan', author: 'a', permlink: 'v' });
    await getCurationCounts(db());
    expect((await getCurationCounts(broken, { force: true })).get('a/v')).toEqual({ reshares: 1, saves: 0, tags: 0 });
    expect(warned).toHaveBeenCalled();
  });
});
