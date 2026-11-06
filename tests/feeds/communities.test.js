/**
 * The community directory routes (routes/communities.js) against a real MongoDB:
 *   POST /community/created     index a community the moment it is created (chain-verified)
 *   GET  /communities/search    substring search over every community, held in memory
 *   GET  /community/:name       full metadata, cached a day, backfilled from Hive
 *
 * Hive's bridge.get_community is answered by a stubbed fetch; the indexing service
 * (services/communitySync.js) is mocked, it has tests of its own elsewhere.
 */
jest.mock('../../utils/hive', () => require('./_hiveMock').create());
const mockIndexed = new Set();
jest.mock('../../services/communitySync', () => ({
  indexOneCommunity: async (name) => {
    if (name === 'hive-500500') throw new Error('rpc exploded');
    return mockIndexed.has(name);
  },
}));

const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const F = require('./_fixtures');

const db = testDb.use();
const app = buildApp(['/', require('../../routes/communities')]);
const details = () => db().collection('community_details');

/** Answer Hive's bridge.get_community with `result` (null = unknown community). */
function stubHive(result) {
  const calls = [];
  jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 });
  });
  return calls;
}

beforeEach(async () => {
  F.pinClock();
  mockIndexed.clear();
  await F.resetFeedCaches(db());
});
afterEach(() => jest.useRealTimers());

describe('POST /community/created', () => {
  test.each(['', 'hive-12', 'gaming', 'hive-123456789'])('rejects the name %p', async (name) => {
    expect((await request(app).post('/community/created').send({ name }).expect(400)).body).toEqual({ error: 'Invalid community name' });
  });

  test('indexes a community that exists on Hive, and refuses one that does not', async () => {
    mockIndexed.add('hive-123456');
    expect((await request(app).post('/community/created').send({ name: ' HIVE-123456 ' }).expect(200)).body).toEqual({ ok: true, name: 'hive-123456' });
    expect((await request(app).post('/community/created').send({ name: 'hive-654321' }).expect(404)).body).toEqual({ error: 'No such community on Hive' });
  });

  test('an indexing failure is a 500', async () => {
    const logged = F.quietErrors();
    await request(app).post('/community/created').send({ name: 'hive-500500' }).expect(500);
    expect(logged).toHaveBeenCalled();
  });
});

describe('GET /communities/search', () => {
  beforeEach(async () => {
    await db().collection('hivecommunities').insertMany([
      { name: 'hive-1', title: 'Gaming Philippines', about: 'pinoy gamers', subscribers: 50 },
      { name: 'hive-2', title: 'Retro', about: 'retro gaming and more', subscribers: 900 },
      { name: 'hive-3', title: 'Gaming World', about: '', subscribers: 10 },
      { name: 'hive-4', title: 'Cooking', about: 'food', subscribers: 5000 },
      { title: 'no name' },
    ]);
  });
  const search = (query) => request(app).get('/communities/search').query(query);

  test('half-typed words match, every word must appear, title matches rank first then size', async () => {
    const res = await search({ q: 'GAMIN' }).expect(200);
    expect(res.body.total).toBe(3);
    expect(res.body.communities.map((c) => c.name)).toEqual(['hive-1', 'hive-3', 'hive-2']);
    expect(res.body.communities[0]).not.toHaveProperty('_hay');

    expect((await search({ q: 'gaming ph' }).expect(200)).body.communities.map((c) => c.name)).toEqual(['hive-1']);
    expect((await search({ q: 'hive-4' }).expect(200)).body.communities.map((c) => c.name)).toEqual(['hive-4']);
  });

  test('an empty query is an empty list; limit is clamped', async () => {
    expect((await search({ q: '   ' }).expect(200)).body).toEqual({ success: true, communities: [] });
    expect((await search({ q: 'gaming', limit: 1 }).expect(200)).body.communities).toHaveLength(1);
    expect((await search({ q: 'gaming', limit: 0 }).expect(200)).body.communities).toHaveLength(3);
  });

  test('the index is held in memory for half an hour', async () => {
    await search({ q: 'x' }).expect(200);
    await db().collection('hivecommunities').insertOne({ name: 'hive-9', title: 'Brand new gaming' });
    expect((await search({ q: 'brand' }).expect(200)).body.total).toBe(0);
  });
});

describe('GET /community/:name', () => {
  const fromHive = { name: 'hive-777', title: 'Seven', about: 'a', description: 'd', flag_text: 'be nice', subscribers: 7, num_authors: 2, lang: 'de', is_nsfw: 1 };

  test('a cache miss is backfilled from Hive, normalised, and stored', async () => {
    const calls = stubHive(fromHive);

    const res = await request(app).get('/community/HIVE-777').expect(200);

    expect(res.body.community).toEqual({
      name: 'hive-777', title: 'Seven', about: 'a', description: 'd', rules: 'be nice',
      subscribers: 7, num_authors: 2, lang: 'de', is_nsfw: true,
    });
    expect(calls[0]).toMatchObject({ method: 'bridge.get_community', params: { name: 'hive-777' } });
    expect(await details().findOne({ name: 'hive-777' })).toMatchObject({ rules: 'be nice', cachedAt: expect.any(Date) });
  });

  test('a fresh cached row is served without asking Hive', async () => {
    await details().insertOne({ name: 'hive-777', title: 'Cached', cachedAt: F.hoursAgo(2) });
    const calls = stubHive(fromHive);
    const res = await request(app).get('/community/hive-777').expect(200);
    expect(res.body.community).toEqual({ name: 'hive-777', title: 'Cached' });
    expect(calls).toEqual([]);
  });

  test('a row older than a day is refreshed', async () => {
    await details().insertOne({ name: 'hive-777', title: 'Old', cachedAt: F.daysAgo(2) });
    stubHive(fromHive);
    expect((await request(app).get('/community/hive-777').expect(200)).body.community.title).toBe('Seven');
  });

  test('Hive unreachable: a stale row is better than nothing, no row is a 404', async () => {
    await details().insertOne({ name: 'hive-777', title: 'Old', cachedAt: F.daysAgo(2) });
    stubHive(null);
    expect((await request(app).get('/community/hive-777').expect(200)).body.community.title).toBe('Old');
    expect((await request(app).get('/community/hive-888').expect(404)).body).toEqual({ success: false, error: 'Community not found' });
  });

  test('a network error on every endpoint reads as unreachable', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    await request(app).get('/community/hive-999').expect(404);
  });
});
