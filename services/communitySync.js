const { getDb } = require('../utils/db');
const { HIVE_RPC_ENDPOINTS } = require('../utils/config');


/**
 * Community avatars, which bridge.get_community does NOT return.
 *
 * A community is an account, so its picture lives in the account's
 * posting_json_metadata like anyone else's. Without indexing it the grid falls
 * back to images.hive.blog, and that proxy cannot read images.3speak.tv — so a
 * community created here showed a grey placeholder while its avatar sat on our
 * own CDN.
 */
async function fetchCommunityAvatars(names) {
    const out = new Map();
    if (!names.length) return out;
    for (const endpoint of HIVE_RPC_ENDPOINTS) {
        try {
            const resp = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', method: 'condenser_api.get_accounts', params: [names], id: 1 }),
                signal: AbortSignal.timeout(15000)
            });
            const data = await resp.json();
            for (const acct of data?.result || []) {
                let profile = {};
                for (const field of ['posting_json_metadata', 'json_metadata']) {
                    try {
                        const parsed = JSON.parse(acct[field] || '{}');
                        if (parsed?.profile && Object.keys(parsed.profile).length) { profile = parsed.profile; break; }
                    } catch { /* hand-edited metadata; try the other field */ }
                }
                out.set(acct.name, {
                    image: String(profile.profile_image || '').trim(),
                    cover: String(profile.cover_image || '').trim(),
                });
            }
            return out;
        } catch (err) {
            console.error(`Community avatar fetch failed for ${endpoint}:`, err.message);
        }
    }
    return out;
}

async function syncHiveCommunities() {
    console.log('Starting Hive community sync...');
    const db = getDb();
    const commCollection = db.collection('hivecommunities');
    let totalSynced = 0;
    let last = '';

    try {
        // Paginate through all communities via bridge.list_communities
        while (true) {
            const params = { limit: 100, sort: 'rank' };
            if (last) params.last = last;

            let listResult;
            for (const endpoint of HIVE_RPC_ENDPOINTS) {
                try {
                    const resp = await fetch(endpoint, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ jsonrpc: '2.0', method: 'bridge.list_communities', params, id: 1 }),
                        signal: AbortSignal.timeout(15000)
                    });
                    const data = await resp.json();
                    listResult = data.result;
                    break;
                } catch (err) {
                    console.error(`Community list fetch failed for ${endpoint}:`, err.message);
                }
            }

            if (!listResult || listResult.length === 0) break;

            // Fetch full details (with description) in batches of 10
            for (let i = 0; i < listResult.length; i += 10) {
                const batch = listResult.slice(i, i + 10);
                const details = await Promise.all(batch.map(async (comm) => {
                    for (const endpoint of HIVE_RPC_ENDPOINTS) {
                        try {
                            const resp = await fetch(endpoint, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ jsonrpc: '2.0', method: 'bridge.get_community', params: { name: comm.name }, id: 1 }),
                                signal: AbortSignal.timeout(10000)
                            });
                            const data = await resp.json();
                            if (data.result) return data.result;
                        } catch (err) {
                            // silently try next endpoint
                        }
                    }
                    console.error(`Community detail fetch failed for ${comm.name}: all endpoints failed`);
                    return null;
                }));

                const avatars = await fetchCommunityAvatars(details.filter(Boolean).map(d => d.name));
                const ops = details.filter(Boolean).map(d => ({
                    updateOne: {
                        filter: { name: d.name },
                        update: {
                            $set: {
                                title: d.title,
                                about: d.about || '',
                                description: d.description || '',
                                lang: d.lang || 'en',
                                is_nsfw: d.is_nsfw || false,
                                subscribers: d.subscribers || 0,
                                num_authors: d.num_authors || 0,
                                sum_pending: d.sum_pending || 0,
                                image: avatars.get(d.name)?.image || '',
                                cover: avatars.get(d.name)?.cover || '',
                                used: true
                            }
                        },
                        upsert: true
                    }
                }));

                if (ops.length > 0) {
                    await commCollection.bulkWrite(ops);
                    totalSynced += ops.length;
                }
            }

            last = listResult[listResult.length - 1].name;
            if (listResult.length < 100) break;
        }

        console.log(`Community sync complete: ${totalSynced} communities synced`);
    } catch (error) {
        console.error('Community sync failed:', error);
    }
}


/**
 * Index ONE community immediately.
 *
 * The full sync paginates every community on Hive on a schedule, which is the
 * right shape for catching edits made on other frontends but the wrong one for
 * a community somebody just created here: they would not see it in 3Speak's own
 * list until the next pass. Same reasoning as the badge index.
 *
 * Reads the community from the chain rather than trusting the caller, so this
 * cannot be used to plant a row for something that does not exist.
 */
async function indexOneCommunity(name) {
    const clean = String(name || '').trim().toLowerCase();
    if (!/^hive-\d{5,8}$/.test(clean)) return false;

    for (const endpoint of HIVE_RPC_ENDPOINTS) {
        try {
            const resp = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', method: 'bridge.get_community', params: { name: clean }, id: 1 }),
                signal: AbortSignal.timeout(15000)
            });
            const data = await resp.json();
            const d = data?.result;
            if (!d || !d.name) return false;
            const art = (await fetchCommunityAvatars([d.name])).get(d.name) || {};
            await getDb().collection('hivecommunities').updateOne(
                { name: d.name },
                {
                    $set: {
                        title: d.title,
                        about: d.about || '',
                        description: d.description || '',
                        lang: d.lang || 'en',
                        is_nsfw: d.is_nsfw || false,
                        subscribers: d.subscribers || 0,
                        num_authors: d.num_authors || 0,
                        sum_pending: d.sum_pending || 0,
                        image: art.image || '',
                        cover: art.cover || '',
                        used: true
                    }
                },
                { upsert: true }
            );
            return true;
        } catch (err) {
            console.error(`Indexing ${clean} failed for ${endpoint}:`, err.message);
        }
    }
    return false;
}

module.exports = { syncHiveCommunities, indexOneCommunity };
