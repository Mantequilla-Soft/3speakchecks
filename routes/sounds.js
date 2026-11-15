/**
 * Sound pages on 3speak.tv (/sound/:id): a sound, and the Shorts that use it.
 * Read-only views of the index services/soundIndex.js builds.
 *
 *   GET /sounds/trending?limit=      the sounds most used by Shorts of the last
 *                                    SOUND_TRENDING_DAYS days (remixes count too)
 *   GET /sounds/:id?sort=new|top&page=&limit=
 *       { sound, original, uses, shorts, page, totalPages }. `original` is the
 *       Short the sound comes from (a `short_` sound), `uses` how many other
 *       Shorts use it, `shorts` those Shorts (newest, or by Hive payout for "top").
 *
 * Only what the Shorts feed shows is listed: published, listed, not hidden from
 * feeds, media not gone, creator not hidden. A sound whose original is not
 * shown answers 404, so a hidden creator is never named here.
 */
const express = require('express');
// Through the module, so a test can stand in for the database.
const dbModule = require('../utils/db');
const { HIDDEN_AUTHORS, SOUND_TRENDING_DAYS } = require('../utils/config');
const { hiddenListSync } = require('../utils/hiddenCreators');
const { unavailableMatch } = require('../utils/unavailable');
const { hiddenFromFeedMatch } = require('../utils/hiddenFromFeed');
const { isSoundId, parseSoundId } = require('../utils/soundIds');
const { USES, SOUNDS, loadLibrary, libraryFileUrl } = require('../services/soundIndex');

const router = express.Router();

const CACHE_MS = 60 * 1000;
const cache = new Map();
function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = fn().catch((err) => { cache.delete(key); throw err; });
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  return value;
}
function _clearCacheForTests() { cache.clear(); }

const int = (v, def, min, max) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

const hiddenSet = () => new Set([...HIDDEN_AUTHORS, ...hiddenListSync()].map((a) => String(a).toLowerCase()));

/** The uses whose upload is still shown in the Shorts feed, in the same order. */
async function visibleUses(db, rows) {
  if (!rows.length) return [];
  const hidden = hiddenSet();
  const candidates = rows.filter((r) => !hidden.has(String(r.author).toLowerCase()) && !hidden.has(String(r.embed_owner).toLowerCase()));
  if (!candidates.length) return [];
  const docs = await db.collection('embed-video').find({
    $or: candidates.map((r) => ({ owner: r.embed_owner, permlink: r.embed_permlink })),
    status: 'published',
    listed_on_3speak: { $ne: false },
    ...unavailableMatch(),
    ...hiddenFromFeedMatch(),
  }, { projection: { owner: 1, permlink: 1, thumbnail_url: 1, duration: 1 } }).toArray();
  const live = new Map(docs.map((d) => [`${d.owner}/${d.permlink}`, d]));
  return candidates
    .filter((r) => live.has(`${r.embed_owner}/${r.embed_permlink}`))
    .map((r) => {
      const d = live.get(`${r.embed_owner}/${r.embed_permlink}`);
      return {
        author: r.author,
        permlink: r.permlink,
        owner: r.embed_owner,
        embed_permlink: r.embed_permlink,
        title: r.title || '',
        thumbnail_url: d.thumbnail_url || r.thumbnail_url || null,
        duration: Number(d.duration || r.duration) || null,
        createdAt: r.createdAt,
        via: r.via,
      };
    });
}

/** The public face of a `sounds` row (+ what the page needs to play it). */
function soundView(id, row, library) {
  const parsed = parseSoundId(id);
  const out = {
    id,
    kind: parsed ? parsed.kind : 'external',
    title: (row && row.title) || '',
    artist: (row && row.artist) || '',
    account: (row && row.account) || null,
    source: (row && row.source) || null,
    url: (row && row.url) || null,
    license: (row && row.license) || null,
  };
  if (parsed && parsed.kind === 'library') {
    const t = library.byId.get(parsed.slug);
    out.audio_url = libraryFileUrl(library, parsed.slug);
    if (t) {
      out.title = out.title || t.title;
      out.artist = out.artist || t.artist;
      out.duration = t.duration;
    }
  }
  return out;
}

