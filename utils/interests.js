const { INTEREST_MULTIPLIER } = require('./config');

// Parse ?interests=a,b,c into a lowercased Set. Empty when the param is absent —
// callers key on that to stay on the exact legacy code path (backwards compatible;
// the prod frontend that doesn't send interests behaves identically to before).
function parseInterests(req) {
  const raw = req && req.query ? req.query.interests : null;
  if (!raw) return new Set();
  const arr = Array.isArray(raw) ? raw : String(raw).split(',');
  return new Set(arr.map((t) => String(t).trim().toLowerCase()).filter(Boolean));
}

// For a batch of { author, permlink } content keys, fetch the transcription tags
// from the `subtitles-tags` collection (keyed by owner + asset permlink) and
// return a Map "author/permlink" -> Set(tags). One query for the whole batch.
async function fetchTranscriptionTags(db, keys) {
  const map = new Map();
  const seen = new Set();
  const orConds = [];
  for (const k of keys || []) {
    if (!k || !k.author || !k.permlink) continue;
    const id = `${k.author}/${k.permlink}`;
    if (seen.has(id)) continue;
    seen.add(id);
    orConds.push({ author: k.author, permlink: k.permlink });
  }
  if (!orConds.length) return map;
  const docs = await db.collection('subtitles-tags')
    .find({ $or: orConds }, { projection: { author: 1, permlink: 1, tags: 1 } })
    .toArray();
  for (const d of docs) {
    const tags = String(d.tags || '')
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    map.set(`${d.author}/${d.permlink}`, new Set(tags));
  }
  return map;
}

// Normalize "own" tags (hive_tags / tags) — accepts an array or a comma string,
// strips a leading # and lowercases — into a Set.
function normalizeTags(tags) {
  const arr = typeof tags === 'string' ? tags.split(',') : (tags || []);
  const out = new Set();
  for (const t of arr) {
    const s = String(t).replace(/^#/, '').trim().toLowerCase();
    if (s) out.add(s);
  }
  return out;
}

// True if any of the content's tags (own + transcription) is in the interest set.
function tagsMatchInterests(ownTags, transcriptionSet, interestSet) {
  if (!interestSet || !interestSet.size) return false;
  for (const t of interestSet) {
    if (ownTags && ownTags.has(t)) return true;
    if (transcriptionSet && transcriptionSet.has(t)) return true;
  }
  return false;
}

module.exports = {
  INTEREST_MULTIPLIER,
  parseInterests,
  fetchTranscriptionTags,
  normalizeTags,
  tagsMatchInterests,
};
