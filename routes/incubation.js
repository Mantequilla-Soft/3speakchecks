// Read side for INCUBATING users — people using 3Speak who have no Hive account
// yet. Their content is off-chain, in the incubation_* collections written by
// the separate incubation service (prodops/services/incubation).
//
// Reads live HERE and writes live THERE, deliberately. Feeds, profiles and
// thread merges are this service's job and it already has the indexes, the
// caching and the frontend pointed at it; accepting user comments into 3Speak's
// database is not, and the incubation service owns that lifecycle (including
// the graduation replay, which has to stay next to the code that knows which
// operation types can be replayed at all).
//
// TWO RULES that every handler here follows:
//
//  1. Resolve the handle to a userId FIRST, then query by userId. The `handle`
//     field denormalised onto each content row is a RENDER CACHE: a user can
//     change their handle while incubating, and again at graduation if the name
//     got taken on Hive meanwhile. Querying by it returns a stale slice.
//
//  2. Never return rows that have already been published to Hive. Once a
//     graduating user's post is replayed on chain, the Hive-backed feed is its
//     home; returning it here too would double it in every list.

const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');

const ACCOUNTS = 'incubation_accounts';
const COMMENTS = 'incubation_comments';
const PROFILES = 'incubation_profiles';
const FOLLOWS = 'incubation_follows';
const VOTES = 'incubation_votes';

const clampLimit = (v, def, max) => Math.min(Math.max(parseInt(v, 10) || def, 1), max);

/**
 * handle -> { userId, handle, status, hiveUsername } for a batch of handles.
 *
 * Reads incubation_accounts, the mirror the incubation service maintains, NOT
 * butrauth's own users collection. Both live in this database, so reading
 * butrauth directly would work and would be a mistake: that schema is another
 * service's private business and nothing here would notice it changing.
 */
async function resolveHandles(db, handles) {
    const wanted = [...new Set(handles.filter(h => typeof h === 'string' && h).map(h => h.toLowerCase()))];
    if (!wanted.length) return {};
    const rows = await db.collection(ACCOUNTS)
        .find({ handle: { $in: wanted } })
        .project({ butrauthUserId: 1, handle: 1, status: 1, hiveUsername: 1 })
        .toArray();
    const out = {};
    for (const r of rows) {
        out[r.handle] = {
            userId: r.butrauthUserId,
            handle: r.handle,
            status: r.status || 'incubating',
            hiveUsername: r.hiveUsername || null,
        };
    }
    return out;
}

/**
 * Pull the bits a video card needs out of the post's own metadata.
 *
 * The upload writes a legacy `video.info` block so other Hive frontends can
 * render the player, and it is already stored verbatim on the incubation row —
 * so the thumbnail and duration are here, in the same shape a published post
 * would carry them. No second source to keep in step.
 */
function videoBitsOf(meta) {
    const info = meta?.video?.info || {};
    let thumbnail = null;
    if (Array.isArray(info.sourceMap)) {
        const t = info.sourceMap.find((x) => x && x.type === 'thumbnail');
        if (t) thumbnail = t.url || null;
    }
    if (!thumbnail && Array.isArray(meta?.image) && meta.image[0]) thumbnail = meta.image[0];
    return {
        thumbnail,
        duration: Number(info.duration) || 0,
        // The embed asset this post is about, so a player can be pointed at it.
        assetAuthor: info.author || null,
        assetPermlink: info.permlink || null,
    };
}

function shapePost(r) {
    const bits = videoBitsOf(r.jsonMetadata);
    return {
        ...bits,
        permlink: r.permlink,
        title: r.title || '',
        body: r.body || '',
        handle: r.handle,
        // A reply written by someone who ALREADY has a Hive account. Rendered
        // under their real account so the thread shows who actually spoke —
        // and so their avatar and reputation resolve normally.
        hiveAuthor: r.hiveAuthor || null,
        authorKind: r.authorKind || 'incubating',
        videoId: r.videoId || null,
        // 'video' | 'short' | 'comment'. Derived at write time from the post's
        // OpenAttribute envelope; absent on rows older than that field.
        contentType: r.contentType || null,
        parentAuthor: r.parentAuthor || '',
        parentPermlink: r.parentPermlink || '',
        jsonMetadata: r.jsonMetadata || {},
        created: r.createdAt,
        // No Hive author exists yet. Saying so explicitly stops a frontend from
        // building an @author link that would 404 on every other Hive site.
        onChain: false,
    };
}

