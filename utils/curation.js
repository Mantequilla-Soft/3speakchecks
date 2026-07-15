/**
 * Curation signals — the MANUAL votes.
 *
 * Everything else the ranking uses is either passive (views, watch time) or
 * on-chain (upvotes, rewards). These three are a person deliberately doing
 * something about ONE video:
 *
 *   reshares — put it on their own blog                    → `reshares`    (Go playlists svc)
 *   saves    — added it to a playlist / Watch Later        → `playlists.items`
 *   tags     — labelled its topic alongside their upvote   → `viewer-tags`
 *
 * NOTE these are 3Speak reshares, NOT Hive reblogs — the `reshares` collection is
 * written by the playlists service when a user hits Reshare in the app.
 *
 * All three are keyed by HIVE author/permlink (that is what all three collections
 * store), and all three are DISTINCT-ACTOR counts: adding one video to three of
 * your own playlists is still one person caring.
 *
 * Self-curation does not count. An author resharing / saving / tagging their own
 * video is not a signal, it is a lever — those rows are dropped in the aggregation.
 *
 * The boost is log-damped and hard-capped, exactly like the reshare boost it
 * replaces. These signals are SPARSE — live, after self-curation is excluded, 226
 * videos carry any curation at all (134 reshared, 87 tagged, 15 saved) and the top
 * distinct-actor count is 2. So a single act has to lift a video without letting one
 * motivated person mint a #1 slot.
 *
 *   curationBoost = min(CAP, 1 + Wr·ln(1+reshares) + Ws·ln(1+saves) + Wt·ln(1+tags))
 *
 * Legacy playlists are NOT counted: the old app wrote `playlists.list` as an array
 * of `videos._id` ObjectId refs, a schema nothing writes any more. Counting them
 * would mean a second, differently-shaped join for a frozen signal. If those 951
 * historic saves are wanted, backfill them into `items` rather than teaching the
 * ranking a second shape.
 */
const {
  CURATION_ENABLED, CURATION_CACHE_MS,
  CURATION_RESHARE_WEIGHT, CURATION_SAVE_WEIGHT, CURATION_TAG_WEIGHT,
  CURATION_MAX_BOOST,
} = require('./config');

const EMPTY = Object.freeze({ reshares: 0, saves: 0, tags: 0 });
const keyOf = (author, permlink) => `${String(author || '').toLowerCase()}/${permlink}`;
const num = (n) => Math.max(0, Number(n) || 0);

/**
 * The bounded boost. `opts.reshareWeight = 0` is how trending / shorts opt out of
 * the reshare term: those feeds already score reshares ADDITIVELY (their tuned
 * TRENDING_RESHARE_WEIGHT / RESHARE_WEIGHT), so counting them again here would be
 * double-dipping. Discover has no additive term, so it takes all three.
 */
function curationBoost(counts = EMPTY, opts = {}) {
  if (!CURATION_ENABLED) return 1;
  const wr = opts.reshareWeight ?? CURATION_RESHARE_WEIGHT;
  const ws = opts.saveWeight ?? CURATION_SAVE_WEIGHT;
  const wt = opts.tagWeight ?? CURATION_TAG_WEIGHT;
  const cap = opts.cap ?? CURATION_MAX_BOOST;

  const boost = 1
    + wr * Math.log1p(num(counts.reshares))
    + ws * Math.log1p(num(counts.saves))
    + wt * Math.log1p(num(counts.tags));

  return Math.min(cap, Math.max(1, boost));
}

// Group on the LOWERCASED author. `keyOf` lowercases too, so grouping on the raw field
// would let `Alice/x` and `alice/x` become two groups that collapse to one key on the
// way into the map — where the second silently overwrites the first instead of merging.
// Same reason the self-curation comparison is done on lowercased values.
const lc = (f) => ({ $toLower: { $ifNull: [f, ''] } });

