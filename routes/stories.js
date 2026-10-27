/**
 * Stories: vertical clips that are visible on 3Speak for 24 hours.
 *
 * A story is an ordinary short underneath (an `embed-video` doc with `short: true`
 * and a Hive snap that embeds it). What makes it a story is a flag on the author's
 * own signed post, `json_metadata['3speak'].story === true`, which this router
 * mirrors onto the embed doc:
 *
 *   story: true, story_posted_at, story_expires_at   the 24h window, anchored on
 *                                                     the Hive post's created time
 * While live it is an ordinary short in every shorts feed (with a "Story" badge
 * in the player); once expired, utils/hiddenFromFeed.js drops it from them all.
 *
 * Nobody signs anything extra for this. POST /stories/register only repeats what
 * the author's post already says: it reads the post from Hive, and acts only when
 * the post carries the flag, is the author's, and publishes an asset the author
 * owns. Forging a story means publishing a post as that account.
 *
 * Once `story_expires_at` passes, the embed player swaps the video for an
 * "expired story" placeholder (snapievideoplayer, server.js), and these routes
 * stop listing it.
 *
 * Env (read here, not in utils/config.js):
 *   STORIES_ALLOWED_OWNERS  comma list of who may post stories; EMPTY = everyone.
 *                           Unset = the closed trial (badadib,meno,tibfox). Keep in
 *                           step with storiesEnabledFor() in the frontend config.
 *   STORY_TTL_HOURS         default 24
 */
const express = require('express');
const { getDb } = require('../utils/db');
const { hiveRpcBatch, getFollowingList } = require('../utils/hive');
const { unavailableMatch } = require('../utils/unavailable');
const { nsfwFilterHiveTags, isNsfwAllowed } = require('../utils/filters');
const { hiddenListSync } = require('../utils/hiddenCreators');
const { getUserFilters, applyUserFilters } = require('../utils/userFilters');
const { ENABLE_MONGO_WRITES } = require('../utils/config');
const { postReferencesAsset } = require('../services/videoHiveSync');

const router = express.Router();

const STORIES_ALLOWED_OWNERS = (process.env.STORIES_ALLOWED_OWNERS === undefined
    ? 'badadib,meno,tibfox' : process.env.STORIES_ALLOWED_OWNERS)
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const STORY_TTL_MS = (parseFloat(process.env.STORY_TTL_HOURS) || 24) * 60 * 60 * 1000;

const ACCOUNT_RE = /^[a-z][a-z0-9.-]{2,15}$/;
const PERMLINK_RE = /^[a-z0-9-]{1,255}$/;

const storyAllowedFor = (owner) =>
    STORIES_ALLOWED_OWNERS.length === 0 || STORIES_ALLOWED_OWNERS.includes(owner);

function parseMeta(raw) {
    let meta = raw;
    if (typeof meta === 'string') {
        try { meta = JSON.parse(meta); } catch { return {}; }
    }
    return (meta && typeof meta === 'object') ? meta : {};
}

// Hive dates come without a zone and are UTC.
const hiveDate = (s) => new Date(/Z$|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);

// The hive post a story doc belongs to. register() always writes hive_permlink,
// so the embed_url parse is only for a doc the indexer linked first.
function hivePermlinkOf(doc) {
    if (doc.hive_permlink) return doc.hive_permlink;
    const m = typeof doc.embed_url === 'string' && doc.embed_url.match(/^@[^/]+\/(.+)$/);
    return m ? m[1] : doc.permlink;
}

// ─── Active stories, shared by every reader ─────────────────────────────────
// A 24h window holds a handful of docs, but finding them is a scan of embed-video
// (no index on `story`), so the list is built at most every ACTIVE_TTL_MS per nsfw
// variant and dropped the moment a story is registered.
const ACTIVE_TTL_MS = 30 * 1000;
const activeCache = new Map(); // 'sfw' | 'nsfw' -> { at, docs }

async function activeStories(db, req) {
    const key = isNsfwAllowed(req) ? 'nsfw' : 'sfw';
    const hit = activeCache.get(key);
    if (hit && Date.now() - hit.at < ACTIVE_TTL_MS) return hit.docs;

    const docs = await db.collection('embed-video').find({
        story: true,
        story_expires_at: { $gt: new Date() },
        status: 'published',
        listed_on_3speak: { $ne: false },
        ...unavailableMatch(),
        ...nsfwFilterHiveTags(req),
    }, {
        projection: {
            owner: 1, permlink: 1, hive_permlink: 1, embed_url: 1, thumbnail_url: 1,
            story_posted_at: 1, story_expires_at: 1, createdAt: 1,
        },
    }).sort({ story_posted_at: -1 }).toArray();

    activeCache.set(key, { at: Date.now(), docs });
    return docs;
}

