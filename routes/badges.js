/**
 * Hive badge accounts.
 *
 * A "badge" on Hive is an ordinary account used as a token of participation:
 * its PROFILE is the badge (name, description, image) and the accounts it
 * FOLLOWS are the people who earned it. Nothing else marks it — there is no
 * badge object on chain. @tibfox's HOD-event-badges bot is one producer of
 * these: it watches VSC badge-NFT transfers and makes the badge account follow
 * each recipient.
 *
 * That makes a badge page the same shape as a community page — an identity plus
 * a feed — with one difference: a community's feed is "posts filed under this
 * category", a badge's is "videos by the people who hold it". We already build
 * exactly that for the follow feed, so the feed here is the same builder with
 * the global fallback switched off (utils/followFeed.js).
 *
 * The DIRECTORY comes from a registry account: one account that follows every
 * badge worth listing. @peakd curates `badge-500500` ("All Qualified PeakD
 * Badges") for peakd.com and it is the de-facto list, so we read it rather than
 * invent a second one. Override with BADGE_REGISTRY_ACCOUNT.
 */
const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');
const { getFollowingList, hiveRpcBatch } = require('../utils/hive');
const { REGISTRY, REGISTRY_ACCOUNT, indexOneBadge } = require('../utils/badgeIndex');
const { buildFollowFeed } = require('../utils/followFeed');
const { feedAgeMatch } = require('../utils/feedAge');
const { unavailableMatch } = require('../utils/unavailable');
const { hiddenFromFeedMatch } = require('../utils/hiddenFromFeed');
const { hiddenListSync } = require('../utils/hiddenCreators');
// Attached to the FEED route only, rather than to the whole /badges mount in
// server.js: the directory and recipient lists are not video lists, and neither
// middleware should ever see them.
const { slimFeed } = require('../utils/slimFeed');
const { videoStatsMiddleware } = require('../services/videoStats');

const DIRECTORY_TTL_MS = 60 * 60 * 1000;   // the registry changes a few times a year
const PROFILE_TTL_MS = 15 * 60 * 1000;
const PROFILE_BATCH = 20;                  // accounts per JSON-RPC batch

// Hive account names: 3-16 chars, segments of a-z0-9- separated by dots.
const ACCOUNT_RE = /^[a-z][a-z0-9-]{1,15}(\.[a-z][a-z0-9-]{1,15})*$/;

const cache = new Map();
function cached(key, ttl) {
    const hit = cache.get(key);
    return hit && Date.now() - hit.ts < ttl ? hit.value : null;
}
function remember(key, value) {
    cache.set(key, { value, ts: Date.now() });
    return value;
}
/** Last good value regardless of age — what we serve when Hive is unreachable. */
function stale(key) {
    const hit = cache.get(key);
    return hit ? hit.value : null;
}

/**
 * Identity + follow counts for many accounts, in batches.
 *
 * Needs BOTH calls, and neither one alone will do:
 *   - `condenser_api.get_accounts` carries the raw profile JSON (and takes a
 *     whole chunk of names in ONE call) but has no follower/following counts.
 *   - `bridge.get_profile` has the counts, but hivemind TRUNCATES the profile
 *     name to 20 characters, so "Hive Open Days - Alicante 2026" comes back as
 *     "Hive Open Days - ..." — the badge's own title, cut in half.
 * So: names and description from the raw account, counts from bridge.
 */
