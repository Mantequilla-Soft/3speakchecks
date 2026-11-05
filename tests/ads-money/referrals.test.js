/**
 * Referral money in the ad payout (services/adPayouts.js):
 *   - the advertiser referral: 2% of a referred advertiser's shown campaign, out of
 *     the platform's share, paid in kind, only to a real and unblocked Hive account;
 *   - the earner referral bonus: 10% of a referred user's own creator, viewer and
 *     listener money for 90 days, paid ON TOP by the platform and never more than
 *     the platform has left;
 *   - the transfer memo that tells the two apart.
 *
 * Butter Auth and the chain are stubbed through settlePeriod's `deps`, the database
 * is real. Ports scripts/test-ad-referral-share and scripts/test-ad-earner-referral.
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
const ENCODER = cfg.AD_ENCODER_ACCOUNT;
const daysBefore = (n) => new Date(period.start.getTime() - n * F.DAY);

beforeAll(() => ensureAdIndexes());
beforeEach(() => {
  F.pinClock();
  hiveRpcBatch.mockReset();
  hiveRpcBatch.mockImplementation(F.contentChain());
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.useRealTimers());

/** One shown 100 HBD campaign booked by `adv`, four impressions on `creator`. */
async function settleShown({ paidAssets = { HBD: 100 }, creator = 'creatorx', deps }) {
  const c = await F.seedCampaign(db(), period, { hiveAccount: 'adv', paidAssets });
  await F.seedImpressions(db(), c, 4, { owner: creator, period });
  await P.settlePeriod(db(), period, deps);
  return {
    paid: await F.payoutsOf(db(), period.key),
    doc: await F.cols(db()).periods.findOne({ _id: period.key }),
  };
}

