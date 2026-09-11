/**
 * Scheduled posts worker.
 *
 * Posts that users have queued for later are stored in the `scheduled-posts`
 * Mongo collection by routes/scheduledPosts.js. This worker polls the
 * collection every N minutes for posts whose `scheduledOn` is due and whose
 * `status` is "scheduled", then broadcasts them to Hive as the original user
 * — signed with the THREESPEAK account's posting key. For that signature to
 * be accepted, the user must have added `threespeak` to their posting
 * account_auths (the frontend handles that before saving the schedule).
 *
 * Entirely env-gated: schedule() is a no-op if THREESPEAK_POSTING_KEY is
 * missing OR SCHEDULED_POSTS_RUNNER !== 'true'. Only ONE checker instance
 * should run the worker (or jobs get double-broadcast).
 */

const { Client, PrivateKey } = require('@hiveio/dhive');
const { ObjectId } = require('mongodb');
const { getDb } = require('../utils/db');
const { HIVE_RPC_ENDPOINTS } = require('../utils/config');
const { hiveRpcBatch } = require('../utils/hive');

const THREESPEAK_USERNAME = process.env.THREESPEAK_USERNAME || 'threespeak';
const THREESPEAK_POSTING_KEY = process.env.THREESPEAK_POSTING_KEY || '';
const RUNNER_ENABLED = process.env.SCHEDULED_POSTS_RUNNER === 'true';
const INTERVAL_MIN = Math.max(1, parseInt(process.env.SCHEDULED_POSTS_INTERVAL_MIN || '5', 10));
const MAX_ATTEMPTS = 3;
// A doc is only ever left in `status: "processing"` if the worker died between
// claiming it and writing the terminal status — the 2026-09-08 `pkill -f "node
// server.js"` outage was exactly that shape. Anything older than this is treated
// as abandoned and reconciled against the chain. Keep it comfortably above a real
// broadcast + embed-link round trip, or a merely-slow tick gets reaped out from
// under itself.
const STUCK_MIN = Math.max(INTERVAL_MIN * 2, parseInt(process.env.SCHEDULED_POSTS_STUCK_MIN || '15', 10));
const REAP_PER_TICK = 25;
const COLLECTION = 'scheduled-posts';

// Embed service hook — after broadcasting the Hive post, link the embed video
// record so the embed_url / hive_author / hive_permlink point at the new post.
// All env-driven: if either is missing, we skip the link step (broadcast still
// succeeds — the user just gets an embed-video without the hive_* fields set).
const EMBED_API_URL = (process.env.EMBED_API_URL || '').replace(/\/$/, '');
const EMBED_API_KEY = process.env.EMBED_API_KEY || '';

let client;
let postingKey;

function getClient() {
    if (!client) client = new Client(HIVE_RPC_ENDPOINTS);
    return client;
}

function getKey() {
    if (!postingKey) postingKey = PrivateKey.fromString(THREESPEAK_POSTING_KEY);
    return postingKey;
}

/**
 * On-chain authorization check: has `owner` granted @threespeak posting authority?
 * This is what makes app-key auth on the create route safe — a scheduled post can
 * only ever be queued for a user who opted into @threespeak, and the cron can only
 * broadcast on their behalf because of this exact grant.
 */
async function hasThreespeakPostingAuthority(owner) {
    const [account] = await getClient().database.getAccounts([owner]);
    if (!account) return false;
    const posting = account.posting || {};
    const auths = posting.account_auths || [];
    const grant = auths.find(([acc]) => acc === THREESPEAK_USERNAME);
    return !!grant && grant[1] >= (posting.weight_threshold || 1);
}

/**
 * Build the comment + comment_options operations from a stored doc.
 * Returns an array of dhive Operation tuples ready for sendOperations.
 */
