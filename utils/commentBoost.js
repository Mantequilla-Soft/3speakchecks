/**
 * Comment boost — reward videos that spark discussion.
 *
 * Comment counts are NOT in Mongo (stats.num_comments is empty on every doc); they
 * live only on Hive. A background sync (services/commentCounts.js) fetches them for
 * recent videos and stamps them into `video-comment-counts` (_id = author/permlink):
 *
 *   { comments, native3Speak, effective }
 *
 * where `effective = comments + (NATIVE_MULT − 1)·native3Speak` — comments posted
 * through the 3Speak frontend count NATIVE_MULT× (default 1.5).
 *
 * The feeds turn that into a modest, log-damped, capped multiplier:
 *
 *   commentBoost = min(CAP, 1 + W·ln(1 + effective))
 *
 * At W=0.2 / CAP=1.8:  eff 1 → 1.14,  5 → 1.36,  10 → 1.48,  20 → 1.60.  So a lively
 * comment section lifts a video, but a brigaded one can't run away with the feed.
 * A video with no record gets exactly ×1 — never a penalty.
 *
 * Applied to discover / interests (folded into the pool `base` by the discover
 * worker) and to the follow feed (which reads the cached map below per request).
 */
const {
  COMMENT_BOOST_ENABLED, COMMENT_BOOST_WEIGHT, COMMENT_BOOST_MAX, COMMENT_CACHE_MS,
} = require('./config');

const COLLECTION = 'video-comment-counts';
const keyOf = (author, permlink) => `${String(author || '').toLowerCase()}/${permlink}`;

/** The bounded multiplier for an `effective` comment count. */
function commentBoost(effective, opts = {}) {
  if (!COMMENT_BOOST_ENABLED) return 1;
  const w = opts.weight ?? COMMENT_BOOST_WEIGHT;
  const cap = opts.cap ?? COMMENT_BOOST_MAX;
  const n = Math.max(0, Number(effective) || 0);
  return Math.min(cap, Math.max(1, 1 + w * Math.log1p(n)));
}

let cache = { at: 0, map: new Map() };

/**
 * The whole `video-comment-counts` collection as one small in-process map (keyed
 * "author/permlink"), refreshed on a TTL. The collection is bounded to the last
 * COMMENT_SYNC_MAX_AGE_DAYS of videos, so it's a few thousand tiny rows. Used by the
 * request-path follow feed; the discover worker reads the collection directly (force).
 */
async function getCommentCounts(db, { force = false } = {}) {
  if (!COMMENT_BOOST_ENABLED) return new Map();
  if (!force && cache.map.size && Date.now() - cache.at < COMMENT_CACHE_MS) return cache.map;
  try {
    const rows = await db.collection(COLLECTION)
      .find({}, { projection: { effective: 1, comments: 1, native3Speak: 1 } }).toArray();
    const map = new Map(rows.map((r) => [r._id, r]));
    cache = { at: Date.now(), map };
    return map;
  } catch (e) {
    console.warn('comment counts read failed (feeds fall back to no boost):', e && e.message);
    return cache.map;   // stale beats broken; empty on a cold failure
  }
}

/** Test/ops hook — drop the cached map. */
function invalidate() { cache = { at: 0, map: new Map() }; }

module.exports = { commentBoost, getCommentCounts, keyOf, invalidate, COLLECTION };
