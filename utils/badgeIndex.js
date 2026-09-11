const { getDb } = require('./db');
const { getFollowingList, hiveRpcBatch } = require('./hive');

/**
 * The badge index.
 *
 * 3Speak keeps its OWN list of badges in `badge-registry`, with each badge's
 * name, picture, description and counts stored alongside. It used to read
 * @peakd's `badge-500500` follow list live and shape it on every request, which
 * meant two things: the directory could only contain what another company had
 * chosen to curate by hand, and every visitor paid for a pile of Hive calls to
 * find out.
 *
 * Now: a badge created here lands in the database immediately, everything else
 * is refreshed on a schedule, and serving the directory is one database read.
 */

const REGISTRY = 'badge-registry';
const REGISTRY_ACCOUNT = process.env.BADGE_REGISTRY_ACCOUNT || 'badge-500500';
const PROFILE_BATCH = 20;

async function getProfiles(accounts) {
    const out = new Map();
    for (let i = 0; i < accounts.length; i += PROFILE_BATCH) {
        const chunk = accounts.slice(i, i + PROFILE_BATCH);
        const batch = [
            { jsonrpc: '2.0', id: 'accounts', method: 'condenser_api.get_accounts', params: [chunk] },
            ...chunk.map((name, n) => ({
                jsonrpc: '2.0', id: `p${n}`, method: 'bridge.get_profile', params: { account: name }
            }))
        ];
        const results = await hiveRpcBatch(batch);

        for (const r of results) {
            if (!r) continue;
            if (r.id === 'accounts' && Array.isArray(r.result)) {
                for (const raw of r.result) {
                    const entry = out.get(raw.name) || {};
                    entry.meta = parseProfileMeta(raw);
                    entry.created = raw.created || null;
                    entry.postCount = typeof raw.post_count === 'number' ? raw.post_count : 0;
                    entry.creator = raw.recovery_account || null;
                    out.set(raw.name, entry);
                }
            } else if (r.result && r.result.name) {
                const entry = out.get(r.result.name) || {};
                entry.stats = r.result.stats || {};
                entry.reputation = typeof r.result.reputation === 'number' ? r.result.reputation : null;
                out.set(r.result.name, entry);
            }
        }
    }
    return out;
}

/** The `profile` object out of an account's metadata, untruncated. */
function parseProfileMeta(raw) {
    for (const field of ['posting_json_metadata', 'json_metadata']) {
        try {
            const parsed = JSON.parse(raw[field] || '{}');
            if (parsed && parsed.profile && Object.keys(parsed.profile).length) return parsed.profile;
        } catch {
            /* a hand-edited account can hold unparseable metadata; try the next */
        }
    }
    return {};
}

/** Merged entry → the badge fields a card needs. */
function shapeBadge(account, entry) {
    const meta = (entry && entry.meta) || {};
    const stats = (entry && entry.stats) || {};
    return {
        account,
        // The badge's own name, not the account id. Falling back to the account
        // keeps a card readable for a badge whose profile was never filled in.
        title: meta.name || account,
        description: meta.about || '',
        image: meta.profile_image || `https://images.hive.blog/u/${account}/avatar`,
        cover: meta.cover_image || '',
        website: meta.website || '',
        location: meta.location || '',
        recipients: typeof stats.following === 'number' ? stats.following : 0,
        subscribers: typeof stats.followers === 'number' ? stats.followers : 0,
        created: (entry && entry.created) || null,
        creator: (entry && entry.creator) || null,
        posts: (entry && entry.postCount) || 0
    };
}

/** The peakd registry's following list = every badge THEY have curated. */
async function getRegistryAccounts() {
    const list = await getFollowingList(REGISTRY_ACCOUNT);
    return Array.isArray(list) ? list : [];
}

/**
 * Import @peakd's curated list into ours.
 *
 * An INPUT, not the source of truth: anything they add turns up on the next
 * run, and their list being stale, curated against us, or unreachable no longer
 * decides what our own directory contains.
 */
async function importPeakdRegistry() {
    const accounts = await getRegistryAccounts();
    if (!accounts.length) return 0;   // unreachable: keep what we have
    await getDb().collection(REGISTRY).bulkWrite(accounts.map(account => ({
        updateOne: {
            filter: { account },
            update: { $set: { account }, $setOnInsert: { source: 'peakd', addedAt: new Date() } },
            upsert: true,
        },
    })), { ordered: false });
    return accounts.length;
}

/** Write the current on-chain identity of these badges into the index. */
async function indexBadgeAccounts(accounts) {
    if (!accounts.length) return 0;
    const profiles = await getProfiles(accounts);
    const ops = accounts.map((account) => {
        const shaped = shapeBadge(account, profiles.get(account));
        return {
            updateOne: {
                filter: { account },
                update: {
                    $set: {
                        account,
                        title: shaped.title,
                        description: shaped.description,
                        image: shaped.image,
                        cover: shaped.cover,
                        website: shaped.website,
                        location: shaped.location,
                        recipients: shaped.recipients,
                        subscribers: shaped.subscribers,
                        indexedAt: new Date(),
                    },
                    $setOnInsert: { source: 'peakd', addedAt: new Date() },
                },
                upsert: true,
            },
        };
    });
    await getDb().collection(REGISTRY).bulkWrite(ops, { ordered: false });
    return ops.length;
}

/**
 * One badge, indexed NOW.
 *
 * Called the moment a badge is created here, so its creator can find it in the
 * directory straight away instead of waiting for the hourly pass — which is the
 * whole difference between "it worked" and "did that work?".
 */
async function indexOneBadge(account, source = 'peakd') {
    await getDb().collection(REGISTRY).updateOne(
        { account },
        { $set: { account }, $setOnInsert: { source, addedAt: new Date() } },
        { upsert: true },
    );
    if (source !== 'peakd') {
        await getDb().collection(REGISTRY).updateOne({ account }, { $set: { source } });
    }
    await indexBadgeAccounts([account]);
}

/** Import from peakd, then refresh every badge we know about. */
async function runBadgeIndex() {
    const imported = await importPeakdRegistry();
    const accounts = await getDb().collection(REGISTRY).distinct('account');
    const indexed = await indexBadgeAccounts(accounts);
    return { imported, indexed };
}

module.exports = {
    REGISTRY,
    REGISTRY_ACCOUNT,
    getProfiles,
    parseProfileMeta,
    shapeBadge,
    getRegistryAccounts,
    importPeakdRegistry,
    indexBadgeAccounts,
    indexOneBadge,
    runBadgeIndex,
};
