const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');
const { feedAgeMatch } = require('../utils/feedAge');
const { unavailableMatch } = require('../utils/unavailable');
const { hiddenFromFeedMatch } = require('../utils/hiddenFromFeed');
const { nsfwFilterTags, nsfwFilterHiveTags } = require('../utils/filters');
const { hiddenListSync } = require('../utils/hiddenCreators');
const { HIDDEN_AUTHORS, TRENDING_CANDIDATE_LIMIT, TRENDING_VIEWS_WEIGHT, TRENDING_VOTES_WEIGHT, TRENDING_COMMENTS_WEIGHT, TRENDING_REWARD_WEIGHT, TRENDING_RESHARE_WEIGHT, RESHARE_WEIGHT } = require('../utils/config');
const { fetchHiveRewards, fetchLivePageData, mulberry32, getFollowingList } = require('../utils/hive');
const {
    INTEREST_MULTIPLIER, parseInterests, fetchTranscriptionTags, normalizeTags, tagsMatchInterests,
    resolveInterestTiers, interestTierForTag, interestTierMultiplier,
} = require('../utils/interests');
const { applyRetention } = require('../utils/retentionRank');
const { rankFeed, applyInterestBoost, filterForUser } = require('../utils/feedRank');
const { getUserFilters, applyUserFilters, applyUserFilterQuery, normUser } = require('../utils/userFilters');
const { NEW_FROM_FOLLOWING_DAYS } = require('../utils/config');
const { RETENTION_FOLLOW_HALFLIFE_H, INTEREST_RECENCY_TILT, INTEREST_RECENCY_DAYS } = require('../utils/config');

// Mild "favor newer" tilt for the interests feed, on top of `base`'s own freshness:
//   × (1 + TILT · max(0, 1 − ageDays/DAYS))   → new ×(1+TILT), tapering to ×1 at DAYS+.
// Undated entries get ×1 (no tilt), never a penalty.
function interestRecencyTilt(created) {
    if (!(INTEREST_RECENCY_TILT > 0) || !(INTEREST_RECENCY_DAYS > 0)) return 1;
    const t = created ? new Date(created).getTime() : NaN;
    if (!Number.isFinite(t)) return 1;
    const ageDays = Math.max(0, (Date.now() - t) / 86400000);
    return 1 + INTEREST_RECENCY_TILT * Math.max(0, 1 - ageDays / INTEREST_RECENCY_DAYS);
}
const {
    DISCOVER_INTEREST_MULTIPLIER,
    DISCOVER_INTEREST_EXACT_MULT, DISCOVER_INTEREST_SIBLING_MULT,
} = require('../utils/config');
const DISCOVER_TIER_MULTS = {
    exact: DISCOVER_INTEREST_EXACT_MULT,
    sibling: DISCOVER_INTEREST_SIBLING_MULT,
};
const {
    RELATED_TOPIC_MULT, RELATED_INTEREST_MULT, RELATED_CREATOR_MULT,
    RELATED_CREATOR_POOL, RELATED_JITTER,
} = require('../utils/config');
const { jitter, interleaveExploration, interleaveByAge, interleaveByInterest, freshness, ageHours } = require('../utils/discoverScore');
const { DISCOVER_AGE_STRATIFY, DISCOVER_AGE_WEIGHTS, DISCOVER_INTEREST_SHARE } = require('../utils/config');
const { getCurationCounts, curationBoost, keyOf, EMPTY } = require('../utils/curation');
const { getFollowSetForReq, applyFollowBoost } = require('../utils/followBoost');
const { getPremiumSet, applyPremiumBoost } = require('../utils/premiumBoost');
const { getSuggestedCreators } = require('../utils/suggestedCreators');
const { attachTopicTags } = require('../utils/topicTag');
const { SUGGEST_MAX_LIMIT } = require('../utils/config');
const { getPool, hydrate } = require('../utils/discoverPool');
const { getInterestPool } = require('../utils/interestPool');
const { getTranscriptionTags } = require('../utils/transcriptionTags');
const { pickWinner, fetchViewerWeights } = require('../utils/effectiveTags');

/**
 * GET /feeds/interests — the "Interests" row / tab.
 *
 * Dedicated endpoint with its OWN stratified pool, rather than
 * /feeds/discover?interestsOnly=1 filtering the discover pool. The discover pool
 * is a ~2.7k UNIFORM sample of a ~104k tagged catalogue, so its topic mix mirrors
 * the catalogue and a single-topic filter starved the feed: `science` surfaced 29
 * of its 785 videos — one page, and paging produced nothing more.
 *
 * The interest pool samples up to INTEREST_POOL_PER_TAG per TOPIC, so every topic
 * has depth. Everything in it already carries a winning topic, so the only work
 * here is the interest match + seeded jitter, then the shared user filters.
 *
 * Query: ?page&limit&interests&currentuser&hidewatched&nsfw&seed&chrono
 */
