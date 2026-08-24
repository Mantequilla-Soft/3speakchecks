/**
 * "What would the next payout send?" — answered against LIVE data, without paying
 * anyone and without leaving a mark.
 *
 *   node scripts/emulate-payout.cjs
 *
 * Runs the real settlePeriod() on the real database, then restores every write it
 * made: payout rows, the period record, and the payoutId stamped on each impression.
 * Campaigns are never touched, so a flight that is mid-run stays mid-run.
 *
 * Transfers are stubbed by the module's OWN dry-run branch rather than by patching
 * it: AD_PAYOUT_ACTIVE_KEY is deleted from the environment before adPayouts is
 * required, and that module reads the key once at load. So the code path under test
 * is the one that runs in production, minus the broadcast.
 *
 * ⚠️ It writes and then rolls back, so do not run it against a settle in progress:
 * the rollback would undo that too. It is a read-only question asked with write-shaped
 * machinery, which is the only way to ask it accurately.
 */
process.chdir(require('path').join(__dirname, '..'));
require('dotenv').config();
delete process.env.AD_PAYOUT_ACTIVE_KEY;          // force dry run

const db = require('../utils/db');
const cfg = require('../utils/config');
const { settlePeriod, periodContaining, accrualFor } = require('../services/adPayouts');

(async () => {
  await db.connectToMongo();
  const d = db.getDb();
  const PAYOUTS = cfg.AD_PAYOUTS_COLLECTION;
  const PERIODS = cfg.AD_PAYOUT_PERIODS_COLLECTION;
  const IMPS = cfg.AD_IMPRESSIONS_COLLECTION;

  // ── snapshot, so this leaves no trace ──
  const beforePayouts = await d.collection(PAYOUTS).find({}).toArray();
  const beforePeriods = await d.collection(PERIODS).find({}).toArray();
  const impsWithPayout = await d.collection(IMPS).find({ payoutId: { $ne: null } }, { projection: { _id: 1, payoutId: 1 } }).toArray();
  const campsBefore = await d.collection('ad_campaigns').find({}, { projection: { _id: 1, status: 1, deliveredImpressions: 1 } }).toArray();

  const period = periodContaining(Date.now());
  console.log(`period ${period.key}  ${period.start.toISOString()} → ${period.end.toISOString()}\n`);

  const camps = await d.collection('ad_campaigns').find({}).toArray();
  let revenue = 0;
  for (const c of camps) {
    const a = accrualFor(c, period.start, period.end);
    revenue += a;
    console.log(`  flight ${c._id}  accrued ${a.toFixed(5)} HBD of its ${c.paidHbd} paid`);
  }
  console.log(`\n  revenue this period : ${revenue.toFixed(5)} HBD`);
  console.log(`  creator pool (${cfg.AD_CREATOR_POOL_PCT}%)  : ${(revenue * cfg.AD_CREATOR_POOL_PCT / 100).toFixed(5)} HBD`);

  const res = await settlePeriod(d, period);
  console.log('\n  settle result:', JSON.stringify(res));

  const rows = await d.collection(PAYOUTS).find({ periodKey: period.key }).toArray();
  console.log(`\n  payout rows it would write: ${rows.length}`);
  rows.forEach(r => console.log(`     @${r.account}  ${r.hbd} HBD  (${r.kind})  status=${r.status}`));
  const per = await d.collection(PERIODS).findOne({ _id: period.key });
  if (per) {
    console.log(`\n  period record: revenue ${per.revenueHbd} pool ${per.poolHbd} rate ${per.ratePerImpression}`);
    console.log(`                 impressions ${per.impressions} recipients ${per.recipients} dust carried ${per.carriedOut}`);
  }

  // ── roll back ──
  await d.collection(PAYOUTS).deleteMany({});
  if (beforePayouts.length) await d.collection(PAYOUTS).insertMany(beforePayouts);
  await d.collection(PERIODS).deleteMany({});
  if (beforePeriods.length) await d.collection(PERIODS).insertMany(beforePeriods);
  await d.collection(IMPS).updateMany({}, { $set: { payoutId: null } });
  for (const i of impsWithPayout) await d.collection(IMPS).updateOne({ _id: i._id }, { $set: { payoutId: i.payoutId } });

  const campsAfter = await d.collection('ad_campaigns').find({}, { projection: { _id: 1, status: 1, deliveredImpressions: 1 } }).toArray();
  const changed = campsAfter.filter((a, i) => JSON.stringify(a) !== JSON.stringify(campsBefore[i]));
  console.log(`\n  rolled back. payout rows: ${await d.collection(PAYOUTS).countDocuments({})}, periods: ${await d.collection(PERIODS).countDocuments({})}`);
  console.log(`  unsettled impressions restored: ${await d.collection(IMPS).countDocuments({ payoutId: null })}`);
  console.log(`  campaigns changed by this run  : ${changed.length} (0 = your running ads untouched)`);
  process.exit(0);
})();
