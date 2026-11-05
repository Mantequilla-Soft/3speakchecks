/**
 * Small shared utilities: the view-count cache (utils/cache.js), the HafSQL
 * client (utils/hafsql.js, with `pg` mocked: nothing connects), the comment-count
 * map behind the comment boost (utils/commentBoost.js) and the viewer tag
 * vocabulary (utils/interestTags.js).
 */
jest.mock('pg', () => {
  const pools = [];
  class Pool {
    constructor(options) {
      this.options = options;
      this.handlers = {};
      this.query = jest.fn(async () => ({ rows: [{ ok: 1 }] }));
      pools.push(this);
    }

    on(event, fn) { this.handlers[event] = fn; return this; }
  }
  return { Pool, __pools: pools };
});

const testDb = require('../helpers/db');

describe('utils/cache: view counts', () => {
  const { getCachedViews, setCachedViews, sortedShortsCache, SORTED_SHORTS_CACHE_TTL } = require('../../utils/cache');
  let now;
  beforeEach(() => {
    now = Date.parse('2026-11-01T12:00:00Z');
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  test('an unknown key is a miss', () => {
    expect(getCachedViews('nobody/nothing')).toBeNull();
  });

  test('a stored count is served for five minutes, then expires', () => {
    setCachedViews('alice/v1', 42);
    now += 5 * 60 * 1000 - 1;
    expect(getCachedViews('alice/v1')).toBe(42);
    now += 1;
    expect(getCachedViews('alice/v1')).toBeNull();
  });

  test('a zero count is a hit, not a miss', () => {
    setCachedViews('alice/zero', 0);
    expect(getCachedViews('alice/zero')).toBe(0);
  });

  test('setting again restarts the clock and replaces the value', () => {
    setCachedViews('alice/v2', 1);
    now += 4 * 60 * 1000;
    setCachedViews('alice/v2', 2);
    now += 4 * 60 * 1000;
    expect(getCachedViews('alice/v2')).toBe(2);
  });

  test('the sorted-shorts cache is a shared map with a 15-minute TTL', () => {
    expect(sortedShortsCache).toBeInstanceOf(Map);
    expect(SORTED_SHORTS_CACHE_TTL).toBe(15 * 60 * 1000);
  });
});

describe('utils/hafsql', () => {
  const OLD = {};
  const KEYS = ['HAFSQL_HOST', 'HAFSQL_PORT', 'HAFSQL_DATABASE', 'HAFSQL_USER', 'HAFSQL_PASSWORD'];
  beforeEach(() => { for (const k of KEYS) { OLD[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of KEYS) { if (OLD[k] === undefined) delete process.env[k]; else process.env[k] = OLD[k]; } });

  const fresh = () => {
    let mod;
    let pg;
    jest.isolateModules(() => {
      pg = require('pg');
      mod = require('../../utils/hafsql');
    });
    return { hafsql: mod, pools: pg.__pools };
  };

  test('defaults to the public read-only HafSQL account, created lazily and once', async () => {
    const { hafsql, pools } = fresh();
    const before = pools.length;
    await hafsql.query('SELECT 1', []);
    await hafsql.query('SELECT 2', []);
    expect(pools.length - before).toBe(1);
    const { options } = pools[pools.length - 1];
    expect(options).toMatchObject({
      host: 'hafsql-sql.mahdiyari.info', port: 5432, database: 'haf_block_log', user: 'hafsql_public', max: 4, query_timeout: 20000,
    });
  });

  test('HAFSQL_* points it at another database', async () => {
    Object.assign(process.env, { HAFSQL_HOST: '127.0.0.1', HAFSQL_PORT: '6543', HAFSQL_DATABASE: 'haf', HAFSQL_USER: 'u', HAFSQL_PASSWORD: 'p' });
    const { hafsql, pools } = fresh();
    await hafsql.query('SELECT 1');
    expect(pools[pools.length - 1].options).toMatchObject({ host: '127.0.0.1', port: 6543, database: 'haf', user: 'u', password: 'p' });
  });

  test('returns the rows; a plain query passes text and values through', async () => {
    const { hafsql, pools } = fresh();
    await expect(hafsql.query('SELECT $1::int AS ok', [1])).resolves.toEqual([{ ok: 1 }]);
    expect(pools[pools.length - 1].query).toHaveBeenCalledWith('SELECT $1::int AS ok', [1]);
  });

  test('timeoutMs lifts the read timeout for that one query only', async () => {
    const { hafsql, pools } = fresh();
    await hafsql.query('SELECT heavy($1)', ['x'], { timeoutMs: 90000 });
    expect(pools[pools.length - 1].query).toHaveBeenCalledWith({ text: 'SELECT heavy($1)', values: ['x'], query_timeout: 90000 }, undefined);
  });

  test('a query error reaches the caller', async () => {
    const { hafsql, pools } = fresh();
    await hafsql.query('SELECT 1');
    pools[pools.length - 1].query.mockRejectedValueOnce(new Error('statement timeout'));
    await expect(hafsql.query('SELECT 1')).rejects.toThrow('statement timeout');
  });

  test('a dropped idle connection is logged, never thrown', async () => {
    const { hafsql, pools } = fresh();
    await hafsql.query('SELECT 1');
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => pools[pools.length - 1].handlers.error(new Error('Connection terminated'))).not.toThrow();
    expect(spy).toHaveBeenCalledWith('[hafsql] pool error:', 'Connection terminated');
  });
});

describe('utils/commentBoost: the cached comment-count map', () => {
  const db = testDb.use();
  const { getCommentCounts, invalidate, keyOf, COLLECTION } = require('../../utils/commentBoost');
  let now;
  beforeEach(() => {
    invalidate();
    now = Date.parse('2026-11-01T12:00:00Z');
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  test('keys are lower-cased author plus permlink as stored', () => {
    expect(keyOf('Alice', 'My-Video')).toBe('alice/My-Video');
    expect(keyOf(undefined, 'p')).toBe('/p');
  });

  test('reads the whole collection into a map keyed by _id', async () => {
    await db().collection(COLLECTION).insertMany([
      { _id: 'alice/v1', comments: 3, native3Speak: 1, effective: 3.5, extra: 'not projected' },
      { _id: 'bob/v2', comments: 0, native3Speak: 0, effective: 0 },
    ]);
    const map = await getCommentCounts(db());
    expect([...map.keys()].sort()).toEqual(['alice/v1', 'bob/v2']);
    expect(map.get('alice/v1')).toEqual({ _id: 'alice/v1', comments: 3, native3Speak: 1, effective: 3.5 });
  });

  test('serves the cached map until the TTL runs out, then re-reads', async () => {
    const col = db().collection(COLLECTION);
    await col.insertOne({ _id: 'alice/v1', effective: 1 });
    await getCommentCounts(db());
    await col.insertOne({ _id: 'bob/v2', effective: 2 });

    now += 5 * 60 * 1000 - 1;
    expect((await getCommentCounts(db())).has('bob/v2')).toBe(false);
    now += 1;
    expect((await getCommentCounts(db())).has('bob/v2')).toBe(true);
  });

  test('force skips the cache (what the discover worker uses)', async () => {
    const col = db().collection(COLLECTION);
    await col.insertOne({ _id: 'alice/v1', effective: 1 });
    await getCommentCounts(db());
    await col.insertOne({ _id: 'bob/v2', effective: 2 });
    expect((await getCommentCounts(db(), { force: true })).size).toBe(2);
  });

  test('an empty collection is never cached as a hit: the next call reads again', async () => {
    expect((await getCommentCounts(db())).size).toBe(0);
    await db().collection(COLLECTION).insertOne({ _id: 'alice/v1', effective: 1 });
    expect((await getCommentCounts(db())).size).toBe(1);
  });

  test('a read failure serves the stale map; a cold failure is an empty map', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = { collection: () => ({ find: () => ({ toArray: async () => { throw new Error('mongo down'); } }) }) };
    expect((await getCommentCounts(broken)).size).toBe(0);

    await db().collection(COLLECTION).insertOne({ _id: 'alice/v1', effective: 1 });
    await getCommentCounts(db());
    now += 10 * 60 * 1000;
    const stale = await getCommentCounts(broken);
    expect(stale.get('alice/v1')).toMatchObject({ effective: 1 });
  });

  test('switched off by config: always neutral and never reads', async () => {
    let mod;
    jest.isolateModules(() => {
      jest.doMock('../../utils/config', () => ({ ...jest.requireActual('../../utils/config'), COMMENT_BOOST_ENABLED: false }));
      mod = require('../../utils/commentBoost');
    });
    const find = jest.fn();
    expect(mod.commentBoost(50)).toBe(1);
    expect((await mod.getCommentCounts({ collection: () => ({ find }) })).size).toBe(0);
    expect(find).not.toHaveBeenCalled();
  });

  test('weight and cap can be overridden per call', () => {
    const { commentBoost } = require('../../utils/commentBoost');
    expect(commentBoost(10, { weight: 0, cap: 5 })).toBe(1);
    expect(commentBoost(1e9, { weight: 1, cap: 2.5 })).toBe(2.5);
  });
});

describe('utils/interestTags: the viewer tag vocabulary', () => {
  const {
    normalizeInterestTag, expandTag, isCategoryTag, INTEREST_TAGS, TAGS_V2_TREE, TAGS_V2_TOPICS, LEGACY_INTEREST_TAGS,
  } = require('../../utils/interestTags');

  test.each([
    ['Music', 'music'],
    ['  #gaming ', 'gaming'],
    ['tech-science', 'tech-science'], // a category is a tag in its own right
    ['vlog', 'vlog'],                 // viewer-only extra
    ['tutorial', 'tutorial'],         // v1 only, still accepted for the old picker
    ['programming', 'programming'],   // v2 only (lost in the first v2 rollout)
  ])('%p is accepted as %p', (raw, tag) => {
    expect(normalizeInterestTag(raw)).toBe(tag);
  });

  test.each([['memes'], [''], [null], [undefined], ['music videos'], ['##music']])('%p is rejected', (raw) => {
    expect(normalizeInterestTag(raw)).toBeNull();
  });

  test('a category expands to itself plus every topic under it; anything else to itself', () => {
    expect(expandTag('Sports-Health')).toEqual(['sports-health', 'sports', 'health', 'fitness']);
    expect(expandTag(' music ')).toEqual(['music']);
    expect(expandTag(undefined)).toEqual(['']);
  });

  test('isCategoryTag knows the seven categories only', () => {
    expect(Object.keys(TAGS_V2_TREE)).toHaveLength(7);
    for (const c of Object.keys(TAGS_V2_TREE)) expect(isCategoryTag(c.toUpperCase())).toBe(true);
    expect(isCategoryTag('music')).toBe(false);
    expect(isCategoryTag('constructor')).toBe(false); // no prototype keys
    expect(isCategoryTag(null)).toBe(false);
  });

  test('the accepted list is the de-duplicated union of v2 and v1', () => {
    expect(new Set(INTEREST_TAGS).size).toBe(INTEREST_TAGS.length);
    for (const t of [...TAGS_V2_TOPICS, ...LEGACY_INTEREST_TAGS]) expect(INTEREST_TAGS).toContain(t);
  });
});
