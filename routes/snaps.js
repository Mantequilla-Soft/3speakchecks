// Community "snaps" — short WRITTEN posts a creator publishes to their followers.
//
// The snap is a real Hive comment (published client-side under @peak.snaps, the same
// container 3Speak shorts use). We index its permlink here so the profile's Community
// tab loads fast from Mongo instead of walking the chain.
//
// The post itself is the proof of authorship: POST /snaps just names a permlink, and
// we RE-FETCH it from Hive and store OUR read of it — so nobody can index a snap onto
// someone else's profile, and we never trust client-supplied body/title.

const express = require('express');
const dhive = require('@hiveio/dhive');
const { getDb } = require('../utils/db');
const { HIVE_RPC_ENDPOINTS } = require('../utils/config');

const router = express.Router();
const client = new dhive.Client(HIVE_RPC_ENDPOINTS);

const COLLECTION = 'community-snaps';
const SNAP_APP = '3speak/snap'; // json_metadata.app our composer stamps on a snap
const norm = (s) => String(s || '').trim().toLowerCase();

let _indexed = false;
async function ensureIndex() {
  if (_indexed) return;
  _indexed = true;
  try { await getDb().collection(COLLECTION).createIndex({ owner: 1, created: -1 }); } catch (_) { /* best effort */ }
}

function parseMeta(post) {
  try {
    return typeof post.json_metadata === 'string'
      ? JSON.parse(post.json_metadata || '{}')
      : (post.json_metadata || {});
  } catch (_) { return {}; }
}

// A snap is broadcast, then indexed a beat later — the RPC may not have it yet, so
// retry across the block time before giving up.
async function fetchPost(author, permlink, tries = 6, delayMs = 1500) {
  for (let i = 0; i < tries; i++) {
    try {
      const post = await client.database.call('get_content', [author, permlink]);
      if (post && post.author && String(post.permlink) === permlink) return post;
    } catch (_) { /* transient RPC error — retry */ }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

/**
 * POST /snaps  { author, permlink }
 * Verify the on-chain snap and index it. Idempotent (re-index = refresh from chain).
 */
router.post('/snaps', async (req, res) => {
  try {
    const owner = norm(req.body?.author || req.body?.owner);
    const permlink = String(req.body?.permlink || '').trim();
    if (!owner || !permlink) {
      return res.status(400).json({ success: false, error: 'author and permlink are required' });
    }

    const post = await fetchPost(owner, permlink);
    if (!post || !post.author) {
      return res.status(404).json({ success: false, error: 'post not found on-chain (try again in a moment)' });
    }
    if (norm(post.author) !== owner) {
      return res.status(403).json({ success: false, error: 'author mismatch' });
    }
    const meta = parseMeta(post);
    if (String(meta.app || '') !== SNAP_APP) {
      return res.status(400).json({ success: false, error: 'not a 3Speak snap' });
    }

    await ensureIndex();
    const _id = `${owner}/${permlink}`;
    const doc = {
      owner,
      permlink,
      title: String(post.title || '').slice(0, 300),
      body: String(post.body || '').slice(0, 60000),
      tags: Array.isArray(meta.tags) ? meta.tags.filter((t) => typeof t === 'string').slice(0, 12) : [],
      image: Array.isArray(meta.image) && meta.image[0] ? String(meta.image[0]) : null,
      nsfw: Array.isArray(meta.tags) && meta.tags.includes('nsfw'),
      parentAuthor: post.parent_author || null,
      parentPermlink: post.parent_permlink || null,
      // Hive timestamps are UTC without a zone suffix.
      created: post.created ? new Date(`${post.created}Z`) : new Date(),
      indexedAt: new Date(),
    };
    await getDb().collection(COLLECTION).updateOne({ _id }, { $set: doc }, { upsert: true });
    res.json({ success: true, snap: { _id, ...doc } });
  } catch (err) {
    console.error('POST /snaps failed:', err);
    res.status(500).json({ success: false, error: 'internal error' });
  }
});

/**
 * GET /snaps/:owner?page=&limit=  — the owner's snaps, newest first, for the tab.
 */
router.get('/snaps/:owner', async (req, res) => {
  try {
    const owner = norm(req.params.owner);
    if (!owner) return res.status(400).json({ success: false, error: 'owner required' });

    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const skip = (page - 1) * limit;

    await ensureIndex();
    const col = getDb().collection(COLLECTION);
    const [snaps, total] = await Promise.all([
      col.find({ owner }).sort({ created: -1 }).skip(skip).limit(limit).toArray(),
      col.countDocuments({ owner }),
    ]);
    res.json({ success: true, snaps, page, limit, total, hasMore: skip + snaps.length < total });
  } catch (err) {
    console.error('GET /snaps/:owner failed:', err);
    res.status(500).json({ success: false, error: 'internal error' });
  }
});

module.exports = router;
