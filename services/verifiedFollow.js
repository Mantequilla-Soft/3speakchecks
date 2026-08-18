/**
 * Auto-follow / auto-unfollow sweep for the verified-badge account.
 *
 * Every VERIFIED_FOLLOW_INTERVAL_HOURS we take the list of verified creators
 * from Mongo (`contentcreators.verified === true`), diff it against who the
 * badge account already follows on chain, and reconcile:
 *
 *   verified but not followed   → broadcast a `follow` custom_json
 *   followed but not verified   → broadcast an unfollow  ...but only if we're
 *                                 the ones who followed them (see the ledger).
 *
 * Following is the badge: an account showing up in @badge-181335's following
 * list *is* the "verified" mark on Hive.
 *
 * THE LEDGER, and why unfollow can't just be the inverse of follow:
 * the badge account's following list is not ours alone. @badge-181335 follows
 * ~774 accounts while only ~273 creators are verified, so a naive "unfollow
 * everything unverified" pass would wipe hundreds of follows made by hand or by
 * another bot. So every follow we broadcast is recorded in the
 * `verified-badge-follows` collection, and we only ever unfollow rows we own.
 * Follows made outside this worker are untouchable — except for the adoption
 * pass below.
 *
 * ADOPTION (VERIFIED_FOLLOW_ADOPT_EXISTING, on by default): an account that is
 * already followed AND currently verified is, by the platform's own definition,
 * correctly badged — it is exactly what this worker would have created itself.
 * On each sweep we record those into the ledger so that when they later lose
 * `verified` the badge comes off too. Adoption writes no transaction; it only
 * decides what we're allowed to clean up later. Set it to false to keep the
 * worker strictly to follows it made itself.
 *
 * Source of truth for "already followed" is the chain, not the ledger — the
 * badge account may be followed/unfollowed by hand, and re-reading the chain
 * each run means we never fight a manual edit. The one danger in that is a
 * load-balanced RPC node answering an empty list for an account that does have
 * follows: we'd then re-broadcast hundreds of redundant ops. Hence the
 * empty-list retry in getFollowing() and the abort-on-error below — when in
 * doubt we broadcast nothing and try again next run.
 *
 * Banned, hidden and VERIFIED_FOLLOW_EXCLUDED creators count as unverified in
 * both directions: never followed, and unfollowed if we'd badged them before.
 * The badge is a public endorsement and hidden-creator moderation exists
 * precisely to stop us pointing at them.
 *
 * Gated entirely on env: schedule() is a no-op when VERIFIED_BADGE_ACCOUNT or
 * VERIFIED_BADGE_POSTING_KEY is unset, so a deployment without badge
 * credentials simply doesn't run this.
 */

const { Client, PrivateKey } = require('@hiveio/dhive');
const { HIVE_RPC_ENDPOINTS, ENABLE_MONGO_WRITES } = require('../utils/config');
const { getDb } = require('../utils/db');

const LEDGER = 'verified-badge-follows';

const BADGE_ACCOUNT = (process.env.VERIFIED_BADGE_ACCOUNT || '').trim().toLowerCase();
const BADGE_POSTING_KEY = (process.env.VERIFIED_BADGE_POSTING_KEY || '').trim();

const ENABLED = String(process.env.VERIFIED_FOLLOW_ENABLED ?? 'true').toLowerCase() !== 'false';
const DRY_RUN = String(process.env.VERIFIED_FOLLOW_DRY_RUN || '').toLowerCase() === 'true';
const UNFOLLOW_ENABLED = String(process.env.VERIFIED_UNFOLLOW_ENABLED ?? 'true').toLowerCase() !== 'false';
const ADOPT_EXISTING = String(process.env.VERIFIED_FOLLOW_ADOPT_EXISTING ?? 'true').toLowerCase() !== 'false';

const INTERVAL_HOURS = parseFloat(process.env.VERIFIED_FOLLOW_INTERVAL_HOURS || '6');
const INTERVAL_MS = Math.max(5 * 60_000, INTERVAL_HOURS * 60 * 60 * 1000);
// First run is deliberately later than collectSubs' 5min so two signed-broadcast
// workers don't wake up on the same tick after a restart.
const FIRST_RUN_MS = Math.max(0, parseFloat(process.env.VERIFIED_FOLLOW_FIRST_RUN_MIN || '7')) * 60 * 1000;