function buildOperations(doc) {
    const ops = [];

    ops.push([
        'comment',
        {
            parent_author: doc.parentAuthor || '',
            parent_permlink: doc.parentPermlink || 'hive-181335',
            author: doc.owner,
            permlink: doc.permlink,
            title: doc.title || '',
            body: doc.body || '',
            json_metadata: typeof doc.jsonMetadata === 'string'
                ? doc.jsonMetadata
                : JSON.stringify(doc.jsonMetadata || {}),
        },
    ]);

    // comment_options — beneficiaries + payout shape.
    // payoutOptions: 'default' (50/50 SBD-HP) | 'powerup' (100% HP) | 'decline' (decline payout).
    const payoutOption = (doc.payoutOptions || 'default').toLowerCase();
    const declinePayout = payoutOption === 'decline';
    const percentHbd = payoutOption === 'powerup' ? 0 : 10000; // 0 = 100% HP, 10000 = 50/50 (legacy SBD label)
    const maxAcceptedPayout = declinePayout ? '0.000 HBD' : '1000000.000 HBD';

    const extensions = [];
    const benes = Array.isArray(doc.beneficiaries) ? doc.beneficiaries : [];
    // Skip the beneficiaries extension when declining payout — emitting an empty
    // beneficiaries array against a 0 HBD payout is awkward on-chain.
    if (!declinePayout && benes.length > 0) {
        extensions.push([
            0,
            {
                beneficiaries: benes
                    .filter(b => b && b.account && Number.isFinite(b.weight))
                    .map(b => ({ account: b.account, weight: b.weight })),
            },
        ]);
    }

    ops.push([
        'comment_options',
        {
            author: doc.owner,
            permlink: doc.permlink,
            max_accepted_payout: maxAcceptedPayout,
            percent_hbd: percentHbd,
            allow_votes: true,
            allow_curation_rewards: true,
            extensions,
        },
    ]);

    return ops;
}

async function broadcastPost(doc) {
    const ops = buildOperations(doc);
    return getClient().broadcast.sendOperations(ops, getKey());
}

/**
 * After successfully broadcasting, tell the embed service that the embed
 * video now has a Hive post attached. Non-fatal — if the link fails we log
 * and continue (the broadcast itself is the source of truth).
 *
 * Two-step: first the /hive endpoint sets hive_author/hive_permlink/embed_url
 * + Hive metadata; then the /thumbnail endpoint sets thumbnail_url. The split
 * mirrors how the live upload flow calls these from the frontend — for live
 * uploads the thumbnail endpoint is hit immediately after the image is uploaded,
 * so without the second call here scheduled uploads end up with a null
 * thumbnail_url on the embed-video record (visible as "no thumbnail" on the
 * author's profile, even though the on-chain post has the image).
 */
async function linkEmbedVideoToHivePost(doc) {
    if (!doc.embedPermlink || !EMBED_API_URL || !EMBED_API_KEY) return;

    // 1. /hive — link the broadcast Hive post to the embed-video record.
    try {
        const url = `${EMBED_API_URL}/video/${encodeURIComponent(doc.embedPermlink)}/hive`;
        const body = {
            hive_author: doc.owner,
            hive_permlink: doc.permlink,
            hive_title: doc.title || '',
            hive_body: doc.body || '',
            hive_tags: Array.isArray(doc.tags) ? doc.tags : [],
        };
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': EMBED_API_KEY },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const txt = await res.text().catch(() => '');
            console.warn(`[scheduledPosts] embed-link /hive non-2xx for ${doc.owner}/${doc.permlink}: ${res.status} ${txt}`);
        } else {
            console.log(`[scheduledPosts] linked embed video ${doc.embedPermlink} -> @${doc.owner}/${doc.permlink}`);
        }
    } catch (err) {
        console.warn(`[scheduledPosts] embed-link /hive error for ${doc.owner}/${doc.permlink}:`, err.message || err);
    }

    // 2. /thumbnail — set thumbnail_url so the embed-video record matches what the
    // on-chain post advertises. Skipped silently if the schedule has no thumbnail.
    if (!doc.thumbnail) return;
    try {
        const url = `${EMBED_API_URL}/video/${encodeURIComponent(doc.embedPermlink)}/thumbnail`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': EMBED_API_KEY },
            body: JSON.stringify({ thumbnail_url: doc.thumbnail }),
        });
        if (!res.ok) {
            const txt = await res.text().catch(() => '');
            console.warn(`[scheduledPosts] embed-link /thumbnail non-2xx for ${doc.owner}/${doc.permlink}: ${res.status} ${txt}`);
        } else {
            console.log(`[scheduledPosts] set thumbnail_url for ${doc.embedPermlink}`);
        }
    } catch (err) {
        console.warn(`[scheduledPosts] embed-link /thumbnail error for ${doc.owner}/${doc.permlink}:`, err.message || err);
    }
}