// Drop moderation-hidden creators (live list), expired stories (the cache can be 30s
// old) and the viewer's own dismissals.
//
// HIDDEN_AUTHORS is deliberately NOT applied: it keeps team / test accounts out of
// the public feeds (badadib is on it), and those are exactly the accounts allowed to
// post stories during the trial. Who may post is STORIES_ALLOWED_OWNERS' job.
async function visibleStories(db, req, currentuser) {
    const hidden = new Set(hiddenListSync());
    const now = Date.now();
    let docs = (await activeStories(db, req))
        .filter((d) => !hidden.has(d.owner) && new Date(d.story_expires_at).getTime() > now);
    if (currentuser) {
        const uf = await getUserFilters(db, currentuser);
        docs = applyUserFilters(docs, uf, (d) => ({ owner: d.owner, permlink: hivePermlinkOf(d) }));
    }
    return docs;
}

// Which of these the viewer has already watched, from the same watch_history rows
// the shorts player writes (`user:owner:hivePermlink`).
async function seenSet(db, currentuser, docs) {
    if (!currentuser || docs.length === 0) return new Set();
    const ids = docs.map((d) => `${currentuser}:${d.owner}:${hivePermlinkOf(d)}`);
    const rows = await db.collection('watch_history')
        .find({ _id: { $in: ids } }, { projection: { _id: 1 } }).toArray();
    return new Set(rows.map((r) => r._id));
}

const storyCard = (d, seen) => ({
    owner: d.owner,
    permlink: d.permlink,
    hive_permlink: hivePermlinkOf(d),
    thumbnail_url: d.thumbnail_url || null,
    posted_at: d.story_posted_at,
    expires_at: d.story_expires_at,
    seen,
});

/**
 * GET /stories?currentuser=&nsfw=
 * Creators with a live story, for the row on the home page. Unseen first, then
 * newest. { success, currentUserHasStory, creators: [{ username, story_count,
 * unseen_count, latest_at, latest_expires_at, followed }] }. The row draws its
 * countdown ring from the newest story's latest_at -> latest_expires_at.
 */
