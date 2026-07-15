const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getDb } = require('../utils/db');
const { nsfwFilter } = require('../utils/filters');

// Treat docs with no category as `voice_message` — the default snap-style
// upload doesn't always set the field. Filtering for voice should catch them.
function applyCategoryFilter(query, value) {
    if (!value) return;
    if (value === 'voice_message') {
        query.$and = (query.$and || []).concat([
            { $or: [{ category: 'voice_message' }, { category: null }, { category: { $exists: false } }] },
        ]);
    } else {
        query.category = value;
    }
}

function categoryMatchClause(value) {
    if (value === 'voice_message') {
        return { $or: [{ category: 'voice_message' }, { category: null }, { category: { $exists: false } }] };
    }
    return { category: value };
}

// Aggregation stages that enrich each audio doc with `playlist_thumbnail` —
// the cover of the earliest-created playlist that contains the audio's
// (owner, post_permlink) tuple. Uploaders sometimes publish a track straight
// into an album playlist; this lets the tile fall back to the album art
// when the audio itself has no thumbnail set.
const playlistJoin = [
    {
        $lookup: {
            from: 'playlists',
            let: { audioOwner: '$owner', audioPermlink: '$post_permlink' },
            pipeline: [
                {
                    $match: {
                        thumbnail: { $exists: true, $ne: '' },
                        $expr: {
                            $and: [
                                { $ne: ['$$audioPermlink', null] },
                                { $anyElementTrue: {
                                    $map: {
                                        input: { $ifNull: ['$items', []] },
                                        as: 'it',
                                        in: { $and: [
                                            { $eq: ['$$it.author', '$$audioOwner'] },
                                            { $eq: ['$$it.permlink', '$$audioPermlink'] },
                                        ]}
                                    }
                                }}
                            ]
                        }
                    }
                },
                { $sort: { created_at: 1 } },
                { $limit: 1 },
                { $project: { thumbnail: 1, _id: 0 } }
            ],
            as: '_playlist'
        }
    },
    {
        $addFields: {
            playlist_thumbnail: { $arrayElemAt: ['$_playlist.thumbnail', 0] }
        }
    },
    { $project: { _playlist: 0 } }
];

// Pipeline stages that overwrite each audio doc's `plays` with the *derived*
// listen count = (number of audio-listen-log rows for the track) + the
// consolidated `archivedListens` (older rows folded into embed-audio by the
// consolidation worker). This is the single source of truth for listen counts;
// the stored `plays` field is no longer trusted (it held legacy count-on-load
// values and was reset to 0). Apply BEFORE a `$sort: { plays }` to sort by it,
// or after `$limit` to derive only the returned page.
const listenCountStages = [
    {
        $lookup: {
            from: 'audio-listen-log',
            let: { perm: '$permlink' },
            pipeline: [
                { $match: { $expr: { $eq: ['$permlink', '$$perm'] } } },
                { $count: 'c' },
            ],
            as: '_llc',
        },
    },
    {
        $addFields: {
            plays: {
                $add: [
                    { $ifNull: [{ $arrayElemAt: ['$_llc.c', 0] }, 0] },
                    { $ifNull: ['$archivedListens', 0] },
                ],
            },
        },
    },
    { $project: { _llc: 0 } },
];

// Build a Mongo permlink filter from one or more auto-tag names (OR semantics).
// Returns null if no valid tags. Always queries the subtitles-tags collection.
async function autoTagPermlinkFilter(db, raw) {
    if (!raw) return null;
    const list = (Array.isArray(raw) ? raw : [raw])
        .map(t => String(t).trim().toLowerCase())
        .filter(Boolean);
    if (list.length === 0) return null;
    const escaped = list.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const regex = `(^|,)\\s*(${escaped.join('|')})\\s*(,|$)`;
    const tagDocs = await db.collection('subtitles-tags').find({
        tags: { $regex: regex, $options: 'i' }
    }).project({ permlink: 1 }).toArray();
    return { $in: tagDocs.map(d => d.permlink) };
}