/**
 * Atomically claim a single due post (status: scheduled → processing) and
 * return the original doc. Returns null if nothing to claim. The atomic
 * findOneAndUpdate prevents two ticks (or two replicas) from racing.
 */
async function claimNextDuePost(coll) {
    const now = new Date();
    // Strict claim filter: only ever claim docs that are explicitly status:scheduled,
    // are due (scheduledOn elapsed), still under the attempt cap, AND have non-empty
    // string owner/permlink. The owner/permlink check is defense-in-depth so a
    // malformed doc can never become a broadcast op.
    const res = await coll.findOneAndUpdate(
        {
            status: 'scheduled',
            scheduledOn: { $lte: now },
            attempts: { $lt: MAX_ATTEMPTS },
            owner: { $type: 'string', $ne: '' },
            permlink: { $type: 'string', $ne: '' },
        },
        {
            $set: { status: 'processing', processingStartedAt: now, updatedAt: now },
            $inc: { attempts: 1 },
        },
        { sort: { scheduledOn: 1 }, returnDocument: 'before' },
    );
    return res && (res.value || res); // driver shape varies — handle both
}

/**
 * Sanity-check a claimed doc before we sign anything. If this throws, the doc
 * is marked failed without ever being broadcast — the @threespeak posting key
 * stays unused for malformed entries. Belt-and-braces alongside the strict
 * claim filter.
 */
function validateClaimedDoc(doc) {
    if (!doc || typeof doc !== 'object') throw new Error('claimed doc is not an object');
    if (typeof doc.owner !== 'string' || !doc.owner.trim()) throw new Error('doc.owner missing or empty');
    if (typeof doc.permlink !== 'string' || !doc.permlink.trim()) throw new Error('doc.permlink missing or empty');
    if (doc.status !== 'processing') throw new Error(`doc.status is "${doc.status}", expected "processing"`);
    if (typeof doc.body !== 'string' || !doc.body.trim()) throw new Error('doc.body missing or empty');
    // Title may be empty (Hive allows it for reply-style posts) but must be a string.
    if (doc.title != null && typeof doc.title !== 'string') throw new Error('doc.title must be a string');
}

/**
 * Is this post already on chain? Returns true / false, or **null when we could
 * not tell** (every RPC endpoint down, or a malformed reply).
 *
 * Callers MUST treat null as "leave it alone". Requeueing a post that is in fact
 * live re-broadcasts `comment_options`, which the chain rejects once the post has
 * votes — so a perfectly recoverable doc would burn its attempts and land in
 * `failed` while the post sits published. Failing closed costs one more sweep.
 */
async function isPostOnChain(author, permlink) {
    const [res] = await hiveRpcBatch([{
        jsonrpc: '2.0',
        id: 1,
        method: 'condenser_api.get_content',
        params: [author, permlink],
    }]);
    // hiveRpcBatch returns [] once every endpoint has failed -> genuinely unknown.
    if (!res) return null;

    if (res.error) {
        // A post that was never broadcast comes back as an Assert Exception, NOT
        // as an empty result: {"code":-32602,"data":{"extension":{
        // "assertion_expression":"Post alice/foo does not exist"}}}. Requiring the
        // permlink to appear in the error keeps a generic node complaint (which is
        // NOT evidence of absence) from being read as "safe to rebroadcast".
        const raw = JSON.stringify(res.error);
        if (raw.includes(permlink) && /does not exist/i.test(raw)) return false;
        return null;
    }

    if (!('result' in res)) return null;
    const c = res.result;
    if (c === null) return false;          // some nodes answer a missing post this way
    if (typeof c !== 'object') return null;
    if (typeof c.author !== 'string' || typeof c.permlink !== 'string') return null;
    // Older nodes answer with a zeroed stub (author: ""), so compare identity
    // rather than truthiness.
    return c.author === author && c.permlink === permlink;
}

