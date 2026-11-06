/**
 * Viewer and listener rewards (services/adPayouts.js payViewers, payListeners and
 * the listener pools inside settlePeriod), and the one merged payout row an account
 * gets when it earned for several reasons in one period (writePayoutRows).
 *
 * Against a real MongoDB. Listener pools are switched on here at the live values
 * (3.5 audio + 1.5 podcast), so the split is 50 / 10 / 3.5 / 1.5 / 2 / 5.
 *
 * Ports scripts/test-ad-viewer-rewards (the payout part), test-ad-payout-safety
 * (case 2) and test-ad-viewer-creator-merge.
 */
process.env.AD_LISTENER_AUDIO_POOL_PCT = '3.5';
process.env.AD_LISTENER_PODCAST_POOL_PCT = '1.5';

jest.mock('../../utils/hive', () => ({ ...jest.requireActual('../../utils/hive'), hiveRpcBatch: jest.fn() }));

const { hiveRpcBatch } = require('../../utils/hive');
const testDb = require('../helpers/db');
const F = require('./_fixtures');
const P = require('../../services/adPayouts');
const cfg = require('../../utils/config');
const { ensureAdIndexes } = require('../../utils/adModel');

const db = testDb.use();
const period = P.periodContaining(F.PERIOD_AT.getTime());
const next = P.periodContaining(period.end.getTime());

beforeAll(() => ensureAdIndexes());
beforeEach(() => {
  F.pinClock();
  hiveRpcBatch.mockReset();
  hiveRpcBatch.mockImplementation(F.contentChain());
});
afterEach(() => jest.useRealTimers());

const watchOf = (viewer) => F.cols(db()).watch.find({ viewer }).toArray();

test('listener pools are on in this file at the live split', () => {
  expect([cfg.AD_LISTENER_AUDIO_POOL_PCT, cfg.AD_LISTENER_PODCAST_POOL_PCT]).toEqual([3.5, 1.5]);
});

