const { HIVE_RPC_ENDPOINTS } = require('./config');

// Caches
const rewardCache = new Map();
const REWARD_CACHE_TTL = 15 * 60 * 1000;

const reputationCache = new Map();
const REPUTATION_CACHE_TTL = 8 * 60 * 60 * 1000;

const followerCache = new Map();
const FOLLOWER_CACHE_TTL = 4 * 60 * 60 * 1000;

const followingCache = new Map();
const FOLLOWING_CACHE_TTL = 10 * 60 * 1000;

// Send a batch RPC request, trying each endpoint in order until one succeeds
async function hiveRpcBatch(rpcBatch) {
    for (const endpoint of HIVE_RPC_ENDPOINTS) {
        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(rpcBatch),
                signal: AbortSignal.timeout(10000)
            });
            const results = await response.json();
            return Array.isArray(results) ? results : [results];
        } catch (error) {
            console.error(`Hive RPC failed for ${endpoint}:`, error.message);
        }
    }
    return [];
}

/* Transfers into an account, bounded by DATE rather than by count.
 *
 * 🚨 `get_account_history` is capped at 1000 entries per call by the node — asking
 * for more is not allowed, so a single call can only ever mean "the last 1000",
 * which is a moving window that silently drops the oldest as traffic grows. For the
 * ad payment account that is a real hazard: payouts leave the same account that
 * advertisers pay into, so every creator payout consumes window that an incoming
 * payment needs, and an advertiser who paid and claimed a day later could fall off
 * the end and become unclaimable with their money already sent.
 *
 * So this pages BACKWARDS until it reaches `sinceMs` instead. Each page reports its
 * own lowest index; the next call starts one below it. The walk stops at the first
 * page whose oldest entry predates the cutoff, at the account's first operation, or
 * at `maxPages` — which is a backstop against an unbounded scan, not a limit anyone
 * is expected to reach, because the caller's cutoff should be days rather than years.
 *
 * Returns raw history entries, newest page last, exactly as a single call would.
 */
async function transfersSince(account, sinceMs, { maxPages = 25, pageSize = 1000 } = {}) {
    const out = [];
    let start = -1;
    for (let page = 0; page < maxPages; page += 1) {
        // operation filter (low) for `transfer` (op id 2) = 1<<2 = 4.
        const [hist] = await hiveRpcBatch([{
            jsonrpc: '2.0',
            method: 'condenser_api.get_account_history',
            params: [account, start, pageSize, 4, 0],
            id: 1,
        }]);
        const entries = Array.isArray(hist?.result) ? hist.result : [];
        if (!entries.length) break;
        out.push(...entries);

        // Entries come back ascending by index, so the FIRST is the oldest of the page.
        const lowestIndex = entries[0]?.[0];
        const rawTs = entries[0]?.[1]?.timestamp;
        /* Hive stamps are UTC but carry no zone, and Date.parse would read a bare
         * "2026-09-16T17:30:18" as local time. On a UTC box that happens to agree;
         * anywhere else it silently shifts the cutoff by the offset. */
        const oldestMs = rawTs ? Date.parse(`${rawTs}Z`) : NaN;
        if (Number.isFinite(oldestMs) && oldestMs <= sinceMs) break;
        if (!Number.isFinite(lowestIndex) || lowestIndex <= 0) break;
        start = lowestIndex - 1;
    }
    return out;
}

// Convert raw Hive reputation to human-readable score (e.g., 9999999999999 -> ~69)
function hiveReputationToScore(rawReputation) {
    const rep = parseInt(rawReputation);
    if (isNaN(rep) || rep === 0) return 25;
    const neg = rep < 0;
    const absRep = Math.abs(rep);
    let score = Math.log10(absRep) - 9;
    if (score < 0) score = 0;
    score = score * (neg ? -9 : 9) + 25;
    return Math.round(score * 10) / 10;
}

