/**
 * utils/db.js: the connection and the indexes it builds on boot.
 *
 * The indexes are behaviour, not decoration: the social-link unique index is what
 * stops one channel being claimed twice by a race, the TTL index is what expires
 * unverified claims, and the ranking indexes keep feed reads off collection scans.
 * All of it runs against this worker's throwaway MongoDB.
 */
const testDb = require('../helpers/db');
const { SOCIAL_LINKS_COLLECTION, UNVERIFIED_TTL_DAYS, DATABASE_NAME } = require('../../utils/config');
const searchWeights = require('../../config/search-weights.json');

const db = testDb.use();

// A second, private copy of utils/db (its own client), for the boot paths that
// would disturb the shared one. Always closed again.
async function withFreshDb(fn, { mocks } = {}) {
  let mod;
  jest.isolateModules(() => {
    if (mocks) mocks();
    mod = require('../../utils/db');
  });
  try {
    return await fn(mod);
  } finally {
    await mod.closeMongo();
  }
}

const indexNames = async (coll) => (await db().collection(coll).indexes()).map((i) => i.name);

// connectToMongo builds its indexes in the background and does not wait for them;
// closeMongo does. One full boot-and-close here means every index exists before the
// first test looks for it.
beforeAll(() => withFreshDb((mod) => mod.connectToMongo()), 60000);

describe('the boot indexes', () => {
  test('getDb is the configured database and getLinksCollection the social links', () => {
    const { getDb, getLinksCollection } = require('../../utils/db');
    expect(getDb().databaseName).toBe(DATABASE_NAME);
    expect(getLinksCollection().collectionName).toBe(SOCIAL_LINKS_COLLECTION);
  });

  test('social links: one row per user, platform and channel', async () => {
    const links = db().collection(SOCIAL_LINKS_COLLECTION);
    const row = { hive_username: 'alice', platform: 'youtube', platform_username: 'UCx', verified: true, first_seen: new Date() };
    await links.insertOne({ ...row });
    await expect(links.insertOne({ ...row })).rejects.toThrow(/duplicate key/);
    await expect(links.insertOne({ ...row, hive_username: 'bob' })).resolves.toBeTruthy();
  });

  test('unverified claims expire after UNVERIFIED_TTL_DAYS; verified ones never do', async () => {
    const ttl = (await db().collection(SOCIAL_LINKS_COLLECTION).indexes()).find((i) => i.name === 'social_link_unverified_ttl');
    expect(ttl).toMatchObject({
      key: { first_seen: 1 },
      expireAfterSeconds: UNVERIFIED_TTL_DAYS * 86400,
      partialFilterExpression: { verified: false },
    });
  });

  test('every text-search index from config/search-weights.json exists with its weights', async () => {
    for (const cfg of Object.values(searchWeights)) {
      const idx = (await db().collection(cfg.collection).indexes()).find((i) => i.name === cfg.indexName);
      expect(idx).toBeDefined();
      expect(idx.weights).toEqual(cfg.fields);
      if (cfg.languageOverride) expect(idx.language_override).toBe(cfg.languageOverride);
    }
  });

  test.each([
    ['subtitles-tags', 'author_1_permlink_1'],
    ['view-durations', 'owner_1_permlink_1'],
    ['view-durations', 'updatedAt_1'],
    ['user-hidden-creators', 'username_1'],
    ['contentcreators', 'hidden_1'],
    ['stream-boosts', 'sender_1'],
    ['videos', 'community_1_views_-1'],
    ['embed-video', 'story_posted_at_1'],
  ])('ranking index on %s: %s', async (coll, name) => {
    expect(await indexNames(coll)).toContain(name);
  });

  test('the stories index is partial: only rows that ever were a story', async () => {
    const idx = (await db().collection('embed-video').indexes()).find((i) => i.name === 'story_posted_at_1');
    expect(idx.partialFilterExpression).toEqual({ story_posted_at: { $exists: true } });
  });
});

