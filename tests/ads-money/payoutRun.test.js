/**
 * The payout job with an active key configured (services/adPayouts.js runOnce,
 * schedule, refundRefusedPayments, payPending through its own client).
 *
 * The key is a deterministic test key from a public seed, and dhive's Client is
 * replaced by one whose broadcast only records: nothing can reach a node, and the
 * test network guard would refuse it anyway.
 *
 * Covers the scheduled run end to end (close finished flights, settle every elapsed
 * period, send, refund, release stale credit), catching up after downtime, refunds
 * of payments from the wrong account, and the switches that keep the job off.
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
jest.mock('../../utils/hive', () => ({ ...jest.requireActual('../../utils/hive'), hiveRpcBatch: jest.fn() }));

const mockSendOperations = jest.fn();
const F = require('./_fixtures');

process.env.AD_PAYOUT_ACTIVE_KEY = F.testActiveKey();
process.env.AD_PAYOUT_SOURCE = 'payout-source';
process.env.AD_PAYOUTS_ENABLED = 'true';

const { PrivateKey } = jest.requireActual('@hiveio/dhive');
const { hiveRpcBatch } = require('../../utils/hive');
const testDb = require('../helpers/db');
const P = require('../../services/adPayouts');
const { ensureAdIndexes } = require('../../utils/adModel');

const db = testDb.use();
const sentOps = () => mockSendOperations.mock.calls.map(([ops]) => ops[0][1]);

beforeAll(() => ensureAdIndexes());
beforeEach(() => {
  F.pinClock();
  mockSendOperations.mockReset();
  mockSendOperations.mockImplementation(async () => ({ id: 'chain-trx' }));
  hiveRpcBatch.mockReset();
  hiveRpcBatch.mockImplementation(F.contentChain());
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.useRealTimers());

/** Load a fresh copy of the module under a different environment. */
function isolatedPayouts(env, { dbModule } = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  let mod;
  jest.isolateModules(() => {
    if (dbModule) jest.doMock('../../utils/db', () => dbModule);
    mod = require('../../services/adPayouts');
    // doMock is not scoped to the isolated registry: undo it, or the database helper
    // gets the stub in afterAll and the connection is never closed.
    if (dbModule) jest.dontMock('../../utils/db');
  });
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return mod;
}

describe('returning a payment we refused', () => {
  const refused = (over = {}) => ({
    trx_id: 'stray-1', status: 'refused', refundStatus: 'pending', reason: 'payer_mismatch',
    from: 'stranger', amount: '5.000 HBD', refundTo: 'stranger', refundAmount: '5.000 HBD', expectedFrom: 'adv', ...over,
  });
  const paymentOf = (trx = 'stray-1') => F.cols(db()).payments.findOne({ trx_id: trx });

  test('sends back exactly what arrived, in its asset, to the account that sent it, and records the receipt', async () => {
    await F.cols(db()).payments.insertOne(refused({ amount: '12.5 HIVE', refundAmount: '12.5 HIVE' }));
    expect(await P.refundRefusedPayments(db())).toEqual({ refunded: 1, dryRun: false });
    expect(sentOps()).toEqual([{
      from: 'payout-source', to: 'stranger', amount: '12.500 HIVE',
      memo: '3Speak ads: returned - please pay from @adv',
    }]);
    expect(await paymentOf()).toMatchObject({
      refundStatus: 'returned', returnedTrxId: 'chain-trx', returnedBy: 'auto', returnedAt: F.NOW, refundAttempts: 1,
    });
  });

  test('falls back to the original amount and sender, and names no account it does not know', async () => {
    await F.cols(db()).payments.insertOne(refused({ refundAmount: undefined, refundTo: undefined, expectedFrom: null }));
    mockSendOperations.mockResolvedValue({});
    await P.refundRefusedPayments(db());
    expect(sentOps()[0]).toMatchObject({ to: 'stranger', amount: '5.000 HBD', memo: expect.stringContaining('the account the campaign is booked under') });
    expect((await paymentOf()).returnedTrxId).toBeNull();
  });

  test.each([
    ['an amount that does not parse', { refundAmount: 'lots HBD' }],
    ['a zero amount', { refundAmount: '0.000 HBD' }],
    ['an asset we never accept', { refundAmount: '5.000 BTC' }],
    ['no recipient', { refundTo: '', from: '' }],
  ])('%s is parked for a human and never broadcast', async (_label, over) => {
    await F.cols(db()).payments.insertOne(refused(over));
    expect(await P.refundRefusedPayments(db())).toEqual({ refunded: 0, dryRun: false });
    expect(mockSendOperations).not.toHaveBeenCalled();
    expect(await paymentOf()).toMatchObject({ refundStatus: 'review', lastError: expect.stringContaining('unreturnable') });
  });

  test('a failed return goes back to pending, and after three attempts is parked rather than risked twice', async () => {
    await F.cols(db()).payments.insertOne(refused());
    mockSendOperations.mockRejectedValue(new Error('timeout'));
    await P.refundRefusedPayments(db());
    expect(await paymentOf()).toMatchObject({ refundStatus: 'pending', refundAttempts: 1, lastError: 'timeout' });
    await P.refundRefusedPayments(db());
    await P.refundRefusedPayments(db());
    expect(await paymentOf()).toMatchObject({ refundStatus: 'review', refundAttempts: 3 });
    expect(console.error).toHaveBeenLastCalledWith(expect.stringContaining('CHECK THE CHAIN'));
  });

  test('a refund already being sent, or already returned, is not sent again', async () => {
    await F.cols(db()).payments.insertMany([refused({ trx_id: 'a', refundStatus: 'sending' }), refused({ trx_id: 'b', refundStatus: 'returned' })]);
    expect(await P.refundRefusedPayments(db())).toEqual({ refunded: 0, dryRun: false });
    expect(mockSendOperations).not.toHaveBeenCalled();
  });

  test('two refund runs at once return a payment once', async () => {
    await F.cols(db()).payments.insertOne(refused());
    const [a, b] = await Promise.all([P.refundRefusedPayments(db()), P.refundRefusedPayments(db())]);
    expect(a.refunded + b.refunded).toBe(1);
    expect(mockSendOperations).toHaveBeenCalledTimes(1);
  });
});

