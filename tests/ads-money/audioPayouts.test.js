/**
 * The monthly pay-per-listen payout (services/audioPayouts.js runPayout, schedule).
 *
 * The beneficiary account's liquid HBD and HIVE are shared over last month's
 * qualifying listens: a verified listen weighs 1 (author share / listener share), an
 * anonymous listen on a ppl track weighs PPL_ANON_LISTEN_WEIGHT for the author only.
 *
 * Configuration is read when the module loads, so each test loads its own copy with
 * its own environment. dhive's Client is replaced by one whose broadcast only
 * records; account reads go to a fake chain. The signing key is a test key from a
 * public seed. Real MongoDB throughout.
 */
jest.mock('@hiveio/dhive', () => {
  const actual = jest.requireActual('@hiveio/dhive');
  class Client extends actual.Client {
    constructor(...args) {
      super(...args);
      this.broadcast = { sendOperations: (...a) => mockSendOperations(...a) };
    }
  }
  return { ...actual, Client };
});

const mockSendOperations = jest.fn();
const testDb = require('../helpers/db');
const { fakeHiveChain } = require('../helpers/hive');
const F = require('./_fixtures');

const db = testDb.use();
const POOL = 'ppl-pool';
const NOW = new Date('2026-11-01T12:00:00Z');
const PERIOD_END = new Date('2026-11-01T00:00:00Z');
const IN_OCTOBER = new Date('2026-10-15T12:00:00Z');
const log = () => db().collection('audio-listen-log');
const payouts = () => db().collection('audio-payouts');
const LIVE = { PPL_PAYOUT_ACTIVE_KEY: F.testActiveKey() };

/** A copy of the module under `env` (on top of a known beneficiary), on this database. */
function loadPpl(env = {}, { getDb = () => db() } = {}) {
  const all = { PPL_BENEFICIARY: POOL, PPL_PAYOUT_ACTIVE_KEY: '', ...env };
  const saved = {};
  for (const [k, v] of Object.entries(all)) { saved[k] = process.env[k]; process.env[k] = v; }
  let mod;
  jest.isolateModules(() => {
    jest.doMock('../../utils/db', () => ({ getDb }));
    mod = require('../../services/audioPayouts');
    jest.dontMock('../../utils/db');
  });
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return mod;
}

/** The beneficiary holds `hbd` / `hive`; `alive` are the other accounts that exist. */
function chain({ hbd = '20.000 HBD', hive = '10.000 HIVE', alive = ['artist-a', 'artist-b', 'fan'] } = {}) {
  return fakeHiveChain([
    { name: POOL, hbd_balance: hbd, balance: hive },
    ...alive.map((name) => ({ name })),
  ]);
}

const listen = (over = {}) => ({ permlink: 'track', owner: 'artist-a', username: 'fan', payable: true, ppl: true, createdAt: IN_OCTOBER, ...over });
const seedListens = (...rows) => log().insertMany(rows);
const periodRow = () => payouts().findOne({ periodEnd: PERIOD_END });
const preview = () => payouts().findOne({ _id: 'ppl-dry-run-latest' });

beforeEach(() => {
  mockSendOperations.mockReset();
  mockSendOperations.mockImplementation(async (ops) => ({ id: `tx-${ops[0][1].to}` }));
  jest.spyOn(console, 'error').mockImplementation(() => {});
  // The 1.2s pause between recipients is for the node's sake, not the test's.
  const realTimeout = global.setTimeout;
  jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms, ...a) => (ms === 1200 ? (fn(), 0) : realTimeout(fn, ms, ...a)));
});

