/**
 * routes/badges.js and utils/badgeIndex.js: Hive badge accounts. A badge's profile
 * is its identity and the accounts it follows are its holders.
 *
 * Hive is a small in-memory world behind a jest.fn hiveRpcBatch (accounts, bridge
 * profiles, follow lists); the badge index, the creator pointers and the videos are
 * real MongoDB collections.
 */
const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const { pinClock, NOW } = require('./_fixtures');

jest.mock('../../utils/hive', () => ({
  ...jest.requireActual('../../utils/hive'),
  hiveRpcBatch: jest.fn(),
  getFollowingList: jest.fn(),
}));
// The off-chain follow lookup would call a local Butter Auth service; nobody here follows off chain.
jest.mock('../../utils/incubationHosted', () => ({ ...jest.requireActual('../../utils/incubationHosted'), followingOf: jest.fn(async () => []) }));
const { hiveRpcBatch, getFollowingList } = require('../../utils/hive');
const badgeIndex = require('../../utils/badgeIndex');

const db = testDb.use();
const app = buildApp(['/badges', require('../../routes/badges')]);
const registry = () => db().collection(badgeIndex.REGISTRY);
const creators = () => db().collection('badge-creators');

// ── a tiny Hive ──────────────────────────────────────────────────────────────
let accounts;   // name -> raw condenser account
let profiles;   // name -> bridge profile
let following;  // name -> [names]
let failing;    // when true every Hive call rejects

const account = (name, profile = {}, extra = {}) => ({
  name,
  posting_json_metadata: JSON.stringify({ profile }),
  json_metadata: '',
  created: '2025-01-01T00:00:00',
  post_count: 3,
  recovery_account: 'creator-acct',
  posting: { account_auths: [] },
  ...extra,
});

function answer(call) {
  if (call.method === 'condenser_api.get_accounts') {
    return { id: call.id, result: call.params[0].map((n) => accounts[n]).filter(Boolean) };
  }
  if (call.method === 'bridge.get_profile') {
    const p = profiles[call.params.account];
    return p ? { id: call.id, result: p } : { id: call.id, error: { message: 'not found' } };
  }
  throw new Error(`unexpected ${call.method}`);
}

let tick = 0;
beforeEach(() => {
  // The router caches a badge for 15 minutes; each test lives in its own hour.
  tick += 1;
  pinClock(new Date(NOW.getTime() + tick * 3600 * 1000));
  failing = false;
  accounts = {
    'badge-1234': account('badge-1234', { name: 'Hive Open Days - Alicante 2026', about: 'Were there', profile_image: 'https://img/b.png', website: 'https://hod.example' },
      { posting: { account_auths: [['tibfox', 1]] } }),
    'badge-5678': account('badge-5678', {}, { posting: { account_auths: [['someone-else', 1]] } }),
    alice: account('alice', { name: 'Alice A', profile_image: 'https://img/alice.png' }),
    bob: account('bob', {}),
  };
  profiles = {
    'badge-1234': { name: 'badge-1234', stats: { following: 34, followers: 5 }, reputation: 25 },
    'badge-5678': { name: 'badge-5678', stats: {} },
    alice: { name: 'alice', stats: {}, reputation: 61.2 },
    bob: { name: 'bob', stats: {} },
  };
  following = { 'badge-500500': ['badge-1234', 'badge-5678'], 'badge-1234': ['bob', 'alice', 'carol'] };
  hiveRpcBatch.mockReset();
  hiveRpcBatch.mockImplementation(async (batch) => {
    if (failing) throw new Error('all nodes down');
    return batch.map(answer);
  });
  getFollowingList.mockReset();
  getFollowingList.mockImplementation(async (name) => {
    if (failing) throw new Error('all nodes down');
    return following[name] || [];
  });
});
afterEach(() => jest.useRealTimers());

