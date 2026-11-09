/**
 * Period settlement (services/adPayouts.js settlePeriod) against a real MongoDB.
 *
 * Covers: one rate per period whatever flight an impression came from, accrual by
 * time, idempotent re-settlement, carries (creator and viewer, in their own assets),
 * dust, blocked accounts, the community split resolved from the chain (and what
 * happens when the chain is down), and the cuts that only SHOWN ads may fund.
 *
 * Ports scripts/test-ad-payout, test-ad-payout-safety (cases 3 and 4),
 * test-ad-community-split, test-ad-community-rpc-down and test-ad-excluded-accounts.
 * Config is the default split: creator 50, viewer 10, referrer 2, encoder 5.
 */
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
const ENCODER = cfg.AD_ENCODER_ACCOUNT;

beforeAll(() => ensureAdIndexes());
beforeEach(() => {
  F.pinClock();
  hiveRpcBatch.mockReset();
  hiveRpcBatch.mockImplementation(F.contentChain());
});
afterEach(() => jest.useRealTimers());

const periodDoc = (key = period.key) => F.cols(db()).periods.findOne({ _id: key });

describe('the defaults this file is written against', () => {
  test('creator 50, viewer 10 (listeners share it), referrer 2, encoder 5, nobody shares with a community', () => {
    expect([cfg.AD_CREATOR_POOL_PCT, cfg.AD_VIEWER_POOL_PCT, cfg.AD_REFERRAL_POOL_PCT, cfg.AD_ENCODER_POOL_PCT])
      .toEqual([50, 10, 2, 5]);
    expect(cfg.AD_DEFAULT_COMMUNITY_PCT).toBe(0);
    expect(cfg.AD_EXCLUDED_ACCOUNTS).toEqual(['badadib']);
    expect(period).toEqual({
      key: '2026-10-01', start: new Date('2026-10-01T07:00:00Z'), end: new Date('2026-10-04T07:00:00Z'),
    });
  });
});

describe('period boundaries', () => {
  test.each([
    ['2026-10-01T12:00:00Z', '2026-10-01', '2026-10-01T07:00:00.000Z', '2026-10-04T07:00:00.000Z'],
    ['2026-10-01T07:00:00Z', '2026-10-01', '2026-10-01T07:00:00.000Z', '2026-10-04T07:00:00.000Z'],
    ['2026-10-01T06:59:59Z', '2026-09-28', '2026-09-28T07:00:00.000Z', '2026-10-01T07:00:00.000Z'],
    ['2026-11-01T12:00:00Z', '2026-10-31', '2026-10-31T07:00:00.000Z', '2026-11-03T07:00:00.000Z'],
  ])('%s falls in period %s', (at, key, start, end) => {
    const p = P.periodContaining(Date.parse(at));
    expect([p.key, p.start.toISOString(), p.end.toISOString()]).toEqual([key, start, end]);
  });

  test('periods tile time: each one starts where the previous ended', () => {
    expect(next.start).toEqual(period.end);
    expect(next.key).toBe('2026-10-04');
  });
});

describe('accrual is pro rata by time, never by delivery', () => {
  const start = new Date('2026-10-01T00:00:00Z');
  const end = new Date('2026-10-11T00:00:00Z'); // a 10-day window
  const c = (over) => ({ startAt: start, endAt: end, paidHbd: 100, priceHbd: 100, ...over });

  test.each([
    ['a flight entirely inside the window earns its whole fee', c(), start, end, 100],
    ['half of the flight inside the window earns half', c(), start, new Date('2026-10-06T00:00:00Z'), 50],
    ['a flight outside the window earns nothing', c(), new Date('2026-10-20T00:00:00Z'), new Date('2026-10-21T00:00:00Z'), 0],
    ['a flight with no dates earns nothing', c({ startAt: null }), start, end, 0],
    ['a flight that ends before it starts earns nothing', c({ endAt: start }), start, end, 0],
    ['never more than the price, however much was paid', c({ paidHbd: 150 }), start, end, 100],
    ['never more than was paid, whatever the price', c({ paidHbd: 40 }), start, end, 40],
    ['no price on record falls back to what was paid', c({ priceHbd: undefined, paidHbd: 30 }), start, end, 30],
    ['an unpaid flight earns nothing', c({ paidHbd: 0 }), start, end, 0],
  ])('%s', (_label, campaign, from, to, want) => {
    expect(P.accrualFor(campaign, from, to)).toBeCloseTo(want, 9);
  });
});