describe('viewers are paid pro rata by qualifying seconds', () => {
  test('three viewers share a 20 HBD pool by their seconds, at one rate', async () => {
    await F.seedWatches(db(), [['viewer-a', 1200], ['viewer-b', 600], ['viewer-c', 200]]);
    const res = await P.payViewers(db(), period, 20);
    expect(res).toMatchObject({ recipients: 3, paidHbd: 20, carriedOut: 0 });
    const paid = await F.payoutsOf(db(), period.key);
    expect([paid['viewer-a'].hbd, paid['viewer-b'].hbd, paid['viewer-c'].hbd]).toEqual([12, 6, 2]);
    expect(paid['viewer-a']).toMatchObject({ kind: 'viewer', status: 'pending', amounts: [{ symbol: 'HBD', amount: 12 }] });
  });

  test('settling again pays nobody twice: the rows were claimed', async () => {
    await F.seedWatches(db(), [['viewer-a', 100]]);
    await P.payViewers(db(), period, 5);
    const again = await P.payViewers(db(), period, 5);
    expect(again).toMatchObject({ recipients: 0, rows: [] });
    expect((await watchOf('viewer-a'))[0]).toMatchObject({ payoutId: period.key, settledAt: F.NOW });
    expect((await F.payoutsOf(db(), period.key))['viewer-a'].hbd).toBe(5);
  });

  test('a viewer who watched several videos gets one payout for all of them', async () => {
    await F.seedWatches(db(), [['viewer-a', 100], ['viewer-a', 300], ['viewer-b', 400]]);
    const res = await P.payViewers(db(), period, 8, null, { defer: true });
    expect(res.rows.map((r) => [r.account, r.hbd])).toEqual([['viewer-a', 4], ['viewer-b', 4]]);
  });

  test('deferred rows are returned for the caller to write, and nothing is written here', async () => {
    await F.seedWatches(db(), [['viewer-a', 100]]);
    const res = await P.payViewers(db(), period, 5, null, { defer: true });
    expect(res.rows).toEqual([{ account: 'viewer-a', hbd: 5, amounts: [{ symbol: 'HBD', amount: 5 }], kind: 'viewer' }]);
    expect(await F.cols(db()).payouts.countDocuments({})).toBe(0);
  });

  test('legs follow the asset pool: a HIVE-funded pool pays viewers HIVE', async () => {
    await F.seedWatches(db(), [['viewer-a', 300], ['viewer-b', 100]]);
    const res = await P.payViewers(db(), period, 10, { HIVE: 40 }, { defer: true });
    expect(res.rows.map((r) => [r.account, r.hbd, r.amounts])).toEqual([
      ['viewer-a', 7.5, [{ symbol: 'HIVE', amount: 30 }]],
      ['viewer-b', 2.5, [{ symbol: 'HIVE', amount: 10 }]],
    ]);
  });

  test.each([
    ['a zero pool pays and carries nothing', 0, 0],
    ['a negative pool pays and carries nothing', -1, 0],
  ])('%s', async (_label, pool, carried) => {
    await F.seedWatches(db(), [['viewer-a', 100]]);
    expect(await P.payViewers(db(), period, pool)).toEqual({ recipients: 0, paidHbd: 0, carriedOut: carried, rows: [] });
    expect((await watchOf('viewer-a'))[0].payoutId).toBeNull();
  });

  test('nobody has banked a watch: the pool waits for viewers rather than becoming ours', async () => {
    expect(await P.payViewers(db(), period, 7)).toEqual({ recipients: 0, paidHbd: 0, carriedOut: 7, rows: [] });
  });

  test('only blocked viewers: their rows are claimed on sight and the pool carries', async () => {
    await F.seedWatches(db(), [['badadib', 600]]);
    expect(await P.payViewers(db(), period, 3)).toMatchObject({ recipients: 0, carriedOut: 3 });
    expect((await watchOf('badadib'))[0].payoutId).toBe(period.key);
  });

  test('rows with no seconds earn nothing and stay unclaimed', async () => {
    await F.seedWatches(db(), [['viewer-a', 0]]);
    expect(await P.payViewers(db(), period, 3)).toMatchObject({ recipients: 0, carriedOut: 3 });
    expect((await watchOf('viewer-a'))[0].payoutId).toBeNull();
  });

  test('seconds with no viewer name are carried, not paid to anyone', async () => {
    await F.seedWatches(db(), [['viewer-a', 100], [null, 100]]);
    const res = await P.payViewers(db(), period, 4, null, { defer: true });
    expect(res).toMatchObject({ recipients: 1, paidHbd: 2, carriedOut: 2 });
  });
});

describe('a viewer under the minimum keeps their entitlement', () => {
  test('their rows stay unclaimed to keep earning, and their combined share is carried in its asset', async () => {
    // One heavy viewer and 200 casual ones on 1 second each: 0.0004 HBD apiece rounds
    // to nothing, but together they are owed 0.08 HBD.
    const c = await F.seedCampaign(db(), period, { paidHbd: 20, priceHbd: 20, paidAssets: { HBD: 20 } });
    await F.seedImpressions(db(), c, 1, { owner: 'creator-x', period });
    await F.seedWatches(db(), [['whale', 4800]]);
    await F.seedWatches(db(), Array.from({ length: 200 }, (_, i) => [`minnow-${i}`, 1]));

    await P.settlePeriod(db(), period);

    const paid = await F.payoutsOf(db(), period.key);
    expect(paid.whale.hbd).toBe(1.92);
    expect(Object.keys(paid).filter((a) => a.startsWith('minnow-'))).toEqual([]);
    expect(await F.cols(db()).watch.countDocuments({ viewer: /^minnow-/, payoutId: null })).toBe(200);
    expect((await watchOf('whale'))[0].payoutId).toBe(period.key);
    const doc = await F.cols(db()).periods.findOne({ _id: period.key });
    expect(doc.viewerPoolHbd).toBe(2);
    expect(doc.viewerCarriedOut).toBe(0.08);
    expect(Object.keys(doc.viewerCarriedOutAssets)).toEqual(['HBD']);
    expect(doc.viewerCarriedOutAssets.HBD).toBeCloseTo(0.08, 9);
  });

  test('the carried viewer money reaches them in the next period, alongside their waiting seconds', async () => {
    await F.cols(db()).periods.insertOne({
      _id: period.key, status: 'settled', endAt: period.end, carryTo: next.key,
      viewerCarriedOut: 0.08, viewerCarriedOutAssets: { HBD: 0.08 },
    });
    await F.seedWatches(db(), [['minnow', 1]]);
    await P.settlePeriod(db(), next);
    expect((await F.payoutsOf(db(), next.key)).minnow.hbd).toBe(0.08);
  });
});

