// Read side for INCUBATING users — people using 3Speak who have no Hive account
// yet. Their content is off-chain, in Butter Auth's hosted incubation service
// (incubation.butrauth.com), in 3Speak's own space there.
//
// These routes used to read the incubation_* collections straight out of this
// database. The content has moved to the hosted service, which now serves the
// same reads (see its routes/reads.js), so each route here passes the request
// through and returns the answer unchanged. The paths and response shapes are
// the ones the frontend already uses; nothing there changes.
//
// The service keeps the two rules these routes always followed: resolve the
// handle to a userId before querying, and never return a row already published
// to Hive.
//
// Two things stay HERE, because the data they touch is 3Speak's and never moved:
// watch time (written by the player into incubation_watch) and the upload
// records in embed-video. Both are INTERNAL routes for 3Speak's own API server
// on this machine; see isInternal() below.

const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');
const { call, qs } = require('../utils/incubationHosted');

/** Pass the service's answer through, or 502 if it did not answer. */
function relay(res, cache) {
    return (r) => {
        if (cache && r.status === 200) res.set('Cache-Control', cache);
        res.status(r.status).json(r.body ?? { error: 'Empty response' });
    };
}
function failed(res, where) {
    return (err) => {
        console.error(`[incubation] ${where}:`, err.message);
        res.status(502).json({ error: 'Incubation service unavailable' });
    };
}

// POST /incubation/authors  { handles: [...] }
// Batch handle -> identity. Handles nobody holds are left out, as they always
// were: a card with no author is skipped, not rendered as "unknown".
router.post('/authors', (req, res) => {
    const { handles } = req.body || {};
    if (!Array.isArray(handles)) return res.status(400).json({ error: 'handles must be an array' });
    if (handles.length > 100) return res.status(400).json({ error: 'At most 100 handles per request' });
    call('POST', '/public/authors', { handles })
        .then((r) => {
            if (r.status !== 200) return res.status(r.status).json(r.body);
            const authors = {};
            for (const [h, a] of Object.entries(r.body?.authors || {})) {
                if (!a || a.status === 'unknown' || !a.userId) continue;
                authors[h] = { userId: a.userId, handle: h, status: a.status, hiveUsername: a.hiveUsername || null };
            }
            res.set('Cache-Control', 'public, max-age=30');
            res.json({ authors });
        })
        .catch(failed(res, 'authors'));
});

// GET /incubation/profile/:handle?viewer= — profile, interests and counts.
router.get('/profile/:handle', (req, res) => {
    const handle = encodeURIComponent(String(req.params.handle || '').toLowerCase());
    call('GET', `/public/profile/${handle}${qs({ viewer: req.query.viewer })}`)
        .then(relay(res)).catch(failed(res, 'profile'));
});

// GET /incubation/user/:handle/posts — one user's posts, newest first.
router.get('/user/:handle/posts', (req, res) => {
    const handle = encodeURIComponent(String(req.params.handle || '').toLowerCase());
    call('GET', `/public/user/${handle}/posts${qs({ limit: req.query.limit })}`)
        .then(relay(res)).catch(failed(res, 'user posts'));
});

// GET /incubation/feed?limit=&maxAgeDays=&contentType= — recent off-chain posts,
// for interleaving into the home and discover feeds.
router.get('/feed', (req, res) => {
    const { limit, maxAgeDays, contentType } = req.query;
    call('GET', `/public/feed${qs({ limit, maxAgeDays, contentType })}`)
        .then(relay(res, 'public, max-age=30')).catch(failed(res, 'feed'));
});

// GET /incubation/replies?parentAuthor=&parentPermlink= — the off-chain replies
// under one piece of content, for merging into its Hive thread.
router.get('/replies', (req, res) => {
    const { parentAuthor, parentPermlink, limit } = req.query;
    if (typeof parentAuthor !== 'string' || typeof parentPermlink !== 'string') {
        return res.status(400).json({ error: 'parentAuthor and parentPermlink are required' });
    }
    call('GET', `/public/replies${qs({ parentAuthor, parentPermlink, limit })}`)
        .then(relay(res)).catch(failed(res, 'replies'));
});

// POST /incubation/replies/for  { permlinks } — every off-chain reply under any
// of these parents, in one round trip.
router.post('/replies/for', (req, res) => {
    const { permlinks } = req.body || {};
    if (!Array.isArray(permlinks)) return res.status(400).json({ error: 'permlinks must be an array' });
    call('POST', '/public/replies/for', { permlinks })
        .then(relay(res)).catch(failed(res, 'replies/for'));
});