// Ceilings per run. The initial sweep (a few hundred creators) drains over
// successive runs instead of one long burst of transactions, and an unexpected
// mass de-verification can only ever cost this many unfollows before someone
// sees it in the journal.
const MAX_PER_RUN = parseInt(process.env.VERIFIED_FOLLOW_MAX_PER_RUN || '50', 10);
const MAX_UNFOLLOW_PER_RUN = parseInt(process.env.VERIFIED_UNFOLLOW_MAX_PER_RUN || '25', 10);
// custom_json ops batched into a single transaction. Follow ops can't fail
// individually on chain (custom_json is accepted whenever the auth is valid),
// so batching costs nothing in isolation and saves RC + block space.
//
// ⚠️ HIVE LIMIT: an account may submit at most 5 custom_json ops PER BLOCK, and
// blocks are 3s. So 5 ops every 3000ms sits exactly on the ceiling and any jitter
// lands two transactions in one block — observed live as
// "already submitted 5 custom json operation(s) this block". The delay is
// deliberately longer than a block to keep a margin. If you raise OPS_PER_TX
// above 5 every single transaction is rejected, no matter the delay.
const OPS_PER_TX = Math.min(5, Math.max(1, parseInt(process.env.VERIFIED_FOLLOW_OPS_PER_TX || '5', 10)));
const TX_DELAY_MS = Math.max(0, parseInt(process.env.VERIFIED_FOLLOW_TX_DELAY_MS || '4500', 10));
// A chunk that trips the per-block limit (or an RPC blip) is retried rather than
// ending the sweep — one collision used to cost the whole remaining batch.
const BROADCAST_ATTEMPTS = Math.max(1, parseInt(process.env.VERIFIED_FOLLOW_BROADCAST_ATTEMPTS || '4', 10));
// Errors worth retrying: the per-block custom_json cap and ordinary transport noise.
// NOT retried: a bad key, or RC exhaustion — those need a human, and hammering
// them just burns the remaining pool.
const TRANSIENT_RE = /custom json operation|this block|timeout|timed out|econnreset|enotfound|socket|network|fetch failed|502|503|504/i;

// Dead-man's switch on the unfollow path. A partial or failed Mongo read that
// returned few/no verified creators would otherwise read as "everyone lost their
// badge" and unfollow the ledger. Below this count we do nothing at all and say
// so loudly — the real number is in the hundreds.
const MIN_EXPECTED_VERIFIED = parseInt(process.env.VERIFIED_FOLLOW_MIN_EXPECTED || '50', 10);

// Never badge these, even when contentcreators says verified. Separate from the
// feed/leaderboard exclusion lists on purpose: this one is a public endorsement,
// so it's a moderation call of its own. Listing someone here also takes an
// existing badge back off them.
const EXCLUDED = new Set(
    (process.env.VERIFIED_FOLLOW_EXCLUDED || '')
        .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
);

const PAGE_SIZE = 1000;
const EMPTY_RETRY_ATTEMPTS = 3;
const EMPTY_RETRY_DELAY_MS = 1500;

let hiveClient = null;
let postingKey = null;
let ledgerIndexed = false;
let running = false;

