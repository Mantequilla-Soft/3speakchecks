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
const { getDb, getLinksCollection } = require('../utils/db');
const { verifyAndStore, unlinkIfRevoked } = require('../services/verifier');
const { hashForHiveUsername } = require('../utils/hash');
const { call, qs } = require('../utils/incubationHosted');
const { fetchAiFlagsBatch } = require('../utils/transcriptionTags');
const { isHiddenFromFeed } = require('../utils/hiddenFromFeed');

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
//
// Nothing posted before WARMUP_FEED_SINCE ever appears (owner's call, 2026-10-09:
// the feeds opened to everyone that day, so only what was uploaded from then on),
// and nothing older than WARMUP_FEED_MAX_AGE_DAYS (owner's call, 2026-10-17: 3
// days, a warm-up post is a nudge for something new, not a back catalogue).
// The later of the two becomes the service's age window, so `limit` counts only
// posts after it, and the items are checked against it again in case the window
// is rounded. The review queue below keeps the whole window since the start date.
//
// Videos flagged as AI-generated (subtitles-tags ai_generated_v2) are left out too.
// The home rail would drop them in the browser anyway, but the shorts swipe feed
// runs its AI filter BEFORE it mixes warm-up shorts in, so they must not arrive.
// This feed exists to put new creators in front of people, not AI uploads. If the
// lookup fails the items are kept, like every other feed here.
// The video a warm-up post carries, as subtitles-tags keys it: owner + asset id.
const assetKey = (it) => {
    const author = String(it.assetAuthor || it.handle || '').toLowerCase();
    const permlink = String(it.assetPermlink || it.videoId || it.permlink || '');
    return author && permlink ? `${author}/${permlink}` : null;
};
async function dropAiFlagged(items) {
    const keys = items.map(assetKey).filter(Boolean);
    if (!keys.length) return items;
    try {
        const flagged = new Set(await fetchAiFlagsBatch(getDb(), keys.map((k) => {
            const i = k.indexOf('/');
            return { author: k.slice(0, i), permlink: k.slice(i + 1) };
        })));
        return items.filter((it) => !flagged.has(assetKey(it)));
    } catch (e) {
        console.warn('[incubation] AI flag lookup failed, feed unfiltered:', e.message);
        return items;
    }
}
// Videos their creator took out of the feeds: hidden from feeds (hiddenFromFeed)
// or unlisted (listed_on_3speak: false), read off the embed-video asset like
// every other feed here. They stay on the creator's profile, which does not go
// through /feed.
//
// And nothing shows until 3Speak approved it (owner 2026-10-13): the admin
// backend sets `warmup_approved: true` on the embed-video asset. Missing or
// anything but true = not shown, so a post without an asset never shows either.
// WARMUP_APPROVAL_REQUIRED=false turns the gate off.
//
// If the lookup fails, the hidden rule fails open like every other feed here,
// but the approval gate fails CLOSED: an unreviewed post must not slip out on a
// database hiccup, so the feed comes back empty instead.
const WARMUP_APPROVAL_REQUIRED = process.env.WARMUP_APPROVAL_REQUIRED !== 'false';
async function filterByAsset(items) {
    const keys = [...new Set(items.map(assetKey).filter(Boolean))];
    if (!keys.length) return WARMUP_APPROVAL_REQUIRED ? [] : items;
    try {
        const rows = await getDb().collection('embed-video').find(
            { $or: keys.map((k) => { const i = k.indexOf('/'); return { owner: k.slice(0, i), permlink: k.slice(i + 1) }; }) },
            { projection: { _id: 0, owner: 1, permlink: 1, hiddenFromFeed: 1, listed_on_3speak: 1, warmup_approved: 1 } },
        ).toArray();
        const rowKey = (r) => `${String(r.owner).toLowerCase()}/${r.permlink}`;
        const hidden = new Set(rows
            .filter((r) => isHiddenFromFeed(r) || r.listed_on_3speak === false)
            .map(rowKey));
        const approved = new Set(rows.filter((r) => r.warmup_approved === true).map(rowKey));
        return items.filter((it) => {
            const k = assetKey(it);
            if (WARMUP_APPROVAL_REQUIRED && !approved.has(k)) return false;
            return !hidden.has(k);
        });
    } catch (e) {
        if (WARMUP_APPROVAL_REQUIRED) {
            console.warn('[incubation] embed-video lookup failed, warm-up feed held back:', e.message);
            return [];
        }
        console.warn('[incubation] hidden-from-feed lookup failed, feed unfiltered:', e.message);
        return items;
    }
}
// Only a share of the warm-up posts per load, a fresh random pick each time
// (owner 2026-10-12: 50%). Drawn from the whole pool the service will give (its
// cap is 50), not just the newest `limit`, so older posts get their turn too.
// Rounded up, so a single warm-up post still shows. WARMUP_FEED_SHARE=1 turns
// the sampling off.
const WARMUP_FEED_SHARE = Math.min(Math.max(parseFloat(process.env.WARMUP_FEED_SHARE ?? '0.5') || 0, 0), 1);
const WARMUP_FEED_POOL = 50;
function sampleShare(items) {
    if (WARMUP_FEED_SHARE >= 1 || items.length === 0) return items;
    const keep = Math.ceil(items.length * WARMUP_FEED_SHARE);
    const idx = items.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    // Back in the service's order (newest first) once picked.
    return idx.slice(0, keep).sort((a, b) => a - b).map((i) => items[i]);
}
const WARMUP_FEED_SINCE = new Date(process.env.WARMUP_FEED_SINCE || '2026-10-09T00:00:00Z');
const WARMUP_FEED_MAX_AGE_DAYS = (() => {
    const v = parseFloat(process.env.WARMUP_FEED_MAX_AGE_DAYS);
    return Number.isFinite(v) && v > 0 ? v : 3;
})();
router.get('/feed', (req, res) => {
    const { limit, contentType } = req.query;
    const sinceMs = Math.max(WARMUP_FEED_SINCE.getTime(), Date.now() - WARMUP_FEED_MAX_AGE_DAYS * 86400000);
    const cutoffDays = Math.max((Date.now() - sinceMs) / 86400000, 0.001);
    const asked = parseFloat(req.query.maxAgeDays);
    const maxAgeDays = Number.isFinite(asked) && asked > 0 ? Math.min(asked, cutoffDays) : cutoffDays;
    // The caller's limit applies to what is shown, after the draw; the service is
    // asked for the whole pool. Same default as the service when none is given.
    const shownLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), WARMUP_FEED_POOL);
    const sampling = WARMUP_FEED_SHARE < 1;
    call('GET', `/public/feed${qs({ limit: sampling ? WARMUP_FEED_POOL : shownLimit, maxAgeDays, contentType })}`)
        .then(async (r) => {
            if (r.status === 200 && Array.isArray(r.body?.items)) {
                const items = r.body.items.filter((it) => new Date(it.created).getTime() >= sinceMs);
                const shown = await dropAiFlagged(await filterByAsset(items));
                r.body.items = sampleShare(shown).slice(0, shownLimit);
            }
            // A random pick must not be cached, or everyone gets the same half.
            relay(res, sampling ? 'no-store' : 'public, max-age=30')(r);
        })
        .catch(failed(res, 'feed'));
});

