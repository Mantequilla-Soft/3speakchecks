const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');
const { HIVE_RPC_ENDPOINTS } = require('../utils/config');

// Full community metadata (about + description + rules) lives in this
// checker-OWNED collection. We can't use the shared `hivecommunities`
// collection for it: another (Mongoose) service owns that one and periodically
// overwrites each doc with summary-only fields (title/subscribers/num_authors),
// wiping any about/description/rules we write there. This collection is ours.
const CACHE_COLLECTION = 'community_details';
const TTL_MS = 24 * 60 * 60 * 1000; // refresh from Hive at most once a day

async function fetchFromHive(name) {
    for (const endpoint of HIVE_RPC_ENDPOINTS) {
        try {
            const resp = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', method: 'bridge.get_community', params: { name }, id: 1 }),
                signal: AbortSignal.timeout(10000),
            });
            const data = await resp.json();
            if (data.result) return data.result;
        } catch (_) {
            // try next endpoint
        }
    }
    return null;
}

function normalize(d) {
    return {
        name: d.name,
        title: d.title || '',
        about: d.about || '',
        description: d.description || '',
        // bridge.get_community returns the community rules as `flag_text`.
        rules: d.flag_text || '',
        subscribers: d.subscribers || 0,
        num_authors: d.num_authors || 0,
        lang: d.lang || 'en',
        is_nsfw: !!d.is_nsfw,
    };
}

const stripMeta = ({ _id, cachedAt, ...rest }) => rest;

// GET /community/:name — full metadata for one Hive community, served from a
// checker-owned cache and backfilled from Hive (bridge.get_community) on a
// cache miss, so the frontend never has to query the blockchain directly.
router.get('/community/:name', async (req, res) => {
    try {
        const name = String(req.params.name || '').trim().toLowerCase();
        if (!name) return res.status(400).json({ success: false, error: 'Missing community name' });

        const col = getDb().collection(CACHE_COLLECTION);
        const cached = await col.findOne({ name });
        const fresh = cached && cached.cachedAt && (Date.now() - new Date(cached.cachedAt).getTime() < TTL_MS);
        if (fresh) return res.json({ success: true, community: stripMeta(cached) });

        const result = await fetchFromHive(name);
        if (!result) {
            // Hive unreachable — serve stale cache if we have any, else 404.
            if (cached) return res.json({ success: true, community: stripMeta(cached) });
            return res.status(404).json({ success: false, error: 'Community not found' });
        }

        const community = normalize(result);
        await col.updateOne({ name }, { $set: { ...community, cachedAt: new Date() } }, { upsert: true });
        return res.json({ success: true, community });
    } catch (err) {
        console.error('GET /community/:name failed:', err);
        return res.status(500).json({ success: false, error: 'Internal error' });
    }
});

module.exports = router;
