const { getDb } = require('../utils/db');
const { hiveRpcBatch } = require('../utils/hive');
const {
    ENABLE_MONGO_WRITES,
    VIDEO_HIVE_SYNC_BATCH,
    VIDEO_HIVE_SYNC_OWNERS_PER_RUN,
    VIDEO_HIVE_SYNC_FRESH_DAYS,
    VIDEO_HIVE_SYNC_FRESH_RECHECK_MIN,
    VIDEO_HIVE_SYNC_RECHECK_DAYS,
} = require('../utils/config');

// Video → Hive link sync. The embed-video twin of services/audioHiveSync.js.
//
// The external embed indexer is what normally fills hive_author/hive_permlink on
// an embed-video doc, but it never reaches a large share of shorts: measured
// 2026-09-20, 4,053 of 6,598 shorts carry no hive_permlink at all, including 389
// of the 651 posted from 3speak.tv itself in the preceding 30 days.
//
// That pair is the join key for almost everything downstream — thumbnailSync,
// embedCategorySync, commentCounts, pushNotify, discoverWorker and most feed
// filters all require `hive_permlink: {$ne: null}` — and the checker's own write
// routes (/video/thumbnail, /video/listing, /video/nsfw, /videodetails) resolve an
// embed row by {owner, permlink} OR {hive_author, hive_permlink}. A short's own
// permlink is its ASSET id, so a doc with null hive_* matches neither branch.
// Concretely: editing a short's thumbnail from the shorts edit modal broadcasts
// the new image to Hive, then 404s on the Mongo write and is swallowed as a
// console.warn — the card keeps serving the auto-generated first frame, which for
// a clip that fades in is a black image. That is the bug this repairs at source.
//
// Two resolution paths, because the docs split cleanly:
//   1. `embed_url` already holds "@author/permlink" (2,305 of the 4,053) — the
//      answer is in the doc, so it only needs verifying.
//   2. No embed_url (1,748) — walk the owner's recent comment ops for a body that
//      references the asset permlink, exactly as the audio worker does.
//
// Either path VERIFIES before writing: the post must exist, be authored by the
// doc's owner, and actually reference this asset. Trusting embed_url blind would
// let a second post claim an asset it does not own — the same rebind the embed
// service refuses at POST /video/:permlink/hive once a link is already set.
//
// Additive only: never overwrites an existing hive_permlink, and title/body/tags
// are filled only where the doc has none.

const RPC_BATCH = 20;
// Bitmask for filtering account_history to comment_operation (op id 1) = 1 << 1.
// hivemind's bridge.get_account_posts drops peak.snaps replies as snap noise, and
// snap-style shorts are exactly that, so the raw ops are the only way to see them.
const COMMENT_OP_FILTER_LOW = 2;
const HISTORY_OPS = 100;
const OWNER_DELAY_MS = 500;

// "@author/permlink" -> { author, permlink }. Anything else is not a usable link.
function parseEmbedUrl(embedUrl) {
    if (typeof embedUrl !== 'string') return null;
    const m = embedUrl.trim().match(/^@([a-z0-9.-]+)\/([a-z0-9-]{1,256})$/i);
    return m ? { author: m[1], permlink: m[2] } : null;
}

function parseMeta(raw) {
    let meta = raw;
    if (typeof meta === 'string') {
        try { meta = JSON.parse(meta); } catch { return {}; }
    }
    return (meta && typeof meta === 'object') ? meta : {};
}

// Does this post actually publish this asset? The body carries the embed/play URL
// for every posting client we've seen (snapie, snapie-mobile, ecency, 3speak-tv),
// so a substring match on the asset permlink is the reliable signal; the metadata
// check is a second chance for a client that only references it structurally.
// `video.info.permlink` is checked explicitly because that is where the full
// uploader puts it, even though shorts do not use that shape.
function postReferencesAsset(post, assetPermlink) {
    if (!post || !assetPermlink) return false;
    if (typeof post.body === 'string' && post.body.includes(assetPermlink)) return true;
    const meta = parseMeta(post.json_metadata);
    if (meta?.video?.info?.permlink === assetPermlink) return true;
    try {
        return JSON.stringify(meta).includes(assetPermlink);
    } catch {
        return false;
    }
}