// Fetch Hive reward + content data for sorting — caches reward, title, body, tags (15min TTL)
async function fetchHiveRewards(authorPerms) {
    const results = new Map();
    const toFetch = [];

    for (const { author, permlink } of authorPerms) {
        const key = `${author}/${permlink}`;
        const cached = rewardCache.get(key);
        if (cached && Date.now() - cached.timestamp < REWARD_CACHE_TTL) {
            results.set(key, { reward: cached.reward, title: cached.title || '', body: cached.body || '', tags: cached.tags || [] });
        } else {
            toFetch.push({ author, permlink, key });
        }
    }

    // Build all batches up front, then fire them in parallel — was sequential
    // (await inside the for-loop), which made the cold-cache trending feed
    // O(N/20) Hive roundtrips instead of one wall-clock roundtrip.
    const batches = [];
    for (let i = 0; i < toFetch.length; i += 20) {
        batches.push({ offset: i, items: toFetch.slice(i, i + 20) });
    }
    await Promise.all(batches.map(async ({ offset, items }) => {
        const rpcBatch = items.map((item, idx) => ({
            jsonrpc: '2.0',
            id: offset + idx,
            method: 'condenser_api.get_content',
            params: [item.author, item.permlink]
        }));

        const resultsArray = await hiveRpcBatch(rpcBatch);

        for (const rpcResult of resultsArray) {
            if (!rpcResult.result) continue;
            const post = rpcResult.result;
            const postKey = `${post.author}/${post.permlink}`;

            const pending = parseFloat(post.pending_payout_value) || 0;
            const paid = parseFloat(post.total_payout_value) || 0;
            const curator = parseFloat(post.curator_payout_value) || 0;
            const reward = pending + paid + curator;

            const title = post.title || '';
            const body = post.body || '';
            let tags = [];
            try {
                const metadata = JSON.parse(post.json_metadata || '{}');
                tags = Array.isArray(metadata.tags) ? metadata.tags : [];
            } catch (e) { /* ignore */ }

            results.set(postKey, { reward, title, body, tags });
            rewardCache.set(postKey, { reward, title, body, tags, timestamp: Date.now() });

            if (!reputationCache.has(post.author) || Date.now() - (reputationCache.get(post.author)?.timestamp || 0) >= REPUTATION_CACHE_TTL) {
                reputationCache.set(post.author, { reputation: hiveReputationToScore(post.author_reputation), timestamp: Date.now() });
            }
        }

        for (const item of items) {
            if (!results.has(item.key)) {
                results.set(item.key, { reward: 0, title: '', body: '', tags: [] });
            }
        }
    }));

    return results;
}

// Card stats (payout / vote count / comment count) — see fetchHiveVideoStats.
const videoStatsCache = new Map();
const VIDEO_STATS_CACHE_TTL = 10 * 60 * 1000;

/**
 * Fetch the three numbers a feed card shows — payout, vote count and comment
 * count — for each post, via batched `bridge.get_post`.
 *
 * Uses bridge (hivemind) rather than condenser_api.get_content because
 * get_content returns the FULL active_votes array — hundreds of voters per post,
 * ~85% of the payload — which we only ever counted. bridge returns the
 * already-computed `payout` (pending while unpaid, final once paid, so no
 * last_payout branching), `stats.total_votes` and `children` directly. Verified
 * to match get_content exactly on payout/votes/comments across a live feed page.
 *
 * A post whose batch failed is ABSENT from the returned map (never zeroed), so a
 * transient RPC error can't overwrite a good stored value with 0.
 */
