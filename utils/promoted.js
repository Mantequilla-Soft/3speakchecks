/**
 * Currently promoted videos: one definition of "promoted and showable", shared by
 * GET /feeds/promoted (the home Promoted section), the Discover #1 slot in
 * GET /feeds/discover, and the eligibility check before a promotion is sold
 * (routes/promote.js). A video that passes the eligibility check is exactly a
 * video that promotedMatch() finds once promotedUntil is in the future, so nobody
 * pays for a promotion no feed would ever show.
 *
 * NSFW stays a per-viewer filter (nsfwFilterHiveTags in the query): an NSFW video
 * can be promoted, it is just only shown to viewers who opted in.
 */
const { feedAgeMatch } = require('./feedAge');
const { unavailableMatch } = require('./unavailable');
const { hiddenFromFeedMatch, isHiddenFromFeed } = require('./hiddenFromFeed');
const { nsfwFilterHiveTags } = require('./filters');
const { hiddenListSync, isHidden } = require('./hiddenCreators');
const { filterForUser } = require('./feedRank');
const { HIDDEN_AUTHORS, MAX_PROMOTION_DAYS } = require('./config');

const DAY_MS = 24 * 60 * 60 * 1000;

/** Mongo match on `embed-video` for promoted videos a feed may show right now. */
function promotedMatch(req, now = new Date()) {
    return {
        ...feedAgeMatch('createdAt'), ...unavailableMatch(), ...hiddenFromFeedMatch(),
        status: 'published',
        short: false,
        listed_on_3speak: true,
        promotedUntil: { $gt: now },
        hive_author: { $nin: [null, ...HIDDEN_AUTHORS, ...hiddenListSync()] },
        hive_permlink: { $ne: null },
        ...nsfwFilterHiveTags(req),
    };
}

/**
 * Dismissals (always) + already-watched (hidewatched=1), on both keys: an embed's
 * uploader can differ from its Hive author. Items carry owner / author / permlink
 * (the Hive permlink), like a feed card. No ?currentuser= → unchanged.
 */
async function filterPromotedForUser(db, req, items) {
    let visible = await filterForUser(db, req, items);
    if (visible.some((v) => v.author && v.author !== v.owner)) {
        visible = await filterForUser(db, req, visible, (v) => `${v.author}:${v.permlink}`);
    }
    return visible;
}

/**
 * Why an embed-video row can not be promoted, or null when it can. Mirrors
 * promotedMatch() in memory, minus promotedUntil and NSFW. Async because the
 * moderation hidden list is read with the awaited getter here (a sale), which
 * loads the set on a cold start instead of failing open on an empty warm cache.
 */
async function ineligibleReason(db, ev) {
    if (!ev) return 'not_found';
    const age = feedAgeMatch('createdAt').createdAt;
    const tooOld = age && !(ev.createdAt && new Date(ev.createdAt) >= age.$gte);
    if (ev.unavailable === true || ev.banned === true || ev.status === 'deleted'
        || isHiddenFromFeed(ev) || tooOld) return 'unavailable';
    const author = ev.hive_author;
    if (author && (HIDDEN_AUTHORS.includes(author) || await isHidden(db, author))) return 'hidden';
    if (ev.short !== false) return 'short';
    if (ev.listed_on_3speak !== true) return 'unlisted';
    if (ev.status !== 'published' || !author || !ev.hive_permlink) return 'not_published';
    return null;
}

/** Latest promotedUntil of the embed and legacy rows, in ms (0 when none). */
function existingUntilMs(embedDoc, videoDoc) {
    return Math.max(
        new Date(embedDoc?.promotedUntil || 0).getTime() || 0,
        new Date(videoDoc?.promotedUntil || 0).getTime() || 0,
    );
}

/** Whole days that still fit under the MAX_PROMOTION_DAYS-from-now cap. */
function maxDaysLeft(untilMs, now = Date.now()) {
    const room = now + MAX_PROMOTION_DAYS * DAY_MS - Math.max(now, untilMs);
    return Math.max(0, Math.floor(room / DAY_MS));
}

/**
 * The rows a promotion for author/permlink credits, and whether it may be sold.
 * Looked up like /promote/claim: the embed row by its asset key or its Hive post,
 * the legacy row by owner + permlink.
 *   { embedDoc, videoDoc, reason, untilMs, maxDays }
 */
async function promotionEligibility(db, author, permlink) {
    const embedDoc = await db.collection('embed-video').findOne({
        $or: [{ owner: author, permlink }, { hive_author: author, hive_permlink: permlink }],
    });
    const videoDoc = await db.collection('videos').findOne({ owner: author, permlink });
    const reason = await ineligibleReason(db, embedDoc);
    const untilMs = existingUntilMs(embedDoc, videoDoc);
    return { embedDoc, videoDoc, reason, untilMs, maxDays: reason ? 0 : maxDaysLeft(untilMs) };
}

module.exports = {
    DAY_MS, promotedMatch, filterPromotedForUser, ineligibleReason,
    existingUntilMs, maxDaysLeft, promotionEligibility,
};
