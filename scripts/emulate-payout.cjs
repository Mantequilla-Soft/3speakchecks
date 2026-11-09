/**
 * "What would the next payout send?" — answered against LIVE data, without paying
 * anyone and without writing anything.
 *
 *   node scripts/emulate-payout.cjs                    the period running now
 *   node scripts/emulate-payout.cjs --period 2026-11-06  a given period (its start day)
 *
 * Runs the real settlePeriod() against a READ-ONLY handle on the real database
 * (utils/readOnlyDb.js): every read is real, every write is recorded and dropped.
 * What it prints comes from those recorded writes, so it is exactly what a real
 * settlement would have written: the payout rows (with their per-label parts), the
 * period record, and how many impressions, viewer rows and listener rows it would
 * have claimed.
 *
 * 🚨 History: this script used to settle for real and then undo its writes. The undo
 * missed the `payoutId` stamped on viewer and listener rows, so a run on production
 * would have marked real people's watching settled without paying them, and its
 * delete-and-reinsert of every payout row raced the real payout job. Never go back
 * to that shape: if this needs to see something new, read it, do not write it.
 *
 * Transfers are not part of settlement (payPending sends them), and
 * AD_PAYOUT_ACTIVE_KEY is removed from the environment before anything loads, so
 * nothing here can sign one either way.
 */
process.chdir(require('path').join(__dirname, '..'));
require('dotenv').config();
delete process.env.AD_PAYOUT_ACTIVE_KEY;

const dbModule = require('../utils/db');
const cfg = require('../utils/config');
const { readOnlyDb } = require('../utils/readOnlyDb');
const { settlePeriod, periodContaining, accrualFor } = require('../services/adPayouts');

const fmt = (n) => (Number(n) || 0).toFixed(3);

/** The emulation itself, separate from the database connection so it can be tested. */
async function emulate(realDb, period, log = console.log) {
  const { db, writes } = readOnlyDb(realDb);

  const camps = await db.collection(cfg.AD_CAMPAIGNS_COLLECTION).find({}).toArray();
  let revenue = 0;
  for (const c of camps) {
    const a = accrualFor(c, period.start, period.end);
    revenue += a;
    if (a > 0) log(`  flight ${c._id}  accrues ${a.toFixed(5)} HBD of its ${c.paidHbd} paid`);
  }
  log(`\n  revenue this period : ${revenue.toFixed(5)} HBD`);
  log(`  creator pool (${cfg.AD_CREATOR_POOL_PCT}%)  : ${(revenue * cfg.AD_CREATOR_POOL_PCT / 100).toFixed(5)} HBD`);
  log(`  viewer pool  (${cfg.AD_VIEWER_POOL_PCT}%)  : from SHOWN campaigns only, see the period record below`);

  const result = await settlePeriod(db, period);
  if (!result) {
    log('\n  settlePeriod returned nothing: the period is already settled, or a lookup failed (see above).');
  }

  // Payout rows: writePayoutRows upserts one per (periodKey, account).
  const rows = writes
    .filter((w) => w.collection === cfg.AD_PAYOUTS_COLLECTION && w.op === 'updateOne')
    .map((w) => ({ account: w.args[0].account, ...(w.args[1].$set || {}) }))
    .sort((a, b) => (b.hbd || 0) - (a.hbd || 0));
  log(`\n  payout rows it would write: ${rows.length}`);
  for (const r of rows) {
    const legs = (r.amounts || []).map((l) => `${fmt(l.amount)} ${l.symbol}`).join(' + ') || 'nothing sendable';
    const parts = r.parts && Object.keys(r.parts).length > 1
      ? `  [${Object.entries(r.parts).map(([k, v]) => `${k} ${fmt(v)}`).join(', ')}]` : '';
    log(`     @${r.account}  ${fmt(r.hbd)} HBD  (${r.kind})  = ${legs}${parts}`);
  }
  const byKind = {};
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.parts && Object.keys(r.parts).length ? r.parts : { [r.kind]: r.hbd })) {
      byKind[k] = (byKind[k] || 0) + (Number(v) || 0);
    }
  }
  if (rows.length) log(`\n  by label: ${Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${fmt(v)}`).join(' · ')}`);

  // What it would claim.
  const claimed = (collection) => writes
    .filter((w) => w.collection === collection && w.op === 'updateMany')
    .reduce((a, w) => a + ((w.args[0]?._id?.$in || []).length), 0);
  log(`\n  would claim: ${claimed(cfg.AD_IMPRESSIONS_COLLECTION)} impressions, `
    + `${claimed(cfg.AD_VIEWER_WATCH_COLLECTION)} viewer rows, ${claimed(cfg.AD_LISTENER_LISTEN_COLLECTION)} listener rows`);

  const per = writes.find((w) => w.collection === cfg.AD_PAYOUT_PERIODS_COLLECTION && w.op === 'updateOne')?.args[1]?.$set;
  if (per) {
    log(`\n  period record: revenue ${fmt(per.revenueHbd)} pool ${fmt(per.poolHbd)} rate ${per.ratePerImpression}`);
    log(`                 impressions ${per.impressions} recipients ${per.recipients} dust carried ${fmt(per.carriedOut)}`);
    log(`                 viewer pool ${fmt(per.viewerPoolHbd)} (carried in ${fmt(per.viewerCarriedIn)}) paid ${fmt(per.viewerPaidHbd)} `
      + `to ${per.viewerRecipients}, carried out ${fmt(per.viewerCarriedOut)}`);
  }
  log(`\n  nothing was written: ${writes.length} write(s) recorded and dropped.`);
  return { result, rows, writes, period: per || null };
}

if (require.main === module) {
  (async () => {
    const i = process.argv.indexOf('--period');
    const at = i > 0 ? Date.parse(`${process.argv[i + 1]}T12:00:00Z`) : Date.now();
    if (!Number.isFinite(at)) { console.error('--period wants YYYY-MM-DD'); process.exit(2); }
    const period = periodContaining(at);
    await dbModule.connectToMongo();
    console.log(`period ${period.key}  ${period.start.toISOString()} → ${period.end.toISOString()}\n`);
    await emulate(dbModule.getDb(), period);
    process.exit(0);
  })().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { emulate };
