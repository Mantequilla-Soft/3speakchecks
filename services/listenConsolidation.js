/**
 * Listen-log consolidation worker.
 *
 * `audio-listen-log` accumulates one row per credited listen forever, which is
 * great for reporting but unbounded. After LISTEN_CONSOLIDATE_MONTHS (default
 * 5) a listen's detail is no longer needed, so this job:
 *   1. counts the soon-to-be-removed rows per track,
 *   2. folds those counts into the track's `embed-audio` doc
 *      (`archivedListens` += total, `archivedPayableListens` += payable), so
 *      the lifetime total survives the row deletion,
 *   3. deletes the rows.
 *
 * Money-safety: a row is consolidated only when it's safe to drop — either
 * explicitly anonymous (`payable: false`) or already settled (`paid: true`).
 * Payable-but-unpaid rows (e.g. from a long payout dry-run, or legacy rows that
 * predate the `payable` field) are RETAINED so a future payout can still pay
 * them. With live weekly payouts this leaves nothing behind in practice.
 *
 * Scheduling mirrors audioPayouts: a check every LISTEN_CONSOLIDATE_CHECK_HOURS
 * (default 24h), first run 1min after boot. Set LISTEN_CONSOLIDATE_DRY_RUN=true
 * to log the plan without deleting anything.
 */

const { getDb } = require('../utils/db');
const { countedElsewhere } = require('../utils/audioPlays');

const LISTEN_LOG_COLLECTION = 'audio-listen-log';
const AUDIO_COLLECTION = 'embed-audio';

const MONTHS = Math.max(1, parseInt(process.env.LISTEN_CONSOLIDATE_MONTHS, 10) || 5);
const CHECK_HOURS = Math.max(1, parseFloat(process.env.LISTEN_CONSOLIDATE_CHECK_HOURS || '24'));
const CHECK_MS = CHECK_HOURS * 60 * 60 * 1000;
const BATCH = Math.max(100, parseInt(process.env.LISTEN_CONSOLIDATE_BATCH, 10) || 1000);
const DRY_RUN = process.env.LISTEN_CONSOLIDATE_DRY_RUN === 'true';

// Rows older than this are eligible. Only drop ones that are safe to drop —
// anonymous (never payable) or already paid out.
function buildFilter(now) {
    const cutoff = new Date(now);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - MONTHS);
    return {
        cutoff,
        query: {
            createdAt: { $lt: cutoff },
            $or: [{ paid: true }, { payable: false }],
        },
    };
}

async function runConsolidation(now = new Date()) {
    const db = getDb();
    if (!db) return;
    const log = db.collection(LISTEN_LOG_COLLECTION);
    const audio = db.collection(AUDIO_COLLECTION);
    const { cutoff, query } = buildFilter(now);
    const tag = cutoff.toISOString().slice(0, 10);

    if (DRY_RUN) {
        const plan = await log.aggregate([
            { $match: query },
            { $group: {
                _id: '$permlink',
                total: { $sum: 1 },
                payable: { $sum: { $cond: [{ $eq: ['$payable', true] }, 1, 0] } },
            } },
        ]).toArray();
        const rows = plan.reduce((s, p) => s + p.total, 0);
        console.log(`[listenConsolidate] DRY RUN: ${rows} rows across ${plan.length} tracks older than ${tag} (${MONTHS}mo) would be folded into embed-audio + deleted.`);
        return;
    }

    let totalRows = 0;
    let totalTracks = 0;
    let orphanTracks = 0;

    // Batched: count → fold into embed-audio → delete, repeating until the
    // eligible set is empty. Crash between fold and delete at worst re-counts
    // one batch on the next run (bounded over-count of an archival stat).
    // eslint-disable-next-line no-constant-condition
    while (true) {
        // eslint-disable-next-line no-await-in-loop
        const batch = await log.find(query).project({ _id: 1, permlink: 1, payable: 1, ppl: 1, createdAt: 1 }).limit(BATCH).toArray();
        if (batch.length === 0) break;

        const perTrack = new Map();
        for (const r of batch) {
            const t = perTrack.get(r.permlink) || { total: 0, payable: 0 };
            // A listen also kept as a listening session is already in the
            // play count (utils/audioPlays.js): not archived a second time.
            if (!countedElsewhere(r)) t.total += 1;
            if (r.payable === true) t.payable += 1;
            perTrack.set(r.permlink, t);
        }

        const ops = [...perTrack].map(([permlink, c]) => ({
            updateOne: {
                filter: { permlink },
                update: {
                    $inc: { archivedListens: c.total, archivedPayableListens: c.payable },
                    $set: { listensConsolidatedAt: now },
                },
            },
        }));
        // eslint-disable-next-line no-await-in-loop
        const res = await audio.bulkWrite(ops, { ordered: false });
        // Rows whose track no longer exists can't be folded anywhere — they're
        // still deleted (the track is gone), just counted for the log.
        orphanTracks += perTrack.size - (res.matchedCount || 0);

        // eslint-disable-next-line no-await-in-loop
        await log.deleteMany({ _id: { $in: batch.map((r) => r._id) } });

        totalRows += batch.length;
        totalTracks += perTrack.size; // upper bound (a track can span batches)
    }

    if (totalRows > 0) {
        console.log(
            `[listenConsolidate] ${tag}: folded ${totalRows} listen rows older than ${MONTHS}mo into embed-audio and removed them` +
            (orphanTracks > 0 ? `; ${orphanTracks} batch-group(s) had no matching track doc` : ''),
        );
    }
}

/** Wire into server boot. */
function schedule() {
    const mode = DRY_RUN ? 'DRY RUN' : 'ACTIVE';
    console.log(
        `[listenConsolidate] scheduled — consolidating audio-listen-log rows older than ${MONTHS} months, ` +
        `checking every ${CHECK_HOURS}h [${mode}] (first check in 1min)`,
    );
    setTimeout(() => {
        runConsolidation().catch((err) => console.error('[listenConsolidate] tick error:', err));
        setInterval(() => {
            runConsolidation().catch((err) => console.error('[listenConsolidate] tick error:', err));
        }, CHECK_MS);
    }, 60 * 1000);
}

module.exports = { schedule, runConsolidation };
