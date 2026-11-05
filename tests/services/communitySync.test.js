/**
 * communitySync: every Hive community (paged through bridge.list_communities),
 * with its full details and the avatar from the community account's profile, is
 * upserted into hivecommunities; indexOneCommunity does the same for one
 * community straight from the chain. The Hive nodes are a fake fetch.
 */
process.env.HIVE_RPC_ENDPOINTS = 'http://node-a.test,http://node-b.test';

const testDb = require('../helpers/db');
const { syncHiveCommunities, indexOneCommunity } = require('../../services/communitySync');

const db = testDb.use();
const comms = () => db().collection('hivecommunities');

// The fake chain: communities by name, account metadata by name, and per node and
// method a failure switch.
let communities;
let accountMeta;
let down;
let calls;
let realFetch;
beforeEach(() => {
  communities = new Map();
  accountMeta = new Map();
  down = new Set(); // entries 'url' or 'url method'
  calls = [];
  realFetch = global.fetch;
  global.fetch = jest.fn(async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    calls.push({ url, method, params });
    if (down.has(url) || down.has(`${url} ${method}`)) throw new Error('ECONNREFUSED');
    const reply = (result) => ({ json: async () => ({ result }) });
    if (method === 'bridge.list_communities') {
      const names = [...communities.keys()].sort();
      const from = params.last ? names.indexOf(params.last) + 1 : 0;
      return reply(names.slice(from, from + params.limit).map((name) => ({ name })));
    }
    if (method === 'bridge.get_community') return reply(communities.get(params.name) || null);
    if (method === 'condenser_api.get_accounts') {
      return reply(params[0].filter((n) => accountMeta.has(n)).map((n) => ({ name: n, ...accountMeta.get(n) })));
    }
    throw new Error(`unexpected ${method}`);
  });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { global.fetch = realFetch; });

const community = (name, extra = {}) => ({
  name, title: `Title ${name}`, about: 'about', description: 'desc', lang: 'de', is_nsfw: false,
  subscribers: 10, num_authors: 2, sum_pending: 1.5, ...extra,
});
const projection = { projection: { _id: 0 } };

