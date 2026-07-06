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