/** reshares: distinct resharers per video, self-reshares dropped. */
const reshareCounts = (db) => db.collection('reshares').aggregate([
  { $match: { $expr: { $ne: [lc('$username'), lc('$author')] } } },
  { $group: { _id: { author: lc('$author'), permlink: '$permlink' }, actors: { $addToSet: lc('$username') } } },
]).toArray();

/** viewer-tags: distinct taggers per video, self-tags dropped. */
const tagCounts = (db) => db.collection('viewer-tags').aggregate([
  { $match: { $expr: { $ne: [lc('$voter'), lc('$author')] } } },
  { $group: { _id: { author: lc('$author'), permlink: '$permlink' }, actors: { $addToSet: lc('$voter') } } },
]).toArray();

/**
 * playlists: distinct playlist OWNERS holding the video, self-saves dropped.
 *
 * Watch Later is just a playlist (a private one named "Watch Later"), so it needs no
 * special case — a save is a save, and a global distinct-saver count is what makes
 * the signal count for OTHER viewers rather than only the person who saved it.
 *
 * Dropping self-saves is not a nicety, it is the whole integrity of this signal:
 * 3Speak playlists are overwhelmingly creators collecting their OWN videos into
 * albums and series. 476 videos sit in some playlist; only 15 sit in a playlist
 * belonging to someone other than their author. Counting self-saves would let any
 * creator lift their entire back catalogue by ~21% by making one playlist of it.
 */
const saveCounts = (db) => db.collection('playlists').aggregate([
  { $match: { items: { $exists: true, $ne: [] } } },
  { $unwind: '$items' },
  { $match: { $expr: { $ne: [lc('$owner'), lc('$items.author')] } } },
  { $group: { _id: { author: lc('$items.author'), permlink: '$items.permlink' }, actors: { $addToSet: lc('$owner') } } },
]).toArray();

// Accumulate, never assign: even with the $toLower grouping above, two rows reaching
// the same key must ADD their distinct actors rather than have the last one win.
function merge(into, rows, field) {
  for (const r of rows) {
    const id = keyOf(r._id.author, r._id.permlink);
    const cur = into.get(id) || { reshares: 0, saves: 0, tags: 0 };
    cur[field] += (r.actors || []).length;
    into.set(id, cur);
  }
}

let cache = { at: 0, map: new Map() };

/**
 * Distinct-actor counts for EVERY curated video, keyed "author/permlink".
 *
 * The whole map, not a per-request lookup by candidate key. All three collections
 * are tiny (180 reshares, 96 viewer tags, 661 playlists → 226 curated videos), and
 * the bounded `$or` version cost ~370ms per feed request against a map that fits in
 * a few KB. So we build it once and hold it behind a TTL, like the discover pool.
 * A save taking up to CURATION_CACHE_MS to count is fine — this is a ranking nudge,
 * not a read-your-writes surface.
 *
 * Never throws: a broken pipeline degrades to "no curation boost", which leaves every
 * feed exactly as it was rather than breaking it.
 *
 * @returns {Promise<Map<string,{reshares:number,saves:number,tags:number}>>}
 */
async function getCurationCounts(db, { force = false } = {}) {
  if (!CURATION_ENABLED) return new Map();
  if (!force && cache.map.size && Date.now() - cache.at < CURATION_CACHE_MS) return cache.map;

  try {
    const [rs, sv, tg] = await Promise.all([reshareCounts(db), saveCounts(db), tagCounts(db)]);
    const map = new Map();
    merge(map, rs, 'reshares');
    merge(map, sv, 'saves');
    merge(map, tg, 'tags');
    cache = { at: Date.now(), map };
    return map;
  } catch (e) {
    console.warn('curation counts failed (feeds fall back to no boost):', e && e.message);
    return cache.map;   // stale beats broken; empty on a cold failure
  }
}

/** Test/ops hook — drop the cached map. */
function invalidate() { cache = { at: 0, map: new Map() }; }

module.exports = { curationBoost, getCurationCounts, keyOf, invalidate, EMPTY };