describe('one rate for everyone in a period', () => {
  test('two creators with identical delivery are paid identically, whatever flight they rode', async () => {
    // Both advertisers paid 50 HBD. A's flight is this period; B's runs 90 days, so
    // only 3/90 of it accrues here. Under the old per-campaign model X would have been
    // paid thirty times what Y was for the same ten plays.
    const a = await F.seedCampaign(db(), period, { paidHbd: 50, priceHbd: 50, paidAssets: { HBD: 50 } });
    const b = await F.seedCampaign(db(), period, {
      paidHbd: 50, priceHbd: 50, paidAssets: { HBD: 50 }, endAt: new Date(period.start.getTime() + 90 * F.DAY),
    });
    await F.seedImpressions(db(), a, 10, { owner: 'creator-x', period });
    await F.seedImpressions(db(), b, 10, { owner: 'creator-y', period });

    const result = await P.settlePeriod(db(), period);

    const revenue = 50 + 50 * (3 / 90);
    const pool = revenue / 2;
    const paid = await F.payoutsOf(db(), period.key);
    expect(paid['creator-x'].hbd).toBe(paid['creator-y'].hbd);
    expect(paid['creator-x'].hbd).toBe(F.r3(pool / 2));
    const doc = await periodDoc();
    expect(doc.poolHbd).toBeCloseTo(pool, 9);
    expect(doc.revenueHbd).toBeCloseTo(revenue, 9);
    expect(doc.ratePerImpression).toBeCloseTo(pool / 20, 9);
    expect(doc.impressions).toBe(20);
    expect(result).toMatchObject({ periodKey: period.key, recipients: 2 });
    expect(result.ratePerImpression).toBeCloseTo(pool / 20, 9);
  });

  test('a settled period is never settled twice, and its impressions are claimed', async () => {
    const c = await F.seedCampaign(db(), period);
    await F.seedImpressions(db(), c, 4, { owner: 'creator-x', period });
    await P.settlePeriod(db(), period);
    const first = await F.cols(db()).payouts.find({}).sort({ account: 1 }).toArray();

    // A late impression for the same period must not reopen it.
    await F.seedImpressions(db(), c, 4, { owner: 'creator-late', period });
    expect(await P.settlePeriod(db(), period)).toBeNull();

    const again = await F.cols(db()).payouts.find({}).sort({ account: 1 }).toArray();
    expect(again.map((r) => [r.account, r.hbd])).toEqual(first.map((r) => [r.account, r.hbd]));
    expect(await F.cols(db()).impressions.countDocuments({ owner: 'creator-x', payoutId: period.key })).toBe(4);
    expect(await F.cols(db()).payouts.countDocuments({ account: 'creator-late' })).toBe(0);
  });

  test('every payout row waits as pending: settling never sends anything', async () => {
    const c = await F.seedCampaign(db(), period);
    await F.seedImpressions(db(), c, 2, { owner: 'creator-x', period });
    await P.settlePeriod(db(), period);
    const rows = await F.cols(db()).payouts.find({ periodKey: period.key }).toArray();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.status === 'pending' && !r.sentLegs)).toBe(true);
  });

  test('only completed, unpaid impressions inside the period count', async () => {
    const c = await F.seedCampaign(db(), period);
    await F.seedImpressions(db(), c, 2, { owner: 'creator-x', period });
    await F.cols(db()).impressions.insertMany([
      { sid: 'incomplete', campaignId: c._id, owner: 'creator-x', permlink: 'video', completed: false, completedAt: F.midOf(period), payoutId: null },
      { sid: 'paid-before', campaignId: c._id, owner: 'creator-x', permlink: 'video', completed: true, completedAt: F.midOf(period), payoutId: 'older' },
      { sid: 'on-the-end', campaignId: c._id, owner: 'creator-x', permlink: 'video', completed: true, completedAt: period.end, payoutId: null },
    ]);
    await P.settlePeriod(db(), period);
    expect((await periodDoc()).impressions).toBe(2);
    expect((await F.payoutsOf(db(), period.key))['creator-x'].hbd).toBe(50);
  });

  test('when one creator carried every ad they get the whole creator pool, and the encoders their cut', async () => {
    const c = await F.seedCampaign(db(), period);
    await F.seedImpressions(db(), c, 4, { owner: 'creator-x', period });
    await P.settlePeriod(db(), period);
    const paid = await F.payoutsOf(db(), period.key);
    expect(Object.keys(paid).sort()).toEqual(['creator-x', ENCODER].sort());
    expect(paid['creator-x']).toMatchObject({ hbd: 50, kind: 'creator', amounts: [{ symbol: 'HBD', amount: 50 }], parts: { creator: 50 } });
    expect(paid[ENCODER]).toMatchObject({ hbd: 5, kind: 'encoder', amounts: [{ symbol: 'HBD', amount: 5 }] });
    const doc = await periodDoc();
    expect(doc).toMatchObject({ status: 'settled', recipients: 1, carriedOut: 0, encoderPoolHbd: 5, encoderAccount: ENCODER, carryTo: next.key });
    // Nobody had banked a watch, so the viewer pool waits for them.
    expect(doc).toMatchObject({ viewerPoolHbd: 10, viewerPoolStatus: 'earmarked', viewerCarriedOut: 10 });
    expect(doc.viewerCarriedOutAssets).toEqual({ HBD: 10 });
  });
});

