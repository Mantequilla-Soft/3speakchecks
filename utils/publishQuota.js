/**
 * Daily PUBLISH limit, the Mongo side (utils/publishLimit.js has the rules and
 * the window arithmetic): which publishes of an owner count, who is exempt, and
 * the answer GET /publish-quota/:owner and the scheduled-posts routes share.
 *
 * What counts as a publish of an owner, per kind:
 *   1. scheduled-posts docs in status scheduled, processing or posted, at their
 *      scheduledOn. The kind is the embed-video row of (owner, embedPermlink ||
 *      permlink): `short: true` = 'short', else 'video'. Audio posts
 *      (audioPermlink) never count; a post whose embed row is missing has no
 *      known kind and does not count either (fail open).
 *   2. embed-video rows of the owner that are on Hive (hive_permlink set), not
 *      deleted, not a stream VOD, not a media replacement, and not already
 *      counted through a scheduled post, at their createdAt (a "publish now"
 *      goes out right after the upload).
 * Drafts (no time yet), cancelled and failed posts never count.
 *
 * Exempt: accounts in PUBLISH_LIMIT_EXEMPT ('listed'), current 3Speak Pro
 * subscribers in embed-users ('pro'), and warm-up handles, which have no Hive
 * account yet and cannot schedule ('warmup', asked of the hosted incubation
 * service through utils/warmupAudio.js).
 *
 * Every caller fails open: a lookup that throws lets the publish through.
 */
const { getDb } = require('./db');
const { isStreamVod } = require('./streamVod');
const { isWarmupHandle } = require('./warmupAudio');
const {
    WINDOW_HOURS, WINDOW_MS, limitsConfig, isListed, allowedAt, nextFreeAt, conflictsAt, limitMessage,
} = require('./publishLimit');

const SCHEDULED = 'scheduled-posts';
const COUNTED_STATUSES = ['scheduled', 'processing', 'posted'];
// Scheduled posts reach at most 90 days ahead (routes/scheduledPosts.js), so the
// next free time is never searched further than that plus two windows.
const MAX_LEAD_MS = 90 * 24 * 3600 * 1000;
const MAX_ROWS = 2000;

const upgradeUrl = (owner) => `https://3speak.tv/wallet/${encodeURIComponent(owner)}#pro`;

/** A stream recording? The verdict stamped at upload wins; older rows by their app and name. */
function isVodRow(row) {
    if (row.stream_vod === true) return true;
    if (row.stream_vod === false) return false;
    return isStreamVod(row);
}

/** Is this account a current 3Speak Pro subscriber (embed-users, as GET /premium/:username)? */
async function isPro(db, owner) {
    const user = await db.collection('embed-users').findOne(
        { username: owner, premium: true },
        { projection: { _id: 0, premium_expires_at: 1 } },
    );
    if (!user) return false;
    const exp = user.premium_expires_at ? new Date(user.premium_expires_at).getTime() : null;
    return !Number.isFinite(exp) || exp > Date.now(); // a lapsed day pass is not Pro
}

/**
 * Why the limit skips this owner: 'listed', 'pro', 'warmup', or null. The
 * scheduled-posts routes pass `warmup: false`: the owner there has granted
 * @threespeak posting authority on Hive, so it is no warm-up handle.
 */
async function exemptionOf(db, owner, cfg, { warmup = true } = {}) {
    if (isListed(owner, cfg)) return 'listed';
    if (await isPro(db, owner)) return 'pro';
    if (warmup) {
        try {
            if (await isWarmupHandle(owner)) return 'warmup';
        } catch (_) { /* the service did not answer: treat as a Hive account */ }
    }
    return null;
}

/** The kind of the embed-video rows of these permlinks: Map permlink -> 'video' | 'short'. */
async function kindsOf(db, owner, permlinks) {
    const wanted = [...new Set(permlinks.filter(Boolean))];
    if (!wanted.length) return new Map();
    const rows = await db.collection('embed-video').find(
        { owner, permlink: { $in: wanted } },
        { projection: { _id: 0, permlink: 1, short: 1 } },
    ).toArray();
    return new Map(rows.map((r) => [r.permlink, r.short === true ? 'short' : 'video']));
}

/**
 * The kind of a scheduled post (a doc or a create body): 'video', 'short', or
 * null for an audio post or one whose embed row is not there.
 */
async function kindOfPost(db, owner, post) {
    if (!post || post.audioPermlink) return null;
    const key = post.embedPermlink || post.permlink;
    return (await kindsOf(db, owner, [key])).get(key) || null;
}

/**
 * The publishes of `kind` by `owner` between `from` and `to` (ms), as
 * { permlink, title, at: Date, scheduled }. `exclude` names a scheduled post
 * (its Hive permlink) that never counts against itself.
 */
