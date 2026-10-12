const { getLinksCollection } = require('../utils/db');
const { hashForHiveUsername } = require('../utils/hash');
const { getPlatform, isLinkEnabled } = require('./platforms');
const { MAX_LINKS_PER_USER } = require('../utils/config');

function requireAdapter(platform) {
    const adapter = getPlatform(platform);
    if (!adapter) {
        const err = new Error(`Unsupported platform: ${platform}`);
        err.code = 'UNSUPPORTED_PLATFORM';
        throw err;
    }
    return adapter;
}

// Has any *other* Hive user already verified this (platform, canonical id)?
async function findOtherVerifiedClaim({ hive_username, platform, platform_username }) {
    return getLinksCollection().findOne({
        platform,
        platform_username,
        verified: true,
        hive_username: { $ne: hive_username },
    });
}

// Resolve the input identifier to its canonical form, fetch the public profile,
// search for the hash, and upsert a single row keyed by (hive_username, platform,
// canonical_username). Throws on:
//   - adapter errors (e.g. CHANNEL_NOT_FOUND, lookup_failed)
//   - CHANNEL_ALREADY_LINKED   (a different hive user has it verified)
//   - TOO_MANY_LINKS           (this hive user is at the per-user cap)
// `ignoreLinkSwitch`: the warm-up "link your channel" task (routes/incubation.js)
// has its own platform list and is not gated by VERIFY_<NAME>.
async function verifyAndStore({ hive_username, platform, platform_username }, { ignoreLinkSwitch = false } = {}) {
    if (!hive_username) throw new Error('hive_username is required');
    if (!platform) throw new Error('platform is required');
    if (!platform_username) throw new Error('platform_username is required');

    const adapter = requireAdapter(platform);
    // New links only for switched-on platforms (VERIFY_<NAME>); unlinking is not gated.
    if (!ignoreLinkSwitch && !isLinkEnabled(adapter.name)) {
        const err = new Error(`Unsupported platform: ${platform}`);
        err.code = 'UNSUPPORTED_PLATFORM';
        throw err;
    }
    const profile = await adapter.fetchProfile(platform_username);
    const hash = hashForHiveUsername(hive_username);
    const verified = typeof profile.text === 'string' && profile.text.includes(hash);

    const filter = {
        hive_username: hive_username.toLowerCase(),
        platform: adapter.name,
        platform_username: profile.canonical_username,
    };

    if (verified) {
        const otherClaim = await findOtherVerifiedClaim({
            hive_username: filter.hive_username,
            platform: filter.platform,
            platform_username: filter.platform_username,
        });
        if (otherClaim) {
            const err = new Error(`This ${adapter.name} channel is already verified by another Hive account`);
            err.code = 'CHANNEL_ALREADY_LINKED';
            err.claimedBy = otherClaim.hive_username;
            throw err;
        }
    }

    const existing = await getLinksCollection().findOne(filter);
    if (!existing) {
        const count = await getLinksCollection().countDocuments({ hive_username: filter.hive_username });
        if (count >= MAX_LINKS_PER_USER) {
            const err = new Error(`Hive user already has ${count} linked accounts (max ${MAX_LINKS_PER_USER})`);
            err.code = 'TOO_MANY_LINKS';
            throw err;
        }
    }

    const now = new Date();
    const update = {
        $set: { hash, verified, last_checked: now, last_error: null },
        $setOnInsert: { first_seen: now },
    };
    if (verified) update.$set.verified_at = now;

    await getLinksCollection().updateOne(filter, update, { upsert: true });
    return getLinksCollection().findOne(filter);
}

// Unlink semantics — rescan, delete only if hash is gone.
//   { status: 'deleted',       record }     hash gone, row removed
//   { status: 'still_present', record }     hash still on profile, row kept (timestamps refreshed)
//   { status: 'not_found' }                 no row exists for the resolved canonical id
//   { status: 'lookup_failed', error }      adapter call failed; row untouched
async function unlinkIfRevoked({ hive_username, platform, platform_username }) {
    if (!hive_username) throw new Error('hive_username is required');
    if (!platform) throw new Error('platform is required');
    if (!platform_username) throw new Error('platform_username is required');

    const adapter = requireAdapter(platform);

    let profile;
    try {
        profile = await adapter.fetchProfile(platform_username);
    } catch (err) {
        return { status: 'lookup_failed', error: err.message || String(err) };
    }

    const filter = {
        hive_username: hive_username.toLowerCase(),
        platform: adapter.name,
        platform_username: profile.canonical_username,
    };
    const existing = await getLinksCollection().findOne(filter);
    if (!existing) {
        return { status: 'not_found' };
    }

    const hash = hashForHiveUsername(hive_username);
    const stillPresent = typeof profile.text === 'string' && profile.text.includes(hash);
    if (stillPresent) {
        const now = new Date();
        await getLinksCollection().updateOne(filter, {
            $set: { verified: true, verified_at: now, last_checked: now, last_error: null },
        });
        const refreshed = await getLinksCollection().findOne(filter);
        return { status: 'still_present', record: refreshed };
    }

    await getLinksCollection().deleteOne(filter);
    return { status: 'deleted', record: existing };
}

module.exports = { verifyAndStore, unlinkIfRevoked };
