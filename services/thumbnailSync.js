const { getDb } = require('../utils/db');
const { hiveRpcBatch } = require('../utils/hive');
const {
    ENABLE_MONGO_WRITES,
    THUMBNAIL_SYNC_BATCH,
    THUMBNAIL_SYNC_RECHECK_DAYS,
    THUMBNAIL_SYNC_FRESH_RECHECK_MIN,
    THUMBNAIL_SYNC_FRESH_DAYS,
} = require('../utils/config');

// Some publishers (livestream VODs, third-party apps posting through the embed
// API) write the thumbnail into the Hive post's json_metadata but never copy it
// onto the embed-video doc, leaving thumbnail_url null. Feeds read that field and
// fall back to a constructed img.3speak.tv URL which does not resolve, so the card
// renders blank — while the same video shows a thumbnail fine on Hive.
//
// The real fix belongs in the upstream publisher/enricher (main 3Speak backend,
// off-box). Until that lands, this worker repairs the docs from the post itself.
//
// Additive only: never overwrites an existing thumbnail_url.

const RPC_BATCH = 20;

// sourceMap's explicit thumbnail entry is authoritative; image[0] is the fallback
// most posting clients set. Anything that isn't an http(s) URL is ignored.
function pickThumbnail(post) {
    let meta = post && post.json_metadata;
    if (typeof meta === 'string') {
        try { meta = JSON.parse(meta); } catch { return null; }
    }
    if (!meta || typeof meta !== 'object') return null;

    const fromMap = (meta.video?.info?.sourceMap || [])
        .find(s => s && s.type === 'thumbnail')?.url;
    const fromImage = Array.isArray(meta.image)
        ? meta.image[0]
        : (typeof meta.image === 'string' ? meta.image : null);

    const url = fromMap || fromImage || null;
    return typeof url === 'string' && /^https?:\/\//.test(url) ? url : null;
}

async function syncThumbnails() {
    const db = getDb();
    const ev = db.collection('embed-video');
    const now = Date.now();

    // A post whose metadata carries no image at all would otherwise be re-fetched
    // every run forever, so every doc we look at gets stamped and then skipped for
    // a while. Recently-uploaded docs are retried on a short cadence (the enricher
    // may still be catching up); older ones only get an occasional recheck.
    const freshCutoff = new Date(now - THUMBNAIL_SYNC_FRESH_DAYS * 24 * 60 * 60 * 1000);
    const retryFresh = new Date(now - THUMBNAIL_SYNC_FRESH_RECHECK_MIN * 60 * 1000);
    const retryOld = new Date(now - THUMBNAIL_SYNC_RECHECK_DAYS * 24 * 60 * 60 * 1000);

    const docs = await ev.find({
        status: 'published',
        hive_author: { $ne: null },
        hive_permlink: { $ne: null },
        $and: [
            { $or: [{ thumbnail_url: null }, { thumbnail_url: { $exists: false } }, { thumbnail_url: '' }] },
            {
                $or: [
                    { thumbnail_sync_checked_at: { $exists: false } },
                    { createdAt: { $gte: freshCutoff }, thumbnail_sync_checked_at: { $lt: retryFresh } },
                    { createdAt: { $lt: freshCutoff }, thumbnail_sync_checked_at: { $lt: retryOld } },
                ],
            },
        ],
    })
        .project({ hive_author: 1, hive_permlink: 1 })
        .sort({ createdAt: -1 })   // newest first: a just-published video gets its thumbnail soonest
        .limit(THUMBNAIL_SYNC_BATCH)
        .toArray();

    if (docs.length === 0) return { scanned: 0, updated: 0 };

    let updated = 0;
    let noImage = 0;
    let checked = 0;
    for (let i = 0; i < docs.length; i += RPC_BATCH) {
        const slice = docs.slice(i, i + RPC_BATCH);
        const rpcBatch = slice.map((d, idx) => ({
            jsonrpc: '2.0',
            id: idx,
            method: 'condenser_api.get_content',
            params: [d.hive_author, d.hive_permlink],
        }));

        const results = await hiveRpcBatch(rpcBatch);
        // Fills and misses are written separately so each modifiedCount means
        // exactly one thing — a combined bulkWrite would report the "checked"
        // stamps as repaired thumbnails.
        const fillOps = [];
        const stampOps = [];
        for (const r of results) {
            const post = r && r.result;
            if (!post || !post.author) continue;   // missing/deleted post — leave unstamped, retry next run
            checked++;
            const filter = { hive_author: post.author, hive_permlink: post.permlink };
            const thumbnail = pickThumbnail(post);

            if (!thumbnail) {
                // Stamp the miss so we stop re-fetching this post every run.
                stampOps.push({ updateOne: { filter, update: { $set: { thumbnail_sync_checked_at: new Date() } } } });
                continue;
            }
            fillOps.push({
                updateOne: {
                    // Re-assert the "still empty" condition at write time: a real
                    // upload may have set the thumbnail since we read the doc.
                    filter: {
                        ...filter,
                        $or: [{ thumbnail_url: null }, { thumbnail_url: { $exists: false } }, { thumbnail_url: '' }],
                    },
                    update: {
                        $set: {
                            thumbnail_url: thumbnail,
                            thumbnail_backfilled_at: new Date(),
                            thumbnail_sync_checked_at: new Date(),
                        },
                    },
                },
            });
        }

        if (ENABLE_MONGO_WRITES) {
            try {
                if (fillOps.length) {
                    const res = await ev.bulkWrite(fillOps, { ordered: false });
                    updated += res.modifiedCount || 0;
                }
                if (stampOps.length) {
                    const res = await ev.bulkWrite(stampOps, { ordered: false });
                    noImage += res.modifiedCount || 0;
                }
            } catch (err) {
                console.error('[thumbnailSync] bulkWrite error:', err.message);
            }
        }
    }

    // Only log when there was something to do — this runs often and an idle
    // "0 updated" line every cycle just buries the useful entries.
    if (updated || noImage) {
        console.log(`[thumbnailSync] ${checked} post(s) checked: ${updated} thumbnail(s) backfilled, ${noImage} with no image on the post`);
    }
    return { scanned: docs.length, updated, noImage };
}

module.exports = { syncThumbnails, pickThumbnail };
