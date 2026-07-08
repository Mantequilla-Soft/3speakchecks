/**
 * Shared feed ranking/filtering so every discovery feed behaves the same:
 *   1. interest boost  — multiply score for videos whose tags match ?interests=
 *   2. retention       — multiply score by the cached retention factor (algo.md)
 *   3. sort by score
 *   4. hide-seen       — drop videos the ?currentuser= has already watched
 *
 * All steps are no-ops when their input is absent (no interests / no currentuser /
 * no retention record), so callers stay backwards compatible. The "new videos"
 * feeds deliberately don't use this (they must stay purely chronological).
 */
const {
  INTEREST_MULTIPLIER, parseInterests, fetchTranscriptionTags, normalizeTags, tagsMatchInterests,
} = require('./interests');
const { applyRetention } = require('./retentionRank');

// Asset key for interest/transcription + retention lookups: embed candidates carry
// the asset id in `_embedPermlink`, legacy videos use `permlink`.
function defaultSubKey(v) {
  return { author: v.owner, permlink: v._source === 'embed' ? (v._embedPermlink || v.permlink) : v.permlink };
}
// watch_history key: "user:owner:hivePermlink" — v.permlink is the Hive permlink here.
function defaultWatchKey(v) { return `${v.owner}:${v.permlink}`; }

async function applyInterestBoost(db, req, videos, subKey = defaultSubKey, scoreField = 'trending_score') {
  const interestSet = parseInterests(req);
  if (!interestSet.size || !videos.length) return;
  const transcription = await fetchTranscriptionTags(db, videos.map(subKey));
  for (const v of videos) {
    const { author, permlink } = subKey(v);
    const own = normalizeTags(v.tags_v2 || v.tags);
    const tr = transcription.get(`${author}/${permlink}`);
    if (tagsMatchInterests(own, tr, interestSet)) {
      v[scoreField] = (Number(v[scoreField]) || 0) * INTEREST_MULTIPLIER;
      v.interest_match = true;
    }
  }
}

async function filterWatched(db, req, videos, wkey = defaultWatchKey) {
  const currentuser = (req.query.currentuser || '').trim().toLowerCase();
  if (!currentuser || !videos.length) return videos;
  const ids = videos.map((v) => `${currentuser}:${wkey(v)}`);
  const watched = await db.collection('watch_history')
    .find({ _id: { $in: ids } }, { projection: { _id: 1 } }).toArray();
  const seen = new Set(watched.map((w) => w._id));
  return videos.filter((v) => !seen.has(`${currentuser}:${wkey(v)}`));
}

/**
 * Full pipeline: interest boost → retention → sort desc → hide-seen.
 * @returns {Promise<Array>} the ranked, watched-filtered videos.
 */
async function rankFeed(db, req, videos, opts = {}) {
  const scoreField = opts.scoreField || 'trending_score';
  const subKey = opts.subKey || defaultSubKey;
  const wkey = opts.wkey || defaultWatchKey;
  await applyInterestBoost(db, req, videos, subKey, scoreField);
  await applyRetention(db, videos, { scoreField, keyFn: opts.retentionKeyFn });
  videos.sort((a, b) => (Number(b[scoreField]) || 0) - (Number(a[scoreField]) || 0));
  return filterWatched(db, req, videos, wkey);
}

module.exports = { rankFeed, applyInterestBoost, filterWatched, defaultSubKey, defaultWatchKey };
