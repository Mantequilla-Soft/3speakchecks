/**
 * Sound pages: which Shorts use which sound.
 *
 * A Short's Hive post records the song it was made with in
 * `json_metadata.video.sound` (the editor's music library, or since 2026-11 the
 * audio of another Short picked with "Use this sound" on 3speak.tv). A Short with
 * no sound uses its own original audio, and a remix (`video.originalAuthor` /
 * `originalPermlink`) uses the audio of the post it remixes. So every Short has
 * exactly one sound (utils/soundIds.js names them).
 *
 *   sound_uses   one row per Short, `_id` = Hive `author/permlink`:
 *                { sound, via: 'original'|'sound'|'remix', author, permlink,
 *                  embed_owner, embed_permlink, title, thumbnail_url, duration,
 *                  createdAt, reward, indexedAt }
 *   sounds       one row per sound: { _id, kind, title, artist, account, source,
 *                  url, license, original: { author, permlink }?, file?, createdAt, updatedAt }
 *   sound_index_state  { _id: 'shorts', cursor } how far the backfill got.
 *
 * The job (BACKGROUND_JOBS, scheduleSoundIndex) walks every published Short in
 * `embed-video` oldest first, SOUND_INDEX_BATCH per run, so the first runs are the
 * backfill and later ones pick up new Shorts. Every run also re-reads the Shorts
 * of the last SOUND_INDEX_RECHECK_H hours: a post is often linked to its upload a
 * while after the upload, and its payout ("Top") still moves in that window.
 *
 * Reads only Hive (get_content) and the music library list; writes only the three
 * collections above.
 */
const { getDb } = require('../utils/db');
const { hiveRpcBatch, pickSound } = require('../utils/hive');
const {
  ENABLE_MONGO_WRITES, SOUND_INDEX_INTERVAL_MIN, SOUND_INDEX_BATCH, SOUND_INDEX_RECHECK_H, SOUND_LIBRARY_URL,
} = require('../utils/config');
const { shortSoundId, soundIdForSound, libraryKey, parseSoundId, ACCOUNT, PERMLINK } = require('../utils/soundIds');

const USES = 'sound_uses';
const SOUNDS = 'sounds';
const STATE = 'sound_index_state';

let indexesEnsured = false;
async function ensureIndexes(db = getDb()) {
  if (indexesEnsured) return;
  indexesEnsured = true;
  try {
    await db.collection(USES).createIndex({ sound: 1, createdAt: -1 });
    await db.collection(USES).createIndex({ sound: 1, reward: -1 });
    await db.collection(USES).createIndex({ via: 1, createdAt: -1 });
    await db.collection(USES).createIndex({ author: 1 });
  } catch (err) {
    indexesEnsured = false;
    console.error('[soundIndex] index setup failed:', err && err.message);
  }
}

// ─── The music library ────────────────────────────────────────────────────────

const EMPTY_LIBRARY = { byId: new Map(), byKey: new Map(), base: '' };
let libraryCache = { at: 0, value: EMPTY_LIBRARY };
const LIBRARY_TTL_MS = 6 * 3600 * 1000;

/** library.json ({ tracks: [{ id, title, artist, file, ... }] }) as lookups. */
function libraryFrom(json, url) {
  const byId = new Map();
  const byKey = new Map();
  const tracks = Array.isArray(json?.tracks) ? json.tracks : Array.isArray(json) ? json : [];
  for (const t of tracks) {
    if (!t || typeof t.id !== 'string' || typeof t.title !== 'string') continue;
    const id = t.id.toLowerCase();
    byId.set(id, {
      id, title: t.title.slice(0, 100), artist: String(t.artist || '').slice(0, 100),
      file: typeof t.file === 'string' ? t.file : null,
      source: typeof t.source === 'string' ? t.source.slice(0, 60) : null,
      url: typeof t.sourceUrl === 'string' ? t.sourceUrl.slice(0, 300) : null,
      license: typeof t.license === 'string' ? t.license.slice(0, 40) : null,
      account: t.source === '3speak' && typeof t.account === 'string' ? t.account.toLowerCase() : null,
      duration: Number(t.duration) || null,
    });
    byKey.set(libraryKey(t.title, t.artist), id);
  }
  const base = url ? url.slice(0, url.lastIndexOf('/') + 1) : '';
  return { byId, byKey, base };
}

/** The library, cached; an unreachable list keeps the last one (or none). */
async function loadLibrary({ fetchImpl = fetch, url = SOUND_LIBRARY_URL, now = Date.now() } = {}) {
  if (!url) return EMPTY_LIBRARY;
  if (now - libraryCache.at < LIBRARY_TTL_MS && libraryCache.value.byId.size) return libraryCache.value;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(10000) });
    if (res.ok) libraryCache = { at: now, value: libraryFrom(await res.json(), url) };
  } catch (err) {
    console.warn('[soundIndex] music library unreachable:', err && err.message);
  }
  return libraryCache.value;
}
function _resetLibraryForTests(value) { libraryCache = { at: value ? Date.now() : 0, value: value || EMPTY_LIBRARY }; }

