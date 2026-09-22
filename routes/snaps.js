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
const { getFollowingList } = require('../utils/hive');

const router = express.Router();
const client = new dhive.Client(HIVE_RPC_ENDPOINTS);

const COLLECTION = 'community-snaps';
const HIDDEN_COLLECTION = 'snap-hidden';         // per-user hides — SEPARATE from video hides
const INTERACT_COLLECTION = 'snap-interactions';  // snaps a user has voted/commented on
const SNAP_APP = '3speak/snap'; // json_metadata.app our composer stamps on a snap
// Community posts only surface in the home feed while they're fresh.
const SNAP_FEED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const { getCached, invalidate: dropCache } = require('../utils/feedCache');
const { SNAP_FEED_CACHE_MS } = require('../utils/config');

// ── Caches ────────────────────────────────────────────────────────────────────
// Mongo is not in this datacentre and the round trip costs 110-390ms, which was the
// entire cost of this feed: one trip for the snaps, plus a second for a signed-in
// viewer's hides and interactions. Live, those three collections hold 22, 3 and 11
// documents, so all three are cached whole and every per-viewer decision happens in
// memory. Writes below invalidate their own cache, so hiding a snap or interacting
// with one still takes effect on the very NEXT request; the TTL only bounds how
// stale a snap written by another process can be.
const SNAPS_KEY = 'snaps:recent';
const HIDDEN_KEY = 'snaps:hidden';
const INTERACT_KEY = 'snaps:interactions';

// Widened by the TTL so a set built a minute ago still covers a window requested
// now; the exact cutoff is applied per request.
const loadSnaps = (db) => getCached(SNAPS_KEY, SNAP_FEED_CACHE_MS, () => db
  .collection(COLLECTION)
  .find({ created: { $gt: new Date(Date.now() - SNAP_FEED_MAX_AGE_MS - SNAP_FEED_CACHE_MS) } })
  .sort({ created: -1 })
  .toArray(), []);

const loadHidden = (db) => getCached(HIDDEN_KEY, SNAP_FEED_CACHE_MS,
  () => db.collection(HIDDEN_COLLECTION).find({}).toArray(), []);

const loadInteractions = (db) => getCached(INTERACT_KEY, SNAP_FEED_CACHE_MS,
  () => db.collection(INTERACT_COLLECTION).find({}, { projection: { user: 1, key: 1 } }).toArray(), []);

// Callers may ask for a TIGHTER window than the default (Discover only wants the
// last few days, so stale posts don't pad a browse surface). Clamped so a caller
// can narrow but never widen past the default.
function maxAgeMsFrom(req, defaultMs) {
  const h = parseFloat(req.query.maxAgeHours);
  if (!Number.isFinite(h) || h <= 0) return defaultMs;
  return Math.min(h * 60 * 60 * 1000, defaultMs);
}
const norm = (s) => String(s || '').trim().toLowerCase();