describe('a period that took revenue but served nothing', () => {
  test('still settles, and carries the whole creator pool forward in the asset it arrived as', async () => {
    await F.seedCampaign(db(), period, { paidHbd: 40, priceHbd: 40, paidAssets: { HBD: 40 } });
    const result = await P.settlePeriod(db(), period);
    expect(result).toEqual({ periodKey: period.key, recipients: 0, totalHbd: 0, carriedOut: 20 });
    const doc = await periodDoc();
    expect(doc).toMatchObject({
      status: 'settled', impressions: 0, revenueHbd: 40, carriedOut: 20, carryTo: next.key,
      carriedOutAssets: { HBD: 20 }, shownRevenueHbd: 0, encoderPoolHbd: 0, encoderAccount: null, viewerPoolHbd: 0,
    });
    // Nothing was shown, so no viewer, referrer or encoder is paid out of it.
    expect(await F.cols(db()).payouts.countDocuments({})).toBe(0);
  });

  test('a HIVE carry is paid as HIVE next period, never turned into HBD nobody sent', async () => {
    await F.seedCampaign(db(), period, { paidAssets: { HIVE: 400 } });
    await P.settlePeriod(db(), period);
    expect((await periodDoc()).carriedOutAssets).toEqual({ HIVE: 200 });

    // The next period is funded in HBD and shows one ad.
    const b = await F.seedCampaign(db(), next, { paidAssets: { HBD: 100 } });
    await F.seedImpressions(db(), b, 1, { owner: 'creator-x', period: next });
    await P.settlePeriod(db(), next);

    const row = (await F.payoutsOf(db(), next.key))['creator-x'];
    expect(row.hbd).toBe(100); // 50 carried in + 50 of its own, as HBD-equivalent
    expect(row.amounts.sort((x, y) => x.symbol.localeCompare(y.symbol)))
      .toEqual([{ symbol: 'HBD', amount: 50 }, { symbol: 'HIVE', amount: 200 }]);
    expect((await periodDoc(next.key))).toMatchObject({ carriedIn: 50, poolHbd: 100 });
  });

  test('a viewer carry from an earlier period still goes out when nothing was shown', async () => {
    // The earlier period owed viewers 2 HBD it could not send.
    await F.cols(db()).periods.insertOne({
      _id: 'earlier', status: 'settled', carryTo: period.key,
      carriedOut: 0, viewerCarriedOut: 2, viewerCarriedOutAssets: { HBD: 2 },
    });
    await F.seedWatches(db(), [['viewer-a', 300], ['viewer-b', 100]]);
    await P.settlePeriod(db(), period);
    const paid = await F.payoutsOf(db(), period.key);
    expect([paid['viewer-a'].hbd, paid['viewer-b'].hbd]).toEqual([1.5, 0.5]);
    expect(await periodDoc()).toMatchObject({ viewerPoolHbd: 2, viewerCarriedIn: 2, viewerPoolStatus: 'paid', viewerRecipients: 2 });
  });

  test('a period with no revenue and no carry settles to zero and pays nobody', async () => {
    const result = await P.settlePeriod(db(), period);
    expect(result).toEqual({ periodKey: period.key, recipients: 0, totalHbd: 0, carriedOut: 0 });
    expect(await periodDoc()).toMatchObject({ status: 'settled', revenueHbd: 0, poolHbd: 0, assetSplit: { HBD: 1 } });
  });
});