// ─── Pay-per-listen tracking ────────────────────────────────────────────────
// A track counts as "one listen" only when ≥66% of its duration has actually
// been *streamed* AND the listener was logged in. We do NOT trust a
// client-reported "I listened N seconds" number (trivially forged with curl).
// Instead:
//   1. POST /audio/play-start  → opens a server-side session, returns an
//      HMAC-bound token + heartbeat interval. Only a logged-in `username`
//      makes the session payable.
//   2. POST /audio/play-beat   → sent every ~10s while the audio is really
//      playing. The server credits the *wall-clock gap it measures* between
//      beats, clamped per beat — so faking one listen costs ~66% of the
//      track's real duration of kept-alive heartbeats, not one HTTP call.
// A credited session appends one row to `audio-listen-log`; the (future)
// payout program reads that, weighted/filtered by account.
const LISTEN_LOG_COLLECTION = 'audio-listen-log';
const LISTEN_SESSION_COLLECTION = 'audio-listen-sessions';
const LISTEN_THRESHOLD = 0.66;
const BEAT_SECONDS = 10;
// A single beat can credit at most this much real time (covers a slightly
// late beat / tab throttling) — a long gap from a paused/backgrounded tab is
// clamped, so silence is never counted.
const MAX_BEAT_CREDIT_MS = BEAT_SECONDS * 1000 * 1.6;
// Same listener (username, else IP) + same track within this window counts
// as one listen — guards replays / refresh loops.
const LISTEN_DEDUPE_MS = (parseInt(process.env.LISTEN_DEDUPE_MIN, 10) || 30) * 60 * 1000;
// Per-process secret. Sessions live only minutes (< one track), so losing
// them on restart is fine and we don't need a configured secret.
const SESSION_SECRET = crypto.randomBytes(32);

const HIVE_NAME_RE = /^[a-z][a-z0-9.-]{2,15}$/;

// Optional, env-gated heartbeat obfuscation. When LISTEN_BEAT_KEY is set the
// /play-beat body must be AES-256-GCM ciphertext keyed off it. NOTE: the
// frontend key ships in the public JS bundle, so this is *obfuscation /
// anti-casual-tampering*, NOT cryptographic protection — the real anti-forge
// guarantee is the server-measured wall-clock between beats. Unset → plain
// JSON beats (backward compatible).
const LISTEN_BEAT_KEY = process.env.LISTEN_BEAT_KEY || '';
const beatKeyBuf = LISTEN_BEAT_KEY
    ? crypto.createHash('sha256').update(LISTEN_BEAT_KEY).digest()
    : null;

// Layout: base64( iv[12] | ciphertext | gcmTag[16] ) — matches WebCrypto's
// AES-GCM output (tag appended to ciphertext).
function decryptBeat(encB64) {
    const raw = Buffer.from(String(encB64), 'base64');
    if (raw.length < 12 + 16 + 2) throw new Error('short');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const ct = raw.subarray(12, raw.length - 16);
    const d = crypto.createDecipheriv('aes-256-gcm', beatKeyBuf, iv);
    d.setAuthTag(tag);
    const pt = Buffer.concat([d.update(ct), d.final()]);
    return JSON.parse(pt.toString('utf8'));
}

let listenIndexesEnsured = false;
async function ensureListenIndexes(db) {
    if (listenIndexesEnsured) return;
    listenIndexesEnsured = true;
    try {
        const log = db.collection(LISTEN_LOG_COLLECTION);
        await log.createIndex({ username: 1, permlink: 1, createdAt: -1 }); // dedupe + payout
        await log.createIndex({ permlink: 1, createdAt: -1 });              // per-track payout
        await log.createIndex({ owner: 1, createdAt: -1 });                 // per-author payout
        const sess = db.collection(LISTEN_SESSION_COLLECTION);
        await sess.createIndex({ sid: 1 }, { unique: true });
        await sess.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL cleanup
    } catch (err) {
        listenIndexesEnsured = false;
        console.error('Failed to ensure audio-listen indexes:', err.message);
    }
}

// Binds the heartbeat token to the session, NOT to the listener's IP.
//
// The IP used to be in this HMAC, which forced us to keep it on the session row to
// re-derive the token on each beat. It is gone (2026-07-14), and nothing of value
// went with it:
//
//   • The listen LOG's `ip` was never read by anything. audioPayouts.js and
//     listenConsolidation.js pay out on username/permlink/owner/payable/ppl/
//     createdAt, and the double-credit guard is a username+permlink time window.
//     It was a write-only column — pure liability on the one collection tied to
//     real money AND to a real Hive identity.
//   • The anti-forge defence is untouched: `sid` is 16 random bytes, the secret is
//     per-process, and credit is still only the wall-clock gap the SERVER measures
//     between beats, clamped by MAX_BEAT_CREDIT_MS. An IP never stopped a forger —
//     they use their own.
function sessionToken(sid, permlink) {
    return crypto.createHmac('sha256', SESSION_SECRET)
        .update(`${sid}.${permlink}`).digest('hex');
}
function tokenMatches(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; }
}