describe('advertiser referral: 2% out of what the platform keeps', () => {
  test('a referred advertiser pays the referrer 2, and the creator, viewer and encoder shares do not move', async () => {
    const { paid, doc } = await settleShown({ deps: F.stubDeps({ referrers: { adv: 'refbob' }, real: ['refbob'] }) });
    expect(paid.creatorx.hbd).toBe(50);
    expect(paid.refbob).toMatchObject({ hbd: 2, kind: 'referral', amounts: [{ symbol: 'HBD', amount: 2 }] });
    expect(paid[ENCODER]).toMatchObject({ hbd: 5, kind: 'encoder' });
    expect(doc).toMatchObject({ viewerPoolHbd: 10, referralPoolHbd: 2, referralRecipients: 1, referralSkipped: [] });
  });

  test('a creator who is also the referrer gets ONE row holding both, never one overwriting the other', async () => {
    const { paid } = await settleShown({ creator: 'refbob', deps: F.stubDeps({ referrers: { adv: 'refbob' }, real: ['refbob'] }) });
    expect(await F.cols(db()).payouts.countDocuments({ account: 'refbob' })).toBe(1);
    expect(paid.refbob).toMatchObject({ hbd: 52, kind: 'creator+referral', amounts: [{ symbol: 'HBD', amount: 52 }], parts: { creator: 50, referral: 2 } });
  });

  test('a HIVE-funded campaign pays its referrer HIVE, scaled natively with no exchange rate', async () => {
    const { paid } = await settleShown({ paidAssets: { HIVE: 400 }, deps: F.stubDeps({ referrers: { adv: 'refbob' }, real: ['refbob'] }) });
    expect(paid.refbob).toMatchObject({ hbd: 2, amounts: [{ symbol: 'HIVE', amount: 8 }] });
    expect(paid[ENCODER].amounts).toEqual([{ symbol: 'HIVE', amount: 20 }]);
  });

  test('a mixed-asset campaign pays the referrer each asset in proportion', async () => {
    const { paid } = await settleShown({ paidAssets: { HBD: 40, HIVE: 240 }, deps: F.stubDeps({ referrers: { adv: 'refbob' }, real: ['refbob'] }) });
    expect(paid.refbob.amounts).toEqual([{ symbol: 'HBD', amount: 0.8 }, { symbol: 'HIVE', amount: 4.8 }]);
  });

  test.each([
    ['is not a real Hive account (a typo must not become a transfer)', { referrers: { adv: 'ghost' }, real: [] }, 'ghost', 'no_such_account'],
    ['cannot be confirmed because the node is down (fails CLOSED)', { referrers: { adv: 'refbob' }, real: 'throw' }, 'refbob', 'no_such_account'],
    ['is the advertiser themselves', { referrers: { adv: 'adv' }, real: ['adv'] }, 'adv', 'self'],
    ['is a platform account', { referrers: { adv: 'badadib' }, real: ['badadib'] }, 'badadib', 'reward_blocked'],
  ])('a referrer who %s is not paid, and the skip is recorded', async (_label, deps, referrer, why) => {
    const { paid, doc } = await settleShown({ deps: F.stubDeps(deps) });
    expect(paid[referrer]?.kind).not.toBe('referral');
    expect(paid.creatorx.hbd).toBe(50);
    expect(doc.referralSkipped).toEqual([{ advertiser: 'adv', referrer, why }]);
    expect(doc.referralPoolHbd).toBe(0);
  });

  test('an advertiser nobody referred changes nothing: only the creator and the encoders are paid', async () => {
    const { paid, doc } = await settleShown({ deps: F.stubDeps() });
    expect(Object.keys(paid).sort()).toEqual(['creatorx', ENCODER].sort());
    expect(doc.referralPoolHbd).toBe(0);
  });

  test('only the referrer of a SHOWN campaign is paid; a campaign nobody saw funds nobody', async () => {
    const shown = await F.seedCampaign(db(), period, { hiveAccount: 'adv' });
    await F.seedCampaign(db(), period, { hiveAccount: 'adv2', paidHbd: 60, priceHbd: 60, paidAssets: { HBD: 60 } });
    await F.seedImpressions(db(), shown, 2, { owner: 'creatorx', period });
    const deps = F.stubDeps({ referrers: { adv: 'refbob', adv2: 'refcarol' }, real: ['refbob', 'refcarol'] });
    await P.settlePeriod(db(), period, deps);
    const paid = await F.payoutsOf(db(), period.key);
    expect(paid.refbob.hbd).toBe(2);
    expect(paid.refcarol).toBeUndefined();
  });

  test('nothing shown at all: no referral, encoder or viewer row, and the creator pool carries', async () => {
    await F.seedCampaign(db(), period, { hiveAccount: 'adv' });
    await P.settlePeriod(db(), period, F.stubDeps({ referrers: { adv: 'refbob' }, real: ['refbob'] }));
    expect(await F.cols(db()).payouts.countDocuments({})).toBe(0);
    expect(await F.cols(db()).periods.findOne({ _id: period.key })).toMatchObject({ encoderPoolHbd: 0, carriedOut: 50, referralPoolHbd: 0 });
  });

  test('one referrer of two advertisers is paid once, for both', async () => {
    const a = await F.seedCampaign(db(), period, { hiveAccount: 'adv' });
    const b = await F.seedCampaign(db(), period, { hiveAccount: 'ADV2 ' });
    await F.seedImpressions(db(), a, 1, { owner: 'creatorx', period });
    await F.seedImpressions(db(), b, 1, { owner: 'creatorx', period });
    await P.settlePeriod(db(), period, F.stubDeps({ referrers: { adv: 'refbob', adv2: 'refbob' }, real: ['refbob'] }));
    expect((await F.payoutsOf(db(), period.key)).refbob.hbd).toBe(4);
  });

  test('a campaign with no advertiser account on it asks Butter Auth nothing', async () => {
    const c = await F.seedCampaign(db(), period, { hiveAccount: '' });
    await F.seedImpressions(db(), c, 1, { owner: 'creatorx', period });
    const referrersFor = jest.fn(async () => new Map());
    await P.settlePeriod(db(), period, { ...F.stubDeps(), referrersFor });
    expect(referrersFor).not.toHaveBeenCalled();
  });

  test('referral money below the sendable minimum is not carried into the creator pool', async () => {
    // A 0.01 HBD campaign: the 2% cut is 0.0002 and rounds to nothing.
    const c = await F.seedCampaign(db(), period, { hiveAccount: 'adv', paidHbd: 0.01, priceHbd: 0.01, paidAssets: { HBD: 0.01 } });
    await F.seedImpressions(db(), c, 1, { owner: 'creatorx', period });
    await P.settlePeriod(db(), period, F.stubDeps({ referrers: { adv: 'refbob' }, real: ['refbob'] }));
    const doc = await F.cols(db()).periods.findOne({ _id: period.key });
    expect((await F.payoutsOf(db(), period.key)).refbob).toBeUndefined();
    expect([doc.referralPoolHbd, doc.carriedOut]).toEqual([0, 0]);
  });
});

