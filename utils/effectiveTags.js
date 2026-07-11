/**
 * "Winner-only" topic resolution for interest matching.
 *
 * Every video collapses to ONE effective topic — the tag with the highest combined
 * weight from two sources:
 *   - viewer votes      — each contributes its vote weight (0–10000) to its tag
 *   - transcription tags — each auto-tag contributes AUTO_TAG_WEIGHT (a 100% vote)
 *
 * Feeds then interest-match against that single winner, instead of any of a
 * video's several Hive/auto tags. This is what stops one video that carries five
 * loose auto-tags from matching five different interests.
 *
 * Tie-breaks (when weights are equal — the common no-vote case where every auto
 * tag sits at AUTO_TAG_WEIGHT): a tag the crowd actually voted on beats a
 * pure-auto tag; then the EARLIER auto tag wins, because the tagger emits tags in
 * relevance order (first = most relevant); then tag name, for determinism.
 */
const AUTO_TAG_WEIGHT = 10000;
const VIEWER_TAGS = 'viewer-tags';
const TAG_FIELD = 'viewer-tag';

const lc = (s) => String(s || '').trim().toLowerCase().replace(/^@/, '');
const splitOrdered = (raw) => String(raw || '')
  .split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);

/**
 * @param {string[]} autoOrdered   transcription tags, in the tagger's relevance order
 * @param {Object<string,number>} viewerWeights  tag -> summed viewer vote weight
 * @returns {string|null} the single winning tag
 */
function pickWinner(autoOrdered = [], viewerWeights = {}) {
  const autoIndex = new Map();
  autoOrdered.forEach((t, i) => { if (!autoIndex.has(t)) autoIndex.set(t, i); });

  const tags = new Set([...autoIndex.keys(), ...Object.keys(viewerWeights)]);
  if (!tags.size) return null;

  let best = null;
  for (const tag of tags) {
    const vw = viewerWeights[tag] || 0;
    const cand = {
      tag,
      weight: vw + (autoIndex.has(tag) ? AUTO_TAG_WEIGHT : 0),
      hasVote: vw > 0 ? 1 : 0,
      order: autoIndex.has(tag) ? autoIndex.get(tag) : Number.MAX_SAFE_INTEGER,
    };
    if (!best
      || cand.weight > best.weight
      || (cand.weight === best.weight && cand.hasVote > best.hasVote)
      || (cand.weight === best.weight && cand.hasVote === best.hasVote && cand.order < best.order)
      || (cand.weight === best.weight && cand.hasVote === best.hasVote && cand.order === best.order && cand.tag < best.tag)
    ) best = cand;
  }
  return best ? best.tag : null;
}

/** Batch: ordered auto-tags per key. keys = [{author, permlink}] (owner+ASSET). */
async function fetchAutoTagsOrdered(db, keys) {
  const map = new Map();
  const seen = new Set();
  const orConds = [];
  for (const k of keys || []) {
    if (!k || !k.author || !k.permlink) continue;
    const id = `${lc(k.author)}/${k.permlink}`;
    if (seen.has(id)) continue;
    seen.add(id);
    orConds.push({ author: lc(k.author), permlink: k.permlink });
  }
  if (!orConds.length) return map;
  const docs = await db.collection('subtitles-tags')
    .find({ $or: orConds }, { projection: { author: 1, permlink: 1, tags: 1 } }).toArray();
  for (const d of docs) map.set(`${lc(d.author)}/${d.permlink}`, splitOrdered(d.tags));
  return map;
}

/** Batch: viewer vote weight per tag per key. keys = [{author, permlink}] (HIVE). */
async function fetchViewerWeights(db, keys) {
  const map = new Map();
  const seen = new Set();
  const orConds = [];
  for (const k of keys || []) {
    if (!k || !k.author || !k.permlink) continue;
    const id = `${lc(k.author)}/${k.permlink}`;
    if (seen.has(id)) continue;
    seen.add(id);
    orConds.push({ author: lc(k.author), permlink: k.permlink });
  }
  if (!orConds.length) return map;
  const rows = await db.collection(VIEWER_TAGS).aggregate([
    { $match: { $or: orConds } },
    {
      $group: {
        _id: { a: '$author', p: '$permlink', t: `$${TAG_FIELD}` },
        w: { $sum: { $max: [{ $abs: { $ifNull: ['$weight', 1] } }, 1] } },
      },
    },
  ]).toArray();
  for (const r of rows) {
    const id = `${lc(r._id.a)}/${r._id.p}`;
    const obj = map.get(id) || {};
    obj[r._id.t] = (obj[r._id.t] || 0) + r.w;
    map.set(id, obj);
  }
  return map;
}

/**
 * Winner tag for a batch of video objects.
 * @param {(v)=>({author,permlink})} autoKeyFn  owner + ASSET permlink (subtitles-tags)
 * @param {(v)=>({author,permlink})} hiveKeyFn  hive author + hive permlink (viewer-tags)
 * @returns {Promise<Map<object,string|null>>} video ref -> winner tag
 */
async function getWinners(db, videos, autoKeyFn, hiveKeyFn) {
  const out = new Map();
  if (!videos || !videos.length) return out;
  const [autoMap, viewerMap] = await Promise.all([
    fetchAutoTagsOrdered(db, videos.map(autoKeyFn)),
    fetchViewerWeights(db, videos.map(hiveKeyFn)),
  ]);
  for (const v of videos) {
    const ak = autoKeyFn(v);
    const hk = hiveKeyFn(v);
    const auto = autoMap.get(`${lc(ak.author)}/${ak.permlink}`) || [];
    const viewer = viewerMap.get(`${lc(hk.author)}/${hk.permlink}`) || {};
    out.set(v, pickWinner(auto, viewer));
  }
  return out;
}

module.exports = {
  AUTO_TAG_WEIGHT, pickWinner, fetchAutoTagsOrdered, fetchViewerWeights, getWinners,
};