describe('syncHiveCommunities', () => {
  test('pages through every community and stores details plus avatar and cover', async () => {
    for (let i = 0; i < 150; i++) communities.set(`hive-${100000 + i}`, community(`hive-${100000 + i}`));
    accountMeta.set('hive-100000', {
      posting_json_metadata: JSON.stringify({ profile: { profile_image: ' https://img/a.png ', cover_image: 'https://img/c.png' } }),
    });
    accountMeta.set('hive-100001', {
      posting_json_metadata: '{broken',
      json_metadata: JSON.stringify({ profile: { profile_image: 'https://img/b.png' } }),
    });

    await syncHiveCommunities();

    expect(await comms().countDocuments()).toBe(150);
    const lists = calls.filter((c) => c.method === 'bridge.list_communities').map((c) => c.params);
    expect(lists).toEqual([{ limit: 100, sort: 'rank' }, { limit: 100, sort: 'rank', last: 'hive-100099' }]);
    expect(await comms().findOne({ name: 'hive-100000' }, projection)).toEqual({
      name: 'hive-100000', title: 'Title hive-100000', about: 'about', description: 'desc', lang: 'de', is_nsfw: false,
      subscribers: 10, num_authors: 2, sum_pending: 1.5, image: 'https://img/a.png', cover: 'https://img/c.png', used: true,
    });
    expect(await comms().findOne({ name: 'hive-100001' })).toMatchObject({ image: 'https://img/b.png', cover: '' });
  });

  test('missing optional fields get defaults', async () => {
    communities.set('hive-1', { name: 'hive-1', title: 'Bare' });

    await syncHiveCommunities();

    expect(await comms().findOne({ name: 'hive-1' }, projection)).toEqual({
      name: 'hive-1', title: 'Bare', about: '', description: '', lang: 'en', is_nsfw: false,
      subscribers: 0, num_authors: 0, sum_pending: 0, image: '', cover: '', used: true,
    });
  });

  test('running twice updates in place', async () => {
    communities.set('hive-1', community('hive-1'));
    await syncHiveCommunities();
    communities.set('hive-1', community('hive-1', { subscribers: 99 }));

    await syncHiveCommunities();

    expect(await comms().countDocuments()).toBe(1);
    expect((await comms().findOne({})).subscribers).toBe(99);
  });

  test('a community whose details cannot be read on any node is skipped, the rest are stored', async () => {
    communities.set('hive-1', community('hive-1'));
    communities.set('hive-2', community('hive-2'));
    const inner = global.fetch.getMockImplementation();
    global.fetch.mockImplementation(async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'bridge.get_community' && body.params.name === 'hive-2') throw new Error('timeout');
      return inner(url, init);
    });

    await syncHiveCommunities();

    expect((await comms().find({}).toArray()).map((c) => c.name)).toEqual(['hive-1']);
  });

  test('a node that cannot list falls through to the next one', async () => {
    communities.set('hive-1', community('hive-1'));
    down.add('http://node-a.test bridge.list_communities');

    await syncHiveCommunities();

    expect(await comms().countDocuments()).toBe(1);
  });

  test('when no node can list, nothing is written and nothing is thrown', async () => {
    communities.set('hive-1', community('hive-1'));
    down.add('http://node-a.test');
    down.add('http://node-b.test');

    await expect(syncHiveCommunities()).resolves.toBeUndefined();
    expect(await comms().countDocuments()).toBe(0);
  });

  test('avatars that cannot be read on any node leave the images empty, the community is still stored', async () => {
    communities.set('hive-1', community('hive-1'));
    accountMeta.set('hive-1', { posting_json_metadata: JSON.stringify({ profile: { profile_image: 'https://img/x.png' } }) });
    down.add('http://node-a.test condenser_api.get_accounts');
    down.add('http://node-b.test condenser_api.get_accounts');

    await syncHiveCommunities();

    expect(await comms().findOne({ name: 'hive-1' })).toMatchObject({ image: '', cover: '' });
  });

  test('a database failure is logged, never thrown', async () => {
    communities.set('hive-1', community('hive-1'));
    const { Collection } = require('mongodb');
    jest.spyOn(Collection.prototype, 'bulkWrite').mockRejectedValue(new Error('not primary'));

    await expect(syncHiveCommunities()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith('Community sync failed:', expect.any(Error));
  });
});

describe('indexOneCommunity', () => {
  test.each([['alice'], ['hive-12'], ['hive-123456789'], [''], [null]])('refuses %p without asking the chain', async (name) => {
    await expect(indexOneCommunity(name)).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });

  test('a community that does not exist on chain is not planted', async () => {
    await expect(indexOneCommunity('hive-555555')).resolves.toBe(false);
    expect(await comms().countDocuments()).toBe(0);
  });

  test('indexes a real community from the chain, normalising the name', async () => {
    communities.set('hive-555555', community('hive-555555', { title: 'Fresh' }));
    accountMeta.set('hive-555555', { posting_json_metadata: JSON.stringify({ profile: { profile_image: 'https://img/f.png' } }) });

    await expect(indexOneCommunity('  HIVE-555555 ')).resolves.toBe(true);

    expect(await comms().findOne({ name: 'hive-555555' })).toMatchObject({ title: 'Fresh', image: 'https://img/f.png', used: true });
  });

  test('falls through to the next node, and gives up when all fail', async () => {
    communities.set('hive-555555', community('hive-555555'));
    down.add('http://node-a.test bridge.get_community');
    await expect(indexOneCommunity('hive-555555')).resolves.toBe(true);

    await comms().deleteMany({});
    down.add('http://node-b.test bridge.get_community');
    await expect(indexOneCommunity('hive-555555')).resolves.toBe(false);
    expect(await comms().countDocuments()).toBe(0);
  });
});