describe('earner referral bonus: 10% on top, for the first 90 days', () => {
  const row = (account, kind, hbd, legs) => ({ account, kind, hbd, amounts: legs || [{ symbol: 'HBD', amount: hbd }] });
  const linkRef = (referrer, days = 10, source = 'link') => ({ referrer, source, referredAt: daysBefore(days) });
  const plan = (rows, deps, room = 100) => P.planEarnerReferralBonus(db(), rows, period, room, F.stubDeps(deps));

  test('a link referral pays 10% of the earner\'s creator, viewer and listener money, and the earner keeps all of theirs', async () => {
    const earner = [
      row('newbie', 'creator', 1), row('newbie', 'viewer', 0.5),
      row('newbie', 'listener-audio', 0.3), row('newbie', 'listener-podcast', 0.2),
    ];
    const before = JSON.stringify(earner);
    const b = await plan(earner, { referrals: { newbie: linkRef('alice') }, real: ['alice'] });
    expect(b.rows).toEqual([{ account: 'alice', hbd: 0.2, amounts: [{ symbol: 'HBD', amount: 0.2 }], kind: 'earner-referral' }]);
    expect(b).toMatchObject({ poolHbd: 0.2, scaled: 1, skipped: [] });
    expect(JSON.stringify(earner)).toBe(before);
  });

  test('only link and invite referrals pay; a typed or unknown source pays nothing and says why', async () => {
    const earner = [row('a1', 'creator', 1), row('a2', 'creator', 1), row('a3', 'creator', 1)];
    const b = await plan(earner, {
      referrals: { a1: linkRef('chatgpt', 5, 'typed'), a2: linkRef('bob', 5, 'invite'), a3: linkRef('carl', 5, null) },
      real: ['chatgpt', 'bob', 'carl'],
    });
    expect(b.rows.map((r) => r.account)).toEqual(['bob']);
    expect(b.skipped.map((s) => s.why).sort()).toEqual(['source_typed', 'source_unknown']);
  });

  test('single level: community, referral, bonus and encoder money is never the basis of a bonus', async () => {
    const earner = ['community', 'referral', 'earner-referral', 'encoder'].map((k) => row('n1', k, 5));
    expect((await plan(earner, { referrals: { n1: linkRef('alice', 1) }, real: ['alice'] })).rows).toEqual([]);
  });

  test.each([
    [100, false], [90, false], [89, true], [0, true],
  ])('referred %i days before the period starts: paid = %s', async (days, isPaid) => {
    const b = await plan([row('earner', 'creator', 1)], { referrals: { earner: linkRef('alice', days) }, real: ['alice'] });
    expect(b.rows.length === 1).toBe(isPaid);
  });

  test('a referrer that is not on chain, blocked, the earner, or has no date is not paid', async () => {
    await F.cols(db()).creators.insertOne({ username: 'blockedguy', adRewardDisabled: true });
    const earner = ['e1', 'e2', 'e3', 'e4'].map((a) => row(a, 'creator', 1));
    const b = await plan(earner, {
      referrals: {
        e1: linkRef('ghost', 1), e2: linkRef('blockedguy', 1), e3: linkRef('e3', 1),
        e4: { referrer: 'e4ref', source: 'link', referredAt: null },
      },
      real: ['blockedguy', 'e3', 'e4ref'],
    });
    expect(b.rows).toEqual([]);
    expect(b.skipped.map((s) => s.why).sort()).toEqual(['no_date', 'no_such_account', 'reward_blocked', 'self']);
  });

  test('never more than the platform has left: every bonus is scaled down by the same factor', async () => {
    const earner = [row('m1', 'creator', 10), row('m2', 'viewer', 10)];
    const b = await plan(earner, { referrals: { m1: linkRef('alice', 1), m2: linkRef('bob', 1) }, real: ['alice', 'bob'] }, 1);
    expect(b.rows.map((r) => [r.account, r.hbd]).sort()).toEqual([['alice', 0.5], ['bob', 0.5]]);
    expect(b.scaled).toBe(0.5);
    expect(b.poolHbd).toBeLessThanOrEqual(1);
  });

  test('no room at all (no shown ads) pays no bonus and asks Butter Auth nothing', async () => {
    const referralsFor = jest.fn();
    const b = await P.planEarnerReferralBonus(db(), [row('z', 'creator', 1)], period, 0, { referralsFor });
    expect(b).toEqual({ rows: [], poolHbd: 0, skipped: [], scaled: 1 });
    expect(referralsFor).not.toHaveBeenCalled();
  });

  test('the bonus is paid in the earner\'s own assets, scaled 1:1 with no rate', async () => {
    const earner = [row('h', 'creator', 2, [{ symbol: 'HIVE', amount: 6 }, { symbol: 'HBD', amount: 0.5 }])];
    const b = await plan(earner, { referrals: { h: linkRef('alice', 1) }, real: ['alice'] });
    expect(b.rows[0].amounts).toEqual([{ symbol: 'HIVE', amount: 0.6 }, { symbol: 'HBD', amount: 0.05 }]);
  });

  test('one referrer of two earners gets one row; names are matched case-insensitively', async () => {
    const earner = [row('R1', 'creator', 1), row('r2', 'listener-podcast', 1)];
    const b = await plan(earner, { referrals: { r1: linkRef('alice', 1), r2: linkRef('ALICE ', 1, 'invite') }, real: ['alice'] });
    expect(b.rows.map((r) => [r.account, r.hbd])).toEqual([['alice', 0.2]]);
  });

  test('a bonus too small to send produces no row', async () => {
    const b = await plan([row('tiny', 'creator', 0.004)], { referrals: { tiny: linkRef('alice', 1) }, real: ['alice'] });
    expect(b.rows).toEqual([]);
  });

  test('referrer names are confirmed on chain at most 100 at a time', async () => {
    const earner = Array.from({ length: 150 }, (_, i) => row(`e${i}`, 'creator', 1));
    const referrals = Object.fromEntries(earner.map((r, i) => [r.account, linkRef(`ref${i}`, 1)]));
    const deps = F.stubDeps({ referrals, real: Object.values(referrals).map((r) => r.referrer) });
    const b = await P.planEarnerReferralBonus(db(), earner, period, 1000, deps);
    expect(deps.lookups.map((names) => names.length)).toEqual([100, 50]);
    expect(b.rows).toHaveLength(150);
  });

  test('inside a settlement: the referred creator keeps 50, their referrer gets 5 on top', async () => {
    const c = await F.seedCampaign(db(), period);
    await F.seedImpressions(db(), c, 2, { owner: 'newbie', period });
    await P.settlePeriod(db(), period, F.stubDeps({ referrals: { newbie: linkRef('alice') }, real: ['alice'] }));
    const paid = await F.payoutsOf(db(), period.key);
    expect(paid.newbie.hbd).toBe(50);
    expect(paid.alice).toMatchObject({ hbd: 5, kind: 'earner-referral' });
    expect(await F.cols(db()).periods.findOne({ _id: period.key })).toMatchObject({
      earnerReferralPoolHbd: 5, earnerReferralRecipients: 1, earnerReferralScaled: 1, earnerReferralSkipped: [],
    });
  });

  test('inside a settlement: a typed referral is left out of the recorded skips (it is the normal case)', async () => {
    const c = await F.seedCampaign(db(), period);
    await F.seedImpressions(db(), c, 1, { owner: 'newbie', period });
    await P.settlePeriod(db(), period, F.stubDeps({
      referrals: { newbie: linkRef('chatgpt', 5, 'typed') }, real: ['chatgpt'],
    }));
    expect((await F.cols(db()).periods.findOne({ _id: period.key })).earnerReferralSkipped).toEqual([]);
    expect((await F.payoutsOf(db(), period.key)).chatgpt).toBeUndefined();
  });

  test.each([
    ['AD_EARNER_REFERRAL_PCT', '0'],
    ['AD_EARNER_REFERRAL_DAYS', '0'],
  ])('%s=%s switches the bonus off', async (name, value) => {
    const prev = process.env[name];
    process.env[name] = value;
    let isolated;
    jest.isolateModules(() => { isolated = require('../../services/adPayouts'); });
    if (prev === undefined) delete process.env[name]; else process.env[name] = prev;
    const b = await isolated.planEarnerReferralBonus(db(), [row('newbie', 'creator', 10)], period, 100,
      F.stubDeps({ referrals: { newbie: linkRef('alice') }, real: ['alice'] }));
    expect(b.rows).toEqual([]);
  });
});

describe('the transfer memo', () => {
  test.each([
    ['a bonus-only row says so outright', 'earner-referral', '3Speak referral bonus - 2026-10-01'],
    ['a merged row names the bonus in words', 'creator+earner-referral', '3Speak ad revenue share (creator+referral bonus) - 2026-10-01'],
    ['an ordinary row names its reason', 'creator', '3Speak ad revenue share (creator) - 2026-10-01'],
    ['several reasons are all named', 'creator+viewer', '3Speak ad revenue share (creator+viewer) - 2026-10-01'],
  ])('%s', (_label, kind, memo) => {
    expect(P.payoutMemo({ kind, periodKey: '2026-10-01' })).toBe(memo);
  });
});