describe('utils/badgeIndex', () => {
  test('parseProfileMeta prefers posting metadata, falls back to json_metadata, survives garbage', () => {
    const { parseProfileMeta } = badgeIndex;
    expect(parseProfileMeta({ posting_json_metadata: '{"profile":{"name":"P"}}', json_metadata: '{"profile":{"name":"J"}}' })).toEqual({ name: 'P' });
    expect(parseProfileMeta({ posting_json_metadata: '{"profile":{}}', json_metadata: '{"profile":{"name":"J"}}' })).toEqual({ name: 'J' });
    expect(parseProfileMeta({ posting_json_metadata: '{not json', json_metadata: '' })).toEqual({});
    expect(parseProfileMeta({})).toEqual({});
  });

  test('shapeBadge takes the untruncated name from the account and the counts from bridge', async () => {
    const shaped = badgeIndex.shapeBadge('badge-1234', (await badgeIndex.getProfiles(['badge-1234'])).get('badge-1234'));
    expect(shaped).toEqual({
      account: 'badge-1234', title: 'Hive Open Days - Alicante 2026', description: 'Were there',
      image: 'https://img/b.png', cover: '', website: 'https://hod.example', location: '',
      recipients: 34, subscribers: 5, created: '2025-01-01T00:00:00', creator: 'creator-acct', posts: 3,
    });
  });

  test('shapeBadge keeps an empty badge readable', () => {
    expect(badgeIndex.shapeBadge('badge-9999', undefined)).toMatchObject({
      title: 'badge-9999', image: 'https://images.hive.blog/u/badge-9999/avatar', recipients: 0, posts: 0, created: null,
    });
  });

  test('getProfiles asks in batches of 20 accounts', async () => {
    const names = Array.from({ length: 45 }, (_, i) => `acct${i}`);
    await badgeIndex.getProfiles(names);
    expect(hiveRpcBatch.mock.calls.map(([b]) => b[0].params[0].length)).toEqual([20, 20, 5]);
  });

  test('runBadgeIndex imports the peakd list and indexes every known badge, keeping our own source', async () => {
    await registry().insertOne({ account: 'badge-1111', source: '3speak', addedAt: NOW });
    accounts['badge-1111'] = account('badge-1111', { name: 'Made here' });

    expect(await badgeIndex.runBadgeIndex()).toEqual({ imported: 2, indexed: 3 });

    const rows = await registry().find({}, { projection: { _id: 0, addedAt: 0, indexedAt: 0 } }).sort({ account: 1 }).toArray();
    expect(rows.map((r) => [r.account, r.source, r.title, r.recipients])).toEqual([
      ['badge-1111', '3speak', 'Made here', 0],
      ['badge-1234', 'peakd', 'Hive Open Days - Alicante 2026', 34],
      ['badge-5678', 'peakd', 'badge-5678', 0],
    ]);
  });

  test('an unreachable peakd list keeps what the index already has', async () => {
    getFollowingList.mockResolvedValue(null);
    await registry().insertOne({ account: 'badge-1234', title: 'kept' });
    expect(await badgeIndex.importPeakdRegistry()).toBe(0);
    expect(await badgeIndex.indexBadgeAccounts([])).toBe(0);
    expect(await registry().countDocuments()).toBe(1);
  });

  test('indexOneBadge marks a badge made here as ours even if peakd listed it first', async () => {
    await registry().insertOne({ account: 'badge-1234', source: 'peakd' });
    await badgeIndex.indexOneBadge('badge-1234', '3speak');
    expect(await registry().findOne({ account: 'badge-1234' })).toMatchObject({ source: '3speak', title: 'Hive Open Days - Alicante 2026' });
  });
});

