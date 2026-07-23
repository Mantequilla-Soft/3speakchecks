/**
 * Feed-card stats (payout / votes / comments), served from our own cache.
 *
 * THE PROBLEM: a feed card shows payout, vote count and comment count. None of
 * those live in Mongo (stats.total_hive_reward / num_votes / num_comments are 0
 * on every doc), so the FRONTEND fetched them itself — one
 * condenser_api.get_content per visible card, on every feed, in every browser.
 * Measured on a live 24-card discover page that is ~964KB and ~1.3s, and ~85% of
 * it is the active_votes array, which the cards only ever counted. Every visitor
 * re-fetched the same popular posts, so the load scaled with users × cards.
 *
 * THE FIX: keep the three numbers in `video-stats`, refreshed from Hive in the
 * BACKGROUND (shared by everybody), and stamp them into stats.* on the way out.
 * The browser then needs no Hive calls at all and the response grows by ~0 bytes,
 * because the stats object is already in the payload — just zeroed.
 *
 * Population is LAZY, driven by what feeds actually serve: attachVideoStats()
 * fills in whatever is cached and queues anything missing/stale for the background
 * drain. So the working set is exactly the videos people are being shown, at any
 * age — no attempt to sync the whole corpus. A cold key simply has no stats on its
 * first appearance; the frontend still has its own fallback for that case, and the
 * key is warm by the next request.
 *
 * Never blocks a feed response: the Mongo read is an indexed _id lookup on a local
 * DB, and the Hive refresh happens off the request path entirely.
 */
const { getDb } = require('../utils/db');
const { fetchHiveVideoStats } = require('../utils/hive');
const {
  VIDEO_STATS_ENABLED, VIDEO_STATS_TTL_MIN, VIDEO_STATS_DRAIN_SEC,
  VIDEO_STATS_DRAIN_BATCH, VIDEO_STATS_QUEUE_MAX, ENABLE_MONGO_WRITES,
} = require('../utils/config');

const COLLECTION = 'video-stats';

// Keys awaiting a background refresh. A Set both dedupes and preserves insertion
// order, so the queue drains oldest-first.
const pending = new Set();
let draining = false;

const lc = (s) => String(s || '').trim().toLowerCase();
const ttlMs = () => Math.max(1, VIDEO_STATS_TTL_MIN) * 60 * 1000;

/** Hive author/permlink for a feed item, across the shapes the feeds emit. */
function keyOf(v) {
  if (!v || typeof v !== 'object') return null;
  const author = lc(
    (v.author && typeof v.author === 'object' ? (v.author.username || v.author.id) : v.author)
    || v.owner || v.hive_author,
  );
  const permlink = v.permlink || v.hive_permlink;
  return author && permlink ? `${author}/${permlink}` : null;
}

function enqueue(key) {
  if (!key || pending.has(key)) return;
  if (pending.size >= VIDEO_STATS_QUEUE_MAX) return;   // shed rather than grow without bound
  pending.add(key);
}

/**
 * Fill stats.* on a list of feed items from the cache, and queue whatever is
 * missing or stale. Mutates the items in place. Safe to call on any feed shape.
 */
async function attachVideoStats(videos) {
  if (!VIDEO_STATS_ENABLED || !Array.isArray(videos) || videos.length === 0) return;

  const byKey = new Map();
  for (const v of videos) {
    const key = keyOf(v);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(v);
  }
  if (byKey.size === 0) return;

  let rows = [];
  try {
    rows = await getDb().collection(COLLECTION)
      .find({ _id: { $in: [...byKey.keys()] } })
      .toArray();
  } catch (err) {
    console.error('[videoStats] cache read failed:', err && err.message);
    return;                                   // serve the feed unchanged
  }

  const fresh = Date.now() - ttlMs();
  const seen = new Set();

  for (const row of rows) {
    seen.add(row._id);
    for (const v of byKey.get(row._id) || []) {
      v.stats = {
        ...(v.stats || {}),
        total_hive_reward: row.reward || 0,
        num_votes: row.votes || 0,
        num_comments: row.comments || 0,
        // Explicit marker: tells the frontend these numbers are authoritative so it
        // can skip its own Hive fetch. Needed because a legitimately 0/0/0 post is
        // indistinguishable from "not filled in" by value alone.
        has_stats: true,
      };
    }
    if (!row.updatedAt || row.updatedAt.getTime() < fresh) enqueue(row._id);
  }

  // Never served before → no stats to show yet; warm it for next time.
  for (const key of byKey.keys()) if (!seen.has(key)) enqueue(key);
}

