/**
 * Outside podcast feeds (the Podcasts tab on /audio): the main-thread half.
 *
 * - runs services/podcastFeedsWorker.js, which does every fetch and parse, and
 *   restarts it if it dies;
 * - ticks it every PODCAST_TICK_SEC to poll the feeds that are due (each feed
 *   every PODCAST_POLL_MIN, 30 minutes by default);
 * - optionally (PODCAST_PODPING_ENABLED=true) listens for PODPING on Hive
 *   (custom_json `pp_*` / `podping`): most podcast hosts announce a new episode
 *   there within seconds, so a ping for a feed we follow marks it due right away;
 * - sends a web push for each new episode to the people who follow that show
 *   (push kind `podcasts`); the bell itself needs no rows, see routes/podcasts.js;
 * - drops feeds nobody follows any more, with their episodes, after a grace week.
 *
 * Collections (all small, all ours):
 *   podcast_feeds     one row per show, shared by everyone who added it (a
 *                     private feed: one row per listener, routes/podcasts.js)
 *   podcast_subs      `<user>|<feedId>` → added_at, notify
 *   podcast_episodes  the newest 50 per show, lean (see utils/podcastParse.js)
 *   podcast_progress  `<user>|<episodeId>` → pos, dur, done (TTL 180 days)
 *
 * Switches: PODCAST_FEEDS_ENABLED=false turns all of it off,
 * PODCAST_PODPING_ENABLED=true adds the Hive listener (off by default).
 */
const path = require('path');
const { Worker } = require('worker_threads');
const { ObjectId } = require('mongodb');
const { getDb } = require('../utils/db');
const { hiveRpcCall } = require('../utils/hive');
const { ENABLE_MONGO_WRITES } = require('../utils/config');
const push = require('../utils/webPush');
const { urlKey } = require('../utils/podcastParse');

const WORKER_PATH = path.join(__dirname, 'podcastFeedsWorker.js');
const FEEDS = 'podcast_feeds';
const EPISODES = 'podcast_episodes';
const SUBS = 'podcast_subs';
const PROGRESS = 'podcast_progress';
const STATE = 'podcast-state';

const ENABLED = String(process.env.PODCAST_FEEDS_ENABLED || 'true').toLowerCase() !== 'false';
// Off unless asked for: reading every Hive block for podpings is about 1.4 GB a
// day from the API nodes, and the 30-minute poll is fast enough for podcasts.
const PODPING_ENABLED = String(process.env.PODCAST_PODPING_ENABLED || 'false').toLowerCase() === 'true';
const TICK_SEC = Math.max(20, parseInt(process.env.PODCAST_TICK_SEC, 10) || 60);
const PODPING_EVERY_MS = 9000;
const PODPING_MAX_BLOCKS = 50;
// Further behind than this (a long restart) and we skip ahead: the regular poll
// covers whatever was pinged in the gap.
const PODPING_MAX_LAG = 1200;
const PODPING_MIN_REFETCH_MS = 2 * 60 * 1000;
const ORPHAN_GRACE_MS = 7 * 24 * 3600 * 1000;
const PUSH_MAX_PER_FEED = 2;

let worker = null;
let seq = 0;
const pending = new Map();
let restarts = 0;

function spawn() {
  worker = new Worker(WORKER_PATH);
  worker.on('message', (msg) => {
    const p = pending.get(msg && msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    p.resolve(msg);
  });
  worker.on('error', (err) => console.error('[podcasts] worker error:', err && err.message));
  worker.on('exit', (code) => {
    for (const [id, p] of pending) { clearTimeout(p.timer); p.resolve({ id, ok: false, code: 'worker_exit' }); }
    pending.clear();
    worker = null;
    restarts += 1;
    const wait = Math.min(5 * 60 * 1000, 5000 * 2 ** Math.min(6, restarts));
    console.error(`[podcasts] worker exited (${code}), restarting in ${Math.round(wait / 1000)}s`);
    setTimeout(spawn, wait).unref();
  });
}

/** Ask the worker something; resolves to its reply, or { ok:false, code:'timeout' }. */
function ask(type, payload = {}, timeoutMs = 30000) {
  if (!worker) return Promise.resolve({ ok: false, code: 'unavailable' });
  const id = ++seq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, code: 'timeout' }); }, timeoutMs);
    pending.set(id, { resolve, timer });
    worker.postMessage({ id, type, ...payload });
  });
}

