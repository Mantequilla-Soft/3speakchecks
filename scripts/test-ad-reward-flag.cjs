#!/usr/bin/env node
/**
 * `contentcreators.adRewardDisabled` withholds payment without withholding ads.
 *
 *   node scripts/test-ad-reward-flag.cjs
 *
 * An admin sets the flag on an account. From then on we do not send that account money,
 * as a creator or as a viewer. Everything else is unchanged: their videos still carry
 * ads, the advertiser is still charged, the impression is still real inventory.
 *
 * 🚨 BLOCKED IS NOT OPTED OUT. Opting out of ads is the creator's own switch
 * (ad_creator_prefs) and it removes their videos from what we sell. This flag is ours,
 * and it only stops a transfer. The test asserts the difference by checking the
 * impression still counts toward the rate everyone else is paid at.
 *
 * The two sides are asymmetric on purpose, same as the platform's own accounts:
 *   creator — impressions STAY in the denominator, so blocking one creator does not
 *     change what any other creator earns per impression.
 *   viewer  — seconds LEAVE the denominator, because the viewer pool is a fixed sum
 *     earmarked for viewers and a blocked viewer must not shrink everyone else's share.
 *
 * Sets the flag on throwaway accounts it creates, and removes them in a `finally`.
 * Parks real rows first, via the shared guard.
 */
require('dotenv').config();
const { connectToMongo, getDb } = require('../utils/db');
const P = require('../services/adPayouts');
const cfg = require('../utils/config');
const { parkRealRows } = require('./_realMoneyGuard.cjs');

let failed = 0;
const check = (l, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${l}${ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`}`);
};

const MARK = 'rewardflag-test';
const BLOCKED_CREATOR = `${MARK}-blocked-creator`;
const PAID_CREATOR = `${MARK}-paid-creator`;
const BLOCKED_VIEWER = `${MARK}-blocked-viewer`;
const PAID_VIEWER = `${MARK}-paid-viewer`;