describe('POST /badges/created', () => {
  test('records the pointer and indexes the badge when the chain confirms the authority', async () => {
    pinClock(NOW);
    const res = await request(app).post('/badges/created').send({ creator: ' TibFox ', account: 'Badge-1234' }).expect(200);

    expect(res.body).toEqual({ ok: true, creator: 'tibfox', account: 'badge-1234' });
    expect(await creators().find({}, { projection: { _id: 0 } }).toArray()).toEqual([{ creator: 'tibfox', account: 'badge-1234', createdAt: NOW }]);
    expect(await registry().findOne({ account: 'badge-1234' })).toMatchObject({ source: '3speak', recipients: 34 });
  });

  test('a creator the badge never granted authority to is a 403 and nothing is written', async () => {
    await request(app).post('/badges/created').send({ creator: 'mallory', account: 'badge-1234' }).expect(403);
    expect(await creators().countDocuments()).toBe(0);
    expect(await registry().countDocuments()).toBe(0);
  });

  test('a badge account that does not exist is a 403', async () => {
    await request(app).post('/badges/created').send({ creator: 'tibfox', account: 'badge-0000' }).expect(403);
  });

  test('calling twice keeps one pointer', async () => {
    await request(app).post('/badges/created').send({ creator: 'tibfox', account: 'badge-1234' }).expect(200);
    await request(app).post('/badges/created').send({ creator: 'tibfox', account: 'badge-1234' }).expect(200);
    expect(await creators().countDocuments()).toBe(1);
  });

  test.each([
    [{ creator: 'tibfox', account: 'alice' }],
    [{ creator: 'tibfox', account: 'badge-12' }],
    [{ creator: 'x', account: 'badge-1234' }],
    [{ creator: 'Bad Name!', account: 'badge-1234' }],
    [{ creator: { $ne: '' }, account: 'badge-1234' }],
    [{}],
  ])('%j is a 400 and the chain is never asked', async (body) => {
    await request(app).post('/badges/created').send(body).expect(400);
    expect(hiveRpcBatch).not.toHaveBeenCalled();
  });

  test('a Hive outage is a 500', async () => {
    failing = true;
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await request(app).post('/badges/created').send({ creator: 'tibfox', account: 'badge-1234' }).expect(500);
  });
});

describe('GET /badges/by-creator/:creator', () => {
  test('offers only the badges the creator still holds authority over', async () => {
    await creators().insertMany([
      { creator: 'tibfox', account: 'badge-1234' },
      { creator: 'tibfox', account: 'badge-5678' }, // authority since removed
    ]);
    const res = await request(app).get('/badges/by-creator/TibFox').expect(200);
    expect(res.body.creator).toBe('tibfox');
    expect(res.body.badges.map((b) => [b.account, b.title, b.recipients])).toEqual([['badge-1234', 'Hive Open Days - Alicante 2026', 34]]);
  });

  test('a creator with no pointers gets an empty list without asking Hive', async () => {
    expect((await request(app).get('/badges/by-creator/nobody').expect(200)).body).toEqual({ creator: 'nobody', badges: [] });
    expect(hiveRpcBatch).not.toHaveBeenCalled();
  });

  test('a creator whose every authority was removed gets an empty list', async () => {
    await creators().insertOne({ creator: 'tibfox', account: 'badge-5678' });
    expect((await request(app).get('/badges/by-creator/tibfox').expect(200)).body.badges).toEqual([]);
  });

  test('an invalid name is a 400', async () => {
    await request(app).get('/badges/by-creator/a').expect(400);
  });

  test('a Hive outage is a 500', async () => {
    await creators().insertOne({ creator: 'tibfox', account: 'badge-1234' });
    failing = true;
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await request(app).get('/badges/by-creator/tibfox').expect(500);
  });
});

