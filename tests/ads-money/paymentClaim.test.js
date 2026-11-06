/**
 * Proving an advertiser's payment and scheduling the flight
 * (services/adPaymentClaim.js claimCampaignPayment), against a real MongoDB.
 *
 * The chain is a mocked utils/hive: `transfersSince` returns the payment account's
 * history as a node would, `hiveRpcBatch` answers the median price feed.
 *
 * Covers: matching a transfer by memo, valuing HIVE at the on-chain median, partial
 * and full payment, exactly-once crediting on the unique txid, the payer binding (a
 * payment from any other account is refused and queued for return), spending
 * advertiser credit to close a shortfall, and the per-campaign lock that stops two
 * concurrent claims losing a credit. Ports scripts/test-ad-payer-binding.
 */
process.env.AD_PAYMENT_ACCOUNT = 'ads-account';

jest.mock('../../utils/hive', () => ({
  ...jest.requireActual('../../utils/hive'),
  transfersSince: jest.fn(),
  hiveRpcBatch: jest.fn(),
}));

const { ObjectId } = require('mongodb');
const { transfersSince, hiveRpcBatch } = require('../../utils/hive');
const testDb = require('../helpers/db');
const F = require('./_fixtures');
const { claimCampaignPayment, getHbdPerHive, parseAsset, priceOf } = require('../../services/adPaymentClaim');
const { balanceOf } = require('../../utils/adBalance');
const cfg = require('../../utils/config');

const db = testDb.use();
const ACCOUNT = 'ads-account';
const HOUR = 3600 * 1000;
const medianFeed = (base, quote) => hiveRpcBatch.mockResolvedValue([{ id: 1, result: { base, quote } }]);

let seq = 0;
/** A payment into the ads account for campaign `c`. */
const pay = (c, amount, { from = 'adv', memo = c.memo, to = ACCOUNT } = {}) => {
  seq += 1;
  return F.transferEntry({ index: seq, trxId: `trx-${seq}`, from, to, amount, memo });
};

/** An unpaid 100 HBD, 7-day booking by @adv, booked an hour ago. */
async function booking(over = {}) {
  const _id = new ObjectId();
  const c = {
    _id, memo: `ad:${_id}`, advertiserRef: 'adv-ref', hiveAccount: 'adv', status: 'awaiting_payment',
    priceHbd: 100, paidHbd: 0, days: 7, createdAt: new Date(F.NOW.getTime() - HOUR), ...over,
  };
  await F.cols(db()).campaigns.insertOne(c);
  return c;
}
const campaignOf = (c) => F.cols(db()).campaigns.findOne({ _id: c._id });
const chainHas = (...entries) => transfersSince.mockResolvedValue(entries);