describe('a second boot against an existing database', () => {
  test('is idempotent: the same indexes, nothing duplicated', async () => {
    const before = await indexNames(SOCIAL_LINKS_COLLECTION);
    await withFreshDb(async (mod) => { await mod.connectToMongo(); });
    expect(await indexNames(SOCIAL_LINKS_COLLECTION)).toEqual(before);
  });

  test('a TTL index with an outdated expiry is replaced by the configured one', async () => {
    const links = db().collection(SOCIAL_LINKS_COLLECTION);
    await links.dropIndex('social_link_unverified_ttl');
    await links.createIndex({ first_seen: 1 }, { name: 'social_link_unverified_ttl', expireAfterSeconds: 60, partialFilterExpression: { verified: false } });
    await withFreshDb(async (mod) => { await mod.connectToMongo(); });
    const ttl = (await links.indexes()).find((i) => i.name === 'social_link_unverified_ttl');
    expect(ttl.expireAfterSeconds).toBe(UNVERIFIED_TTL_DAYS * 86400);
  });

  test('a text index with other weights is dropped and rebuilt (only one text index is allowed)', async () => {
    const cfg = searchWeights.embedAudio;
    const coll = db().collection(cfg.collection);
    await coll.dropIndex(cfg.indexName);
    await coll.createIndex({ title: 'text' }, { name: 'old_text_index' });
    await withFreshDb(async (mod) => { await mod.connectToMongo(); });
    const names = (await coll.indexes()).map((i) => i.name);
    expect(names).toContain(cfg.indexName);
    expect(names).not.toContain('old_text_index');
  });

  test('an index that cannot be built is logged and never takes the boot down', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    // Two identical claims make the unique social-link index impossible to build.
    const links = db().collection(SOCIAL_LINKS_COLLECTION);
    await links.dropIndex('social_link_unique');
    const row = { hive_username: 'alice', platform: 'youtube', platform_username: 'UCx', verified: true };
    await links.insertMany([{ ...row }, { ...row }]);
    await withFreshDb(async (mod) => {
      await mod.connectToMongo();
      expect(mod.getDb().databaseName).toBe(DATABASE_NAME);
    });
    expect(errors.mock.calls.flat().join(' ')).toMatch(/social-link indexes/i);
    // Put the index back for the tests after this one.
    await links.deleteMany({});
    await links.createIndex({ hive_username: 1, platform: 1, platform_username: 1 }, { unique: true, name: 'social_link_unique' });
  });
});

describe('connection failure', () => {
  test('exits the process rather than serving without a database', async () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await withFreshDb(async (mod) => {
      await mod.connectToMongo();
      expect(exit).toHaveBeenCalledWith(1);
      expect(mod.getDb()).toBeUndefined();
    }, {
      mocks: () => jest.doMock('mongodb', () => ({
        MongoClient: class { connect() { return Promise.reject(new Error('ECONNREFUSED')); } },
      })),
    });
  });

  test('the pool size comes from MONGO_MAX_POOL_SIZE, 75 by default', async () => {
    const seen = [];
    const mocks = () => jest.doMock('mongodb', () => ({
      MongoClient: class {
        constructor(_uri, opts) { seen.push(opts.maxPoolSize); }

        connect() { return Promise.reject(new Error('stop here')); }
      },
    }));
    jest.spyOn(process, 'exit').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await withFreshDb((mod) => mod.connectToMongo(), { mocks });
    process.env.MONGO_MAX_POOL_SIZE = '12';
    try {
      await withFreshDb((mod) => mod.connectToMongo(), { mocks });
    } finally {
      delete process.env.MONGO_MAX_POOL_SIZE;
    }
    expect(seen).toEqual([75, 12]);
  });

  test('closeMongo without a connection is harmless', async () => {
    await withFreshDb(async () => {});
  });
});
