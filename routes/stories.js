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
 * While it is live, the author can keep a story as an ordinary short
 * (POST /stories/keep, signed like the comment pins): `story` turns false,
 * `story_expires_at` goes, `story_kept_at` is stamped. `story_posted_at` stays, so
 * it still counts as a story posted (streaks here, the leaderboard's story_uploads
 * and story_streak, which an external rollup job writes).
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
const { ENABLE_MONGO_WRITES, SIGNATURE_TIMESTAMP_TOLERANCE_MS, AD_SIGNING_DELEGATES } = require('../utils/config');
const { verifyHiveAuthority } = require('../utils/hiveAuth');
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

// ─── Streaks ────────────────────────────────────────────────────────────────
// A creator's streak is the run of consecutive UTC days with at least one story,
// ending today or yesterday: a story yesterday and none yet today keeps it alive
// until midnight UTC. Kept stories count (story_posted_at stays). Built for every
// creator from the last STREAK_LOOKBACK_DAYS at once, so a streak caps there.
const DAY_MS = 24 * 60 * 60 * 1000;
const STREAK_TTL_MS = 5 * 60 * 1000;
const STREAK_LOOKBACK_DAYS = 60;
let streakCache = null; // { at, byOwner: Map(owner -> { streak, postedToday }) }

const utcDay = (d) => Math.floor(new Date(d).getTime() / DAY_MS);

async function streaks(db) {
    if (streakCache && Date.now() - streakCache.at < STREAK_TTL_MS) return streakCache.byOwner;
    const since = new Date(Date.now() - STREAK_LOOKBACK_DAYS * DAY_MS);
    // `$exists` matches the partial index on story_posted_at (utils/db.js).
    const docs = await db.collection('embed-video')
        .find({ story_posted_at: { $exists: true, $gte: since } }, { projection: { owner: 1, story_posted_at: 1 } })
        .toArray();
    const days = new Map();
    for (const d of docs) {
        if (!days.has(d.owner)) days.set(d.owner, new Set());
        days.get(d.owner).add(utcDay(d.story_posted_at));
    }
    const today = utcDay(Date.now());
    const byOwner = new Map();
    for (const [owner, set] of days) {
        let day = set.has(today) ? today : today - 1;
        let streak = 0;
        while (set.has(day)) { streak += 1; day -= 1; }
        if (streak > 0) byOwner.set(owner, { streak, postedToday: set.has(today) });
    }
    streakCache = { at: Date.now(), byOwner };
    return byOwner;
}

const streakOf = (byOwner, owner) => (byOwner.get(owner) || { streak: 0 }).streak;

// Something about a story changed: the row and the streaks rebuild on next read.
function storiesChanged() {
    activeCache.clear();
    streakCache = null;
}

/**
 * GET /stories?currentuser=&nsfw=
 * Creators with a live story, for the row on the home page. Unseen first, then
 * newest. { success, currentUserHasStory, creators: [{ username, story_count,
 * unseen_count, latest_at, latest_expires_at, followed, streak }],
 * currentUserStreak }. The row draws its countdown ring from the newest story's
 * latest_at -> latest_expires_at.
 */