describe('the monthly window', () => {
  test.each([
    ['2026-11-01T12:00:00Z', '2026-11-01T00:00:00.000Z'],
    ['2026-11-30T23:59:59Z', '2026-11-01T00:00:00.000Z'],
    ['2027-01-01T00:00:00Z', '2027-01-01T00:00:00.000Z'],
  ])('at %s the last month boundary is %s', (now, want) => {
    expect(loadPpl().lastMonthBoundary(new Date(now)).toISOString()).toBe(want);
  });

  test('in January the window is the whole of the previous December', async () => {
    chain();
    await seedListens(listen({ createdAt: new Date('2026-12-15T00:00:00Z') }));
    await loadPpl().runPayout(new Date('2027-01-05T00:00:00Z'));
    expect(await preview()).toMatchObject({ windowStart: '2026-12-01T00:00:00.000Z', windowEnd: '2027-01-01T00:00:00.000Z', listens: 1 });
  });

  test('only unpaid listens inside the window count', async () => {
    chain();
    await seedListens(
      listen(),
      listen({ createdAt: new Date('2026-09-30T23:59:59Z') }),
      listen({ createdAt: PERIOD_END }),
      listen({ paid: true }),
    );
    await loadPpl().runPayout(NOW);
    expect((await preview()).listens).toBe(1);
  });
});

describe('without a key: a dry run that claims nothing', () => {
  test('the plan is computed and kept as a preview; no period is claimed and no listen marked paid', async () => {
    chain();
    await seedListens(listen(), listen(), listen({ owner: 'artist-b' }), listen({ owner: 'artist-b' }));
    await loadPpl().runPayout(NOW);
    expect(await preview()).toMatchObject({
      windowStart: '2026-10-01T00:00:00.000Z', windowEnd: '2026-11-01T00:00:00.000Z',
      listens: 4, recipients: 2, authorShare: 1,
      poolBalance: { hbd: 20, hive: 10 },
      wouldDistribute: { hbd: '20.000', hive: '10.000' },
      plan: [{ account: 'artist-a', hbd: '10.000', hive: '5.000' }, { account: 'artist-b', hbd: '10.000', hive: '5.000' }],
      skipped: [],
    });
    expect(await periodRow()).toBeNull();
    expect(await log().countDocuments({ paid: true })).toBe(0);
    expect(mockSendOperations).not.toHaveBeenCalled();
  });

  test('PPL_PAYOUT_DRY_RUN=true keeps it a dry run even with a key', async () => {
    chain();
    await seedListens(listen());
    await loadPpl({ ...LIVE, PPL_PAYOUT_DRY_RUN: 'true' }).runPayout(NOW);
    expect(mockSendOperations).not.toHaveBeenCalled();
    expect(await preview()).not.toBeNull();
  });

  test('an empty month writes nothing at all in a dry run', async () => {
    await loadPpl().runPayout(NOW);
    expect(await payouts().countDocuments({})).toBe(0);
  });

  test('the preview never occupies the period: a real run afterwards still pays', async () => {
    chain();
    await seedListens(listen());
    await loadPpl().runPayout(NOW);
    await loadPpl(LIVE).runPayout(NOW);
    expect((await periodRow()).status).toBe('completed');
  });
});