describe('GET /badges: the directory', () => {
  test('lists held badges and our own new ones biggest first, and drops empty imports', async () => {
    await registry().insertMany([
      { account: 'badge-0001', title: 'Small', recipients: 2, source: 'peakd' },
      { account: 'badge-0002', title: 'Big', recipients: 90, subscribers: 4, source: 'peakd', image: 'https://img/big.png' },
      { account: 'badge-0003', recipients: 0, source: 'peakd' },
      { account: 'badge-0004', title: 'Brand new', source: '3speak' },
    ]);
    const res = await request(app).get('/badges').expect(200);

    expect(res.body.registry).toBe('badge-500500');
    expect(res.body.total).toBe(3);
    expect(res.body.badges.map((b) => [b.account, b.recipients, b.madeHere])).toEqual([
      ['badge-0002', 90, false], ['badge-0001', 2, false], ['badge-0004', 0, true],
    ]);
    expect(res.body.badges[2]).toMatchObject({ title: 'Brand new', image: 'https://images.hive.blog/u/badge-0004/avatar', description: '' });
  });

  test('a database failure is a 500', async () => {
    const { Collection } = require('mongodb');
    jest.spyOn(Collection.prototype, 'find').mockImplementation(() => { throw new Error('down'); });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await request(app).get('/badges').expect(500);
  });
});

describe('GET /badges/:account', () => {
  test('returns the identity, counts and whether the registry lists it, then serves it from cache', async () => {
    const first = await request(app).get('/badges/BADGE-1234').expect(200);
    expect(first.body).toMatchObject({ account: 'badge-1234', title: 'Hive Open Days - Alicante 2026', recipients: 34, inRegistry: true });
    expect(first.body.cached).toBeUndefined();

    hiveRpcBatch.mockClear();
    const second = await request(app).get('/badges/badge-1234').expect(200);
    expect(second.body.cached).toBe(true);
    expect(hiveRpcBatch).not.toHaveBeenCalled();
  });

  test('the cache expires after fifteen minutes', async () => {
    await request(app).get('/badges/badge-5678').expect(200);
    pinClock(new Date(Date.now() + 16 * 60 * 1000));
    expect((await request(app).get('/badges/badge-5678').expect(200)).body.cached).toBeUndefined();
  });

  // stale() is documented as "what we serve when Hive is unreachable", but no route
  // calls it: once the 15-minute entry expires, an outage turns a badge page that was
  // fine a minute ago into a 500. (routes/badges.js:54-58, used nowhere; :300 answers 500)
  test.skip('BUG: an expired badge is served from the last good copy while Hive is down', async () => {
    await request(app).get('/badges/badge-1234').expect(200);
    pinClock(new Date(Date.now() + 16 * 60 * 1000));
    failing = true;
    const res = await request(app).get('/badges/badge-1234').expect(200);
    expect(res.body.title).toBe('Hive Open Days - Alicante 2026');
  });

  test('a badge outside the registry says so, and a broken registry read is not fatal', async () => {
    accounts['badge-4321'] = account('badge-4321', { name: 'Unlisted' });
    getFollowingList.mockRejectedValue(new Error('registry read failed'));
    expect((await request(app).get('/badges/badge-4321').expect(200)).body).toMatchObject({ title: 'Unlisted', inRegistry: false });
  });

  test('an unknown account is a 404, an invalid name a 400', async () => {
    await request(app).get('/badges/nobody-here').expect(404);
    await request(app).get('/badges/x').expect(400);
  });

  test('a Hive outage is a 500', async () => {
    failing = true;
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await request(app).get('/badges/badge-9876').expect(500);
  });
});