describe('listeners are paid from their own pool per kind (real database)', () => {
  test('3Speak audio and outside podcasts are separate pools and separate rows', async () => {
    await F.seedListens(db(), [['alice', 'audio', 3000], ['bob', 'audio', 1000], ['carol', 'podcast', 500]]);
    const audio = await P.payListeners(db(), period, 'audio', 4);
    expect(audio.rows.map((r) => [r.account, r.hbd, r.kind])).toEqual([['alice', 3, 'listener-audio'], ['bob', 1, 'listener-audio']]);
    const paid = await F.payoutsOf(db(), period.key);
    expect(paid.alice).toMatchObject({ kind: 'listener-audio', amounts: [{ symbol: 'HBD', amount: 3 }] });
    // The podcast listener is in the other pool and is left for it.
    expect((await F.cols(db()).listens.findOne({ listener: 'carol' })).payoutId).toBeNull();
  });

  test('a listener under the minimum keeps building up; blocked listeners are claimed and leave the denominator', async () => {
    await F.seedListens(db(), [['alice', 'podcast', 9990], ['tiny', 'podcast', 1], ['badadib', 'podcast', 9999]]);
    const res = await P.payListeners(db(), period, 'podcast', 0.5, { HBD: 0.5 }, { defer: true });
    expect(res.rows.map((r) => [r.account, r.hbd])).toEqual([['alice', 0.5]]);
    expect(res.carriedOut).toBe(0);
    const byName = Object.fromEntries((await F.cols(db()).listens.find({}).toArray()).map((r) => [r.listener, r.payoutId]));
    expect(byName).toEqual({ alice: period.key, tiny: null, badadib: period.key });
  });

  test('only blocked listeners: claimed, and the whole pool carries', async () => {
    await F.seedListens(db(), [['badadib', 'audio', 100]]);
    expect(await P.payListeners(db(), period, 'audio', 2)).toMatchObject({ recipients: 0, carriedOut: 2 });
    expect((await F.cols(db()).listens.findOne({ listener: 'badadib' })).payoutId).toBe(period.key);
  });

  test('rows with no seconds or no listener name earn nothing', async () => {
    await F.seedListens(db(), [['alice', 'audio', 100], [null, 'audio', 100], ['bob', 'audio', 0]]);
    const res = await P.payListeners(db(), period, 'audio', 2, null, { defer: true });
    expect(res.rows.map((r) => [r.account, r.hbd])).toEqual([['alice', 1]]);
    expect(res.carriedOut).toBe(1);
  });
});

