/**
 * What an advertiser is owed back, and how it is spent (services/adPayouts.js
 * closeFinishedCampaigns and releaseStaleCredit, utils/adBalance.js).
 *
 * A flight that under-delivered against its forecast becomes spendable CREDIT, not a
 * refund. The balance is derived from the campaigns that earned and spent it, never
 * a counter, so closing a campaign twice cannot double it and a crash cannot lose it.
 *
 * Ports scripts/test-ad-balance, against a real MongoDB with the clock pinned.
 */
const testDb = require('../helpers/db');
const F = require('./_fixtures');
const { closeFinishedCampaigns, releaseStaleCredit } = require('../../services/adPayouts');
const { balanceOf, ledgerOf, round3 } = require('../../utils/adBalance');
const { STATES } = require('../../utils/adModel');

const db = testDb.use();
const REF = 'adv-ref';
const ago = (days) => new Date(F.NOW.getTime() - days * F.DAY);
const camps = () => F.cols(db()).campaigns;

beforeEach(() => F.pinClock());
afterEach(() => jest.useRealTimers());

/** A flight that ended yesterday. */
async function endedFlight(over = {}) {
  const c = {
    advertiserRef: REF, hiveAccount: 'adv', name: 'flight', status: STATES.RUNNING,
    paidHbd: 100, priceHbd: 100, startAt: ago(14), endAt: ago(1),
    deliveredImpressions: 25, forecastImpressions: 100, createdAt: ago(15), ...over,
  };
  const { insertedId } = await camps().insertOne(c);
  return insertedId;
}

describe('closing a finished flight', () => {
  test('an under-delivered flight banks its shortfall as spendable credit, in the same write that closes it', async () => {
    const id = await endedFlight();
    expect(await closeFinishedCampaigns(db())).toBe(1);
    expect(await camps().findOne({ _id: id })).toMatchObject({
      status: STATES.COMPLETE, closedAt: F.NOW, deliveryRate: 0.25, undelivered: false,
      refundHbd: 75, creditHbd: 75, refundStatus: 'credited',
    });
    expect(await balanceOf(db(), REF)).toBe(75);
  });

  test.each([
    ['delivered nothing', { deliveredImpressions: 0 }, { refundHbd: 100, creditHbd: 100, refundStatus: 'credited', undelivered: true, deliveryRate: 0 }],
    ['delivered everything', { deliveredImpressions: 100 }, { refundHbd: 0, creditHbd: 0, refundStatus: 'none', deliveryRate: 1 }],
    ['over-delivered (owes nothing, and says so)', { deliveredImpressions: 120 }, { refundHbd: 0, creditHbd: 0, refundStatus: 'none', deliveryRate: 1.2 }],
    ['has no forecast on record (needs a human, invents nothing)', { forecastImpressions: 0, deliveredImpressions: 0 }, { refundHbd: null, creditHbd: 0, refundStatus: 'review', deliveryRate: null }],
    ['falls short by less than the 0.01 credit floor', { paidHbd: 0.01, priceHbd: 0.01, deliveredImpressions: 50 }, { refundHbd: 0.005, creditHbd: 0, refundStatus: 'none' }],
    ['falls short by exactly the 0.01 credit floor', { paidHbd: 0.02, priceHbd: 0.02, deliveredImpressions: 50 }, { refundHbd: 0.01, creditHbd: 0.01, refundStatus: 'credited' }],
    ['was never paid', { paidHbd: 0, deliveredImpressions: 0 }, { refundHbd: 0, creditHbd: 0, refundStatus: 'none' }],
  ])('a flight that %s', async (_label, over, want) => {
    const id = await endedFlight(over);
    await closeFinishedCampaigns(db());
    expect(await camps().findOne({ _id: id })).toMatchObject({ status: STATES.COMPLETE, ...want });
  });

  test('closing again never doubles the credit', async () => {
    await endedFlight();
    await closeFinishedCampaigns(db());
    expect(await closeFinishedCampaigns(db())).toBe(0);
    expect(await balanceOf(db(), REF)).toBe(75);
  });

  test('two runs racing to close the same flight bank its credit once', async () => {
    await endedFlight();
    const [a, b] = await Promise.all([closeFinishedCampaigns(db()), closeFinishedCampaigns(db())]);
    expect(a + b).toBe(1);
    expect(await balanceOf(db(), REF)).toBe(75);
  });

  test('flights still running, paused or already closed are left alone', async () => {
    const running = await endedFlight({ endAt: ago(-1) });
    const paused = await endedFlight({ status: STATES.PAUSED });
    const done = await endedFlight({ status: STATES.COMPLETE, creditHbd: 0 });
    expect(await closeFinishedCampaigns(db())).toBe(0);
    const statuses = await Promise.all([running, paused, done].map(async (id) => (await camps().findOne({ _id: id })).status));
    expect(statuses).toEqual([STATES.RUNNING, STATES.PAUSED, STATES.COMPLETE]);
  });

  test('a scheduled flight whose end has passed is closed too', async () => {
    const id = await endedFlight({ status: STATES.SCHEDULED, endAt: F.NOW });
    await closeFinishedCampaigns(db());
    expect((await camps().findOne({ _id: id })).status).toBe(STATES.COMPLETE);
  });
});

