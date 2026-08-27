/**
 * Backfill `embed-video.duration` for videos that were published without one.
 *
 * WHY THEY HAVE NONE: nothing on our side ever measures a video's length. The field
 * is whatever the uploading client put in its tus metadata (embedvideos
 * src/utils/uploadAuth.ts), and the encode-completion path writes manifest_cid and
 * publishes without filling it in — even though the manifest it just produced states
 * the duration outright. An app that does not send it leaves the field null forever.
 *
 * As of 2026-08-25: 1,994 of 8,767 published videos (22.7%). Two populations —
 * everything before March 2026 (~100% missing, 1,191 rows) and a share that has been
 * climbing back since April as third-party and mobile uploaders took more of the
 * volume (3% -> 16%, 803 rows). By app: 3speak-tv 4%, hive-react-kit 0%, ecency 31%,
 * snapie-mobile 49%, snapie 71%.
 *
 * WHAT IT COSTS: an unknown length fails CLOSED in ad serving (routes/adServe.js —
 * "an unknown duration is not evidence of a match"), so every campaign with a length
 * window skips those videos and roughly a quarter of the inventory cannot carry an ad.
 *
 * SOURCE: the video's own HLS manifest, sum of #EXTINF. Authoritative, not an
 * estimate. A manifest we cannot read leaves the doc alone and is reported — a
 * guessed duration is worse than a missing one.
 *
 * This drains the historical backlog in one pass. services/durationSync.js keeps up
 * with new uploads afterwards; both share utils/videoDuration.js.
 *
 * Safe to re-run: a filled doc no longer matches the filter, and the write re-asserts
 * "still unknown" so a concurrent real write is never clobbered.
 *
 * Usage:
 *   node backfill-null-durations.js --dry-run             # report only, no writes
 *   node backfill-null-durations.js --dry-run --limit=50
 *   node backfill-null-durations.js                       # apply
 *   node backfill-null-durations.js --concurrency=6
 */
const path = require('path');
const { MongoClient } = require('mongodb');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { durationFromManifest, UNKNOWN_DURATION } = require('../utils/videoDuration');

const MONGODB_URI = process.env.MONGODB_URI;
const DATABASE_NAME = process.env.DATABASE_NAME || 'threespeak';

const DRY_RUN = process.argv.includes('--dry-run');
const numArg = (name, dflt) => {
    const a = process.argv.find((x) => x.startsWith(`--${name}=`));
    const n = a ? parseInt(a.split('=')[1], 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : dflt;
};
// Low by design. The IPFS gateway is the constraint, and a wide fan-out is what turns
// a cold-cache miss into a run of 500s — the failure that first made this backlog look
// unrecoverable.
const CONCURRENCY = numArg('concurrency', 4);
const LIMIT = numArg('limit', 0);
const BATCH = 100;   // docs held in memory / written at a time

async function pooled(items, limit, fn) {
    const out = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i]);
        }
    }));
    return out;
}

const FILTER = {
    status: 'published',
    manifest_cid: { $nin: [null, ''] },
    $or: UNKNOWN_DURATION,
};

async function run() {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db(DATABASE_NAME);
    const ev = db.collection('embed-video');

    try {
        const totalPublished = await ev.countDocuments({ status: 'published' });
        const totalMissing = await ev.countDocuments(FILTER);
        console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'APPLY'}  concurrency=${CONCURRENCY}${LIMIT ? `  limit=${LIMIT}` : ''}`);
        console.log(`Published videos      : ${totalPublished}`);
        console.log(`Missing a duration    : ${totalMissing} (${(totalMissing * 100 / totalPublished).toFixed(1)}%)`);
        if (!totalMissing) { console.log('Nothing to do.'); return; }

        const target = LIMIT ? Math.min(LIMIT, totalMissing) : totalMissing;
        let seen = 0; let filled = 0; let unreadable = 0;
        const byApp = {};
        const started = Date.now();
        // Newest first so the videos most likely to be watched (and sold against) are
        // repaired first if the run is interrupted.
        const cursor = ev.find(FILTER).project({ owner: 1, permlink: 1, manifest_cid: 1, frontend_app: 1 }).sort({ _id: -1 });

        let batch = [];
        const flush = async () => {
            if (!batch.length) return;
            const secs = await pooled(batch, CONCURRENCY, (d) => durationFromManifest(d.manifest_cid).catch(() => null));
            const ops = [];
            batch.forEach((d, i) => {
                const app = d.frontend_app || 'unknown';
                byApp[app] = byApp[app] || { ok: 0, fail: 0 };
                if (!secs[i]) { unreadable++; byApp[app].fail++; return; }
                filled++; byApp[app].ok++;
                ops.push({
                    updateOne: {
                        // Re-assert "still unknown": a file replacement or a late client
                        // write may have set a real duration since we read the doc.
                        filter: { _id: d._id, $or: UNKNOWN_DURATION },
                        update: {
                            $set: {
                                duration: Math.round(secs[i]),
                                duration_source: 'manifest',
                                duration_backfilled_at: new Date(),
                                duration_sync_checked_at: new Date(),
                            },
                        },
                    },
                });
            });
            if (ops.length && !DRY_RUN) await ev.bulkWrite(ops, { ordered: false });
            const rate = seen / Math.max(1, (Date.now() - started) / 1000);
            const left = Math.max(0, target - seen);
            console.log(`  ${seen}/${target}  recovered ${filled}  unreadable ${unreadable}  (${rate.toFixed(1)}/s, ~${Math.ceil(left / Math.max(rate, 0.01) / 60)}min left)`);
            batch = [];
        };

        for await (const doc of cursor) {
            if (LIMIT && seen >= LIMIT) break;
            batch.push(doc); seen++;
            if (batch.length >= BATCH) await flush();
        }
        await flush();

        console.log(`\nScanned    : ${seen}`);
        console.log(`Recovered  : ${filled}`);
        console.log(`Unreadable : ${unreadable} (left alone, retried by services/durationSync.js)`);
        console.log('\nby uploading app:');
        Object.entries(byApp).sort((a, b) => (b[1].ok + b[1].fail) - (a[1].ok + a[1].fail))
            .forEach(([app, r]) => console.log(`  ${app.padEnd(18)} recovered ${String(r.ok).padStart(5)}  unreadable ${String(r.fail).padStart(4)}`));

        const after = await ev.countDocuments(FILTER);
        console.log(`\nStill missing a duration: ${after} (was ${totalMissing})`);
        if (DRY_RUN) console.log('Dry run only — no writes made. Re-run without --dry-run to apply.');
    } finally {
        await client.close();
    }
}

run().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