let _indexed = false;
async function ensureIndex() {
  if (_indexed) return;
  _indexed = true;
  const db = getDb();
  try { await db.collection(COLLECTION).createIndex({ owner: 1, created: -1 }); } catch (_) { /* best effort */ }
  try { await db.collection(COLLECTION).createIndex({ created: -1 }); } catch (_) { /* feed order */ }
  try { await db.collection(INTERACT_COLLECTION).createIndex({ user: 1 }); } catch (_) { /* per-user lookup */ }
  try { await db.collection(HIDDEN_COLLECTION).createIndex({ user: 1 }); } catch (_) { /* per-user lookup */ }
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
    dropCache(SNAPS_KEY);      // a new snap must appear immediately, not in a minute
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

/**
 * GET /snaps-feed?scope=all|following&currentuser=&page=&limit=&nsfw=
 * Cross-author community-post feed for the home feed. Fresh (<7d) only.
 *   scope=following → only people `currentuser` follows (Interests + Follow sections)
 *   scope=all       → anyone (Discover + New sections)
 * Excludes the viewer's snap-hidden posts/creators and the snaps they've already
 * voted/commented on (see POST /snaps/interaction). These filters are SEPARATE from
 * the video hide lists — a snap-hidden creator's videos are unaffected.
 */
router.get('/snaps-feed', async (req, res) => {
  try {
    const currentuser = norm(req.query.currentuser);
    const scope = req.query.scope === 'following' ? 'following' : 'all';
    const limit = Math.min(30, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const skip = (page - 1) * limit;
    const db = getDb();
    await ensureIndex();

    let following = null;
    if (scope === 'following') {
      if (!currentuser) return res.json({ success: true, snaps: [], page, limit, hasMore: false });
      const list = await getFollowingList(currentuser);
      if (!list || !list.length) return res.json({ success: true, snaps: [], page, limit, hasMore: false });
      following = new Set(list);
    }

    // Per-viewer exclusions: hidden creators/posts + already-engaged snaps + the
    // viewer's OWN snaps (you see those on your profile's Community tab, not in
    // your own home feed).
    let hiddenCreators = null;
    let excludedKeys = null;
    if (currentuser) {
      const [allHides, allInteractions] = await Promise.all([loadHidden(db), loadInteractions(db)]);
      const hides = allHides.filter((h) => h.user === currentuser);
      hiddenCreators = new Set([...hides.filter((h) => h.type === 'creator').map((h) => h.owner), currentuser]);
      excludedKeys = new Set([
        ...hides.filter((h) => h.type === 'post').map((h) => `${h.owner}/${h.permlink}`),
        ...allInteractions.filter((i) => i.user === currentuser).map((i) => i.key),
      ]);
    }

    const cutoff = Date.now() - maxAgeMsFrom(req, SNAP_FEED_MAX_AGE_MS);
    const allowNsfw = req.query.nsfw === 'true';
    const all = await loadSnaps(db);
    const matching = all.filter((sn) => (
      new Date(sn.created).getTime() > cutoff
      && (allowNsfw || sn.nsfw !== true)
      && (!following || following.has(sn.owner))
      && (!hiddenCreators || !hiddenCreators.has(sn.owner))
      && (!excludedKeys || !excludedKeys.has(sn._id))
    ));

    res.json({
      success: true,
      snaps: matching.slice(skip, skip + limit),
      page,
      limit,
      hasMore: matching.length > skip + limit,
    });
  } catch (err) {
    console.error('GET /snaps-feed failed:', err);
    res.status(500).json({ success: false, error: 'internal error' });
  }
});

/**
 * POST /snaps/interaction { user, author, permlink }
 * Record that `user` voted or commented on a snap, so it stops surfacing in their
 * home feed. Idempotent; fire-and-forget from the client.
 */
router.post('/snaps/interaction', async (req, res) => {
  try {
    const user = norm(req.body?.user);
    const owner = norm(req.body?.author || req.body?.owner);
    const permlink = String(req.body?.permlink || '').trim();
    if (!user || !owner || !permlink) {
      return res.status(400).json({ success: false, error: 'user, author and permlink are required' });
    }
    const key = `${owner}/${permlink}`;
    await getDb().collection(INTERACT_COLLECTION).updateOne(
      { _id: `${user}:${key}` },
      { $set: { user, key, at: new Date() } },
      { upsert: true },
    );
    dropCache(INTERACT_KEY);   // the snap must stop surfacing on the NEXT request
    res.json({ success: true });
  } catch (err) {
    console.error('POST /snaps/interaction failed:', err);
    res.status(500).json({ success: false, error: 'internal error' });
  }
});

// ── Per-user snap hides (community posts only; separate from video hides) ──────
async function setHide(res, { user, owner, permlink, type, remove }) {
  if (!user || !owner || (type === 'post' && !permlink)) {
    return res.status(400).json({ success: false, error: 'missing fields' });
  }
  const _id = type === 'post' ? `${user}:post:${owner}/${permlink}` : `${user}:creator:${owner}`;
  const col = getDb().collection(HIDDEN_COLLECTION);
  if (remove) await col.deleteOne({ _id });
  else await col.updateOne({ _id }, { $set: { user, type, owner, permlink: type === 'post' ? permlink : null, at: new Date() } }, { upsert: true });
  dropCache(HIDDEN_KEY);       // hiding must take effect on the NEXT request
  return res.json({ success: true });
}

router.post('/snaps/hide', (req, res) =>
  setHide(res, { user: norm(req.body?.user), owner: norm(req.body?.author || req.body?.owner), permlink: String(req.body?.permlink || '').trim(), type: 'post', remove: false }));
router.delete('/snaps/hide', (req, res) =>
  setHide(res, { user: norm(req.body?.user), owner: norm(req.body?.author || req.body?.owner), permlink: String(req.body?.permlink || '').trim(), type: 'post', remove: true }));
router.post('/snaps/hide-creator', (req, res) =>
  setHide(res, { user: norm(req.body?.user), owner: norm(req.body?.author || req.body?.owner), type: 'creator', remove: false }));
router.delete('/snaps/hide-creator', (req, res) =>
  setHide(res, { user: norm(req.body?.user), owner: norm(req.body?.author || req.body?.owner), type: 'creator', remove: true }));

module.exports = router;