/**
 * Reclaim posts stranded in `processing`.
 *
 * The happy path always writes a terminal status, so a doc can only sit in
 * `processing` if the process died mid-flight. Nothing used to pick those up:
 * they stayed invisible forever, never retried and never reported.
 *
 * Each stranded doc is reconciled against the chain rather than blindly retried:
 *   on chain      -> the broadcast landed and only the bookkeeping was lost, so
 *                    mark it posted and re-run the embed link (the step most
 *                    likely to have died with the process).
 *   not on chain  -> nothing was published, so requeue it, or fail it once the
 *                    attempt cap is spent.
 *   can't tell    -> leave it exactly as it is and try again next sweep.
 */
async function requeueStuckPosts(coll) {
    const cutoff = Date.now() - STUCK_MIN * 60 * 1000;
    const candidates = await coll.find({ status: 'processing' }).limit(REAP_PER_TICK).toArray();

    for (const doc of candidates) {
        // A real claim always stamps processingStartedAt; fall back to updatedAt,
        // and if a doc somehow carries neither, treat it as stuck rather than
        // leaving it invisible forever.
        const startedAt = doc.processingStartedAt || doc.updatedAt;
        if (startedAt && new Date(startedAt).getTime() > cutoff) continue;

        const onChain = await isPostOnChain(doc.owner, doc.permlink);

        if (onChain === null) {
            console.warn(`[scheduledPosts] stuck ${doc.owner}/${doc.permlink} — could not reach Hive to confirm, leaving it in processing`);
            continue;
        }

        // Every write is guarded on status still being 'processing', so a sweep can
        // never clobber a tick that finished the doc while we were on the network.
        if (onChain) {
            const upd = await coll.updateOne(
                { _id: doc._id, status: 'processing' },
                {
                    $set: {
                        status: 'posted',
                        postedAt: doc.postedAt || new Date(),
                        recoveredAt: new Date(),
                        lastError: null,
                        updatedAt: new Date(),
                    },
                },
            );
            if (upd.modifiedCount) {
                console.log(`[scheduledPosts] recovered ${doc.owner}/${doc.permlink} — already on chain, marked posted`);
                await linkEmbedVideoToHivePost(doc);
            }
            continue;
        }

        // Not on chain, so retrying cannot double-post. `attempts` here is the
        // CURRENT value — this doc came from a plain find(), not from the claim's
        // `before` snapshot, so unlike the broadcast error path it needs no +1.
        const attempts = doc.attempts || 0;
        const exhausted = attempts >= MAX_ATTEMPTS;
        const upd = await coll.updateOne(
            { _id: doc._id, status: 'processing' },
            {
                $set: {
                    status: exhausted ? 'failed' : 'scheduled',
                    lastError: `abandoned in processing for >${STUCK_MIN}min (attempt ${attempts}/${MAX_ATTEMPTS})`,
                    updatedAt: new Date(),
                },
            },
        );
        if (upd.modifiedCount) {
            console.warn(`[scheduledPosts] stuck ${doc.owner}/${doc.permlink} not on chain — ${exhausted ? 'marked failed (attempts exhausted)' : 'requeued'}`);
        }
    }
}

// setInterval does not wait for the previous tick. Without this guard a tick that
// outran INTERVAL_MIN could have its own in-flight doc swept and re-claimed by the
// next one — a double broadcast.
let ticking = false;

async function runOnce() {
    if (!RUNNER_ENABLED || !THREESPEAK_POSTING_KEY) return;
    if (ticking) return;
    ticking = true;
    try {
        await runTick();
    } finally {
        ticking = false;
    }
}