async function getProfiles(accounts) {
    const out = new Map();
    for (let i = 0; i < accounts.length; i += PROFILE_BATCH) {
        const chunk = accounts.slice(i, i + PROFILE_BATCH);
        const batch = [
            { jsonrpc: '2.0', id: 'accounts', method: 'condenser_api.get_accounts', params: [chunk] },
            ...chunk.map((name, n) => ({
                jsonrpc: '2.0', id: `p${n}`, method: 'bridge.get_profile', params: { account: name }
            }))
        ];
        const results = await hiveRpcBatch(batch);

        for (const r of results) {
            if (!r) continue;
            if (r.id === 'accounts' && Array.isArray(r.result)) {
                for (const raw of r.result) {
                    const entry = out.get(raw.name) || {};
                    entry.meta = parseProfileMeta(raw);
                    entry.created = raw.created || null;
                    entry.postCount = typeof raw.post_count === 'number' ? raw.post_count : 0;
                    entry.creator = raw.recovery_account || null;
                    out.set(raw.name, entry);
                }
            } else if (r.result && r.result.name) {
                const entry = out.get(r.result.name) || {};
                entry.stats = r.result.stats || {};
                entry.reputation = typeof r.result.reputation === 'number' ? r.result.reputation : null;
                out.set(r.result.name, entry);
            }
        }
    }
    return out;
}

/** The `profile` object out of an account's metadata, untruncated. */
function parseProfileMeta(raw) {
    for (const field of ['posting_json_metadata', 'json_metadata']) {
        try {
            const parsed = JSON.parse(raw[field] || '{}');
            if (parsed && parsed.profile && Object.keys(parsed.profile).length) return parsed.profile;
        } catch {
            /* a hand-edited account can hold unparseable metadata; try the next */
        }
    }
    return {};
}

/** Merged entry → the badge fields a card needs. */
function shapeBadge(account, entry) {
    const meta = (entry && entry.meta) || {};
    const stats = (entry && entry.stats) || {};
    return {
        account,
        // The badge's own name, not the account id. Falling back to the account
        // keeps a card readable for a badge whose profile was never filled in.
        title: meta.name || account,
        description: meta.about || '',
        image: meta.profile_image || `https://images.hive.blog/u/${account}/avatar`,
        cover: meta.cover_image || '',
        website: meta.website || '',
        location: meta.location || '',
        recipients: typeof stats.following === 'number' ? stats.following : 0,
        subscribers: typeof stats.followers === 'number' ? stats.followers : 0,
        created: (entry && entry.created) || null,
        creator: (entry && entry.creator) || null,
        posts: (entry && entry.postCount) || 0
    };
}

/** The registry's following list = every listed badge. */
async function getRegistryAccounts() {
    const list = await getFollowingList(REGISTRY_ACCOUNT);
    return Array.isArray(list) ? list : [];
}

// Who holds posting authority over which badge.
//
// 🚨 Hive has NO reverse index from an account to the accounts that granted it
// authority, so "which badges may I award?" cannot be asked of the chain. The
// registry directory above does not answer it either: it lists badges @peakd
// has accepted, has no creator field, and a badge made five minutes ago is not
// in it.
//
// This was localStorage first, which meant a badge made on a laptop could not be
// awarded from a phone -- the same per-browser trap that made warm-up sessions
// go stale across devices.
const CREATORS = 'badge-creators';
const BADGE_NAME_RE = /^badge-\d{4,10}$/;


/** Does `creator` hold posting authority over `account`, according to the chain? */
async function verifyBadgeAuthority(creator, account) {
    const results = await hiveRpcBatch([{
        jsonrpc: '2.0', method: 'condenser_api.get_accounts', params: [[account]], id: 1,
    }]);
    const acct = results?.[0]?.result?.[0];
    if (!acct) return false;
    return (acct.posting?.account_auths || []).some(([who]) => who === creator);
}

/**
 * POST /badges/created  { creator, account }
 *
 * Deliberately UNAUTHENTICATED but chain-verified: the row is only a pointer to
 * something already true on Hive, and it is written only if the chain agrees
 * that `creator` really does hold posting authority. So a forged call cannot
 * plant a badge somebody does not control, and the record grants nothing by
 * itself -- every consumer re-checks before offering to award.
 */
