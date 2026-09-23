const { getDb } = require('../utils/db');
const { hiveRpcBatch } = require('../utils/hive');
const {
    ENABLE_MONGO_WRITES,
    VIDEO_HIVE_SYNC_BATCH,
    VIDEO_HIVE_SYNC_OWNERS_PER_RUN,
    VIDEO_HIVE_SYNC_FRESH_DAYS,
    VIDEO_HIVE_SYNC_FRESH_RECHECK_MIN,
    VIDEO_HIVE_SYNC_RECHECK_DAYS,
    VIDEO_HIVE_SYNC_VERIFY_BATCH,
    VIDEO_HIVE_SYNC_VERIFY_DAYS,
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
//
// Third path, added 2026-09-23: VERIFY the links that already exist. A link that
// was right when it was written still rots when the post is deleted, and the two
// paths above only ever look at rows with NO link, so a rotted one was never
// revisited. That is not theoretical: a client that publishes a snap twice and
// then drops one leaves the doc pointing at the deleted twin, which is exactly
// what happened to rachaeldwatson/mlh6no57 (two snaps three seconds apart,
// ...-592 deleted, ...-397 live with five replies on it). Downstream the short
// then takes no comments and no votes, and the shorts panel simply looks broken.
// Measured the same day: ~0.5% of linked published docs (roughly 45 rows) point
// at a deleted post, and none of them were written by this worker.

const RPC_BATCH = 20;
// Bitmask for filtering account_history to comment_operation (op id 1) = 1 << 1.
// hivemind's bridge.get_account_posts drops peak.snaps replies as snap noise, and
// snap-style shorts are exactly that, so the raw ops are the only way to see them.
const COMMENT_OP_FILTER_LOW = 2;
const HISTORY_OPS = 100;
// The repair path walks much deeper: it runs only for a doc whose link is already
// known to be dead (rare), and the post it is looking for can be days old. 100 ops
// covers less than two days for a chatty account -- rachaeldwatson's snap sat at
// depth ~200, so the shallow budget would have declared it unrecoverable.
const REPAIR_HISTORY_OPS = 1000;
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

// A link that was checked and still resolves. Only the stamp moves, so the pass
// paces itself off `hive_link_verified_at` instead of re-reading the chain for
// every linked doc on every run.
function verifiedOp(doc) {
    return {
        updateOne: {
            filter: { _id: doc._id },
            update: { $set: { hive_link_verified_at: new Date() } },
        },
    };
}

// Repoint a doc whose linked post is gone at the live one. The filter re-asserts
// the dead permlink so a concurrent write elsewhere wins instead of being
// clobbered. hive_title/hive_body/hive_tags keep metadataFill's "only where
// empty" rule: a duplicate twin carries the same text anyway, and overwriting
// would throw away a title somebody curated by hand.
function repairOp(doc, post) {
    return {
        updateOne: {
            filter: { _id: doc._id, hive_permlink: doc.hive_permlink },
            update: {
                $set: {
                    hive_author: post.author,
                    hive_permlink: post.permlink,
                    embed_url: `@${post.author}/${post.permlink}`,
                    hive_link_synced_at: new Date(),
                    hive_link_verified_at: new Date(),
                    hive_link_repaired_at: new Date(),
                    ...metadataFill(doc, post),
                },
            },
        },
    };
}

// The linked post is gone and nothing live references the asset. The dead link is
// LEFT IN PLACE on purpose: nulling it would hand the doc straight back to path 1,
// which reads the equally dead embed_url, and other collections join on the pair.
// The stamp is what lets a human (or a query) find these.
function deadOp(doc) {
    return {
        updateOne: {
            filter: { _id: doc._id },
            update: { $set: { hive_link_verified_at: new Date(), hive_link_dead_at: new Date() } },
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
async function getRecentComments(account, depth = HISTORY_OPS) {
    const [res] = await hiveRpcBatch([{
        jsonrpc: '2.0',
        id: 1,
        method: 'condenser_api.get_account_history',
        params: [account, -1, depth, COMMENT_OP_FILTER_LOW, 0],
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

// Of the owner's comment ops that reference this asset, the newest one that is
// STILL ON CHAIN.
//
// The existence check is the point. account_history keeps the comment op of a post
// that was later deleted, so an op proves only that something was published once —
// matching on ops alone is how a doc ends up linked to a deleted twin, and the
// duplicate-publish case guarantees there are two ops to choose from. Newest first
// because when a client publishes twice it is the first attempt that gets dropped.
async function pickLivePost(posts, assetPermlink, excludePermlink = null) {
    const candidates = [];
    for (let i = posts.length - 1; i >= 0; i -= 1) {   // account_history is oldest-first
        const p = posts[i];
        if (excludePermlink && p.permlink === excludePermlink) continue;
        if (postReferencesAsset(p, assetPermlink)) candidates.push(p);
    }
    if (candidates.length === 0) return null;

    const slice = candidates.slice(0, RPC_BATCH);
    const results = await hiveRpcBatch(slice.map((c, idx) => ({
        jsonrpc: '2.0',
        id: idx,
        method: 'condenser_api.get_content',
        params: [c.author, c.permlink],
    })));
    const live = new Map();
    for (const r of results) {
        if (r?.result?.author) live.set(r.id, r.result);
    }
    for (let idx = 0; idx < slice.length; idx += 1) {
        if (live.has(idx)) return live.get(idx);
    }
    return null;
}

/**
 * Re-check the links that already exist, and repoint the ones that have rotted.
 * @returns {{ checked: number, verified: number, repaired: number, dead: number, errors: number }}
 */
async function verifyLinkedDocs(ev) {
    const out = { checked: 0, verified: 0, repaired: 0, dead: 0, errors: 0 };
    if (!(VIDEO_HIVE_SYNC_VERIFY_BATCH > 0)) return out;

    const staleCutoff = new Date(Date.now() - VIDEO_HIVE_SYNC_VERIFY_DAYS * 24 * 60 * 60 * 1000);
    const docs = await ev.find({
        status: 'published',
        hive_permlink: { $ne: null, $exists: true },
        $or: [
            { hive_link_verified_at: { $exists: false } },
            { hive_link_verified_at: { $lt: staleCutoff } },
        ],
    })
        .project({ owner: 1, permlink: 1, hive_author: 1, hive_permlink: 1, hive_title: 1, hive_body: 1, hive_tags: 1, createdAt: 1 })
        .sort({ createdAt: -1 })   // a fresh rot is the one still worth repairing
        .limit(VIDEO_HIVE_SYNC_VERIFY_BATCH)
        .toArray();

    out.checked = docs.length;
    if (docs.length === 0) return out;

    const ops = [];
    const broken = [];

    for (let i = 0; i < docs.length; i += RPC_BATCH) {
        const slice = docs.slice(i, i + RPC_BATCH);
        let results;
        try {
            results = await hiveRpcBatch(slice.map((d, idx) => ({
                jsonrpc: '2.0',
                id: idx,
                method: 'condenser_api.get_content',
                params: [d.hive_author || d.owner, d.hive_permlink],
            })));
        } catch (err) {
            console.error('[videoHiveSync] verify batch failed:', err.message);
            out.errors++;
            continue;   // unstamped: it comes round again next run
        }
        for (const r of results) {
            const doc = slice[r?.id];
            if (!doc) continue;
            if (r.result && r.result.author) {
                // Still there. A post that no longer MENTIONS the asset is left
                // alone deliberately: postReferencesAsset is a heuristic, and
                // acting on it here would unlink rows that are perfectly fine.
                ops.push(verifiedOp(doc));
                out.verified++;
                continue;
            }
            broken.push(doc);
        }
    }

    // Everything below runs only for a link that is already known to be dead.
    const byOwner = new Map();
    for (const doc of broken) {
        if (!byOwner.has(doc.owner)) byOwner.set(doc.owner, []);
        byOwner.get(doc.owner).push(doc);
    }
    for (const [owner, items] of byOwner) {
        let posts;
        try {
            posts = await getRecentComments(owner, REPAIR_HISTORY_OPS);
        } catch (err) {
            console.error(`[videoHiveSync] repair history walk failed for ${owner}:`, err.message);
            out.errors++;
            continue;   // unstamped on purpose: retry next run rather than call it dead
        }
        for (const doc of items) {
            let live = null;
            try {
                live = await pickLivePost(posts, doc.permlink, doc.hive_permlink);
            } catch (err) {
                console.error(`[videoHiveSync] repair lookup failed for ${owner}/${doc.permlink}:`, err.message);
                out.errors++;
                continue;
            }
            if (live) {
                ops.push(repairOp(doc, live));
                out.repaired++;
                console.log(`[videoHiveSync] repaired ${doc.owner}/${doc.permlink}: @${doc.hive_author || doc.owner}/${doc.hive_permlink} is gone -> @${live.author}/${live.permlink}`);
            } else {
                ops.push(deadOp(doc));
                out.dead++;
                console.warn(`[videoHiveSync] dead link ${doc.owner}/${doc.permlink} -> @${doc.hive_author || doc.owner}/${doc.hive_permlink} (no live post references the asset)`);
            }
        }
        await new Promise((r) => setTimeout(r, OWNER_DELAY_MS));
    }

    if (ops.length && ENABLE_MONGO_WRITES) {
        await ev.bulkWrite(ops, { ordered: false });
    }
    return out;
}

/**
 * Run one batch of embed-video -> Hive link resolution.
 * @returns {{ scanned: number, linked: number, missed: number, errors: number, verify: object }}
 */
async function syncVideoHiveLinks() {
    const db = getDb();
    const ev = db.collection('embed-video');
    const now = Date.now();

    // Before spending the run on rows with no link, re-check the ones that have
    // one. The backlog query below can never see a rotted link, because it only
    // selects rows where hive_permlink is null.
    const verify = await verifyLinkedDocs(ev);

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

    if (docs.length === 0) {
        if (verify.checked) {
            console.log(`[videoHiveSync] backlog empty; verified ${verify.checked} existing links, repaired ${verify.repaired}, dead ${verify.dead}, errors ${verify.errors}${ENABLE_MONGO_WRITES ? '' : ' [WRITES DISABLED]'}`);
        }
        return { scanned: 0, linked: 0, missed: 0, errors: verify.errors, verify };
    }

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
                // Not posts.find(): that took the OLDEST matching op and never
                // asked whether the post still exists, so a client that published
                // twice and dropped its first attempt got the doc linked to the
                // deleted one.
                const match = await pickLivePost(posts, doc.permlink);
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

    console.log(`[videoHiveSync] scanned ${docs.length} (${direct.length} by embed_url, ${search.length} by history), linked ${linked}, missed ${missed}, errors ${errors}; verified ${verify.checked} existing (repaired ${verify.repaired}, dead ${verify.dead})${ENABLE_MONGO_WRITES ? '' : ' [WRITES DISABLED]'}`);
    return { scanned: docs.length, linked, missed, errors: errors + verify.errors, verify };
}

module.exports = {
    syncVideoHiveLinks,
    verifyLinkedDocs,
    pickLivePost,
    parseEmbedUrl,
    postReferencesAsset,
};