describe('payPending with the configured key', () => {
  test('signs with the configured active key through its own client', async () => {
    await F.cols(db()).payouts.insertOne({ periodKey: 'p', account: 'creatorx', kind: 'creator', hbd: 1, amounts: [{ symbol: 'HBD', amount: 1 }], status: 'pending' });
    expect(await P.payPending(db())).toEqual({ sent: 1, dryRun: false });
    const [, key] = mockSendOperations.mock.calls[0];
    expect(key).toBeInstanceOf(PrivateKey);
    expect(key.createPublic().toString()).toBe(PrivateKey.fromString(F.testActiveKey()).createPublic().toString());
  });

  test('with nothing pending it reports a live run that sent nothing', async () => {
    expect(await P.payPending(db())).toEqual({ sent: 0, dryRun: false });
  });
});

describe('the scheduled run', () => {
  // Now is 2026-11-01T12:00Z, inside period 2026-10-31.
  const p25 = P.periodContaining(Date.parse('2026-10-26T12:00:00Z'));
  const settledKeys = async () => (await F.cols(db()).periods.find({ status: 'settled' }).sort({ _id: 1 }).toArray()).map((p) => p._id);

  test('closes finished flights, settles every elapsed period, sends the payouts and returns stray payments', async () => {
    const c = await F.seedCampaign(db(), p25, { status: 'running', deliveredImpressions: 4, forecastImpressions: 4 });
    await F.seedImpressions(db(), c, 4, { owner: 'creatorx', period: p25 });
    await F.cols(db()).payments.insertOne({ trx_id: 'stray', status: 'refused', refundStatus: 'pending', from: 'stranger', amount: '1.000 HBD' });

    expect(await P.runOnce()).toEqual({ closed: 1, settled: 2, sent: 2, dryRun: false, refunded: 1 });

    expect(await settledKeys()).toEqual(['2026-10-25', '2026-10-28']);
    expect(sentOps().map((op) => `${op.to} ${op.amount}`).sort()).toEqual(['creatorx 50.000 HBD', 'encoder.pay 5.000 HBD', 'stranger 1.000 HBD']);
    expect((await F.cols(db()).campaigns.findOne({ _id: c._id })).status).toBe('complete');
  });

  test('after downtime it resumes from the last settled period and settles every one since, even those that served nothing', async () => {
    await F.cols(db()).periods.insertOne({ _id: '2026-10-16', status: 'settled', endAt: new Date('2026-10-19T07:00:00Z') });
    expect(await P.runOnce()).toMatchObject({ settled: 4, sent: 0 });
    expect(await settledKeys()).toEqual(['2026-10-16', '2026-10-19', '2026-10-22', '2026-10-25', '2026-10-28']);
  });

  test('a first run anchors on the oldest thing that could owe anybody: here an unpaid watch', async () => {
    await F.seedWatches(db(), [['viewer-a', 100]], { updatedAt: new Date('2026-10-26T00:00:00Z') });
    expect(await P.runOnce()).toMatchObject({ settled: 2 });
    expect(await settledKeys()).toEqual(['2026-10-25', '2026-10-28']);
  });

  test('a first run with nothing anywhere settles nothing and sends nothing', async () => {
    expect(await P.runOnce()).toEqual({ closed: 0, settled: 0, sent: 0, dryRun: false, refunded: 0 });
    expect(mockSendOperations).not.toHaveBeenCalled();
  });

  test('credit held by a booking abandoned unpaid is released by the run', async () => {
    const c = await F.seedCampaign(db(), p25, {
      // An unpaid booking has no flight yet: claim sets the dates once it is paid.
      status: 'awaiting_payment', paidHbd: 20, priceHbd: 20, creditAppliedHbd: 20, startAt: null, endAt: null,
      createdAt: new Date('2026-09-01T00:00:00Z'),
    });
    await P.runOnce();
    expect(await F.cols(db()).campaigns.findOne({ _id: c._id })).toMatchObject({ creditReleasedHbd: 20, paidHbd: 0, amountDueHbd: 20 });
  });

  test('switched off, the run does nothing at all', async () => {
    const off = isolatedPayouts({ AD_PAYOUTS_ENABLED: 'false' });
    expect(await off.runOnce()).toBeNull();
  });

  test('a run that fails returns null and logs, rather than throwing into the scheduler', async () => {
    const broken = isolatedPayouts({}, { dbModule: { getDb: () => { throw new Error('no database'); } } });
    expect(await broken.runOnce()).toBeNull();
    expect(console.error).toHaveBeenCalledWith('[adPayout] run failed:', 'no database');
  });
});