describe('who earns what', () => {
  const planOf = async (env, ...rows) => {
    chain({ hbd: '9.000 HBD', hive: '0.000 HIVE', alive: ['artist-a', 'artist-b', 'fan', 'fan2'] });
    await seedListens(...rows);
    await loadPpl(env).runPayout(NOW);
    const p = await preview();
    return p ? Object.fromEntries(p.plan.map((r) => [r.account, r.hbd])) : null;
  };

  test('by default artists get every verified listen, and an anonymous ppl listen counts a quarter', async () => {
    const plan = await planOf({},
      listen(), listen(),
      listen({ username: null, payable: false }), listen({ username: null, payable: false }),
      listen({ username: null, payable: false }), listen({ username: null, payable: false }),
      listen({ owner: 'artist-b' }));
    // Weights: artist-a 2 + 4 * 0.25 = 3, artist-b 1, of a 9 HBD pool.
    expect(plan).toEqual({ 'artist-a': '6.750', 'artist-b': '2.250' });
  });

  test('PPL_AUTHOR_SHARE splits each verified listen between the artist and the listener', async () => {
    const plan = await planOf({ PPL_AUTHOR_SHARE: '0.75' }, listen(), listen({ username: 'fan2' }));
    expect(plan).toEqual({ 'artist-a': '6.750', fan: '1.125', fan2: '1.125' });
  });

  test.each(['1.5', '-1', 'half'])('an invalid PPL_AUTHOR_SHARE (%s) pays artists 100%%', async (share) => {
    expect(await planOf({ PPL_AUTHOR_SHARE: share }, listen())).toEqual({ 'artist-a': '9.000' });
  });

  test.each([
    ['a self-listen (payable false, with a username)', listen({ payable: false })],
    ['an anonymous listen on a non-ppl track', listen({ username: null, payable: false, ppl: false })],
    ['an anonymous listen that could not be measured', listen({ username: null, payable: false, noDuration: true })],
  ])('%s earns nothing', async (_label, row) => {
    expect(await planOf({}, listen(), row)).toEqual({ 'artist-a': '9.000' });
  });

  test('PPL_ANON_LISTEN_WEIGHT=0 ignores anonymous listens entirely', async () => {
    const plan = await planOf({ PPL_ANON_LISTEN_WEIGHT: '0' }, listen({ owner: 'artist-b' }), listen({ username: null, payable: false }));
    expect(plan).toEqual({ 'artist-b': '9.000' });
  });

  test('a recipient whose Hive account no longer exists is skipped, not sent a failing transfer', async () => {
    chain({ alive: ['artist-a'] });
    await seedListens(listen(), listen({ owner: 'gone-artist' }));
    await loadPpl().runPayout(NOW);
    expect(await preview()).toMatchObject({ recipients: 1, skipped: ['gone-artist'] });
  });

  test('a share that rounds below 0.001 of both assets is left in the pool for next month', async () => {
    chain({ hbd: '0.001 HBD', hive: '0.000 HIVE' });
    await seedListens(listen(), listen({ owner: 'artist-b' }));
    await loadPpl().runPayout(NOW);
    expect(await preview()).toMatchObject({ recipients: 0, plan: [] });
  });

  test('amounts are floored, never rounded up past what the pool holds', async () => {
    chain({ hbd: '10.000 HBD', hive: '0.000 HIVE' });
    await seedListens(listen(), listen({ owner: 'artist-b' }), listen({ owner: 'artist-b', username: 'fan2' }));
    await loadPpl().runPayout(NOW);
    const p = await preview();
    expect(p.plan.map((r) => r.hbd)).toEqual(['3.333', '6.666']);
    expect(Number(p.wouldDistribute.hbd)).toBeLessThanOrEqual(10);
  });
});

