/**
 * Keep a test's synthetic pools away from real money.
 *
 * 🚨 WHY THIS EXISTS, TWICE OVER.
 *
 * `settlePeriod` distributes to whatever is unsettled, and by design it has NO date
 * filter on viewer rows — a watch banked in an earlier period is still owed, so it
 * cannot be scoped by period. That means ANY test which calls settlePeriod against a
 * synthetic campaign sweeps in every real unpaid impression and watch row on the box.
 *
 * It has already gone wrong twice:
 *   2026-09-02  a test's fake 20 HBD pool queued a live 1.777 HBD transfer to @tibfox.
 *   2026-09-03  test-ad-community-split claimed @tibfox's real 195s watch row, stamping
 *               it settled with no payout at all. His entitlement was simply erased.
 *
 * Those two are the same omission with opposite symptoms, and which one you get depends
 * on whether the real account clears the payout minimum. Neither is acceptable, so this
 * is a shared helper rather than a paragraph in each test that someone can forget:
 *
 *   const { parkRealRows } = require('./_realMoneyGuard.cjs');
 *   const restore = await parkRealRows(db, cfg);
 *   try { ...settle things... } finally { await restore(); }
 *
 * Parking sets a sentinel `payoutId`/`status` so settlement's `{ payoutId: null }` and
 * `{ status: 'pending' }` queries cannot see the rows. Restore puts them back exactly.
 * Always restore in a `finally`, or a thrown assertion strands real rows.
 */

const SENTINEL = '__parked-by-test';

async function parkRealRows(db, cfg) {
  const imps = db.collection(cfg.AD_IMPRESSIONS_COLLECTION);
  const watch = db.collection(cfg.AD_VIEWER_WATCH_COLLECTION);
  const pays = db.collection(cfg.AD_PAYOUTS_COLLECTION);

  const impIds = (await imps.find({ payoutId: null }).project({ _id: 1 }).toArray()).map((r) => r._id);
  const watchIds = (await watch.find({ payoutId: null }).project({ _id: 1 }).toArray()).map((r) => r._id);
  const payIds = (await pays.find({ status: 'pending' }).project({ _id: 1 }).toArray()).map((r) => r._id);

  if (impIds.length) await imps.updateMany({ _id: { $in: impIds } }, { $set: { payoutId: SENTINEL } });
  if (watchIds.length) await watch.updateMany({ _id: { $in: watchIds } }, { $set: { payoutId: SENTINEL } });
  // A real pending payout would otherwise be broadcast by a test that reaches payPending.
  if (payIds.length) await pays.updateMany({ _id: { $in: payIds } }, { $set: { status: SENTINEL } });

  if (impIds.length || watchIds.length || payIds.length) {
    console.log(`  [guard] parked ${impIds.length} impression(s), ${watchIds.length} watch row(s), ${payIds.length} pending payout(s)`);
  }

  return async function restore() {
    // `settledAt` is unset as well: a restored row must look untouched, not settled-then-
    // unsettled, or the next settlement reports a date that never happened.
    if (impIds.length) await imps.updateMany({ _id: { $in: impIds } }, { $set: { payoutId: null } });
    if (watchIds.length) await watch.updateMany({ _id: { $in: watchIds } }, { $set: { payoutId: null }, $unset: { settledAt: '' } });
    if (payIds.length) await pays.updateMany({ _id: { $in: payIds } }, { $set: { status: 'pending' } });
    if (impIds.length || watchIds.length || payIds.length) console.log('  [guard] real rows restored');
  };
}

/**
 * Assert a test paid nobody outside itself.
 *
 * Parking is the defence; this is the alarm. Call it before restoring, with the prefix
 * your test's own accounts share.
 */
async function assertNoStrayPayouts(db, cfg, ownPrefix) {
  const rows = await db.collection(cfg.AD_PAYOUTS_COLLECTION)
    .find({ account: { $not: new RegExp(`^${ownPrefix}`) } }).toArray();
  const strays = rows.filter((r) => r.status !== SENTINEL);
  if (strays.length) {
    console.error(`  🚨 STRAY PAYOUTS to ${strays.map((r) => `@${r.account} ${r.hbd}`).join(', ')} — a real account was paid by a test`);
  }
  return strays.map((r) => r.account);
}

module.exports = { parkRealRows, assertNoStrayPayouts, SENTINEL };
