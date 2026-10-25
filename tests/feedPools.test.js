/**
 * feedPools: a shared pool must answer exactly what the old per-request query
 * answered -- the first n of each source, hidden creators re-applied live -- and go
 * back to Mongo whenever the pool can't be sure (deep pages, a full pool cut short).
 */
const mockHidden = { list: [] };
jest.mock('../utils/hiddenCreators', () => ({ hiddenListSync: () => mockHidden.list }));
const mockRep = new Map();
jest.mock('../utils/hive', () => ({
  fetchHiveRewards: async () => new Map(),
  reputationCache: { get: (u) => mockRep.get(u) },
}));

const { invalidate } = require('../utils/feedCache');
const { NEW_POOL_SIZE } = require('../utils/config');
const { getNewSources, loadShortsPool } = require('../utils/feedPools');

// A fake db whose find() honours $nin on owner / hive_author, sort is ignored (the
// fixtures are already newest first) and limit is applied. Counts every query.
function fakeDb(collections) {
  const calls = [];
  const db = {
    calls,
    collection: (name) => ({
      find: (query) => {
        let n = Infinity;
        const cursor = {
          sort: () => cursor,
          limit: (k) => { n = k; return cursor; },
          toArray: async () => {
            calls.push({ name, limit: n });
            const ninOf = (f) => (query[f] && query[f].$nin) || [];
            return (collections[name] || [])
              .filter((d) => !ninOf('owner').includes(d.owner) && !ninOf('hive_author').includes(d.hive_author))
              .slice(0, n);
          },
        };
        return cursor;
      },
    }),
  };
  return db;
}

const legacyDocs = (k, owner = (i) => `u${i % 7}`) =>
  Array.from({ length: k }, (_, i) => ({ owner: owner(i), permlink: `l${i}`, created: new Date(2026, 9, 1, 0, 0, k - i) }));
const embedDocs = (k) =>
  Array.from({ length: k }, (_, i) => ({ owner: `e${i}`, hive_author: `e${i}`, hive_permlink: `p${i}`, permlink: `x${i}`, createdAt: new Date(2026, 9, 1, 0, 0, k - i) }));

beforeEach(() => { invalidate(); mockHidden.list = []; mockRep.clear(); });

test('the first n of each source come from the pool, Mongo is hit once', async () => {
  const db = fakeDb({ videos: legacyDocs(30), 'embed-video': embedDocs(30) });
  const a = await getNewSources(db, false, 20);
  const b = await getNewSources(db, false, 10);
  expect(a.legacy.map((v) => v.permlink)).toEqual(legacyDocs(20).map((v) => v.permlink));
  expect(b.embed.map((v) => v.permlink)).toEqual(embedDocs(10).map((v) => v.hive_permlink));
  expect(db.calls).toHaveLength(2);                     // one load: legacy + embed
  expect(db.calls.every((c) => c.limit === NEW_POOL_SIZE)).toBe(true);
});

test('a creator hidden AFTER the pool loaded is dropped on the next request', async () => {
  const db = fakeDb({ videos: legacyDocs(30), 'embed-video': embedDocs(30) });
  await getNewSources(db, false, 20);
  mockHidden.list = ['u3', 'e2'];
  const r = await getNewSources(db, false, 20);
  expect(r.legacy.some((v) => v.owner === 'u3')).toBe(false);
  expect(r.embed.some((v) => v.author === 'e2')).toBe(false);
  expect(r.legacy).toHaveLength(20);                    // pool isn't full, so it holds everything
  expect(db.calls).toHaveLength(2);
});

test('a FULL pool cut short by a newly hidden creator goes back to Mongo', async () => {
  // Every 2nd legacy video is u1's. With the pool exactly full, hiding u1 leaves it
  // holding half of what the page needs, and the rest was never fetched.
  const db = fakeDb({ videos: legacyDocs(NEW_POOL_SIZE * 2, (i) => (i % 2 ? 'u1' : 'u0')), 'embed-video': [] });
  await getNewSources(db, false, NEW_POOL_SIZE);
  mockHidden.list = ['u1'];
  const r = await getNewSources(db, false, NEW_POOL_SIZE);
  expect(r.legacy).toHaveLength(NEW_POOL_SIZE);
  expect(r.legacy.every((v) => v.owner === 'u0')).toBe(true);
  expect(db.calls.slice(2).map((c) => c.limit)).toEqual([NEW_POOL_SIZE, NEW_POOL_SIZE]);
});

test('pages deeper than the pool go straight to Mongo with the real limit', async () => {
  const db = fakeDb({ videos: legacyDocs(10), 'embed-video': [] });
  await getNewSources(db, false, NEW_POOL_SIZE + 50);
  expect(db.calls.map((c) => c.limit)).toEqual([NEW_POOL_SIZE + 50, NEW_POOL_SIZE + 50]);
});

test('nsfw on and off are separate pools', async () => {
  const db = fakeDb({ videos: legacyDocs(5), 'embed-video': [] });
  await getNewSources(db, false, 5);
  await getNewSources(db, true, 5);
  await getNewSources(db, false, 5);
  expect(db.calls).toHaveLength(4);
});

test('shorts pool flags low-reputation authors instead of dropping them', async () => {
  // The route drops them AFTER dedup, as before; dropping them here would let an
  // older duplicate of the same owner+thumbnail survive in their place.
  mockRep.set('spammer', { reputation: 10 });
  mockRep.set('fine', { reputation: 50 });
  const db = fakeDb({
    'embed-video': [
      { owner: 'spammer', permlink: 'a', embed_url: '@spammer/a', createdAt: new Date() },
      { owner: 'fine', permlink: 'b', embed_url: '@fine/b', createdAt: new Date() },
    ],
  });
  const { shorts, lowRep } = await loadShortsPool(db, 14, false);
  expect(shorts.map((s) => s.permlink)).toEqual(['a', 'b']);
  expect([...lowRep].map((s) => s.permlink)).toEqual(['a']);
  expect(shorts[1].hive_title).toBe('');                // hive fields attached
});