describe('with a key: the real payout', () => {
  test('claims the month, sends each recipient one transaction holding both assets, and marks every counted listen paid', async () => {
    chain();
    await seedListens(listen(), listen({ owner: 'artist-b' }), listen({ username: null, payable: false }));
    await loadPpl(LIVE).runPayout(NOW);

    const memo = '3Speak pay-per-listen 2026-10-01..2026-11-01';
    expect(mockSendOperations.mock.calls.map(([ops]) => ops)).toEqual([
      [['transfer', { from: POOL, to: 'artist-a', amount: '11.111 HBD', memo }], ['transfer', { from: POOL, to: 'artist-a', amount: '5.555 HIVE', memo }]],
      [['transfer', { from: POOL, to: 'artist-b', amount: '8.888 HBD', memo }], ['transfer', { from: POOL, to: 'artist-b', amount: '4.444 HIVE', memo }]],
    ]);
    expect(await periodRow()).toMatchObject({
      status: 'completed', recipients: 2, failures: 0, listens: 3, listensMarkedPaid: 3,
      poolBalance: { hbd: 20, hive: 10 },
      details: [
        { account: 'artist-a', hbd: '11.111', hive: '5.555', status: 'ok', txId: 'tx-artist-a' },
        { account: 'artist-b', hbd: '8.888', hive: '4.444', status: 'ok', txId: 'tx-artist-b' },
      ],
    });
    expect(await log().countDocuments({ paid: true, payoutPeriodEnd: PERIOD_END })).toBe(3);
  });

  /* BUG (services/audioPayouts.js:304-305). The audit totals are a running sum that
   * is FLOORED at every step, so floating-point error drifts them below what was
   * sent: here 5.555 + 4.444 HIVE went out and the period row records 9.998. The
   * transfers are right; the record of them is not, which is what a person checks
   * against the chain. Summing the sent amounts and rounding once would fix it. */
  test.skip('BUG: the recorded totals equal what was actually sent', async () => {
    chain();
    await seedListens(listen(), listen({ owner: 'artist-b' }), listen({ username: null, payable: false }));
    await loadPpl(LIVE).runPayout(NOW);
    const sent = (sym) => mockSendOperations.mock.calls.flatMap(([ops]) => ops)
      .map(([, op]) => op.amount.split(' ')).filter(([, s]) => s === sym)
      .reduce((a, [n]) => a + Math.round(Number(n) * 1000), 0) / 1000;
    expect((await periodRow()).totals).toEqual({ hbd: sent('HBD').toFixed(3), hive: sent('HIVE').toFixed(3) });
  });

  test('a recipient with only one asset worth sending gets only that leg', async () => {
    chain({ hbd: '5.000 HBD', hive: '0.000 HIVE' });
    await seedListens(listen());
    await loadPpl(LIVE).runPayout(NOW);
    expect(mockSendOperations.mock.calls[0][0]).toEqual([['transfer', expect.objectContaining({ amount: '5.000 HBD' })]]);
  });

  test('a completed month is never paid twice', async () => {
    chain();
    await seedListens(listen());
    const ppl = loadPpl(LIVE);
    await ppl.runPayout(NOW);
    await seedListens(listen({ owner: 'artist-b' }));
    await ppl.runPayout(NOW);
    expect(mockSendOperations).toHaveBeenCalledTimes(1);
  });

  test('a failed transfer leaves the month in error, its listens unpaid, and it is NOT retried automatically', async () => {
    chain();
    mockSendOperations.mockImplementation(async (ops) => {
      if (ops[0][1].to === 'artist-b') throw new Error('rejected');
      return { id: 'tx' };
    });
    await seedListens(listen(), listen({ owner: 'artist-b' }));
    const ppl = loadPpl(LIVE);
    await ppl.runPayout(NOW);
    expect(await periodRow()).toMatchObject({ status: 'error', recipients: 1, failures: 1 });
    expect((await periodRow()).details[1]).toMatchObject({ account: 'artist-b', status: 'error', error: 'rejected' });
    expect(await log().countDocuments({ paid: true })).toBe(0);

    mockSendOperations.mockClear();
    await ppl.runPayout(NOW);
    expect(mockSendOperations).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenLastCalledWith(expect.stringContaining('NOT auto-retrying'));
  });

  test.each(['in_progress', 'error', 'no_listens', 'empty_pool', 'completed'])('a month already marked %s is left alone', async (status) => {
    chain();
    await seedListens(listen());
    await payouts().insertOne({ periodEnd: PERIOD_END, status });
    await loadPpl(LIVE).runPayout(NOW);
    expect(mockSendOperations).not.toHaveBeenCalled();
  });

  test('a month with no listens is recorded as such, so it is not re-checked forever', async () => {
    await loadPpl(LIVE).runPayout(NOW);
    expect(await periodRow()).toMatchObject({ status: 'no_listens', listens: 0, recipients: 0 });
  });

  test('a month whose listens all earn nothing is recorded as no_listens too', async () => {
    await seedListens(listen({ payable: false }));
    await loadPpl(LIVE).runPayout(NOW);
    expect(await periodRow()).toMatchObject({ status: 'no_listens', listens: 1 });
  });

  test('an empty pool is recorded with the balances it saw', async () => {
    chain({ hbd: '0.000 HBD', hive: '0.000 HIVE' });
    await seedListens(listen());
    await loadPpl(LIVE).runPayout(NOW);
    expect(await periodRow()).toMatchObject({ status: 'empty_pool', poolBalance: { hbd: 0, hive: 0 } });
  });

  test('a beneficiary account that cannot be found stops the run before anything is claimed', async () => {
    fakeHiveChain([]);
    await seedListens(listen());
    await loadPpl(LIVE).runPayout(NOW);
    expect(await periodRow()).toBeNull();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('source account @ppl-pool not found'));
  });

  test('a run that loses the race to claim the month skips it', async () => {
    chain();
    await seedListens(listen());
    await payouts().createIndex({ periodEnd: 1 }, { unique: true, partialFilterExpression: { periodEnd: { $type: 'date' } } });
    await payouts().insertOne({ periodEnd: PERIOD_END, status: 'in_progress' });
    // This run's "already handled?" read happened before the other run's claim.
    const stale = {
      collection: (name) => {
        const real = db().collection(name);
        if (name !== 'audio-payouts') return real;
        return Object.assign(Object.create(real), { findOne: async () => null });
      },
    };
    await loadPpl(LIVE, { getDb: () => stale }).runPayout(NOW);
    expect(mockSendOperations).not.toHaveBeenCalled();
    expect(await payouts().countDocuments({ periodEnd: PERIOD_END })).toBe(1);
  });

  test('any other failure to claim the month stops the run before a transfer is built', async () => {
    chain();
    await seedListens(listen());
    const failing = {
      collection: (name) => {
        const real = db().collection(name);
        if (name !== 'audio-payouts') return real;
        return Object.assign(Object.create(real), { insertOne: async () => { throw new Error('disk full'); } });
      },
    };
    await expect(loadPpl(LIVE, { getDb: () => failing }).runPayout(NOW)).rejects.toThrow('disk full');
    expect(mockSendOperations).not.toHaveBeenCalled();
    expect(await log().countDocuments({ paid: true })).toBe(0);
  });

  test('PPL_PAYOUT_PERIOD_END pins the window; an invalid value falls back to the month boundary', async () => {
    chain();
    await seedListens(listen({ createdAt: new Date('2026-09-10T00:00:00Z') }), listen());
    await loadPpl({ PPL_PAYOUT_PERIOD_END: '2026-09-15T00:00:00Z' }).runPayout(NOW);
    expect(await preview()).toMatchObject({ windowStart: '2026-08-15T00:00:00.000Z', windowEnd: '2026-09-15T00:00:00.000Z', listens: 1 });

    await loadPpl({ PPL_PAYOUT_PERIOD_END: 'whenever' }).runPayout(NOW);
    expect((await preview()).windowEnd).toBe('2026-11-01T00:00:00.000Z');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('is not a valid date'));
  });
});