beforeEach(() => {
  F.pinClock();
  transfersSince.mockReset();
  hiveRpcBatch.mockReset();
  transfersSince.mockResolvedValue([]);
  medianFeed('0.250 HBD', '1.000 HIVE'); // 1 HIVE = 0.25 HBD
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.useRealTimers());

describe('finding the payment', () => {
  test('a campaign that does not exist is a 404', async () => {
    expect(await claimCampaignPayment(db(), new ObjectId())).toEqual({ status: 404, body: { success: false, error: 'Campaign not found' } });
  });

  test('a cancelled campaign cannot be paid for', async () => {
    const c = await booking({ status: 'cancelled' });
    expect(await claimCampaignPayment(db(), c._id)).toMatchObject({ status: 409, body: { error: 'That campaign was cancelled' } });
  });

  test('no matching transfer yet: a 404 that says exactly what to send', async () => {
    const c = await booking();
    const res = await claimCampaignPayment(db(), c._id);
    expect(res).toEqual({
      status: 404,
      body: { success: false, error: 'No matching transfer found yet', expect: { to: ACCOUNT, memo: c.memo, amount: '100.000 HBD' } },
    });
  });

  test('only a transfer INTO the ads account with this campaign\'s memo matches', async () => {
    const c = await booking();
    const other = await booking();
    chainHas(
      pay(c, '100.000 HBD', { to: 'someone-else' }),
      pay(other, '100.000 HBD'),
      [99, { trx_id: 'vote', op: ['vote', { voter: 'adv' }] }],
      [98, { op: ['transfer', { from: 'adv', to: ACCOUNT, amount: '100.000 HBD', memo: c.memo }] }], // no trx_id
      null,
    );
    expect((await claimCampaignPayment(db(), c._id)).status).toBe(404);
  });

  test('the memo matches whatever its case and surrounding spaces', async () => {
    const c = await booking();
    chainHas(pay(c, '100.000 HBD', { memo: `  ${c.memo.toUpperCase()} ` }));
    expect((await claimCampaignPayment(db(), c._id)).body.message).toBe('Payment received, flight scheduled');
  });

  test('a campaign with no stored memo matches the default ad:<id>', async () => {
    const c = await booking({ memo: undefined });
    chainHas(pay(c, '100.000 HBD', { memo: `ad:${c._id}` }));
    expect((await claimCampaignPayment(db(), c._id)).status).toBe(200);
  });

  test('the scan is bounded by date: it reaches back to an hour before the booking', async () => {
    const c = await booking();
    await claimCampaignPayment(db(), c._id);
    expect(transfersSince).toHaveBeenCalledWith(ACCOUNT, c.createdAt.getTime() - HOUR);
  });

  test('a booking with no date scans the whole booking-expiry window, plus a day', async () => {
    const c = await booking({ createdAt: undefined });
    await claimCampaignPayment(db(), c._id);
    expect(transfersSince).toHaveBeenCalledWith(ACCOUNT, F.NOW.getTime() - (cfg.AD_BOOKING_EXPIRY_DAYS + 1) * F.DAY);
  });

  test('history the caller already read is used without reading the chain again', async () => {
    const c = await booking();
    const res = await claimCampaignPayment(db(), c._id, { ops: [pay(c, '100.000 HBD')] });
    expect(res.status).toBe(200);
    expect(transfersSince).not.toHaveBeenCalled();
  });
});

describe('crediting a payment', () => {
  test('payment in full from the booked account schedules the flight from now', async () => {
    const c = await booking();
    const entry = pay(c, '100.000 HBD');
    chainHas(entry);
    const res = await claimCampaignPayment(db(), c._id);
    expect(res.body).toEqual({ success: true, message: 'Payment received, flight scheduled', creditedHbd: 100 });
    expect(await campaignOf(c)).toMatchObject({
      status: 'scheduled', paidHbd: 100, paidAssets: { HBD: 100 },
      startAt: F.NOW, endAt: new Date(F.NOW.getTime() + 7 * F.DAY),
    });
    expect(await F.cols(db()).payments.findOne({ trx_id: entry[1].trx_id })).toMatchObject({
      status: 'credited', campaignId: c._id, from: 'adv', amount: '100.000 HBD', processedAt: F.NOW,
    });
    expect(res.campaign).toMatchObject({ status: 'scheduled' });
  });

  test('a requested start in the future is honoured: the flight is not shortened by paying early', async () => {
    const startAt = new Date(F.NOW.getTime() + 3 * F.DAY);
    const c = await booking({ requestedStartAt: startAt });
    chainHas(pay(c, '100.000 HBD'));
    await claimCampaignPayment(db(), c._id);
    expect(await campaignOf(c)).toMatchObject({ startAt, endAt: new Date(startAt.getTime() + 7 * F.DAY) });
  });

  test('HIVE is valued at the on-chain median, and the HIVE itself is what is recorded as paid', async () => {
    const c = await booking();
    chainHas(pay(c, '400.000 HIVE'));
    const res = await claimCampaignPayment(db(), c._id);
    expect(res.body.creditedHbd).toBe(100);
    expect(await campaignOf(c)).toMatchObject({ status: 'scheduled', paidHbd: 100, paidAssets: { HIVE: 400 } });
  });

  test('a part payment is recorded, and the rest completes it without counting the first twice', async () => {
    const c = await booking();
    const first = pay(c, '40.000 HBD');
    chainHas(first);
    expect((await claimCampaignPayment(db(), c._id)).body).toMatchObject({ message: 'Partial payment received', creditedHbd: 40 });
    expect(await campaignOf(c)).toMatchObject({ status: 'awaiting_payment', paidHbd: 40 });

    chainHas(first, pay(c, '240.000 HIVE'));
    expect((await claimCampaignPayment(db(), c._id)).body).toMatchObject({ message: 'Payment received, flight scheduled', creditedHbd: 60 });
    expect(await campaignOf(c)).toMatchObject({ status: 'scheduled', paidHbd: 100, paidAssets: { HBD: 40, HIVE: 240 } });
  });

  test('claiming again for the same transfer credits nothing more', async () => {
    const c = await booking({ creativeEmbedId: 'creative-1' });
    await db().collection(cfg.AD_CREATIVES_COLLECTION).insertOne({ embedId: 'creative-1', name: 'spot' });
    chainHas(pay(c, '100.000 HBD'));
    await claimCampaignPayment(db(), c._id);
    const again = await claimCampaignPayment(db(), c._id);
    expect(again).toMatchObject({ status: 200, body: { success: true, message: 'Already credited' }, creative: { embedId: 'creative-1' } });
    expect((await campaignOf(c)).paidHbd).toBe(100);
  });

  test('an asset other than HBD or HIVE is neither valued nor recorded as paid', async () => {
    const c = await booking();
    chainHas(pay(c, '100.000 TESTS'), pay(c, '10.000 HBD'));
    const res = await claimCampaignPayment(db(), c._id);
    expect(res.body.creditedHbd).toBe(10);
    expect((await campaignOf(c)).paidAssets).toEqual({ HBD: 10 });
  });

  test('a self-promotion booking priced by totalHbd is scheduled once paid in full', async () => {
    const c = await booking({ priceHbd: undefined, totalHbd: 10 });
    chainHas(pay(c, '10.000 HBD'));
    await claimCampaignPayment(db(), c._id);
    expect((await campaignOf(c)).status).toBe('scheduled');
  });

  /* BUG (services/adPaymentClaim.js:212-233). When the median price feed cannot be
   * read, getHbdPerHive() returns 0 and a HIVE payment is credited at 0 HBD, while
   * its txid is reserved as `credited`. Every later claim then skips that transfer
   * as already counted, so the advertiser's HIVE is recorded in paidAssets but never
   * valued, and the flight is never scheduled without a manual fix. A missing price
   * should refuse to credit (release the reservation) so a retry can value it. */
  test.skip('BUG: a HIVE payment made while the price feed is down is credited once the feed is back', async () => {
    const c = await booking();
    chainHas(pay(c, '400.000 HIVE'));
    hiveRpcBatch.mockResolvedValue([]); // every node down
    await claimCampaignPayment(db(), c._id).catch(() => {});
    medianFeed('0.250 HBD', '1.000 HIVE');
    await claimCampaignPayment(db(), c._id);
    expect(await campaignOf(c)).toMatchObject({ status: 'scheduled', paidHbd: 100 });
  });
});

describe('who may pay', () => {
  test('a payment from another account is refused, recorded, and queued to go back to its sender', async () => {
    const c = await booking();
    const entry = pay(c, '100.000 HBD', { from: 'stranger' });
    chainHas(entry);
    const res = await claimCampaignPayment(db(), c._id);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      success: false, expectedFrom: 'adv',
      refused: [{ from: 'stranger', amount: '100.000 HBD', willBeReturnedTo: 'stranger' }],
      error: expect.stringContaining('Pay from @adv'),
    });
    expect(await F.cols(db()).payments.findOne({ trx_id: entry[1].trx_id })).toMatchObject({
      status: 'refused', reason: 'payer_mismatch', expectedFrom: 'adv',
      refundStatus: 'pending', refundTo: 'stranger', refundAmount: '100.000 HBD',
    });
    expect(await campaignOf(c)).toMatchObject({ status: 'awaiting_payment', paidHbd: 0 });
  });

  test.each([
    ['case and spaces on the booked account are cosmetic', ' ADV ', 'adv', 200],
    ['a lookalike name is not the same account', 'adv', 'adv2', 409],
    ['a dotted sub-account is not the same account', 'adv', 'adv.vsc', 409],
  ])('%s', async (_label, hiveAccount, from, status) => {
    const c = await booking({ hiveAccount });
    chainHas(pay(c, '100.000 HBD', { from }));
    expect((await claimCampaignPayment(db(), c._id)).status).toBe(status);
  });

  test('a campaign with no account on it fails closed: nothing can be credited to it', async () => {
    const c = await booking({ hiveAccount: '' });
    const entry = pay(c, '100.000 HBD');
    chainHas(entry);
    expect((await claimCampaignPayment(db(), c._id)).status).toBe(409);
    expect(await F.cols(db()).payments.findOne({ trx_id: entry[1].trx_id })).toMatchObject({ reason: 'advertiser_unknown', expectedFrom: null });
  });

  test('retrying a claim never queues the same stray payment for return twice', async () => {
    const c = await booking();
    chainHas(pay(c, '100.000 HBD', { from: 'stranger' }));
    await claimCampaignPayment(db(), c._id);
    await claimCampaignPayment(db(), c._id);
    expect(await F.cols(db()).payments.countDocuments({ refundStatus: 'pending' })).toBe(1);
    // The unique txid index is what makes that so.
    const [refusedRow] = await F.cols(db()).payments.find({}).toArray();
    await expect(F.cols(db()).payments.insertOne({ trx_id: refusedRow.trx_id, status: 'refused' }))
      .rejects.toMatchObject({ code: 11000 });
  });

  /* BUG (services/adPaymentClaim.js:186-206). The comment there says "already
   * credited" in front of somebody whose payment was refused would be actively
   * misleading about where their money went. That is what a RETRY answers: the
   * refused transfer is already reserved, so `refused` is empty the second time and
   * the advertiser is told `success: true, 'Already credited'` for a flight that is
   * still unpaid. */
  test.skip('BUG: retrying the claim of a refused payment still says it was refused', async () => {
    const c = await booking();
    chainHas(pay(c, '100.000 HBD', { from: 'stranger' }));
    await claimCampaignPayment(db(), c._id);
    const retry = await claimCampaignPayment(db(), c._id);
    expect(retry.body.success).toBe(false);
    expect(retry.body.message).not.toBe('Already credited');
  });

  test('a right payment alongside a stray one is credited, and the stray one is reported', async () => {
    const c = await booking();
    chainHas(pay(c, '60.000 HBD'), pay(c, '40.000 HBD', { from: 'stranger' }));
    const res = await claimCampaignPayment(db(), c._id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      message: 'Partial payment received', creditedHbd: 60,
      refused: [{ from: 'stranger', amount: '40.000 HBD', willBeReturnedTo: 'stranger' }],
      refusedNote: expect.stringContaining('Pay from @adv'),
    });
    expect((await campaignOf(c)).paidHbd).toBe(60);
  });
});