router.get('/stories', async (req, res) => {
    try {
        const db = getDb();
        const currentuser = ACCOUNT_RE.test(String(req.query.currentuser || '')) ? req.query.currentuser : null;
        const docs = await visibleStories(db, req, currentuser);
        const [seen, following, byOwner] = await Promise.all([
            seenSet(db, currentuser, docs),
            currentuser ? getFollowingList(currentuser).catch(() => []) : [],
            streaks(db),
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
                    streak: streakOf(byOwner, d.owner),
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
            ...(currentuser ? { currentUserStreak: streakOf(byOwner, currentuser) } : {}),
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
 * GET /stories/streak/:user
 * { success, streak, postedToday }: the creator's current story streak in days.
 */
router.get('/stories/streak/:user', async (req, res) => {
    const user = String(req.params.user || '').toLowerCase();
    if (!ACCOUNT_RE.test(user)) return res.status(400).json({ success: false, error: 'invalid user' });
    try {
        const s = (await streaks(getDb())).get(user) || { streak: 0, postedToday: false };
        res.json({ success: true, streak: s.streak, postedToday: s.postedToday });
    } catch (error) {
        console.error('[stories] streak failed:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * GET /stories/seen?author=&permlink=   (the HIVE permlink)
 * Who watched a story: { success, count, viewers: [{ username, at }] }, newest first,
 * the author left out, at most SEEN_MAX names (count is all of them). Read from
 * watch_history, which is public already (routes/watchedFeed.js), so this is public
 * too; the frontend only shows it to the author. Viewers with watch history off
 * never appear.
 */
const SEEN_MAX = 200;
const SEEN_SCAN = 2000; // rows read per story; a viewer can have one per permlink
const SEEN_TTL_MS = 30 * 1000;
const seenCache = new Map(); // 'author/permlink' -> { at, payload }

router.get('/stories/seen', async (req, res) => {
    const author = String(req.query.author || '').toLowerCase();
    const permlink = String(req.query.permlink || '');
    if (!ACCOUNT_RE.test(author) || !PERMLINK_RE.test(permlink)) {
        return res.status(400).json({ success: false, error: 'invalid author or permlink' });
    }
    const key = `${author}/${permlink}`;
    const hit = seenCache.get(key);
    if (hit && Date.now() - hit.at < SEEN_TTL_MS) return res.json(hit.payload);

    try {
        const db = getDb();
        const doc = await db.collection('embed-video').findOne(
            { owner: author, $or: [{ hive_permlink: permlink }, { permlink }], story_posted_at: { $exists: true } },
            { projection: { permlink: 1, hive_permlink: 1, embed_url: 1 } },
        );
        if (!doc) return res.status(404).json({ success: false, error: 'story not found' });

        // History rows carry whichever permlink the player had: the Hive one or the
        // asset id. Both are read, and a viewer with both rows counts once.
        const permlinks = [...new Set([hivePermlinkOf(doc), doc.permlink])];
        const rows = await db.collection('watch_history')
            .find({ author, permlink: { $in: permlinks }, username: { $ne: author } },
                { projection: { _id: 0, username: 1, last_watched_at: 1, watched_at: 1 } })
            .sort({ last_watched_at: -1 })
            .limit(SEEN_SCAN)
            .toArray();
        const byUser = new Map();
        for (const r of rows) {
            if (r.username && !byUser.has(r.username)) {
                byUser.set(r.username, { username: r.username, at: r.last_watched_at || r.watched_at || null });
            }
        }
        const payload = { success: true, count: byUser.size, viewers: [...byUser.values()].slice(0, SEEN_MAX) };

        if (seenCache.size >= 500) seenCache.clear();
        seenCache.set(key, { at: Date.now(), payload });
        res.json(payload);
    } catch (error) {
        console.error('[stories] seen failed:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Must match keepMessage() in the frontend (src/lib/stories.js) and the signer in
// its server/index.cjs exactly.
const keepMessage = (author, permlink, timestamp) =>
    ['3speak-stories', 'keep', author, permlink, String(timestamp)].join('|');

/**
 * POST /stories/keep { author, permlink, signature, timestamp }   (the HIVE permlink)
 * The author keeps a live story as an ordinary short. Proof of authorship is the
 * comment pins' shape (routes/commentPins.js): a signature over keepMessage() from
 * the author's posting key or a delegate we sign with (@threespeak). Only a live
 * story can be kept; an expired one is gone from 3Speak already.
 */
router.post('/stories/keep', express.json({ limit: '4kb' }), async (req, res) => {
    if (!ENABLE_MONGO_WRITES) {
        return res.status(503).json({ success: false, error: 'Writes disabled' });
    }
    const b = req.body || {};
    const author = String(b.author || '').toLowerCase();
    const permlink = String(b.permlink || '');
    if (!ACCOUNT_RE.test(author) || !PERMLINK_RE.test(permlink)) {
        return res.status(400).json({ success: false, error: 'invalid author or permlink' });
    }

    const signature = typeof b.signature === 'string' ? b.signature.slice(0, 200) : '';
    const timestamp = parseInt(b.timestamp, 10);
    if (!signature || !Number.isFinite(timestamp)) {
        return res.status(401).json({
            success: false,
            error: 'Signature required',
            expected_message: keepMessage(author, permlink, '<ms>'),
        });
    }
    if (Math.abs(Date.now() - timestamp) > SIGNATURE_TIMESTAMP_TOLERANCE_MS) {
        return res.status(401).json({ success: false, error: 'timestamp out of tolerance' });
    }

    let verdict = { ok: false, signer: null };
    try {
        verdict = await verifyHiveAuthority({
            message: keepMessage(author, permlink, timestamp),
            signature,
            username: author,
            allowedDelegates: AD_SIGNING_DELEGATES,
        });
    } catch (err) {
        if (err && err.code === 'HIVE_ACCOUNT_NOT_FOUND') {
            return res.status(404).json({ success: false, error: 'Hive account not found' });
        }
    }
    if (!verdict.ok) return res.status(401).json({ success: false, error: 'Invalid signature' });

    try {
        const embed = getDb().collection('embed-video');
        const doc = await embed.findOne(
            { owner: author, $or: [{ hive_permlink: permlink }, { permlink }] },
            { projection: { permlink: 1, hive_permlink: 1, embed_url: 1, story: 1, story_expires_at: 1 } },
        );
        if (!doc) return res.status(404).json({ success: false, error: 'story not found' });
        const live = doc.story === true && doc.story_expires_at && new Date(doc.story_expires_at) > new Date();
        if (!live) return res.status(409).json({ success: false, error: 'not a live story' });

        // story_expires_at must GO, not just `story`: the feeds' liveStoryMatch() and
        // the player's placeholder both key on it. story_posted_at stays (streaks,
        // leaderboard).
        await embed.updateOne({ _id: doc._id }, {
            $set: { story: false, story_kept_at: new Date() },
            $unset: { story_expires_at: '' },
        });
        storiesChanged();

        console.log(`[stories] kept ${author}/${doc.permlink} as a short (signer ${verdict.signer || author})`);
        res.json({ success: true, kept: { owner: author, permlink: doc.permlink, hive_permlink: hivePermlinkOf(doc) } });
    } catch (error) {
        console.error('[stories] keep failed:', error);
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
        // The author kept it as a short. Registering again would bring the post's own
        // story flag back and hide it, and register needs no signature.
        if (doc.story_kept_at) {
            return res.status(409).json({ success: false, error: 'kept as a short' });
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
        storiesChanged();

        console.log(`[stories] registered ${author}/${assetPermlink} -> @${author}/${post.permlink}, expires ${expiresAt.toISOString()}`);
        res.json({ success: true, story: { owner: author, permlink: assetPermlink, hive_permlink: post.permlink, expires_at: expiresAt } });
    } catch (error) {
        console.error('[stories] register failed:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

module.exports = router;
module.exports.STORY_TTL_MS = STORY_TTL_MS;
module.exports._test = { keepMessage };