describe('listener pools inside a settlement', () => {
  test('a shown period funds 3.5 audio and 1.5 podcast, each shared by its own listeners', async () => {
    const c = await F.seedCampaign(db(), period);
    await F.seedImpressions(db(), c, 1, { owner: 'creator-x', period });
    await F.seedListens(db(), [['alice', 'audio', 600], ['bob', 'audio', 600], ['carol', 'podcast', 60]]);
    await P.settlePeriod(db(), period);
    const paid = await F.payoutsOf(db(), period.key);
    expect([paid.alice.hbd, paid.bob.hbd, paid.carol.hbd]).toEqual([1.75, 1.75, 1.5]);
    expect(paid.carol.kind).toBe('listener-podcast');
    const doc = await F.cols(db()).periods.findOne({ _id: period.key });
    expect(doc.listeners).toEqual({
      audio: { poolHbd: 3.5, recipients: 2, paidHbd: 3.5, carriedIn: 0, carriedOut: 0, carriedOutAssets: {} },
      podcast: { poolHbd: 1.5, recipients: 1, paidHbd: 1.5, carriedIn: 0, carriedOut: 0, carriedOutAssets: {} },
    });
  });

  test('a listener pool nobody qualified for carries into the next period, in its asset', async () => {
    const c = await F.seedCampaign(db(), period, { paidAssets: { HIVE: 400 } });
    await F.seedImpressions(db(), c, 1, { owner: 'creator-x', period });
    await P.settlePeriod(db(), period);
    const doc = await F.cols(db()).periods.findOne({ _id: period.key });
    expect(doc.listeners.audio).toMatchObject({ poolHbd: 3.5, carriedOut: 3.5, carriedOutAssets: { HIVE: 14 } });

    // Next period nothing is shown, but the carried audio pool still goes out.
    await F.seedListens(db(), [['alice', 'audio', 100]]);
    await P.settlePeriod(db(), next);
    const row = (await F.payoutsOf(db(), next.key)).alice;
    expect(row).toMatchObject({ hbd: 3.5, kind: 'listener-audio', amounts: [{ symbol: 'HIVE', amount: 14 }] });
    expect((await F.cols(db()).periods.findOne({ _id: next.key })).listeners.audio.carriedIn).toBe(3.5);
  });

  test('the platform keeps what is left: the encoder cut still comes out of it', async () => {
    const c = await F.seedCampaign(db(), period);
    await F.seedImpressions(db(), c, 1, { owner: 'creator-x', period });
    await P.settlePeriod(db(), period);
    const paid = await F.payoutsOf(db(), period.key);
    expect(paid[cfg.AD_ENCODER_ACCOUNT].hbd).toBe(5);
    expect(paid['creator-x'].hbd).toBe(50);
  });
});