async function fetchHiveVideoStats(authorPerms, { batchSize = 20, ttl = VIDEO_STATS_CACHE_TTL } = {}) {
    const results = new Map();
    const toFetch = [];

    for (const { author, permlink } of authorPerms) {
        if (!author || !permlink) continue;
        const key = `${author}/${permlink}`;
        const cached = videoStatsCache.get(key);
        if (cached && Date.now() - cached.timestamp < ttl) {
            results.set(key, { reward: cached.reward, votes: cached.votes, comments: cached.comments });
        } else {
            toFetch.push({ author, permlink, key });
        }
    }

    const batches = [];
    for (let i = 0; i < toFetch.length; i += batchSize) {
        batches.push({ offset: i, items: toFetch.slice(i, i + batchSize) });
    }

    await Promise.all(batches.map(async ({ offset, items }) => {
        const rpcBatch = items.map((item, idx) => ({
            jsonrpc: '2.0',
            id: offset + idx,
            method: 'bridge.get_post',
            params: { author: item.author, permlink: item.permlink }
        }));

        const resultsArray = await hiveRpcBatch(rpcBatch);

        for (const rpcResult of resultsArray) {
            const post = rpcResult && rpcResult.result;
            if (!post || !post.author || !post.permlink) continue;
            const row = {
                reward: Math.round((parseFloat(post.payout) || 0) * 1000) / 1000,
                votes: (post.stats && post.stats.total_votes) || 0,
                comments: post.children || 0
            };
            const key = `${post.author}/${post.permlink}`;
            results.set(key, row);
            videoStatsCache.set(key, { ...row, timestamp: Date.now() });
        }
    }));

    return results;
}

// Fetch live display data for the current page (no cache for post-level data)
async function fetchLivePageData(authorPerms) {
    const results = new Map();

    for (let i = 0; i < authorPerms.length; i += 20) {
        const batch = authorPerms.slice(i, i + 20);
        const rpcBatch = batch.map((item, idx) => ({
            jsonrpc: '2.0',
            id: i + idx,
            method: 'condenser_api.get_content',
            params: [item.author, item.permlink]
        }));

        const resultsArray = await hiveRpcBatch(rpcBatch);

        for (const rpcResult of resultsArray) {
            if (!rpcResult.result) continue;
            const post = rpcResult.result;
            const postKey = `${post.author}/${post.permlink}`;

            const pending = parseFloat(post.pending_payout_value) || 0;
            const paid = parseFloat(post.total_payout_value) || 0;
            const curator = parseFloat(post.curator_payout_value) || 0;
            const reward = pending + paid + curator;

            const title = post.title || '';
            const body = post.body || '';
            const votes = post.net_votes || 0;
            const comments = post.children || 0;
            const author_reputation = hiveReputationToScore(post.author_reputation);

            let tags = [];
            try {
                const metadata = JSON.parse(post.json_metadata || '{}');
                tags = Array.isArray(metadata.tags) ? metadata.tags : [];
            } catch (e) { /* ignore */ }

            results.set(postKey, { reward, title, body, tags, votes, comments, author_reputation });

            rewardCache.set(postKey, { reward, title, body, tags, timestamp: Date.now() });
            reputationCache.set(post.author, { reputation: author_reputation, timestamp: Date.now() });
        }

        for (const item of batch) {
            const key = `${item.author}/${item.permlink}`;
            if (!results.has(key)) {
                results.set(key, { reward: 0, title: '', body: '', tags: [], votes: 0, comments: 0, author_reputation: 25 });
            }
        }
    }

    return results;
}

// Fetch follower counts via RPC in batches of 20
async function fetchFollowerCounts(authors) {
    const results = new Map();
    const toFetch = [];

    for (const author of authors) {
        const cached = followerCache.get(author);
        if (cached && Date.now() - cached.timestamp < FOLLOWER_CACHE_TTL) {
            results.set(author, cached.followers);
        } else {
            toFetch.push(author);
        }
    }

    for (let i = 0; i < toFetch.length; i += 20) {
        const batch = toFetch.slice(i, i + 20);
        const rpcBatch = batch.map((author, idx) => ({
            jsonrpc: '2.0',
            id: i + idx,
            method: 'condenser_api.get_follow_count',
            params: [author]
        }));

        const resultsArray = await hiveRpcBatch(rpcBatch);

        for (const rpcResult of resultsArray) {
            if (!rpcResult.result) continue;
            const account = rpcResult.result.account;
            const followers = rpcResult.result.follower_count || 0;
            results.set(account, followers);
            followerCache.set(account, { followers, timestamp: Date.now() });
        }

        for (const author of batch) {
            if (!results.has(author)) {
                results.set(author, 0);
            }
        }
    }

    return results;
}