describe('spending advertiser credit at claim time', () => {
  const earnedCredit = (hbd) => F.cols(db()).campaigns.insertOne({ advertiserRef: 'adv-ref', creditHbd: hbd });

  test('credit closes the shortfall and the flight is scheduled', async () => {
    await earnedCredit(75);
    const c = await booking();
    chainHas(pay(c, '25.000 HBD'));
    const res = await claimCampaignPayment(db(), c._id);
    expect(res.body).toMatchObject({ message: 'Payment received, flight scheduled', creditAppliedHbd: 75, creditNote: expect.stringContaining('75 HBD of credit') });
    expect(await campaignOf(c)).toMatchObject({ status: 'scheduled', paidHbd: 100, creditAppliedHbd: 75, creditAppliedAt: F.NOW });
    expect(await balanceOf(db(), 'adv-ref')).toBe(0);
  });

  test('never more than the shortfall: the rest stays on the balance', async () => {
    await earnedCredit(75);
    const c = await booking();
    chainHas(pay(c, '90.000 HBD'));
    await claimCampaignPayment(db(), c._id);
    expect((await campaignOf(c)).creditAppliedHbd).toBe(10);
    expect(await balanceOf(db(), 'adv-ref')).toBe(65);
  });

  test('a flight paid in full spends no credit at all', async () => {
    await earnedCredit(75);
    const c = await booking();
    chainHas(pay(c, '100.000 HBD'));
    await claimCampaignPayment(db(), c._id);
    expect((await campaignOf(c)).creditAppliedHbd).toBeUndefined();
    expect(await balanceOf(db(), 'adv-ref')).toBe(75);
  });

  test('credit is applied once per campaign, never drawn a second time', async () => {
    await earnedCredit(75);
    const c = await booking({ creditAppliedHbd: 5, paidHbd: 5 });
    chainHas(pay(c, '10.000 HBD'));
    await claimCampaignPayment(db(), c._id);
    expect(await campaignOf(c)).toMatchObject({ creditAppliedHbd: 5, paidHbd: 15, status: 'awaiting_payment' });
  });

  test('a credit that would not cover the whole shortfall is still applied, as a part payment', async () => {
    await earnedCredit(20);
    const c = await booking();
    chainHas(pay(c, '30.000 HBD'));
    await claimCampaignPayment(db(), c._id);
    expect(await campaignOf(c)).toMatchObject({ paidHbd: 50, creditAppliedHbd: 20, status: 'awaiting_payment' });
  });
});