/** Express middleware: attach stats to every video list on the way out. */
const LIST_KEYS = ['videos', 'items', 'results', 'shorts', 'trends', 'data'];

function videoStatsMiddleware(req, res, next) {
  if (!VIDEO_STATS_ENABLED) return next();
  const originalJson = res.json.bind(res);
  res.json = (payload) => {
    const lists = [];
    if (Array.isArray(payload)) lists.push(payload);
    else if (payload && typeof payload === 'object') {
      for (const k of LIST_KEYS) if (Array.isArray(payload[k])) lists.push(payload[k]);
    }
    if (lists.length === 0) return originalJson(payload);
    // Send once the (local, indexed) lookup resolves. Failures still send.
    Promise.all(lists.map(attachVideoStats))
      .catch((err) => console.error('[videoStats] attach failed:', err && err.message))
      .finally(() => originalJson(payload));
    return res;
  };
  next();
}

/** Refresh a slice of the pending queue from Hive and store it. */
async function drainVideoStats() {
  if (!VIDEO_STATS_ENABLED || draining || pending.size === 0) return null;
  draining = true;
  const startedAt = Date.now();
  try {
    const keys = [...pending].slice(0, Math.max(1, VIDEO_STATS_DRAIN_BATCH));
    for (const k of keys) pending.delete(k);

    const authorPerms = keys.map((k) => {
      const i = k.indexOf('/');
      return { author: k.slice(0, i), permlink: k.slice(i + 1) };
    });

    // ttl:0 — the queue already decided these need refreshing, so bypass the
    // in-process cache in utils/hive.js rather than re-reading what we just aged out.
    const stats = await fetchHiveVideoStats(authorPerms, { ttl: 0 });
    if (stats.size === 0) return { queued: pending.size, fetched: 0, ms: Date.now() - startedAt };

    const now = new Date();
    const ops = [];
    for (const [key, s] of stats) {
      const i = key.indexOf('/');
      ops.push({
        updateOne: {
          filter: { _id: key },
          update: { $set: {
            author: key.slice(0, i), permlink: key.slice(i + 1),
            reward: s.reward, votes: s.votes, comments: s.comments, updatedAt: now,
          } },
          upsert: true,
        },
      });
    }
    if (ENABLE_MONGO_WRITES && ops.length) {
      await getDb().collection(COLLECTION).bulkWrite(ops, { ordered: false });
    }
    return { requested: keys.length, fetched: ops.length, queued: pending.size, ms: Date.now() - startedAt };
  } catch (err) {
    console.error('[videoStats] drain failed:', err && err.message);
    return { error: String((err && err.message) || err) };
  } finally {
    draining = false;
  }
}

function scheduleVideoStats() {
  if (!VIDEO_STATS_ENABLED) {
    console.log('[videoStats] disabled (VIDEO_STATS_ENABLED=false)');
    return;
  }
  const everyMs = Math.max(5, VIDEO_STATS_DRAIN_SEC) * 1000;
  setInterval(() => {
    drainVideoStats()
      .then((s) => { if (s && (s.fetched || s.error)) console.log('[videoStats]', JSON.stringify(s)); })
      .catch((e) => console.error('[videoStats] drain error:', e && e.message));
  }, everyMs);
  console.log(`[videoStats] enabled — draining every ${VIDEO_STATS_DRAIN_SEC}s, up to ${VIDEO_STATS_DRAIN_BATCH}/run, TTL ${VIDEO_STATS_TTL_MIN}min`);
}

module.exports = {
  attachVideoStats, videoStatsMiddleware, drainVideoStats, scheduleVideoStats, keyOf,
};