(async () => {
  await connectToMongo();
  const db = getDb();
  const camps = db.collection(cfg.AD_CAMPAIGNS_COLLECTION);
  const imps = db.collection(cfg.AD_IMPRESSIONS_COLLECTION);
  const pays = db.collection(cfg.AD_PAYOUTS_COLLECTION);
  const periods = db.collection(cfg.AD_PAYOUT_PERIODS_COLLECTION);
  const watch = db.collection(cfg.AD_VIEWER_WATCH_COLLECTION);
  const creators = db.collection(cfg.AD_REWARD_FLAG_COLLECTION);

  console.log(`  flag collection: ${cfg.AD_REWARD_FLAG_COLLECTION}.adRewardDisabled\n`);

  const per = P.periodContaining(Date.now() - 60 * 864e5);
  // Derived from the period, so this holds at any configured period length.
  const mid = new Date(per.start.getTime() + (per.end.getTime() - per.start.getTime()) / 2);

  const wipe = async () => {
    await camps.deleteMany({ name: MARK });
    await imps.deleteMany({ sid: { $regex: `^${MARK}` } });
    await watch.deleteMany({ permlink: { $regex: `^${MARK}` } });
    await pays.deleteMany({ periodKey: per.key });
    await periods.deleteMany({ _id: per.key });
    await creators.deleteMany({ username: { $regex: `^${MARK}` } });
  };

  const restoreRealRows = await parkRealRows(db, cfg);
  try {
    await wipe();

    // Two creators and two viewers; one of each is flagged by an "admin".
    await creators.insertMany([
      { username: BLOCKED_CREATOR, adRewardDisabled: true },
      { username: PAID_CREATOR },
      { username: BLOCKED_VIEWER, adRewardDisabled: true },
      { username: PAID_VIEWER, adRewardDisabled: false },
    ]);

    const c = await camps.insertOne({
      name: MARK, advertiserRef: MARK, hiveAccount: 'adv', status: 'complete',
      paidHbd: 100, priceHbd: 100, paidAssets: { HBD: 100 },
      startAt: per.start, endAt: per.end, createdAt: per.start,
    });
    // Two impressions each: identical work, one creator flagged.
    await imps.insertMany([
      ...[0, 1].map((i) => ({ sid: `${MARK}-b${i}`, campaignId: c.insertedId, owner: BLOCKED_CREATOR, permlink: `bp${i}`, completed: true, payoutId: null, completedAt: mid, at: mid })),
      ...[0, 1].map((i) => ({ sid: `${MARK}-p${i}`, campaignId: c.insertedId, owner: PAID_CREATOR, permlink: `pp${i}`, completed: true, payoutId: null, completedAt: mid, at: mid })),
    ]);
    // Equal watch time, one viewer flagged.
    await watch.insertMany([
      { viewer: BLOCKED_VIEWER, owner: 'someone', permlink: `${MARK}-v1`, contentSeconds: 600, watchedPct: 90, payoutId: null },
      { viewer: PAID_VIEWER, owner: 'someone', permlink: `${MARK}-v2`, contentSeconds: 600, watchedPct: 90, payoutId: null },
    ]);

    await P.settlePeriod(db, per);
    const period = await periods.findOne({ _id: per.key });
    const rows = await pays.find({ periodKey: per.key }).toArray();
    const by = (a) => rows.find((r) => r.account === a);
    const pool = 100 * (cfg.AD_CREATOR_POOL_PCT / 100);

    console.log('-- creator: ads still served and charged, money withheld --');
    check('all 4 impressions counted', period.impressions, 4);
    check('  rate unchanged by the block (pool/4)', Math.round(period.ratePerImpression * 1e6) / 1e6, Math.round((pool / 4) * 1e6) / 1e6);
    check('  unflagged creator paid for its 2', Math.round((by(PAID_CREATOR)?.hbd ?? -1) * 1000) / 1000, Math.round((pool / 4) * 2 * 1000) / 1000);
    check('  flagged creator has NO payout row', !by(BLOCKED_CREATOR), true);

    console.log('\n-- viewer: seconds leave the pool entirely --');
    check('unflagged viewer paid', !!by(PAID_VIEWER), true);
    check('  gets the WHOLE viewer pool, not half', Math.round((by(PAID_VIEWER)?.hbd ?? -1) * 1000) / 1000, Math.round(period.viewerPoolHbd * 1000) / 1000);
    check('  flagged viewer has NO payout row', !by(BLOCKED_VIEWER), true);
    const bw = await watch.findOne({ viewer: BLOCKED_VIEWER });
    check('  flagged row claimed, not re-read forever', bw.payoutId, per.key);

    console.log('\n-- the flag is read strictly --');
    // A missing field, an explicit false and a truthy-but-not-true value must all pay.
    check('adRewardDisabled: false pays', !!by(PAID_VIEWER), true);
    check('  a missing field pays', !!by(PAID_CREATOR), true);
    await creators.updateOne({ username: PAID_CREATOR }, { $set: { adRewardDisabled: 'yes' } });
    await pays.deleteMany({ periodKey: per.key });
    await periods.deleteMany({ _id: per.key });
    await imps.updateMany({ sid: { $regex: `^${MARK}` } }, { $set: { payoutId: null } });
    await watch.updateMany({ permlink: { $regex: `^${MARK}` } }, { $set: { payoutId: null }, $unset: { settledAt: '' } });
    await P.settlePeriod(db, per);
    const again = await pays.find({ periodKey: per.key }).toArray();
    check("  a non-boolean 'yes' does NOT withhold", !!again.find((r) => r.account === PAID_CREATOR), true);

    console.log('\n-- nothing real was touched --');
    const strays = again.filter((r) => !r.account.startsWith(MARK));
    check('no payout row outside this test', strays.map((r) => r.account), []);

    await wipe();
  } finally {
    await creators.deleteMany({ username: { $regex: `^${MARK}` } });
    await restoreRealRows();
  }

  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
