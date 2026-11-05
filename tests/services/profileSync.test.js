/**
 * profileSync: every creator (legacy and embed) gets a hiveprofiles row built from
 * their Hive account's profile metadata. The Hive nodes are a fake fetch; the
 * upserts land in the real test MongoDB.
 */
process.env.HIVE_RPC_ENDPOINTS = 'http://node-a.test,http://node-b.test';

const testDb = require('../helpers/db');
const { syncHiveProfiles } = require('../../services/profileSync');
const { NOW } = require('./_fixtures');

const db = testDb.use();
const profiles = () => db().collection('hiveprofiles');

const ONLY_DATE = ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame',
  'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate',
  'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'];

// node -> 'ok' | 'down' | 'empty'; accounts answered from `accounts`.
let nodes;
let accounts;
let calls;
let realFetch;
beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ONLY_DATE });
  nodes = { 'http://node-a.test': 'ok', 'http://node-b.test': 'ok' };
  accounts = new Map();
  calls = [];
  realFetch = global.fetch;
  global.fetch = jest.fn(async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    calls.push({ url, method, names: params[0] });
    if (nodes[url] === 'down') throw new Error('ECONNREFUSED');
    if (nodes[url] === 'empty') return { json: async () => ({ result: null }) };
    return { json: async () => ({ result: params[0].map((n) => accounts.get(n)).filter(Boolean) }) };
  });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  global.fetch = realFetch;
  jest.useRealTimers();
});

const account = (name, { posting, json } = {}) => ({
  name,
  posting_json_metadata: posting === undefined ? '' : (typeof posting === 'string' ? posting : JSON.stringify(posting)),
  json_metadata: json === undefined ? '' : JSON.stringify(json),
});

test('writes a profile row per creator from posting_json_metadata, falling back to json_metadata', async () => {
  accounts.set('alice', account('alice', { posting: { profile: { name: 'Alice', about: 'Hi', location: 'Earth', website: 'https://a.example', profile_image: 'https://i/a.png', cover_image: 'https://i/c.png' } } }));
  accounts.set('bob', account('bob', { json: { profile: { name: 'Bob' } } }));
  accounts.set('carol', account('carol', { posting: '{broken' }));
  await db().collection('videos').insertMany([{ owner: 'alice' }, { owner: 'bob' }, { owner: null }]);
  await db().collection('embed-video').insertMany([{ owner: 'alice' }, { owner: 'carol' }]);

  await syncHiveProfiles();

  const rows = await profiles().find({}, { projection: { _id: 0 } }).sort({ username: 1 }).toArray();
  expect(rows).toEqual([
    { username: 'alice', display_name: 'Alice', about: 'Hi', location: 'Earth', website: 'https://a.example', profile_image: 'https://i/a.png', cover_image: 'https://i/c.png', updated_at: NOW },
    { username: 'bob', display_name: 'Bob', about: '', location: '', website: '', profile_image: '', cover_image: '', updated_at: NOW },
    { username: 'carol', display_name: '', about: '', location: '', website: '', profile_image: '', cover_image: '', updated_at: NOW },
  ]);
  // Owners are deduplicated across both collections, nulls dropped.
  expect(calls).toHaveLength(1);
  expect(calls[0].names.sort()).toEqual(['alice', 'bob', 'carol']);
});

test('running twice updates the same rows instead of adding new ones', async () => {
  accounts.set('alice', account('alice', { posting: { profile: { name: 'Alice' } } }));
  await db().collection('videos').insertOne({ owner: 'alice' });
  await syncHiveProfiles();
  accounts.set('alice', account('alice', { posting: { profile: { name: 'Alice B.' } } }));

  await syncHiveProfiles();

  expect(await profiles().countDocuments()).toBe(1);
  expect((await profiles().findOne({ username: 'alice' })).display_name).toBe('Alice B.');
});

test('asks for at most 1000 accounts per call', async () => {
  const owners = Array.from({ length: 1001 }, (_, i) => ({ owner: `u${i}` }));
  owners.forEach(({ owner }) => accounts.set(owner, account(owner)));
  await db().collection('videos').insertMany(owners);

  await syncHiveProfiles();

  expect(calls.map((c) => c.names.length)).toEqual([1000, 1]);
  expect(await profiles().countDocuments()).toBe(1001);
});

test.each([
  ['unreachable', 'down'],
  ['answering no result', 'empty'],
])('a first node that is %s falls through to the next one', async (_label, mode) => {
  nodes['http://node-a.test'] = mode;
  accounts.set('alice', account('alice'));
  await db().collection('videos').insertOne({ owner: 'alice' });

  await syncHiveProfiles();

  expect(calls.map((c) => c.url)).toEqual(['http://node-a.test', 'http://node-b.test']);
  expect(await profiles().countDocuments()).toBe(1);
});

test('every node failing skips the batch and leaves existing rows untouched', async () => {
  nodes = { 'http://node-a.test': 'down', 'http://node-b.test': 'down' };
  await profiles().insertOne({ username: 'alice', display_name: 'Kept' });
  await db().collection('videos').insertOne({ owner: 'alice' });

  await syncHiveProfiles();

  expect(await profiles().find({}, { projection: { _id: 0 } }).toArray()).toEqual([{ username: 'alice', display_name: 'Kept' }]);
  expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/Profile fetch failed for batch 0-1/));
});

test('a database failure is logged, never thrown', async () => {
  const { Collection } = require('mongodb');
  jest.spyOn(Collection.prototype, 'distinct').mockRejectedValue(new Error('connection reset'));

  await expect(syncHiveProfiles()).resolves.toBeUndefined();
  expect(console.error).toHaveBeenCalledWith('Profile sync failed:', expect.any(Error));
});
