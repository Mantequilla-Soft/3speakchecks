/**
 * Daily PUBLISH limit (owner 2026-11-25): a free Hive account publishes at most
 * 1 regular video and 3 Shorts (stories count as Shorts) per rolling 24 hours.
 * Uploading is not limited; anything over the limit has to be scheduled on a
 * free time.
 *
 * Two publishes are compared by their PUBLISH time: "publish now" is now, a
 * scheduled post is its scheduledOn. A publish of kind K at time t with limit L
 * is allowed when no 24-hour window that contains t would hold more than L
 * publishes of kind K (the others plus this one). Windows are half open, so two
 * publishes exactly 24 hours apart never share one: for L = 1 that means no
 * other publish of the kind less than 24 hours before or after t.
 *
 * This file is the pure part: the settings and the window arithmetic, on plain
 * arrays of times. utils/publishQuota.js reads the publishes out of Mongo.
 *
 * Env (read on every call, so a restart is not needed to flip it in tests):
 *   PUBLISH_DAILY_LIMITS_ENABLED   on unless exactly "false"
 *   PUBLISH_LIMIT_VIDEOS_PER_DAY   1
 *   PUBLISH_LIMIT_SHORTS_PER_DAY   3
 *   PUBLISH_LIMIT_EXEMPT           comma list of accounts the limit skips
 */
const WINDOW_HOURS = 24;
const WINDOW_MS = WINDOW_HOURS * 3600 * 1000;
const KINDS = ['video', 'short'];
const DEFAULTS = { video: 1, short: 3 };

/** A positive whole number from the env, or the default (unset, junk or below 1). */
function limitOf(raw, fallback) {
    const n = parseInt(String(raw ?? '').trim(), 10);
    return Number.isInteger(n) && n >= 1 ? n : fallback;
}

const normName = (v) => String(v || '').trim().toLowerCase().replace(/^@/, '');

/** The settings, from the environment. */
function limitsConfig(env = process.env) {
    return {
        enabled: String(env.PUBLISH_DAILY_LIMITS_ENABLED ?? '').trim() !== 'false',
        limits: {
            video: limitOf(env.PUBLISH_LIMIT_VIDEOS_PER_DAY, DEFAULTS.video),
            short: limitOf(env.PUBLISH_LIMIT_SHORTS_PER_DAY, DEFAULTS.short),
        },
        exempt: String(env.PUBLISH_LIMIT_EXEMPT || '').split(',').map(normName).filter(Boolean),
    };
}

const isListed = (owner, cfg) => cfg.exempt.includes(normName(owner));

/** The other publishes less than 24 hours from `at` (ms), oldest first. */
function nearTimes(times, at) {
    return times.filter((t) => Math.abs(t - at) < WINDOW_MS).sort((a, b) => a - b);
}

/**
 * May one more publish go out at `at` (ms), given the other publishes `times`
 * (ms) of the same kind and the limit? Every window that holds `at` starts in
 * (at - 24h, at]; the fullest one starts on a publish or on `at` itself, so
 * those are the only starts to try.
 */
function allowedAt(times, at, limit) {
    const near = nearTimes(times, at);
    if (near.length + 1 <= limit) return true;
    const starts = [at, ...near.filter((t) => t <= at)];
    for (const s of starts) {
        const inWindow = near.filter((t) => t >= s && t < s + WINDOW_MS).length;
        if (inWindow + 1 > limit) return false;
    }
    return true;
}

/**
 * The earliest time >= `from` (ms) where a publish is allowed, or null when there
 * is none among the candidates (only with no times at all can that not happen).
 * The answer only changes where a window edge meets a publish, so the candidates
 * are `from` and each publish, 24 hours before and after it.
 */
function nextFreeAt(times, from, limit) {
    const candidates = new Set([from]);
    for (const t of times) {
        for (const c of [t - WINDOW_MS, t, t + WINDOW_MS]) if (c > from) candidates.add(c);
    }
    for (const c of [...candidates].sort((a, b) => a - b)) {
        if (allowedAt(times, c, limit)) return c;
    }
    return null;
}

/**
 * The publishes ({ permlink, title, at: Date, scheduled }) less than 24 hours
 * from `at` (ms), oldest first: what the API calls conflicts.
 */
function conflictsAt(publishes, at) {
    return publishes
        .filter((p) => Math.abs(p.at.getTime() - at) < WINDOW_MS)
        .sort((a, b) => a.at - b.at)
        .map((p) => ({ permlink: p.permlink, title: p.title, at: p.at.toISOString(), scheduled: p.scheduled }));
}

/** The 429 text: what the limit is and when the next free time is. */
function limitMessage(kind, limit, nextFree) {
    const noun = kind === 'short' ? (limit === 1 ? 'Short' : 'Shorts') : (limit === 1 ? 'video' : 'videos');
    const when = nextFree ? ` Schedule it for ${nextFree} or later,` : ' Schedule it for a later time,';
    return `Free accounts can publish ${limit} ${noun} per ${WINDOW_HOURS} hours.${when} or get 3Speak Pro for no limit.`;
}

module.exports = {
    WINDOW_HOURS, WINDOW_MS, KINDS,
    limitsConfig, isListed, normName, allowedAt, nextFreeAt, conflictsAt, limitMessage,
};
