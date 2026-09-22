// GET /playlists-feed — recently-CHANGED public playlists, for interleaving into
// the home feed next to the community snaps (see routes/snaps.js /snaps-feed).
//
// Source of truth is the on-chain playlist index maintained by the Go
// 3speak-playlists service, which writes the SAME Mongo `playlists` collection
// we read here. Every add / remove / reorder bumps `updated_at` +
// `last_modified_block`, so "a playlist changed recently" = a recent updated_at.
//
// Thumbnails are only returned when the playlist stored one; the frontend
// resolves the rest from the first item (Hive get_content) + avatar.
//
// ⚠️ This used to be described as "a pure Mongo read, so it stays cheap". It was
// cheap in query terms and never in wall-clock terms: Mongo is not in this
// datacentre, so the single round trip WAS the entire response time. Measured, the
// plan executes in 2ms and returns 1 document out of 59 public playlists, while the
// endpoint answered in 0.115s at a 110ms ping and 0.39s at a 389ms ping. It tracked
// the ping, not the data.
//
// So the whole (tiny) candidate set is now cached in process and every per-viewer
// decision -- the age window, excluding your own playlists, the `following` scope,
// pagination -- happens in memory. See utils/feedCache.js.

const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');
const { getFollowingList } = require('../utils/hive');
const { getCached } = require('../utils/feedCache');
const { PLAYLIST_FEED_CACHE_MS } = require('../utils/config');

// "Recently changed" window. Matches the snaps feed's 7-day freshness. Env-tunable.
const MAX_AGE_MS = (parseInt(process.env.PLAYLIST_FEED_MAX_AGE_DAYS, 10) || 7) * 24 * 60 * 60 * 1000;

// Callers may ask for a TIGHTER window than the default (Discover only wants
// playlists changed in the last day). Clamped: narrow, never widen.
function maxAgeMsFrom(req, defaultMs) {
  const h = parseFloat(req.query.maxAgeHours);
  if (!Number.isFinite(h) || h <= 0) return defaultMs;
  return Math.min(h * 60 * 60 * 1000, defaultMs);
}

// Playlist `metadata` is stored as JSON (json.RawMessage) — via the Node driver
// it can arrive as an object, a BSON Binary, or a base64 string. (Mirrors the
// helper in routes/audio.js.)
function decodePlaylistMeta(m) {
  try {
    if (!m) return null;
    if (typeof m === 'object' && m._bsontype === 'Binary') return JSON.parse(m.buffer.toString('utf8'));
    if (Buffer.isBuffer(m)) return JSON.parse(m.toString('utf8'));
    if (typeof m === 'string') {
      try { return JSON.parse(m); } catch { return JSON.parse(Buffer.from(m, 'base64').toString('utf8')); }
    }
    if (typeof m === 'object') return m;
  } catch { /* ignore */ }
  return null;
}

/**
 * Every candidate playlist, newest-changed first, cached as ONE set.
 *
 * Widened by the cache TTL so that a set built a minute ago still contains
 * everything a request made now could ask for; the exact cutoff is then applied
 * per request in memory. Response cards are precomputed here so the hot path does
 * no per-row work at all.
 *
 * Non-string and empty owners are dropped at build time (the query used to do this
 * with `$type: 'string'` and a `$nin` on '').
 */
async function loadRecentPlaylists(db) {
  return getCached('playlists-feed', PLAYLIST_FEED_CACHE_MS, async () => {
    const rows = await db.collection('playlists')
      .find({
        access: 'public',
        type: { $ne: 'audio' },            // audio albums have their own surface (/audio)
        'items.1': { $exists: true },      // >= 2 items so the card isn't thin/empty
        updated_at: { $gt: new Date(Date.now() - MAX_AGE_MS - PLAYLIST_FEED_CACHE_MS) },
      })
      .sort({ updated_at: -1, last_modified_block: -1, _id: -1 })
      .toArray();

    const out = [];
    for (const p of rows) {
      const owner = typeof p.owner === 'string' ? p.owner.trim().toLowerCase() : '';
      if (!owner) continue;
      const items = Array.isArray(p.items) ? p.items : [];
      const meta = decodePlaylistMeta(p.metadata);
      const first = items.slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0] || null;
      const updated = p.updated_at || p.created_at || null;
      out.push({
        owner,
        updatedMs: new Date(p.updated_at || 0).getTime() || 0,
        // Frozen: one object is handed to every caller, so nothing may mutate it.
        card: Object.freeze({
          id: String(p._id),
          name: p.name || 'Untitled playlist',
          owner: p.owner,
          itemCount: items.length,
          // May be null — the frontend then resolves from firstItem / avatar.
          thumbnail: p.thumbnail || meta?.album?.thumbnail || null,
          firstItem: first ? Object.freeze({ author: first.author, permlink: first.permlink }) : null,
          updated_at: updated,
        }),
      });
    }
    return out;
  }, []);
}

/**
 * GET /playlists-feed?scope=all|following&currentuser=&page=&limit=
 * Recently-changed (<7d) public playlists with >= 2 items, for interleaving into
 * the community-snaps home-feed stream. Same scope model as /snaps-feed:
 *   scope=following → only playlists owned by people `currentuser` follows
 *                     (Interests + Follow sections)
 *   scope=all       → anyone (Discover + New sections)
 * Excludes the viewer's own playlists either way (same as own snaps).
 */
router.get('/playlists-feed', async (req, res) => {
  try {
    const db = getDb();
    const currentuser = String(req.query.currentuser || '').trim().toLowerCase();
    const scope = req.query.scope === 'following' ? 'following' : 'all';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 30);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    let following = null;
    if (scope === 'following') {
      // Mirrors /snaps-feed: no viewer or no follows → empty feed.
      if (!currentuser) return res.json({ success: true, playlists: [], page, limit, hasMore: false });
      const list = await getFollowingList(currentuser);
      if (!list || !list.length) return res.json({ success: true, playlists: [], page, limit, hasMore: false });
      following = new Set(list.map((u) => String(u).toLowerCase()));
    }

    const all = await loadRecentPlaylists(db);

    // The cutoff is applied HERE, not in the query, so a cached set still honours an
    // exact per-request window (and `maxAgeHours`, which only ever narrows it).
    const cutoff = Date.now() - maxAgeMsFrom(req, MAX_AGE_MS);
    const matching = all.filter((p) => (
      p.updatedMs > cutoff
      && p.owner !== currentuser              // your own playlists, same as own snaps
      && (!following || following.has(p.owner))
    ));

    const playlists = matching.slice(skip, skip + limit).map((p) => p.card);
    res.json({ success: true, playlists, page, limit, hasMore: matching.length > skip + limit });
  } catch (err) {
    console.error('GET /playlists-feed failed:', err);
    res.status(500).json({ success: false, error: 'internal error' });
  }
});

module.exports = router;