router.post('/created', async (req, res) => {
    const creator = String(req.body?.creator || '').trim().toLowerCase();
    const account = String(req.body?.account || '').trim().toLowerCase();
    if (!ACCOUNT_RE.test(creator) || !BADGE_NAME_RE.test(account)) {
        return res.status(400).json({ error: 'Invalid creator or badge account' });
    }
    try {
        if (!await verifyBadgeAuthority(creator, account)) {
            return res.status(403).json({ error: 'That account has not granted you posting authority' });
        }
        await getDb().collection(CREATORS).updateOne(
            { creator, account },
            { $set: { creator, account }, $setOnInsert: { createdAt: new Date() } },
            { upsert: true },
        );
        // Straight into the index, identity and all, so its creator finds it in
        // the directory now rather than after the next hourly pass.
        await indexOneBadge(account, '3speak');
        res.json({ ok: true, creator, account });
    } catch (error) {
        console.error('Error recording badge creator:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /badges/by-creator/:creator — badges this account can award.
 *
 * Mounted ABOVE /:account, or Express matches this path as a badge name.
 * Re-verified against the chain on every read, so authority that has since been
 * removed is not offered and then refused at broadcast.
 */
router.get('/by-creator/:creator', async (req, res) => {
    const creator = String(req.params.creator || '').toLowerCase();
    if (!ACCOUNT_RE.test(creator)) return res.status(400).json({ error: 'Invalid account name' });
    try {
        const rows = await getDb().collection(CREATORS)
            .find({ creator }, { projection: { account: 1 } }).limit(200).toArray();
        const names = rows.map(r => r.account);
        if (!names.length) return res.json({ creator, badges: [] });

        // Two reads on purpose: the authority check needs the raw account object
        // (get_accounts), while the card needs the badge's name, picture and
        // recipient count, which only bridge.get_profile carries -- and that is
        // exactly what getProfiles already assembles for the directory.
        const results = await hiveRpcBatch([{
            jsonrpc: '2.0', method: 'condenser_api.get_accounts', params: [names], id: 1,
        }]);
        const held = (results?.[0]?.result || [])
            .filter(a => (a.posting?.account_auths || []).some(([who]) => who === creator))
            .map(a => a.name);
        if (!held.length) return res.json({ creator, badges: [] });

        const profiles = await getProfiles(held);
        res.json({ creator, badges: held.map(name => shapeBadge(name, profiles.get(name))) });
    } catch (error) {
        console.error('Error listing badges by creator:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /badges — the badge directory, biggest first.
 *
 * One database read. This used to fetch @peakd's follow list and then a profile
 * for every badge on it, on every cache miss, and could only ever show what
 * their team had curated. The index (utils/badgeIndex, refreshed hourly by
 * services/badgeSync) holds our own list with each badge's identity alongside.
 */
router.get('/', async (req, res) => {
    try {
        const rows = await getDb().collection(REGISTRY)
            .find({}, { projection: { _id: 0 } })
            .toArray();

        const badges = rows
            // A badge nobody holds is an empty page, so imported stragglers are
            // dropped — but never the ones made here: a badge minted a minute
            // ago has no recipients BY DEFINITION, and hiding it means whoever
            // just paid 3 HIVE cannot find their own badge.
            .filter(b => (b.recipients || 0) > 0 || b.source === '3speak')
            .map(b => ({
                account: b.account,
                title: b.title || b.account,
                description: b.description || '',
                image: b.image || `https://images.hive.blog/u/${b.account}/avatar`,
                cover: b.cover || '',
                website: b.website || '',
                location: b.location || '',
                recipients: b.recipients || 0,
                subscribers: b.subscribers || 0,
                madeHere: b.source === '3speak',
            }))
            .sort((a, b) => b.recipients - a.recipients);

        res.json({ registry: REGISTRY_ACCOUNT, total: badges.length, badges });
    } catch (error) {
        console.error('Error serving the badge directory:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/** GET /badges/:account — one badge's identity + counts. */
router.get('/:account', async (req, res) => {
    const account = String(req.params.account || '').toLowerCase();
    if (!ACCOUNT_RE.test(account)) return res.status(400).json({ error: 'Invalid account name' });

    const key = `badge:${account}`;
    try {
        const hit = cached(key, PROFILE_TTL_MS);
        if (hit) return res.json({ ...hit, cached: true });

        const profiles = await getProfiles([account]);
        const entry = profiles.get(account);
        if (!entry) return res.status(404).json({ error: 'Account not found' });

        const registry = await getRegistryAccounts().catch(() => []);
        const badge = { ...shapeBadge(account, entry), inRegistry: registry.includes(account) };
        remember(key, badge);
        res.json(badge);
    } catch (error) {
        console.error(`Error fetching badge ${account}:`, error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /badges/:account/recipients — who holds the badge, paginated.
 *
 * Each entry carries how many videos that recipient has ON 3SPEAK, counted with
 * the same visibility rules as the feed. On a video site "34 recipients, 9 of
 * them post here" is the useful shape of that list, and it lets the page put
 * the creators first instead of an alphabetical wall of avatars.
 */
router.get('/:account/recipients', async (req, res) => {
    const account = String(req.params.account || '').toLowerCase();
    if (!ACCOUNT_RE.test(account)) return res.status(400).json({ error: 'Invalid account name' });

    try {
        const db = getDb();
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);

        const all = (await getFollowingList(account)) || [];

        // Video counts for EVERY recipient (two grouped queries, not two per
        // name), so the list can be ordered by them before it is paginated.
        const hidden = hiddenListSync();
        const [legacyCounts, embedCounts] = await Promise.all([
            all.length ? db.collection('videos').aggregate([
                { $match: { owner: { $in: all, $nin: hidden }, status: 'published', ...feedAgeMatch('created'), ...unavailableMatch(), ...hiddenFromFeedMatch() } },
                { $group: { _id: '$owner', n: { $sum: 1 } } }
            ]).toArray() : [],
            all.length ? db.collection('embed-video').aggregate([
                { $match: { hive_author: { $in: all, $nin: hidden }, status: 'published', short: false, listed_on_3speak: true, hive_permlink: { $ne: null }, ...feedAgeMatch('createdAt'), ...unavailableMatch(), ...hiddenFromFeedMatch() } },
                { $group: { _id: '$hive_author', n: { $sum: 1 } } }
            ]).toArray() : []
        ]);
        const counts = new Map();
        for (const row of [...legacyCounts, ...embedCounts]) {
            counts.set(row._id, (counts.get(row._id) || 0) + row.n);
        }

        const ordered = all
            .map(name => ({ account: name, videos: counts.get(name) || 0 }))
            .sort((a, b) => b.videos - a.videos || a.account.localeCompare(b.account));

        const slice = ordered.slice((page - 1) * limit, (page - 1) * limit + limit);

        // Display names only for the slice on screen — one batch, not 34.
        if (slice.length) {
            const profiles = await getProfiles(slice.map(r => r.account)).catch(() => new Map());
            for (const r of slice) {
                const entry = profiles.get(r.account);
                const meta = (entry && entry.meta) || {};
                r.displayName = meta.name || r.account;
                r.image = meta.profile_image || `https://images.hive.blog/u/${r.account}/avatar`;
                r.reputation = entry && typeof entry.reputation === 'number' ? entry.reputation : null;
            }
        }

        res.json({
            account,
            total: ordered.length,
            withVideos: ordered.filter(r => r.videos > 0).length,
            page,
            limit,
            totalPages: Math.ceil(ordered.length / limit),
            recipients: slice
        });
    } catch (error) {
        console.error(`Error fetching recipients for ${account}:`, error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /badges/:account/feed — videos by the badge's recipients.
 *
 * Same builder and same ranking as /feed/:username, with allowFallback off: a
 * badge with no recipients must render "no videos yet", never the whole site.
 */
router.get('/:account/feed', slimFeed, videoStatsMiddleware, async (req, res) => {
    const account = String(req.params.account || '').toLowerCase();
    if (!ACCOUNT_RE.test(account)) return res.status(400).json({ error: 'Invalid account name' });

    try {
        // Newest first: this page is a record of what the badge's holders have
        // published, not a recommendation feed.
        const feed = await buildFollowFeed(req, account, { allowFallback: false, chronological: true });
        res.json({ ...feed, account, recipients: feed.following });
    } catch (error) {
        console.error(`Error fetching badge feed for ${account}:`, error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