// Fetch following list from Hive RPC API
async function getFollowingList(username) {
    const cached = followingCache.get(username);
    if (cached && Date.now() - cached.timestamp < FOLLOWING_CACHE_TTL) {
        return cached.following;
    }

    try {
        const following = [];
        let startFollowing = '';
        const batchSize = 1000;

        while (true) {
            const result = await hiveRpcBatch([{
                jsonrpc: '2.0',
                id: 1,
                method: 'condenser_api.get_following',
                params: [username, startFollowing, 'blog', batchSize]
            }]);

            if (!result || result.length === 0 || !result[0].result) break;

            const batch = result[0].result;
            if (batch.length === 0) break;

            for (const entry of batch) {
                if (entry.following === startFollowing) continue;
                following.push(entry.following);
            }

            if (batch.length < batchSize) break;
            startFollowing = batch[batch.length - 1].following;
        }

        if (following.length === 0) {
            console.log(`User ${username} follows nobody or following list is empty`);
            return null;
        }

        followingCache.set(username, { following, timestamp: Date.now() });
        return following;

    } catch (error) {
        console.error(`Error fetching following list for ${username}:`, error.message);
        return null;
    }
}

// Seeded PRNG (mulberry32)
function mulberry32(seed) {
    return function() {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

// Comments posted through the 3Speak frontend set json_metadata.app to '3speak/...'
// (CommentSection.jsx / Short.jsx = '3speak/new-version'); older/other 3Speak surfaces
// use '3speak/...' or 'threespeak'. Match either — these count NATIVE_MULT× (see config).
const NATIVE_COMMENT_APP_RE = /3speak|threespeak/i;
function isNative3SpeakComment(reply) {
    try {
        const md = typeof reply.json_metadata === 'string'
            ? JSON.parse(reply.json_metadata || '{}')
            : (reply.json_metadata || {});
        return NATIVE_COMMENT_APP_RE.test(String(md && md.app || ''));
    } catch { return false; }
}

/**
 * Fetch TOP-LEVEL comment counts for each post via batched
 * condenser_api.get_content_replies (direct replies only — one RPC per post, no
 * recursion). Returns Map "author/permlink" -> { comments, native3Speak }.
 *
 * A post whose batch failed (transient RPC error) is simply ABSENT from the map, so
 * the caller keeps its previous stored value rather than zeroing it. A real post with
 * no comments returns `result: []` → { comments: 0, native3Speak: 0 }.
 */
async function fetchCommentReplyCounts(authorPerms, { batchSize = 20 } = {}) {
    const results = new Map();
    for (let i = 0; i < authorPerms.length; i += batchSize) {
        const batch = authorPerms.slice(i, i + batchSize);
        const rpcBatch = batch.map((it, idx) => ({
            jsonrpc: '2.0', id: i + idx,
            method: 'condenser_api.get_content_replies',
            params: [it.author, it.permlink],
        }));
        const arr = await hiveRpcBatch(rpcBatch);
        for (const r of arr) {
            // JSON-RPC batch responses carry the request id; map back by it (order isn't
            // guaranteed, and a failover can drop entries — those posts stay absent).
            if (!r || !Array.isArray(r.result)) continue;
            const idx = Number(r.id) - i;
            const item = batch[idx];
            if (!item) continue;
            let native = 0;
            for (const rep of r.result) if (isNative3SpeakComment(rep)) native += 1;
            results.set(`${item.author}/${item.permlink}`, { comments: r.result.length, native3Speak: native });
        }
    }
    return results;
}


/* A single (non-batched) JSON-RPC call that actually FAILS OVER.
 *
 * hiveRpcBatch returns whatever the first endpoint answers, and a node that replies
 * `{"error": ...}` with HTTP 200 counts as an answer — fine for the batch callers,
 * which tolerate missing entries, but not here: one endpoint in the default list
 * does exactly that for `bridge.*` (it is not a hivemind node), so without this the
 * comment walk would return nothing and every viewer would silently read as having
 * engaged with no one. See the hivemind-probe trap in the frontend for the same bug
 * in the other direction.
 */
async function hiveRpcCall(method, params) {
    for (const endpoint of HIVE_RPC_ENDPOINTS) {
        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
                signal: AbortSignal.timeout(15000),
            });
            const json = await response.json();
            if (json && json.error) continue;            // node answered, but can't serve this
            if (json && json.result !== undefined) return json.result;
        } catch (error) {
            // Try the next endpoint. A total outage returns null, which every caller
            // treats as "no data", never as "the answer is empty".
        }
    }
    return null;
}

