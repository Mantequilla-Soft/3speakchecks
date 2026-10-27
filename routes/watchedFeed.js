const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');
const { ENABLE_MONGO_WRITES } = require('../utils/config');

/* ────────────────────────────────────────────────────────────────────
 * GET /feeds/watched/:username?type=videos|shorts&since=<unix s>&page=&limit=
 *
 * A viewer's watch history as feed cards, newest watch first, in ONE request.
 *
 * The /watched page used to take the history from the playlists API and then
 * resolve every entry against Hive with its own get_content call (plus a shorts
 * lookup per short): 20+ round trips per page, which is why it crawled. The
 * deployed playlists build also ignores `type` and `since`, so the date filter
 * and the Videos/Shorts tabs did nothing. This reads the same `watch_history`
 * collection the playlists service writes (same database) and resolves the
 * page against our own video collections, in the shape every other feed card
 * already renders.
 *
 * Read only. Recording and deleting history stay with the playlists service.
 * Public like the playlists endpoint it replaces for reading: history is not
 * gated there either.
 *
 * `type`: shorts = `short: true`; videos = everything else, because older rows
 * never had the flag set (same rule as the playlists service).
 * `since`: entries whose LAST watch is at or after it.
 * ──────────────────────────────────────────────────────────────────── */

const MAX_LIMIT = 50;
// Unflagged rows classified per request. The worst user has ~650, so one call
// settles them; the cap only bounds a pathological history.
const CLASSIFY_BATCH = 1000;

/**
 * Settle `short` on this user's history rows that never got it.
 *
 * Only the shorts player sends the flag. The watch page records before it knows
 * what it is playing, so a short opened there was stored unflagged and landed in
 * the Videos tab (where a portrait card switches the grid to its mixed layout).
 * Our own `embed-video.short` is the truth, so classify from it here: rows we can
 * match get true/false, rows we cannot (legacy uploads, which predate shorts, or
 * videos gone for good) get false. Each row is settled once; the playlists
 * service only writes `short` when a caller sends it, so a later rewatch from the
 * watch page leaves the answer alone.
 */
async function classifyUnflagged(db, username) {
  if (!ENABLE_MONGO_WRITES) return;
  const history = db.collection('watch_history');
  const rows = await history.find(
    { username, short: { $exists: false } },
    { projection: { author: 1, permlink: 1 } },
  ).limit(CLASSIFY_BATCH).toArray();
  if (!rows.length) return;

  const permlinks = [...new Set(rows.map((r) => r.permlink))];
  const projection = { owner: 1, permlink: 1, hive_permlink: 1, short: 1 };
  const [byAsset, byHive] = await Promise.all([
    db.collection('embed-video').find({ permlink: { $in: permlinks } }, { projection }).toArray(),
    db.collection('embed-video').find({ hive_permlink: { $in: permlinks } }, { projection }).toArray(),
  ]);
  const isShort = new Map();
  for (const ev of byAsset) isShort.set(`${ev.owner}/${ev.permlink}`, ev.short === true);
  for (const ev of byHive) {
    const k = `${ev.owner}/${ev.hive_permlink}`;
    if (!isShort.has(k)) isShort.set(k, ev.short === true);
  }

  await history.bulkWrite(rows.map((r) => ({
    updateOne: {
      // Guarded on the field still being absent, so a flag the player sent in
      // the meantime is never overwritten.
      filter: { _id: r._id, short: { $exists: false } },
      update: { $set: { short: isShort.get(`${r.author}/${r.permlink}`) === true } },
    },
  })), { ordered: false });
}

function historyFilter(username, type, since) {
  const filter = { username };
  if (type === 'shorts') filter.short = true;
  else if (type === 'videos') filter.short = { $ne: true };
  if (since > 0) filter.last_watched_at = { $gte: new Date(since * 1000) };
  return filter;
}

