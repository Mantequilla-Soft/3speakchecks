/**
 * "Videos from a set of followed accounts", shared by every feed built that way.
 *
 * Two callers, one ranking: the personalized follow feed (/feed/:username, the
 * accounts YOU follow) and the badge feed (/badges/:account/feed, the accounts a
 * badge account follows — its recipients). They differ only in what happens when
 * the account follows nobody, which is `allowFallback`.
 *
 * Returns the response payload; it never touches `res`, so the routes stay thin
 * and both get the identical recency-decay + comment-boost + rankFeed treatment.
 */
const { getDb } = require('./db');
const { feedAgeMatch } = require('./feedAge');
const { unavailableMatch } = require('./unavailable');
const { hiddenFromFeedMatch } = require('./hiddenFromFeed');
const { nsfwFilterTags, nsfwFilterHiveTags } = require('./filters');
const { hiddenListSync } = require('./hiddenCreators');
const { getFollowingList } = require('./hive');
const { FOLLOW_FEED_HALFLIFE_H } = require('./config');
const { rankFeed } = require('./feedRank');
const { getCommentCounts, commentBoost, keyOf: commentKeyOf } = require('./commentBoost');

/**
 * @param req             the express request — read for pagination and for the
 *                        nsfw / interests / hide-watched query params.
 * @param username        the account whose following list defines the feed.
 * @param allowFallback   true  → an account that follows nobody gets the whole
 *                                site (what /feed/:username has always done, so
 *                                a logged-in user with an empty follow list is
 *                                not shown a blank home page).
 *                        false → it gets an EMPTY feed. A badge page must never
 *                                silently turn into the global feed: a badge with
 *                                no recipients yet has no videos, and saying so is
 *                                the honest answer.
 */