// GET /incubation/review?state=pending|approved|rejected|all — the queue for the
// admin backend's warm-up approval (see filterByAsset above). Every warm-up post
// since WARMUP_FEED_SINCE with its embed-video asset and review state:
//   pending  = warmup_approved missing (never reviewed)
//   approved = warmup_approved: true (shown in the feeds)
//   rejected = warmup_approved: false (reviewed, kept out)
// Read-only and public like the rest of this router: the posts are already on
// each creator's public profile. Approving is a write the admin backend makes on
// embed-video itself. The service caps one read at 50, so videos and shorts are
// read separately: the newest 50 of each.
const reviewState = (row) => (row?.warmup_approved === true ? 'approved'
    : row?.warmup_approved === false ? 'rejected' : 'pending');
router.get('/review', async (req, res) => {
    const want = String(req.query.state || 'pending');
    const maxAgeDays = Math.max((Date.now() - WARMUP_FEED_SINCE.getTime()) / 86400000, 0.001);
    try {
        const reads = await Promise.all(['video', 'short'].map((contentType) =>
            call('GET', `/public/feed${qs({ limit: WARMUP_FEED_POOL, maxAgeDays, contentType })}`)));
        if (reads.some((r) => r.status !== 200)) return relay(res)(reads.find((r) => r.status !== 200));
        const items = reads.flatMap((r) => r.body?.items || [])
            .filter((it) => new Date(it.created).getTime() >= WARMUP_FEED_SINCE.getTime())
            .sort((a, b) => new Date(b.created) - new Date(a.created));
        const keys = [...new Set(items.map(assetKey).filter(Boolean))];
        const rows = keys.length ? await getDb().collection('embed-video').find(
            { $or: keys.map((k) => { const i = k.indexOf('/'); return { owner: k.slice(0, i), permlink: k.slice(i + 1) }; }) },
            { projection: { _id: 0, owner: 1, permlink: 1, status: 1, short: 1, hiddenFromFeed: 1, listed_on_3speak: 1,
                warmup_approved: 1, warmup_reviewed_by: 1, warmup_reviewed_at: 1 } },
        ).toArray() : [];
        const byKey = new Map(rows.map((r) => [`${String(r.owner).toLowerCase()}/${r.permlink}`, r]));
        let ai = new Set();
        try {
            ai = new Set(await fetchAiFlagsBatch(getDb(), keys.map((k) => {
                const i = k.indexOf('/');
                return { author: k.slice(0, i), permlink: k.slice(i + 1) };
            })));
        } catch (e) {
            console.warn('[incubation] review: AI flag lookup failed:', e.message);
        }
        const out = items.map((it) => {
            const k = assetKey(it);
            const row = k ? byKey.get(k) : null;
            return {
                handle: it.handle,
                permlink: it.permlink,
                title: it.title,
                body: it.body,
                contentType: it.contentType,
                created: it.created,
                thumbnail: it.thumbnail,
                duration: it.duration,
                watchUrl: `https://3speak.tv/watch?v=${encodeURIComponent(it.handle)}/${encodeURIComponent(it.permlink)}`,
                embedUrl: row ? `https://play.3speak.tv/embed?v=${encodeURIComponent(row.owner)}/${encodeURIComponent(row.permlink)}` : null,
                // The document the admin backend writes warmup_approved on.
                asset: row ? { owner: row.owner, permlink: row.permlink } : null,
                state: reviewState(row),
                reviewedBy: row?.warmup_reviewed_by ?? null,
                reviewedAt: row?.warmup_reviewed_at ?? null,
                // Kept out of the feeds anyway, whatever the review says.
                hiddenByCreator: !!row && (isHiddenFromFeed(row) || row.listed_on_3speak === false),
                aiGenerated: !!k && ai.has(k),
                assetStatus: row?.status ?? null,
            };
        });
        res.set('Cache-Control', 'no-store');
        res.json({
            approvalRequired: WARMUP_APPROVAL_REQUIRED,
            since: WARMUP_FEED_SINCE.toISOString(),
            items: want === 'all' ? out : out.filter((o) => o.state === want),
        });
    } catch (err) {
        failed(res, 'review')(err);
    }
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

/* ─── Advertiser business contact (warm-up accounts) ─────────────────────────
 *
 * 🚨 PRIVATE, OFF-CHAIN, FOREVER. An advertiser in warm-up gives us an email (required)
 * and optionally a postal address, so the team can reach the business behind an ad.
 * This is the ONLY place they are kept: never in the incubation service's profile
 * (which is shown to others and copied to the Hive account at graduation), never in a
 * Hive operation, never in a log line. Internal-only routes, reached by 3Speak's API
 * on behalf of the signed-in user, keyed by that user's id.
 */
const CONTACTS = 'incubation_contacts';
const USER_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const ADDRESS_FIELDS = ['line1', 'line2', 'postalCode', 'city', 'region', 'country'];

const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '');

/** An address counts once street, city and country are there. The rest is optional. */
function addressComplete(a) {
    return !!(a && a.line1 && a.city && a.country);
}

// GET /incubation/internal/contact/:userId — what this user has given us, or nulls.
router.get('/internal/contact/:userId', internalOnly, async (req, res) => {
    try {
        const userId = String(req.params.userId || '');
        if (!USER_ID_RE.test(userId)) return res.status(400).json({ error: 'Invalid user id' });
        const row = await getDb().collection(CONTACTS).findOne({ userId }, { projection: { _id: 0, email: 1, address: 1, updatedAt: 1 } });
        res.json({
            email: row?.email || null,
            address: row?.address || null,
            addressComplete: addressComplete(row?.address),
            updatedAt: row?.updatedAt || null,
        });
    } catch (err) {
        console.error('[incubation] internal contact read:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// GET /incubation/internal/contact-by-handle/:handle — the same row, found by the
// warm-up handle, for 3Speak's ADMIN view of an advertiser's page. 3Speak's API only
// calls this after ButrAuth confirmed the caller may manage the app.
router.get('/internal/contact-by-handle/:handle', internalOnly, async (req, res) => {
    try {
        const handle = String(req.params.handle || '').toLowerCase();
        if (!HANDLE_RE.test(handle)) return res.status(400).json({ error: 'Invalid handle' });
        const row = await getDb().collection(CONTACTS).findOne(
            { handle },
            { sort: { updatedAt: -1 }, projection: { _id: 0, userId: 1, email: 1, address: 1, createdAt: 1, updatedAt: 1 } },
        );
        if (!row) return res.json({ found: false });
        res.json({ found: true, ...row, addressComplete: addressComplete(row.address) });
    } catch (err) {
        console.error('[incubation] internal contact by handle:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// PUT /incubation/internal/contact/:userId { handle, email, address{...} } — save it.
router.put('/internal/contact/:userId', internalOnly, async (req, res) => {
    try {
        const userId = String(req.params.userId || '');
        if (!USER_ID_RE.test(userId)) return res.status(400).json({ error: 'Invalid user id' });
        const b = req.body || {};
        const email = clean(b.email, 254).toLowerCase();
        if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
        const address = {};
        for (const f of ADDRESS_FIELDS) address[f] = clean(b.address?.[f], 120) || null;
        const handle = clean(b.handle, 64).toLowerCase() || null;
        await getDb().collection(CONTACTS).updateOne(
            { userId },
            { $set: { userId, handle, email, address, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
            { upsert: true },
        );
        res.json({ ok: true, email, address, addressComplete: addressComplete(address) });
    } catch (err) {
        // Never the body: it is somebody's email and home address.
        console.error('[incubation] internal contact write:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

/* ── Warm-up "link your channel" (optional task) ─────────────────────────────
 * A warm-up user has no Hive account, so their channel links are kept under
 * `warmup:<butrauth userId>` in the same social_links collection (the userId,
 * not the handle: a handle can still change before graduation). The code they
 * put in their bio is md5 of that id, exactly like a Hive name's. Only 3Speak's
 * API reaches these, after proving the warm-up session; claim-assets moves the
 * links to the new Hive account at graduation.
 *
 * Its own platform list (WARMUP_LINK_PLATFORMS, default youtube,tiktok,instagram),
 * NOT the VERIFY_<NAME> switches: prod allows profile links for YouTube and
 * SoundCloud only, while warm-up users may still link these (owner 2026-10-06). */
const WARMUP_LINK_PLATFORMS = (process.env.WARMUP_LINK_PLATFORMS || 'youtube,tiktok,instagram')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const warmupId = (userId) => `warmup:${userId}`.toLowerCase();
const shapeLink = (r) => ({
    platform: r.platform, platform_username: r.platform_username, verified: !!r.verified,
    verified_at: r.verified_at || null, last_error: r.last_error || null,
});

// GET /incubation/internal/social/:userId → { code, platforms, links }
router.get('/internal/social/:userId', internalOnly, async (req, res) => {
    try {
        const userId = String(req.params.userId || '');
        if (!USER_ID_RE.test(userId)) return res.status(400).json({ error: 'Invalid user id' });
        const id = warmupId(userId);
        const rows = await getLinksCollection().find({ hive_username: id }).toArray();
        res.json({ code: hashForHiveUsername(id), platforms: WARMUP_LINK_PLATFORMS, links: rows.map(shapeLink) });
    } catch (err) {
        console.error('[incubation] internal social read:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// POST /incubation/internal/social/verify { userId, platform, platform_username }
router.post('/internal/social/verify', internalOnly, async (req, res) => {
    const userId = String(req.body?.userId || '');
    const platform = String(req.body?.platform || '').toLowerCase();
    const platformUsername = String(req.body?.platform_username || '').trim();
    if (!USER_ID_RE.test(userId)) return res.status(400).json({ error: 'Invalid user id' });
    if (!WARMUP_LINK_PLATFORMS.includes(platform)) {
        return res.status(400).json({ error: `Unsupported platform: ${platform}`, supported: WARMUP_LINK_PLATFORMS });
    }
    if (!platformUsername) return res.status(400).json({ error: 'platform_username is required' });
    try {
        const saved = await verifyAndStore({ hive_username: warmupId(userId), platform, platform_username: platformUsername }, { ignoreLinkSwitch: true });
        res.json(shapeLink(saved));
    } catch (err) {
        if (err.code === 'CHANNEL_NOT_FOUND') return res.status(404).json({ error: err.message });
        if (err.code === 'CHANNEL_ALREADY_LINKED') return res.status(409).json({ error: 'This channel is already linked to another account', code: 'CHANNEL_ALREADY_LINKED' });
        if (err.code === 'TOO_MANY_LINKS') return res.status(409).json({ error: err.message, code: 'TOO_MANY_LINKS' });
        console.error('[incubation] internal social verify:', err.message);
        res.status(502).json({ error: 'Platform lookup failed.' });
    }
});

// POST /incubation/internal/social/unlink { userId, platform, platform_username }
// Same rule as /verify/unlink: removed only once the code is gone from the bio.
router.post('/internal/social/unlink', internalOnly, async (req, res) => {
    const userId = String(req.body?.userId || '');
    const platform = String(req.body?.platform || '').toLowerCase();
    const platformUsername = String(req.body?.platform_username || '').trim();
    if (!USER_ID_RE.test(userId) || !platform || !platformUsername) return res.status(400).json({ error: 'userId, platform and platform_username are required' });
    try {
        const result = await unlinkIfRevoked({ hive_username: warmupId(userId), platform, platform_username: platformUsername });
        if (result.status === 'deleted') return res.json({ status: 'deleted' });
        if (result.status === 'not_found') return res.status(404).json({ error: 'No such link' });
        if (result.status === 'still_present') {
            return res.status(409).json({ error: 'The code is still on your profile. Remove it from your bio, then try again.', status: 'still_present' });
        }
        res.status(502).json({ error: 'Platform lookup failed.' });
    } catch (err) {
        console.error('[incubation] internal social unlink:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// Move a graduate's warm-up links onto their new Hive account. A channel that
// account already has is dropped from the warm-up copy (the unique index is
// hive_username + platform + platform_username).
async function moveWarmupLinks(userId, hiveUsername) {
    if (!USER_ID_RE.test(userId)) return 0;
    const coll = getLinksCollection();
    const rows = await coll.find({ hive_username: warmupId(userId) }).toArray();
    let moved = 0;
    for (const r of rows) {
        const clash = await coll.findOne({ hive_username: hiveUsername, platform: r.platform, platform_username: r.platform_username });
        if (clash) { await coll.deleteOne({ _id: r._id }); continue; }
        await coll.updateOne({ _id: r._id }, { $set: { hive_username: hiveUsername, moved_from_warmup: warmupId(userId), moved_at: new Date() } });
        moved += 1;
    }
    return moved;
}

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
        /* An ADVERTISER graduating: link their private contact record to the new Hive
         * account. Only advertisers have one (the contact goal is theirs alone), so
         * this is what lets the site recognise the account as an advertiser on any
         * device, before they have registered a product. Done first, because the
         * same-name early return below would otherwise skip it. The record stays
         * private; only the yes/no is ever public (/advertise/has-product). */
        const userId = String(req.body?.userId || '');
        const linkQuery = USER_ID_RE.test(userId) ? { userId } : { handle };
        await getDb().collection(CONTACTS).updateMany(
            linkQuery,
            { $set: { hiveAccount: hiveUsername, graduatedAt: new Date() } },
        );
        // Channel links made during the warm-up (also before the same-name return).
        const linksMoved = await moveWarmupLinks(userId, hiveUsername).catch((e) => {
            console.error('[incubation] claim-assets: moving warm-up links failed:', e.message);
            return 0;
        });
        // Same string: a no-op that would also sweep in anything uploaded after
        // graduation.
        if (handle === hiveUsername) return res.json({ claimed: 0, reason: 'same_name', linksMoved });
        const result = await getDb().collection('embed-video').updateMany(
            { owner: handle },
            { $set: { owner: hiveUsername, owner_claimed_from: handle, owner_claimed_at: new Date() } },
        );
        res.json({ claimed: result.modifiedCount, from: handle, to: hiveUsername, linksMoved });
    } catch (err) {
        console.error('[incubation] internal claim-assets:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

module.exports = router;
module.exports.isInternal = isInternal;