function getClient() {
    if (hiveClient) return hiveClient;
    // Same filter as collectSubscriptions: the checker's RPC list carries nodes
    // we only want for read-only queries, never for signed broadcasts.
    const nodes = HIVE_RPC_ENDPOINTS.filter((u) => /^https?:\/\//.test(u) && !/testnet/.test(u));
    hiveClient = new Client(nodes.length ? nodes : ['https://api.hive.blog']);
    return hiveClient;
}

function getKey() {
    if (postingKey) return postingKey;
    postingKey = PrivateKey.fromString(BADGE_POSTING_KEY);
    return postingKey;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fetchFollowingPage(account, start) {
    return getClient().call('condenser_api', 'get_following', [account, start, 'blog', PAGE_SIZE]);
}

/**
 * Every account @account follows, as a lowercase Set. Throws on RPC failure —
 * the caller must not broadcast on a partial list.
 */
async function getFollowing(account) {
    // A load-balanced node occasionally answers [] for an account that does have
    // follows. Retry the first page: a genuinely empty account stays empty.
    let page = [];
    for (let attempt = 1; attempt <= EMPTY_RETRY_ATTEMPTS; attempt++) {
        page = (await fetchFollowingPage(account, '')) || [];
        if (page.length > 0) break;
        if (attempt < EMPTY_RETRY_ATTEMPTS) await sleep(EMPTY_RETRY_DELAY_MS);
    }

    const all = new Set();
    let start = '';
    while (page.length > 0) {
        for (const entry of page) all.add(String(entry.following).toLowerCase());
        if (page.length < PAGE_SIZE) break;
        // get_following repeats `start` as the first entry of the next page, so
        // always advance past the last name we saw.
        const next = page[page.length - 1].following;
        if (next === start) break;
        start = next;
        page = (await fetchFollowingPage(account, start)) || [];
    }
    return all;
}

/** Verified creators that should carry the badge, lowercase, deduped. */
async function getVerifiedCreators() {
    // Hardcoded, like the rest of the codebase: config's COLLECTION_NAME is a
    // legacy name that actually resolves to the `videos` collection.
    const rows = await getDb().collection('contentcreators')
        .find(
            { verified: true, banned: { $ne: true }, hidden: { $ne: true } },
            { projection: { username: 1, _id: 0 } },
        )
        .toArray();

    const names = new Set();
    for (const row of rows) {
        const name = String(row.username || '').trim().toLowerCase();
        // Never follow ourselves — Hive rejects a self-follow op.
        if (name && name !== BADGE_ACCOUNT && !EXCLUDED.has(name)) names.add(name);
    }
    return names;
}

function ledgerCollection() {
    return getDb().collection(LEDGER);
}

async function ensureLedgerIndex() {
    if (ledgerIndexed) return;
    try {
        await ledgerCollection().createIndex({ account: 1, username: 1 }, { unique: true, background: true });
    } catch (e) {
        console.warn(`[verifiedFollow] could not ensure ${LEDGER} index: ${e.message}`);
    }
    ledgerIndexed = true;
}

/** Badges we currently hold responsibility for: followed by us, not yet removed. */
async function getOwnedFollows() {
    const rows = await ledgerCollection()
        .find({ account: BADGE_ACCOUNT, unfollowedAt: null }, { projection: { username: 1, _id: 0 } })
        .toArray();
    return new Set(rows.map((r) => String(r.username || '').toLowerCase()));
}

async function recordFollows(usernames, source) {
    if (!ENABLE_MONGO_WRITES || usernames.length === 0) return;
    const now = new Date();
    await ledgerCollection().bulkWrite(
        usernames.map((username) => ({
            updateOne: {
                filter: { account: BADGE_ACCOUNT, username },
                // followedAt on insert only, so an adopt→unfollow→re-follow cycle
                // keeps the original date; unfollowedAt is cleared to re-own the row.
                update: { $set: { unfollowedAt: null, source }, $setOnInsert: { followedAt: now } },
                upsert: true,
            },
        })),
        { ordered: false },
    );
}

async function recordUnfollows(usernames, reason) {
    if (!ENABLE_MONGO_WRITES || usernames.length === 0) return;
    await ledgerCollection().updateMany(
        { account: BADGE_ACCOUNT, username: { $in: usernames } },
        { $set: { unfollowedAt: new Date(), unfollowReason: reason } },
    );
}

function followOp(following, what) {
    return [
        'custom_json',
        {
            required_auths: [],
            required_posting_auths: [BADGE_ACCOUNT],
            id: 'follow',
            // what: ['blog'] = follow, what: [] = unfollow.
            json: JSON.stringify(['follow', { follower: BADGE_ACCOUNT, following, what }]),
        },
    ];
}

/**
 * Broadcast `names` as follow (what=['blog']) or unfollow (what=[]) ops, batched
 * and throttled. Returns the names that actually made it on chain — a failure
 * stops the run and leaves the rest for the next sweep, which is safe because
 * every sweep re-derives its work from the chain.
 */
async function broadcastFollowOps(names, what, verb) {
    const done = [];
    for (let i = 0; i < names.length; i += OPS_PER_TX) {
        const chunk = names.slice(i, i + OPS_PER_TX);
        let sent = false;

        for (let attempt = 1; attempt <= BROADCAST_ATTEMPTS; attempt++) {
            try {
                const result = await getClient().broadcast.sendOperations(
                    chunk.map((name) => followOp(name, what)),
                    getKey(),
                );
                done.push(...chunk);
                sent = true;
                console.log(`[verifiedFollow] ${verb} ${chunk.join(', ')} (tx ${result?.id || 'no id'})`);
                break;
            } catch (err) {
                const msg = err?.message || String(err);
                if (attempt < BROADCAST_ATTEMPTS && TRANSIENT_RE.test(msg)) {
                    // Back off by whole blocks so a per-block collision clears.
                    console.warn(`[verifiedFollow] ${verb} retry ${attempt}/${BROADCAST_ATTEMPTS - 1} for ${chunk[0]}…: ${msg}`);
                    await sleep(3000 * attempt);
                    continue;
                }
                // Out of RC, bad key, or a transient that outlasted our retries.
                console.error(`[verifiedFollow] ${verb} failed for ${chunk.join(', ')}: ${msg}`);
                break;
            }
        }

        // Give up the rest of the batch; the next sweep re-derives it from the chain.
        if (!sent) break;
        if (i + OPS_PER_TX < names.length && TX_DELAY_MS) await sleep(TX_DELAY_MS);
    }
    return done;
}

async function runFollowSweep() {
    if (running) {
        console.log('[verifiedFollow] previous sweep still running — skipping this tick');
        return { skipped: true };
    }
    running = true;
    try {
        await ensureLedgerIndex();
        const verified = await getVerifiedCreators();

        if (verified.size < MIN_EXPECTED_VERIFIED) {
            // Almost certainly a bad read rather than a real collapse. Doing
            // nothing is always recoverable; unfollowing everyone is not.
            console.error(
                `[verifiedFollow] only ${verified.size} verified creator(s) — below the ${MIN_EXPECTED_VERIFIED} sanity floor, skipping sweep entirely`,
            );
            return { error: 'verified set below sanity floor', verified: verified.size };
        }

        let following;
        try {
            following = await getFollowing(BADGE_ACCOUNT);
        } catch (err) {
            // Broadcasting against an unknown following list would re-follow
            // everyone. Bail and retry on the next tick instead.
            console.error(`[verifiedFollow] could not read @${BADGE_ACCOUNT}'s following list — skipping sweep: ${err.message}`);
            return { error: err.message };
        }

        const owned = await getOwnedFollows();

        // Already followed + still verified: correctly badged. Take ownership so a
        // later de-verification can be cleaned up. No transaction, ledger only.
        if (ADOPT_EXISTING) {
            const adopt = [...verified].filter((name) => following.has(name) && !owned.has(name));
            if (adopt.length) {
                if (DRY_RUN) {
                    console.log(`[verifiedFollow] DRY RUN — would adopt ${adopt.length} existing follow(s) into the ledger`);
                } else {
                    await recordFollows(adopt, 'adopted');
                    adopt.forEach((name) => owned.add(name));
                    console.log(`[verifiedFollow] adopted ${adopt.length} existing follow(s) into the ledger`);
                }
            }
        }

        const missing = [...verified].filter((name) => !following.has(name)).sort();
        // Unfollow only what we own AND still actually follow. Anything else in
        // the following list was put there by someone else — not ours to remove.
        const stale = UNFOLLOW_ENABLED
            ? [...owned].filter((name) => following.has(name) && !verified.has(name)).sort()
            : [];
        // Ledger rows for accounts already gone from the following list: someone
        // unfollowed by hand. Close the row instead of broadcasting a no-op.
        const alreadyGone = UNFOLLOW_ENABLED
            ? [...owned].filter((name) => !following.has(name) && !verified.has(name))
            : [];

        console.log(
            `[verifiedFollow] ${verified.size} verified creator(s), @${BADGE_ACCOUNT} follows ${following.size} ` +
            `(${owned.size} ours) → ${missing.length} to follow, ${stale.length} to unfollow`,
        );

        const followBatch = missing.slice(0, MAX_PER_RUN);
        const unfollowBatch = stale.slice(0, MAX_UNFOLLOW_PER_RUN);
        const pending = (missing.length - followBatch.length) + (stale.length - unfollowBatch.length);

        if (DRY_RUN) {
            if (followBatch.length) console.log(`[verifiedFollow] DRY RUN — would follow ${followBatch.length}: ${followBatch.join(', ')}`);
            if (unfollowBatch.length) console.log(`[verifiedFollow] DRY RUN — would unfollow ${unfollowBatch.length}: ${unfollowBatch.join(', ')}`);
            if (alreadyGone.length) console.log(`[verifiedFollow] DRY RUN — would close ${alreadyGone.length} ledger row(s) unfollowed by hand`);
            if (pending) console.log(`[verifiedFollow] DRY RUN — ${pending} more deferred to the next run`);
            return {
                verified: verified.size, followed: 0, unfollowed: 0,
                wouldFollow: followBatch, wouldUnfollow: unfollowBatch, pending, dryRun: true,
            };
        }

        if (alreadyGone.length) {
            await recordUnfollows(alreadyGone, 'manual');
            console.log(`[verifiedFollow] closed ${alreadyGone.length} ledger row(s) unfollowed by hand`);
        }

        const followed = await broadcastFollowOps(followBatch, ['blog'], 'followed');
        await recordFollows(followed, 'auto');

        const unfollowed = await broadcastFollowOps(unfollowBatch, [], 'unfollowed');
        await recordUnfollows(unfollowed, 'unverified');

        const remaining = (missing.length - followed.length) + (stale.length - unfollowed.length);
        console.log(
            `[verifiedFollow] sweep done — followed ${followed.length}, unfollowed ${unfollowed.length}, ${remaining} still pending`,
        );
        return { verified: verified.size, followed: followed.length, unfollowed: unfollowed.length, pending: remaining };
    } finally {
        running = false;
    }
}

/**
 * Wire the worker into the server boot sequence. No-op when env is incomplete,
 * so deployments without badge credentials skip silently.
 */
function schedule() {
    if (!ENABLED) {
        console.log('[verifiedFollow] disabled — VERIFIED_FOLLOW_ENABLED=false');
        return;
    }
    if (!BADGE_ACCOUNT || !BADGE_POSTING_KEY) {
        console.log('[verifiedFollow] disabled — set VERIFIED_BADGE_ACCOUNT and VERIFIED_BADGE_POSTING_KEY to enable.');
        return;
    }

    // Validate the key parses at boot rather than every interval.
    try {
        getKey();
    } catch (err) {
        console.error(`[verifiedFollow] disabled — could not parse VERIFIED_BADGE_POSTING_KEY: ${err.message}`);
        return;
    }

    if (UNFOLLOW_ENABLED && !ENABLE_MONGO_WRITES) {
        // Without ledger writes we can't tell our follows from anyone else's,
        // and unfollowing on a guess is exactly what the ledger exists to prevent.
        console.warn('[verifiedFollow] ENABLE_MONGO_WRITES=false — unfollow is inert (the ledger can\'t be maintained)');
    }

    console.log(
        `[verifiedFollow] scheduled every ${INTERVAL_HOURS}h as @${BADGE_ACCOUNT}` +
        `${DRY_RUN ? ' (DRY RUN)' : ''} — follow max ${MAX_PER_RUN}/run, ` +
        `unfollow ${UNFOLLOW_ENABLED ? `max ${MAX_UNFOLLOW_PER_RUN}/run` : 'off'}, first run in ${FIRST_RUN_MS / 60000}min`,
    );

    setTimeout(() => {
        runFollowSweep().catch((err) => console.error('[verifiedFollow] tick error:', err));
        setInterval(() => {
            runFollowSweep().catch((err) => console.error('[verifiedFollow] tick error:', err));
        }, INTERVAL_MS);
    }, FIRST_RUN_MS);
}

module.exports = { schedule, runFollowSweep, getFollowing, getVerifiedCreators, getOwnedFollows };
