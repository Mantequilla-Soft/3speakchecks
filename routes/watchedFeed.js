const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');
const { ObjectId } = require('mongodb');
const { ENABLE_MONGO_WRITES } = require('../utils/config');
const { artToken } = require('../utils/podcastArt');

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
 * `type`: shorts = `short: true`; audio = `audio: true` (3Speak audio the player
 * recorded once it was really listened to); videos = everything else, because
 * older rows never had the short flag set (same rule as the playlists service).
 * Audio entries come back as `embed-audio` docs flagged `_audio`.
 * Outside podcast episodes (no Hive post) are recorded by the global player as
 * author `_podcast` + the episode id (PODCAST_AUTHOR): always audio, they come
 * back as episode cards flagged `_audio` + `_podcast` (no audio URL: the card
 * opens the episode in the podcast player). Audio cards carry the listener's
 * `progress` ({ pos, dur, done }, podcast_progress) when there is one.
 * `since`: entries whose LAST watch is at or after it.
 * ──────────────────────────────────────────────────────────────────── */

const MAX_LIMIT = 50;
// The author of an outside podcast episode's history row; its permlink is the
// episode id (`<feed id>:<16 chars>`). Never a Hive name (no `_` there) nor a
// warm-up handle. Must match PODCAST_HISTORY_AUTHOR in the frontend's
// src/lib/listenHistory.js.
const PODCAST_AUTHOR = '_podcast';
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

/**
 * Settle `audio` on this user's history rows that never got it. The playlists
 * service stores only `short`, so an audio listen is recognised here, once per
 * row, by matching our own `embed-audio` (asset permlink or Hive post permlink).
 */
async function classifyAudio(db, username) {
  if (!ENABLE_MONGO_WRITES) return;
  const history = db.collection('watch_history');
  // An outside episode is audio by its author alone, and one an older checker
  // already settled as `audio: false` is put right.
  const rows = await history.find(
    { username, $or: [{ audio: { $exists: false } }, { author: PODCAST_AUTHOR, audio: { $ne: true } }] },
    { projection: { author: 1, permlink: 1 } },
  ).limit(CLASSIFY_BATCH).toArray();
  if (!rows.length) return;

  const pods = rows.filter((r) => r.author === PODCAST_AUTHOR);
  const rest = rows.filter((r) => r.author !== PODCAST_AUTHOR);
  const ops = pods.map((r) => ({
    updateOne: { filter: { _id: r._id, audio: { $ne: true } }, update: { $set: { audio: true } } },
  }));
  if (!rest.length) {
    await history.bulkWrite(ops, { ordered: false });
    return;
  }

  const permlinks = [...new Set(rest.map((r) => r.permlink))];
  const projection = { owner: 1, permlink: 1, post_permlink: 1 };
  const [byAsset, byPost] = await Promise.all([
    db.collection('embed-audio').find({ permlink: { $in: permlinks } }, { projection }).toArray(),
    db.collection('embed-audio').find({ post_permlink: { $in: permlinks } }, { projection }).toArray(),
  ]);
  const isAudio = new Set([
    ...byAsset.map((a) => `${a.owner}/${a.permlink}`),
    ...byPost.map((a) => `${a.owner}/${a.post_permlink}`),
  ]);

  await history.bulkWrite([...ops, ...rest.map((r) => ({
    updateOne: {
      filter: { _id: r._id, audio: { $exists: false } },
      update: { $set: { audio: isAudio.has(`${r.author}/${r.permlink}`) } },
    },
  }))], { ordered: false });
}

