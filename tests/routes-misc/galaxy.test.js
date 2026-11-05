/**
 * routes/galaxy.js: the follow-graph scan for the galaxy page, read from HafSQL.
 *
 * HafSQL is replaced by a small in-memory follow graph that answers the route's
 * queries the way Postgres would, so the tests check the shape of a scan (ring,
 * sample, candidates, links), its exclusions and its caching rather than SQL text.
 * The router is loaded fresh for every test, so its 10-minute cache starts empty.
 */
const request = require('supertest');
const { buildApp } = require('../helpers/app');
const { pinClock } = require('./_fixtures');

const mockQuery = jest.fn();
jest.mock('../../utils/hafsql', () => ({ query: (...args) => mockQuery(...args) }));

let follows; // [follower, following]
let accounts; // name -> { followings, rep, followers, active, display_name }

const isPerson = (n, excluded) => !n.startsWith('badge-') && !excluded.includes(n);
const followingOf = (a) => follows.filter(([f]) => f === a).map(([, t]) => t);
const followersOf = (a) => follows.filter(([, t]) => t === a).map(([f]) => f);

/** Answers the queries routes/galaxy.js sends, from `follows` and `accounts`. */
function fakeHafsql(sql, params) {
  const q = sql.replace(/\s+/g, ' ');
  if (q.startsWith('select following_name as n from hafsql.follows where follower_name = $1')) {
    const [account, limit, excluded] = params;
    return followingOf(account).filter((n) => isPerson(n, excluded)).sort().slice(0, limit).map((n) => ({ n }));
  }
  if (q.startsWith('select follower_name as n from hafsql.follows where following_name = $1')) {
    const [account, limit, excluded] = params;
    return followersOf(account).filter((n) => isPerson(n, excluded)).sort().slice(0, limit).map((n) => ({ n }));
  }
  if (q.startsWith('select name, followings::int as f')) {
    return params[0].filter((n) => accounts[n]).map((name) => ({ name, f: accounts[name].followings ?? 10 }));
  }
  if (q.startsWith('select following_name as n, count(*)::int as c')) {
    const [from, to] = params;
    const c = new Map();
    for (const [f, t] of follows) if (from.includes(f) && to.includes(t)) c.set(t, (c.get(t) || 0) + 1);
    return [...c].map(([n, count]) => ({ n, c: count }));
  }
  if (q.startsWith('select following_name as name, count(*)::int as count')) {
    const [sampled, center, following, limit, excluded, mapScanned] = params;
    const by = new Map();
    for (const [f, t] of follows) {
      if (!sampled.includes(f) || t === center || following.includes(t) || !isPerson(t, excluded)) continue;
      if (!by.has(t)) by.set(t, []);
      by.get(t).push(f);
    }
    return [...by]
      .map(([name, fs]) => ({ name, count: fs.length, via: fs.filter((f) => mapScanned.includes(f)).sort() }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, limit);
  }
  if (q.startsWith('select follower_name as a, following_name as b')) {
    const [from, to] = params;
    return follows.filter(([f, t]) => from.includes(f) && to.includes(t) && f !== t).map(([a, b]) => ({ a, b }));
  }
  if (q.startsWith('select name, reputation::float as rep')) {
    return params[0].filter((n) => accounts[n]).map((name) => ({ name, ...accounts[name] }));
  }
  throw new Error(`fake hafsql: unexpected query ${q}`);
}

let app;
beforeEach(() => {
  pinClock();
  mockQuery.mockReset();
  mockQuery.mockImplementation(async (sql, params) => fakeHafsql(sql, params));
  follows = [
    ['meg', 'ann'], ['meg', 'ben'], ['meg', 'cat'], ['meg', 'botty'], ['meg', 'badge-x'], ['meg', 'dtube'],
    ['ann', 'meg'], ['ben', 'meg'], ['dan', 'meg'], ['badge-y', 'meg'],
    ['ann', 'ben'], ['ann', 'xia'], ['ann', 'yan'], ['ann', 'ann'],
    ['ben', 'ann'], ['ben', 'xia'], ['ben', 'dtube'],
    ['cat', 'yan'], ['cat', 'zed'], ['cat', 'badge-z'],
    ['botty', 'wes'],
  ];
  accounts = {
    ann: {}, ben: {}, cat: {}, dan: {}, botty: { followings: 50000 },
    xia: { rep: 65.5, followers: 120, active: '2026-10-30T00:00:00Z', display_name: 'Ex' },
    yan: { rep: 40, followers: 3, active: null, display_name: '' },
    // zed has no accounts row: dropped from the candidates.
  };
  jest.isolateModules(() => { app = buildApp(['/', require('../../routes/galaxy')]); });
});
afterEach(() => jest.useRealTimers());

describe('input', () => {
  test.each([
    ['/galaxy/lists'], ['/galaxy/lists?account=No!'], ['/galaxy/scan'], ['/galaxy/scan?center=ab'],
  ])('%s is a 400', async (path) => {
    expect((await request(app).get(path).expect(400)).body).toEqual({ success: false, error: 'invalid account' });
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('GET /galaxy/lists', () => {
  test('following and followers A to Z, without badge accounts or excluded ones, cacheable', async () => {
    const res = await request(app).get('/galaxy/lists?account=MEG').expect(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.body).toEqual({ success: true, account: 'meg', following: ['ann', 'ben', 'botty', 'cat'], followers: ['ann', 'ben', 'dan'] });
  });

  test('HafSQL being down is a 502, and the failure is not cached', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockQuery.mockRejectedValueOnce(new Error('pg down'));
    await request(app).get('/galaxy/lists?account=meg').expect(502);
    await request(app).get('/galaxy/lists?account=meg').expect(200);
  });
});

describe('GET /galaxy/scan', () => {
  test("what the people I follow follow: candidates strongest first, with who leads there and how they link", async () => {
    const res = await request(app).get('/galaxy/scan?center=meg').expect(200);
    const b = res.body;
    expect(b).toMatchObject({ success: true, center: 'meg', mode: 'following', following: ['ann', 'ben', 'botty', 'cat'] });
    // A mass-follower stays on the map but is never scanned.
    expect([...b.sampled].sort()).toEqual(['ann', 'ben', 'cat']);
    // Most followed by the scan first, scanned before unscanned on a tie.
    expect(b.mapRing).toEqual(['ann', 'ben', 'cat', 'botty']);
    expect(b.candidates).toEqual([
      { name: 'xia', count: 2, via: ['ann', 'ben'], rep: 65.5, followers: 120, active: Date.parse('2026-10-30T00:00:00Z'), displayName: 'Ex' },
      { name: 'yan', count: 2, via: ['ann', 'cat'], rep: 40, followers: 3, active: null, displayName: '' },
    ]);
    // Self-follows are not links.
    expect(b.ringLinks).toEqual({ ann: ['ben'], ben: ['ann'] });
  });

  test('the heavy queries get the long read timeout', async () => {
    await request(app).get('/galaxy/scan?center=meg').expect(200);
    const heavy = mockQuery.mock.calls.filter(([, , opts]) => opts && opts.timeoutMs === 60000);
    expect(heavy).toHaveLength(2);
  });

  test.each([
    ['followers', ['ann', 'ben', 'dan']],
    ['mutuals', ['ann', 'ben']],
    ['nonsense', ['ann', 'ben', 'cat', 'botty']],
  ])('mode=%s scans that ring', async (mode, ring) => {
    const res = await request(app).get(`/galaxy/scan?center=meg&mode=${mode}`).expect(200);
    expect([...res.body.mapRing].sort()).toEqual([...ring].sort());
    expect(res.body.mode).toBe(mode === 'nonsense' ? 'following' : mode);
  });

  test('nobody to scan: an empty galaxy, not an error', async () => {
    const res = await request(app).get('/galaxy/scan?center=lonely').expect(200);
    expect(res.body).toEqual({ success: true, center: 'lonely', mode: 'following', following: [], followers: [], sampled: [], mapRing: [], candidates: [], ringLinks: {} });
  });

  test('a ring of mass-followers only: shown, never scanned', async () => {
    follows.push(['solo', 'botty']);
    const solo = await request(app).get('/galaxy/scan?center=solo').expect(200);
    expect(solo.body).toMatchObject({ mapRing: ['botty'], sampled: [], candidates: [] });
  });

  test('depth sets how many ring members are scanned; an unknown depth (even a prototype key) is the default', async () => {
    const ring = Array.from({ length: 130 }, (_, i) => `user${String(i).padStart(3, '0')}`);
    for (const n of ring) { follows.push(['big', n]); accounts[n] = {}; }
    const sampled = async (depth) => (await request(app).get(`/galaxy/scan?center=big&depth=${depth}`).expect(200)).body.sampled;
    expect(await sampled('orbit')).toHaveLength(120);
    expect(await sampled('starsystem')).toHaveLength(130);
    expect(await sampled('toString')).toHaveLength(120);
  });

  test('the sample is a seeded shuffle: the same galaxy keeps its shape', async () => {
    const ring = Array.from({ length: 30 }, (_, i) => `user${String(i).padStart(3, '0')}`);
    for (const n of ring) { follows.push(['big', n]); accounts[n] = {}; }
    const first = (await request(app).get('/galaxy/scan?center=big').expect(200)).body.sampled;
    jest.setSystemTime(Date.now() + 11 * 60 * 1000); // past the cache
    const again = (await request(app).get('/galaxy/scan?center=big').expect(200)).body.sampled;
    expect(again).toEqual(first);
    expect(first).not.toEqual(ring);
    expect([...first].sort()).toEqual(ring);
  });

  test('a scan is cached for ten minutes', async () => {
    await request(app).get('/galaxy/scan?center=meg').expect(200);
    const calls = mockQuery.mock.calls.length;
    await request(app).get('/galaxy/scan?center=meg').expect(200);
    expect(mockQuery.mock.calls.length).toBe(calls);
    jest.setSystemTime(Date.now() + 11 * 60 * 1000);
    await request(app).get('/galaxy/scan?center=meg').expect(200);
    expect(mockQuery.mock.calls.length).toBe(calls * 2);
  });

  test('HafSQL failing mid-scan is a 502, and the next request tries again', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockQuery.mockImplementation(async (sql, params) => {
      if (/reputation/.test(sql)) throw new Error('timeout');
      return fakeHafsql(sql, params);
    });
    await request(app).get('/galaxy/scan?center=meg').expect(502);
    mockQuery.mockImplementation(async (sql, params) => fakeHafsql(sql, params));
    expect((await request(app).get('/galaxy/scan?center=meg').expect(200)).body.candidates).toHaveLength(2);
  });

  test('the cache holds at most 60 entries, the oldest go first', async () => {
    for (let i = 0; i < 61; i += 1) await request(app).get(`/galaxy/lists?account=acct${String(i).padStart(3, '0')}`).expect(200);
    const calls = mockQuery.mock.calls.length;
    await request(app).get('/galaxy/lists?account=acct060').expect(200); // newest: still cached
    expect(mockQuery.mock.calls.length).toBe(calls);
    await request(app).get('/galaxy/lists?account=acct000').expect(200); // evicted: read again
    expect(mockQuery.mock.calls.length).toBe(calls + 2);
  });
});