describe('never losing or doubling a payment', () => {
  test('a failed campaign write releases the reservation, so the retry can credit it', async () => {
    const c = await booking();
    chainHas(pay(c, '100.000 HBD'));
    const real = F.cols(db()).campaigns;
    const failing = {
      collection: (name) => (name !== real.collectionName ? db().collection(name) : {
        findOne: (...a) => real.findOne(...a),
        updateOne: async () => { throw new Error('write failed'); },
      }),
    };
    await expect(claimCampaignPayment(failing, c._id)).rejects.toThrow('write failed');
    expect(await F.cols(db()).payments.countDocuments({})).toBe(0);

    const retry = await claimCampaignPayment(db(), c._id);
    expect(retry.body.message).toBe('Payment received, flight scheduled');
  });

  test('two claims at once for DIFFERENT transfers both count: neither write erases the other', async () => {
    const c = await booking();
    const [a, b] = [pay(c, '50.000 HBD'), pay(c, '50.000 HBD')];
    await Promise.all([
      claimCampaignPayment(db(), c._id, { ops: [a] }),
      claimCampaignPayment(db(), c._id, { ops: [b] }),
    ]);
    expect(await campaignOf(c)).toMatchObject({ paidHbd: 100, status: 'scheduled' });
  });

  test('two claims at once for the SAME transfer credit it once', async () => {
    const c = await booking();
    const ops = [pay(c, '50.000 HBD')];
    const results = await Promise.all([claimCampaignPayment(db(), c._id, { ops }), claimCampaignPayment(db(), c._id, { ops })]);
    expect(results.map((r) => r.body.message).sort()).toEqual(['Already credited', 'Partial payment received']);
    expect((await campaignOf(c)).paidHbd).toBe(50);
  });

  test('a claim that failed does not block the next claim for the same campaign', async () => {
    const c = await booking();
    transfersSince.mockRejectedValueOnce(new Error('node down'));
    await expect(claimCampaignPayment(db(), c._id)).rejects.toThrow('node down');
    chainHas(pay(c, '100.000 HBD'));
    expect((await claimCampaignPayment(db(), c._id)).status).toBe(200);
  });
});