async function publishesOf(db, owner, kind, from, to, exclude = '') {
    const range = { $gte: new Date(from), $lt: new Date(to) };
    const posts = await db.collection(SCHEDULED).find(
        { owner, status: { $in: COUNTED_STATUSES }, scheduledOn: range },
        { projection: { _id: 0, permlink: 1, title: 1, scheduledOn: 1, status: 1, embedPermlink: 1, audioPermlink: 1 } },
    ).sort({ scheduledOn: 1 }).limit(MAX_ROWS).toArray();
    const videoPosts = posts.filter((p) => !p.audioPermlink);
    const kinds = await kindsOf(db, owner, videoPosts.map((p) => p.embedPermlink || p.permlink));
    const out = videoPosts
        .filter((p) => p.permlink !== exclude && kinds.get(p.embedPermlink || p.permlink) === kind)
        .map((p) => ({ permlink: p.permlink, title: p.title || '', at: p.scheduledOn, scheduled: p.status !== 'posted' }));

    const rows = (await db.collection('embed-video').find(
        {
            owner,
            createdAt: range,
            hive_permlink: { $nin: [null, ''] },
            status: { $ne: 'deleted' },
            short: kind === 'short' ? true : { $ne: true },
        },
        {
            projection: {
                _id: 0, permlink: 1, short: 1, createdAt: 1, hive_permlink: 1, hive_title: 1, embed_title: 1, title: 1,
                stream_vod: 1, frontend_app: 1, is_openpod_stream: 1, originalFilename: 1, replacesPermlink: 1,
            },
        },
    ).sort({ createdAt: 1 }).limit(MAX_ROWS).toArray())
        .filter((r) => !isVodRow(r) && !r.replacesPermlink && r.hive_permlink !== exclude && r.permlink !== exclude);
    if (!rows.length) return out;

    // Already counted through its scheduled post (whenever that one is due),
    // the post being rescheduled included.
    const covering = await db.collection(SCHEDULED).find(
        {
            owner,
            status: { $in: COUNTED_STATUSES },
            $or: [
                { permlink: { $in: [...new Set(rows.flatMap((r) => [r.hive_permlink, r.permlink]))] } },
                { embedPermlink: { $in: rows.map((r) => r.permlink) } },
            ],
        },
        { projection: { _id: 0, permlink: 1, embedPermlink: 1 } },
    ).toArray();
    const coveredHive = new Set(covering.map((p) => p.permlink));
    const coveredEmbed = new Set(covering.map((p) => p.embedPermlink || p.permlink));
    const seen = new Set(out.map((p) => p.permlink));
    for (const r of rows) {
        if (coveredHive.has(r.hive_permlink) || coveredEmbed.has(r.permlink) || seen.has(r.hive_permlink)) continue;
        seen.add(r.hive_permlink);
        out.push({ permlink: r.hive_permlink, title: r.hive_title || r.embed_title || r.title || '', at: r.createdAt, scheduled: false });
    }
    return out;
}

/**
 * The quota answer for a publish of `kind` by `owner` at `at` (ms): the body of
 * GET /publish-quota/:owner without `success`. Throws on a lookup error; the
 * callers fail open.
 */
async function quotaFor(owner, kind, at, { exclude = '', warmup = true } = {}) {
    const cfg = limitsConfig();
    const limit = cfg.limits[kind];
    const base = { enabled: cfg.enabled, exempt: false, reason: null, kind, limit, window_hours: WINDOW_HOURS, at: new Date(at).toISOString() };
    const open = { allowed: true, conflicts: [], next_free_at: null };
    if (!cfg.enabled) return { ...base, ...open };

    const db = getDb();
    const reason = await exemptionOf(db, owner, cfg, { warmup });
    if (reason) return { ...base, exempt: true, reason, ...open };

    const now = Date.now();
    const start = Math.max(at, now);
    const to = Math.max(start, now + MAX_LEAD_MS) + 2 * WINDOW_MS;
    const publishes = await publishesOf(db, owner, kind, at - WINDOW_MS, to, exclude);
    const times = publishes.map((p) => p.at.getTime());
    const next = nextFreeAt(times, start, limit);
    return {
        ...base,
        allowed: allowedAt(times, at, limit),
        conflicts: conflictsAt(publishes, at),
        next_free_at: next === null ? null : new Date(next).toISOString(),
    };
}

/**
 * For the scheduled-posts routes: the 429 body when `post` (a create body or a
 * stored doc: permlink, embedPermlink, audioPermlink) may not go out at `at`
 * (ms), or null when it may. Never throws: any lookup error lets it through.
 */
async function publishLimitRefusal(owner, post, at) {
    try {
        if (!limitsConfig().enabled) return null;
        const kind = await kindOfPost(getDb(), owner, post);
        if (!kind) return null;
        const q = await quotaFor(owner, kind, at, { exclude: post.permlink, warmup: false });
        if (q.allowed) return null;
        return {
            error: limitMessage(kind, q.limit, q.next_free_at),
            code: 'daily_publish_limit',
            kind,
            limit: q.limit,
            conflicts: q.conflicts,
            next_free_at: q.next_free_at,
            upgrade_url: upgradeUrl(owner),
        };
    } catch (err) {
        console.warn(`[publishQuota] limit check for @${owner} failed, letting it through:`, err.message || err);
        return null;
    }
}

module.exports = { quotaFor, publishLimitRefusal, publishesOf, kindOfPost, exemptionOf, upgradeUrl, COUNTED_STATUSES };
