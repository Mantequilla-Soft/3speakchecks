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
    // rawQuality weights (renormalized): unique-coverage %, finish rate, hook rate, replay.
    RETENTION_W_PCT: parseFloat(process.env.RETENTION_W_PCT ?? '0.5'),
    RETENTION_W_COMPLETION: parseFloat(process.env.RETENTION_W_COMPLETION ?? '0.3'),
    RETENTION_W_HOOK: parseFloat(process.env.RETENTION_W_HOOK ?? '0.2'),
    RETENTION_W_REPLAY: parseFloat(process.env.RETENTION_W_REPLAY ?? '0.1'),
    // Feed multiplier: score *= clamp(1 + WEIGHT*(relQ-1), MIN_MULT, MAX_MULT).
    RETENTION_WEIGHT: parseFloat(process.env.RETENTION_WEIGHT ?? '0.6'),
    RETENTION_MIN_MULT: parseFloat(process.env.RETENTION_MIN_MULT ?? '0.5'),
    RETENTION_MAX_MULT: parseFloat(process.env.RETENTION_MAX_MULT ?? '2'),
    // Follow feed is chronological — retention only nudges. A recency half-life
    // (hours) keeps "newest first" dominant so retention just reorders similar-age
    // videos. Long default (7 days) → the feed stays close to chronological.
    RETENTION_FOLLOW_HALFLIFE_H: parseFloat(process.env.RETENTION_FOLLOW_HALFLIFE_H ?? '168'),

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

    // Freshness: fresh uploads matter but must NOT dominate — the whole point of
    // this feed is reviving older work. Deliberately the WEAKEST driver (~2.3x)
    // so retention (~3.1x) and interest (2.5x) decide the ranking. Freshness hits
    // its floor at ~3 days, after which a 4-day-old and a 4-year-old video are
    // equal on age and are separated only by quality/interest/reshares.
    DISCOVER_HALFLIFE_H: parseFloat(process.env.DISCOVER_HALFLIFE_H ?? '72'),        // freshness half-life (hours)
    DISCOVER_FRESH_FLOOR: parseFloat(process.env.DISCOVER_FRESH_FLOOR ?? '0.65'),    // old-but-great stays competitive
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
    // Reshares: a real curation signal (someone put it on their own blog), but a
    // popularity one — so log-damped and hard-capped so it can't dominate.
    //   reshareBoost = min(1 + W·ln(1+n), CAP)
    DISCOVER_RESHARE_WEIGHT: parseFloat(process.env.DISCOVER_RESHARE_WEIGHT ?? '0.25'),
    DISCOVER_RESHARE_MAX_BOOST: parseFloat(process.env.DISCOVER_RESHARE_MAX_BOOST ?? '2.0'),
    DISCOVER_JITTER: parseFloat(process.env.DISCOVER_JITTER ?? '0.15'),              // ±15% seeded per-video shuffle
    DISCOVER_EXPLORE_EVERY: parseInt(process.env.DISCOVER_EXPLORE_EVERY) || 4,       // every Nth slot = random pick (25%)

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