describe('dust below the sendable minimum', () => {
  test('a creator share that rounds below 0.001 is not sent', async () => {
    // 0.002 HBD of revenue: a 0.001 pool across four creators, 0.00025 each.
    const c = await F.seedCampaign(db(), period, { paidHbd: 0.002, priceHbd: 0.002, paidAssets: { HBD: 0.002 } });
    for (const owner of ['a', 'b', 'c', 'd']) await F.seedImpressions(db(), c, 1, { owner: `creator-${owner}`, period });
    await P.settlePeriod(db(), period);
    expect(await F.cols(db()).payouts.countDocuments({ kind: 'creator' })).toBe(0);
    expect((await periodDoc()).recipients).toBe(0);
  });

  /* BUG (services/adPayouts.js:1016-1022). The dust that settlePeriod carries is the
   * sum of each row's ROUNDED share, so with AD_PAYOUT_MIN_HBD at Hive's own 0.001 a
   * share under 0.0005 rounds to 0 before it is summed and the carry is always zero.
   * The comment above it says this dust is carried "rather than dropping it", and
   * payViewers does carry it correctly (pool minus what was paid). Here the 0.001
   * pool goes to nobody and is recorded as carrying nothing. */
  test('BUG: creator shares that round to zero are dropped instead of carried', async () => {
    const c = await F.seedCampaign(db(), period, { paidHbd: 0.002, priceHbd: 0.002, paidAssets: { HBD: 0.002 } });
    for (const owner of ['a', 'b', 'c', 'd']) await F.seedImpressions(db(), c, 1, { owner: `creator-${owner}`, period });
    await P.settlePeriod(db(), period);
    expect((await periodDoc()).carriedOut).toBeCloseTo(0.001, 6);
  });
});