function historyFilter(username, type, since) {
  const filter = { username };
  if (type === 'shorts') filter.short = true;
  // An outside episode counts as audio even before its row is settled.
  else if (type === 'audio') filter.$or = [{ audio: true }, { author: PODCAST_AUTHOR }];
  else if (type === 'videos') {
    filter.short = { $ne: true };
    filter.audio = { $ne: true };
    filter.author = { $ne: PODCAST_AUTHOR };
  }
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

const oid = (id) => {
  try { return /^[0-9a-f]{24}$/.test(String(id)) ? new ObjectId(String(id)) : null; } catch { return null; }
};

/**
 * The outside episodes behind `rows` (author PODCAST_AUTHOR), as cards keyed by
 * episode id. Leaves out an episode the feed no longer lists (we keep the newest
 * 50 per show) and anything from a private feed: this history is public, and a
 * private feed's episodes are only ever shown to its vouched follower.
 */
async function episodeCards(db, rows) {
  const ids = [...new Set(rows.map((r) => String(r.permlink)))];
  if (!ids.length) return new Map();
  const episodes = await db.collection('podcast_episodes').find({ _id: { $in: ids } }).toArray();
  const feedIds = [...new Set(episodes.map((e) => String(e.feed_id)))].map(oid).filter(Boolean);
  const feeds = feedIds.length
    ? await db.collection('podcast_feeds').find(
      { _id: { $in: feedIds } },
      { projection: { title: 1, image: 1, link: 1, private: 1 } },
    ).toArray()
    : [];
  const feedById = new Map(feeds.map((f) => [String(f._id), f]));
  const cards = new Map();
  for (const ep of episodes) {
    const feed = feedById.get(String(ep.feed_id));
    if (!feed || feed.private || ep.private) continue;
    const image = ep.image || feed.image || '';
    cards.set(String(ep._id), {
      _id: String(ep._id),
      external: true,
      owner: '',
      title: ep.title || '',
      show: feed.title || '',
      show_id: String(ep.feed_id),
      thumbnail_url: image,
      art: artToken(image),
      duration: ep.duration || 0,
      published_at: ep.published_at || null,
    });
  }
  return cards;
}

/** `user`'s listening progress for track / episode ids, as id -> { pos, dur, done }. */
async function progressFor(db, user, ids) {
  if (!ids.length) return new Map();
  const rows = await db.collection('podcast_progress').find(
    { _id: { $in: ids.map((id) => `${user}|${id}`) } },
  ).toArray();
  return new Map(rows.map((p) => [String(p._id).slice(user.length + 1), { pos: p.pos || 0, dur: p.dur || 0, done: p.done === true }]));
}

router.get('/watched/:username', async (req, res) => {
  try {
    const username = String(req.params.username || '').trim();
    if (!username || username.length > 64) {
      return res.status(400).json({ success: false, error: 'Invalid username' });
    }
    const type = ['videos', 'shorts', 'audio'].includes(req.query.type) ? req.query.type : '';
    const since = Math.max(0, parseInt(req.query.since, 10) || 0);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), MAX_LIMIT);

    const db = getDb();
    const history = db.collection('watch_history');
    // Before counting, so the tabs split on the real answer. Never fatal: an
    // unclassified row only lands in the wrong tab.
    await Promise.all([classifyUnflagged(db, username), classifyAudio(db, username)]).catch((err) => {
      console.error('[watched-feed] classify failed:', err && err.message);
    });

    // Both tab counts on every call: the tabs label themselves with them, and
    // they follow the date filter, so they cannot be fetched once and reused.
    const [rows, videosCount, shortsCount, audioCount] = await Promise.all([
      history.find(historyFilter(username, type, since))
        .sort({ last_watched_at: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray(),
      history.countDocuments(historyFilter(username, 'videos', since)),
      history.countDocuments(historyFilter(username, 'shorts', since)),
      history.countDocuments(historyFilter(username, 'audio', since)),
    ]);

    // Audio entries: the track's own embed-audio doc, the shape every audio tile
    // renders. Matched by asset permlink or Hive post permlink, like videos.
    const isPodcast = (r) => r.author === PODCAST_AUTHOR;
    const audioRows = rows.filter((r) => r.audio === true && !isPodcast(r));
    const episodeByKey = await episodeCards(db, rows.filter(isPodcast));
    const audioDocs = audioRows.length
      ? await db.collection('embed-audio').find({
        status: 'published',
        $or: audioRows.flatMap((r) => [
          { owner: r.author, permlink: r.permlink },
          { owner: r.author, post_permlink: r.permlink },
        ]),
      }).toArray()
      : [];
    const audioByKey = new Map();
    for (const a of audioDocs) {
      audioByKey.set(`${a.owner}/${a.permlink}`, a);
      if (a.post_permlink && !audioByKey.has(`${a.owner}/${a.post_permlink}`)) audioByKey.set(`${a.owner}/${a.post_permlink}`, a);
    }

    // History rows carry whichever permlink the player had: the asset id for
    // newer uploads, the Hive permlink for others. Match either, in one query.
    // The listener's own spot in each audio card's track, one query for the page.
    const progress = await progressFor(db, username.toLowerCase(), [
      ...[...episodeByKey.keys()],
      ...audioRows.map((r) => audioByKey.get(`${r.author}/${r.permlink}`)).filter(Boolean).map((a) => String(a._id)),
    ]);
    const withProgress = (id) => (progress.has(id) ? { progress: progress.get(id) } : {});

    const videoRows = rows.filter((r) => !isPodcast(r));
    const embedDocs = videoRows.length
      ? await db.collection('embed-video').find({
        $or: videoRows.flatMap((r) => [
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
    const missing = videoRows.filter((r) => !byKey.has(`${r.author}/${r.permlink}`));
    const legacyDocs = missing.length
      ? await db.collection('videos').find({
        $or: missing.map((r) => ({ owner: r.author, permlink: r.permlink })),
      }).toArray()
      : [];
    const legacyByKey = new Map(legacyDocs.map((v) => [`${v.owner}/${v.permlink}`, v]));

    const videos = [];
    for (const r of rows) {
      const key = `${r.author}/${r.permlink}`;
      const watchedAt = Math.floor(new Date(r.last_watched_at || r.watched_at).getTime() / 1000);
      if (isPodcast(r)) {
        const ep = episodeByKey.get(String(r.permlink));
        if (ep) {
          videos.push({
            ...ep,
            ...withProgress(ep._id),
            _audio: true,
            _podcast: true,
            _historyKey: key,
            watched_at: watchedAt,
            watch_count: r.watch_count || 1,
          });
        }
        continue;
      }
      if (r.audio === true) {
        const a = audioByKey.get(key);
        if (a) {
          videos.push({
            ...a,
            _id: String(a._id),
            ...withProgress(String(a._id)),
            _audio: true,
            _historyKey: key,
            watched_at: watchedAt,
            watch_count: r.watch_count || 1,
          });
        }
        continue;
      }
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
        watched_at: watchedAt,
        watch_count: r.watch_count || 1,
      });
    }

    const total = type === 'shorts' ? shortsCount
      : type === 'audio' ? audioCount
        : type === 'videos' ? videosCount : videosCount + shortsCount + audioCount;
    res.json({
      success: true,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      counts: { videos: videosCount, shorts: shortsCount, audio: audioCount },
      videos,
    });
  } catch (error) {
    console.error('Error fetching watched feed:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
// The feed-card shape for one embed-video, shared with routes/continueWatching.js.
module.exports.embedCard = embedCard;