/** The playable file of a library song, or null. */
function libraryFileUrl(library, slug) {
  const t = library.byId.get(slug);
  return t && t.file && library.base ? `${library.base}${encodeURIComponent(t.file)}` : null;
}

// ─── Reading Hive ─────────────────────────────────────────────────────────────

/** Map `author/permlink` -> the post's fields this index needs, for up to N posts. */
async function fetchPosts(keys, rpc = hiveRpcBatch) {
  const out = new Map();
  for (let i = 0; i < keys.length; i += 20) {
    const slice = keys.slice(i, i + 20);
    const batch = slice.map((k, j) => ({ jsonrpc: '2.0', id: j, method: 'condenser_api.get_content', params: [k.author, k.permlink] }));
    const results = await rpc(batch);
    for (const r of results || []) {
      const p = r && r.result;
      if (!p || !p.author || !p.permlink) continue;
      let meta = {};
      try { meta = JSON.parse(p.json_metadata || '{}') || {}; } catch { meta = {}; }
      const money = (v) => parseFloat(v) || 0;
      out.set(`${p.author}/${p.permlink}`, {
        title: String(p.title || '').slice(0, 200),
        created: p.created ? new Date(`${p.created}Z`) : null,
        reward: Math.round((money(p.pending_payout_value) + money(p.total_payout_value) + money(p.curator_payout_value)) * 1000) / 1000,
        meta,
      });
    }
  }
  return out;
}

// The Hive post an upload went out as.
function postOf(short) {
  if (short.hive_author && short.hive_permlink) return { author: String(short.hive_author).toLowerCase(), permlink: String(short.hive_permlink).toLowerCase() };
  const parts = typeof short.embed_url === 'string' ? short.embed_url.replace(/^@/, '').split('/') : [];
  return parts.length === 2 && parts[0] && parts[1] ? { author: parts[0].toLowerCase(), permlink: parts[1].toLowerCase() } : null;
}

/**
 * Which sound one post uses: { sound, via, meta } where meta is what the post
 * tells about that sound (for the `sounds` row).
 */
function soundOfPost(post, { author, permlink }, library) {
  const video = post && post.meta && typeof post.meta.video === 'object' ? post.meta.video : {};
  const rawSound = video && typeof video.sound === 'object' ? video.sound : null;
  const sound = pickSound(rawSound);
  if (sound) {
    const id = soundIdForSound(sound, library);
    if (id) return { sound: id, via: 'sound', meta: sound };
  }
  const oa = String(video.originalAuthor || '').toLowerCase();
  const op = String(video.originalPermlink || '').toLowerCase();
  if (ACCOUNT.test(oa) && PERMLINK.test(op) && !(oa === author && op === permlink)) {
    return { sound: shortSoundId(oa, op), via: 'remix', meta: null };
  }
  return { sound: shortSoundId(author, permlink), via: 'original', meta: null };
}

// ─── Writing the index ────────────────────────────────────────────────────────

/** The `sounds` row update for one use. */
function soundRowUpdate(id, use, meta, library, now) {
  const parsed = parseSoundId(id);
  const set = { updatedAt: now };
  const onInsert = { createdAt: now, kind: parsed ? parsed.kind : 'external' };
  if (parsed && parsed.kind === 'library') {
    const t = library.byId.get(parsed.slug);
    Object.assign(set, {
      title: (t && t.title) || (meta && meta.title) || parsed.slug,
      artist: (t && t.artist) || (meta && meta.artist) || '',
      source: (t && t.source) || (meta && meta.source) || null,
      url: (t && t.url) || (meta && meta.url) || null,
      license: (t && t.license) || (meta && meta.license) || null,
      account: (t && t.account) || null,
      file: t && t.file ? t.file : null,
    });
  } else if (parsed && parsed.kind === 'short') {
    onInsert.original = { author: parsed.author, permlink: parsed.permlink };
    onInsert.account = parsed.author;
    if (use.via === 'original') {
      // The post itself: its own title names its sound.
      Object.assign(set, { title: use.title || '', artist: `@${parsed.author}` });
    } else {
      // Named by a post that uses it, until the original is indexed.
      onInsert.title = (meta && meta.title) || '';
      onInsert.artist = `@${parsed.author}`;
    }
  } else if (meta) {
    Object.assign(set, {
      title: meta.title, artist: meta.artist || '', source: meta.source || null,
      url: meta.url || null, license: meta.license || null,
    });
  }
  return { updateOne: { filter: { _id: id }, update: { $set: set, $setOnInsert: onInsert }, upsert: true } };
}

/**
 * Index these `embed-video` Shorts. Returns { indexed, missing } (missing: no
 * Hive post yet, tried again in a later run).
 */
