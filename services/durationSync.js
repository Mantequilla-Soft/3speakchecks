const { getDb } = require('../utils/db');
const { durationFromManifest, UNKNOWN_DURATION } = require('../utils/videoDuration');
const {
    ENABLE_MONGO_WRITES,
    DURATION_SYNC_BATCH,
    DURATION_SYNC_CONCURRENCY,
    DURATION_SYNC_RECHECK_DAYS,
    DURATION_SYNC_FRESH_RECHECK_MIN,
    DURATION_SYNC_FRESH_DAYS,
} = require('../utils/config');

// embed-video.duration is client-supplied at upload and never measured on our side
// — see utils/videoDuration.js for the full picture. Apps that omit it leave the
// field null forever, which is roughly a quarter of the published library.
//
// This worker repairs the ONGOING half of that: a video published without a length
// gets one within a few minutes, from its own manifest. The historical backlog is
// drained separately by scripts/backfill-null-durations.js — this worker would get
// there too, just over days rather than an evening.
//
// The real fix belongs upstream, in the encoder: it produces the manifest, so it
// already knows the answer at the moment it publishes. Until that lands, this is
// the stopgap.
//
// Additive only: never overwrites a duration that is already set.

/** Small pooled map — the IPFS gateway is the constraint, not us. */
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

async function syncDurations() {
    const db = getDb();
    const ev = db.collection('embed-video');
    const now = Date.now();

    // A video whose manifest we cannot read would otherwise be re-fetched every run
    // forever, so every doc we look at gets stamped and then skipped for a while.
    // Recently-published docs retry on a short cadence — a manifest can be moments
    // from being reachable — while older ones get only an occasional recheck.
    const freshCutoff = new Date(now - DURATION_SYNC_FRESH_DAYS * 24 * 60 * 60 * 1000);
    const retryFresh = new Date(now - DURATION_SYNC_FRESH_RECHECK_MIN * 60 * 1000);
    const retryOld = new Date(now - DURATION_SYNC_RECHECK_DAYS * 24 * 60 * 60 * 1000);

    const docs = await ev.find({
        status: 'published',
        manifest_cid: { $nin: [null, ''] },
        $and: [
            { $or: UNKNOWN_DURATION },
            {
                $or: [
                    { duration_sync_checked_at: { $exists: false } },
                    { createdAt: { $gte: freshCutoff }, duration_sync_checked_at: { $lt: retryFresh } },
                    { createdAt: { $lt: freshCutoff }, duration_sync_checked_at: { $lt: retryOld } },
                ],
            },
        ],
    })
        .project({ owner: 1, permlink: 1, manifest_cid: 1 })
        .sort({ createdAt: -1 })   // newest first: a just-published video gets its length soonest
        .limit(DURATION_SYNC_BATCH)
        .toArray();

    if (docs.length === 0) return { scanned: 0, updated: 0, unreadable: 0 };

    const seconds = await pooled(docs, DURATION_SYNC_CONCURRENCY,
        (d) => durationFromManifest(d.manifest_cid).catch(() => null));

    // Fills and misses are written separately so each modifiedCount means exactly
    // one thing — a combined bulkWrite would report the "checked" stamps as repairs.
    const fillOps = [];
    const stampOps = [];
    docs.forEach((d, i) => {
        const secs = seconds[i];
        if (!secs) {
            stampOps.push({ updateOne: { filter: { _id: d._id }, update: { $set: { duration_sync_checked_at: new Date() } } } });
            return;
        }
        fillOps.push({
            updateOne: {
                // Re-assert "still unknown" at write time: a file replacement or a
                // late client write may have set a real duration since we read the doc,
                // and theirs is not ours to overwrite.
                filter: { _id: d._id, $or: UNKNOWN_DURATION },
                update: {
                    $set: {
                        duration: Math.round(secs),
                        // Provenance. The field is otherwise unaudited — anyone looking
                        // at a duration later can tell ours from the uploader's.
                        duration_source: 'manifest',
                        duration_backfilled_at: new Date(),
                        duration_sync_checked_at: new Date(),
                    },
                },
            },
        });
    });

    let updated = 0;
    let unreadable = 0;
    if (ENABLE_MONGO_WRITES) {
        try {
            if (fillOps.length) {
                const res = await ev.bulkWrite(fillOps, { ordered: false });
                updated += res.modifiedCount || 0;
            }
            if (stampOps.length) {
                const res = await ev.bulkWrite(stampOps, { ordered: false });
                unreadable += res.modifiedCount || 0;
            }
        } catch (err) {
            console.error('[durationSync] bulkWrite error:', err.message);
        }
    }

    // Only log when there was something to do — this runs often and an idle
    // "0 updated" line every cycle just buries the useful entries.
    if (updated || unreadable) {
        console.log(`[durationSync] ${docs.length} video(s) checked: ${updated} length(s) recovered, ${unreadable} with no readable manifest`);
    }
    return { scanned: docs.length, updated, unreadable };
}

module.exports = { syncDurations };
