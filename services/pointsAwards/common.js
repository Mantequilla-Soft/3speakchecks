/**
 * Small helpers the 3Speak Points finders share (services/pointsAwards/*.js).
 *
 * Every finder gets one context object:
 *   { db, now, launch, firstsSince, hidden }
 *   now          ms, the moment of this run
 *   launch       Date, POINTS_AWARDS_SINCE (or the day of the first run): nothing
 *                before it is ever paid, so turning awards on does not pay out the
 *                whole history at once
 *   firstsSince  Date, POINTS_FIRSTS_SINCE (default: launch), for the `first` kinds
 *   hidden       Set of hidden creators
 * and returns award rows `{ id, user, kind, ref?, units? }` for the points server.
 */

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
// How far back the incremental finders look. The points server pays an id once,
// so the overlap between hourly runs costs a log lookup, nothing more.
const WINDOW_HOURS = 72;
// A UTC day's watch and listen totals are sent once the day is this far behind
// us: sessions are dated by their start, and a long video started before
// midnight keeps adding to its day for a while after it.
const DAY_FINAL_LAG_MS = 3 * HOUR_MS;
// How many finished days a run still sends (a checker that was down catches up).
const DAYS_BACK = 3;

const HIVE_RE = /^[a-z][a-z0-9.-]{2,15}$/;
const PERMLINK_RE = /^[a-z0-9][a-z0-9._-]{0,254}$/i;

const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
const dayStartMs = (t) => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
const name = (v) => { const s = String(v || '').trim().toLowerCase().replace(/^@/, ''); return HIVE_RE.test(s) ? s : ''; };
const postKey = (author, permlink) => (author && permlink ? `${author}/${permlink}` : null);

/** The start of a finder's window: WINDOW_HOURS back, never before `from` (the launch). */
function windowStart(now, from, hours = WINDOW_HOURS) {
    return new Date(Math.max(now - hours * HOUR_MS, from ? new Date(from).getTime() : 0));
}

/** The finished UTC days (YYYY-MM-DD) a day-total kind sends now, oldest first, none before launch. */
function finishedDays(now, launch) {
    const out = [];
    const firstDay = dayStartMs(launch);
    for (let i = DAYS_BACK; i >= 1; i -= 1) {
        const start = dayStartMs(now) - i * DAY_MS;
        if (start < firstDay || start + DAY_MS + DAY_FINAL_LAG_MS > now) continue;
        out.push(dayKey(start));
    }
    return out;
}

function chunk(list, size) {
    const out = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
}

module.exports = {
    HOUR_MS, DAY_MS, WINDOW_HOURS, DAY_FINAL_LAG_MS, HIVE_RE, PERMLINK_RE,
    dayKey, dayStartMs, name, postKey, windowStart, finishedDays, chunk,
};
