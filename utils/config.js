const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const parseBool = (v, fallback) => {
    if (v === undefined || v === null || v === '') return fallback;
    return String(v).toLowerCase() === 'true';
};

module.exports = {
    // ─── Social-link verifier (merged from mantequilla-social-verifier) ───
    SOCIAL_LINKS_COLLECTION: process.env.SOCIAL_LINKS_COLLECTION || 'social_links',
    YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY || '',
    HIVE_AUTH_REQUIRED: parseBool(process.env.HIVE_AUTH_REQUIRED, true),
    SIGNATURE_TIMESTAMP_TOLERANCE_MS: parseInt(process.env.SIGNATURE_TIMESTAMP_TOLERANCE_MS) || 5 * 60 * 1000,
    MAX_LINKS_PER_USER: parseInt(process.env.MAX_LINKS_PER_USER) || 25,
    UNVERIFIED_TTL_DAYS: parseInt(process.env.UNVERIFIED_TTL_DAYS) || 3,
    RATE_LIMIT_WINDOW_MS: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 1000,
    RATE_LIMIT_MAX: parseInt(process.env.RATE_LIMIT_MAX) || 10,

    PORT: process.env.PORT || 3000,
    MONGODB_URI: process.env.MONGODB_URI,
    DATABASE_NAME: process.env.DATABASE_NAME || 'threespeak',
    COLLECTION_NAME: process.env.COLLECTION_NAME || 'contentcreators',
    API_SECRET_KEY: process.env.API_SECRET_KEY,
    ENABLE_MONGO_WRITES: process.env.ENABLE_MONGO_WRITES !== 'false',
    SHORT_SORT_INTERVAL: parseInt(process.env.SHORT_SORT_INTERVAL) || 2,
    HIVE_RPC_ENDPOINTS: (process.env.HIVE_RPC_ENDPOINTS || process.env.HIVE_RPC_ENDPOINT || 'https://techcoderx.com,https://api.deathwing.me,https://api.hive.blog')
        .split(',').map(s => s.trim()).filter(Boolean),
    REWARD_WEIGHT: parseFloat(process.env.REWARD_WEIGHT) || 0.7,
    RESHARE_WEIGHT: parseFloat(process.env.RESHARE_WEIGHT) || 0.15,
    TRENDING_VIEWS_WEIGHT: parseFloat(process.env.TRENDING_VIEWS_WEIGHT) || 1,
    TRENDING_VOTES_WEIGHT: parseFloat(process.env.TRENDING_VOTES_WEIGHT) || 2,
    TRENDING_COMMENTS_WEIGHT: parseFloat(process.env.TRENDING_COMMENTS_WEIGHT) || 3,
    TRENDING_REWARD_WEIGHT: parseFloat(process.env.TRENDING_REWARD_WEIGHT) || 10,
    TRENDING_RESHARE_WEIGHT: parseFloat(process.env.TRENDING_RESHARE_WEIGHT) || 5,
    TRENDING_CANDIDATE_LIMIT: parseInt(process.env.TRENDING_CANDIDATE_LIMIT) || 200,
    // Score multiplier applied to shorts/trending/recommended items whose tags
    // (transcription + hive) match the caller's ?interests=. 1.0 = no effect.
    INTEREST_MULTIPLIER: parseFloat(process.env.INTEREST_MULTIPLIER) || 2.0,
    HIDDEN_AUTHORS: (process.env.HIDDEN_AUTHORS || 'threespeak-fixer')
        .split(',').map(s => s.trim()).filter(Boolean),
    TRENDING_INTERVAL_MIN: parseInt(process.env.TRENDING_INTERVAL_MIN) || 15,

    // ─── Retention ranking (NEW, independent of the legacy trending flagger) ───
    // A separate cron aggregates the watch-duration data (view-durations /
    // view-heatmaps) into a per-video quality score, cached in RETENTION_COLLECTION.
    // Feeds that already use interests / watch-history then multiply their existing
    // score by a bounded retention factor. See services/retention.js + algo.md.
    RETENTION_ENABLED: parseBool(process.env.RETENTION_ENABLED, true),
    RETENTION_INTERVAL_MIN: parseInt(process.env.RETENTION_INTERVAL_MIN) || 5,   // was 15 for trending; retention runs every 5 min
    RETENTION_COLLECTION: process.env.RETENTION_COLLECTION || 'video-retention',
    // How much watch history the SCORING aggregates. Independent of the storage
    // window (WATCH_RETENTION_DAYS, 365) — we keep a year of raw rows but only
    // score on recent behaviour.
    RETENTION_WINDOW_DAYS: parseInt(process.env.RETENTION_WINDOW_DAYS) || 90,
    RETENTION_MIN_SESSION_SECONDS: parseFloat(process.env.RETENTION_MIN_SESSION_SECONDS) || 2, // drop junk/1-beat sessions
    RETENTION_COMPLETION_PCT: parseFloat(process.env.RETENTION_COMPLETION_PCT) || 70,          // watchedPct ≥ this = "finished"
    RETENTION_HOOK_FRAC: parseFloat(process.env.RETENTION_HOOK_FRAC) || 0.15,                  // got past the first 15% = "hooked"
    RETENTION_BAYES_M: parseFloat(process.env.RETENTION_BAYES_M) || 30,          // Bayesian prior strength (≈ viewers needed to trust the raw score)
    // "Watched a meaningful chunk" — a MUCH lower bar than finishing. With the data
    // we actually have, a video people watch a third of the way through is evidence
    // of value, and demanding RETENTION_COMPLETION_PCT (70) before crediting any of
    // it threw that evidence away. See algo.md ("Partial watch time is a signal").
    RETENTION_ENGAGED_PCT: parseFloat(process.env.RETENTION_ENGAGED_PCT ?? '30'),
    // rawQuality weights (renormalized): unique-coverage %, finish rate, engaged rate, hook rate, replay.
    RETENTION_W_PCT: parseFloat(process.env.RETENTION_W_PCT ?? '0.5'),
    RETENTION_W_COMPLETION: parseFloat(process.env.RETENTION_W_COMPLETION ?? '0.3'),
    RETENTION_W_ENGAGED: parseFloat(process.env.RETENTION_W_ENGAGED ?? '0.25'),
    RETENTION_W_HOOK: parseFloat(process.env.RETENTION_W_HOOK ?? '0.2'),
    RETENTION_W_REPLAY: parseFloat(process.env.RETENTION_W_REPLAY ?? '0.1'),
    // Feed multiplier: score *= clamp(1 + WEIGHT*(relQ-1), MIN_MULT, MAX_MULT).
    RETENTION_WEIGHT: parseFloat(process.env.RETENTION_WEIGHT ?? '0.6'),
    RETENTION_MIN_MULT: parseFloat(process.env.RETENTION_MIN_MULT ?? '0.5'),
    RETENTION_MAX_MULT: parseFloat(process.env.RETENTION_MAX_MULT ?? '2'),
    // ── The demotion side needs EVIDENCE (algo.md, "Why a demotion needs evidence")
    // relQ is normalized against the BAND MEAN, which a handful of high-retention
    // videos drag upward — so the typical video lands just under 1.0 and, at the old
    // symmetric multiplier, got demoted BELOW a video with no watch data at all
    // (which scores exactly ×1). Measured on live data: 650 of 1044 scored videos
    // (62%) sat below ×1, and 633 of those had ≤1 distinct viewer. Having a little
    // data was a net penalty — the exact opposite of what the signal is for.
    //
    // So the downside is now gated twice:
    //   confidence = clamp((viewers − MIN) / (FULL − MIN), 0, 1)
    //   shortfall  = max(0, (1 − relQ) − PENALTY_DEADBAND)   → noise near 1.0 is free
    //   mult       = 1 − WEIGHT · confidence · shortfall
    //
    // MIN is a HARD floor, not a soft ramp: at or below MIN distinct viewers we have
    // no evidence at all, so retention can only BOOST, never demote. One person
    // bouncing off a video is not a verdict, and under a smooth ramp it still cost a
    // bad-scoring video ~14% — which is the very inversion this is meant to remove.
    // 633 of the 1044 live scored videos have ≤1 viewer; all of them are now safe.
    // The UPSIDE is untouched and ungated: a good video is boosted from viewer one.
    RETENTION_PENALTY_MIN_VIEWERS: parseFloat(process.env.RETENTION_PENALTY_MIN_VIEWERS ?? '3'),
    RETENTION_PENALTY_FULL_VIEWERS: parseFloat(process.env.RETENTION_PENALTY_FULL_VIEWERS ?? '10'),
    RETENTION_PENALTY_DEADBAND: parseFloat(process.env.RETENTION_PENALTY_DEADBAND ?? '0.1'),
    // Follow feed is chronological — retention only nudges. A recency half-life
    // (hours) keeps "newest first" dominant so retention just reorders similar-age
    // videos. Long default (7 days) → the feed stays close to chronological.
    RETENTION_FOLLOW_HALFLIFE_H: parseFloat(process.env.RETENTION_FOLLOW_HALFLIFE_H ?? '168'),

    // ─── Shorts candidate window (/shortssorted) ──────────────────────────────
    // The default 14-day window is sized for the GLOBAL pool, where two weeks is
    // already hundreds of shorts. A follow feed (?followedby=) draws from one
    // user's following list, so the same window can leave a handful or none — the
    // rails then can't fill a row and silently don't render. Give the follow feed
    // a much longer window so the pool is a real feed rather than a remainder.
    SHORTS_WINDOW_DAYS: parseFloat(process.env.SHORTS_WINDOW_DAYS ?? '14'),
    SHORTS_FOLLOW_WINDOW_DAYS: parseFloat(process.env.SHORTS_FOLLOW_WINDOW_DAYS ?? '60'),

    // ─── Discover feed (/feeds/discover) ──────────────────────────────────────
    // Deliberately BLIND to votes, views and rewards — it exists to surface what
    // those signals bury. A background worker (services/discover.js, hourly) builds
    // the candidate pool and precomputes
    //     base = freshness × newBoost × reshareBoost × retention
    // into DISCOVER_POOL_COLLECTION; the request path only adds interest × jitter,
    // then interleaves random picks. See algo.md ("Discover feed").
    DISCOVER_ENABLED: parseBool(process.env.DISCOVER_ENABLED, true),
    DISCOVER_INTERVAL_MIN: parseInt(process.env.DISCOVER_INTERVAL_MIN) || 60,        // pool rebuild cadence (hourly)
    DISCOVER_POOL_COLLECTION: process.env.DISCOVER_POOL_COLLECTION || 'discover-pool',
    DISCOVER_POOL_CACHE_MS: parseInt(process.env.DISCOVER_POOL_CACHE_MS) || 5 * 60 * 1000, // in-process pool cache TTL

    // Pool sources (unioned + deduped by the worker):
    DISCOVER_WINDOW_DAYS: parseInt(process.env.DISCOVER_WINDOW_DAYS) || 14,          // (a) recent window
    DISCOVER_CANDIDATE_LIMIT: parseInt(process.env.DISCOVER_CANDIDATE_LIMIT) || 400, // (a) per-collection cap, cut by RECENCY
    // (b) random all-time, transcription-tagged. OVERSAMPLED on purpose: roughly
    // half of `subtitles-tags` points at shorts / unlisted / deleted videos that no
    // longer resolve to a published doc, so 2000 sampled ≈ 1000 that actually land.
    DISCOVER_RANDOM_OLD_COUNT: parseInt(process.env.DISCOVER_RANDOM_OLD_COUNT) || 2000,
    DISCOVER_RETENTION_ACTIVE_DAYS: parseInt(process.env.DISCOVER_RETENTION_ACTIVE_DAYS) || 14, // (c) had watch data recently
    DISCOVER_POOL_LIMIT: parseInt(process.env.DISCOVER_POOL_LIMIT) || 4000,          // hard cap on the built pool

    // ── Interest pool (feeds the dedicated /feeds/interests endpoint) ──────────
    // The discover pool is a ~2.7k UNIFORM sample of a ~104k tagged catalogue, so
    // filtering it down to one topic starved the interests feed (science surfaced
    // 29 of its 785 videos - a single page). This second pool is STRATIFIED: it
    // samples up to INTEREST_POOL_PER_TAG videos for EACH topic, so every topic -
    // niche ones included - has real depth to page through.
    INTEREST_POOL_COLLECTION: process.env.INTEREST_POOL_COLLECTION || 'interest-pool',
    INTEREST_POOL_PER_TAG: parseInt(process.env.INTEREST_POOL_PER_TAG) || 800,   // per-topic sample size
    INTEREST_POOL_LIMIT: parseInt(process.env.INTEREST_POOL_LIMIT) || 20000,     // hard cap on the built pool

    // Freshness: fresh uploads matter but must NOT dominate — the whole point of
    // this feed is reviving older work. Still the WEAKEST driver, below retention
    // (~3.1x) and interest (2.5x). freshness = max(0.5^(hrs/HALFLIFE), FLOOR), so
    // the FLOOR *is* the fresh-vs-old spread: 1/FLOOR.
    //   0.65 → 1.54x   |   0.43 → 2.33x  (= 1.5x more recency-biased)
    // Raised the bias to 1.5x because the top of discover was carrying too many
    // years-old videos. Freshness bottoms out at ~3.7 days, after which a 4-day-old
    // and a 4-year-old are equal on age and separated only by quality/interest.
    DISCOVER_HALFLIFE_H: parseFloat(process.env.DISCOVER_HALFLIFE_H ?? '72'),        // freshness half-life (hours)
    DISCOVER_FRESH_FLOOR: parseFloat(process.env.DISCOVER_FRESH_FLOOR ?? '0.43'),    // old-but-great stays competitive
    DISCOVER_NEW_GRACE_H: parseFloat(process.env.DISCOVER_NEW_GRACE_H ?? '12'),      // "really fresh" window
    DISCOVER_NEW_BOOST: parseFloat(process.env.DISCOVER_NEW_BOOST ?? '1.15'),        // modest lift, tapering to 1.0
    DISCOVER_INTEREST_MULTIPLIER: parseFloat(process.env.DISCOVER_INTEREST_MULTIPLIER ?? '2.5'), // > global 2.0
    // Retention is a PRIMARY driver here (trending only tilts it at 0.6). relQ is
    // deliberately compressed near 1.0 by the Bayesian prior (live range ≈
    // 0.63–1.24), so weight 1.0 would move a video only ~2x — a rounding error next
    // to the other factors. 1.5 AMPLIFIES the spread to ≈0.44–1.37 (~3.1x).
    DISCOVER_RETENTION_WEIGHT: parseFloat(process.env.DISCOVER_RETENTION_WEIGHT ?? '1.5'),
    DISCOVER_RETENTION_MIN_MULT: parseFloat(process.env.DISCOVER_RETENTION_MIN_MULT ?? '0.4'),
    DISCOVER_RETENTION_MAX_MULT: parseFloat(process.env.DISCOVER_RETENTION_MAX_MULT ?? '2.5'),
    DISCOVER_JITTER: parseFloat(process.env.DISCOVER_JITTER ?? '0.15'),              // ±15% seeded per-video shuffle
    DISCOVER_EXPLORE_EVERY: parseInt(process.env.DISCOVER_EXPLORE_EVERY) || 4,       // every Nth slot = random pick (25%)

    // ─── Curation signals: the MANUAL votes (utils/curation.js) ───────────────
    // Three deliberate human acts, as opposed to the passive signals (views, watch
    // time) and the on-chain ones (votes, rewards):
    //   reshare — put the video on their own blog        (public endorsement)
    //   save    — added it to a playlist / Watch Later   (intent to come back)
    //   tag     — labelled its topic in the vote dialog  (a curation vote)
    // All three are sparse and high-precision, so the boost is log-damped and
    // hard-capped — one save must LIFT a video, never run away with the feed.
    //   curationBoost = min(CAP, 1 + Wr·ln(1+reshares) + Ws·ln(1+saves) + Wt·ln(1+tags))
    // At n=1 each: reshare +17%, save +21%, tag +14%; all three ≈ +52%.
    CURATION_ENABLED: parseBool(process.env.CURATION_ENABLED, true),
    // The counts are held in-process as one small map (226 curated videos live) and
    // refreshed on a TTL — the per-request $or lookup it replaces cost ~370ms.
    CURATION_CACHE_MS: parseInt(process.env.CURATION_CACHE_MS) || 5 * 60 * 1000,
    // Reshares kept their historic weight (was DISCOVER_RESHARE_WEIGHT) so the
    // discover feed's existing tuning is unchanged by the other two arriving.
    CURATION_RESHARE_WEIGHT: parseFloat(process.env.CURATION_RESHARE_WEIGHT ?? process.env.DISCOVER_RESHARE_WEIGHT ?? '0.25'),
    CURATION_SAVE_WEIGHT: parseFloat(process.env.CURATION_SAVE_WEIGHT ?? '0.3'),
    CURATION_TAG_WEIGHT: parseFloat(process.env.CURATION_TAG_WEIGHT ?? '0.2'),
    CURATION_MAX_BOOST: parseFloat(process.env.CURATION_MAX_BOOST ?? process.env.DISCOVER_RESHARE_MAX_BOOST ?? '2.5'),

    // ─── Follow boost (utils/followBoost.js) ─────────────────────────────────
    // Videos by creators the caller follows rank higher in EVERY feed, not just the
    // dedicated follow feed. Deliberately below the interest multiplier (2.0 global
    // / 2.5 discover): following someone says "show me more of them", not "show me
    // only them" — discover must not collapse into a follow feed.
    FOLLOW_BOOST: parseFloat(process.env.FOLLOW_BOOST ?? '1.6'),
    FOLLOW_BOOST_TTL_MS: parseInt(process.env.FOLLOW_BOOST_TTL_MS) || 10 * 60 * 1000,
    // Hard cap on the follow-set LRU. `?currentuser=` is unauthenticated and each miss
    // allocates a Set of up to several thousand usernames, so an uncapped map is an
    // unauthenticated memory leak. 5k concurrent logged-in browsers is far past real.
    FOLLOW_BOOST_MAX_USERS: parseInt(process.env.FOLLOW_BOOST_MAX_USERS) || 5000,

    // ─── Related videos (/feeds/related/:author/:permlink) ────────────────────
    // Sidebar recommendations biased toward the CURRENT video's winning topic,
    // the user's interests, and the same creator. See routes/feeds.js.
    RELATED_TOPIC_MULT: parseFloat(process.env.RELATED_TOPIC_MULT ?? '3.0'),     // candidate shares current video's topic
    RELATED_INTEREST_MULT: parseFloat(process.env.RELATED_INTEREST_MULT ?? '2.0'), // candidate's topic ∈ user interests
    RELATED_CREATOR_MULT: parseFloat(process.env.RELATED_CREATOR_MULT ?? '2.5'), // same creator (recency already in base)
    RELATED_CREATOR_POOL: parseInt(process.env.RELATED_CREATOR_POOL) || 12,      // how many recent same-creator videos to consider
    RELATED_JITTER: parseFloat(process.env.RELATED_JITTER ?? '0.15'),

    COMMUNITY_SYNC_DELAY_H: parseInt(process.env.COMMUNITY_SYNC_DELAY_H) || 4,
    COMMUNITY_SYNC_INTERVAL_H: parseInt(process.env.COMMUNITY_SYNC_INTERVAL_H) || 4,
    PROFILE_SYNC_DELAY_H: parseInt(process.env.PROFILE_SYNC_DELAY_H) || 3,
    PROFILE_SYNC_INTERVAL_H: parseInt(process.env.PROFILE_SYNC_INTERVAL_H) || 3,
    // Pay-per-listen beneficiary account — must match the frontend's
    // VITE_PPL_BENEFICIARY. A track is "pay-per-listen" when its Hive post
    // routes (near) all beneficiaries here; only those get listen-tracked.
    PPL_BENEFICIARY: process.env.PPL_BENEFICIARY || 'threespeak-audio',
    // --- Video promotion ---
    // Account that receives promotion payments (HBD or HIVE). Users transfer here
    // with memo `promote:<author>/<permlink>`; we verify on-chain before crediting.
    PROMOTION_ACCOUNT: process.env.PROMOTION_ACCOUNT || 'threespeakfund',
    // Cost (in HBD) that buys 24h of promoted position. HIVE payments are valued
    // at the on-chain median price. Keep in sync with the frontend's VITE_ var.
    COST_PER_24H_PROMOTION_HBD: parseFloat(process.env.COST_PER_24H_PROMOTION_HBD) || 0.5,
    // Hard cap on how far out promotedUntil can reach (days from now).
    MAX_PROMOTION_DAYS: parseInt(process.env.MAX_PROMOTION_DAYS) || 7,
};