router.get('/stories', async (req, res) => {
    try {
        const db = getDb();
        const currentuser = ACCOUNT_RE.test(String(req.query.currentuser || '')) ? req.query.currentuser : null;
        const docs = await visibleStories(db, req, currentuser);
        const [seen, following] = await Promise.all([
            seenSet(db, currentuser, docs),
            currentuser ? getFollowingList(currentuser).catch(() => []) : [],
        ]);
        const followingSet = new Set(following || []);

        const byCreator = new Map();
        for (const d of docs) {
            if (!byCreator.has(d.owner)) {
                byCreator.set(d.owner, {
                    username: d.owner, story_count: 0, unseen_count: 0,
                    // docs are newest first, so the first one per owner is the newest
                    latest_at: d.story_posted_at, latest_expires_at: d.story_expires_at,
                    followed: followingSet.has(d.owner),
                });
            }
            const c = byCreator.get(d.owner);
            c.story_count += 1;
            if (!seen.has(`${currentuser}:${d.owner}:${hivePermlinkOf(d)}`)) c.unseen_count += 1;
        }
        const creators = [...byCreator.values()].sort((a, b) =>
            (b.unseen_count > 0) - (a.unseen_count > 0)
            || new Date(b.latest_at) - new Date(a.latest_at));

        res.json({
            success: true,
            currentUserHasStory: !!currentuser && byCreator.has(currentuser),
            creators: creators.filter((c) => c.username !== currentuser),
        });
    } catch (error) {
        console.error('[stories] list failed:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * GET /stories/following?currentuser=
 * Live stories from the accounts the viewer follows, newest first, each with
 * `seen`. The frontend injects these into its notification list; nothing is
 * written per follower, so a story reaches every follower the moment it is
 * registered and leaves when it expires.
 */
router.get('/stories/following', async (req, res) => {
    try {
        const currentuser = String(req.query.currentuser || '');
        if (!ACCOUNT_RE.test(currentuser)) {
            return res.status(400).json({ success: false, error: 'currentuser required' });
        }
        const db = getDb();
        const [docs, following] = await Promise.all([
            visibleStories(db, req, currentuser),
            getFollowingList(currentuser).catch(() => []),
        ]);
        const followingSet = new Set(following || []);
        const mine = docs.filter((d) => followingSet.has(d.owner));
        const seen = await seenSet(db, currentuser, mine);
        res.set('Cache-Control', 'no-store');
        res.json({
            success: true,
            stories: mine.map((d) => storyCard(d, seen.has(`${currentuser}:${d.owner}:${hivePermlinkOf(d)}`))),
        });
    } catch (error) {
        console.error('[stories] following failed:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * POST /stories/register { author, permlink }   (the HIVE post)
 * Mirrors the post's story flag onto its embed doc. Called by the uploader right
 * after publishing; idempotent, so a retry is harmless.
 */
router.post('/stories/register', express.json({ limit: '4kb' }), async (req, res) => {
    if (!ENABLE_MONGO_WRITES) {
        return res.status(503).json({ success: false, error: 'Writes disabled' });
    }
    const author = String(req.body?.author || '').toLowerCase();
    const permlink = String(req.body?.permlink || '');
    if (!ACCOUNT_RE.test(author) || !PERMLINK_RE.test(permlink)) {
        return res.status(400).json({ success: false, error: 'invalid author or permlink' });
    }
    if (!storyAllowedFor(author)) {
        return res.status(403).json({ success: false, error: 'Stories are not open for this account yet' });
    }

    try {
        const [r] = await hiveRpcBatch([{
            jsonrpc: '2.0', id: 0, method: 'condenser_api.get_content', params: [author, permlink],
        }]);
        const post = r?.result;
        // A just-broadcast post can take a block or two to be readable.
        if (!post?.author) {
            return res.status(404).json({ success: false, error: 'post not found yet', retry: true });
        }
        if (post.author !== author) {
            return res.status(400).json({ success: false, error: 'post author mismatch' });
        }

        const meta = parseMeta(post.json_metadata);
        if (meta?.['3speak']?.story !== true) {
            return res.status(400).json({ success: false, error: 'post is not marked as a story' });
        }
        // The asset the post embeds. It must be the author's own: a story cannot
        // turn somebody else's video into one that expires.
        const info = meta?.video?.info || {};
        const assetPermlink = String(info.permlink || '');
        if (info.author !== author || !PERMLINK_RE.test(assetPermlink) || !postReferencesAsset(post, assetPermlink)) {
            return res.status(400).json({ success: false, error: 'post does not publish one of your videos' });
        }

        const db = getDb();
        const embed = db.collection('embed-video');
        const doc = await embed.findOne({ owner: author, permlink: assetPermlink });
        if (!doc) return res.status(404).json({ success: false, error: 'video not found', retry: true });
        if (doc.short !== true) {
            return res.status(400).json({ success: false, error: 'only vertical shorts can be stories' });
        }

        const postedAt = hiveDate(post.created);
        const expiresAt = new Date(postedAt.getTime() + STORY_TTL_MS);
        const set = {
            story: true,
            story_posted_at: postedAt,
            story_expires_at: expiresAt,
            hive_author: author,
            hive_permlink: post.permlink,
            embed_url: `@${author}/${post.permlink}`,
        };
        // Same fill videoHiveSync does, so the story viewer has a caption at once.
        if (!doc.hive_body && post.body) set.hive_body = post.body;
        if (!Array.isArray(doc.hive_tags) || doc.hive_tags.length === 0) {
            const tags = Array.isArray(meta.tags) ? meta.tags.filter((t) => typeof t === 'string') : [];
            if (tags.length) set.hive_tags = tags;
        }
        await embed.updateOne({ _id: doc._id }, { $set: set });
        activeCache.clear();

        console.log(`[stories] registered ${author}/${assetPermlink} -> @${author}/${post.permlink}, expires ${expiresAt.toISOString()}`);
        res.json({ success: true, story: { owner: author, permlink: assetPermlink, hive_permlink: post.permlink, expires_at: expiresAt } });
    } catch (error) {
        console.error('[stories] register failed:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

module.exports = router;
module.exports.STORY_TTL_MS = STORY_TTL_MS;
