/**
 * 3Speak Points awards the checker knows about, sent to the points server
 * (hangouts, live.3speak.tv) which pays them and mints them as 3SP:
 *
 *   rank    the #1 of each main leaderboard board for the last calendar month
 *           (100 points each), summed from `leaderboard-daily`. Boards are the
 *           daily metrics below; the peak-viewers board takes the month's max.
 *           Computed from the 2nd of the month (UTC), when the rollup has
 *           finished the month's last day, and only for the month just ended.
 *   remix   a remix or reaction (`derived-content`, kinds remix + reaction) of
 *           someone else's post, to its maker (100 points), for posts from the
 *           last REMIX_WINDOW_HOURS.
 *
 * The points server decides amounts and limits (once per board and month,
 * once per source post per maker, 3 remixes a day) and every award id pays
 * once there, so sending one twice is harmless. Final answers are kept in
 * `points-award-log` so the same id is not sent every hour.
 *
 * Hidden creators and LEADERBOARD_EXCLUDED_USERS never place on a board, like
 * on /leaderboard; hidden creators earn no remix award either.
 *
 * Off unless POINTS_AWARD_URL and POINTS_AWARD_SECRET are both set.
 */

const { getDb } = require('../utils/db');
const { hiddenListSync } = require('../utils/hiddenCreators');
const { ENABLE_MONGO_WRITES, LEADERBOARD_EXCLUDED_USERS } = require('../utils/config');

const AWARD_URL = (process.env.POINTS_AWARD_URL || '').trim().replace(/\/+$/, '');
const AWARD_SECRET = (process.env.POINTS_AWARD_SECRET || '').trim();
const INTERVAL_MIN = Math.max(5, parseFloat(process.env.POINTS_AWARD_INTERVAL_MIN || '60'));
const FIRST_RUN_MS = Math.max(0, parseFloat(process.env.POINTS_AWARD_FIRST_RUN_MIN || '9')) * 60 * 1000;
const REMIX_WINDOW_HOURS = 72;
const LOG = 'points-award-log';
const LOG_TTL_DAYS = 120;
const SEND_CHUNK = 200;

// The main boards (routes/leaderboard.js METRICS) that leaderboard-daily
// carries. story_streak is a run of days, not a daily sum: not a board here.
const RANK_METRICS = [
    'video_uploads', 'short_uploads', 'video_watch_secs', 'short_watch_secs', 'tags_given',
    'streams', 'stream_secs', 'stream_peak_viewers', 'stream_viewers',
    'boosts_received', 'boost_amount_received', 'boosts_given', 'boost_amount_given',
    'story_uploads',
];
const MAX_METRICS = new Set(['stream_peak_viewers']);
const FINAL_REASONS = new Set(['already', 'own', 'limit', 'invalid', 'account']);

