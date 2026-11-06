/**
 * Sending payouts (services/adPayouts.js payPending) and the refund dry run.
 *
 * No active key is configured in this file, so the module is in its default DRY
 * RUN. The "sending" tests inject a recording client through `deps.client`, the seam
 * payPending has for exactly this: nothing is broadcast, every transfer is captured.
 *
 * Covers claim-then-send, one transfer per asset leg, a partly-failed payout that
 * must not re-send the leg that landed, parking after repeated failures, legs too
 * small to send, legacy rows, and two runs racing for the same rows.
 * Ports scripts/test-ad-payout-safety case 1.
 */
process.env.AD_PAYOUT_SOURCE = 'payout-source';

const testDb = require('../helpers/db');
const F = require('./_fixtures');
const P = require('../../services/adPayouts');
const { ensureAdIndexes } = require('../../utils/adModel');

const db = testDb.use();
const KEY = 'test-key-object';

beforeAll(() => ensureAdIndexes());
beforeEach(() => {
  F.pinClock();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.useRealTimers());

const pending = (over = {}) => ({
  periodKey: '2026-10-01', account: 'creatorx', kind: 'creator', hbd: 10,
  amounts: [{ symbol: 'HBD', amount: 10 }], status: 'pending', createdAt: F.NOW, ...over,
});
const seed = async (...rows) => { await F.cols(db()).payouts.insertMany(rows); };
const rowOf = (account = 'creatorx') => F.cols(db()).payouts.findOne({ account });
const amounts = (client) => client.attempts.map((a) => a.ops[0][1].amount);

describe('without an active key nothing is sent', () => {
  test('pending payouts are only logged as what would be sent, and stay pending', async () => {
    await seed(pending());
    expect(await P.payPending(db())).toEqual({ sent: 0, dryRun: true });
    expect((await rowOf()).status).toBe('pending');
  });

  test('with nothing pending the run is a no-op that still reports dry run', async () => {
    expect(await P.payPending(db())).toEqual({ sent: 0, dryRun: true });
  });

  test('refused payments waiting for a refund are only logged, not returned', async () => {
    await F.cols(db()).payments.insertOne({ trx_id: 't1', status: 'refused', refundStatus: 'pending', from: 'stranger', amount: '5.000 HBD' });
    expect(await P.refundRefusedPayments(db())).toEqual({ refunded: 0, dryRun: true });
    expect((await F.cols(db()).payments.findOne({ trx_id: 't1' })).refundStatus).toBe('pending');
  });

  test('with no refund owed the refund pass is a no-op', async () => {
    expect(await P.refundRefusedPayments(db())).toEqual({ refunded: 0, dryRun: true });
  });
});

describe('sending a payout', () => {
  test('one transfer per asset leg, from the payout account, with the memo, then marked paid', async () => {
    await seed(pending({ hbd: 30, amounts: [{ symbol: 'HBD', amount: 10 }, { symbol: 'hive', amount: 200 }] }));
    const client = F.recordingClient();
    expect(await P.payPending(db(), { client, key: KEY })).toEqual({ sent: 1, dryRun: false });
    expect(client.sent).toEqual([
      { from: 'payout-source', to: 'creatorx', amount: '10.000 HBD', memo: '3Speak ad revenue share (creator) - 2026-10-01' },
      { from: 'payout-source', to: 'creatorx', amount: '200.000 HIVE', memo: '3Speak ad revenue share (creator) - 2026-10-01' },
    ]);
    expect(client.attempts.every((a) => a.key === KEY && a.ops.length === 1 && a.ops[0][0] === 'transfer')).toBe(true);
    expect(await rowOf()).toMatchObject({ status: 'paid', paidAt: F.NOW, sentLegs: ['HBD', 'HIVE'], attempts: 1 });
  });

  test('a row written before `amounts` existed is paid its HBD figure', async () => {
    await seed(pending({ amounts: undefined, hbd: 1.2346 }));
    const client = F.recordingClient();
    await P.payPending(db(), { client, key: KEY });
    expect(amounts(client)).toEqual(['1.235 HBD']);
  });

  test('an earner bonus row carries the referral-bonus memo', async () => {
    await seed(pending({ kind: 'earner-referral' }));
    const client = F.recordingClient();
    await P.payPending(db(), { client, key: KEY });
    expect(client.sent[0].memo).toBe('3Speak referral bonus - 2026-10-01');
  });

  test('a leg below the 0.001 minimum is skipped and the rest is sent', async () => {
    await seed(pending({ amounts: [{ symbol: 'HBD', amount: 5 }, { symbol: 'HIVE', amount: 0.0004 }] }));
    const client = F.recordingClient();
    await P.payPending(db(), { client, key: KEY });
    expect(amounts(client)).toEqual(['5.000 HBD']);
    expect((await rowOf()).status).toBe('paid');
  });

  test('a row with no leg that can be sent is parked for review, never marked paid', async () => {
    await seed(pending({ hbd: 0.0004, amounts: [{ symbol: 'HBD', amount: 0.0004 }] }));
    const client = F.recordingClient();
    expect(await P.payPending(db(), { client, key: KEY })).toEqual({ sent: 0, dryRun: false });
    expect(client.attempts).toEqual([]);
    expect(await rowOf()).toMatchObject({ status: 'review', lastError: 'no leg reaches the 0.001 minimum', lastTriedAt: F.NOW });
  });

  test('rows that are not pending (paid, under review, being sent) are left alone', async () => {
    await seed(pending({ account: 'a', status: 'paid' }), pending({ account: 'b', status: 'review' }), pending({ account: 'c', status: 'sending' }));
    const client = F.recordingClient();
    await P.payPending(db(), { client, key: KEY });
    expect(client.attempts).toEqual([]);
  });
});

describe('a payout that fails part way', () => {
  test('the leg that landed is recorded and NOT re-sent; the retry sends only the missing leg', async () => {
    await seed(pending({ hbd: 30, amounts: [{ symbol: 'HBD', amount: 10 }, { symbol: 'HIVE', amount: 200 }] }));
    const flaky = F.recordingClient((op) => op.amount.endsWith('HIVE'));
    await P.payPending(db(), { client: flaky, key: KEY });
    expect(amounts(flaky)).toEqual(['10.000 HBD', '200.000 HIVE']);
    expect(await rowOf()).toMatchObject({ status: 'pending', sentLegs: ['HBD'], attempts: 1, lastError: 'simulated node failure' });

    const good = F.recordingClient();
    await P.payPending(db(), { client: good, key: KEY });
    expect(amounts(good)).toEqual(['200.000 HIVE']);
    expect(await rowOf()).toMatchObject({ status: 'paid', sentLegs: ['HBD', 'HIVE'], attempts: 2 });
    expect((await rowOf()).lastError).toBeUndefined();
  });

  test('after three failed attempts the row is parked for a human to check the chain', async () => {
    await seed(pending());
    const broken = F.recordingClient(() => true);
    for (let i = 0; i < 3; i += 1) await P.payPending(db(), { client: broken, key: KEY });
    expect(await rowOf()).toMatchObject({ status: 'review', attempts: 3 });
    expect(console.error).toHaveBeenLastCalledWith(expect.stringContaining('CHECK THE CHAIN'));
    // Parked means parked: a fourth run does not try again.
    await P.payPending(db(), { client: broken, key: KEY });
    expect(broken.attempts).toHaveLength(3);
  });

  test('one failing recipient does not stop the others', async () => {
    await seed(pending({ account: 'unlucky' }), pending({ account: 'lucky' }));
    const client = F.recordingClient((op) => op.to === 'unlucky');
    expect(await P.payPending(db(), { client, key: KEY })).toEqual({ sent: 1, dryRun: false });
    expect([(await rowOf('unlucky')).status, (await rowOf('lucky')).status]).toEqual(['pending', 'paid']);
  });
});

describe('two runs at once', () => {
  test('every leg is sent exactly once when two runs race over the same rows', async () => {
    await seed(...['a', 'b', 'c', 'd'].map((account) => pending({ account, amounts: [{ symbol: 'HBD', amount: 1 }, { symbol: 'HIVE', amount: 2 }] })));
    const client = F.recordingClient();
    const [one, two] = await Promise.all([
      P.payPending(db(), { client, key: KEY }),
      P.payPending(db(), { client, key: KEY }),
    ]);
    expect(one.sent + two.sent).toBe(4);
    expect(client.sent.map((op) => `${op.to} ${op.amount}`).sort()).toEqual([
      'a 1.000 HBD', 'a 2.000 HIVE', 'b 1.000 HBD', 'b 2.000 HIVE',
      'c 1.000 HBD', 'c 2.000 HIVE', 'd 1.000 HBD', 'd 2.000 HIVE',
    ]);
  });

  test('a row another run claimed after this one read it is skipped', async () => {
    await seed(pending());
    const payouts = F.cols(db()).payouts;
    // This run reads the row as pending; another run claims it before this one can.
    const racing = {
      collection: (name) => (name !== payouts.collectionName ? db().collection(name) : {
        find: (q) => ({
          toArray: async () => {
            const rows = await payouts.find(q).toArray();
            await payouts.updateMany({}, { $set: { status: 'sending' } });
            return rows;
          },
        }),
        findOneAndUpdate: (...a) => payouts.findOneAndUpdate(...a),
        updateOne: (...a) => payouts.updateOne(...a),
      }),
    };
    const client = F.recordingClient();
    expect(await P.payPending(racing, { client, key: KEY })).toEqual({ sent: 0, dryRun: false });
    expect(client.attempts).toEqual([]);
  });
});