describe('the small helpers', () => {
  test.each([
    ['0.250 HBD', '1.000 HIVE', 0.25],
    ['1.000 HBD', '4.000 HIVE', 0.25],
    [undefined, '1.000 HIVE', 0],
    ['0.250 HBD', '0.000 HIVE', 0],
  ])('the median %s / %s values a HIVE at %p HBD', async (base, quote, want) => {
    medianFeed(base, quote);
    expect(await getHbdPerHive()).toBe(want);
  });

  test('an unreachable price feed values HIVE at 0', async () => {
    hiveRpcBatch.mockResolvedValue([]);
    expect(await getHbdPerHive()).toBe(0);
  });

  test.each([
    ['10.000 HBD', { amount: 10, symbol: 'HBD' }],
    [' 2.5 hive ', { amount: 2.5, symbol: 'HIVE' }],
    ['abc', { amount: 0, symbol: '' }],
    [undefined, { amount: 0, symbol: '' }],
  ])('parseAsset(%p) reads the amount and the symbol', (s, want) => {
    expect(parseAsset(s)).toEqual(want);
  });

  test.each([
    [{ priceHbd: 100, totalHbd: 5 }, 100],
    [{ totalHbd: 5 }, 5],
    [{ priceHbd: 0, totalHbd: 5 }, 0],
    [{}, 0],
  ])('priceOf(%p) is %p', (c, want) => {
    expect(priceOf(c)).toBe(want);
  });
});
