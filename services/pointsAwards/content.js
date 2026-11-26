/**
 * The creating and supporting kinds of 3Speak Points:
 *
 *   first        an account's first video, Short, story or podcast episode
 *                (embed-video / embed-audio), once per type. Only for accounts whose
 *                first of that type is on or after POINTS_FIRSTS_SINCE: anyone with
 *                an earlier one (any 3Speak upload of that type that was published,
 *                or a legacy `videos` row for videos) is not a newcomer.
 *   referral     the account that referred a newcomer (Butter Auth, link and invite
 *   invited      referrals only, like ad referrals) once the newcomer's first video
 *                is out: `referral` to the referrer, `invited` to the newcomer
 *   storystreak  every 7th day of a run of consecutive UTC days with a story
 *                (`story_posted_at`), counting days from the launch on
 *   challenge    a Shorts challenge entry the team approved (`checked: true`)
 *   remixed      a remix or reaction of your post by someone else, to you
 *   tip          a tip sent from 3Speak (`supports`: Hive and Lightning), to the
 *                tipper, units = its value in milli-HBD
 */

const { referralsFor, PAID_SOURCES } = require('../adReferrals');
const { weekIdOf } = require('../../utils/shortsChallenge');
const { windowStart, dayKey, dayStartMs, postKey, DAY_MS } = require('./common');

// Lightning tips are recorded in sats and never converted (services/lightningSupports.js),
// so the points need a rate. Sats in one HBD (about one US dollar).
const SATS_PER_HBD = Math.max(1, parseFloat(process.env.POINTS_SATS_PER_HBD) || 1000);
// A tip below this (milli-HBD) earns nothing: the flat 100 per tip would otherwise
// make dust tips between two accounts of one person a points tap.
const TIP_MIN_MILLI_HBD = Math.max(0, parseInt(process.env.POINTS_TIP_MIN_MILLI_HBD, 10) || 100);
const STREAK_DAYS = 7;
const STREAK_LOOKBACK_DAYS = 60;
const CHALLENGE_WEEKS_BACK = 6;
const REMIX_KINDS = ['remix', 'reaction'];
const EVER_PUBLISHED = ['published', 'deleted'];

const typeOf = (v) => (v.story_posted_at ? 'story' : v.short ? 'short' : 'video');

/**
 * New firsts in the window: [{ user, type }]. A story counts as a story, not as
 * a Short too; a podcast is an embed-audio upload in the podcast category.
 */
async function newFirsts({ db, now, firstsSince }) {
    const since = windowStart(now, firstsSince);
    const ev = db.collection('embed-video');
    const projection = { _id: 0, owner: 1, short: 1, story_posted_at: 1 };
    const [uploads, stories, podcasts] = await Promise.all([
        ev.find({ processed: { $in: [true, false, null] }, createdAt: { $gte: since }, status: 'published', hive_permlink: { $type: 'string' } }, { projection }).limit(5000).toArray(),
        ev.find({ story_posted_at: { $gte: since }, status: 'published' }, { projection }).limit(5000).toArray(),
        db.collection('embed-audio').find({ createdAt: { $gte: since }, category: 'podcast', status: 'published', post_permlink: { $type: 'string' } },
            { projection: { _id: 0, owner: 1 } }).limit(5000).toArray(),
    ]);
    const fresh = new Set();
    for (const v of [...uploads, ...stories]) if (v.owner) fresh.add(`${v.owner}|${typeOf(v)}`);
    for (const a of podcasts) if (a.owner) fresh.add(`${a.owner}|podcast`);
    if (!fresh.size) return [];

    // Who had one of the type before: distinct owners, so a busy old channel is one row.
    const owners = [...new Set([...fresh].map((k) => k.split('|')[0]))];
    const earlier = { owner: { $in: owners }, createdAt: { $lt: firstsSince }, status: { $in: EVER_PUBLISHED } };
    const [oldVideos, oldShorts, oldStories, oldPodcasts, legacy] = await Promise.all([
        ev.distinct('owner', { ...earlier, short: { $ne: true }, story_posted_at: null }),
        ev.distinct('owner', { ...earlier, short: true, story_posted_at: null }),
        ev.distinct('owner', { owner: { $in: owners }, story_posted_at: { $lt: firstsSince } }),
        db.collection('embed-audio').distinct('owner', { owner: { $in: owners }, createdAt: { $lt: firstsSince }, category: 'podcast' }),
        db.collection('videos').distinct('owner', { owner: { $in: owners } }),
    ]);
    const old = new Set([
        ...[...oldVideos, ...legacy].map((o) => `${o}|video`),
        ...oldShorts.map((o) => `${o}|short`),
        ...oldStories.map((o) => `${o}|story`),
        ...oldPodcasts.map((o) => `${o}|podcast`),
    ]);
    return [...fresh].filter((k) => !old.has(k)).sort().map((k) => {
        const [user, type] = k.split('|');
        return { user, type };
    });
}