describe('accounts that must not be paid', () => {
  test('a platform account\'s impressions still set the rate; only its credit is withheld', async () => {
    const c = await F.seedCampaign(db(), period);
    await F.seedImpressions(db(), c, 2, { owner: 'badadib', period });
    await F.seedImpressions(db(), c, 2, { owner: 'creator-x', period });
    await P.settlePeriod(db(), period);
    const doc = await periodDoc();
    expect(doc.impressions).toBe(4);
    expect(doc.ratePerImpression).toBe(12.5); // pool / 4, not pool / 2
    const paid = await F.payoutsOf(db(), period.key);
    expect(paid['creator-x'].hbd).toBe(25);
    expect(paid.badadib).toBeUndefined();
    expect(doc).toMatchObject({ withheldHbd: 25, withheldFrom: ['badadib'] });
  });

  test('a blocked viewer leaves the viewer pool entirely, and their row is claimed so it is not re-read', async () => {
    const c = await F.seedCampaign(db(), period);
    await F.seedImpressions(db(), c, 1, { owner: 'creator-x', period });
    const [blockedRow] = await F.seedWatches(db(), [['badadib', 600]]);
    await F.seedWatches(db(), [['viewer-a', 600]]);
    await P.settlePeriod(db(), period);
    const paid = await F.payoutsOf(db(), period.key);
    expect(paid['viewer-a'].hbd).toBe(10); // the WHOLE viewer pool, not half
    expect(paid.badadib).toBeUndefined();
    expect((await F.cols(db()).watch.findOne({ _id: blockedRow._id })).payoutId).toBe(period.key);
  });

  // Read as `=== true`: a malformed value must never silently withhold somebody's money.
  test.each([
    ['true withholds the payout', true, false],
    ['the string "true" does not', 'true', true],
    ['1 does not', 1, true],
    ['false does not', false, true],
  ])('an adRewardDisabled flag of %s', async (_label, flag, isPaid) => {
    await F.cols(db()).creators.insertOne({ username: 'creator-flagged', adRewardDisabled: flag });
    const c = await F.seedCampaign(db(), period);
    await F.seedImpressions(db(), c, 1, { owner: 'creator-flagged', period });
    await P.settlePeriod(db(), period);
    expect(!!(await F.payoutsOf(db(), period.key))['creator-flagged']).toBe(isPaid);
  });

  test('reward flags that cannot be read stop the settlement before anything is written', async () => {
    const c = await F.seedCampaign(db(), period);
    await F.seedImpressions(db(), c, 2, { owner: 'creator-x', period });
    const broken = {
      collection: (name) => (name === cfg.AD_REWARD_FLAG_COLLECTION
        ? { find: () => ({ toArray: async () => { throw new Error('flags unreadable'); } }) }
        : db().collection(name)),
    };
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(P.settlePeriod(broken, period)).rejects.toThrow('flags unreadable');
    expect(await periodDoc()).toBeNull();
    expect(await F.cols(db()).payouts.countDocuments({})).toBe(0);
    expect(await F.cols(db()).impressions.countDocuments({ payoutId: null })).toBe(2);
  });

  test('an ad on an outside podcast episode (no owner) counts in the rate and credits nobody', async () => {
    const c = await F.seedCampaign(db(), period);
    await F.seedImpressions(db(), c, 1, { owner: 'creator-x', period });
    await F.seedImpressions(db(), c, 1, { owner: null, permlink: 'episode', period });
    await P.settlePeriod(db(), period);
    expect((await F.payoutsOf(db(), period.key))['creator-x'].hbd).toBe(25);
    expect(await F.cols(db()).payouts.countDocuments({ kind: 'creator' })).toBe(1);
    // Only the owned video was looked up on chain.
    expect(hiveRpcBatch.mock.calls.flatMap(([batch]) => batch.map((r) => r.params))).toEqual([['creator-x', 'video']]);
  });
});

