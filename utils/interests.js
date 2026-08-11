const { INTEREST_MULTIPLIER } = require('./config');
const { TAGS_V2_TREE, isCategoryTag } = require('./interestTags');

// Parent lookup: topic -> its category. Built once from the same tree the
// vocabulary validation uses, so the two can never drift.
const TOPIC_PARENT = new Map();
for (const [cat, topics] of Object.entries(TAGS_V2_TREE)) {
  for (const t of topics) TOPIC_PARENT.set(t, cat);
}

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

/**
 * Resolve a viewer's picks into the two buckets the tiered ranking needs.
 *
 * SELECTED (full boost) is the picks EXPANDED: choosing the category
 * "Tech & Science" means you asked for everything under it, so `technology`,
 * `education`, `science` and `programming` are all first-class selections, not
 * second-class relatives. Choosing the topic `technology` selects just that.
 *
 * ADJACENT (reduced boost) only ever comes from picking a TOPIC: someone who
 * chose `technology` should see the rest of tech-science ahead of gardening, but
 * behind technology itself. A picked CATEGORY contributes no adjacents, because
 * everything beneath it is already selected outright.
 *
 * Pure and cheap: call once per request, not per video.
 */
function resolveInterestTiers(interestSet) {
  const picked = new Set([...(interestSet || [])].map((t) => String(t).toLowerCase()));

  const selected = new Set();
  const pickedTopics = new Set();
  for (const t of picked) {
    selected.add(t);
    if (isCategoryTag(t)) {
      for (const sub of TAGS_V2_TREE[t] || []) selected.add(sub);  // full boost, not sibling
    } else {
      pickedTopics.add(t);
    }
  }

  // Neighbourhood of the picked TOPICS only, minus anything already selected.
  const adjacent = new Set();
  for (const t of pickedTopics) {
    const parent = TOPIC_PARENT.get(t);
    if (!parent) continue;
    if (!selected.has(parent)) adjacent.add(parent);
    for (const sib of TAGS_V2_TREE[parent] || []) if (!selected.has(sib)) adjacent.add(sib);
  }

  return { selected, adjacent, any: picked.size > 0 };
}

/**
 * Strength of a video's relationship to the viewer's interests.
 * Returns 'exact' | 'sibling' | null, strongest first.
 */
function interestMatchTier(ownTags, transcriptionSet, tiers) {
  if (!tiers || !tiers.any) return null;
  const has = (tag) => (ownTags && ownTags.has(tag)) || (transcriptionSet && transcriptionSet.has(tag));
  for (const t of tiers.selected) if (has(t)) return 'exact';
  for (const s of tiers.adjacent) if (has(s)) return 'sibling';
  return null;
}

/**
 * Tier for a SINGLE tag — the discover/shorts pools precompute one `winnerTag`
 * per video, so this avoids allocating a Set per candidate in the hot loop.
 */
function interestTierForTag(tag, tiers) {
  if (!tiers || !tiers.any || !tag) return null;
  const t = String(tag).toLowerCase();
  if (tiers.selected.has(t)) return 'exact';
  if (tiers.adjacent.has(t)) return 'sibling';
  return null;
}

/** Score multiplier for a tier. Unknown/no match leaves the score untouched. */
function interestTierMultiplier(tier, mults) {
  if (tier === 'exact') return mults.exact;
  if (tier === 'sibling') return mults.sibling;
  return 1;
}

module.exports = {
  INTEREST_MULTIPLIER,
  parseInterests,
  fetchTranscriptionTags,
  normalizeTags,
  tagsMatchInterests,
  resolveInterestTiers,
  interestMatchTier,
  interestTierForTag,
  interestTierMultiplier,
};
