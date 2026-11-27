/**
 * The watch and listen kinds of 3Speak Points, from `points-activity`
 * (services/pointsAwards/activity.js, other people's content only):
 *
 *   first5    5+ minutes of video watched on a UTC day, sent as soon as it is
 *             reached (no units, so nothing can change afterwards)
 *   vodtime   the minutes of video watched on a finished UTC day (units = minutes)
 *   listen    the minutes of 3Speak audio heard on a finished UTC day (units = minutes)
 *   finish    a video (not a Short: one minute is no achievement) seen 90%+
 *   reach     a video or Short with REACH_MIN_VIEWERS signed-in watchers (not the
 *             author) within 7 days of being published, to its creator
 *   playlist  someone else's public playlist of 3+ items, every item seen or heard 90%+
 *   premiere  watching a premiere (scheduled-posts, premiere: true) within its first
 *             10 minutes
 *   premheld  a premiere that went out within 15 minutes of its time, to its creator
 *
 * The points server applies the daily caps (120 a day of vodtime and listen, 10
 * finishes, 3 playlists).
 */

const { ACTIVITY } = require('./activity');
const { dayKey, dayStartMs, finishedDays, windowStart, postKey, DAY_MS } = require('./common');

const FIRST5_SECS = 5 * 60;
const FINISH_PCT = 90;
const REACH_MIN_VIEWERS = Math.max(1, parseInt(process.env.REACH_MIN_VIEWERS, 10) || 20);
const REACH_DAYS = 7;
// A watcher counts for reach after this many seconds of the video.
const REACH_MIN_SECS = 10;
const PLAYLIST_MIN_ITEMS = 3;
const PLAYLIST_MAX_CANDIDATES = 500;
const PREMIERE_EARLY_MS = 10 * 60 * 1000;
const PREMHELD_LATE_MS = 15 * 60 * 1000;

/** first5 for today and yesterday, vodtime and listen for the finished days. */
async function dailyAwards({ db, now, launch }) {
    const done = finishedDays(now, launch);
    const live = [dayKey(now), dayKey(now - DAY_MS)].filter((d) => Date.parse(d) >= dayStartMs(launch));
    const days = [...new Set([...done, ...live])];
    if (!days.length) return [];
    const rows = await db.collection(ACTIVITY)
        .find({ kind: { $in: ['watch', 'listen'] }, day: { $in: days } }, { projection: { _id: 0, kind: 1, user: 1, day: 1, secs: 1 } })
        .toArray();
    const totals = new Map(); // kind|user|day -> secs
    for (const r of rows) {
        const k = `${r.kind}|${r.user}|${r.day}`;
        totals.set(k, (totals.get(k) || 0) + (Number(r.secs) || 0));
    }
    const doneSet = new Set(done);
    const liveSet = new Set(live);
    const out = [];
    for (const [k, secs] of [...totals].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const [kind, user, day] = k.split('|');
        if (kind === 'watch' && liveSet.has(day) && secs >= FIRST5_SECS) out.push({ id: `first5:${user}:${day}`, user, kind: 'first5' });
        const minutes = Math.floor(secs / 60);
        if (!doneSet.has(day) || minutes < 1) continue;
        const award = kind === 'watch' ? 'vodtime' : 'listen';
        out.push({ id: `${award}:${user}:${day}`, user, kind: award, units: minutes });
    }
    return out;
}

/** Videos seen 90%+ in the window. */
async function finishAwards({ db, now, launch }) {
    const rows = await db.collection(ACTIVITY)
        .find({ kind: 'watch', at: { $gte: windowStart(now, launch) }, pct: { $gte: FINISH_PCT }, short: false, post: { $type: 'string' } },
            { projection: { _id: 0, user: 1, post: 1 } })
        .sort({ at: 1 })
        .limit(5000)
        .toArray();
    return rows.map((r) => ({ id: `finish:${r.user}:${r.post}`, user: r.user, kind: 'finish', ref: r.post }));
}

/** Videos and Shorts of the last REACH_DAYS (+1) days that reached REACH_MIN_VIEWERS signed-in watchers. */
async function reachAwards({ db, now, launch }) {
    const since = windowStart(now, launch, (REACH_DAYS + 1) * 24);
    const videos = await db.collection('embed-video')
        .find({ processed: { $in: [true, false, null] }, createdAt: { $gte: since }, status: 'published', hive_permlink: { $type: 'string' } },
            { projection: { _id: 0, hive_author: 1, hive_permlink: 1, createdAt: 1 } })
        .limit(5000)
        .toArray();
    const published = new Map();
    for (const v of videos) {
        const post = postKey(v.hive_author, v.hive_permlink);
        if (post) published.set(post, { author: v.hive_author, until: new Date(v.createdAt).getTime() + REACH_DAYS * DAY_MS });
    }
    if (!published.size) return [];
    const rows = await db.collection(ACTIVITY)
        .find({ kind: 'watch', post: { $in: [...published.keys()] }, secs: { $gte: REACH_MIN_SECS } },
            { projection: { _id: 0, user: 1, post: 1, firstAt: 1 } })
        .toArray();
    const viewers = new Map(); // post -> Set(user)
    for (const r of rows) {
        const v = published.get(r.post);
        if (!v || r.user === v.author || new Date(r.firstAt).getTime() > v.until) continue;
        if (!viewers.has(r.post)) viewers.set(r.post, new Set());
        viewers.get(r.post).add(r.user);
    }
    return [...viewers].filter(([, set]) => set.size >= REACH_MIN_VIEWERS)
        .map(([post]) => ({ id: `reach:${post}`, user: published.get(post).author, kind: 'reach', ref: post }));
}