describe('the community split', () => {
  const CREATOR = 'creator-x';
  const share = (pct) => F.cols(db()).prefs.updateOne({ _id: CREATOR }, { $set: { communitySharePct: pct } }, { upsert: true });

  test('the chain decides the community: a missing category, a stale one and a legacy video all pay the right community', async () => {
    await share(25);
    await F.cols(db()).prefs.updateOne({ _id: 'legacy-owner' }, { $set: { communitySharePct: 25 } }, { upsert: true });
    await F.cols(db()).embedVideo.insertMany([
      { owner: CREATOR, permlink: 'gap', hive_author: CREATOR, hive_permlink: 'gap-post' },
      { owner: CREATOR, permlink: 'stale', category: 'hive-999999', hive_author: CREATOR, hive_permlink: 'stale-post' },
    ]);
    hiveRpcBatch.mockImplementation(F.contentChain({
      [`${CREATOR}/gap-post`]: 'hive-178315',
      [`${CREATOR}/stale-post`]: 'hive-181335',
      'legacy-owner/old-video': 'hive-172958',
    }));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const c = await F.seedCampaign(db(), period, { paidHbd: 60, priceHbd: 60, paidAssets: { HBD: 60 } });
    await F.seedImpressions(db(), c, 1, { owner: CREATOR, permlink: 'gap', period });
    await F.seedImpressions(db(), c, 1, { owner: CREATOR, permlink: 'stale', period });
    // No embed-video row: a legacy video, whose owner/permlink ARE the Hive post.
    await F.seedImpressions(db(), c, 1, { owner: 'legacy-owner', permlink: 'old-video', period });

    await P.settlePeriod(db(), period);

    // Pool 30 over 3 impressions = 10 each; 25 of the creator side's 50 is half.
    const paid = await F.payoutsOf(db(), period.key);
    expect(paid['hive-178315']).toMatchObject({ hbd: 5, kind: 'community' });
    expect(paid['hive-181335']).toMatchObject({ hbd: 5, kind: 'community' });
    expect(paid['hive-172958']).toMatchObject({ hbd: 5, kind: 'community' });
    expect(paid['hive-999999']).toBeUndefined();
    expect(paid[CREATOR]).toMatchObject({ hbd: 10, kind: 'creator' });
    expect(paid['legacy-owner']).toMatchObject({ hbd: 5, kind: 'creator' });
    // The drift is reported, so somebody can fix whatever wrote the stale copy.
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('community mismatch'));
  });

  test('sharing is opt in: with no preference the creator keeps the whole share', async () => {
    hiveRpcBatch.mockImplementation(F.contentChain({ [`${CREATOR}/video`]: 'hive-178315' }));
    const c = await F.seedCampaign(db(), period);
    await F.seedImpressions(db(), c, 2, { owner: CREATOR, period });
    await P.settlePeriod(db(), period);
    const paid = await F.payoutsOf(db(), period.key);
    expect(paid[CREATOR].hbd).toBe(50);
    expect(paid['hive-178315']).toBeUndefined();
  });

  test.each([
    [25, 'splits the creator side in half', 25, 25],
    [0, 'is a deliberate keep-everything', 50, 0],
    [80, 'is clamped to the creator side, never paying more than the impression earned', 0, 50],
    [-5, 'shares nothing', 50, 0],
    ['abc', 'shares nothing', 50, 0],
  ])('a stored community share of %p %s', async (pct, _label, creatorHbd, communityHbd) => {
    await share(pct);
    hiveRpcBatch.mockImplementation(F.contentChain({ [`${CREATOR}/video`]: 'hive-178315' }));
    const c = await F.seedCampaign(db(), period);
    await F.seedImpressions(db(), c, 1, { owner: CREATOR, period });
    await P.settlePeriod(db(), period);
    const paid = await F.payoutsOf(db(), period.key);
    expect(paid[CREATOR]?.hbd ?? 0).toBe(creatorHbd);
    expect(paid['hive-178315']?.hbd ?? 0).toBe(communityHbd);
  });

  test('a video in no community pays the creator the whole share, whatever they set', async () => {
    await share(25);
    const c = await F.seedCampaign(db(), period);
    await F.seedImpressions(db(), c, 1, { owner: CREATOR, period });
    await P.settlePeriod(db(), period);
    expect((await F.payoutsOf(db(), period.key))[CREATOR].hbd).toBe(50);
  });

  test('an upload with no Hive post has no community, even with a stored category, and is not looked up', async () => {
    await share(25);
    await F.cols(db()).embedVideo.insertOne({ owner: CREATOR, permlink: 'video', category: 'hive-178315' });
    const c = await F.seedCampaign(db(), period);
    await F.seedImpressions(db(), c, 1, { owner: CREATOR, period });
    await P.settlePeriod(db(), period);
    expect((await F.payoutsOf(db(), period.key))[CREATOR].hbd).toBe(50);
    expect(hiveRpcBatch).not.toHaveBeenCalled();
  });

  test('a post the chain says does not exist has no community', async () => {
    await share(25);
    hiveRpcBatch.mockImplementation(F.contentChain({ [`${CREATOR}/video`]: null }));
    const c = await F.seedCampaign(db(), period);
    await F.seedImpressions(db(), c, 1, { owner: CREATOR, period });
    await P.settlePeriod(db(), period);
    expect((await F.payoutsOf(db(), period.key))[CREATOR].hbd).toBe(50);
  });

  test('a blocked community does not cost the creator their own share', async () => {
    await share(25);
    await F.cols(db()).creators.insertOne({ username: 'hive-178315', adRewardDisabled: true });
    hiveRpcBatch.mockImplementation(F.contentChain({ [`${CREATOR}/video`]: 'hive-178315' }));
    const c = await F.seedCampaign(db(), period);
    await F.seedImpressions(db(), c, 1, { owner: CREATOR, period });
    await P.settlePeriod(db(), period);
    const paid = await F.payoutsOf(db(), period.key);
    expect(paid[CREATOR].hbd).toBe(25);
    expect(paid['hive-178315']).toBeUndefined();
    expect(await periodDoc()).toMatchObject({ withheldHbd: 25, withheldFrom: ['hive-178315'] });
  });

  test('chain lookups are batched 25 posts at a time', async () => {
    const c = await F.seedCampaign(db(), period);
    for (let i = 0; i < 30; i += 1) await F.seedImpressions(db(), c, 1, { owner: CREATOR, permlink: `v${i}`, period });
    await P.settlePeriod(db(), period);
    expect(hiveRpcBatch.mock.calls.map(([batch]) => batch.length)).toEqual([25, 5]);
    expect(hiveRpcBatch.mock.calls[0][0][0]).toMatchObject({ method: 'condenser_api.get_content', params: [CREATOR, 'v0'] });
  });
});

