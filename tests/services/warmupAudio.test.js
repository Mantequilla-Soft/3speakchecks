/**
 * utils/warmupAudio.js: how the warm-up audio cap is kept fresh.
 *
 * tests/warmupAudio.test.js covers who counts as warming up and the shape of the
 * cap. This file covers the refresh around it, with the real aggregation on the
 * test MongoDB: the five-minute rebuild, single-flight, the short wait on the very
 * first call, the owner cache TTLs, and failing soft when Mongo or the hosted
 * incubation service is down. Only the service client is mocked.
 */
jest.mock('../../utils/incubationHosted', () => ({ call: jest.fn() }));

const testDb = require('../helpers/db');

const db = testDb.use();
const sharedDb = require('../../utils/db');
const T0 = Date.parse('2026-11-01T12:00:00Z');
const MIN = 60 * 1000;
let now;
let call;
let mod;

const day = (n) => new Date(Date.UTC(2026, 9, n));
const seed = () => db().collection('embed-audio').insertMany([
  { owner: 'alice', permlink: 'a1', createdAt: day(1), status: 'published' },
  { owner: 'alice', permlink: 'a2', createdAt: day(9), status: 'published' },
  { owner: 'alice', permlink: 'a3', createdAt: day(20), status: 'draft' },   // not published: never counts
  { owner: 'bob', permlink: 'b1', createdAt: day(5), status: 'published' },
  { owner: 'carol', permlink: 'c1', createdAt: day(7), status: 'published' },
  { owner: 'dave', permlink: 'd1', createdAt: day(3), status: 'published' },
  { owner: 'hiveuser', permlink: 'h1', createdAt: day(8), status: 'published' },
  { owner: 'Not_A_Handle!', permlink: 'x1', createdAt: day(8), status: 'published' },
]);

// Everyone is a warm-up handle except a Hive user the service does not know.
const service = async (_method, path) => {
  const h = decodeURIComponent(path.split('/').pop());
  return h === 'hiveuser' ? { status: 404, body: null } : { status: 200, body: { handle: h, hiveUsername: null } };
};

function load(env = {}) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  jest.isolateModules(() => {
    // The fresh copy must use the connected database layer, not a fresh one.
    jest.doMock('../../utils/db', () => sharedDb);
    call = require('../../utils/incubationHosted').call;
    mod = require('../../utils/warmupAudio');
  });
  process.env = saved;
  call.mockImplementation(service);
}

beforeEach(async () => {
  now = T0;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  await seed();
  load();
});

describe('the rebuild on the real aggregation', () => {
  test('the newest published track of the three most recent warm-up accounts', async () => {
    const { owners, allowed } = await mod.warmupAudio();
    expect(owners.sort()).toEqual(['alice', 'bob', 'carol', 'dave']);
    expect(allowed).toEqual(['a2', 'c1', 'b1']);
  });

  test('a name that cannot be a handle is never sent to the service', async () => {
    await mod.warmupAudio();
    const asked = call.mock.calls.map(([, path]) => decodeURIComponent(path.split('/').pop()));
    expect(asked).not.toContain('Not_A_Handle!');
    expect(mod._test.ownerCache.get('Not_A_Handle!')).toMatchObject({ warmup: false });
  });

  test('the capped query really narrows the warm-up audio in Mongo', async () => {
    const cap = await mod.warmupAudio();
    const rows = await db().collection('embed-audio')
      .find(mod.capWarmup({ status: 'published' }, cap)).project({ permlink: 1 }).toArray();
    expect(rows.map((r) => r.permlink).sort()).toEqual(['a2', 'b1', 'c1', 'h1', 'x1']);
  });

  test('nobody warming up: nothing is aggregated and nothing is capped', async () => {
    call.mockResolvedValue({ status: 404, body: null });
    expect(await mod.warmupAudio()).toMatchObject({ owners: [], allowed: [] });
  });

  test('WARMUP_AUDIO_MAX_TOTAL raises the total', async () => {
    load({ WARMUP_AUDIO_MAX_TOTAL: '10' });
    expect((await mod.warmupAudio()).allowed).toEqual(['a2', 'c1', 'b1', 'd1']);
  });

  // Regression: `parseInt(...) || 3` used to turn an explicit 0 into 3, so warm-up
  // audio could not be hidden from the lists by configuration.
  test('WARMUP_AUDIO_MAX_TOTAL=0 hides every warm-up track from the lists', async () => {
    load({ WARMUP_AUDIO_MAX_TOTAL: '0' });
    expect(mod.MAX_TOTAL).toBe(0);
    expect((await mod.warmupAudio()).allowed).toEqual([]);
  });
});