// POST /audio/play-start — open a measured listen session
// body: { permlink, username? }   (username only credited if logged in)
router.post('/play-start', async (req, res) => {
    try {
        const db = getDb();
        await ensureListenIndexes(db);

        const permlink = typeof req.body?.permlink === 'string' ? req.body.permlink.trim() : '';
        if (!permlink || permlink.length > 256) {
            return res.status(400).json({ error: 'Invalid permlink' });
        }
        const rawName = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
        const username = HIVE_NAME_RE.test(rawName) ? rawName : null;

        const track = await db.collection('embed-audio').findOne(
            { permlink },
            { projection: { owner: 1, post_permlink: 1, duration: 1, ppl: 1 } }
        );
        if (!track) return res.status(404).json({ error: 'Unknown track' });

        // Only pay-per-listen tracks are worth a session. Non-PPL (or
        // not-yet-link-resolved) tracks: tell the client not to track —
        // saves the play-start follow-ups and all heartbeats.
        if (track.ppl !== true) {
            return res.json({ payable: false, ppl: false });
        }

        // Self-listen guard: an author streaming their own PPL track must
        // never earn from it (self-dealing). No session → no heartbeats,
        // no log row.
        if (username && track.owner && username === track.owner) {
            return res.json({ payable: false, ppl: true, reason: 'self' });
        }

        const duration = Number(track.duration);
        if (!Number.isFinite(duration) || duration <= 0) {
            return res.status(422).json({ error: 'Track has no duration' });
        }

        const sid = crypto.randomBytes(16).toString('hex');
        const durationMs = Math.round(duration * 1000);
        const now = new Date();

        await db.collection(LISTEN_SESSION_COLLECTION).insertOne({
            sid,
            permlink,
            owner: track.owner || null,
            post_permlink: track.post_permlink || null,
            durationMs,
            username,            // null → session can never be credited
            paid: !!username,
            accumulatedMs: 0,
            credited: false,
            startedAt: now,
            lastBeatAt: now,
            // Generous TTL: a few track-lengths so a paused tab can resume.
            expiresAt: new Date(Date.now() + durationMs * 4 + 5 * 60 * 1000),
        });

        res.json({
            sid,
            token: sessionToken(sid, permlink),
            beatSeconds: BEAT_SECONDS,
            threshold: LISTEN_THRESHOLD,
            payable: !!username,
            encrypted: !!beatKeyBuf,
        });
    } catch (error) {
        console.error('Error starting listen session:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /audio/play-beat — heartbeat while the audio is really playing
// body: { sid, token }  — or { enc } when LISTEN_BEAT_KEY is set
router.post('/play-beat', async (req, res) => {
    try {
        const db = getDb();

        let sid, token;
        if (beatKeyBuf) {
            if (typeof req.body?.enc !== 'string') {
                return res.status(400).json({ error: 'encryption_required' });
            }
            try {
                const dec = decryptBeat(req.body.enc);
                sid = typeof dec?.sid === 'string' ? dec.sid : '';
                token = typeof dec?.token === 'string' ? dec.token : '';
            } catch {
                return res.status(400).json({ error: 'bad_ciphertext' });
            }
        } else {
            sid = typeof req.body?.sid === 'string' ? req.body.sid : '';
            token = typeof req.body?.token === 'string' ? req.body.token : '';
        }
        if (!sid || !token) return res.status(400).json({ error: 'Invalid beat' });

        const sessions = db.collection(LISTEN_SESSION_COLLECTION);
        const s = await sessions.findOne({ sid });
        if (!s) return res.status(410).json({ error: 'no_session' });

        // Token is bound to the session's permlink — a sid alone can't be replayed
        // against another track. No transition shim is needed for the dropped IP
        // binding: SESSION_SECRET is per-process, so a restart already invalidates
        // every in-flight session's token no matter what it was HMAC'd over. The
        // client just reopens the session (sessions are shorter than one track).
        if (!tokenMatches(token, sessionToken(sid, s.permlink))) {
            return res.status(403).json({ error: 'bad_token' });
        }
        if (s.credited) {
            return res.json({ progress: 1, credited: true, done: true });
        }

        const now = Date.now();
        const gap = Math.max(0, now - new Date(s.lastBeatAt).getTime());
        // The crux: credit only the real elapsed time between beats, capped
        // so one delayed/forged beat can't claim a huge span.
        const credit = Math.min(gap, MAX_BEAT_CREDIT_MS);
        const accumulatedMs = s.accumulatedMs + credit;
        const qualifies = s.paid && s.username
            && accumulatedMs >= s.durationMs * LISTEN_THRESHOLD;

        let credited = false;
        if (qualifies) {
            // Atomically claim the credit exactly once for this session.
            const claim = await sessions.findOneAndUpdate(
                { sid, credited: { $ne: true } },
                { $set: { credited: true, accumulatedMs, lastBeatAt: new Date(now) } }
            );
            const won = claim?.value !== undefined ? claim.value : claim;
            if (won) {
                credited = true;
                const log = db.collection(LISTEN_LOG_COLLECTION);
                const dupe = await log.findOne({
                    username: s.username,
                    permlink: s.permlink,
                    createdAt: { $gt: new Date(now - LISTEN_DEDUPE_MS) },
                }, { projection: { _id: 1 } });
                if (!dupe) {
                    await log.insertOne({
                        username: s.username,
                        permlink: s.permlink,
                        owner: s.owner,
                        post_permlink: s.post_permlink,
                        listenedSeconds: Math.round(accumulatedMs / 1000),
                        trackDuration: Math.round(s.durationMs / 1000),
                        payable: true, // payout-eligible; snapieaudio writes payable:false for anon plays
                        ppl: true,     // checker only logs listens on ppl tracks
                        createdAt: new Date(now),
                        listenDate: new Date(now).toISOString().slice(0, 10), // UTC YYYY-MM-DD
                    });
                }
            }
        } else {
            await sessions.updateOne(
                { sid },
                { $set: { accumulatedMs, lastBeatAt: new Date(now) } }
            );
        }

        res.json({
            progress: Math.min(1, accumulatedMs / s.durationMs),
            credited,
            done: credited,
        });
    } catch (error) {
        console.error('Error recording listen beat:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /audio — list audio with optional filters
router.get('/', async (req, res) => {
    try {
        const db = getDb();
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
        const skip = (page - 1) * limit;

        const audioCollection = db.collection('embed-audio');

        const audioQuery = {
            status: 'published',
            ...nsfwFilter(req)
        };

        // Category filter (voice_message, podcast, audiobook, song, interview)
        applyCategoryFilter(audioQuery, req.query.category);

        // Genre filter (matches the `genre` field if set, else a case-insensitive
        // tag — old data without a genre field still benefits from any tag write).
        if (req.query.genre) {
            const g = String(req.query.genre).trim();
            if (g) {
                const escaped = g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(`^${escaped}$`, 'i');
                audioQuery.$and = (audioQuery.$and || []).concat([
                    { $or: [{ genre: regex }, { tags: regex }] },
                ]);
            }
        }

        // Tag filter
        if (req.query.tag) {
            audioQuery.tags = req.query.tag;
        }

        // Owner filter
        if (req.query.owner) {
            audioQuery.owner = req.query.owner;
        }

        // Exact-permlink lookup (used to resolve audio docs for playlist items, etc.)
        if (req.query.permlink) {
            audioQuery.permlink = req.query.permlink;
        }

        // Date filter (ISO string or days-ago shorthand)
        if (req.query.from) {
            const from = req.query.from;
            // If numeric, treat as "days ago"
            const days = parseInt(from);
            if (!isNaN(days) && days > 0) {
                audioQuery.createdAt = { $gte: new Date(Date.now() - days * 86400000) };
            } else {
                audioQuery.createdAt = { $gte: new Date(from) };
            }
        }

        // Auto-tag filter (from subtitles-tags). Accepts a single string or repeated values
        // (e.g. ?auto_tag=news&auto_tag=tech) — matched with OR semantics.
        const autoTagFilter = await autoTagPermlinkFilter(db, req.query.auto_tag);
        if (autoTagFilter) audioQuery.permlink = autoTagFilter;

        // Duration filter (seconds)
        const minDur = parseInt(req.query.min_duration);
        const maxDur = parseInt(req.query.max_duration);
        if ((!isNaN(minDur) && minDur > 0) || (!isNaN(maxDur) && maxDur > 0)) {
            audioQuery.duration = {};
            if (!isNaN(minDur) && minDur > 0) audioQuery.duration.$gte = minDur;
            if (!isNaN(maxDur) && maxDur > 0) audioQuery.duration.$lte = maxDur;
        }

        // Search by title/description
        if (req.query.q) {
            const search = req.query.q.trim();
            audioQuery.$or = [
                { title: { $regex: search, $options: 'i' } },
                { description: { $regex: search, $options: 'i' } },
                { owner: { $regex: search, $options: 'i' } },
            ];
        }

        // Sort: popular = derived listen count, else newest/duration.
        const popularSort = req.query.sort === 'popular';
        let sort = { createdAt: -1 };
        if (popularSort) sort = { plays: -1, createdAt: -1 };
        if (req.query.sort === 'longest') sort = { duration: -1 };
        if (req.query.sort === 'shortest') sort = { duration: 1 };

        const total = await audioCollection.countDocuments(audioQuery);
        const totalPages = Math.ceil(total / limit);

        // Subtitle-language join (extract available language keys).
        const subtitleStages = [
            {
                $lookup: {
                    from: 'subtitles',
                    let: { perm: '$permlink' },
                    pipeline: [
                        { $match: { $expr: { $eq: ['$permlink', '$$perm'] } } },
                        { $project: { subtitles: 1, _id: 0 } }
                    ],
                    as: '_subs'
                }
            },
            {
                $addFields: {
                    subtitle_languages: {
                        $cond: {
                            if: { $gt: [{ $size: '$_subs' }, 0] },
                            then: { $objectToArray: { $arrayElemAt: ['$_subs.subtitles', 0] } },
                            else: []
                        }
                    }
                }
            },
            {
                $addFields: {
                    subtitle_languages: { $map: { input: '$subtitle_languages', as: 'l', in: '$$l.k' } }
                }
            },
            { $project: { _subs: 0 } },
        ];

        // Derive `plays` from the listen log. When sorting by popularity the
        // derived count must exist before the $sort; otherwise derive it after
        // paging so only the returned page pays for the lookup.
        const pipeline = [{ $match: audioQuery }];
        if (popularSort) {
            pipeline.push(...listenCountStages, { $sort: sort }, { $skip: skip }, { $limit: limit });
        } else {
            pipeline.push({ $sort: sort }, { $skip: skip }, { $limit: limit }, ...listenCountStages);
        }
        pipeline.push(...subtitleStages, ...playlistJoin);

        // Optionally join auto-generated tags from subtitles-tags
        if (req.query.include_auto_tags === 'true') {
            pipeline.push(
                {
                    $lookup: {
                        from: 'subtitles-tags',
                        let: { perm: '$permlink' },
                        pipeline: [
                            { $match: { $expr: { $eq: ['$permlink', '$$perm'] } } },
                            { $project: { tags: 1, _id: 0 } }
                        ],
                        as: '_autoTags'
                    }
                },
                {
                    $addFields: {
                        auto_tags: {
                            $cond: {
                                if: { $gt: [{ $size: '$_autoTags' }, 0] },
                                then: { $arrayElemAt: ['$_autoTags.tags', 0] },
                                else: null
                            }
                        }
                    }
                },
                { $project: { _autoTags: 0 } }
            );
        }

        const audio = await audioCollection.aggregate(pipeline).toArray();

        res.json({
            page,
            limit,
            total,
            totalPages,
            audio
        });
    } catch (error) {
        console.error('Error fetching audio:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /audio/grouped — returns audio grouped by category (for homepage-like layout)
router.get('/grouped', async (req, res) => {
    try {
        const db = getDb();
        const audioCollection = db.collection('embed-audio');
        const perGroup = Math.min(parseInt(req.query.limit) || 10, 30);

        // Optional date filter
        const baseMatch = { status: 'published' };
        if (req.query.from) {
            const days = parseInt(req.query.from);
            if (!isNaN(days) && days > 0) {
                baseMatch.createdAt = { $gte: new Date(Date.now() - days * 86400000) };
            }
        }

        // Duration filter (seconds)
        const minDur = parseInt(req.query.min_duration);
        const maxDur = parseInt(req.query.max_duration);
        if ((!isNaN(minDur) && minDur > 0) || (!isNaN(maxDur) && maxDur > 0)) {
            baseMatch.duration = {};
            if (!isNaN(minDur) && minDur > 0) baseMatch.duration.$gte = minDur;
            if (!isNaN(maxDur) && maxDur > 0) baseMatch.duration.$lte = maxDur;
        }

        const categories = ['podcast', 'voice_message', 'song', 'audiobook', 'interview'];
        const groups = {};

        // Shared pipeline stages to join subtitle languages
        const subtitleJoin = [
            {
                $lookup: {
                    from: 'subtitles',
                    let: { perm: '$permlink' },
                    pipeline: [
                        { $match: { $expr: { $eq: ['$permlink', '$$perm'] } } },
                        { $project: { subtitles: 1, _id: 0 } }
                    ],
                    as: '_subs'
                }
            },
            {
                $addFields: {
                    subtitle_languages: {
                        $cond: {
                            if: { $gt: [{ $size: '$_subs' }, 0] },
                            then: { $map: { input: { $objectToArray: { $arrayElemAt: ['$_subs.subtitles', 0] } }, as: 'l', in: '$$l.k' } },
                            else: []
                        }
                    }
                }
            },
            { $project: { _subs: 0 } },
            ...playlistJoin
        ];

        // Fetch each category in parallel
        await Promise.all(categories.map(async (cat) => {
            const items = await audioCollection.aggregate([
                { $match: { ...baseMatch, ...categoryMatchClause(cat) } },
                { $sort: { createdAt: -1 } },
                { $limit: perGroup },
                ...listenCountStages,
                ...subtitleJoin
            ]).toArray();
            if (items.length > 0) {
                groups[cat] = items;
            }
        }));

        // Also fetch "popular" across all categories. Combines both changes:
        //  - constrained to a recent window + a decaying recency boost for
        //    brand-new audio (so fresh tracks surface and old tracks with years
        //    of plays don't dominate), honoring a tighter caller `from`, and
        //  - the popularity signal is the DERIVED listen count (listenCountStages
        //    sets `plays` = audio-listen-log rows + archivedListens), since the
        //    stored `plays` field is no longer trusted.
        const POPULAR_WINDOW_DAYS = 60;
        const POPULAR_BOOST_DAYS = 7;
        const POPULAR_RECENCY_BOOST = 3;
        const popularWindowStart = new Date(Date.now() - POPULAR_WINDOW_DAYS * 86400000);
        const callerFrom = baseMatch.createdAt?.$gte;
        const popularMatch = {
            ...baseMatch,
            // Note: no `plays` filter here — the stored field is reset; we filter
            // on the derived count after listenCountStages below.
            createdAt: { $gte: callerFrom && callerFrom > popularWindowStart ? callerFrom : popularWindowStart },
        };
        const popular = await audioCollection.aggregate([
            { $match: popularMatch },
            ...listenCountStages,
            { $match: { plays: { $gt: 0 } } },
            {
                $addFields: {
                    _ageDays: { $divide: [{ $subtract: ['$$NOW', '$createdAt'] }, 86400000] },
                },
            },
            {
                $addFields: {
                    _score: {
                        $multiply: [
                            { $ifNull: ['$plays', 0] },
                            {
                                $add: [
                                    1,
                                    {
                                        $multiply: [
                                            POPULAR_RECENCY_BOOST,
                                            { $max: [0, { $divide: [{ $subtract: [POPULAR_BOOST_DAYS, '$_ageDays'] }, POPULAR_BOOST_DAYS] }] },
                                        ],
                                    },
                                ],
                            },
                        ],
                    },
                },
            },
            { $sort: { _score: -1, createdAt: -1 } },
            { $limit: perGroup },
            ...subtitleJoin,
            { $project: { _ageDays: 0, _score: 0 } },
        ]).toArray();
        if (popular.length > 0) {
            groups.popular = popular;
        }

        // Recent (newest across all)
        const recent = await audioCollection.aggregate([
            { $match: baseMatch },
            { $sort: { createdAt: -1 } },
            { $limit: perGroup },
            ...listenCountStages,
            ...subtitleJoin
        ]).toArray();
        if (recent.length > 0) {
            groups.recent = recent;
        }

        res.json({ groups });
    } catch (error) {
        console.error('Error fetching grouped audio:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /audio/categories — list distinct categories with counts
router.get('/categories', async (req, res) => {
    try {
        const db = getDb();
        const audioCollection = db.collection('embed-audio');

        const categories = await audioCollection.aggregate([
            { $match: { status: 'published' } },
            { $group: { _id: '$category', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
        ]).toArray();

        res.json({
            categories: categories.map(c => ({ name: c._id || 'uncategorized', count: c.count })),
        });
    } catch (error) {
        console.error('Error fetching audio categories:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /audio/tags — list top tags with counts
router.get('/tags', async (req, res) => {
    try {
        const db = getDb();
        const audioCollection = db.collection('embed-audio');
        const limit = Math.min(parseInt(req.query.limit) || 30, 100);

        const tags = await audioCollection.aggregate([
            { $match: { status: 'published', tags: { $exists: true, $ne: [] } } },
            { $unwind: '$tags' },
            { $group: { _id: '$tags', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: limit },
        ]).toArray();

        res.json({
            tags: tags.map(t => ({ name: t._id, count: t.count })),
        });
    } catch (error) {
        console.error('Error fetching audio tags:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /audio/auto-tags — list top auto-generated tags from subtitles-tags
// (for audio entries that have been processed)
router.get('/auto-tags', async (req, res) => {
    try {
        const db = getDb();
        const limit = Math.min(parseInt(req.query.limit) || 20, 50);

        // Get audio permlinks
        const audioPermlinks = await db.collection('embed-audio')
            .find({ status: 'published' })
            .project({ permlink: 1 })
            .toArray();

        const permlinks = audioPermlinks.map(a => a.permlink);

        // Find matching subtitles-tags
        const tagDocs = await db.collection('subtitles-tags')
            .find({ permlink: { $in: permlinks } })
            .toArray();

        // Parse comma-separated tags and count
        const tagCounts = {};
        for (const doc of tagDocs) {
            const tags = (doc.tags || '').split(',').map(t => t.trim()).filter(Boolean);
            for (const t of tags) {
                tagCounts[t] = (tagCounts[t] || 0) + 1;
            }
        }

        const sorted = Object.entries(tagCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit)
            .map(([name, count]) => ({ name, count }));

        res.json({ tags: sorted, total_tagged: tagDocs.length });
    } catch (error) {
        console.error('Error fetching auto tags:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /audio/creators — list audio creators, optionally filtered
router.get('/creators', async (req, res) => {
    try {
        const db = getDb();
        const audioCollection = db.collection('embed-audio');
        const limit = Math.min(parseInt(req.query.limit) || 20, 50);

        const audioQuery = {
            status: 'published',
            ...nsfwFilter(req),
        };

        // Date filter (days-ago shorthand or ISO)
        if (req.query.from) {
            const days = parseInt(req.query.from);
            if (!isNaN(days) && days > 0) {
                audioQuery.createdAt = { $gte: new Date(Date.now() - days * 86400000) };
            } else {
                audioQuery.createdAt = { $gte: new Date(req.query.from) };
            }
        }

        // Duration filter (seconds)
        const minDur = parseInt(req.query.min_duration);
        const maxDur = parseInt(req.query.max_duration);
        if ((!isNaN(minDur) && minDur > 0) || (!isNaN(maxDur) && maxDur > 0)) {
            audioQuery.duration = {};
            if (!isNaN(minDur) && minDur > 0) audioQuery.duration.$gte = minDur;
            if (!isNaN(maxDur) && maxDur > 0) audioQuery.duration.$lte = maxDur;
        }

        // Auto-tag filter (single or repeated; OR semantics)
        const autoTagFilter = await autoTagPermlinkFilter(db, req.query.auto_tag);
        if (autoTagFilter) audioQuery.permlink = autoTagFilter;

        // Category + genre filters (mirrors /audio)
        applyCategoryFilter(audioQuery, req.query.category);
        if (req.query.genre) {
            const g = String(req.query.genre).trim();
            if (g) {
                const escaped = g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(`^${escaped}$`, 'i');
                audioQuery.$and = (audioQuery.$and || []).concat([
                    { $or: [{ genre: regex }, { tags: regex }] },
                ]);
            }
        }

        // Get distinct audio creators with play counts (within the filtered set).
        // Derive each track's listen count first, then sum per owner.
        const creators = await audioCollection.aggregate([
            { $match: audioQuery },
            ...listenCountStages,
            { $group: {
                _id: '$owner',
                tracks: { $sum: 1 },
                totalPlays: { $sum: { $ifNull: ['$plays', 0] } },
                latestTrack: { $max: '$createdAt' },
            }},
            { $sort: { totalPlays: -1 } },
            { $limit: limit },
        ]).toArray();

        res.json({
            creators: creators.map(c => ({
                owner: c._id,
                tracks: c.tracks,
                totalPlays: c.totalPlays,
                latestTrack: c.latestTrack,
                avatar: `https://images.hive.blog/u/${c._id}/avatar/small`,
            })),
        });
    } catch (error) {
        console.error('Error fetching audio creators:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Playlist `metadata` is stored as JSON (json.RawMessage) — via the Node
// driver it can arrive as an object, a BSON Binary, or a base64 string.
function decodePlaylistMeta(m) {
    try {
        if (!m) return null;
        if (typeof m === 'object' && m._bsontype === 'Binary') return JSON.parse(m.buffer.toString('utf8'));
        if (Buffer.isBuffer(m)) return JSON.parse(m.toString('utf8'));
        if (typeof m === 'string') {
            // Could be raw JSON or base64-encoded JSON.
            try { return JSON.parse(m); } catch { return JSON.parse(Buffer.from(m, 'base64').toString('utf8')); }
        }
        if (typeof m === 'object') return m;
    } catch { /* ignore */ }
    return null;
}

// GET /audio/playlists — public playlists that contain music, split into:
//   by_artist    → every track is by the playlist creator
//   by_listeners → contains at least one track by someone else
router.get('/playlists', async (req, res) => {
    try {
        const db = getDb();
        const perGroup = Math.min(Math.max(parseInt(req.query.limit) || 24, 1), 60);

        // Recent public playlists that actually have items.
        const candidates = await db.collection('playlists').find({
            access: 'public',
            owner: { $type: 'string', $ne: '' },
            'items.0': { $exists: true },
        }).sort({ last_modified_block: -1, _id: -1 }).limit(400).toArray();

        if (candidates.length === 0) return res.json({ by_artist: [], by_listeners: [] });

        // Resolve which (author, permlink) pairs are audio tracks in one query.
        // Apply the SAME content filters as the audio page so filtering by
        // e.g. category "Music" keeps albums whose tracks match.
        const permlinks = [...new Set(candidates.flatMap(p => (p.items || []).map(i => i.permlink)))];
        const audioQuery = { post_permlink: { $in: permlinks }, status: 'published' };
        applyCategoryFilter(audioQuery, req.query.category);
        if (req.query.genre) {
            const g = String(req.query.genre).trim();
            if (g) {
                const esc = g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const rx = new RegExp(`^${esc}$`, 'i');
                audioQuery.$and = (audioQuery.$and || []).concat([{ $or: [{ genre: rx }, { tags: rx }] }]);
            }
        }
        if (req.query.q) {
            const s = String(req.query.q).trim();
            audioQuery.$and = (audioQuery.$and || []).concat([
                { $or: [
                    { title: { $regex: s, $options: 'i' } },
                    { owner: { $regex: s, $options: 'i' } },
                ] },
            ]);
        }
        const audioDocs = await db.collection('embed-audio').find(
            audioQuery,
            { projection: { owner: 1, permlink: 1, post_permlink: 1, title: 1, thumbnail_url: 1, duration: 1, audio_cid: 1, category: 1 } },
        ).toArray();
        const audioByKey = new Map();
        for (const a of audioDocs) audioByKey.set(`${a.owner}|${a.post_permlink}`, a);

        const by_artist = [];
        const by_listeners = [];

        for (const p of candidates) {
            const items = p.items || [];
            const audioItems = items.filter(it => audioByKey.has(`${it.author}|${it.permlink}`));
            if (audioItems.length === 0) continue; // not a music playlist

            // User's rule: only the creator's tracks → by artist; any track
            // from someone else → by listeners.
            const onlyCreator = items.every(it => it.author === p.owner);
            const meta = decodePlaylistMeta(p.metadata);
            // Full ordered, playable track list (embed-audio doc shape the
            // audio player/queue expects) — ordered by playlist position.
            const tracks = audioItems
                .slice()
                .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
                .slice(0, 200)
                .map(it => {
                    const a = audioByKey.get(`${it.author}|${it.permlink}`);
                    return {
                        _id: String(a._id),
                        owner: a.owner,
                        permlink: a.permlink,
                        post_permlink: a.post_permlink,
                        title: a.title,
                        audio_cid: a.audio_cid,
                        thumbnail_url: a.thumbnail_url || null,
                        duration: a.duration,
                        category: a.category || null,
                    };
                });
            // Cover priority: playlist's own image → album meta → any track
            // art → the creator's Hive avatar (never empty).
            const thumbnail = p.thumbnail
                || meta?.album?.thumbnail
                || tracks.find(t => t.thumbnail_url)?.thumbnail_url
                || `https://images.hive.blog/u/${p.owner}/avatar`;

            const entry = {
                id: String(p._id),
                name: p.name || 'Untitled playlist',
                owner: p.owner,
                thumbnail,
                trackCount: tracks.length,
                totalItems: items.length,
                artists: [...new Set(items.map(it => it.author))].slice(0, 6),
                album: meta?.album || null,
                tracks,
                updatedAt: p.updated_at || p.created_at || null,
            };
            (onlyCreator ? by_artist : by_listeners).push(entry);
        }

        const sortRecent = (a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
        res.json({
            by_artist: by_artist.sort(sortRecent).slice(0, perGroup),
            by_listeners: by_listeners.sort(sortRecent).slice(0, perGroup),
        });
    } catch (error) {
        console.error('Error fetching audio playlists:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /audio/:permlink/subtitles — get subtitles for an audio track
router.get('/:permlink/subtitles', async (req, res) => {
    try {
        const db = getDb();
        const { permlink } = req.params;

        const subtitle = await db.collection('subtitles').findOne({ permlink });
        if (!subtitle) {
            return res.json({ found: false, subtitles: null });
        }

        res.json({ found: true, subtitles: subtitle });
    } catch (error) {
        console.error('Error fetching audio subtitles:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