// Fields to copy off the verified post, minus anything the doc already has. Tags
// are left to tagSync to lowercase — it watches this collection for hive_tags
// changes, so writing hive_tags_lower here would race it.
function metadataFill(doc, post) {
    const set = {};
    const meta = parseMeta(post.json_metadata);
    if (!doc.hive_title && typeof post.title === 'string' && post.title) set.hive_title = post.title;
    if (!doc.hive_body && typeof post.body === 'string' && post.body) set.hive_body = post.body;
    if (!Array.isArray(doc.hive_tags) || doc.hive_tags.length === 0) {
        const tags = Array.isArray(meta.tags) ? meta.tags.filter((t) => typeof t === 'string') : [];
        if (tags.length) set.hive_tags = tags;
    }
    return set;
}

// The link write, with the "still unlinked" condition re-asserted at write time —
// the upstream indexer may have got there between our read and this bulkWrite.
function linkOp(doc, post) {
    return {
        updateOne: {
            filter: {
                _id: doc._id,
                $or: [{ hive_permlink: null }, { hive_permlink: { $exists: false } }],
            },
            update: {
                $set: {
                    hive_author: post.author,
                    hive_permlink: post.permlink,
                    embed_url: `@${post.author}/${post.permlink}`,
                    hive_link_synced_at: new Date(),
                    hive_link_checked_at: new Date(),
                    ...metadataFill(doc, post),
                },
            },
        },
    };
}

// Stamp a miss so a doc whose post we cannot find stops being re-fetched every run.
function stampOp(doc) {
    return {
        updateOne: {
            filter: { _id: doc._id },
            update: { $set: { hive_link_checked_at: new Date() } },
        },
    };
}

// The owner's recent comment operations, shaped like posts. Used only for docs
// with no embed_url to go on.
async function getRecentComments(account) {
    const [res] = await hiveRpcBatch([{
        jsonrpc: '2.0',
        id: 1,
        method: 'condenser_api.get_account_history',
        params: [account, -1, HISTORY_OPS, COMMENT_OP_FILTER_LOW, 0],
    }]);
    const ops = Array.isArray(res?.result) ? res.result : [];
    const posts = [];
    const seen = new Set();
    for (const entry of ops) {
        const op = entry?.[1]?.op;
        if (!op || op[0] !== 'comment') continue;
        const c = op[1];
        if (c.author !== account) continue;   // replies BY others on their post
        const key = `${c.author}/${c.permlink}`;
        if (seen.has(key)) continue;
        seen.add(key);
        posts.push(c);
    }
    return posts;
}

/**
 * Run one batch of embed-video -> Hive link resolution.
 * @returns {{ scanned: number, linked: number, missed: number, errors: number }}
 */