describe('freshness', () => {
  test('within five minutes the last answer is served without asking anyone', async () => {
    await mod.warmupAudio();
    const asked = call.mock.calls.length;
    now = T0 + 5 * MIN - 1;
    await mod.warmupAudio();
    expect(call.mock.calls.length).toBe(asked);
  });

  test('after five minutes the old answer is served while a rebuild runs, then the new one', async () => {
    await mod.warmupAudio();
    await db().collection('embed-audio').insertOne({ owner: 'erin', permlink: 'e1', createdAt: day(30), status: 'published' });
    // Hold on to the background rebuild's aggregation, to know when it is done.
    const proto = db().collection('embed-audio').constructor.prototype;
    const realAggregate = proto.aggregate;
    let aggregatedDone;
    const aggregated = new Promise((r) => { aggregatedDone = r; });
    jest.spyOn(proto, 'aggregate').mockImplementation(function aggregate(...args) {
      const cursor = realAggregate.apply(this, args);
      const toArray = cursor.toArray.bind(cursor);
      cursor.toArray = () => toArray().then((rows) => { aggregatedDone(); return rows; });
      return cursor;
    });
    now = T0 + 5 * MIN;
    const during = await mod.warmupAudio();
    expect(during.owners).not.toContain('erin'); // stale, but instant
    await aggregated;
    await new Promise((r) => setImmediate(r));
    const after = await mod.warmupAudio();
    expect(after.owners).toContain('erin');
    expect(after.allowed[0]).toBe('e1');
  });

  test('concurrent callers share one rebuild', async () => {
    const distinct = jest.spyOn(db().collection('embed-audio').constructor.prototype, 'distinct');
    await Promise.all([mod.warmupAudio(), mod.warmupAudio(), mod.warmupAudio()]);
    expect(distinct).toHaveBeenCalledTimes(1);
  });

  test('a "no" is remembered for six hours, a "yes" for five minutes', async () => {
    const { isWarmupHandle } = mod._test;
    await isWarmupHandle('hiveuser');
    await isWarmupHandle('alice');
    call.mockClear();
    now = T0 + 5 * MIN;
    await isWarmupHandle('hiveuser');
    await isWarmupHandle('alice');
    expect(call.mock.calls.map(([, p]) => p)).toEqual(['/public/profile/alice']);
    now = T0 + 6 * 60 * MIN;
    await isWarmupHandle('hiveuser');
    expect(call).toHaveBeenCalledTimes(2);
  });

  test('a graduated handle (it has a Hive account now) is not warming up', async () => {
    call.mockResolvedValue({ status: 200, body: { handle: 'alice', hiveUsername: 'alice' } });
    expect(await mod._test.isWarmupHandle('alice')).toBe(false);
  });
});

describe('failing soft', () => {
  test('the very first call waits at most a moment, then goes on uncapped', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      let release;
      const gate = new Promise((r) => { release = r; });
      call.mockImplementation(() => gate);
      const first = mod.warmupAudio();
      await jest.advanceTimersByTimeAsync(1500);
      expect(await first).toMatchObject({ owners: [], allowed: [], at: 0 });
      release({ status: 404, body: null });
    } finally {
      jest.useRealTimers();
    }
  });

  test('a failed rebuild keeps the last answer and is retried in 30 seconds', async () => {
    const good = await mod.warmupAudio();
    const distinct = jest.spyOn(db().collection('embed-audio').constructor.prototype, 'distinct')
      .mockRejectedValueOnce(new Error('mongo down'));
    now = T0 + 5 * MIN;
    await mod.warmupAudio();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('refresh failed'), 'mongo down');
    expect((await mod.warmupAudio()).allowed).toEqual(good.allowed);

    // Not before the 30 s retry...
    const calls = distinct.mock.calls.length;
    now = T0 + 5 * MIN + 29 * 1000;
    await mod.warmupAudio();
    expect(distinct.mock.calls.length).toBe(calls);
    // ...and then again.
    now = T0 + 5 * MIN + 31 * 1000;
    await mod.warmupAudio();
    expect(distinct.mock.calls.length).toBe(calls + 1);
  });

  test('a service that is down for one owner keeps what was known, a stranger counts as not warming up', async () => {
    await mod.warmupAudio();
    now = T0 + 6 * 60 * MIN + 1; // every cached answer has expired
    call.mockRejectedValue(new Error('ECONNREFUSED'));
    const { owners } = await mod._test.rebuild();
    expect(owners.sort()).toEqual(['alice', 'bob', 'carol', 'dave']);
    mod._test.ownerCache.clear();
    expect((await mod._test.rebuild()).owners).toEqual([]);
  });
});