// bridge returns a comment's root post in `url`: "/<category>/@<root_author>/<root_permlink>#@<author>/<permlink>".
// The root author is the CREATOR whose video the conversation hangs under, which is
// what a discovery boost cares about — `parent_author` on a nested reply is just the
// person replied to, who may not have posted anything at all.
const ROOT_FROM_URL = /^\/[^/]+\/@([^/]+)\/([^#?]+)/;

/* Every comment an account wrote since `sinceMs`, newest first.
 *
 * 🚨 `bridge.get_account_posts` caps `limit` at 20 — asking for 100 is an assert
 * failure on the node, not a silent clamp — so 90 days of an active commenter is a
 * short paged walk (measured: 8 pages / 155 comments / ~1.1s for a busy account,
 * 2 pages / 28 comments / ~0.23s for a quiet one). The walk stops at the first
 * comment older than the cutoff, at the end of the account's comments, or at
 * `maxPages`, which is a backstop against an unbounded scan rather than a limit
 * anyone is expected to reach.
 *
 * Each page repeats the item it was anchored on, so the anchor is skipped rather
 * than counted twice.
 *
 * @returns {Promise<Array<{author,permlink,parent_author,root_author,root_permlink,created,depth}>>}
 */
async function fetchAccountComments(account, sinceMs, { maxPages = 30 } = {}) {
    const acct = String(account || '').trim().toLowerCase().replace(/^@/, '');
    if (!acct) return [];

    const out = [];
    let startAuthor = '';
    let startPermlink = '';

    for (let page = 0; page < maxPages; page += 1) {
        const res = await hiveRpcCall('bridge.get_account_posts', {
            sort: 'comments', account: acct, limit: 20,
            start_author: startAuthor, start_permlink: startPermlink,
        });
        if (!Array.isArray(res) || !res.length) break;

        let reachedCutoff = false;
        for (const c of res) {
            if (startAuthor && c.author === startAuthor && c.permlink === startPermlink) continue;
            const created = Date.parse(`${c.created}Z`);
            if (!Number.isFinite(created)) continue;
            if (created < sinceMs) { reachedCutoff = true; break; }
            const m = ROOT_FROM_URL.exec(String(c.url || ''));
            out.push({
                author: c.author,
                permlink: c.permlink,
                parent_author: String(c.parent_author || '').toLowerCase(),
                root_author: m ? m[1].toLowerCase() : String(c.parent_author || '').toLowerCase(),
                root_permlink: m ? m[2] : c.parent_permlink,
                created,
                depth: c.depth,
            });
        }

        const last = res[res.length - 1];
        if (reachedCutoff || res.length < 20 || !last) break;
        startAuthor = last.author;
        startPermlink = last.permlink;
    }

    return out;
}

module.exports = {
    transfersSince,
    hiveRpcCall,
    fetchAccountComments,
    hiveRpcBatch,
    hiveReputationToScore,
    fetchHiveRewards,
    fetchHiveVideoStats,
    fetchLivePageData,
    fetchFollowerCounts,
    fetchCommentReplyCounts,
    isNative3SpeakComment,
    getFollowingList,
    mulberry32,
    reputationCache,
    REPUTATION_CACHE_TTL,
};