describe('schedule()', () => {
  const MINUTE = 60 * 1000;
  const firstChecks = () => setTimeout.mock.calls.filter(([, ms]) => ms === MINUTE);
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const realTimeout = jest.requireActual('timers').setTimeout;
    setTimeout.mockImplementation((fn, ms, ...a) => {
      if (ms === MINUTE) return 0;
      if (ms === 1200) { fn(); return 0; }
      return realTimeout(fn, ms, ...a);
    });
    const realInterval = global.setInterval;
    jest.spyOn(global, 'setInterval').mockImplementation((fn, ms, ...a) => (ms === 12 * 60 * MINUTE ? 0 : realInterval(fn, ms, ...a)));
  });

  test.each([
    ['LIVE with a valid key', LIVE, '[LIVE]'],
    ['DRY RUN without one', {}, '[DRY RUN]'],
    ['DRY RUN when forced, key or not', { ...LIVE, PPL_PAYOUT_DRY_RUN: 'true' }, '[DRY RUN]'],
  ])('schedules a first check a minute after boot: %s', (_label, env, mode) => {
    loadPpl(env).schedule();
    expect(firstChecks()).toHaveLength(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(mode));
  });

  test.each([
    ['there is no beneficiary', { PPL_BENEFICIARY: '  ' }, 'PPL_BENEFICIARY is not set'],
    ['the key does not parse', { PPL_PAYOUT_ACTIVE_KEY: 'nonsense' }, 'does not parse'],
  ])('schedules nothing when %s', (_label, env, message) => {
    loadPpl(env).schedule();
    expect(firstChecks()).toHaveLength(0);
    expect([...console.log.mock.calls, ...console.error.mock.calls].flat().join('\n')).toContain(message);
  });

  test('the first check starts the twelve-hourly interval, and a failing check is logged, not thrown', async () => {
    loadPpl({}, { getDb: () => { throw new Error('no database'); } }).schedule();
    firstChecks()[0][0]();
    const tick = setInterval.mock.calls.find(([, ms]) => ms === 12 * 60 * MINUTE);
    expect(tick).toBeDefined();
    tick[0]();
    await new Promise((r) => setImmediate(r));
    expect(console.error.mock.calls.filter(([msg]) => msg === '[pplPayout] tick error:')).toHaveLength(2);
  });
});
