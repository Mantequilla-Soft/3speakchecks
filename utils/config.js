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
    // The `/feed/:username` follow feed gets its OWN recency half-life (shorter → newer
    // ranks higher). Kept separate from RETENTION_FOLLOW_HALFLIFE_H, which the tag feed
    // and firstUploads also use — those should stay on the gentler 7-day decay.
    // 2026-07-22: 96h (4 days) so followed creators' newest uploads sit higher.
    FOLLOW_FEED_HALFLIFE_H: parseFloat(process.env.FOLLOW_FEED_HALFLIFE_H ?? '96'),
    // How far back /feeds/new-from-following looks for unwatched uploads by creators
    // you follow. A week: long enough that a couple of days away still shows you what
    // you missed, short enough that "new" still means new.
    NEW_FROM_FOLLOWING_DAYS: parseInt(process.env.NEW_FROM_FOLLOWING_DAYS ?? '7', 10),
    // Interests feed gets a mild extra recency tilt on top of `base`'s freshness:
    //   × (1 + TILT · max(0, 1 − ageDays/DAYS))
    // A brand-new video ×1.35, tapering linearly to ×1.0 at 21 days+. Gentle — the
    // topic match and quality still dominate, this just breaks ties toward newer.
    INTEREST_RECENCY_TILT: parseFloat(process.env.INTEREST_RECENCY_TILT ?? '0.35'),
    INTEREST_RECENCY_DAYS: parseFloat(process.env.INTEREST_RECENCY_DAYS ?? '21'),

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
    // The long AGE TAIL below the fast floor. The fast decay bottoms out at ~3.7
    // days, which used to make a 5-month-old and a 4-year-old video IDENTICAL on
    // age — the only thing age ever did past that was the 6-year hard cutoff, and
    // >2y videos were all over the feed. The floor now decays slowly with age:
    //   freshness = max( 0.5^(hrs/HALFLIFE), FLOOR · max(0.5^(years/AGE_HALFLIFE_Y), AGE_FLOOR) )
    // At the defaults (1y half-life, 0.25 floor) the tail bottoms out exactly at
    // the 2-year mark: 5mo → 0.32, 1y → 0.22, ≥2y → 0.107 flat. A 5-month-old
    // outranks a 4-year-old ~3× on age; ancient still isn't zero, so a genuinely
    // great old video can be lifted back up by retention + curation.
    // AGE_HALFLIFE_Y=0 disables the tail (old flat-floor behaviour).
    DISCOVER_AGE_HALFLIFE_Y: parseFloat(process.env.DISCOVER_AGE_HALFLIFE_Y ?? '1'),
    DISCOVER_AGE_FLOOR: parseFloat(process.env.DISCOVER_AGE_FLOOR ?? '0.25'),
    DISCOVER_NEW_GRACE_H: parseFloat(process.env.DISCOVER_NEW_GRACE_H ?? '12'),      // "really fresh" window
    DISCOVER_NEW_BOOST: parseFloat(process.env.DISCOVER_NEW_BOOST ?? '1.15'),        // gentle first-traction nudge, tapers to 1

    // ── RECENCY BOOST: a continuous recency premium in the SCORE, decoupled from the
    // age bands ───────────────────────────────────────────────────────────────────
    // A smooth multiplier folded into `base`: strongest for a brand-new upload, halving
    // its extra lift every DISCOVER_RECENCY_HALFLIFE_H, back to ×1 after a few days.
    //   recencyBoost = 1 + DISCOVER_RECENCY_BOOST · 0.5^(ageHours / DISCOVER_RECENCY_HALFLIFE_H)
    //   defaults: 0h ×3.0, 10h ×2.4, 1d ×2.0, 2d ×1.5, 4d ×1.16, 7d ~×1.03.
    // Unlike the <10h age band (which sets HOW MANY fresh videos a discover page holds),
    // this sets HOW HIGH a recent video scores — so more-recent videos lead in the
    // interests feed (pure score, no bands), the follow feed, AND the within-band order
    // of discover, regardless of the other multipliers (curation ≤2.5, comment ≤1.8,
    // retention ≤2.5) that would otherwise let an engaged older video outrank a fresh one.
    // Continuous (not a <10h step), so "newer ranks higher" is a real gradient.
    DISCOVER_RECENCY_BOOST: parseFloat(process.env.DISCOVER_RECENCY_BOOST ?? '2'),           // extra lift at age 0 (0 = off)
    DISCOVER_RECENCY_HALFLIFE_H: parseFloat(process.env.DISCOVER_RECENCY_HALFLIFE_H ?? '18'), // how fast the premium fades
    // Boundary (hours) of the dedicated ultra-fresh age BAND at the front of the discover
    // distribution (its own guaranteed page share — see DISCOVER_AGE_WEIGHTS). Composition
    // only; the recency premium above is what boosts the SCORE.
    DISCOVER_ULTRAFRESH_HOURS: parseFloat(process.env.DISCOVER_ULTRAFRESH_HOURS ?? '10'),
    DISCOVER_INTEREST_MULTIPLIER: parseFloat(process.env.DISCOVER_INTEREST_MULTIPLIER ?? '2.5'), // > global 2.0
    // Retention is a PRIMARY driver here (trending only tilts it at 0.6). relQ is
    // deliberately compressed near 1.0 by the Bayesian prior (live range ≈
    // 0.63–1.24), so weight 1.0 would move a video only ~2x — a rounding error next
    // to the other factors. 1.5 AMPLIFIES the spread to ≈0.44–1.37 (~3.1x).
    DISCOVER_RETENTION_WEIGHT: parseFloat(process.env.DISCOVER_RETENTION_WEIGHT ?? '1.5'),
    DISCOVER_RETENTION_MIN_MULT: parseFloat(process.env.DISCOVER_RETENTION_MIN_MULT ?? '0.4'),
    DISCOVER_RETENTION_MAX_MULT: parseFloat(process.env.DISCOVER_RETENTION_MAX_MULT ?? '2.5'),
    DISCOVER_JITTER: parseFloat(process.env.DISCOVER_JITTER ?? '0.15'),              // ±15% seeded per-video jitter
    DISCOVER_EXPLORE_EVERY: parseInt(process.env.DISCOVER_EXPLORE_EVERY) || 4,       // every Nth slot = exploration pick (25%) — legacy interleave only

    // ── Target AGE DISTRIBUTION of the discover page (the primary age control) ──
    // The page is COMPOSED to these proportions directly (age-stratified interleave,
    // utils/discoverScore.js), rather than hoping a freshness curve + an explore
    // quota emergently produce them. That approach structurally COULDN'T hit an
    // arbitrary target: the head slots came straight off the top of the score order,
    // which is ~100% <30d, so >70% of the page was always <30d no matter the tuning.
    //
    // Bands are fixed at 7d / 30d / 6mo / 1y / 2y (see AGE_BAND_DAYS); the weights
    // are their share of every page and need not sum to 1 (they're normalized).
    // Within a band, videos are ordered by discover_score — quality still picks
    // WHICH videos surface, the weights only set HOW MANY of each age. A band with
    // too few videos hands its slots to the others (graceful backfill). The mix
    // holds at EVERY page depth, so pagination stays consistent.
    DISCOVER_AGE_STRATIFY: parseBool(process.env.DISCOVER_AGE_STRATIFY, true),
    //                       <10h   10h-7d  7-30d  30d-6mo 6mo-1y  1y-2y  >2y
    // 7 bands (2026-07-22): a dedicated ULTRA-FRESH <10h band was carved off the front
    // of the old <7d 0.56 share — <10h now gets a guaranteed 0.16 of every page (at the
    // TOP, since the scheduler front-loads high-weight bands), and 10h-7d keeps 0.40.
    // Fresh total (<7d) is still 0.56; it's just split so brand-new uploads lead.
    // A band that's short of videos (only ~15 exist <10h) backfills into the others.
    // ⚠️ MUST stay aligned 1:1 with AGE_BAND_DAYS in utils/discoverScore.js.
    DISCOVER_AGE_WEIGHTS: (process.env.DISCOVER_AGE_WEIGHTS || '0.16, 0.40, 0.22, 0.11, 0.06, 0.03, 0.02')
      .split(',').map((s) => parseFloat(s.trim())).filter((n) => Number.isFinite(n)),

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

    // ─── Comment boost (utils/commentBoost.js + services/commentCounts.js) ─────
    // Comment counts live ONLY on Hive (Mongo's stats.num_comments is empty on every
    // doc). So a background sync (in-process, every COMMENT_SYNC_INTERVAL_MIN) fetches
    // top-level comment counts from Hive for videos younger than COMMENT_SYNC_MAX_AGE_DAYS
    // — bounding the fetch to a few thousand recent videos — and stamps them into the
    // `video-comment-counts` collection, which the feeds then read cheaply.
    //   commentBoost = min(CAP, 1 + W·ln(1 + effective))
    // Modest + capped, same shape as the reshare boost. Applied to discover/interests
    // (folded into pool `base`) and the follow feed.
    COMMENT_BOOST_ENABLED: parseBool(process.env.COMMENT_BOOST_ENABLED, true),
    COMMENT_BOOST_WEIGHT: parseFloat(process.env.COMMENT_BOOST_WEIGHT ?? '0.2'),
    COMMENT_BOOST_MAX: parseFloat(process.env.COMMENT_BOOST_MAX ?? '1.8'),
    // Comments posted through the 3Speak frontend (json_metadata.app ~ /3speak/) are a
    // stronger signal than generic Hive comments, so they count NATIVE_MULT× toward the
    // "effective" comment total: effective = comments + (NATIVE_MULT − 1)·native.
    COMMENT_NATIVE_MULT: parseFloat(process.env.COMMENT_NATIVE_MULT ?? '1.5'),
    COMMENT_SYNC_ENABLED: parseBool(process.env.COMMENT_SYNC_ENABLED, true),
    COMMENT_SYNC_INTERVAL_MIN: parseInt(process.env.COMMENT_SYNC_INTERVAL_MIN) || 30,
    COMMENT_SYNC_MAX_AGE_DAYS: parseInt(process.env.COMMENT_SYNC_MAX_AGE_DAYS) || 30,   // only fetch comments for videos this fresh
    COMMENT_SYNC_MAX_VIDEOS: parseInt(process.env.COMMENT_SYNC_MAX_VIDEOS) || 8000,     // hard cap per run (safety)
    COMMENT_CACHE_MS: parseInt(process.env.COMMENT_CACHE_MS) || 5 * 60 * 1000,          // in-process count-map TTL (follow feed)

    // ─── Feed card stats (services/videoStats.js) ─────────────────────────────
    // The payout / vote / comment numbers on a feed card used to be fetched by EVERY
    // browser, one condenser_api.get_content per visible card — ~964KB and ~1.3s for a
    // 24-card page, of which ~85% was the active_votes array we only ever counted.
    // Instead the checker keeps them in `video-stats` (refreshed from Hive in the
    // background, shared by all users) and stamps them into stats.* on feed responses,
    // so the browser needs no Hive calls at all.
    //
    // OFF by default: with it off, responses are byte-identical to before and the
    // frontend keeps its own fetch, so deploying this is inert until switched on.
    VIDEO_STATS_ENABLED: parseBool(process.env.VIDEO_STATS_ENABLED, false),
    // How stale a stored row may be before it's queued for a background refresh.
    VIDEO_STATS_TTL_MIN: parseInt(process.env.VIDEO_STATS_TTL_MIN) || 20,
    // Background drain cadence + how many posts one drain may fetch from Hive.
    VIDEO_STATS_DRAIN_SEC: parseInt(process.env.VIDEO_STATS_DRAIN_SEC) || 20,
    VIDEO_STATS_DRAIN_BATCH: parseInt(process.env.VIDEO_STATS_DRAIN_BATCH) || 120,
    // Safety cap on the pending-refresh queue so a traffic spike can't grow it without bound.
    VIDEO_STATS_QUEUE_MAX: parseInt(process.env.VIDEO_STATS_QUEUE_MAX) || 5000,

    // Accounts excluded from the LEADERBOARDS only (and the leaderboard-derived
    // creator suggestions) — e.g. bots/spam gaming the boards. This is NARROWER than
    // the site-wide hidden-creators list: these accounts still appear in feeds/search/
    // their own profile; they're just kept off the boards. Comma-separated, lowercased.
    LEADERBOARD_EXCLUDED_USERS: (process.env.LEADERBOARD_EXCLUDED_USERS || 'badadib')
        .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),

    // ─── "Follow these" creator suggestions (/feeds/suggested-creators) ───────
    // A who-to-follow rail for the discover / interests feeds: creators who posted
    // interest-matching videos in the last SUGGEST_WINDOW_DAYS, ranked by the
    // engagement on their recent work (views + comments + reshares). Topic membership
    // comes from the pre-built `leaderboard-topics-v2` (robust — it doesn't depend on
    // a fresh video being transcribed yet); the engagement is aggregated from the
    // video docs + video-comment-counts + reshares. See utils/suggestedCreators.js.
    SUGGEST_CREATORS_ENABLED: parseBool(process.env.SUGGEST_CREATORS_ENABLED, true),
    SUGGEST_WINDOW_DAYS: parseInt(process.env.SUGGEST_WINDOW_DAYS) || 30,
    SUGGEST_CACHE_MS: parseInt(process.env.SUGGEST_CACHE_MS) || 15 * 60 * 1000,
    SUGGEST_MAX_LIMIT: parseInt(process.env.SUGGEST_MAX_LIMIT) || 30,
    // Engagement blend, on ln(1+x) so views (which dwarf the others) don't dominate.
    // Comments and reshares are the stronger "someone cared" signals, so weighted up.
    SUGGEST_W_VIEWS: parseFloat(process.env.SUGGEST_W_VIEWS ?? '1'),
    SUGGEST_W_COMMENTS: parseFloat(process.env.SUGGEST_W_COMMENTS ?? '2'),
    SUGGEST_W_RESHARES: parseFloat(process.env.SUGGEST_W_RESHARES ?? '3'),

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

    // --- Thumbnail backfill (services/thumbnailSync.js) ---
    // Repairs embed-video docs whose thumbnail_url is null but whose Hive post
    // carries the image (livestream VODs, third-party embed-API uploads). Stopgap
    // until the upstream publisher copies the thumbnail onto the doc itself.
    THUMBNAIL_SYNC_ENABLED: parseBool(process.env.THUMBNAIL_SYNC_ENABLED, true),
    THUMBNAIL_SYNC_INTERVAL_MIN: parseInt(process.env.THUMBNAIL_SYNC_INTERVAL_MIN) || 10,
    // Docs per run. The backlog drains over successive runs rather than in one
    // long burst, so a run never holds the RPC pool for more than a few seconds.
    THUMBNAIL_SYNC_BATCH: parseInt(process.env.THUMBNAIL_SYNC_BATCH) || 60,
    // A post with no image in its metadata is stamped and skipped for a while,
    // otherwise every run would re-fetch the same permanent misses. Recent uploads
    // get the short cadence (the enricher may still be catching up), older ones
    // only an occasional recheck.
    THUMBNAIL_SYNC_FRESH_DAYS: parseInt(process.env.THUMBNAIL_SYNC_FRESH_DAYS) || 2,
    THUMBNAIL_SYNC_FRESH_RECHECK_MIN: parseInt(process.env.THUMBNAIL_SYNC_FRESH_RECHECK_MIN) || 30,
    THUMBNAIL_SYNC_RECHECK_DAYS: parseInt(process.env.THUMBNAIL_SYNC_RECHECK_DAYS) || 7,
};
