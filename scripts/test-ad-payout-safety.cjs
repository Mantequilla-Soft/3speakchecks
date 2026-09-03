#!/usr/bin/env node
/**
 * The four payment defects found in the pre-release review, each pinned by a test that
 * FAILS against the old behaviour.
 *
 *   node scripts/test-ad-payout-safety.cjs
 *
 * 1. a partly-failed multi-asset payout must not re-send the leg that landed
 * 2. a viewer under the minimum must keep their entitlement, not have it erased
 * 3. settlement must run for a period that took revenue but served no impressions
 * 4. a carry must be paid in the assets it arrived as, never minted into a new one
 *
 * 🚨 Parks every real unpaid row before settling and restores them in a `finally`.
 * A synthetic pool run against live rows is how a test once queued a real transfer.
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

const MARK = 'safety-test';

(async () => {
  await connectToMongo();
  const db = getDb();
  const camps = db.collection(cfg.AD_CAMPAIGNS_COLLECTION);
  const imps = db.collection(cfg.AD_IMPRESSIONS_COLLECTION);
  const pays = db.collection(cfg.AD_PAYOUTS_COLLECTION);
  const periods = db.collection(cfg.AD_PAYOUT_PERIODS_COLLECTION);
  const watch = db.collection(cfg.AD_VIEWER_WATCH_COLLECTION);

  const parkedImps = (await imps.find({ payoutId: null }).project({ _id: 1 }).toArray()).map((r) => r._id);
  const parkedWatch = (await watch.find({ payoutId: null }).project({ _id: 1 }).toArray()).map((r) => r._id);
  const parkedPays = (await pays.find({ status: 'pending' }).project({ _id: 1 }).toArray()).map((r) => r._id);
  if (parkedImps.length) await imps.updateMany({ _id: { $in: parkedImps } }, { $set: { payoutId: '__safety' } });
  if (parkedWatch.length) await watch.updateMany({ _id: { $in: parkedWatch } }, { $set: { payoutId: '__safety' } });
  if (parkedPays.length) await pays.updateMany({ _id: { $in: parkedPays } }, { $set: { status: '__safety' } });
  console.log(`  parked ${parkedImps.length} impression(s), ${parkedWatch.length} watch row(s), ${parkedPays.length} pending payout(s)\n`);

  const wipe = async (per) => {
    await camps.deleteMany({ name: MARK });
    await imps.deleteMany({ sid: { $regex: `^${MARK}` } });
    await watch.deleteMany({ permlink: { $regex: `^${MARK}` } });
    await pays.deleteMany({ account: { $regex: `^${MARK}` } });
    if (per) { await pays.deleteMany({ periodKey: per.key }); await periods.deleteMany({ _id: per.key }); }
  };

  try {
    /* ── 1. a landed leg is never re-sent ─────────────────────────────────── */
    console.log('-- 1. partly-failed multi-asset payout --');
    await wipe(null);
    await pays.insertOne({
      periodKey: `${MARK}-p1`, account: `${MARK}-creator`, kind: 'creator', hbd: 30,
      amounts: [{ symbol: 'HBD', amount: 10 }, { symbol: 'HIVE', amount: 200 }],
      status: 'pending', createdAt: new Date(),
    });

    const attempts = [];
    // Fails only on HIVE, exactly like a node rejecting one asset.
    const flaky = { broadcast: { sendOperations: async (ops) => {
      const amount = ops[0][1].amount;
      attempts.push(amount);
      if (amount.endsWith('HIVE')) throw new Error('simulated node failure');
      return { id: 'trx' };
    } } };
    await P.payPending(db, { client: flaky, key: 'stub' });
    const afterFail = await pays.findOne({ account: `${MARK}-creator` });
    check('HBD leg broadcast, HIVE leg attempted', attempts, ['10.000 HBD', '200.000 HIVE']);
    check('  row NOT marked paid', afterFail.status, 'pending');
    check('  the landed leg is recorded', afterFail.sentLegs, ['HBD']);

    // Retry with a client that works. The HBD leg must NOT go out a second time.
    const good = { broadcast: { sendOperations: async (ops) => { attempts.push(ops[0][1].amount); return { id: 'trx' }; } } };
    await P.payPending(db, { client: good, key: 'stub' });
    const afterRetry = await pays.findOne({ account: `${MARK}-creator` });
    check('retry sends ONLY the missing leg', attempts.slice(2), ['200.000 HIVE']);
    check('  HBD sent exactly once overall', attempts.filter((a) => a.endsWith('HBD')).length, 1);
    check('  row now paid', afterRetry.status, 'paid');

    /* ── 2. a viewer under the minimum keeps their entitlement ────────────── */
    console.log('\n-- 2. viewer below the minimum --');
    const per = P.periodContaining(Date.now() - 60 * 864e5);
    await wipe(per);
    const mid = new Date(per.start.getTime() + 864e5);
    const c1 = await camps.insertOne({
      name: MARK, advertiserRef: MARK, hiveAccount: 'adv', status: 'complete',
      paidHbd: 20, priceHbd: 20, paidAssets: { HBD: 20 },
      startAt: per.start, endAt: per.end, createdAt: per.start,
    });
    await imps.insertOne({ sid: `${MARK}-i0`, campaignId: c1.insertedId, owner: `${MARK}-owner`, permlink: 'p0', completed: true, payoutId: null, completedAt: mid, at: mid });
    /* Viewer pool on 20 HBD is 1.00 HBD. One heavy viewer and twenty casual ones, each
     * with 5s of a 10,100s total — 0.000495 HBD apiece, under the 0.001 floor. That is
     * the shape this actually takes in production: a long tail of people who watched
     * something, qualified, and individually cannot be sent anything yet. A single
     * small viewer would not do, because one viewer's unpayable share is by definition
     * under the floor and rounds to nothing; it is their SUM that has to survive. */
    await watch.insertOne({ viewer: `${MARK}-whale`, owner: 'x', permlink: `${MARK}-w0`, contentSeconds: 10000, watchedPct: 90, payoutId: null });
    await watch.insertMany(Array.from({ length: 20 }, (_, i) => (
      { viewer: `${MARK}-minnow${i}`, owner: 'x', permlink: `${MARK}-m${i}`, contentSeconds: 5, watchedPct: 90, payoutId: null }
    )));
    await P.settlePeriod(db, per);
    const minnowRow = await watch.findOne({ viewer: `${MARK}-minnow0` });
    const whaleRow = await watch.findOne({ viewer: `${MARK}-whale` });
    check('viewers under the minimum are NOT paid', await pays.countDocuments({ account: { $regex: `^${MARK}-minnow` } }), 0);
    check('  and their rows stay UNCLAIMED so they keep earning', minnowRow.payoutId, null);
    check('  all 20 of them', await watch.countDocuments({ viewer: { $regex: `^${MARK}-minnow` }, payoutId: null }), 20);
    check('  the paid viewer IS claimed', whaleRow.payoutId, per.key);
    const perDoc = await periods.findOne({ _id: per.key });
    check('  their combined share is carried, not kept', perDoc.viewerCarriedOut, 0.01);
    check('  and the carry names its asset', perDoc.viewerCarriedOutAssets, { HBD: 0.01 });

    /* ── 3. revenue with no impressions still settles ─────────────────────── */
    console.log('\n-- 3. a period that took revenue and served nothing --');
    const per3 = P.periodContaining(Date.now() - 120 * 864e5);
    await wipe(per3);
    await camps.insertOne({
      name: MARK, advertiserRef: MARK, hiveAccount: 'adv', status: 'complete',
      paidHbd: 40, priceHbd: 40, paidAssets: { HBD: 40 },
      startAt: per3.start, endAt: per3.end, createdAt: per3.start,
    });
    // No impressions at all for this period — the case that used to be skipped.
    const r3 = await P.settlePeriod(db, per3);
    const doc3 = await periods.findOne({ _id: per3.key });
    check('settles rather than being skipped', !!doc3, true);
    check('  revenue recognised', Math.round(doc3.revenueHbd), 40);
    check('  whole pool carried forward, not lost', Math.round(doc3.carriedOut * 100) / 100, Math.round(40 * (cfg.AD_CREATOR_POOL_PCT / 100) * 100) / 100);
    check('  carry names the asset it is made of', doc3.carriedOutAssets, { HBD: 40 * (cfg.AD_CREATOR_POOL_PCT / 100) });
    check('  and points at the next period', doc3.carryTo, P.periodContaining(per3.end.getTime()).key);
    void r3;

    /* ── 4. a carry keeps its asset ───────────────────────────────────────── */
    console.log('\n-- 4. a HIVE carry must not become HBD --');
    const perA = P.periodContaining(Date.now() - 200 * 864e5);
    const perB = P.periodContaining(perA.end.getTime());
    await wipe(perA); await wipe(perB);
    // Period A: funded entirely in HIVE, serves nothing → its pool carries.
    await camps.insertOne({
      name: MARK, advertiserRef: MARK, hiveAccount: 'adv', status: 'complete',
      paidHbd: 100, priceHbd: 100, paidAssets: { HIVE: 400 },
      startAt: perA.start, endAt: perA.end, createdAt: perA.start,
    });
    await P.settlePeriod(db, perA);
    const docA = await periods.findOne({ _id: perA.key });
    check('period A carries HIVE, not HBD', Object.keys(docA.carriedOutAssets), ['HIVE']);

    // Period B: funded entirely in HBD, and serves one impression.
    const cB = await camps.insertOne({
      name: MARK, advertiserRef: MARK, hiveAccount: 'adv', status: 'complete',
      paidHbd: 100, priceHbd: 100, paidAssets: { HBD: 100 },
      startAt: perB.start, endAt: perB.end, createdAt: perB.start,
    });
    await imps.insertOne({ sid: `${MARK}-b0`, campaignId: cB.insertedId, owner: `${MARK}-owner`, permlink: 'pb', completed: true, payoutId: null, completedAt: new Date(perB.start.getTime() + 864e5), at: new Date(perB.start.getTime() + 864e5) });
    await P.settlePeriod(db, perB);
    const payB = await pays.findOne({ periodKey: perB.key, account: `${MARK}-owner` });
    const symbols = (payB.amounts || []).map((a) => a.symbol).sort();
    check('the payout carries BOTH assets', symbols, ['HBD', 'HIVE']);
    const hive = (payB.amounts || []).find((a) => a.symbol === 'HIVE');
    check('  the HIVE leg is the carried HIVE, not invented', Math.round(hive.amount), 200);
    check('  and the HBD leg is only what period B took in', Math.round((payB.amounts.find((a) => a.symbol === 'HBD') || {}).amount), 50);

    await wipe(per); await wipe(per3); await wipe(perA); await wipe(perB);
  } finally {
    if (parkedImps.length) await imps.updateMany({ _id: { $in: parkedImps } }, { $set: { payoutId: null } });
    if (parkedWatch.length) await watch.updateMany({ _id: { $in: parkedWatch } }, { $set: { payoutId: null }, $unset: { settledAt: '' } });
    if (parkedPays.length) await pays.updateMany({ _id: { $in: parkedPays } }, { $set: { status: 'pending' } });
    console.log('\ncleaned up; parked rows restored.');
  }

  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