async function indexShorts(db, shorts, { rpc = hiveRpcBatch, library = EMPTY_LIBRARY, now = new Date() } = {}) {
  const items = shorts.map((s) => ({ s, post: postOf(s) })).filter((x) => x.post);
  if (!items.length) return { indexed: 0, missing: 0 };
  const posts = await fetchPosts(items.map((x) => x.post), rpc);
  const useOps = [];
  const soundOps = new Map();
  let missing = 0;
  for (const { s, post } of items) {
    const p = posts.get(`${post.author}/${post.permlink}`);
    if (!p) { missing += 1; continue; }
    const { sound, via, meta } = soundOfPost(p, post, library);
    if (!sound) continue;
    const use = {
      sound, via, author: post.author, permlink: post.permlink,
      embed_owner: s.owner, embed_permlink: s.permlink,
      title: p.title || s.hive_title || '',
      thumbnail_url: s.thumbnail_url || null,
      duration: Number(s.duration) || null,
      createdAt: s.createdAt || p.created || now,
      reward: p.reward,
      indexedAt: now,
    };
    useOps.push({ updateOne: { filter: { _id: `${post.author}/${post.permlink}` }, update: { $set: use }, upsert: true } });
    // One row update per sound and run; a post's own row wins over a mention.
    const prev = soundOps.get(sound);
    if (!prev || via === 'original') soundOps.set(sound, soundRowUpdate(sound, use, meta, library, now));
  }
  if (useOps.length) await db.collection(USES).bulkWrite(useOps, { ordered: false });
  if (soundOps.size) await db.collection(SOUNDS).bulkWrite([...soundOps.values()], { ordered: false });
  return { indexed: useOps.length, missing };
}

const SHORTS_QUERY = { short: true, status: 'published', embed_url: { $type: 'string' } };
const PROJECTION = { owner: 1, permlink: 1, hive_author: 1, hive_permlink: 1, embed_url: 1, createdAt: 1, thumbnail_url: 1, duration: 1, hive_title: 1 };

/**
 * One run: the next SOUND_INDEX_BATCH Shorts after the cursor (the backfill, then
 * the new ones), plus the recent ones again.
 */
async function runSoundIndex({ db = getDb(), rpc = hiveRpcBatch, library, now = new Date(), batch = SOUND_INDEX_BATCH, recheckH = SOUND_INDEX_RECHECK_H, writes = ENABLE_MONGO_WRITES } = {}) {
  if (!writes) return { skipped: 'writes off' };
  await ensureIndexes(db);
  const lib = library || await loadLibrary();
  const state = await db.collection(STATE).findOne({ _id: 'shorts' });
  const cursor = state && state.cursor ? new Date(state.cursor) : new Date(0);
  const next = await db.collection('embed-video')
    .find({ ...SHORTS_QUERY, createdAt: { $gt: cursor } }, { projection: PROJECTION })
    .sort({ createdAt: 1 }).limit(Math.max(1, batch)).toArray();
  const a = await indexShorts(db, next, { rpc, library: lib, now });
  if (next.length) {
    await db.collection(STATE).updateOne(
      { _id: 'shorts' },
      { $set: { cursor: next[next.length - 1].createdAt, updatedAt: now } },
      { upsert: true },
    );
  }
  // The recent ones this run did not just read: up to where the cursor is now.
  const upto = next.length ? new Date(next[next.length - 1].createdAt) : cursor;
  const fresh = new Set(next.map((s) => String(s._id)));
  const since = new Date(now.getTime() - recheckH * 3600 * 1000);
  const recent = upto >= since
    ? (await db.collection('embed-video')
      .find({ ...SHORTS_QUERY, createdAt: { $gte: since, $lte: upto } }, { projection: PROJECTION })
      .sort({ createdAt: -1 }).limit(500).toArray()).filter((s) => !fresh.has(String(s._id)))
    : [];
  const b = await indexShorts(db, recent, { rpc, library: lib, now });
  return { backfill: next.length, indexed: a.indexed + b.indexed, missing: a.missing + b.missing, rechecked: recent.length };
}

function scheduleSoundIndex() {
  const intervalMs = Math.max(1, SOUND_INDEX_INTERVAL_MIN) * 60 * 1000;
  let running = false;
  const runOnce = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runSoundIndex();
      if (r.indexed || r.missing) console.log(`[soundIndex] ${JSON.stringify(r)}`);
    } catch (err) {
      console.error('[soundIndex] run failed:', err && err.message);
    } finally {
      running = false;
    }
  };
  setTimeout(runOnce, 90 * 1000);
  setInterval(runOnce, intervalMs);
  console.log(`Sound index scheduled every ${SOUND_INDEX_INTERVAL_MIN} min (first run in 90s)`);
}

module.exports = {
  ensureIndexes, loadLibrary, libraryFrom, libraryFileUrl, fetchPosts, postOf, soundOfPost,
  indexShorts, runSoundIndex, scheduleSoundIndex, _resetLibraryForTests,
  USES, SOUNDS, STATE,
};