describe('when Hive is unreachable', () => {
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));

  test.each([
    ['every endpoint failed (an empty answer)', () => hiveRpcBatch.mockResolvedValue([])],
    ['the RPC threw', () => hiveRpcBatch.mockRejectedValue(new Error('ECONNREFUSED'))],
    ['a short answer', () => hiveRpcBatch.mockResolvedValue([{ id: 1, result: {} }])],
  ])('a video with no stored community is not settled at a guess: %s', async (_label, arrange) => {
    arrange();
    await F.cols(db()).embedVideo.insertOne({ owner: 'creator-x', permlink: 'video', hive_author: 'creator-x', hive_permlink: 'post' });
    await F.cols(db()).embedVideo.insertOne({ owner: 'creator-x', permlink: 'video2', hive_author: 'creator-x', hive_permlink: 'post2' });
    const c = await F.seedCampaign(db(), period);
    await F.seedImpressions(db(), c, 5, { owner: 'creator-x', permlink: 'video', period });
    await F.seedImpressions(db(), c, 5, { owner: 'creator-x', permlink: 'video2', period });

    expect(await P.settlePeriod(db(), period)).toBeNull();

    expect(await F.cols(db()).payouts.countDocuments({})).toBe(0);
    expect(await periodDoc()).toBeNull();
    expect(await F.cols(db()).impressions.countDocuments({ payoutId: null })).toBe(10);
  });

  test('a video with a stored community falls back to it rather than halting everyone', async () => {
    hiveRpcBatch.mockResolvedValue([]);
    await F.cols(db()).prefs.insertOne({ _id: 'creator-x', communitySharePct: 25 });
    await F.cols(db()).embedVideo.insertOne({
      owner: 'creator-x', permlink: 'video', category: 'hive-111111', hive_author: 'creator-x', hive_permlink: 'post',
    });
    const c = await F.seedCampaign(db(), period);
    await F.seedImpressions(db(), c, 1, { owner: 'creator-x', permlink: 'video', period });
    await P.settlePeriod(db(), period);
    const paid = await F.payoutsOf(db(), period.key);
    expect([paid['creator-x'].hbd, paid['hive-111111'].hbd]).toEqual([25, 25]);
  });
});

describe('cuts that only shown ads may fund', () => {
  test('viewer and encoder shares come from the campaign that was shown, never one that was not', async () => {
    const shown = await F.seedCampaign(db(), period);
    await F.seedCampaign(db(), period, { hiveAccount: 'adv2', paidHbd: 60, priceHbd: 60, paidAssets: { HBD: 60 } });
    await F.seedImpressions(db(), shown, 2, { owner: 'creator-x', period });
    await F.seedWatches(db(), [['viewer-a', 100]]);
    await P.settlePeriod(db(), period);
    const doc = await periodDoc();
    // The creator pool is still half of everything that accrued.
    expect(doc).toMatchObject({ revenueHbd: 160, poolHbd: 80, shownRevenueHbd: 100, viewerPoolHbd: 10, encoderPoolHbd: 5 });
    const paid = await F.payoutsOf(db(), period.key);
    expect([paid['creator-x'].hbd, paid['viewer-a'].hbd, paid[ENCODER].hbd]).toEqual([80, 10, 5]);
  });

  test('the encoders are paid in the assets the advertisers sent', async () => {
    const c = await F.seedCampaign(db(), period, { paidAssets: { HIVE: 400 } });
    await F.seedImpressions(db(), c, 1, { owner: 'creator-x', period });
    await P.settlePeriod(db(), period);
    const paid = await F.payoutsOf(db(), period.key);
    expect(paid[ENCODER]).toMatchObject({ hbd: 5, amounts: [{ symbol: 'HIVE', amount: 20 }] });
    expect(paid['creator-x'].amounts).toEqual([{ symbol: 'HIVE', amount: 200 }]);
  });
});