/** `first` for every new first, plus `referral` + `invited` for newcomers' first videos. */
async function firstAwards(ctx, { lookup = referralsFor } = {}) {
    const firsts = await newFirsts(ctx);
    const out = firsts.map(({ user, type }) => ({ id: `first:${user}:${type}`, user, kind: 'first', ref: type }));
    const newcomers = firsts.filter((f) => f.type === 'video').map((f) => f.user);
    if (newcomers.length) {
        const refs = await lookup(newcomers);
        for (const invitee of newcomers) {
            const r = refs.get(invitee);
            if (!r || !PAID_SOURCES.has(r.source) || !r.referrer || r.referrer === invitee) continue;
            out.push({ id: `referral:${invitee}`, user: r.referrer, kind: 'referral', ref: invitee });
            // Both sides are kind 'referral' on the points server; the id tells them apart.
            out.push({ id: `invited:${invitee}`, user: invitee, kind: 'referral', ref: r.referrer });
        }
    }
    return out;
}

/** Every completed 7-day story run since the launch, for people with a story in the window. */
async function storyStreakAwards({ db, now, launch }) {
    const ev = db.collection('embed-video');
    const users = await ev.distinct('owner', { story_posted_at: { $gte: windowStart(now, launch) } });
    if (!users.length) return [];
    const from = new Date(Math.max(dayStartMs(launch), dayStartMs(now) - STREAK_LOOKBACK_DAYS * DAY_MS));
    const rows = await ev.find({ owner: { $in: users }, story_posted_at: { $gte: from }, status: { $ne: 'deleted' } },
        { projection: { _id: 0, owner: 1, story_posted_at: 1 } }).toArray();
    const days = new Map(); // user -> Set(day start ms)
    for (const r of rows) {
        if (!days.has(r.owner)) days.set(r.owner, new Set());
        days.get(r.owner).add(dayStartMs(r.story_posted_at));
    }
    const out = [];
    for (const [user, set] of [...days].sort(([a], [b]) => (a < b ? -1 : 1))) {
        let run = 0;
        let prev = null;
        for (const d of [...set].sort((a, b) => a - b)) {
            run = prev !== null && d - prev === DAY_MS ? run + 1 : 1;
            prev = d;
            if (run % STREAK_DAYS === 0) out.push({ id: `storystreak:${user}:${dayKey(d)}`, user, kind: 'storystreak' });
        }
    }
    return out;
}

/** Shorts challenge entries the team approved in the window. */
async function challengeAwards({ db, now, launch }) {
    const weeks = [];
    for (let i = 0; i <= CHALLENGE_WEEKS_BACK; i += 1) weeks.push(weekIdOf(new Date(now - i * 7 * DAY_MS)));
    const rows = await db.collection('shorts_challenge_entries')
        .find({ week: { $in: [...new Set(weeks)] }, checked: true, reviewed_at: { $gte: windowStart(now, launch) } },
            { projection: { _id: 0, week: 1, owner: 1, permlink: 1, hive_author: 1, hive_permlink: 1 } })
        .toArray();
    return rows.map((r) => {
        const user = r.hive_author || r.owner;
        const post = postKey(user, r.hive_permlink || r.permlink);
        return post && { id: `challenge:${r.week}:${post}`, user, kind: 'challenge', ref: post };
    }).filter(Boolean);
}

/** Remixes and reactions of someone's post by someone else, to the original creator. */
async function remixedAwards({ db, now, launch, hidden = new Set() }) {
    const rows = await db.collection('derived-content')
        .find({ kind: { $in: REMIX_KINDS }, created: { $gte: windowStart(now, launch) } },
            { projection: { _id: 0, author: 1, permlink: 1, source_author: 1, source_permlink: 1 } })
        .sort({ created: 1 })
        .limit(2000)
        .toArray();
    return rows
        .filter((r) => r.author && r.permlink && r.source_author && r.source_permlink
            && r.author !== r.source_author && !hidden.has(r.author))
        .map((r) => ({
            id: `remixed:${r.author}/${r.permlink}`,
            user: r.source_author,
            kind: 'remixed',
            ref: postKey(r.source_author, r.source_permlink),
        }));
}

/** milli-HBD of a supports row: HBD value for Hive tips, sats at SATS_PER_HBD for Lightning. */
function tipMilliHbd(t) {
    if (t.currency === 'SATS') return Math.round(((Number(t.amount) || 0) * 1000) / SATS_PER_HBD);
    return Math.round((Number(t.hbd_value) || 0) * 1000);
}

/**
 * Tips with a known tipper in the window. Streamed sats add up in one row per
 * listener, post and day, so those are sent once their day is over.
 */
async function tipAwards({ db, now, launch }) {
    const rows = await db.collection('supports')
        .find({ tippedAt: { $gte: windowStart(now, launch) }, tipper: { $type: 'string' } },
            { projection: { _id: 0, trx_id: 1, tipper: 1, author: 1, currency: 1, amount: 1, hbd_value: 1, stream: 1, tippedAt: 1 } })
        .limit(5000)
        .toArray();
    const today = dayKey(now);
    const out = [];
    for (const t of rows) {
        if (!t.trx_id || !t.author || t.tipper === t.author) continue;
        if (t.stream && dayKey(t.tippedAt) >= today) continue;
        const units = tipMilliHbd(t);
        if (units < TIP_MIN_MILLI_HBD) continue;
        out.push({ id: `tip:${t.trx_id}`, user: t.tipper, kind: 'tip', ref: t.author, units });
    }
    return out;
}

module.exports = {
    newFirsts, firstAwards, storyStreakAwards, challengeAwards, remixedAwards, tipAwards, tipMilliHbd,
    SATS_PER_HBD, TIP_MIN_MILLI_HBD,
};