describe('schedule()', () => {
  const FIRST_RUN_MS = 5 * 60 * 1000;
  const DAILY_MS = 24 * 60 * 60 * 1000;
  // Only the scheduler's own timers are caught; everything else (the MongoDB driver)
  // keeps real timers.
  const firstRuns = () => setTimeout.mock.calls.filter(([, ms]) => ms === FIRST_RUN_MS);
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const realTimeout = global.setTimeout;
    const realInterval = global.setInterval;
    jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms, ...a) => (ms === FIRST_RUN_MS ? 0 : realTimeout(fn, ms, ...a)));
    jest.spyOn(global, 'setInterval').mockImplementation((fn, ms, ...a) => (ms === DAILY_MS ? 0 : realInterval(fn, ms, ...a)));
  });

  test('with a valid key it schedules a LIVE run five minutes after boot', () => {
    P.schedule();
    expect(firstRuns()).toHaveLength(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('from @payout-source [LIVE]'));
  });

  test('without a key it still schedules, as a DRY RUN', () => {
    isolatedPayouts({ AD_PAYOUT_ACTIVE_KEY: '' }).schedule();
    expect(firstRuns()).toHaveLength(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[DRY RUN]'));
  });

  test.each([
    ['payouts are switched off', { AD_PAYOUTS_ENABLED: 'false' }, 'log', 'disabled (AD_PAYOUTS_ENABLED=false)'],
    ['there is no source account', { AD_PAYOUT_SOURCE: '   ', AD_PAYMENT_ACCOUNT: '   ' }, 'log', 'no payout source account'],
    ['the key does not parse', { AD_PAYOUT_ACTIVE_KEY: 'not-a-key' }, 'error', 'does not parse'],
  ])('nothing is scheduled when %s', (_label, env, channel, message) => {
    isolatedPayouts(env).schedule();
    expect(firstRuns()).toHaveLength(0);
    expect(console[channel]).toHaveBeenCalledWith(expect.stringContaining(message));
  });

  test('the first run starts the daily interval', async () => {
    const mod = isolatedPayouts({}, { dbModule: { getDb: () => { throw new Error('no database'); } } });
    mod.schedule();
    const [[first]] = firstRuns();
    first();
    expect(setInterval).toHaveBeenCalledWith(mod.runOnce, DAILY_MS);
  });
});