describe('GET /badges/:account/recipients', () => {
  const recent = new Date(NOW.getTime() - 24 * 3600 * 1000);

  beforeEach(async () => {
    await db().collection('videos').insertMany([
      { owner: 'carol', permlink: 'c1', status: 'published', created: recent },
      { owner: 'carol', permlink: 'c2', status: 'published', created: recent },
      { owner: 'carol', permlink: 'draft', status: 'uploaded', created: recent },
    ]);
    await db().collection('embed-video').insertMany([
      { owner: 'bob', permlink: 'asset', hive_author: 'bob', hive_permlink: 'b1', status: 'published', short: false, listed_on_3speak: true, createdAt: recent },
      { owner: 'bob', permlink: 'short', hive_author: 'bob', hive_permlink: 'b2', status: 'published', short: true, listed_on_3speak: true, createdAt: recent },
    ]);
  });

  test('puts the holders who post here first, counting only feed-visible videos', async () => {
    const res = await request(app).get('/badges/badge-1234/recipients').expect(200);
    expect(res.body).toMatchObject({ account: 'badge-1234', total: 3, withVideos: 2, page: 1, limit: 50, totalPages: 1 });
    expect(res.body.recipients).toEqual([
      { account: 'carol', videos: 2, displayName: 'carol', image: 'https://images.hive.blog/u/carol/avatar', reputation: null },
      { account: 'bob', videos: 1, displayName: 'bob', image: 'https://images.hive.blog/u/bob/avatar', reputation: null },
      { account: 'alice', videos: 0, displayName: 'Alice A', image: 'https://img/alice.png', reputation: 61.2 },
    ]);
  });

  test('paginates after ordering', async () => {
    const res = await request(app).get('/badges/badge-1234/recipients?page=2&limit=2').expect(200);
    expect(res.body).toMatchObject({ page: 2, limit: 2, totalPages: 2 });
    expect(res.body.recipients.map((r) => r.account)).toEqual(['alice']);
  });

  test('a badge nobody holds is an empty list without database or profile reads', async () => {
    const res = await request(app).get('/badges/badge-5678/recipients?limit=500').expect(200);
    expect(res.body).toMatchObject({ total: 0, withVideos: 0, limit: 100, recipients: [] });
    expect(hiveRpcBatch).not.toHaveBeenCalled();
  });

  test('a failed profile read still lists the holders, with plain names', async () => {
    hiveRpcBatch.mockRejectedValue(new Error('down'));
    const res = await request(app).get('/badges/badge-1234/recipients').expect(200);
    expect(res.body.recipients.find((r) => r.account === 'alice')).toMatchObject({ displayName: 'alice', reputation: null });
  });

  test('an invalid name is a 400, a failed follow read a 500', async () => {
    await request(app).get('/badges/x/recipients').expect(400);
    failing = true;
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await request(app).get('/badges/badge-1234/recipients').expect(500);
  });
});

describe('GET /badges/:account/feed', () => {
  test('a badge with no holders is an empty feed, never the whole site', async () => {
    await db().collection('videos').insertOne({ owner: 'carol', permlink: 'c1', status: 'published', created: new Date() });
    const res = await request(app).get('/badges/badge-5678/feed').expect(200);
    expect(res.body).toMatchObject({ account: 'badge-5678', feedType: 'empty', recipients: 0, total: 0, videos: [] });
  });

  test('shows the holders\' videos newest first', async () => {
    const at = (h) => new Date(Date.now() - h * 3600 * 1000);
    await db().collection('videos').insertMany([
      { owner: 'carol', author: 'carol', permlink: 'older', status: 'published', created: at(10), title: 'Older' },
      { owner: 'stranger', author: 'stranger', permlink: 'x', status: 'published', created: at(1), title: 'Not a holder' },
    ]);
    await db().collection('embed-video').insertOne({
      owner: 'bob', permlink: 'asset', hive_author: 'bob', hive_permlink: 'newer', hive_title: 'Newer',
      status: 'published', short: false, listed_on_3speak: true, createdAt: at(2),
    });

    const res = await request(app).get('/badges/badge-1234/feed').expect(200);

    expect(res.body).toMatchObject({ account: 'badge-1234', recipients: 3, total: 2 });
    expect(res.body.videos.map((v) => v.permlink)).toEqual(['newer', 'older']);
  });

  test('an invalid name is a 400, a failed follow read a 500', async () => {
    await request(app).get('/badges/x/feed').expect(400);
    failing = true;
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await request(app).get('/badges/badge-1234/feed').expect(500);
  });
});