// POST /incubation/authors  { handles: [...] }
// Batch handle -> identity, so a feed can render author names in one call
// instead of one per card.
router.post('/authors', async (req, res) => {
    try {
        const { handles } = req.body || {};
        if (!Array.isArray(handles)) return res.status(400).json({ error: 'handles must be an array' });
        if (handles.length > 100) return res.status(400).json({ error: 'At most 100 handles per request' });
        const db = getDb();
        res.set('Cache-Control', 'public, max-age=30');
        res.json({ authors: await resolveHandles(db, handles) });
    } catch (err) {
        console.error('[incubation] authors:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// GET /incubation/profile/:handle — profile, interests and counts.
router.get('/profile/:handle', async (req, res) => {
    try {
        const db = getDb();
        const handle = String(req.params.handle || '').toLowerCase();
        const who = (await resolveHandles(db, [handle]))[handle];
        if (!who) return res.status(404).json({ error: 'No such user' });

        const [profileRow, postCount, followingCount] = await Promise.all([
            db.collection(PROFILES).findOne({ butrauthUserId: who.userId }),
            // Same rule as the posts list below: counted by contentType, so
            // shorts are included. Counting kind:'post' said "1 post" on a
            // profile showing three.
            db.collection(COMMENTS).countDocuments({
                butrauthUserId: who.userId,
                $or: [
                    { contentType: { $in: ['video', 'short'] } },
                    { contentType: { $exists: false }, kind: 'post' },
                ],
            }),
            db.collection(FOLLOWS).countDocuments({ butrauthUserId: who.userId, state: 'following' }),
        ]);

        const profile = profileRow?.profile || {};
        res.json({
            handle: who.handle,
            status: who.status,
            hiveUsername: who.hiveUsername,
            profile: {
                name: profile.name || null,
                about: profile.about || null,
                location: profile.location || null,
                website: profile.website || null,
                profile_image: profile.profile_image || null,
                cover_image: profile.cover_image || null,
            },
            interests: Array.isArray(profile.interests) ? profile.interests : [],
            counts: {
                posts: postCount,
                following: followingCount,
                // Followers are NOT counted: nobody can follow an incubating
                // user yet (there is no account to follow), and returning 0
                // would read as "has no followers" rather than "not applicable".
                followers: null,
            },
        });
    } catch (err) {
        console.error('[incubation] profile:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

/**
 * Attach the off-chain like and reply counts to a page of posts.
 *
 * TWO aggregations for the whole page rather than two per card: the card footer
 * asks for both on every post, and doing it per row is how a profile becomes
 * 2N queries.
 *
 * Without these the cards render the same empty placeholders a Hive post shows
 * while its stats load, except here they would never arrive: an off-chain post
 * has no Hive stats to fetch.
 */
async function withCounts(db, handle, rows) {
    const shaped = rows.map(shapePost);
    if (!shaped.length) return shaped;
    const permlinks = shaped.map((r) => r.permlink);

    const [votes, replies] = await Promise.all([
        db.collection(VOTES).aggregate([
            { $match: { author: handle, permlink: { $in: permlinks } } },
            { $group: { _id: '$permlink', n: { $sum: 1 } } },
        ]).toArray(),
        db.collection(COMMENTS).aggregate([
            { $match: { parentAuthor: handle, parentPermlink: { $in: permlinks } } },
            { $group: { _id: '$parentPermlink', n: { $sum: 1 } } },
        ]).toArray(),
    ]);

    const voteBy = new Map(votes.map((v) => [v._id, v.n]));
    const replyBy = new Map(replies.map((r) => [r._id, r.n]));
    return shaped.map((r) => ({
        ...r,
        likeCount: voteBy.get(r.permlink) || 0,
        replyCount: replyBy.get(r.permlink) || 0,
    }));
}

// GET /incubation/user/:handle/posts — one user's posts, newest first.
router.get('/user/:handle/posts', async (req, res) => {
    try {
        const db = getDb();
        const handle = String(req.params.handle || '').toLowerCase();
        const who = (await resolveHandles(db, [handle]))[handle];
        if (!who) return res.status(404).json({ error: 'No such user' });

        const limit = clampLimit(req.query.limit, 30, 100);
        // By contentType, NOT by kind. A short is published as a reply to the
        // snaps container, so its `kind` is 'comment' and filtering on
        // kind:'post' hid every short the user had uploaded from their own
        // profile. The $or keeps rows written before contentType existed
        // working off the old field.
        const rows = await db.collection(COMMENTS)
            .find({
                butrauthUserId: who.userId,
                publishedAt: null,
                $or: [
                    { contentType: { $in: ['video', 'short'] } },
                    { contentType: { $exists: false }, kind: 'post' },
                ],
            })
            .sort({ createdAt: -1 }).limit(limit).toArray();
        res.json({ author: who, items: await withCounts(db, handle, rows) });
    } catch (err) {
        console.error('[incubation] user posts:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// GET /incubation/feed — recent off-chain posts, for interleaving into the home
// and discover feeds next to the Hive-backed ones.
//
// Authors are resolved and attached in ONE batch rather than per row: this is
// the hot path and a lookup per card is what turns a feed into N+1 queries.
router.get('/feed', async (req, res) => {
    try {
        const db = getDb();
        const limit = clampLimit(req.query.limit, 20, 50);
        const maxAgeDays = Math.min(parseFloat(req.query.maxAgeDays) || 30, 90);
        const since = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);

        const rows = await db.collection(COMMENTS)
            .find({ kind: 'post', publishedAt: null, createdAt: { $gte: since } })
            .sort({ createdAt: -1 }).limit(limit).toArray();

        const authors = await resolveHandles(db, rows.map(r => r.handle));
        res.set('Cache-Control', 'public, max-age=30');
        res.json({
            items: rows.map(r => ({
                ...shapePost(r),
                // Re-resolved rather than trusting the denormalised handle, so a
                // renamed author renders correctly. A row whose author has since
                // been erased resolves to null and the frontend can skip it.
                author: authors[r.handle] || null,
            })),
        });
    } catch (err) {
        console.error('[incubation] feed:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// GET /incubation/replies?parentAuthor=&parentPermlink=
//
// The off-chain replies under a piece of content, so a watch page can merge
// them into the Hive comment thread it already fetches. Incubating users are
// commenting on REAL Hive posts, so without this their comments are invisible
// on the very page they were written for.
router.get('/replies', async (req, res) => {
    try {
        const { parentAuthor, parentPermlink } = req.query;
        if (typeof parentAuthor !== 'string' || typeof parentPermlink !== 'string') {
            return res.status(400).json({ error: 'parentAuthor and parentPermlink are required' });
        }
        const db = getDb();
        const limit = clampLimit(req.query.limit, 100, 200);
        const rows = await db.collection(COMMENTS)
            .find({ parentAuthor, parentPermlink, publishedAt: null })
            .sort({ createdAt: -1 }).limit(limit).toArray();

        const authors = await resolveHandles(db, rows.map(r => r.handle));
        res.json({
            items: rows.map(r => ({ ...shapePost(r), author: authors[r.handle] || null })),
        });
    } catch (err) {
        console.error('[incubation] replies:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// GET /incubation/likes?author=&permlink= — how many people liked an off-chain
// post, and whether the named viewer is one of them.
//
// These are 3Speak likes, not Hive votes: they move no rewards and are never
// replayed to the chain. The route is named accordingly so nothing downstream
// mistakes the number for a vote count with a payout behind it.
router.get('/likes', async (req, res) => {
    try {
        const { author, permlink, viewer } = req.query;
        if (typeof author !== 'string' || typeof permlink !== 'string') {
            return res.status(400).json({ error: 'author and permlink are required' });
        }
        const db = getDb();
        const col = db.collection(VOTES);
        const count = await col.countDocuments({ author, permlink });
        let liked = false;
        if (typeof viewer === 'string' && viewer) {
            // A Hive viewer is matched by voterKey; an incubating one by the
            // handle stored on the row. `inc:<handle>` was never a voterKey --
            // those are `inc:<butrauthUserId>` -- so an incubating user's own
            // vote came back unliked and the heart reset on every reload.
            liked = !!(await col.findOne(
                {
                    author,
                    permlink,
                    $or: [
                        { voterKey: `hive:${viewer.toLowerCase()}` },
                        { handle: viewer },
                    ],
                },
                { projection: { _id: 1 } },
            ));
        }
        res.json({ count, liked });
    } catch (err) {
        console.error('[incubation] likes:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// GET /incubation/post/:handle/:permlink — one off-chain post.
//
// The watch page falls back to this when Hive has no such post, which is what
// lets an incubating user's video open on a real watch page instead of a dead
// link from its own card.
router.get('/post/:handle/:permlink', async (req, res) => {
    try {
        const db = getDb();
        const handle = String(req.params.handle || '').toLowerCase();
        const who = (await resolveHandles(db, [handle]))[handle];
        if (!who) return res.status(404).json({ error: 'No such user' });

        const row = await db.collection(COMMENTS).findOne({
            butrauthUserId: who.userId,
            permlink: String(req.params.permlink || ''),
        });
        if (!row) return res.status(404).json({ error: 'Not found' });

        // A published row is served from Hive, not here: returning it too would
        // give the watch page two sources for one post and no rule for which wins.
        if (row.publishedAt) {
            return res.status(409).json({
                error: 'Published to Hive',
                reason: 'published',
                publishedAs: row.publishedAs || null,
            });
        }
        res.json({ author: who, post: shapePost(row) });
    } catch (err) {
        console.error('[incubation] post:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

module.exports = router;
