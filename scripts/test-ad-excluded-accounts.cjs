#!/usr/bin/env node
/**
 * Accounts in AD_EXCLUDED_ACCOUNTS never receive an ad payout.
 *
 *   node scripts/test-ad-excluded-accounts.cjs
 *
 * badadib is the platform's own ad account. Crediting it as a creator is the platform
 * paying itself; crediting it as a viewer takes a slice of a pool we told viewers was
 * theirs. But the two sides handle its ACTIVITY differently, and that asymmetry is the
 * whole point of this file:
 *
 *   creator — its impressions STILL count in the denominator, so `ratePerImpression`,
 *     which every other creator is paid at, does not move because we happen to be
 *     running ads on ourselves. Only the credit is withheld.
 *   viewer  — its seconds are dropped from the denominator too, so the remaining
 *     viewers split the WHOLE pool rather than handing part of it back to us.
 *
 * 🚨 Parks every real unpaid impression and watch row before settling, and restores
 * them in a `finally`. A synthetic pool run against live rows is exactly how a test
 * once queued a real 1.777 HBD transfer.
 */
require('dotenv').config();
const { connectToMongo, getDb } = require('../utils/db');
const P = require('../services/adPayouts');
const cfg = require('../utils/config');

let failed = 0;
const check = (l, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${l}${ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`}`);
};

const MARK = 'excl-test';
const EXCLUDED = cfg.AD_EXCLUDED_ACCOUNTS[0];

(async () => {
  await connectToMongo();
  const db = getDb();
  const camps = db.collection(cfg.AD_CAMPAIGNS_COLLECTION);
  const imps = db.collection(cfg.AD_IMPRESSIONS_COLLECTION);
  const pays = db.collection(cfg.AD_PAYOUTS_COLLECTION);
  const periods = db.collection(cfg.AD_PAYOUT_PERIODS_COLLECTION);
  const watch = db.collection(cfg.AD_VIEWER_WATCH_COLLECTION);

  console.log(`  excluded accounts: ${cfg.AD_EXCLUDED_ACCOUNTS.join(', ')}\n`);
  if (!EXCLUDED) { console.log('no excluded accounts configured — nothing to test'); process.exit(0); }

  const per = P.periodContaining(Date.now() - 60 * 864e5);
  // Mid-period, derived from the period: a fixed +1 day lands ON end when the period
  // is a single day, and `$lt: end` then excludes every impression.
  const mid = new Date(per.start.getTime() + (per.end.getTime() - per.start.getTime()) / 2);

  const clean = async () => {
    await camps.deleteMany({ name: MARK });
    await imps.deleteMany({ sid: { $regex: `^${MARK}` } });
    await watch.deleteMany({ viewer: { $in: [EXCLUDED, `${MARK}-viewer`] }, permlink: { $regex: `^${MARK}` } });
    await pays.deleteMany({ periodKey: per.key });
    await periods.deleteMany({ _id: per.key });
  };

  // Park everything real that settlement would otherwise sweep in.
  const parkedImps = (await imps.find({ payoutId: null }).project({ _id: 1 }).toArray()).map((r) => r._id);
  const parkedWatch = (await watch.find({ payoutId: null }).project({ _id: 1 }).toArray()).map((r) => r._id);
  if (parkedImps.length) await imps.updateMany({ _id: { $in: parkedImps } }, { $set: { payoutId: '__excl-test' } });
  if (parkedWatch.length) await watch.updateMany({ _id: { $in: parkedWatch } }, { $set: { payoutId: '__excl-test' } });
  console.log(`  parked ${parkedImps.length} impression(s) and ${parkedWatch.length} watch row(s)\n`);

  try {
    await clean();

    const c = await camps.insertOne({
      name: MARK, advertiserRef: MARK, hiveAccount: 'adv', status: 'complete',
      paidHbd: 100, priceHbd: 100, paidAssets: { HBD: 100 },
      startAt: per.start, endAt: per.end, createdAt: per.start,
    });

    // Two impressions on the excluded account's videos, two on a normal creator's.
    await imps.insertMany([
      ...[0, 1].map((i) => ({ sid: `${MARK}-x${i}`, campaignId: c.insertedId, owner: EXCLUDED, permlink: `xp${i}`, completed: true, payoutId: null, completedAt: mid, at: mid })),
      ...[0, 1].map((i) => ({ sid: `${MARK}-n${i}`, campaignId: c.insertedId, owner: `${MARK}-creator`, permlink: `np${i}`, completed: true, payoutId: null, completedAt: mid, at: mid })),
    ]);

    // Equal watch time for an excluded viewer and a normal one.
    await watch.insertMany([
      { viewer: EXCLUDED, owner: 'someone', permlink: `${MARK}-v1`, contentSeconds: 600, watchedPct: 90, payoutId: null },
      { viewer: `${MARK}-viewer`, owner: 'someone', permlink: `${MARK}-v2`, contentSeconds: 600, watchedPct: 90, payoutId: null },
    ]);

    await P.settlePeriod(db, per);
    const period = await periods.findOne({ _id: per.key });
    const rows = await pays.find({ periodKey: per.key }).toArray();
    const by = (a) => rows.find((r) => r.account === a);

    console.log('-- creator side: impressions still counted, credit withheld --');
    check('all 4 impressions counted', period.impressions, 4);
    // pool = 100 * AD_CREATOR_POOL_PCT/100, split across all four impressions.
    const pool = 100 * (cfg.AD_CREATOR_POOL_PCT / 100);
    check('  rate is pool/4, not pool/2', Math.round(period.ratePerImpression * 1e6) / 1e6, Math.round((pool / 4) * 1e6) / 1e6);
    check('  normal creator paid for its 2', Math.round((by(`${MARK}-creator`)?.hbd ?? -1) * 1000) / 1000, Math.round((pool / 4) * 2 * 1000) / 1000);
    check('  excluded account has NO payout row', !by(EXCLUDED), true);

    console.log('\n-- viewer side: seconds dropped from the pool entirely --');
    const viewerRow = by(`${MARK}-viewer`);
    check('normal viewer paid', !!viewerRow, true);
    check('  gets the WHOLE viewer pool, not half', Math.round((viewerRow?.hbd ?? -1) * 1000) / 1000, Math.round(period.viewerPoolHbd * 1000) / 1000);
    check('  excluded viewer has no payout row', !by(EXCLUDED), true);
    const exclWatch = await watch.findOne({ viewer: EXCLUDED, permlink: `${MARK}-v1` });
    check('  excluded row still CLAIMED (not re-read forever)', exclWatch.payoutId, per.key);

    console.log('\n-- nothing real was touched --');
    const strays = rows.filter((r) => r.account !== `${MARK}-creator` && r.account !== `${MARK}-viewer`);
    check('no payout row for any account outside this test', strays.map((r) => r.account), []);

    await clean();
  } finally {
    if (parkedImps.length) await imps.updateMany({ _id: { $in: parkedImps } }, { $set: { payoutId: null } });
    if (parkedWatch.length) {
      await watch.updateMany({ _id: { $in: parkedWatch } }, { $set: { payoutId: null }, $unset: { settledAt: '' } });
    }
    console.log('\ncleaned up; parked rows restored.');
  }

  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
