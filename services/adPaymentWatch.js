/**
 * Payment watcher: credits unpaid bookings without waiting for the advertiser.
 *
 * Until this existed a transfer only counted once somebody called claim — the
 * website's wallet flow does that right after the transfer, and "I have sent it"
 * does it by hand. An advertiser who paid from their own wallet and never came
 * back had paid in full and had no flight, with nothing on our side noticing.
 *
 * Every run reads the payment account's NEW transfers once, picks out memos that
 * name a campaign still awaiting payment, and runs the ordinary claim on each
 * (services/adPaymentClaim.js). Same checks, same reservation, same refusal of a
 * payment from the wrong account — so a stray transfer is queued for return here
 * exactly as it would be if the advertiser had pressed the button.
 *
 * Main thread, not a worker thread: claims serialise per campaign through an
 * in-process lock that the claim route shares, and a worker thread would not.
 *
 * Env:
 *   AD_PAYMENT_WATCH_ENABLED        default true
 *   AD_PAYMENT_WATCH_INTERVAL_MIN   default 2
 */
const { getDb } = require('../utils/db');
const { transfersSince } = require('../utils/hive');
const {
  AD_CAMPAIGNS_COLLECTION, AD_PAYMENTS_COLLECTION, AD_PAYMENT_ACCOUNT,
  AD_BOOKING_EXPIRY_DAYS, ADS_STAGE,
} = require('../utils/config');
const { STATES, DAY_MS } = require('../utils/adModel');
const { claimCampaignPayment } = require('./adPaymentClaim');

const ENABLED = String(process.env.AD_PAYMENT_WATCH_ENABLED || 'true').toLowerCase() !== 'false';
const INTERVAL_MIN = Math.max(1, parseInt(process.env.AD_PAYMENT_WATCH_INTERVAL_MIN, 10) || 2);

// Re-read this much before where the last run stopped, for clock skew and for a
// transfer that lands in a block while the previous scan was in flight. Re-reading
// is harmless: a transfer already counted is skipped on its txid.
const OVERLAP_MS = 10 * 60 * 1000;

/* Where the last successful scan reached, in memory only. After a restart the
 * first run reaches back to the oldest unpaid booking instead, bounded by the
 * booking expiry so a long-abandoned booking does not cost a deep history read
 * every boot. A payment older than that can still be claimed by hand. */
let coveredUntilMs = null;
let running = false;

const enabled = () => ENABLED && ADS_STAGE !== 'off';

async function runOnce() {
  if (running) return;
  running = true;
  try {
    const db = getDb();
    const unpaid = await db.collection(AD_CAMPAIGNS_COLLECTION)
      .find({ status: STATES.AWAITING_PAYMENT })
      .project({ _id: 1, memo: 1, createdAt: 1, hiveAccount: 1 })
      .toArray();
    if (!unpaid.length) {
      // Nothing to wait for. Payments that arrive before the next booking cannot
      // be for it, so the window can move up without reading anything.
      coveredUntilMs = Date.now();
      return;
    }

    const scanStartedMs = Date.now();
    let sinceMs;
    if (coveredUntilMs) {
      sinceMs = coveredUntilMs - OVERLAP_MS;
    } else {
      const oldest = Math.min(...unpaid.map((c) => Date.parse(c.createdAt) || scanStartedMs));
      sinceMs = Math.max(oldest - 60 * 60 * 1000, scanStartedMs - (AD_BOOKING_EXPIRY_DAYS + 1) * DAY_MS);
    }
    // A short catch-up window fits in a small page; the first run after boot may not.
    const ops = await transfersSince(AD_PAYMENT_ACCOUNT, sinceMs, { pageSize: coveredUntilMs ? 100 : 1000 });

    const txidsByMemo = new Map();
    for (const entry of ops) {
      const op = entry?.[1]?.op;
      const trxId = entry?.[1]?.trx_id;
      if (!op || op[0] !== 'transfer' || !trxId || op[1].to !== AD_PAYMENT_ACCOUNT) continue;
      const memo = String(op[1].memo || '').trim().toLowerCase();
      if (!memo.startsWith('ad:')) continue;
      if (!txidsByMemo.has(memo)) txidsByMemo.set(memo, []);
      txidsByMemo.get(memo).push(trxId);
    }

    const payments = db.collection(AD_PAYMENTS_COLLECTION);
    let failed = false;
    for (const c of unpaid) {
      const txids = txidsByMemo.get(String(c.memo || `ad:${c._id}`).toLowerCase());
      if (!txids) continue;
      // Only claim for a transfer nobody has counted (or refused) yet, so a booking
      // that is part-paid does not run a claim on every tick.
      const seen = await payments.countDocuments({ trx_id: { $in: txids } });
      if (seen >= txids.length) continue;
      try {
        const result = await claimCampaignPayment(db, c._id, { ops });
        console.log(`[ad-payment-watch] ${c._id} (@${c.hiveAccount}): ${result.body.message || result.body.error}`);
      } catch (e) {
        // One campaign failing must not stop the others, but the window must not
        // move past it either, so the next run tries this one again.
        console.error(`[ad-payment-watch] ${c._id} claim failed:`, e && e.message);
        failed = true;
      }
    }
    if (!failed) coveredUntilMs = scanStartedMs;
  } catch (e) {
    console.error('[ad-payment-watch] run failed:', e && e.message);
  } finally {
    running = false;
  }
}

module.exports = { runOnce, enabled, INTERVAL_MIN };