async function buildFollowFeed(req, username, { allowFallback = true, chronological = false } = {}) {
    const db = getDb();

    // Extract pagination parameters
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
    const skip = (page - 1) * limit;

    // Get following list from Hive API
    let followingList = await getFollowingList(username);

    // ...or from the incubation store, for a name that is not on Hive at
    // all. getFollowingList answers empty for a handle with no account, and
    // empty means "no following list" a few lines down, which drops the
    // reader into the unfiltered fallback: every published video on the
    // site, in a page they asked to be about the people they follow. Their
    // picks are real, they are simply kept somewhere else until graduation.
    if (!followingList || followingList.length === 0) {
        const offChain = await db.collection('incubation_follows')
            .find({ handle: username, state: 'following' }, { projection: { following: 1 } })
            .limit(1000).toArray();
        if (offChain.length) followingList = offChain.map(r => r.following);
    }

    // No recipients → no feed. See `allowFallback` above.
    if (!allowFallback && (!followingList || followingList.length === 0)) {
        const page0 = Math.max(parseInt(req.query.page) || 1, 1);
        return {
            username,
            feedType: 'empty',
            following: 0,
            page: page0,
            limit: Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100),
            total: 0,
            totalPages: 0,
            videos: []
        };
    }

    const videosCollection = db.collection('videos');
    const embedVideoCollection = db.collection('embed-video');

    // Build queries for both collections. Only TOP-LEVEL content: legacy
    // `videos` are top-level by nature; embed videos are filtered with
    // `short: false` so shorts are excluded.
    let legacyQuery, embedQuery, feedType;
    if (followingList && followingList.length > 0) {
        legacyQuery = { owner: { $in: followingList, $nin: hiddenListSync() }, status: 'published', ...nsfwFilterTags(req), ...feedAgeMatch('created'), ...unavailableMatch(), ...hiddenFromFeedMatch() };
        embedQuery = {
            hive_author: { $in: followingList, $nin: hiddenListSync() },
            status: 'published',
            short: false,
            listed_on_3speak: true,
            hive_permlink: { $ne: null },
            ...nsfwFilterHiveTags(req),
            ...feedAgeMatch('createdAt'), ...unavailableMatch(), ...hiddenFromFeedMatch()
        };
        feedType = 'personalized';
        console.log(`Fetching feed for ${username}: ${followingList.length} following`);
    } else {
        // Fallback: all published top-level content (no following list)
        legacyQuery = { owner: { $nin: hiddenListSync() }, status: 'published', ...nsfwFilterTags(req), ...feedAgeMatch('created'), ...unavailableMatch(), ...hiddenFromFeedMatch() };
        embedQuery = {
            status: 'published',
            short: false,
            listed_on_3speak: true,
            hive_author: { $ne: null, $nin: hiddenListSync() },
            hive_permlink: { $ne: null },
            ...nsfwFilterHiveTags(req),
            ...feedAgeMatch('createdAt'), ...unavailableMatch(), ...hiddenFromFeedMatch()
        };
        feedType = 'all';
        console.log(`Feed fallback for ${username}: showing all videos (no following list)`);
    }

    // Fetch a BOUNDED recent-candidate pool from each collection, then rank +
    // hide-seen + paginate over it. A fixed cap (not limit+skip) is what keeps
    // `total` stable and correct: with "Hide watched" on, a limit+skip window
    // would shrink after filtering and stop infinite scroll early, while a
    // countDocuments total would loop on empty pages. Bounded pool = neither.
    const FOLLOW_CANDIDATE_LIMIT = Math.max(limit, 300);
    const [legacyVideos, embedVideosRaw] = await Promise.all([
        videosCollection.find(legacyQuery).sort({ created: -1 }).limit(FOLLOW_CANDIDATE_LIMIT).toArray(),
        embedVideoCollection.find(embedQuery).sort({ createdAt: -1 }).limit(FOLLOW_CANDIDATE_LIMIT).toArray()
    ]);

    // Transform embed videos to the legacy shape (same mapping the other feeds use).
    const embedVideos = embedVideosRaw.map(ev => ({
        owner: ev.owner,
        author: ev.hive_author,
        permlink: ev.hive_permlink,
        title: ev.hive_title || ev.originalFilename || '',
        body: ev.hive_body || '',
        status: 'published',
        created: ev.createdAt,
        created_at: ev.createdAt,
        duration: ev.duration || 0,
        tags: ev.hive_tags || [],
        tags_v2: (ev.hive_tags || []).map(t => t.toLowerCase()),
        images: {
            thumbnail: ev.thumbnail_url || `https://img.3speak.tv/${ev.permlink}/thumbnail.png`,
            poster: ev.thumbnail_url || `https://img.3speak.tv/${ev.permlink}/poster.jpg`
        },
        spkvideo: {
            duration: ev.duration || 0,
            video_v2: ev.permlink,
            play_url: ev.manifest_cid ? `https://ipfs.3speak.tv/ipfs/${ev.manifest_cid}` : null
        },
        _source: 'embed',
        _embedPermlink: ev.permlink,   // asset id — retention/view-durations key
        _sortDate: new Date(ev.createdAt || 0).getTime()
    }));

    const legacyWithDate = legacyVideos.map(v => ({
        ...v,
        _sortDate: new Date(v.created || v.created_at || 0).getTime()
    }));

    // Dedup embeds that already exist as legacy docs.
    const legacyKeys = new Set(legacyWithDate.map(v => `${v.author || v.owner}/${v.permlink}`));
    const uniqueEmbed = embedVideos.filter(ev => !legacyKeys.has(`${ev.author}/${ev.permlink}`));

    // Merge, then rank. Base rank = recency decay (half-life FOLLOW_FEED_HALFLIFE_H,
    // its OWN shorter default than the tag/firstUploads feeds) so the follow feed
    // stays newest-first and leans harder on the newest uploads; retention then
    // multiplies it as a bounded nudge, so a slightly older video with strong
    // retention can edge above a brand-new one but recency still dominates.
    const allVideos = [...legacyWithDate, ...uniqueEmbed];
    const nowMs = Date.now();
    const halfLifeMs = Math.max(1, FOLLOW_FEED_HALFLIFE_H) * 3600 * 1000;
    for (const v of allVideos) {
        const ageMs = Math.max(0, nowMs - (v._sortDate || 0));
        // Floor > 0 so a missing/epoch _sortDate can't zero the score (which
        // would make the interest/retention multipliers no-ops).
        v._rankScore = Math.max(1e-6, Math.pow(0.5, ageMs / halfLifeMs));
    }
    // Comment boost — a video followed creators are discussing ranks a bit higher.
    // One cached map read; ×1 when there's no record. Keyed by HIVE author/permlink.
    const commentCounts = await getCommentCounts(db);
    if (commentCounts.size) {
        for (const v of allVideos) {
            const rec = commentCounts.get(commentKeyOf(v.author || v.owner, v.permlink));
            if (rec) v._rankScore *= commentBoost(rec.effective);
        }
    }
    // Interest boost → retention → sort → hide-seen (?currentuser=), on the
    // recency-decayed base score. Shared with the discovery feeds so the follow
    // feed re-ranks by the same signals when interests / hide-watched are on.
    const visibleVideos = await rankFeed(db, req, allVideos, { scoreField: '_rankScore' });

    // Strict newest-first, for callers where the feed is a RECORD rather than a
    // recommendation. A badge page answers "what have the holders published",
    // and the engagement nudges above (comment boost, interest match, retention)
    // shuffle that into an order nobody can explain from the dates on screen.
    //
    // Applied AFTER rankFeed, not instead of it: that pass also hides watched,
    // NSFW and hidden-creator videos, none of which should change with sorting.
    if (chronological) {
        visibleVideos.sort((a, b) => (b._sortDate || 0) - (a._sortDate || 0));
    }

    const total = visibleVideos.length;
    const totalPages = Math.ceil(total / limit);
    const videos = visibleVideos.slice(skip, skip + limit);
    videos.forEach(v => { delete v._sortDate; delete v._source; delete v._rankScore; delete v._embedPermlink; delete v.retention_mult; delete v.retention_relq; delete v.interest_match; });

    return {
        username,
        feedType,
        following: followingList ? followingList.length : 0,
        page,
        limit,
        total,
        totalPages,
        videos
    };
}

module.exports = { buildFollowFeed };
