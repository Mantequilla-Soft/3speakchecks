// GET /playlists-feed — recently-CHANGED public playlists, for interleaving into
// the home feed next to the community snaps (see routes/snaps.js /snaps-feed).
//
// Source of truth is the on-chain playlist index maintained by the Go
// 3speak-playlists service, which writes the SAME Mongo `playlists` collection
// we read here. Every add / remove / reorder bumps `updated_at` +
// `last_modified_block`, so "a playlist changed recently" = a recent updated_at.
//
// This is a pure Mongo read (no external calls) so it stays cheap like the
// snaps feed. Thumbnails are only returned when the playlist stored one; the
// frontend resolves the rest from the first item (Hive get_content) + avatar.

const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');
const { getFollowingList } = require('../utils/hive');

// "Recently changed" window. Matches the snaps feed's 7-day freshness. Env-tunable.
const MAX_AGE_MS = (parseInt(process.env.PLAYLIST_FEED_MAX_AGE_DAYS, 10) || 7) * 24 * 60 * 60 * 1000;

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

    const ownerClause = { $type: 'string', $nin: currentuser ? ['', currentuser] : [''] };
    if (scope === 'following') {
      // Mirrors /snaps-feed: no viewer or no follows → empty feed.
      if (!currentuser) return res.json({ success: true, playlists: [], page, limit, hasMore: false });
      const following = await getFollowingList(currentuser);
      if (!following || !following.length) return res.json({ success: true, playlists: [], page, limit, hasMore: false });
      ownerClause.$in = following;
    }

    const query = {
      access: 'public',
      type: { $ne: 'audio' },              // audio albums have their own surface (/audio)
      owner: ownerClause,
      'items.1': { $exists: true },        // >= 2 items so the card isn't thin/empty
      updated_at: { $gt: new Date(Date.now() - MAX_AGE_MS) },
    };

    // Only 50-ish public playlists exist and the whole set is tiny, so an
    // unindexed sort is negligible; we don't add an index to another service's
    // collection. Fetch limit+1 to compute hasMore.
    const rows = await db.collection('playlists')
      .find(query)
      .sort({ updated_at: -1, last_modified_block: -1, _id: -1 })
      .skip(skip)
      .limit(limit + 1)
      .toArray();

    const hasMore = rows.length > limit;
    const playlists = rows.slice(0, limit).map((p) => {
      const items = Array.isArray(p.items) ? p.items : [];
      const meta = decodePlaylistMeta(p.metadata);
      const first = items.slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0] || null;
      return {
        id: String(p._id),
        name: p.name || 'Untitled playlist',
        owner: p.owner,
        itemCount: items.length,
        // May be null — the frontend then resolves from firstItem / avatar.
        thumbnail: p.thumbnail || meta?.album?.thumbnail || null,
        firstItem: first ? { author: first.author, permlink: first.permlink } : null,
        updated_at: p.updated_at || p.created_at || null,
      };
    });

    res.json({ success: true, playlists, page, limit, hasMore });
  } catch (err) {
    console.error('GET /playlists-feed failed:', err);
    res.status(500).json({ success: false, error: 'internal error' });
  }
});

module.exports = router;
