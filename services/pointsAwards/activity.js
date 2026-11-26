/**
 * Who watched and listened to what, for the 3Speak Points watch and listen kinds.
 *
 * The player and the checker's own audio tracker time every playback themselves
 * (dev-player watchTracking.js, routes/audioListen.js), but their durable rows
 * (view-durations, listen-durations) are anonymous on purpose. The NAME of a
 * viewer only sits on the open session, which expires minutes after playback:
 *   view-sessions    `viewer`, the 3speak.tv viewer (or a partner app's signed one)
 *   listen-sessions  `listener`, only when our own API vouched for it
 * So every few minutes this copies the named sessions into `points-activity`,
 * one row per (person, item, UTC day):
 *   { kind: 'watch'|'listen', user, item: '<owner>/<player key>', post: '<hive author>/<permlink>'|null,
 *     owner, short, day, secs, pct, firstAt, at, expires_at }
 * `secs` is the seconds that count: for video the content watched ON SCREEN
 * (speed-corrected, a background tab does not build it), for audio the
 * wall-clock listening (audio is made to run in the background). `pct` is the
 * share of the timeline really seen or heard (distinct slices, so seeking to the
 * end is not finishing). Both only ever go up ($max): several sessions of one
 * item on one day count as the best of them, not as their sum.
 *
 * Not stored: your own videos and audio, private mode, live streams, embeds on
 * other sites (they have no viewer), outside podcast episodes (no 3Speak owner to
 * tell "not your own" by). Rows go after ROW_TTL_DAYS.
 *
 * Only runs while 3Speak Points awards are on (POINTS_AWARD_URL + secret).
 */

const { ENABLE_MONGO_WRITES } = require('../../utils/config');
const { name, postKey, dayKey, DAY_MS } = require('./common');

const ACTIVITY = 'points-activity';
const VIEW_SESSIONS = process.env.WATCH_SESSION_COLLECTION || 'view-sessions';
const LISTEN_SESSIONS = 'listen-sessions';
const VIDEO_TYPES = ['embed', 'legacy'];
const ROW_TTL_DAYS = 30;

const coverage = (s) => {
    const n = Number(s.bucketCount) || 0;
    const covered = Array.isArray(s.coveredBuckets) ? new Set(s.coveredBuckets).size : 0;
    return n > 0 ? Math.min(100, Math.round((covered / n) * 1000) / 10) : 0;
};

/** One `points-activity` upsert from a watch or listen session, or null when it does not count. */
function rowOf(kind, s, meta, now) {
    const user = name(kind === 'watch' ? s.viewer : s.listener);
    const owner = name(s.owner);
    const key = kind === 'watch' ? s.permlink : s.id;
    if (!user || !owner || !key) return null;
    const post = meta.post || null;
    if (user === owner || (post && post.split('/')[0] === user)) return null;
    const ms = kind === 'watch' ? (s.visibleContentMs ?? s.contentMs) : s.accumulatedMs;
    const secs = Math.round((Number(ms) || 0) / 1000);
    if (!(secs > 0)) return null;
    const day = dayKey(s.startedAt);
    const item = `${owner}/${key}`;
    return {
        updateOne: {
            filter: { _id: `${kind}|${user}|${item}|${day}` },
            update: {
                $set: {
                    kind, user, item, owner, day, short: !!meta.short,
                    ...(post ? { post } : {}),
                    expires_at: new Date(now + ROW_TTL_DAYS * DAY_MS),
                },
                $max: { secs, pct: coverage(s), at: new Date(s.lastBeatAt) },
                $min: { firstAt: new Date(s.startedAt) },
            },
            upsert: true,
        },
    };
}

/** The Hive post (and Short flag) behind each session's player key. */
async function videoMeta(db, sessions) {
    const keys = [...new Set(sessions.filter((s) => s.type === 'embed').map((s) => s.permlink))];
    const rows = keys.length ? await db.collection('embed-video')
        .find({ permlink: { $in: keys } }, { projection: { _id: 0, owner: 1, permlink: 1, short: 1, hive_author: 1, hive_permlink: 1 } })
        .toArray() : [];
    const byKey = new Map(rows.map((r) => [`${r.owner}/${r.permlink}`, r]));
    return (s) => {
        if (s.type === 'legacy') return { post: postKey(s.owner, s.permlink), short: false };
        const r = byKey.get(`${s.owner}/${s.permlink}`);
        return r ? { post: postKey(r.hive_author, r.hive_permlink), short: !!r.short } : {};
    };
}

async function audioMeta(db, sessions) {
    const keys = [...new Set(sessions.map((s) => s.id))];
    const rows = keys.length ? await db.collection('embed-audio')
        .find({ permlink: { $in: keys } }, { projection: { _id: 0, owner: 1, permlink: 1, post_permlink: 1 } })
        .toArray() : [];
    const byKey = new Map(rows.map((r) => [r.permlink, r]));
    return (s) => {
        const r = byKey.get(s.id);
        return r && r.owner === s.owner ? { post: postKey(r.owner, r.post_permlink) } : {};
    };
}

/** Copy the named sessions with a heartbeat since `since` into points-activity. */
async function syncActivity({ db, since, now = Date.now() }) {
    if (!ENABLE_MONGO_WRITES) return { sessions: 0, written: 0 };
    const [views, listens] = await Promise.all([
        db.collection(VIEW_SESSIONS).find(
            { lastBeatAt: { $gte: since }, viewer: { $type: 'string' }, type: { $in: VIDEO_TYPES }, private: { $ne: true } },
            { projection: { _id: 0, viewer: 1, owner: 1, permlink: 1, type: 1, contentMs: 1, visibleContentMs: 1, coveredBuckets: 1, bucketCount: 1, startedAt: 1, lastBeatAt: 1 } },
        ).toArray(),
        db.collection(LISTEN_SESSIONS).find(
            { lastBeatAt: { $gte: since }, listener: { $type: 'string' }, kind: 'audio', source: '3speak', private: { $ne: true } },
            { projection: { _id: 0, listener: 1, owner: 1, id: 1, accumulatedMs: 1, coveredBuckets: 1, bucketCount: 1, startedAt: 1, lastBeatAt: 1 } },
        ).toArray(),
    ]);
    const vMeta = await videoMeta(db, views);
    const aMeta = await audioMeta(db, listens);
    const ops = [
        ...views.map((s) => rowOf('watch', s, vMeta(s), now)),
        ...listens.map((s) => rowOf('listen', s, aMeta(s), now)),
    ].filter(Boolean);
    if (ops.length) await db.collection(ACTIVITY).bulkWrite(ops, { ordered: false });
    return { sessions: views.length + listens.length, written: ops.length };
}

async function ensureActivityIndexes(db) {
    const c = db.collection(ACTIVITY);
    await c.createIndex({ kind: 1, day: 1 }, { name: 'activity_day' });
    await c.createIndex({ kind: 1, at: 1 }, { name: 'activity_at' });
    await c.createIndex({ post: 1 }, { name: 'activity_post' });
    await c.createIndex({ item: 1 }, { name: 'activity_item' });
    await c.createIndex({ user: 1, pct: 1 }, { name: 'activity_user' });
    await c.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0, name: 'activity_ttl' });
}

module.exports = { syncActivity, ensureActivityIndexes, ACTIVITY, ROW_TTL_DAYS, _test: { rowOf, coverage } };