async function ensureIndexes() {
  const db = getDb();
  await Promise.all([
    db.collection(FEEDS).createIndex({ url_key: 1 }, { unique: true }),
    db.collection(FEEDS).createIndex({ alt_keys: 1 }),
    db.collection(FEEDS).createIndex({ podcast_guid: 1 }, { sparse: true }),
    db.collection(FEEDS).createIndex({ next_poll_at: 1 }),
    db.collection(FEEDS).createIndex({ subscribers: -1, last_followed_at: -1 }),
    db.collection(FEEDS).createIndex({ last_followed_at: -1 }),
    db.collection(SUBS).createIndex({ user: 1 }),
    db.collection(SUBS).createIndex({ feed_id: 1 }),
    db.collection(EPISODES).createIndex({ feed_id: 1, published_at: -1 }),
    db.collection(EPISODES).createIndex({ feed_id: 1, first_seen_at: -1 }),
    db.collection(PROGRESS).createIndex({ user: 1, feed_id: 1 }),
    db.collection(PROGRESS).createIndex({ at: 1 }, { expireAfterSeconds: 180 * 24 * 3600 }),
  ]);
}

// ─── New-episode push ─────────────────────────────────────────────────────────

async function announce(list) {
  if (!push.isConfigured() || !list || !list.length) return;
  const db = getDb();
  let sent = 0;
  for (const item of list) {
    const subs = await db.collection(SUBS)
      .find({ feed_id: new ObjectId(item.feed_id), notify: { $ne: false } }, { projection: { user: 1 } }).toArray();
    const episodes = item.episodes.slice(0, PUSH_MAX_PER_FEED);
    for (const { user } of subs) {
      const prefs = await push.getPrefs(user).catch(() => ({}));
      if (prefs.podcasts === false) continue;
      for (const ep of episodes) {
        const r = await push.sendToUser(user, {
          title: `New episode: ${item.title || 'a podcast you follow'}`.slice(0, 120),
          body: String(ep.title || '').slice(0, 200),
          url: `/audio?type=external&episode=${encodeURIComponent(ep.id)}`,
          tag: `podcast:${ep.id}`,
        }).catch(() => ({ sent: 0 }));
        sent += r.sent || 0;
      }
    }
  }
  if (sent) console.log(`[podcasts] ${sent} new-episode push(es) sent`);
}

async function tick() {
  const r = await ask('tick', {}, 10 * 60 * 1000);
  if (!r.ok) {
    if (r.code !== 'unavailable') console.warn('[podcasts] tick failed:', r.code, r.error || '');
    return;
  }
  if (r.skipped) return;
  if (r.polled) console.log(`[podcasts] polled ${r.polled} feed(s): ${r.changed} changed, ${r.errors} error(s), ${r.announce.reduce((n, a) => n + a.episodes.length, 0)} new episode(s)`);
  await announce(r.announce).catch((e) => console.warn('[podcasts] push:', e.message));
}

// ─── Podping ──────────────────────────────────────────────────────────────────

let podpingBlock = 0;
let podpingSavedAt = 0;

function pingedUrls(op) {
  const v = op && op.value;
  if (!v || typeof v.id !== 'string' || !(v.id === 'podping' || v.id.startsWith('pp_'))) return [];
  let j;
  try { j = JSON.parse(v.json); } catch (_) { return []; }
  const urls = Array.isArray(j.iris) ? j.iris : Array.isArray(j.urls) ? j.urls : j.url ? [j.url] : [];
  return urls.filter((u) => typeof u === 'string').slice(0, 200);
}

