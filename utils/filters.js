// Content filter helpers
// Banned filter - always applied
const BANNED_FILTER = { banned: { $ne: true } };

// NSFW filter - controlled by ?nsfw=true query param (default: filtered)
function isNsfwAllowed(req) {
    return req.query.nsfw === 'true';
}

function nsfwFilter(req) {
    if (isNsfwAllowed(req)) return { ...BANNED_FILTER };
    return { ...BANNED_FILTER, isNsfwContent: { $ne: true } };
}

function nsfwFilterTags(req) {
    if (isNsfwAllowed(req)) return { ...BANNED_FILTER };
    return { ...BANNED_FILTER, tags_v2: { $nin: ['nsfw'] }, isNsfwContent: { $ne: true } };
}

function nsfwFilterHiveTags(req) {
    if (isNsfwAllowed(req)) return { ...BANNED_FILTER };
    return { ...BANNED_FILTER, hive_tags: { $nin: ['nsfw', 'NSFW'] }, isNsfwContent: { $ne: true } };
}

module.exports = { BANNED_FILTER, isNsfwAllowed, nsfwFilter, nsfwFilterTags, nsfwFilterHiveTags };