async function runTick() {
    const db = await getDb();
    const coll = db.collection(COLLECTION);

    // Sweep abandoned claims before taking new ones, so a stranded post is retried
    // on the very next tick instead of waiting for a human to notice it.
    try {
        await requeueStuckPosts(coll);
    } catch (err) {
        console.error('[scheduledPosts] stuck-post sweep error:', err.message || err);
    }

    // Process up to N posts per tick so a flood doesn't stall the loop.
    const PER_TICK = 10;
    for (let i = 0; i < PER_TICK; i++) {
        const doc = await claimNextDuePost(coll);
        if (!doc) return;

        // After the atomic claim doc.status is "scheduled" in the snapshot we
        // returned, but in the DB it's now "processing" — re-stamp here so the
        // validator sees the post-claim state, then validate before signing.
        doc.status = 'processing';
        try {
            validateClaimedDoc(doc);
        } catch (validationErr) {
            await coll.updateOne(
                { _id: doc._id },
                {
                    $set: {
                        status: 'failed',
                        lastError: `validation: ${validationErr.message}`,
                        updatedAt: new Date(),
                    },
                },
            );
            console.error(
                `[scheduledPosts] skipped malformed doc ${doc.owner || '?'}/${doc.permlink || '?'} (id=${doc._id}): ${validationErr.message}`,
            );
            continue;
        }

        try {
            const tx = await broadcastPost(doc);
            await coll.updateOne(
                { _id: doc._id },
                {
                    $set: {
                        status: 'posted',
                        postedAt: new Date(),
                        broadcastTxId: tx && tx.id ? tx.id : null,
                        lastError: null,
                        updatedAt: new Date(),
                    },
                },
            );
            console.log(`[scheduledPosts] posted ${doc.owner}/${doc.permlink} (tx=${tx && tx.id})`);
            await linkEmbedVideoToHivePost(doc);
        } catch (err) {
            const attempts = (doc.attempts || 0) + 1; // we already incremented above
            const final = attempts >= MAX_ATTEMPTS;
            await coll.updateOne(
                { _id: doc._id },
                {
                    $set: {
                        status: final ? 'failed' : 'scheduled', // back to scheduled to retry on next tick
                        lastError: err && err.message ? err.message : String(err),
                        updatedAt: new Date(),
                    },
                },
            );
            console.error(
                `[scheduledPosts] broadcast error for ${doc.owner}/${doc.permlink} (attempt ${attempts}/${MAX_ATTEMPTS}):`,
                err.message || err,
            );
        }
    }
}

async function ensureIndexes() {
    const db = await getDb();
    const coll = db.collection(COLLECTION);
    try {
        await coll.createIndex({ owner: 1, status: 1, scheduledOn: 1 }, { name: 'sched_owner_status_date' });
        await coll.createIndex({ status: 1, scheduledOn: 1 }, { name: 'sched_due' });
        await coll.createIndex({ owner: 1, permlink: 1 }, { unique: true, name: 'sched_owner_permlink' });
    } catch (err) {
        console.error('[scheduledPosts] index create error:', err.message || err);
    }
}

function schedule() {
    if (!RUNNER_ENABLED) {
        console.log('[scheduledPosts] runner disabled — set SCHEDULED_POSTS_RUNNER=true to enable.');
        return;
    }
    if (!THREESPEAK_POSTING_KEY) {
        console.log('[scheduledPosts] disabled — THREESPEAK_POSTING_KEY missing.');
        return;
    }
    try {
        getKey(); // surface a bad key at boot, not on first tick.
    } catch (err) {
        console.error('[scheduledPosts] disabled — could not parse THREESPEAK_POSTING_KEY:', err.message);
        return;
    }

    ensureIndexes().catch((err) => console.error('[scheduledPosts] ensureIndexes error:', err));

    console.log(`[scheduledPosts] scheduled every ${INTERVAL_MIN}min as @${THREESPEAK_USERNAME} (first tick in 30s)`);
    setTimeout(() => {
        runOnce().catch((err) => console.error('[scheduledPosts] tick error:', err));
        setInterval(() => {
            runOnce().catch((err) => console.error('[scheduledPosts] tick error:', err));
        }, INTERVAL_MIN * 60 * 1000);
    }, 30 * 1000);
}

module.exports = { schedule, runOnce, COLLECTION, hasThreespeakPostingAuthority, requeueStuckPosts, isPostOnChain };
