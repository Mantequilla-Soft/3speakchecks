/**
 * Payouts are made in the assets advertisers actually sent (services/adPayouts.js).
 *
 * `paidHbd` is a valuation, not a balance: a campaign paid in HIVE must pay its
 * creators in HIVE, because the HBD to pay them was never received. The trap this
 * guards is "7 HBD worth of HIVE is 7 HIVE": native pools are scaled by each
 * recipient's share, so no exchange rate is consulted anywhere.
 *
 * Ports scripts/test-ad-payout-in-kind, against a real MongoDB.
 */
jest.mock('../../utils/hive', () => ({ ...jest.requireActual('../../utils/hive'), hiveRpcBatch: jest.fn() }));

const { hiveRpcBatch } = require('../../utils/hive');
const testDb = require('../helpers/db');
const F = require('./_fixtures');
const P = require('../../services/adPayouts');
const { ensureAdIndexes } = require('../../utils/adModel');

const db = testDb.use();
const period = P.periodContaining(F.PERIOD_AT.getTime());

beforeAll(() => ensureAdIndexes());
beforeEach(() => {
  hiveRpcBatch.mockReset();
  hiveRpcBatch.mockImplementation(F.contentChain());
});

const legs = (row) => Object.fromEntries(row.amounts.map((l) => [l.symbol, l.amount]));

describe('a 100 HBD-equivalent campaign, four impressions on one creator', () => {
  test.each([
    ['funded entirely in HIVE pays HIVE (400 in, 200 out), never "50 HBD"', { HIVE: 400 }, { HIVE: 200 }],
    ['funded entirely in HBD pays HBD', { HBD: 100 }, { HBD: 50 }],
    ['funded in both halves each asset on its own', { HBD: 40, HIVE: 240 }, { HBD: 20, HIVE: 120 }],
    ['booked before paidAssets existed settles in HBD as it always did', undefined, { HBD: 50 }],
    ['with unusable asset amounts falls back to HBD', { HIVE: -5, HBD: 'lots' }, { HBD: 50 }],
  ])('%s', async (_label, paidAssets, want) => {
    const c = await F.seedCampaign(db(), period, { paidAssets });
    await F.seedImpressions(db(), c, 4, { owner: 'creatorx', period });
    await P.settlePeriod(db(), period);
    const row = (await F.payoutsOf(db(), period.key)).creatorx;
    expect(row.hbd).toBe(50); // the HBD-equivalent is still what reports and thresholds use
    expect(legs(row)).toEqual(want);
  });
});

test('a flight straddling the period accrues its assets by the same time fraction as its HBD value', async () => {
  // Six days of flight, three of them in this period: half of the 400 HIVE.
  const c = await F.seedCampaign(db(), period, { paidAssets: { HIVE: 400 }, endAt: new Date(period.start.getTime() + 6 * F.DAY) });
  await F.seedImpressions(db(), c, 1, { owner: 'creatorx', period });
  await P.settlePeriod(db(), period);
  const doc = await F.cols(db()).periods.findOne({ _id: period.key });
  expect(doc.revenueHbd).toBeCloseTo(50, 9);
  expect(doc.assetTotals.HIVE).toBeCloseTo(200, 9);
  expect(doc.assetSplit).toEqual({ HIVE: 1 });
  expect(legs((await F.payoutsOf(db(), period.key)).creatorx)).toEqual({ HIVE: 100 });
});

test('two campaigns in different assets: every creator is paid their share of each native pool', async () => {
  const a = await F.seedCampaign(db(), period, { paidAssets: { HIVE: 400 } });
  const b = await F.seedCampaign(db(), period, { hiveAccount: 'adv2', paidAssets: { HBD: 100 } });
  // Three impressions for x and one for y, spread over both campaigns.
  await F.seedImpressions(db(), a, 3, { owner: 'creatorx', period });
  await F.seedImpressions(db(), b, 1, { owner: 'creatory', period });
  await P.settlePeriod(db(), period);
  const paid = await F.payoutsOf(db(), period.key);
  // Pool 100 HBD-equivalent = 200 HIVE + 50 HBD. x earned 3/4 of it, y 1/4,
  // whichever campaign their own impressions happened to come from.
  expect([paid.creatorx.hbd, legs(paid.creatorx)]).toEqual([75, { HIVE: 150, HBD: 37.5 }]);
  expect([paid.creatory.hbd, legs(paid.creatory)]).toEqual([25, { HIVE: 50, HBD: 12.5 }]);
});