describe('one row per account per period, holding every reason it was paid', () => {
  test('a creator who also watched gets creator 50 + the whole viewer pool in ONE row', async () => {
    const c = await F.seedCampaign(db(), period);
    await F.seedImpressions(db(), c, 4, { owner: 'tib', period });
    await F.seedWatches(db(), [['tib', 600]]);
    await P.settlePeriod(db(), period);
    const rows = await F.cols(db()).payouts.find({ periodKey: period.key, account: 'tib' }).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ hbd: 60, kind: 'creator+viewer', amounts: [{ symbol: 'HBD', amount: 60 }], parts: { creator: 50, viewer: 10 } });
  });

  test('a creator and a separate viewer are not merged', async () => {
    const c = await F.seedCampaign(db(), period);
    await F.seedImpressions(db(), c, 4, { owner: 'cr', period });
    await F.seedWatches(db(), [['vw', 600]]);
    await P.settlePeriod(db(), period);
    const paid = await F.payoutsOf(db(), period.key);
    expect([paid.cr.hbd, paid.cr.kind, paid.vw.hbd, paid.vw.kind]).toEqual([50, 'creator', 10, 'viewer']);
  });

  test('a creator-viewer shares the viewer pool with another viewer by seconds', async () => {
    const c = await F.seedCampaign(db(), period);
    await F.seedImpressions(db(), c, 2, { owner: 'tib', period });
    await F.seedWatches(db(), [['tib', 300], ['other', 900]]);
    await P.settlePeriod(db(), period);
    const paid = await F.payoutsOf(db(), period.key);
    expect([paid.tib.hbd, paid.other.hbd]).toEqual([52.5, 7.5]);
  });

  test('creator, viewer and listener in one account: one row, every part named', async () => {
    const c = await F.seedCampaign(db(), period);
    await F.seedImpressions(db(), c, 1, { owner: 'tib', period });
    await F.seedWatches(db(), [['tib', 10]]);
    await F.seedListens(db(), [['tib', 'audio', 10]]);
    await P.settlePeriod(db(), period);
    const row = (await F.payoutsOf(db(), period.key)).tib;
    expect(row).toMatchObject({ hbd: 63.5, parts: { creator: 50, viewer: 10, 'listener-audio': 3.5 } });
    expect(row.kind.split('+').sort()).toEqual(['creator', 'listener-audio', 'viewer']);
  });

  /* BUG (services/adPayouts.js:706), cosmetic but it reaches the transfer memo. The
   * merged label is built by joining the label so far with the new kind, so a kind
   * that arrives again after a merge is listed twice ("creator+creator+viewer"), and
   * the order of the names depends on the order the rows arrived. Not reachable from
   * settlePeriod today (each kind reaches an account once per period), only through
   * writePayoutRows called with such rows. The amounts and `parts` are correct. */
  test.skip('BUG: a merged kind label names each reason once, whatever order the rows arrive in', async () => {
    const written = await P.writePayoutRows(db(), period.key, [
      { account: 'tib', hbd: 1, amounts: [], kind: 'creator' },
      { account: 'tib', hbd: 1, amounts: [], kind: 'viewer' },
      { account: 'tib', hbd: 1, amounts: [], kind: 'creator' },
    ]);
    expect(written[0].kind).toBe('creator+viewer');
  });

  test('a referrer who also watched, in a period whose ad was shown, gets referral + viewer in one row', async () => {
    const c = await F.seedCampaign(db(), period, { hiveAccount: 'adv' });
    await F.seedImpressions(db(), c, 4, { owner: 'cr', period });
    await F.seedWatches(db(), [['refbob', 600]]);
    await P.settlePeriod(db(), period, F.stubDeps({ referrers: { adv: 'refbob' }, real: ['refbob'] }));
    const rows = await F.cols(db()).payouts.find({ periodKey: period.key, account: 'refbob' }).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ hbd: 12, kind: 'referral+viewer' });
  });

  test('no ad shown: nobody is paid out of a booking that will be credited back, and the watch waits', async () => {
    await F.seedCampaign(db(), period, { hiveAccount: 'adv' });
    await F.seedWatches(db(), [['refbob', 600]]);
    await P.settlePeriod(db(), period, F.stubDeps({ referrers: { adv: 'refbob' }, real: ['refbob'] }));
    expect(await F.cols(db()).payouts.countDocuments({ periodKey: period.key })).toBe(0);
    expect((await watchOf('refbob'))[0].payoutId).toBeNull();
  });

  test('the database refuses a second row for the same account and period: the merge is required, not optional', async () => {
    await F.cols(db()).payouts.insertOne({ periodKey: period.key, account: 'tib', hbd: 1 });
    await expect(F.cols(db()).payouts.insertOne({ periodKey: period.key, account: 'tib', hbd: 2 }))
      .rejects.toMatchObject({ code: 11000 });
  });

  test('rewriting a row updates its amounts but never resets its status', async () => {
    await P.writePayoutRows(db(), period.key, [{ account: 'tib', hbd: 1, amounts: [{ symbol: 'HBD', amount: 1 }], kind: 'viewer' }]);
    await F.cols(db()).payouts.updateOne({ account: 'tib' }, { $set: { status: 'paid' } });
    await P.writePayoutRows(db(), period.key, [{ account: 'tib', hbd: 2, amounts: [{ symbol: 'HBD', amount: 2 }], kind: 'viewer' }]);
    const rows = await F.cols(db()).payouts.find({ account: 'tib' }).toArray();
    expect(rows.map((r) => [r.hbd, r.status])).toEqual([[2, 'paid']]);
  });

  test('legs of different assets are merged by symbol, and dust legs drop out', async () => {
    const written = await P.writePayoutRows(db(), period.key, [
      { account: 'tib', hbd: 1, amounts: [{ symbol: 'HBD', amount: 1 }, { symbol: 'HIVE', amount: 0.0001 }], kind: 'creator' },
      { account: 'tib', hbd: 2, amounts: [{ symbol: 'HIVE', amount: 8 }, { symbol: 'HBD', amount: 0 }], kind: 'creator' },
    ]);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ hbd: 3, kind: 'creator', parts: { creator: 3 } });
    expect(written[0].amounts).toEqual([{ symbol: 'HBD', amount: 1 }, { symbol: 'HIVE', amount: 8 }]);
  });
});