describe('the balance is derived, never stored', () => {
  test('a new advertiser, or none at all, has nothing', async () => {
    expect(await balanceOf(db(), REF)).toBe(0);
    expect(await balanceOf(db(), null)).toBe(0);
    expect(await ledgerOf(db(), '')).toEqual({ balanceHbd: 0, entries: [] });
  });

  test('balance = credit earned minus credit spent, across that advertiser\'s campaigns only', async () => {
    await camps().insertMany([
      { advertiserRef: REF, creditHbd: 75 },
      { advertiserRef: REF, creditHbd: 10.0004 },
      { advertiserRef: REF, creditAppliedHbd: 30 },
      { advertiserRef: 'someone-else', creditHbd: 500 },
    ]);
    expect(await balanceOf(db(), REF)).toBe(55);
  });

  test('never negative: a hand-edited document must not become a debt', async () => {
    await camps().insertMany([{ advertiserRef: REF, creditHbd: 10 }, { advertiserRef: REF, creditAppliedHbd: 999 }]);
    expect(await balanceOf(db(), REF)).toBe(0);
  });

  test('the ledger explains every entry in date order, in the advertiser\'s terms', async () => {
    await camps().insertMany([
      { advertiserRef: REF, name: 'spring', creditHbd: 75, deliveryRate: 0.25, closedAt: ago(10), createdAt: ago(20) },
      { advertiserRef: REF, name: 'summer', creditAppliedHbd: 50, creditAppliedAt: ago(5), createdAt: ago(5) },
      { advertiserRef: REF, name: 'autumn', creditAppliedHbd: 5, createdAt: ago(2) },
      { advertiserRef: REF, name: 'no credit either way', creditHbd: 0, createdAt: ago(1) },
    ]);
    const ledger = await ledgerOf(db(), REF);
    expect(ledger.balanceHbd).toBe(20);
    expect(ledger.entries.map((e) => [e.name, e.kind, e.hbd, e.reason])).toEqual([
      ['spring', 'earned', 75, 'Delivered 25% of the forecast for this flight'],
      ['summer', 'spent', 50, 'Applied to this booking'],
      ['autumn', 'spent', 5, 'Applied to this booking'],
    ]);
    expect(ledger.entries.map((e) => e.at)).toEqual([ago(10), ago(5), ago(2)]);
    expect(ledger.entries.every((e) => typeof e.campaignId === 'string')).toBe(true);
  });

  test('one campaign that both earned and spent credit shows both entries', async () => {
    await camps().insertOne({ advertiserRef: REF, name: 'both', creditHbd: 10, creditAppliedHbd: 4, updatedAt: ago(3), createdAt: ago(9) });
    const ledger = await ledgerOf(db(), REF);
    expect(ledger.entries.map((e) => [e.kind, e.at])).toEqual([['spent', ago(9)], ['earned', ago(3)]]);
    expect(ledger.balanceHbd).toBe(6);
  });

  test.each([[2.0005, 2.001], [1.0004, 1], [0.1 + 0.2, 0.3]])('round3(%p) is %p', (n, want) => {
    expect(round3(n)).toBe(want);
  });
});

describe('credit held by a booking nobody paid', () => {
  const booking = (over = {}) => camps().insertOne({
    advertiserRef: REF, hiveAccount: 'adv', status: STATES.AWAITING_PAYMENT,
    priceHbd: 20, paidHbd: 20, creditAppliedHbd: 20, amountDueHbd: 0, createdAt: ago(60), ...over,
  }).then((r) => r.insertedId);

  test('is released after the booking expiry, restoring both the balance and the full amount due', async () => {
    await camps().insertOne({ advertiserRef: REF, creditHbd: 75 });
    const id = await booking();
    expect(await balanceOf(db(), REF)).toBe(55);

    expect(await releaseStaleCredit(db())).toBe(1);

    const doc = await camps().findOne({ _id: id });
    expect(doc).toMatchObject({ paidHbd: 0, amountDueHbd: 20, creditReleasedHbd: 20, creditReleasedAt: F.NOW });
    expect(doc.creditAppliedHbd).toBeUndefined();
    expect(await balanceOf(db(), REF)).toBe(75);
    expect(await releaseStaleCredit(db())).toBe(0);
  });

  test.each([
    ['a part-paid booking (real money on top of the credit)', { paidHbd: 30, priceHbd: 100 }],
    ['a booking younger than the expiry', { createdAt: ago(29) }],
    ['a booking that has since been paid and scheduled', { status: STATES.SCHEDULED }],
  ])('is kept by %s', async (_label, over) => {
    const id = await booking(over);
    expect(await releaseStaleCredit(db())).toBe(0);
    expect((await camps().findOne({ _id: id })).creditAppliedHbd).toBe(20);
  });

  test('half a milli-HBD of real money on top is rounding, not a part-payment', async () => {
    await booking({ paidHbd: 20.0004 });
    expect(await releaseStaleCredit(db())).toBe(1);
  });
});