async function loadSound(db, id, { sort, page, limit }) {
  const parsed = parseSoundId(id);
  const [row, library] = await Promise.all([
    db.collection(SOUNDS).findOne({ _id: id }),
    loadLibrary(),
  ]);
  // The post the sound comes from, when it is a Short's own audio.
  let original = null;
  if (parsed.kind === 'short') {
    const own = await db.collection(USES).findOne({ _id: `${parsed.author}/${parsed.permlink}` });
    const shown = own ? await visibleUses(db, [own]) : [];
    if (!shown.length) return null;
    original = shown[0];
  } else if (!row && !(parsed.kind === 'library' && library.byId.has(parsed.slug))) {
    return null;
  }
  const q = { sound: id, via: { $ne: 'original' } };
  const order = sort === 'top' ? { reward: -1, createdAt: -1 } : { createdAt: -1 };
  // Hidden rows are dropped after the page is read, so read a little more.
  const rows = await db.collection(USES).find(q).sort(order).skip((page - 1) * limit).limit(limit + 12).toArray();
  const total = await db.collection(USES).countDocuments(q);
  const shorts = (await visibleUses(db, rows)).slice(0, limit);
  const sound = soundView(id, row, library);
  if (original && !sound.title) sound.title = original.title;
  if (original && !sound.artist) sound.artist = `@${original.author}`;
  return {
    success: true,
    sound,
    original,
    uses: total,
    shorts,
    page,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

async function loadTrending(db, { limit, days }) {
  const since = new Date(Date.now() - days * 86400000);
  const top = await db.collection(USES).aggregate([
    { $match: { via: { $in: ['sound', 'remix'] }, createdAt: { $gte: since } } },
    { $group: { _id: '$sound', uses: { $sum: 1 }, last: { $max: '$createdAt' } } },
    { $sort: { uses: -1, last: -1 } },
    { $limit: limit * 2 },
  ]).toArray();
  if (!top.length) return { success: true, days, sounds: [] };
  const ids = top.map((t) => t._id);
  const [rows, library, originals] = await Promise.all([
    db.collection(SOUNDS).find({ _id: { $in: ids } }).toArray(),
    loadLibrary(),
    db.collection(USES).find({ sound: { $in: ids }, via: 'original' }).toArray(),
  ]);
  const byId = new Map(rows.map((r) => [r._id, r]));
  const shownOriginals = new Map((await visibleUses(db, originals)).map((u) => [`short_${u.author}_${u.permlink}`, u]));
  const hidden = hiddenSet();
  const sounds = [];
  for (const t of top) {
    const parsed = parseSoundId(t._id);
    if (!parsed) continue;
    const view = soundView(t._id, byId.get(t._id), library);
    if (parsed.kind === 'short') {
      const o = shownOriginals.get(t._id);
      if (!o || hidden.has(parsed.author)) continue;
      view.original = o;
      view.title = view.title || o.title;
      view.artist = view.artist || `@${o.author}`;
    }
    sounds.push({ ...view, uses: t.uses });
    if (sounds.length >= limit) break;
  }
  return { success: true, days, sounds };
}

router.get('/trending', async (req, res) => {
  try {
    const limit = int(req.query.limit, 12, 1, 50);
    const days = SOUND_TRENDING_DAYS;
    const out = await cached(`t:${limit}`, () => loadTrending(dbModule.getDb(), { limit, days }));
    res.set('Cache-Control', 'public, max-age=60');
    res.json(out);
  } catch (err) {
    console.error('[sounds] trending failed:', err && err.message);
    res.status(500).json({ success: false, error: 'failed' });
  }
});

router.get('/:id', async (req, res) => {
  const id = String(req.params.id || '').toLowerCase();
  if (!isSoundId(id)) return res.status(400).json({ success: false, error: 'bad_id' });
  try {
    const sort = req.query.sort === 'top' ? 'top' : 'new';
    const page = int(req.query.page, 1, 1, 200);
    const limit = int(req.query.limit, 24, 1, 60);
    const out = await cached(`s:${id}:${sort}:${page}:${limit}`, () => loadSound(dbModule.getDb(), id, { sort, page, limit }));
    if (!out) return res.status(404).json({ success: false, error: 'not_found' });
    res.set('Cache-Control', 'public, max-age=60');
    res.json(out);
  } catch (err) {
    console.error('[sounds] read failed:', err && err.message);
    res.status(500).json({ success: false, error: 'failed' });
  }
});

module.exports = router;
module.exports._clearCacheForTests = _clearCacheForTests;
