/**
 * "Made from this" (utils/derivedStore.js): what was made from a post, for the
 * rail under it on 3speak.tv (audiograms of an episode, clips of a stream, Shorts
 * and remixes of a video, reactions, the narration of a written post).
 *
 *   POST /derived/register { author, permlink }   (the derived HIVE post)
 *       Called by 3speak.tv right after it publishes a derived post. Reads the
 *       post from Hive and indexes what its json_metadata says it was made from
 *       (utils/derivedSource.js). No signature: the row only repeats the post's
 *       own on-chain claim, so forging one means posting as that account. An
 *       edit that drops the source drops the row on the next register.
 *       Idempotent; 404 + retry while a fresh post is not readable yet.
 *
 *   GET /derived/:author/:permlink?limit=24        (the SOURCE post)
 *       &by=<creator>&media=short&order=start    one creator's Shorts of it, in
 *                                                the order of the source (a
 *                                                virtual series: "Part 2 of 4")
 *       { items: [{ author, permlink, kind, media, title, thumbnail, duration,
 *         start?, end?, created }], counts: { kind: n }, total }
 *       Hidden creators are left out. Cached a minute per source; a register
 *       for that source drops the entry.
 */
const express = require('express');
const { getDb } = require('../utils/db');
const { hiveRpcBatch } = require('../utils/hive');
const { hiddenListSync } = require('../utils/hiddenCreators');
const { ENABLE_MONGO_WRITES } = require('../utils/config');
const { ACCOUNT_RE, PERMLINK_RE } = require('../utils/derivedSource');
const { saveDerived, listDerived } = require('../utils/derivedStore');

const router = express.Router();

const MAX_LIMIT = 60;
const MEDIA = ['short', 'video', 'audio', 'post'];
const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX = 2000;
const cache = new Map(); // "author/permlink|limit" -> { at, body }

function dropCached(author, permlink) {
    const prefix = `${author}/${permlink}|`;
    for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
}

router.post('/derived/register', express.json({ limit: '4kb' }), async (req, res) => {
    if (!ENABLE_MONGO_WRITES) {
        return res.status(503).json({ success: false, error: 'Writes disabled' });
    }
    const author = String(req.body?.author || '').toLowerCase();
    const permlink = String(req.body?.permlink || '');
    if (!ACCOUNT_RE.test(author) || !PERMLINK_RE.test(permlink)) {
        return res.status(400).json({ success: false, error: 'invalid author or permlink' });
    }
    try {
        const [r] = await hiveRpcBatch([{
            jsonrpc: '2.0', id: 0, method: 'condenser_api.get_content', params: [author, permlink],
        }]);
        const post = r?.result;
        // A just-broadcast post can take a block or two to be readable.
        if (!post?.author) {
            return res.status(404).json({ success: false, error: 'post not found yet', retry: true });
        }
        if (post.author !== author) {
            return res.status(400).json({ success: false, error: 'post author mismatch' });
        }
        const { row, removed } = await saveDerived(getDb(), post);
        if (row) dropCached(row.source_author, row.source_permlink);
        if (!row && !removed) {
            return res.status(400).json({ success: false, error: 'post names no source' });
        }
        res.json({
            success: true,
            ...(row ? { derived: { kind: row.kind, source: `${row.source_author}/${row.source_permlink}` } } : { removed: true }),
        });
    } catch (error) {
        console.error('[derived] register failed:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

router.get('/derived/:author/:permlink', async (req, res) => {
    const author = String(req.params.author || '').toLowerCase();
    const permlink = String(req.params.permlink || '');
    if (!ACCOUNT_RE.test(author) || !PERMLINK_RE.test(permlink)) {
        return res.status(400).json({ success: false, error: 'invalid author or permlink' });
    }
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || 24));
    const by = ACCOUNT_RE.test(String(req.query.by || '').toLowerCase()) ? String(req.query.by).toLowerCase() : null;
    const media = MEDIA.includes(req.query.media) ? req.query.media : null;
    const order = req.query.order === 'start' ? 'start' : 'new';
    const key = `${author}/${permlink}|${limit}|${by || ''}|${media || ''}|${order}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return res.json(hit.body);
    try {
        const hidden = hiddenListSync();
        const body = by && hidden.includes(by)
            ? { items: [], counts: {}, total: 0 }
            : await listDerived(getDb(), author, permlink, { limit, exclude: hidden, by, media, order });
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
        cache.set(key, { at: Date.now(), body });
        res.json(body);
    } catch (error) {
        console.error('[derived] list failed:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

router._cache = cache;
module.exports = router;