router.get('/interests', async (req, res) => {
    try {
        const db = getDb();
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 30, 1), 100);
        const skip = (page - 1) * limit;

        const interestSet = parseInterests(req);
        // No interests → nothing to show. The tab only makes sense with them.
        if (!interestSet.size) {
            return res.json({ success: true, feed: 'interests', page, limit, total: 0, totalPages: 0, videos: [] });
        }

        const SEED_BUCKET_MS = 5 * 60 * 1000;
        const seed = parseInt(req.query.seed) || Math.floor(Date.now() / SEED_BUCKET_MS);
        const rng = mulberry32(seed);

        const pool = await getInterestPool(db);
        if (!pool.length) {
            // Worker hasn't built it yet (fresh deploy). Empty, not an error.
            return res.json({ success: true, feed: 'interests', page, limit, total: 0, totalPages: 0, seed, videos: [] });
        }

        const allowNsfw = req.query.nsfw === 'true';
        const candidates = pool.filter((e) =>
            (allowNsfw || !e.nsfw) && e.winnerTag && interestSet.has(e.winnerTag)
        );

        // `base` already carries freshness × newBoost × curationBoost × retention.
        // Every candidate matches an interest by definition, so there's no interest
        // multiplier to apply here — just a mild recency tilt, the follow boost and jitter.
        const chrono = req.query.chrono === '1' || req.query.chrono === 'true';
        const followSet = getFollowSetForReq(req);
        const scored = candidates.map((e) => ({
            ...e,
            interest_match: true,
            discover_score: (Number(e.base) || 0) * interestRecencyTilt(e.created) * jitter(rng()),
        }));
        applyFollowBoost(scored, followSet, { scoreField: 'discover_score' });
        applyPremiumBoost(scored, getPremiumSet(db), { scoreField: 'discover_score' });

        if (chrono) {
            scored.sort((a, b) => new Date(b.created || 0) - new Date(a.created || 0));
        } else {
            scored.sort((a, b) => b.discover_score - a.discover_score);
        }

        // Dismissals (always) + already-watched (when hidewatched=1).
        const visible = await filterForUser(db, req, scored);
        const pageEntries = visible.slice(skip, skip + limit);
        const videos = await hydrate(db, pageEntries);
        videos.forEach((v) => { delete v._pool; });

        res.json({
            success: true,
            feed: 'interests',
            page,
            limit,
            seed,
            total: visible.length,
            totalPages: Math.ceil(visible.length / limit),
            interests: [...interestSet],
            videos,
        });
    } catch (error) {
        console.error('Error building interests feed:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * GET /feeds/new-from-following — "New from creators you follow" rail on home.
 *
 * Creators the caller follows who uploaded in the last NEW_FROM_FOLLOWING_DAYS
 * days and still have something the caller HASN'T watched, with the unwatched
 * work split into shorts vs videos so the rail can render "3 shorts / 2 videos".
 *
 * Deliberately not a video feed: it returns creators, so the answer stays small
 * (a few dozen rows) no matter how much those creators posted.
 *
 * Counting rules, and why:
 *  - "Unwatched" reads the SAME watch_history the feeds use (_id
 *    "viewer:owner:permlink"), so anything watched anywhere on 3Speak stops
 *    counting here too.
 *  - Dismissed creators/videos are dropped (utils/userFilters), like every feed.
 *  - The caller's own uploads never count.
 *  - Visibility matches the feeds exactly: shorts use `listed_on_3speak != false`,
 *    videos use `listed_on_3speak == true` — the two feeds disagree on the
 *    missing-field case, and a creator advertising "1 new video" that appears in
 *    no feed would be a dead end.
 *
 * Query: ?currentuser=<viewer>&days&limit&nsfw
 */
router.get('/new-from-following', async (req, res) => {
    try {
        const db = getDb();
        const viewer = normUser(req.query.currentuser || req.query.username);
        if (!viewer) {
            return res.status(400).json({ error: 'currentuser is required' });
        }

        const days = Math.min(Math.max(parseInt(req.query.days, 10) || NEW_FROM_FOLLOWING_DAYS, 1), 30);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);

        const followingList = await getFollowingList(viewer);
        const authors = (followingList || []).map(normUser).filter((a) => a && a !== viewer);
        if (!authors.length) {
            return res.json({ creators: [], days, total_creators: 0, total_items: 0 });
        }

        const since = new Date(Date.now() - days * 86400000);
        const hidden = hiddenListSync();

        // ~320 uploads platform-wide in a 7-day window, so this cap sits far above
        // anything a real following list produces. It's here so a pathological
        // window (?days=30 on a huge follow list) can't pull an unbounded set.
        const CANDIDATE_LIMIT = 1000;

        const embedCollection = db.collection('embed-video');
        const videosCollection = db.collection('videos');

        const [embedDocs, legacyDocs] = await Promise.all([
            embedCollection.find({
                owner: { $in: authors, $nin: [...HIDDEN_AUTHORS, ...hidden] },
                status: 'published',
                hive_permlink: { $ne: null },
                createdAt: { $gte: since },
                $or: [
                    { short: true, listed_on_3speak: { $ne: false } },
                    { short: false, listed_on_3speak: true },
                ],
                ...nsfwFilterHiveTags(req), ...unavailableMatch(), ...hiddenFromFeedMatch(),
            }, { projection: { owner: 1, hive_author: 1, hive_permlink: 1, short: 1, createdAt: 1 } })
                .sort({ createdAt: -1 }).limit(CANDIDATE_LIMIT).toArray(),
            videosCollection.find({
                owner: { $in: authors, $nin: [...HIDDEN_AUTHORS, ...hidden] },
                status: 'published',
                created: { $gte: since },
                ...nsfwFilterTags(req), ...unavailableMatch(), ...hiddenFromFeedMatch(),
            }, { projection: { owner: 1, author: 1, permlink: 1, created: 1 } })
                .sort({ created: -1 }).limit(CANDIDATE_LIMIT).toArray(),
        ]);

        // One shape for both collections. `owner` (not hive_author) is the key the
        // feeds and the shorts player write into watch_history, so grouping and the
        // seen-check both use it.
        const items = [];
        const seenKeys = new Set();
        const push = (owner, permlink, isShort, created) => {
            const o = normUser(owner);
            if (!o || !permlink) return;
            const key = `${o}/${permlink}`;
            if (seenKeys.has(key)) return;      // an embed doc can also exist as a legacy doc
            seenKeys.add(key);
            items.push({ owner: o, permlink, short: !!isShort, created: created || null });
        };
        for (const d of legacyDocs) push(d.owner || d.author, d.permlink, false, d.created);
        for (const d of embedDocs) push(d.owner || d.hive_author, d.hive_permlink, d.short, d.createdAt);

        // Dismissed creators / videos, same as every feed.
        const filters = await getUserFilters(db, viewer);
        let fresh = applyUserFilters(items, filters, (v) => ({ owner: v.owner, permlink: v.permlink }));

        // Already watched → not new to this viewer. Unconditional: unlike the feeds'
        // optional "hide watched", what's left over IS the point of this rail.
        if (fresh.length) {
            const ids = fresh.map((v) => `${viewer}:${v.owner}:${v.permlink}`);
            const watched = await db.collection('watch_history')
                .find({ _id: { $in: ids } }, { projection: { _id: 1 } }).toArray();
            const seen = new Set(watched.map((w) => w._id));
            fresh = fresh.filter((v) => !seen.has(`${viewer}:${v.owner}:${v.permlink}`));
        }

        const byCreator = new Map();
        for (const v of fresh) {
            let row = byCreator.get(v.owner);
            if (!row) {
                row = { username: v.owner, shorts: 0, videos: 0, total: 0, latest_at: null };
                byCreator.set(v.owner, row);
            }
            if (v.short) row.shorts++; else row.videos++;
            row.total++;
            const t = v.created ? new Date(v.created) : null;
            if (t && !Number.isNaN(t.getTime()) && (!row.latest_at || t > row.latest_at)) row.latest_at = t;
        }

        // Newest activity first — the rail reads as "who just posted", not a ranking.
        const creators = [...byCreator.values()]
            .sort((a, b) => (b.latest_at?.getTime() || 0) - (a.latest_at?.getTime() || 0) || b.total - a.total);

        return res.json({
            creators: creators.slice(0, limit).map((c) => ({ ...c, latest_at: c.latest_at || undefined })),
            days,
            total_creators: creators.length,
            total_items: fresh.length,
        });
    } catch (error) {
        console.error('Error building new-from-following:', error);
        return res.status(500).json({ error: 'Failed to fetch new uploads from your creators' });
    }
});

/**
 * GET /feeds/suggested-creators — the "follow these" rail for discover / interests.
 *
 * Creators who posted interest-matching videos in the last 30 days, ranked by the
 * engagement on their recent work (views + comments + reshares), excluding the
 * caller and anyone they already follow. Topic membership comes from the pre-built
 * `leaderboard-topics-v2` (robust to un-transcribed fresh uploads); the engagement is
 * aggregated from the video docs + video-comment-counts + reshares. See
 * utils/suggestedCreators.js.
 *
 * The frontend renders as many tiles as fit its row, so it just passes ?limit=X.
 * Query: ?interests&currentuser&limit
 */
router.get('/suggested-creators', async (req, res) => {
    try {
        const db = getDb();
        const interestSet = parseInterests(req);
        if (!interestSet.size) {
            return res.json({ success: true, feed: 'suggested-creators', interests: [], creators: [] });
        }
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 12, 1), SUGGEST_MAX_LIMIT);
        // `pool` + `seed` → seeded-random `limit` out of the top `pool`, so discover
        // (e.g. pool=20&seed=…) shows a different slice than the interests tab (which
        // sends neither → the deterministic top `limit`).
        const pool = Math.min(Math.max(parseInt(req.query.pool) || 0, 0), SUGGEST_MAX_LIMIT);
        const seed = req.query.seed != null ? parseInt(req.query.seed) : null;
        // Non-blocking follow set: a cold miss returns null (no follow-exclusion this
        // one request; it warms in the background), so the rail never stalls on Hive.
        const followSet = getFollowSetForReq(req);

        const creators = await getSuggestedCreators(db, {
            interests: [...interestSet],
            followSet,
            excludeUser: req.query.currentuser,
            limit, pool, seed,
        });

        res.json({
            success: true,
            feed: 'suggested-creators',
            interests: [...interestSet],
            count: creators.length,
            creators,
        });
    } catch (error) {
        console.error('Error building suggested-creators:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * GET /feeds/discover — interest + retention driven discovery.
 *
 * Unlike trendingSorted this feed ignores votes, views and rewards entirely:
 * those signals concentrate attention on what is already popular. It ranks a
 * PRECOMPUTED pool (built hourly by services/discoverWorker.js) that unions the
 * recent window, a fresh random slice of the transcription-tagged back catalogue,
 * and anything still being watched — so old work keeps getting a shot.
 *
 *   discover_score = base(freshness × newBoost × reshareBoost × retention)
 *                    × interest × jitter
 *
 * then random picks from the lower half are interleaved into every Nth slot.
 * All randomness is seeded (?seed=, else a 5-min bucket) so pagination is stable.
 * Query: ?page&limit&interests&currentuser&nsfw&seed&debug=1
 */
router.get('/discover', async (req, res) => {
    try {
        const db = getDb();
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 30, 1), 100);
        const skip = (page - 1) * limit;
        const debug = req.query.debug === '1';

        // Deterministic seed: explicit ?seed= wins, else a 5-minute bucket so the
        // row is stable across a refresh but does rotate over time.
        const SEED_BUCKET_MS = 5 * 60 * 1000;
        const seed = parseInt(req.query.seed) || Math.floor(Date.now() / SEED_BUCKET_MS);
        const rng = mulberry32(seed);

        const pool = await getPool(db);
        if (!pool.length) {
            // Worker hasn't produced a pool yet (fresh deploy). Empty, not an error.
            return res.json({ success: true, feed: 'discover', page, limit, total: 0, totalPages: 0, seed, videos: [] });
        }

        // NSFW is filtered here (not baked into the pool) because it's per-request.
        const allowNsfw = req.query.nsfw === 'true';
        let candidates = allowNsfw ? pool : pool.filter((e) => !e.nsfw);

        const interestSet = parseInterests(req);
        // Resolved once per request, not per video: picks split into topics vs
        // categories, plus the sibling neighbourhood both imply.
        const interestTiers = resolveInterestTiers(interestSet);

        // "Interests" feed variant: ONLY videos whose winning topic is in the
        // user's interests. The pool already mixes recent + retention-active + a
        // random slice of the back catalogue, so filtering to interest-matches
        // naturally yields interest videos re-ranked by retention with older ones
        // sprinkled in. No interests → empty (the tab only makes sense with them).
        const interestsOnly = req.query.interestsOnly === '1' || req.query.interestsOnly === 'true';
        if (interestsOnly) {
            if (!interestSet.size) {
                return res.json({ success: true, feed: 'interests', page, limit, total: 0, totalPages: 0, seed, videos: [] });
            }
            // Expanded, not literal: picking the CATEGORY "tech-science" has to keep
            // videos whose winner is `technology`/`science`/…, otherwise a category
            // pick matches only the handful of videos tagged with the bare category
            // itself (13 site-wide for tech-science) and the tab looks empty.
            candidates = candidates.filter((e) => interestTierForTag(e.winnerTag, interestTiers) !== null);
        }

        // Per-user scoring: the pool already carries freshness × newBoost ×
        // curationBoost × retention in `base`, and the winning topic in `winnerTag`
        // (viewer votes + auto tags, precomputed hourly). All that's left is the
        // WINNER-ONLY interest match, the follow boost and jitter.
        // `chrono=1` (algo-off / simple feed) bypasses all of that and just sorts
        // newest-first — for interestsOnly it stays interest-filtered but chronological.
        const chrono = req.query.chrono === '1' || req.query.chrono === 'true';
        const followSet = getFollowSetForReq(req);
        const scored = candidates.map((e) => {
            // Tiered rather than a flat interest/not-interest split: an exact pick
            // outranks its neighbours, which outrank everything else. Pick
            // `technology` and technology leads, the rest of tech-science follows,
            // and the wider catalogue fills in behind — interests drive the feed,
            // other topics only fill.
            const tier = interestTierForTag(e.winnerTag, interestTiers);
            const score = (Number(e.base) || 0)
                * interestTierMultiplier(tier, DISCOVER_TIER_MULTS)
                * jitter(rng());
            return { ...e, interest_match: tier !== null, interest_tier: tier, discover_score: score };
        });
        // Creators you follow rank higher here too — discover is still discovery, so
        // this only tilts (×1.6, below the 2.5 interest multiplier), never filters.
        applyFollowBoost(scored, followSet, { scoreField: 'discover_score' });
        applyPremiumBoost(scored, getPremiumSet(db), { scoreField: 'discover_score' });

        if (chrono) {
            scored.sort((a, b) => new Date(b.created || 0) - new Date(a.created || 0));
        } else {
            scored.sort((a, b) => b.discover_score - a.discover_score);
        }

        // Drop dismissed ("not interested" / hidden creator) and — when the
        // preference is on — already-watched, BEFORE pagination so pages stay full.
        const visible = await filterForUser(db, req, scored);

        // Compose the page to the target AGE DISTRIBUTION (skipped in chrono mode).
        // The list is already score-sorted; interleaveByAge splits it into age bands
        // and emits them at DISCOVER_AGE_WEIGHTS proportions (quality still orders
        // within each band). This REPLACES the old head+explore interleave, which
        // couldn't hit an arbitrary target because its head slots were ~100% <30d.
        // interleaveExploration is kept for the legacy path / when stratify is off.
        const composed = chrono
            ? visible
            : (DISCOVER_AGE_STRATIFY
                ? interleaveByAge(visible, DISCOVER_AGE_WEIGHTS)
                : interleaveExploration(visible, rng, { weightOf: (e) => e.discover_score }));

        // Then guarantee interest matches a SHARE of every prefix. The score boost
        // alone cannot do this: `base` spans ~15x, so the handful of non-matching
        // videos at the top of that range outrank a boosted median match and take
        // the first screen. Runs AFTER the age pass, and since each stream keeps
        // its incoming order, the age composition still governs within each.
        // Skipped in chrono mode (algo off) and when the viewer has no interests.
        const finalEntries = (chrono || !interestTiers.any)
            ? composed
            : interleaveByInterest(composed, DISCOVER_INTEREST_SHARE, (e) => e.interest_match);

        const total = finalEntries.length;
        const pageEntries = finalEntries.slice(skip, skip + limit);

        // Only the page slice is hydrated into full video docs.
        const videos = await hydrate(db, pageEntries);

        videos.forEach((v) => {
            const p = v._pool || {};
            delete v._pool;
            if (debug) {
                v.discover_score = Math.round(p.discover_score * 100000) / 100000;
                v.base = p.base;
                v.freshness = p.freshness;
                v.new_boost = p.newBoost;
                v.recency_boost = p.recencyBoost;
                v.curation_boost = p.curationBoost;
                v.reshares = p.reshares;
                v.saves = p.saves;
                v.viewer_tags = p.viewerTags;
                v.comment_boost = p.commentBoost;
                v.comments = p.comments;
                v.native_comments = p.native3Speak;
                v.follow_match = !!p.follow_match;
                v.retention_mult = p.retentionMult;
                v.retention_relq = p.relQ;
                v.retention_viewers = p.retentionViewers;
                v.interest_match = p.interest_match;
                v.winnerTag = p.winnerTag;
                v.pool_src = p.src;
                v.age_hours = p.created ? Math.round(((Date.now() - new Date(p.created).getTime()) / 3600000) * 10) / 10 : null;
            }
        });

        res.json({
            success: true,
            feed: interestsOnly ? 'interests' : 'discover',
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
            seed,           // pass back so the client can pin it across pages
            poolSize: pool.length,
            videos
        });
    } catch (error) {
        console.error('Error fetching discover feed:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * GET /feeds/related/:author/:permlink — sidebar recommendations for a watch page.
 *
 * Biased, in this order of pull:
 *   - same TOPIC as the current video (its winner tag)         × RELATED_TOPIC_MULT
 *   - the user's INTERESTS (candidate's winner ∈ ?interests=)  × RELATED_INTEREST_MULT
 *   - same CREATOR (newest first — recency is already in base) × RELATED_CREATOR_MULT
 * The multipliers STACK, so "same topic AND same creator" naturally ranks highest,
 * and when the current topic isn't in the user's interests, interest-matching
 * videos still get pulled in (sprinkled) via the interest multiplier.
 * Query: ?limit&interests&currentuser&nsfw&seed
 */
router.get('/related/:author/:permlink', async (req, res) => {
    try {
        const db = getDb();
        const author = String(req.params.author || '').trim().toLowerCase().replace(/^@/, '');
        const permlink = String(req.params.permlink || '').trim();
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 40);
        const allowNsfw = req.query.nsfw === 'true';
        const interestSet = parseInterests(req);
        const SEED_BUCKET_MS = 5 * 60 * 1000;
        const seed = parseInt(req.query.seed) || Math.floor(Date.now() / SEED_BUCKET_MS);
        const rng = mulberry32(seed);

        if (!author || !permlink) {
            return res.status(400).json({ success: false, error: 'author and permlink are required' });
        }

        // 1. Winning topic of the CURRENT video (auto tags + viewer votes).
        const [auto, vwMap] = await Promise.all([
            getTranscriptionTags(db, author, permlink),
            fetchViewerWeights(db, [{ author, permlink }]),
        ]);
        const currentTopic = pickWinner(auto.tags || [], vwMap.get(`${author}/${permlink}`) || {});

        // 2. Pool candidates (already carry winnerTag + base). Exclude the current
        //    video and NSFW (unless allowed).
        const pool = await getPool(db);
        const isCurrent = (e) => e.owner === author && e.permlink === permlink;
        const candidates = new Map(); // "owner/permlink" -> pool-entry-shaped
        for (const e of pool) {
            if (isCurrent(e) || (!allowNsfw && e.nsfw)) continue;
            candidates.set(`${e.owner}/${e.permlink}`, { ...e });
        }

        // 3. Supplement with the creator's most-recent videos (they may sit outside
        //    the discover pool). Newest first → recency flows into the score via
        //    freshness below. Shaped like pool entries so hydrate() can render them.
        if (author) {
            const [recentEmbed, recentLegacy] = await Promise.all([
                db.collection('embed-video').find(
                    { ...feedAgeMatch('createdAt'), ...unavailableMatch(), ...hiddenFromFeedMatch(), owner: author, status: 'published', short: false, listed_on_3speak: true, hive_permlink: { $ne: null } },
                    { projection: { owner: 1, permlink: 1, hive_permlink: 1, createdAt: 1, isNsfwContent: 1 } }
                ).sort({ createdAt: -1 }).limit(RELATED_CREATOR_POOL).toArray(),
                db.collection('videos').find(
                    { ...feedAgeMatch('created'), ...unavailableMatch(), ...hiddenFromFeedMatch(), owner: author, status: 'published', publishFailed: { $ne: true } },
                    { projection: { owner: 1, permlink: 1, created: 1, isNsfwContent: 1 } }
                ).sort({ created: -1 }).limit(RELATED_CREATOR_POOL).toArray(),
            ]);
            const addCreator = (owner, hivePermlink, assetPermlink, source, created, nsfw) => {
                const key = `${owner}/${hivePermlink}`;
                if (owner === author && hivePermlink === permlink) return;   // exclude current
                if (!allowNsfw && nsfw) return;
                if (!candidates.has(key)) {
                    candidates.set(key, {
                        owner,
                        // Both supplement queries filter on `owner: author`, so this is
                        // always the current video's Hive author. Set it explicitly so the
                        // follow boost matches on `author` like it does for pool entries,
                        // rather than leaning on owner-equals-author holding here.
                        author,
                        permlink: hivePermlink, assetPermlink, source,
                        created, nsfw: !!nsfw, winnerTag: null, base: freshness(ageHours(created)),
                    });
                }
            };
            recentEmbed.forEach((e) => addCreator(e.owner, e.hive_permlink, e.permlink, 'embed', e.createdAt, e.isNsfwContent));
            recentLegacy.forEach((v) => addCreator(v.owner, v.permlink, v.permlink, 'legacy', v.created, v.isNsfwContent));
        }

        // 4. Score with the stacking multipliers.
        const followSet = getFollowSetForReq(req);
        const scored = [...candidates.values()].map((e) => {
            let m = 1;
            if (currentTopic && e.winnerTag === currentTopic) m *= RELATED_TOPIC_MULT;
            if (interestSet.size && e.winnerTag && interestSet.has(e.winnerTag)) m *= RELATED_INTEREST_MULT;
            if (e.owner === author) m *= RELATED_CREATOR_MULT;
            const score = (Number(e.base) || 0.01) * m * jitter(rng(), RELATED_JITTER);
            return { ...e, _relScore: score };
        });
        applyFollowBoost(scored, followSet, { scoreField: '_relScore' });
        applyPremiumBoost(scored, getPremiumSet(db), { scoreField: '_relScore' });
        scored.sort((a, b) => b._relScore - a._relScore);

        // 5. Drop dismissed / already-watched, then take the page.
        const visible = await filterForUser(db, req, scored);
        const pageEntries = visible.slice(0, limit);
        const videos = await hydrate(db, pageEntries);
        videos.forEach((v) => { delete v._pool; });

        res.json({
            success: true,
            feed: 'related',
            author,
            permlink,
            currentTopic,
            topicInInterests: !!(currentTopic && interestSet.has(currentTopic)),
            total: visible.length,
            videos,
        });
    } catch (error) {
        console.error('Error fetching related feed:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Endpoint to get recommended feed
router.get('/recommended', async (req, res) => {
    try {
        const db = getDb();
        // Extract pagination parameters
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
        const skip = (page - 1) * limit;

        const videosCollection = db.collection('videos');

        // Query for recommended videos
        const query = {
            ...feedAgeMatch('created'), ...unavailableMatch(), ...hiddenFromFeedMatch(),
            recommended: true,
            status: 'published',
            owner: { $nin: [...HIDDEN_AUTHORS, ...hiddenListSync()] },
            ...nsfwFilterTags(req)
        };

        // Exclude this user's dismissals at the QUERY level — this feed paginates in
        // Mongo, so a post-fetch filter would give short pages and a wrong `total`.
        applyUserFilterQuery(query, await getUserFilters(db, req.query.currentuser));

        // Get total count for pagination
        const total = await videosCollection.countDocuments(query);
        const totalPages = Math.ceil(total / limit);

        // Fetch videos with pagination, sorted by created descending (newest first)
        const videos = await videosCollection
            .find(query)
            .sort({ created: -1 })
            .skip(skip)
            .limit(limit)
            .toArray();

        // Return response
        res.json({
            success: true,
            feed: 'recommended',
            page: page,
            limit: limit,
            total: total,
            totalPages: totalPages,
            videos: videos
        });

    } catch (error) {
        console.error('Error fetching recommended feed:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Endpoint to get currently-promoted videos (promotedUntil in the future).
// Powers the home "Promoted" section (logged-in) and is mixed into Home Feed
// for logged-out viewers. Sorted by soonest-expiring first so freshly-paid
// promotions rotate through. NSFW/banned/listed filters still apply.
router.get('/promoted', async (req, res) => {
    try {
        const db = getDb();
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 50);
        const embedVideoCollection = db.collection('embed-video');
        const now = new Date();

        const embedVideosRaw = await embedVideoCollection.find({
            ...feedAgeMatch('createdAt'), ...unavailableMatch(), ...hiddenFromFeedMatch(),
            status: 'published',
            short: false,
            listed_on_3speak: true,
            promotedUntil: { $gt: now },
            hive_author: { $nin: [null, ...HIDDEN_AUTHORS, ...hiddenListSync()] },
            hive_permlink: { $ne: null },
            ...nsfwFilterHiveTags(req)
        }).sort({ promotedUntil: 1 }).limit(limit).toArray();

        const videos = embedVideosRaw.map(ev => ({
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
            promoted: true,
            promotedUntil: ev.promotedUntil,
        }));

        res.json({ success: true, feed: 'promoted', limit, total: videos.length, videos });
    } catch (error) {
        console.error('Error fetching promoted feed:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Endpoint to get new content feed (excludes first uploads)
router.get('/new', async (req, res) => {
    try {
        const db = getDb();
        // Extract pagination parameters
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
        const skip = (page - 1) * limit;

        const videosCollection = db.collection('videos');
        const embedVideoCollection = db.collection('embed-video');

        // Query for new content (exclude first uploads and trending)
        const query = {
            ...feedAgeMatch('created'), ...unavailableMatch(), ...hiddenFromFeedMatch(),
            status: 'published',
            owner: { $nin: [...HIDDEN_AUTHORS, ...hiddenListSync()] },
            firstUpload: { $ne: true },
            trending: { $ne: true },
            publishFailed: { $ne: true },
            ...nsfwFilterTags(req)
        };

        // Fetch legacy and embed videos in parallel
        const [legacyVideos, embedVideosRaw] = await Promise.all([
            videosCollection.find(query).sort({ created: -1 }).limit(limit + skip).toArray(),
            embedVideoCollection.find({
                ...feedAgeMatch('createdAt'), ...unavailableMatch(), ...hiddenFromFeedMatch(),
                status: 'published',
                short: false,
                listed_on_3speak: true,
                hive_author: { $nin: [null, ...HIDDEN_AUTHORS, ...hiddenListSync()] },
                hive_permlink: { $ne: null },
                ...nsfwFilterHiveTags(req)
            }).sort({ createdAt: -1 }).limit(limit + skip).toArray()
        ]);

        // Transform embed videos to match legacy format
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
            _sortDate: new Date(ev.createdAt || 0).getTime()
        }));

        // Add sort dates to legacy videos
        const legacyWithDate = legacyVideos.map(v => ({
            ...v,
            _sortDate: new Date(v.created || v.created_at || 0).getTime()
        }));

        // Deduplicate: remove embed videos that already exist in legacy
        const legacyKeys = new Set(legacyWithDate.map(v => `${v.author || v.owner}/${v.permlink}`));
        const uniqueEmbed = embedVideos.filter(ev => !legacyKeys.has(`${ev.author}/${ev.permlink}`));

        // Merge and sort by date descending
        const merged = [...legacyWithDate, ...uniqueEmbed];
        merged.sort((a, b) => b._sortDate - a._sortDate);

        // This feed stays purely chronological — no interest/retention ranking — but
        // explicit dismissals ("not interested" / hidden creator) must be honoured
        // everywhere. Callers send ?currentuser=&hidewatched=0 to get exactly that.
        const allVideos = await filterForUser(db, req, merged);

        const total = allVideos.length;
        const totalPages = Math.ceil(total / limit);
        const videos = allVideos.slice(skip, skip + limit);

        // Clean up internal fields
        videos.forEach(v => { delete v._sortDate; delete v._source; });

        // Return response
        res.json({
            success: true,
            feed: 'new',
            page: page,
            limit: limit,
            total: total,
            totalPages: totalPages,
            videos: videos
        });

    } catch (error) {
        console.error('Error fetching new content feed:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Endpoint to get trending feed
router.get('/trending', async (req, res) => {
    try {
        const db = getDb();
        // Extract pagination parameters
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
        const skip = (page - 1) * limit;

        const videosCollection = db.collection('videos');

        // Query for trending videos
        const query = {
            ...feedAgeMatch('created'), ...unavailableMatch(), ...hiddenFromFeedMatch(),
            trending: true,
            status: 'published',
            owner: { $nin: [...HIDDEN_AUTHORS, ...hiddenListSync()] },
            ...nsfwFilterTags(req)
        };

        // Exclude this user's dismissals at the QUERY level — this feed paginates in
        // Mongo, so a post-fetch filter would give short pages and a wrong `total`.
        applyUserFilterQuery(query, await getUserFilters(db, req.query.currentuser));

        // Get total count for pagination
        const total = await videosCollection.countDocuments(query);
        const totalPages = Math.ceil(total / limit);

        // Fetch videos with pagination, sorted by created descending
        const videos = await videosCollection
            .find(query)
            .sort({ created: -1 })
            .skip(skip)
            .limit(limit)
            .toArray();

        // Return response
        res.json({
            success: true,
            feed: 'trending',
            page: page,
            limit: limit,
            total: total,
            totalPages: totalPages,
            videos: videos
        });

    } catch (error) {
        console.error('Error fetching trending feed:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Endpoint to get trending feed sorted by score with reshare influence
router.get('/trendingSorted', async (req, res) => {
    try {
        const db = getDb();
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
        const skip = (page - 1) * limit;

        const videosCollection = db.collection('videos');
        const embedVideoCollection = db.collection('embed-video');
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        // Fetch legacy candidate videos (without reward in base_score — reward will be fetched live from Hive)
        const [legacyCandidates, embedCandidatesRaw] = await Promise.all([
            videosCollection.aggregate([
                {
                    $match: {
                        status: 'published',
                        owner: { $nin: [...HIDDEN_AUTHORS, ...hiddenListSync()] },
                        publishFailed: { $ne: true },
                        created: { $gte: sevenDaysAgo },
                        // hiddenFromFeed = author opt-out. unavailableMatch mirrors the
                        // embed candidate query below (it was missing on the legacy side
                        // — pre-existing gap). The 7-day window already covers feedAge.
                        ...unavailableMatch(), ...hiddenFromFeedMatch(),
                        ...nsfwFilterTags(req)
                    }
                },
                {
                    $addFields: {
                        base_score: {
                            $add: [
                                { $multiply: [{ $ifNull: ['$views', 0] }, TRENDING_VIEWS_WEIGHT] },
                                { $multiply: [{ $ifNull: ['$stats.num_votes', 0] }, TRENDING_VOTES_WEIGHT] },
                                { $multiply: [{ $ifNull: ['$stats.num_comments', 0] }, TRENDING_COMMENTS_WEIGHT] }
                            ]
                        }
                    }
                },
                { $sort: { base_score: -1 } },
                { $limit: TRENDING_CANDIDATE_LIMIT }
            ]).toArray(),
            // Fetch published embed videos (non-shorts) from last 7 days with Hive links
            embedVideoCollection.find({
                ...feedAgeMatch('createdAt'), ...unavailableMatch(), ...hiddenFromFeedMatch(),
                status: 'published',
                short: false,
                listed_on_3speak: true,
                hive_author: { $ne: null },
                hive_permlink: { $ne: null },
                createdAt: { $gte: sevenDaysAgo },
                ...nsfwFilterHiveTags(req)
            }).sort({ createdAt: -1 }).limit(TRENDING_CANDIDATE_LIMIT).toArray()
        ]);

        // Enrich legacy videos with live Hive reward data (stats.total_hive_reward in MongoDB is unreliable)
        const legacyAuthorPerms = legacyCandidates
            .filter(v => (v.author || v.owner) && v.permlink)
            .map(v => ({ author: v.author || v.owner, permlink: v.permlink }));

        // Embed candidates' Hive author/permlink (already on the doc).
        const embedAuthorPerms = embedCandidatesRaw
            .filter(ev => ev.hive_author && ev.hive_permlink)
            .map(ev => ({ author: ev.hive_author, permlink: ev.hive_permlink }));

        // Both Hive-rewards lookups can run in parallel — they don't depend
        // on each other. Combined with the inner batch parallelisation in
        // fetchHiveRewards, this is now ~1 RPC roundtrip instead of ~20.
        const [legacyHiveData, embedHiveData] = await Promise.all([
            legacyAuthorPerms.length > 0 ? fetchHiveRewards(legacyAuthorPerms) : Promise.resolve(new Map()),
            embedAuthorPerms.length > 0 ? fetchHiveRewards(embedAuthorPerms) : Promise.resolve(new Map()),
        ]);

        // Recalculate base_score for legacy videos with live reward data
        for (const video of legacyCandidates) {
            const hiveKey = `${video.author || video.owner}/${video.permlink}`;
            const hive = legacyHiveData.get(hiveKey);
            const liveReward = hive ? (hive.reward || 0) : 0;
            video.base_score = (video.base_score || 0) + liveReward * TRENDING_REWARD_WEIGHT;
        }

        // Transform embed videos into candidate format matching legacy videos
        const embedCandidates = embedCandidatesRaw
            .filter(ev => ev.hive_author && ev.hive_permlink)
            .map(ev => {
                const hiveKey = `${ev.hive_author}/${ev.hive_permlink}`;
                const hive = embedHiveData.get(hiveKey) || { reward: 0, title: '', body: '', tags: [] };
                const base_score = (ev.views || 0) * TRENDING_VIEWS_WEIGHT +
                    (hive.reward || 0) * TRENDING_REWARD_WEIGHT;
                return {
                    owner: ev.owner,
                    author: ev.hive_author,
                    permlink: ev.hive_permlink,
                    title: ev.hive_title || hive.title || '',
                    body: ev.hive_body || hive.body || '',
                    status: 'published',
                    created: ev.createdAt,
                    created_at: ev.createdAt,
                    duration: ev.duration || 0,
                    tags: ev.hive_tags || hive.tags || [],
                    images: {
                        thumbnail: ev.thumbnail_url || `https://img.3speak.tv/${ev.permlink}/thumbnail.png`,
                        poster: ev.thumbnail_url || `https://img.3speak.tv/${ev.permlink}/poster.jpg`
                    },
                    spkvideo: {
                        duration: ev.duration || 0,
                        video_v2: ev.permlink,
                        play_url: ev.manifest_cid ? `https://ipfs.3speak.tv/ipfs/${ev.manifest_cid}` : null
                    },
                    stats: {
                        total_hive_reward: hive.reward || 0,
                        num_votes: 0,
                        num_comments: 0
                    },
                    views: ev.views || 0,
                    base_score,
                    _source: 'embed',
                    _embedPermlink: ev.permlink
                };
            });

        // Deduplicate: remove embed videos that already exist in legacy (by hive author+permlink)
        const legacyKeys = new Set(legacyCandidates.map(v => `${v.author || v.owner}/${v.permlink}`));
        const uniqueEmbedCandidates = embedCandidates.filter(ev => !legacyKeys.has(`${ev.author}/${ev.permlink}`));

        // Merge all candidates
        const candidateVideos = [...legacyCandidates, ...uniqueEmbedCandidates];

        // Look up embed-video records to get Hive permlinks for reshare matching (for legacy videos)
        const embedDocs = legacyCandidates.length > 0
            ? await embedVideoCollection.find(
                { $or: legacyCandidates.map(v => ({ owner: v.owner, permlink: v.permlink })) },
                { projection: { owner: 1, permlink: 1, embed_url: 1 } }
              ).toArray()
            : [];

        // Build map: "owner/shortPermlink" -> hive permlink from embed_url
        const hivePermlinkMap = new Map();
        for (const doc of embedDocs) {
            if (doc.embed_url) {
                const parts = doc.embed_url.replace(/^@/, '').split('/');
                if (parts.length === 2) {
                    hivePermlinkMap.set(`${doc.owner}/${doc.permlink}`, { author: parts[0], permlink: parts[1] });
                }
            }
        }
        // Embed videos already have hive author/permlink directly
        for (const ev of uniqueEmbedCandidates) {
            hivePermlinkMap.set(`${ev.owner}/${ev._embedPermlink || ev.permlink}`, { author: ev.author, permlink: ev.permlink });
        }

        // The HIVE identity of a candidate — what reshares / playlist saves / viewer
        // tags are all keyed by. Legacy videos post under their own owner/permlink,
        // so that's the fallback when there's no embed doc to map through. (The old
        // reshare lookup dropped candidates that missed the map, which is why a
        // reshared legacy video with no embed doc used to score 0 reshares.)
        const hiveKeyOf = (v) => (v._source === 'embed'
            ? { author: v.author, permlink: v.permlink }
            : (hivePermlinkMap.get(`${v.owner}/${v.permlink}`) || { author: v.owner, permlink: v.permlink }));

        // ALL THREE manual votes come from the one cached curation map (utils/curation.js).
        // This used to be a per-request `reshares` aggregation, which was both redundant
        // (the map already holds the whole collection) and semantically different: it
        // counted ROWS and included an author's reshares of their OWN video — the exact
        // lever the curation map's self-exclusion exists to close. One source, one meaning.
        const curationCounts = await getCurationCounts(db);
        for (const video of candidateVideos) {
            const hivePl = hiveKeyOf(video);
            const counts = curationCounts.get(keyOf(hivePl.author, hivePl.permlink)) || EMPTY;

            video.reshare_count = counts.reshares;
            video.saves = counts.saves;
            video.viewer_tags = counts.tags;

            // Reshares stay ADDITIVE here (TRENDING_RESHARE_WEIGHT is tuned in .env), so
            // they are zero-weighted in the multiplicative boost below — paying for the
            // same act twice would double-dip.
            video.trending_score = (video.base_score || 0) + counts.reshares * TRENDING_RESHARE_WEIGHT;
            video.trending_score *= curationBoost(counts, { reshareWeight: 0 });
        }

        // Interest weighting (WINNER-ONLY): multiply the score of videos whose
        // single winning topic (viewer votes + auto tags) matches the caller's
        // ?interests=. No-op when no interests are supplied.
        await applyInterestBoost(db, req, candidateVideos, undefined, 'trending_score');

        // Creators the caller follows rank higher (×FOLLOW_BOOST). A tilt, not a
        // filter — trending must stay trending, not turn into a follow feed.
        applyFollowBoost(candidateVideos, getFollowSetForReq(req), { scoreField: 'trending_score' });
        applyPremiumBoost(candidateVideos, getPremiumSet(db), { scoreField: 'trending_score' });

        // Retention re-rank: multiply trending_score by each video's bounded
        // retention factor (cached in video-retention; no-op for videos without a
        // record). This is the shared quality signal applied to every feed that
        // already uses interests / watch-history. See algo.md.
        await applyRetention(db, candidateVideos, { scoreField: 'trending_score' });

        // Sort by final score — or newest-first when algo is off (?chrono=1).
        if (req.query.chrono === '1' || req.query.chrono === 'true') {
            candidateVideos.sort((a, b) =>
                new Date(b.created || b.created_at || 0) - new Date(a.created || a.created_at || 0));
        } else {
            candidateVideos.sort((a, b) => b.trending_score - a.trending_score);
        }

        // Drop dismissed ("not interested" / hidden creator) always, and
        // already-watched when the preference is on — server-side, before
        // pagination so pages stay full. Only when ?currentuser= is supplied.
        const visibleVideos = await filterForUser(db, req, candidateVideos);

        const total = visibleVideos.length;
        const totalPages = Math.ceil(total / limit);
        const videos = visibleVideos.slice(skip, skip + limit);

        // Clean up internal fields (the raw counts — reshare_count / saves /
        // viewer_tags — stay: they're facts about the video, not scoring internals).
        videos.forEach(v => {
            delete v._source; delete v._embedPermlink;
            delete v.retention_mult; delete v.retention_relq; delete v.retention_viewers;
            delete v.interest_match; delete v.follow_match;
        });

        res.json({
            success: true,
            feed: 'trendingSorted',
            page,
            limit,
            total,
            totalPages,
            videos
        });

    } catch (error) {
        console.error('Error fetching trendingSorted feed:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Endpoint to get first uploads feed
router.get('/firstUploads', async (req, res) => {
    try {
        const db = getDb();
        // Extract pagination parameters
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
        const skip = (page - 1) * limit;

        const videosCollection = db.collection('videos');
        const embedVideoCollection = db.collection('embed-video');

        // Query for first time uploads (exclude trending)
        const query = {
            ...feedAgeMatch('created'), ...unavailableMatch(), ...hiddenFromFeedMatch(),
            firstUpload: true,
            status: 'published',
            owner: { $nin: [...HIDDEN_AUTHORS, ...hiddenListSync()] },
            trending: { $ne: true },
            publishFailed: { $ne: true },
            ...nsfwFilterTags(req)
        };

        // Fetch legacy first uploads and embed videos in parallel
        const [legacyVideos, embedVideosRaw] = await Promise.all([
            videosCollection.find(query).sort({ created: -1 }).limit(limit + skip).toArray(),
            embedVideoCollection.find({
                ...feedAgeMatch('createdAt'), ...unavailableMatch(), ...hiddenFromFeedMatch(),
                status: 'published',
                short: false,
                listed_on_3speak: true,
                hive_author: { $ne: null },
                hive_permlink: { $ne: null },
                ...nsfwFilterHiveTags(req)
            }).sort({ createdAt: -1 }).limit(200).toArray()
        ]);

        // For embed videos, check if the owner has NO legacy videos (= first upload on 3speak)
        const embedOwners = [...new Set(embedVideosRaw.map(ev => ev.owner))];
        let ownersWithLegacy = new Set();
        let embedCountByOwner = {};
        if (embedOwners.length > 0) {
            // Check for legacy videos
            const existing = await videosCollection.distinct('owner', { owner: { $in: embedOwners } });
            ownersWithLegacy = new Set(existing);

            // Count total listed embed videos per owner (not just the ones in current query)
            const embedCounts = await embedVideoCollection.aggregate([
                { $match: { owner: { $in: embedOwners }, listed_on_3speak: true } },
                { $group: { _id: '$owner', count: { $sum: 1 } } }
            ]).toArray();
            for (const ec of embedCounts) {
                embedCountByOwner[ec._id] = ec.count;
            }
        }

        // Only include embed video if owner has NO legacy videos AND only 1 embed video total
        const firstEmbedByOwner = new Map();
        for (let i = embedVideosRaw.length - 1; i >= 0; i--) {
            const ev = embedVideosRaw[i];
            if (!ownersWithLegacy.has(ev.owner) && (embedCountByOwner[ev.owner] || 0) <= 1) {
                firstEmbedByOwner.set(ev.owner, ev);
            }
        }

        // Transform first-time embed videos
        const embedVideos = [...firstEmbedByOwner.values()].map(ev => ({
            owner: ev.owner,
            author: ev.hive_author,
            permlink: ev.hive_permlink,
            title: ev.hive_title || ev.originalFilename || '',
            body: ev.hive_body || '',
            status: 'published',
            firstUpload: true,
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
            _embedPermlink: ev.permlink,   // asset id — retention/interest key
            _sortDate: new Date(ev.createdAt || 0).getTime()
        }));

        // Add sort dates to legacy videos
        const legacyWithDate = legacyVideos.map(v => ({
            ...v,
            _sortDate: new Date(v.created || v.created_at || 0).getTime()
        }));

        // Deduplicate
        const legacyKeys = new Set(legacyWithDate.map(v => `${v.author || v.owner}/${v.permlink}`));
        const uniqueEmbed = embedVideos.filter(ev => !legacyKeys.has(`${ev.author}/${ev.permlink}`));

        // Recency-decayed base, then the shared pipeline (interests → retention →
        // sort → hide-seen). Recency stays dominant so this still showcases the
        // newest first-time uploads; retention is ~neutral for brand-new creators
        // (no data) and interests/hide-seen apply when the caller sends them.
        const allVideos = [...legacyWithDate, ...uniqueEmbed];
        const nowMs = Date.now();
        const halfLifeMs = Math.max(1, RETENTION_FOLLOW_HALFLIFE_H) * 3600 * 1000;
        for (const v of allVideos) {
            const ageMs = Math.max(0, nowMs - (v._sortDate || 0));
            v._rankScore = Math.max(1e-6, Math.pow(0.5, ageMs / halfLifeMs)); // floor > 0 (see follow feed)
        }
        const rankedVideos = await rankFeed(db, req, allVideos, { scoreField: '_rankScore' });

        const total = rankedVideos.length;
        const totalPages = Math.ceil(total / limit);
        const videos = rankedVideos.slice(skip, skip + limit);

        // Clean up internal fields
        videos.forEach(v => { delete v._sortDate; delete v._source; delete v._embedPermlink; delete v._rankScore; delete v.retention_mult; delete v.retention_relq; delete v.interest_match; });

        // Return response
        res.json({
            success: true,
            feed: 'firstUploads',
            page: page,
            limit: limit,
            total: total,
            totalPages: totalPages,
            videos: videos
        });

    } catch (error) {
        console.error('Error fetching first uploads feed:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

/* ─── Community feeds ─────────────────────────────────────────────────
 * Replacements for the legacy `${LEGACY}/apiv2/feeds/community/:id/...`
 * endpoints. Same shape as /new and /trending, scoped to one community.
 *
 * `videos.community` is the community id (e.g. "hive-181335") on the legacy
 * indexer. For freshly uploaded embed videos the community id lands in
 * `hive_tags` (as the post's first tag), so we filter on that.
 * ──────────────────────────────────────────────────────────────────── */

// Translate an embed-video doc into the same shape /new / /firstUploads return.
// Mirrors the inline transform those routes already do — kept inline here too
// so it stays trivial to grep for and tweak alongside the others.
function transformEmbedVideoToLegacy(ev) {
    return {
        owner: ev.owner,
        author: ev.hive_author,
        permlink: ev.hive_permlink,
        title: ev.hive_title || ev.originalFilename || '',
        body: ev.hive_body || '',
        status: 'published',
        created: ev.createdAt,
        created_at: ev.createdAt,
        views: ev.views || 0,
        duration: ev.duration || 0,
        tags: ev.hive_tags || [],
        tags_v2: (ev.hive_tags || []).map(t => t.toLowerCase()),
        images: {
            thumbnail: ev.thumbnail_url || `https://img.3speak.tv/${ev.permlink}/thumbnail.png`,
            poster: ev.thumbnail_url || `https://img.3speak.tv/${ev.permlink}/poster.jpg`,
        },
        spkvideo: {
            duration: ev.duration || 0,
            video_v2: ev.permlink,
            play_url: ev.manifest_cid ? `https://ipfs.3speak.tv/ipfs/${ev.manifest_cid}` : null,
        },
        // 🔐 Supporters-only. Card renders a lock badge; the gate is what
        // enforces access, so this is presentation only.
        gated: ev.gated === true,
        _source: 'embed',
        _embedPermlink: ev.permlink,   // asset id — retention/interest key
        _sortDate: new Date(ev.createdAt || 0).getTime(),
    };
}

/* ────────────────────────────────────────────────────────────────────
 * GET /feeds/creator-gated/:username
 *
 * A creator's supporters-only videos, newest first, for the profile page.
 *
 * Deliberately PUBLIC and unfiltered by viewer entitlement: the point of the
 * shelf is to show non-subscribers what they are missing. Cards carry
 * `gated: true` so the UI draws a lock, and playback is refused by the gate
 * rather than by hiding the listing.
 *
 * Returns an empty array rather than 404 for a creator with no gated content,
 * so the profile page can simply hide the section when the list is empty.
 * ──────────────────────────────────────────────────────────────────── */
router.get('/creator-gated/:username', async (req, res) => {
    try {
        const username = String(req.params.username || '').trim().toLowerCase().replace(/^@/, '');
        if (!username || !/^[a-z0-9.-]{3,16}$/.test(username)) {
            return res.status(400).json({ error: 'invalid username', videos: [] });
        }

        const limit = Math.min(parseInt(req.query.limit, 10) || 24, 100);
        const db = await getDb();

        // `$and` rather than a bare `$or`: unavailableMatch()/hiddenFromFeedMatch()
        // spread their own keys in, and a second top-level `$or` would clobber
        // this one silently.
        const query = {
            $and: [{ $or: [{ owner: username }, { hive_author: username }] }],
            gated: true,
            status: 'published',
            hive_author: { $ne: null },
            hive_permlink: { $ne: null },
            ...unavailableMatch(),
            ...hiddenFromFeedMatch(),
        };

        const docs = await db.collection('embed-video')
            .find(query)
            .sort({ createdAt: -1 })
            .limit(limit)
            .toArray();

        const videos = docs.map(transformEmbedVideoToLegacy);
        return res.json({ videos, count: videos.length });
    } catch (err) {
        console.error('GET /feeds/creator-gated error:', err.message);
        return res.status(500).json({ error: 'internal', videos: [] });
    }
});

function validateCommunityId(id) {
    return /^hive-\d+$/.test(String(id || '').trim());
}

// An embed video belongs to a community when the Hive post's `category`
// (parent_permlink) is that community — persisted by embedCategorySync. Some
// posting clients also drop the community id into json_metadata tags, so we match
// either source. This goes in a `$or` (its own key) so it never collides with the
// `hive_tags: { $nin: [...] }` that nsfwFilterHiveTags() spreads in for nsfw exclusion.
function communityMatchClause(communityId) {
    return { $or: [{ category: communityId }, { hive_tags: communityId }] };
}

router.get('/community/:id/new', async (req, res) => {
    try {
        const communityId = String(req.params.id || '').trim();
        if (!validateCommunityId(communityId)) {
            return res.status(400).json({ success: false, error: 'community id must look like "hive-<digits>"' });
        }

        const db = getDb();
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
        const skip = (page - 1) * limit;

        const videosCollection = db.collection('videos');
        const embedVideoCollection = db.collection('embed-video');

        const [legacyVideos, embedVideosRaw] = await Promise.all([
            videosCollection.find({
                ...feedAgeMatch('created'), ...unavailableMatch(), ...hiddenFromFeedMatch(),
                status: 'published',
                owner: { $nin: [...HIDDEN_AUTHORS, ...hiddenListSync()] },
                publishFailed: { $ne: true },
                community: communityId,
                ...nsfwFilterTags(req),
            }).sort({ created: -1 }).limit(limit + skip).toArray(),
            embedVideoCollection.find({
                ...feedAgeMatch('createdAt'), ...unavailableMatch(), ...hiddenFromFeedMatch(),
                status: 'published',
                short: false,
                listed_on_3speak: true,
                hive_author: { $nin: [null, ...HIDDEN_AUTHORS, ...hiddenListSync()] },
                hive_permlink: { $ne: null },
                ...nsfwFilterHiveTags(req),
                ...communityMatchClause(communityId),
            }).sort({ createdAt: -1 }).limit(limit + skip).toArray(),
        ]);

        const embedVideos = embedVideosRaw.map(transformEmbedVideoToLegacy);
        const legacyWithDate = legacyVideos.map(v => ({
            ...v,
            _sortDate: new Date(v.created || v.created_at || 0).getTime(),
        }));

        // Dedup: drop embed entries that already exist in the legacy index.
        const legacyKeys = new Set(legacyWithDate.map(v => `${v.author || v.owner}/${v.permlink}`));
        const uniqueEmbed = embedVideos.filter(ev => !legacyKeys.has(`${ev.author}/${ev.permlink}`));

        const merged = [...legacyWithDate, ...uniqueEmbed].sort((a, b) => b._sortDate - a._sortDate);

        // Chronological like /feeds/new — no ranking — but dismissals still apply.
        const allVideos = await filterForUser(db, req, merged);

        const total = allVideos.length;
        const totalPages = Math.ceil(total / limit);
        const videos = allVideos.slice(skip, skip + limit);
        // Display topic (`tag_v2`), same as the profile grid + home feeds — the
        // community grid uses Card3 too. video_id (legacy) / _embedPermlink (embed)
        // is the ASSET permlink for auto-tags; permlink is the HIVE permlink for
        // viewer tags. Runs before the cleanup delete below.
        await attachTopicTags(
            db,
            videos,
            (v) => ({ author: v.owner, permlink: v.video_id || v._embedPermlink }),
            (v) => ({ author: v.author || v.owner, permlink: v.permlink }),
        );
        videos.forEach(v => { delete v._sortDate; delete v._source; });

        res.json({
            success: true,
            feed: 'community-new',
            community: communityId,
            page, limit, total, totalPages,
            videos,
        });
    } catch (error) {
        console.error('Error fetching community new feed:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

router.get('/community/:id/trending', async (req, res) => {
    try {
        const communityId = String(req.params.id || '').trim();
        if (!validateCommunityId(communityId)) {
            return res.status(400).json({ success: false, error: 'community id must look like "hive-<digits>"' });
        }

        const db = getDb();
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
        const skip = (page - 1) * limit;

        const videosCollection = db.collection('videos');
        const embedVideoCollection = db.collection('embed-video');

        // "Trending" = most-viewed videos in the community *within a recent
        // window* (vs /new which ranks the same recent window by date). The old
        // `trending: true` flag is never set on embed videos, so an embed-based
        // community's trending row was identical to /new. Ranking by `views`
        // (present on both collections) makes it meaningful — but WITHOUT the
        // recency window it surfaced old high-view legacy videos and dropped all
        // recent content, so trending looked disconnected from new. Windowing
        // both collections keeps trending = "recently popular".
        const CANDIDATE_LIMIT = 200;
        const TRENDING_WINDOW_DAYS = 30;
        const windowStart = new Date(Date.now() - TRENDING_WINDOW_DAYS * 24 * 60 * 60 * 1000);

        const [legacyVideos, embedVideosRaw] = await Promise.all([
            videosCollection.find({
                ...feedAgeMatch('created'), ...unavailableMatch(), ...hiddenFromFeedMatch(),
                status: 'published',
                owner: { $nin: [...HIDDEN_AUTHORS, ...hiddenListSync()] },
                publishFailed: { $ne: true },
                community: communityId,
                created: { $gte: windowStart },
                ...nsfwFilterTags(req),
            }).sort({ views: -1 }).limit(CANDIDATE_LIMIT).toArray(),
            embedVideoCollection.find({
                ...feedAgeMatch('createdAt'), ...unavailableMatch(), ...hiddenFromFeedMatch(),
                status: 'published',
                short: false,
                listed_on_3speak: true,
                hive_author: { $nin: [null, ...HIDDEN_AUTHORS, ...hiddenListSync()] },
                hive_permlink: { $ne: null },
                createdAt: { $gte: windowStart },
                ...nsfwFilterHiveTags(req),
                ...communityMatchClause(communityId),
            }).sort({ views: -1 }).limit(CANDIDATE_LIMIT).toArray(),
        ]);

        const embedVideos = embedVideosRaw.map(transformEmbedVideoToLegacy);
        const legacyWithMeta = legacyVideos.map(v => ({
            ...v,
            views: v.views || 0,
            _views: v.views || 0,
            _sortDate: new Date(v.created || v.created_at || 0).getTime(),
        }));
        const embedWithMeta = embedVideos.map(v => ({
            ...v,
            _views: v.views || 0,
            _sortDate: new Date(v.created || v.created_at || 0).getTime(),
        }));

        const legacyKeys = new Set(legacyWithMeta.map(v => `${v.author || v.owner}/${v.permlink}`));
        const uniqueEmbed = embedWithMeta.filter(ev => !legacyKeys.has(`${ev.author}/${ev.permlink}`));

        // Base = views (this is the community "trending" row), then the shared
        // pipeline (interests → retention → sort → hide-seen) tilts it.
        const allVideos = [...legacyWithMeta, ...uniqueEmbed];
        for (const v of allVideos) v._rankScore = (v._views || 0) + 1;
        const rankedVideos = await rankFeed(db, req, allVideos, { scoreField: '_rankScore' });
        const total = rankedVideos.length;
        const totalPages = Math.ceil(total / limit);
        const videos = rankedVideos.slice(skip, skip + limit);
        // Display topic (`tag_v2`) for Card3 — run BEFORE the cleanup delete strips
        // _embedPermlink (the embed asset permlink used for auto-tags).
        await attachTopicTags(
            db,
            videos,
            (v) => ({ author: v.owner, permlink: v.video_id || v._embedPermlink }),
            (v) => ({ author: v.author || v.owner, permlink: v.permlink }),
        );
        videos.forEach(v => { delete v._views; delete v._sortDate; delete v._source; delete v._embedPermlink; delete v._rankScore; delete v.retention_mult; delete v.retention_relq; delete v.interest_match; });

        res.json({
            success: true,
            feed: 'community-trending',
            community: communityId,
            page, limit, total, totalPages,
            videos,
        });
    } catch (error) {
        console.error('Error fetching community trending feed:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Exposed for scripts/test-gated-feed-flag.js. The card mappers drop any field
// they do not name explicitly, which is exactly the kind of regression a test
// should catch rather than a reviewer.
router.__testables = { transformEmbedVideoToLegacy };

module.exports = router;