async function syncVideoHiveLinks() {
    const db = getDb();
    const ev = db.collection('embed-video');
    const now = Date.now();

    // An asset can legitimately exist before its post does (upload, then publish
    // later), so a miss is not permanent. Recent docs are retried on a short
    // cadence; older ones only occasionally, and both stop being free re-fetches.
    const freshCutoff = new Date(now - VIDEO_HIVE_SYNC_FRESH_DAYS * 24 * 60 * 60 * 1000);
    const retryFresh = new Date(now - VIDEO_HIVE_SYNC_FRESH_RECHECK_MIN * 60 * 1000);
    const retryOld = new Date(now - VIDEO_HIVE_SYNC_RECHECK_DAYS * 24 * 60 * 60 * 1000);

    const docs = await ev.find({
        status: 'published',
        $and: [
            { $or: [{ hive_permlink: null }, { hive_permlink: { $exists: false } }] },
            {
                $or: [
                    { hive_link_checked_at: { $exists: false } },
                    { createdAt: { $gte: freshCutoff }, hive_link_checked_at: { $lt: retryFresh } },
                    { createdAt: { $lt: freshCutoff }, hive_link_checked_at: { $lt: retryOld } },
                ],
            },
        ],
    })
        .project({ owner: 1, permlink: 1, embed_url: 1, hive_title: 1, hive_body: 1, hive_tags: 1, createdAt: 1 })
        .sort({ createdAt: -1 })   // newest first: a just-published short links soonest
        .limit(VIDEO_HIVE_SYNC_BATCH)
        .toArray();

    if (docs.length === 0) return { scanned: 0, linked: 0, missed: 0, errors: 0 };

    const direct = [];   // embed_url tells us which post to verify
    const search = [];   // nothing to go on — walk the owner's history
    for (const doc of docs) {
        const parsed = parseEmbedUrl(doc.embed_url);
        // A cross-owner embed_url is exactly the claim we refuse to honour; send it
        // down the search path so the owner's own history has to confirm it.
        if (parsed && parsed.author === doc.owner) direct.push({ doc, target: parsed });
        else search.push(doc);
    }

    const ops = [];
    let linked = 0;
    let missed = 0;
    let errors = 0;

    // --- Path 1: verify the link the doc already carries ---
    for (let i = 0; i < direct.length; i += RPC_BATCH) {
        const slice = direct.slice(i, i + RPC_BATCH);
        let results;
        try {
            results = await hiveRpcBatch(slice.map((d, idx) => ({
                jsonrpc: '2.0',
                id: idx,
                method: 'condenser_api.get_content',
                params: [d.target.author, d.target.permlink],
            })));
        } catch (err) {
            console.error('[videoHiveSync] get_content batch failed:', err.message);
            errors++;
            continue;
        }
        for (const r of results) {
            const entry = slice[r?.id];
            if (!entry) continue;
            const post = r.result;
            // No post there: either the asset was uploaded and never published, or
            // the node is lagging. Stamp it so it retries on the normal cadence.
            // Leaving it unstamped (as thumbnailSync does, where the post is known
            // to exist) would re-fetch it every run forever — and "uploaded, never
            // posted" is a common state here, so those would crowd out real work.
            if (!post || !post.author) {
                ops.push(stampOp(entry.doc));
                missed++;
                continue;
            }
            if (post.author !== entry.doc.owner || !postReferencesAsset(post, entry.doc.permlink)) {
                console.warn(`[videoHiveSync] refused ${entry.doc.owner}/${entry.doc.permlink} -> @${post.author}/${post.permlink} (post does not reference the asset)`);
                ops.push(stampOp(entry.doc));
                missed++;
                continue;
            }
            ops.push(linkOp(entry.doc, post));
            linked++;
        }
    }

    // --- Path 2: find the post by walking the owner's recent comments ---
    const byOwner = new Map();
    for (const doc of search) {
        if (!byOwner.has(doc.owner)) byOwner.set(doc.owner, []);
        byOwner.get(doc.owner).push(doc);
    }
    let ownersDone = 0;
    for (const [owner, items] of byOwner) {
        if (ownersDone >= VIDEO_HIVE_SYNC_OWNERS_PER_RUN) break;
        ownersDone++;
        try {
            const posts = await getRecentComments(owner);
            for (const doc of items) {
                const match = posts.find((p) => postReferencesAsset(p, doc.permlink));
                if (match) {
                    ops.push(linkOp(doc, match));
                    linked++;
                } else {
                    ops.push(stampOp(doc));
                    missed++;
                }
            }
        } catch (err) {
            console.error(`[videoHiveSync] history walk failed for ${owner}:`, err.message);
            errors++;
        }
        await new Promise((r) => setTimeout(r, OWNER_DELAY_MS));
    }

    if (ops.length && ENABLE_MONGO_WRITES) {
        await ev.bulkWrite(ops, { ordered: false });
    }

    console.log(`[videoHiveSync] scanned ${docs.length} (${direct.length} by embed_url, ${search.length} by history), linked ${linked}, missed ${missed}, errors ${errors}${ENABLE_MONGO_WRITES ? '' : ' [WRITES DISABLED]'}`);
    return { scanned: docs.length, linked, missed, errors };
}

module.exports = { syncVideoHiveLinks, parseEmbedUrl, postReferencesAsset };