async function podpingOnce() {
  const props = await hiveRpcCall('condenser_api.get_dynamic_global_properties', []);
  const head = props && props.head_block_number;
  if (!head) return;
  const db = getDb();
  if (!podpingBlock) {
    const st = await db.collection(STATE).findOne({ _id: 'podping' });
    podpingBlock = st && st.block ? st.block : head - 1;
  }
  if (head - podpingBlock > PODPING_MAX_LAG) {
    console.log(`[podcasts] podping ${head - podpingBlock} blocks behind, skipping ahead`);
    podpingBlock = head - 1;
  }
  const from = podpingBlock + 1;
  if (from > head) return;
  const count = Math.min(PODPING_MAX_BLOCKS, head - from + 1);
  const r = await hiveRpcCall('block_api.get_block_range', { starting_block_num: from, count });
  if (!r || !Array.isArray(r.blocks)) return;
  const keys = new Set();
  for (const b of r.blocks) {
    for (const tx of b.transactions || []) {
      for (const op of tx.operations || []) {
        for (const u of pingedUrls(op)) { const k = urlKey(u); if (k) keys.add(k); }
      }
    }
  }
  podpingBlock = from + r.blocks.length - 1;
  if (keys.size) {
    const list = [...keys];
    const res = await db.collection(FEEDS).updateMany(
      {
        $or: [{ url_key: { $in: list } }, { alt_keys: { $in: list } }],
        subscribers: { $gt: 0 },
        // A ping is a hint, not a command: anyone can send one, so it can make us
        // look sooner, never hammer a host.
        last_fetch_at: { $lt: new Date(Date.now() - PODPING_MIN_REFETCH_MS) },
      },
      { $set: { next_poll_at: new Date(), podping_at: new Date() } },
    );
    if (res.modifiedCount) {
      console.log(`[podcasts] podping: ${res.modifiedCount} followed feed(s) updated, fetching`);
      tick().catch(() => {});
    }
  }
  if (Date.now() - podpingSavedAt > 60 * 1000) {
    podpingSavedAt = Date.now();
    await db.collection(STATE).updateOne({ _id: 'podping' }, { $set: { block: podpingBlock, at: new Date() } }, { upsert: true });
  }
}

function startPodping() {
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await podpingOnce(); } catch (e) { console.warn('[podcasts] podping:', e.message); } finally { busy = false; }
  }, PODPING_EVERY_MS).unref();
}

// ─── Clean-up ─────────────────────────────────────────────────────────────────

async function gc() {
  const db = getDb();
  const now = Date.now();
  const candidates = await db.collection(FEEDS).find({
    subscribers: { $lte: 0 },
    $or: [
      { orphaned_at: { $lt: new Date(now - ORPHAN_GRACE_MS) } },
      // Rows a failed probe or an abandoned import left behind.
      { orphaned_at: { $exists: false }, created_at: { $lt: new Date(now - 24 * 3600 * 1000) } },
    ],
  }, { projection: { _id: 1 } }).limit(500).toArray();
  let removed = 0;
  for (const f of candidates) {
    const n = await db.collection(SUBS).countDocuments({ feed_id: f._id });
    if (n > 0) {
      await db.collection(FEEDS).updateOne({ _id: f._id }, { $set: { subscribers: n }, $unset: { orphaned_at: '' } });
      continue;
    }
    await db.collection(EPISODES).deleteMany({ feed_id: f._id });
    await db.collection(FEEDS).deleteOne({ _id: f._id });
    removed += 1;
  }
  if (removed) console.log(`[podcasts] removed ${removed} feed(s) nobody follows`);
}

function start() {
  if (!ENABLED) { console.log('[podcasts] disabled (PODCAST_FEEDS_ENABLED=false)'); return; }
  if (!ENABLE_MONGO_WRITES) { console.log('[podcasts] skipped: ENABLE_MONGO_WRITES=false'); return; }
  ensureIndexes().catch((e) => console.warn('[podcasts] index setup:', e.message));
  spawn();
  setTimeout(() => {
    tick().catch(() => {});
    setInterval(() => tick().catch(() => {}), TICK_SEC * 1000).unref();
  }, 45 * 1000).unref();
  setInterval(() => gc().catch((e) => console.warn('[podcasts] gc:', e.message)), 60 * 60 * 1000).unref();
  if (PODPING_ENABLED) startPodping();
  console.log(`[podcasts] outside feeds on: poll tick ${TICK_SEC}s, podping ${PODPING_ENABLED ? 'on' : 'off'}`);
}

module.exports = {
  start,
  ask,
  enabled: () => ENABLED && ENABLE_MONGO_WRITES,
  collections: { FEEDS, EPISODES, SUBS, PROGRESS },
  _test: { pingedUrls },
};
