/**
 * Feed-time retention re-ranking. Reads the PRE-COMPUTED RETENTION_COLLECTION
 * (written by the retention worker) — one cheap indexed `_id: {$in}` lookup, no
 * aggregation on the request path — and multiplies each candidate's existing feed
 * score by a bounded retention factor.
 *
 * Retention is keyed by owner + ASSET permlink (same as view-durations): for embed
 * candidates that's `_embedPermlink`, for legacy it's `permlink`. Callers pass a
 * keyFn so each feed maps its own doc shape.
 *
 * Backwards compatible: if the collection is empty (worker hasn't run) or a video
 * has no record, its multiplier is exactly 1 → the feed is unchanged.
 */
const { RETENTION_COLLECTION } = require('./config');
const { retentionMultiplier } = require('./retentionScore');

// Default: embed candidates carry the asset id in `_embedPermlink`; legacy videos
// use `permlink` (which already IS the asset id / what the player tracks).
function defaultKey(v) {
  const owner = v.owner || v.author;
  const permlink = v._source === 'embed' ? (v._embedPermlink || v.permlink) : v.permlink;
  return owner && permlink ? `${owner}/${permlink}` : null;
}

/**
 * Multiply each video's `scoreField` by its bounded retention multiplier.
 * @param {import('mongodb').Db} db
 * @param {Array<object>} videos
 * @param {object} [opts]
 * @param {(v:object)=>(string|null)} [opts.keyFn]  owner/permlink key for a video
 * @param {string} [opts.scoreField='trending_score']
 * @param {object} [opts.multOpts]  {weight,min,max} overrides for retentionMultiplier
 * @returns {Promise<number>} how many videos actually had a retention record
 */
async function applyRetention(db, videos, opts = {}) {
  const keyFn = opts.keyFn || defaultKey;
  const scoreField = opts.scoreField || 'trending_score';
  if (!Array.isArray(videos) || !videos.length) return 0;

  const keys = [...new Set(videos.map(keyFn).filter(Boolean))];
  if (!keys.length) return 0;

  // `viewers` is projected alongside the score because the DEMOTION side of the
  // multiplier is gated on it — without it every low-relQ video would be treated as
  // "no evidence" and never demoted at all. See retentionMultiplier().
  let recMap = new Map();
  try {
    const docs = await db.collection(RETENTION_COLLECTION)
      .find({ _id: { $in: keys } }, { projection: { score: 1, viewers: 1 } }).toArray();
    recMap = new Map(docs.map((d) => [d._id, d]));
  } catch {
    return 0; // never let ranking break a feed — fall back to the existing order
  }
  if (!recMap.size) return 0;

  let matched = 0;
  for (const v of videos) {
    const key = keyFn(v);
    const rec = key != null ? recMap.get(key) : undefined;
    if (!rec || rec.score == null) { v.retention_mult = 1; continue; }
    matched += 1;
    const mult = retentionMultiplier(rec.score, { ...opts.multOpts, viewers: rec.viewers });
    v.retention_relq = rec.score;
    v.retention_viewers = rec.viewers ?? null;
    v.retention_mult = Math.round(mult * 1000) / 1000;
    v[scoreField] = (Number(v[scoreField]) || 0) * mult;
  }
  return matched;
}

module.exports = { applyRetention, defaultKey };