// POST /incubation/likes/for  { items: [{author, permlink}], viewer } — like
// counts for many posts in one round trip. These are 3Speak likes, not Hive
// votes: they move no rewards and are never replayed.
router.post('/likes/for', (req, res) => {
    const { items, viewer } = req.body || {};
    if (!Array.isArray(items)) return res.status(400).json({ error: 'items must be an array' });
    call('POST', '/public/likes/for', { items, viewer })
        .then(relay(res)).catch(failed(res, 'likes/for'));
});

// GET /incubation/likes?author=&permlink=&viewer= — the same for one post.
router.get('/likes', (req, res) => {
    const { author, permlink, viewer } = req.query;
    if (typeof author !== 'string' || typeof permlink !== 'string') {
        return res.status(400).json({ error: 'author and permlink are required' });
    }
    call('GET', `/public/likes${qs({ author, permlink, viewer })}`)
        .then(relay(res)).catch(failed(res, 'likes'));
});

// GET /incubation/post/:handle/:permlink — one off-chain post. The watch page
// falls back to this when Hive has no such post.
router.get('/post/:handle/:permlink', (req, res) => {
    const handle = encodeURIComponent(String(req.params.handle || '').toLowerCase());
    const permlink = encodeURIComponent(String(req.params.permlink || ''));
    call('GET', `/public/post/${handle}/${permlink}`)
        .then(relay(res)).catch(failed(res, 'post'));
});

// ---------------------------------------------------------------------------
// Internal: 3Speak's own data, for 3Speak's API server on this machine.
// ---------------------------------------------------------------------------

/**
 * A caller on this machine that did NOT come through nginx.
 *
 * nginx connects from loopback too, so the socket address alone would let any
 * visitor through checker.3speak.tv in. Every vhost in front of the checker
 * sets X-Forwarded-For and X-Real-IP, and Cloudflare adds CF-Connecting-IP, so
 * their absence is what marks a direct local call.
 */
function isInternal(req) {
    const addr = req.socket?.remoteAddress || '';
    const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
    const h = req.headers;
    return loopback && !h['x-forwarded-for'] && !h['x-real-ip'] && !h['cf-connecting-ip'];
}
function internalOnly(req, res, next) {
    if (!isInternal(req)) return res.status(404).json({ error: 'Not found' });
    next();
}

const HANDLE_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const HIVE_RE = /^[a-z][a-z0-9.-]{2,15}$/;

// GET /incubation/internal/watch/:handle — seconds of video this warm-up user
// has watched. The player writes incubation_watch from heartbeats it times
// itself; that stayed in 3Speak's database when the content moved. Keyed by
// handle, because that is all the player is told.
router.get('/internal/watch/:handle', internalOnly, async (req, res) => {
    try {
        const handle = String(req.params.handle || '').toLowerCase();
        if (!HANDLE_RE.test(handle)) return res.status(400).json({ error: 'Invalid handle' });
        const [row] = await getDb().collection('incubation_watch').aggregate([
            { $match: { handle } },
            { $group: { _id: null, seconds: { $sum: '$contentSeconds' } } },
        ]).toArray();
        res.json({ handle, seconds: Math.round(row?.seconds || 0) });
    } catch (err) {
        console.error('[incubation] internal watch:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// POST /incubation/internal/claim-assets { handle, hiveUsername } — move the
// uploads made under a warm-up handle onto the Hive account it graduated to.
//
// The caller (3Speak's API) has already checked the graduation: the user's own
// token names the Hive account, and the incubation service's backfill summary
// names the handle. This only does the write, and only on rows still owned by
// that exact handle, so running it twice matches nothing the second time.
router.post('/internal/claim-assets', internalOnly, async (req, res) => {
    try {
        const handle = String(req.body?.handle || '').toLowerCase();
        const hiveUsername = String(req.body?.hiveUsername || '').toLowerCase();
        if (!HANDLE_RE.test(handle) || !HIVE_RE.test(hiveUsername)) {
            return res.status(400).json({ error: 'handle and hiveUsername are required' });
        }
        // Same string: a no-op that would also sweep in anything uploaded after
        // graduation.
        if (handle === hiveUsername) return res.json({ claimed: 0, reason: 'same_name' });
        const result = await getDb().collection('embed-video').updateMany(
            { owner: handle },
            { $set: { owner: hiveUsername, owner_claimed_from: handle, owner_claimed_at: new Date() } },
        );
        res.json({ claimed: result.modifiedCount, from: handle, to: hiveUsername });
    } catch (err) {
        console.error('[incubation] internal claim-assets:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

module.exports = router;
module.exports.isInternal = isInternal;