/** The calendar month before `now` (UTC), once it is final (from the 2nd). */
function previousMonth(now = Date.now()) {
    const d = new Date(now);
    if (d.getUTCDate() < 2) return null;
    const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    const key = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`;
    return { key, start, end };
}

/** The #1 of every board for one month: value desc, then name, like the boards. */
async function monthlyWinners(db, month, excluded = new Set()) {
    const group = { _id: '$user' };
    for (const m of RANK_METRICS) group[m] = MAX_METRICS.has(m) ? { $max: `$${m}` } : { $sum: `$${m}` };
    const rows = await db.collection('leaderboard-daily')
        .aggregate([{ $match: { date: { $gte: month.start, $lt: month.end } } }, { $group: group }], { allowDiskUse: true })
        .toArray();
    const out = [];
    for (const metric of RANK_METRICS) {
        let best = null;
        for (const r of rows) {
            const user = r._id;
            const v = Number(r[metric]) || 0;
            if (!user || v <= 0 || excluded.has(user)) continue;
            if (!best || v > best.v || (v === best.v && user < best.user)) best = { user, v };
        }
        if (best) out.push({ id: `rank:${month.key}:${metric}`, user: best.user, kind: 'rank' });
    }
    return out;
}

/** Remixes and reactions of someone else's post from the last few days. */
async function remixAwards(db, now = Date.now(), hidden = new Set()) {
    const since = new Date(now - REMIX_WINDOW_HOURS * 3600 * 1000);
    const rows = await db.collection('derived-content')
        .find({ kind: { $in: ['remix', 'reaction'] }, created: { $gte: since } },
            { projection: { _id: 0, author: 1, permlink: 1, source_author: 1, source_permlink: 1 } })
        .sort({ created: 1 })
        .limit(2000)
        .toArray();
    return rows
        .filter((r) => r.author && r.permlink && r.source_author && r.source_permlink
            && r.author !== r.source_author && !hidden.has(r.author))
        .map((r) => ({
            id: `remix:${r.author}/${r.permlink}`,
            user: r.author,
            kind: 'remix',
            ref: `${r.source_author}/${r.source_permlink}`,
        }));
}

async function unsent(db, awards) {
    if (!awards.length) return [];
    const done = await db.collection(LOG).find({ id: { $in: awards.map((a) => a.id) } }, { projection: { _id: 0, id: 1 } }).toArray();
    const seen = new Set(done.map((d) => d.id));
    return awards.filter((a) => !seen.has(a.id));
}

async function post(awards, fetchImpl = fetch) {
    const res = await fetchImpl(`${AWARD_URL}/points/awards`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-points-award-secret': AWARD_SECRET },
        body: JSON.stringify({ awards }),
        signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`points server answered ${res.status}`);
    const body = await res.json();
    return Array.isArray(body?.results) ? body.results : [];
}

/** One run: build the awards, send what has no final answer yet, log those. */
async function runPointsAwards({ now = Date.now(), db = getDb(), fetchImpl = fetch } = {}) {
    if (!AWARD_URL || !AWARD_SECRET) return { sent: 0, awarded: 0 };
    const hidden = new Set(hiddenListSync());
    const excluded = new Set([...hidden, ...LEADERBOARD_EXCLUDED_USERS]);
    const month = previousMonth(now);
    const all = [
        ...(month ? await monthlyWinners(db, month, excluded) : []),
        ...await remixAwards(db, now, hidden),
    ];
    const todo = await unsent(db, all);
    let sent = 0;
    let awarded = 0;
    for (let i = 0; i < todo.length; i += SEND_CHUNK) {
        const chunk = todo.slice(i, i + SEND_CHUNK);
        const results = await post(chunk, fetchImpl);
        sent += chunk.length;
        const final = results.filter((r) => r && r.id && (r.awarded || FINAL_REASONS.has(r.reason)));
        awarded += results.filter((r) => r && r.awarded).length;
        if (final.length && ENABLE_MONGO_WRITES) {
            const at = new Date(now);
            const expires_at = new Date(now + LOG_TTL_DAYS * 86400 * 1000);
            await db.collection(LOG).bulkWrite(final.map((r) => ({
                updateOne: {
                    filter: { id: r.id },
                    update: { $setOnInsert: { id: r.id, result: r.awarded ? 'awarded' : r.reason, at, expires_at } },
                    upsert: true,
                },
            })), { ordered: false });
        }
    }
    if (sent) console.log(`[pointsAwards] sent ${sent}, awarded ${awarded}`);
    return { sent, awarded };
}

let indexed = false;
async function ensureIndexes(db) {
    if (indexed || !ENABLE_MONGO_WRITES) return;
    indexed = true;
    try {
        await db.collection(LOG).createIndex({ id: 1 }, { unique: true, name: 'award_id' });
        await db.collection(LOG).createIndex({ expires_at: 1 }, { expireAfterSeconds: 0, name: 'award_ttl' });
    } catch (err) {
        indexed = false;
        console.error('[pointsAwards] index setup failed:', err && err.message);
    }
}

function schedule() {
    if (!AWARD_URL || !AWARD_SECRET) {
        console.log('[pointsAwards] disabled: set POINTS_AWARD_URL and POINTS_AWARD_SECRET to enable.');
        return;
    }
    console.log(`[pointsAwards] scheduled every ${INTERVAL_MIN}min to ${AWARD_URL}, first run in ${FIRST_RUN_MS / 60000}min`);
    const tick = () => {
        const db = getDb();
        ensureIndexes(db)
            .then(() => runPointsAwards({ db }))
            .catch((err) => console.error('[pointsAwards] run failed:', err && err.message));
    };
    setTimeout(() => {
        tick();
        setInterval(tick, INTERVAL_MIN * 60 * 1000).unref?.();
    }, FIRST_RUN_MS).unref?.();
}

module.exports = { schedule, runPointsAwards, monthlyWinners, remixAwards, previousMonth, RANK_METRICS };