// Same shape /feeds/new and transformEmbedVideoToLegacy in feeds.js return, so
// the frontend renders it with the main feed's card. A short keeps its asset id
// as the permlink: that is what /shorts links by, and most shorts have no Hive post.
function embedCard(ev) {
  const short = ev.short === true;
  return {
    owner: ev.owner,
    author: short ? ev.owner : (ev.hive_author || ev.owner),
    permlink: short ? ev.permlink : (ev.hive_permlink || ev.permlink),
    // Never the upload's filename: a regular video with no Hive post is flagged
    // `_unlinked` instead, and the page looks its title up as an off-chain
    // (warm-up) post, dropping it if there is none.
    title: ev.hive_title || ev.embed_title || (short ? (ev.originalFilename || '') : ''),
    status: ev.status || 'published',
    created: ev.createdAt,
    created_at: ev.createdAt,
    views: ev.views || 0,
    duration: ev.duration || 0,
    tags: ev.hive_tags || [],
    tags_v2: (ev.hive_tags || []).map((t) => String(t).toLowerCase()),
    images: {
      thumbnail: ev.thumbnail_url || `https://img.3speak.tv/${ev.permlink}/thumbnail.png`,
      poster: ev.thumbnail_url || `https://img.3speak.tv/${ev.permlink}/poster.jpg`,
    },
    spkvideo: {
      duration: ev.duration || 0,
      video_v2: ev.permlink,
      play_url: ev.manifest_cid ? `https://ipfs.3speak.tv/ipfs/${ev.manifest_cid}` : null,
    },
    gated: ev.gated === true,
    ...(short ? { _short: true } : {}),
    ...(!short && !ev.hive_permlink ? { _unlinked: true } : {}),
  };
}

router.get('/watched/:username', async (req, res) => {
  try {
    const username = String(req.params.username || '').trim();
    if (!username || username.length > 64) {
      return res.status(400).json({ success: false, error: 'Invalid username' });
    }
    const type = ['videos', 'shorts'].includes(req.query.type) ? req.query.type : '';
    const since = Math.max(0, parseInt(req.query.since, 10) || 0);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), MAX_LIMIT);

    const db = getDb();
    const history = db.collection('watch_history');
    // Before counting, so the tabs split on the real answer. Never fatal: an
    // unclassified row only lands in the wrong tab.
    await classifyUnflagged(db, username).catch((err) => {
      console.error('[watched-feed] classify failed:', err && err.message);
    });

    // Both tab counts on every call: the tabs label themselves with them, and
    // they follow the date filter, so they cannot be fetched once and reused.
    const [rows, videosCount, shortsCount] = await Promise.all([
      history.find(historyFilter(username, type, since))
        .sort({ last_watched_at: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray(),
      history.countDocuments(historyFilter(username, 'videos', since)),
      history.countDocuments(historyFilter(username, 'shorts', since)),
    ]);

    // History rows carry whichever permlink the player had: the asset id for
    // newer uploads, the Hive permlink for others. Match either, in one query.
    const embedDocs = rows.length
      ? await db.collection('embed-video').find({
        $or: rows.flatMap((r) => [
          { owner: r.author, permlink: r.permlink },
          { owner: r.author, hive_permlink: r.permlink },
        ]),
      }).toArray()
      : [];
    const byKey = new Map();
    for (const ev of embedDocs) {
      byKey.set(`${ev.owner}/${ev.permlink}`, ev);
      if (ev.hive_permlink && !byKey.has(`${ev.owner}/${ev.hive_permlink}`)) {
        byKey.set(`${ev.owner}/${ev.hive_permlink}`, ev);
      }
    }

    // Legacy uploads (old uploader) live only in `videos`.
    const missing = rows.filter((r) => !byKey.has(`${r.author}/${r.permlink}`));
    const legacyDocs = missing.length
      ? await db.collection('videos').find({
        $or: missing.map((r) => ({ owner: r.author, permlink: r.permlink })),
      }).toArray()
      : [];
    const legacyByKey = new Map(legacyDocs.map((v) => [`${v.owner}/${v.permlink}`, v]));

    const videos = [];
    for (const r of rows) {
      const key = `${r.author}/${r.permlink}`;
      const ev = byKey.get(key);
      const legacy = ev ? null : legacyByKey.get(key);
      // A video we no longer hold anywhere is left out, as the page always did.
      if (!ev && !legacy) continue;
      // A 24h story is gone from 3Speak once it expires (routes/stories.js), so it
      // leaves the history too. The tab counts still include it: they are plain
      // history counts, and a page just comes back one card short.
      if (ev && ev.story === true && ev.story_expires_at && new Date(ev.story_expires_at) <= new Date()) continue;
      const card = ev ? embedCard(ev) : { ...legacy, author: legacy.author || legacy.owner };
      videos.push({
        ...card,
        // The history entry's own key, which is what deleting it needs; the card's
        // author/permlink can differ (Hive permlink vs asset id).
        _historyKey: key,
        watched_at: Math.floor(new Date(r.last_watched_at || r.watched_at).getTime() / 1000),
        watch_count: r.watch_count || 1,
      });
    }

    const total = type === 'shorts' ? shortsCount : (type === 'videos' ? videosCount : videosCount + shortsCount);
    res.json({
      success: true,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      counts: { videos: videosCount, shorts: shortsCount },
      videos,
    });
  } catch (error) {
    console.error('Error fetching watched feed:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
