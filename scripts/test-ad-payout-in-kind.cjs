#!/usr/bin/env node
/**
 * Payouts are made in the assets advertisers actually paid.
 *
 *   node scripts/test-ad-payout-in-kind.cjs
 *
 * `paidHbd` is a VALUATION, not a balance. An advertiser may pay entirely in HIVE,
 * and an HBD-denominated payout is then not merely awkward — it is impossible, and
 * every transfer fails for want of HBD. So a campaign's asset mix rides through
 * settlement and everyone is paid in kind.
 *
 * 🚨 The arithmetic trap this guards: "7 HBD worth of HIVE" is not "7 HIVE".
 * Splitting an HBD figure by a value ratio and labelling the pieces with symbols
 * would mispay the HIVE leg by the exchange rate. Native pools are scaled instead,
 * so no rate is consulted at payout time and the platform holds no position.
 *
 * Creates and removes its own rows, and parks real ones so nothing live is settled.
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

const MARK = 'inkind-test';

(async () => {
  await connectToMongo();
  const db = getDb();
  const camps = db.collection(cfg.AD_CAMPAIGNS_COLLECTION);
  const imps = db.collection(cfg.AD_IMPRESSIONS_COLLECTION);
  const pays = db.collection(cfg.AD_PAYOUTS_COLLECTION);
  const periods = db.collection(cfg.AD_PAYOUT_PERIODS_COLLECTION);
  const watch = db.collection(cfg.AD_VIEWER_WATCH_COLLECTION);

  const clean = async (per) => {
    await camps.deleteMany({ name: MARK });
    await imps.deleteMany({ sid: { $regex: `^${MARK}` } });
    await pays.deleteMany({ periodKey: per.key });
    await periods.deleteMany({ _id: per.key });
  };

  // Real unpaid viewer rows would otherwise be settled by these synthetic pools.
  const parked = (await watch.find({ payoutId: null }).project({ _id: 1 }).toArray()).map((r) => r._id);
  if (parked.length) await watch.updateMany({ _id: { $in: parked } }, { $set: { payoutId: '__inkind-test' } });

  const run = async (label, paidAssets, expectSymbols, expectAmounts) => {
    const per = P.periodContaining(Date.now() - 60 * 864e5);
    await clean(per);
    // Mid-period, derived from the period — a fixed +1 day lands ON end at 1-day periods.
    const mid = new Date(per.start.getTime() + (per.end.getTime() - per.start.getTime()) / 2);
    const c = await camps.insertOne({
      name: MARK, advertiserRef: MARK, hiveAccount: 'adv', status: 'complete',
      paidHbd: 100, priceHbd: 100, paidAssets,
      startAt: per.start, endAt: per.end, createdAt: per.start,
    });
    await imps.insertMany([0, 1, 2, 3].map((i) => ({
      sid: `${MARK}-${i}`, campaignId: c.insertedId, owner: 'creatorx', permlink: `p${i}`,
      completed: true, payoutId: null, completedAt: mid, at: mid,
    })));
    await P.settlePeriod(db, per);
    const row = await pays.findOne({ periodKey: per.key, account: 'creatorx' });
    console.log(`\n-- ${label} --`);
    check('creator paid', !!row, true);
    check('  hbd-equivalent still recorded', row.hbd, 50);
    check('  assets paid', row.amounts.map((a) => a.symbol).sort(), expectSymbols);
    check('  native amounts', row.amounts.map((a) => a.amount).sort((x, y) => x - y), expectAmounts);
    await clean(per);
  };

  try {
    // Paid entirely in HIVE. 400 HIVE in, creator pool is 50% => 200 HIVE out.
    // The HBD-equivalent is 50, and paying "50 HBD" here would be unsettleable.
    await run('funded entirely in HIVE', { HIVE: 400 }, ['HIVE'], [200]);

    // Paid entirely in HBD — unchanged behaviour.
    await run('funded entirely in HBD', { HBD: 100 }, ['HBD'], [50]);

    // Mixed. Each asset is halved independently; no rate is used, so the HIVE leg
    // is 50% of the HIVE and the HBD leg 50% of the HBD.
    await run('funded in BOTH', { HBD: 40, HIVE: 240 }, ['HBD', 'HIVE'], [20, 120]);

    // A campaign predating paidAssets must still settle, in HBD.
    await run('legacy campaign with no paidAssets', undefined, ['HBD'], [50]);
  } finally {
    if (parked.length) {
      await watch.updateMany({ _id: { $in: parked } }, { $set: { payoutId: null }, $unset: { settledAt: '' } });
    }
    console.log('\ncleaned up; parked viewer rows restored.');
  }

  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