/** Someone else's public playlists finished by people who finished one of its items in the window. */
async function playlistAwards({ db, now, launch }) {
    const recent = await db.collection(ACTIVITY)
        .find({ kind: { $in: ['watch', 'listen'] }, at: { $gte: windowStart(now, launch) }, pct: { $gte: FINISH_PCT } },
            { projection: { _id: 0, user: 1, post: 1, item: 1 } })
        .limit(5000)
        .toArray();
    if (!recent.length) return [];
    const keysOf = (r) => [r.post, r.item].filter(Boolean);
    const recentKeys = new Set(recent.flatMap(keysOf));
    const split = [...recentKeys].map((k) => k.split('/'));
    const playlists = await db.collection('playlists')
        .find({ access: 'public', 'items.author': { $in: [...new Set(split.map((s) => s[0]))] }, 'items.permlink': { $in: [...new Set(split.map((s) => s[1]))] } },
            { projection: { owner: 1, items: 1 } })
        .limit(PLAYLIST_MAX_CANDIDATES)
        .toArray();
    const lists = playlists
        .map((p) => ({ id: String(p._id), owner: p.owner, keys: (p.items || []).map((i) => postKey(i.author, i.permlink)).filter(Boolean) }))
        .filter((p) => p.keys.length >= PLAYLIST_MIN_ITEMS && p.keys.some((k) => recentKeys.has(k)));
    if (!lists.length) return [];

    // Everything each of those people finished in the rows we still keep.
    const users = [...new Set(recent.map((r) => r.user))];
    const finished = new Map(); // user -> Set(key)
    const rows = await db.collection(ACTIVITY)
        .find({ user: { $in: users }, pct: { $gte: FINISH_PCT } }, { projection: { _id: 0, user: 1, post: 1, item: 1 } })
        .toArray();
    for (const r of rows) {
        if (!finished.has(r.user)) finished.set(r.user, new Set());
        for (const k of keysOf(r)) finished.get(r.user).add(k);
    }
    const out = [];
    for (const user of users) {
        const seen = finished.get(user) || new Set();
        for (const p of lists) {
            if (p.owner === user || !p.keys.every((k) => seen.has(k))) continue;
            out.push({ id: `playlist:${user}:${p.id}`, user, kind: 'playlist', ref: p.id });
        }
    }
    return out;
}

/** Premieres that started in the window: who watched early, and whether the creator held it on time. */
async function premiereAwards({ db, now, launch }) {
    const posts = await db.collection('scheduled-posts')
        .find({ premiere: true, scheduledOn: { $gte: windowStart(now, launch), $lte: new Date(now) }, status: 'posted' },
            { projection: { owner: 1, permlink: 1, embedPermlink: 1, scheduledOn: 1, postedAt: 1 } })
        .limit(1000)
        .toArray();
    if (!posts.length) return [];
    const out = [];
    for (const p of posts) {
        const start = new Date(p.scheduledOn).getTime();
        if (p.postedAt && new Date(p.postedAt).getTime() <= start + PREMHELD_LATE_MS) {
            out.push({ id: `premheld:${p._id}`, user: p.owner, kind: 'premheld', ref: postKey(p.owner, p.permlink) });
        }
    }
    const byKey = new Map();
    for (const p of posts) {
        byKey.set(postKey(p.owner, p.permlink), p);
        if (p.embedPermlink) byKey.set(postKey(p.owner, p.embedPermlink), p);
    }
    const keys = [...byKey.keys()];
    const rows = await db.collection(ACTIVITY)
        .find({ kind: 'watch', $or: [{ post: { $in: keys } }, { item: { $in: keys } }] }, { projection: { _id: 0, user: 1, post: 1, item: 1, firstAt: 1, at: 1 } })
        .toArray();
    const seen = new Set();
    for (const r of rows) {
        const p = byKey.get(r.post) || byKey.get(r.item);
        const start = new Date(p.scheduledOn).getTime();
        const post = postKey(p.owner, p.permlink);
        const first = new Date(r.firstAt).getTime();
        if (r.user === p.owner || first > start + PREMIERE_EARLY_MS || new Date(r.at).getTime() < start) continue;
        const id = `premiere:${r.user}:${post}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ id, user: r.user, kind: 'premiere', ref: post });
    }
    return out;
}

module.exports = {
    dailyAwards, finishAwards, reachAwards, playlistAwards, premiereAwards,
    FIRST5_SECS, FINISH_PCT, REACH_MIN_VIEWERS, PLAYLIST_MIN_ITEMS,
};
