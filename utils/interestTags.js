/**
 * Canonical taxonomy for viewer-assigned tags — the ONLY tags a viewer may
 * assign via the vote dialog.
 *
 * This is the UNION of two vocabularies, on purpose:
 *
 *  - V2 — the current taxonomy: 7 broad categories + 27 topics. A CATEGORY is a
 *    legitimate tag in its own right ("definitely this area, not sure which
 *    topic"), so categories are accepted too. Mirrors src/utils/tagsV2.js.
 *  - V1 (`LEGACY_INTEREST_TAGS`) — the retired flat interest list. Still
 *    accepted because the DEPLOYED prod frontend ships the old picker; drop
 *    these only once every client has moved to v2, or prod users' tags start
 *    getting 400s.
 *
 * Anything outside the union is rejected (400) and silently never recorded —
 * which is how the v2 rollout initially lost tags like `programming`.
 */

// --- v2: the 2-level tree. Single source of truth for the vocabulary AND for
// rolling a category up to its topics (a category filter must match the
// category tag itself PLUS every topic under it). Mirrors src/utils/tagsV2.js.
// `vlog` is viewer-pickable only — the auto-tagger never emits it.
const TAGS_V2_TREE = {
  'tech-science': ['technology', 'education', 'science', 'programming'],
  'crypto-finance': ['cryptocurrency', 'finance', 'business'],
  'entertainment': ['music', 'gaming', 'lifestyle', 'vlog', 'comedy', 'story-time', 'commercial'],
  'arts-diy': ['art', 'diy-crafts', 'photography'],
  'food-outdoor': ['nature', 'travel', 'food', 'pets', 'gardening'],
  'sports-health': ['sports', 'health', 'fitness'],
  'life-society': ['news', 'spirituality', 'politics'],
};

const TAGS_V2_CATEGORIES = Object.keys(TAGS_V2_TREE);
const TAGS_V2_TOPICS = Object.values(TAGS_V2_TREE).flat();

/** Category → [category, ...its topics]; any other slug → just itself. */
function expandTag(slug) {
  const t = String(slug || '').trim().toLowerCase();
  return TAGS_V2_TREE[t] ? [t, ...TAGS_V2_TREE[t]] : [t];
}

/** Is this one of the 7 broad categories? */
const isCategoryTag = (slug) => Object.hasOwn(TAGS_V2_TREE, String(slug || '').toLowerCase());

// Viewer-pickable but never emitted by the auto-tagger (mirrors
// VIEWER_EXTRA_TAGS in the frontend's tagsV2.js).
const VIEWER_EXTRA_TAGS = ['vlog'];

// --- v1: retired list, still accepted for the deployed prod frontend ---
const LEGACY_INTEREST_TAGS = [
  'news', 'travel', 'health', 'technology', 'art', 'music', 'tutorial', 'nature',
  'education', 'vlog', 'gaming', 'cryptocurrency', 'finance', 'food', 'sports', 'science',
];

const INTEREST_TAGS = [...new Set([
  ...TAGS_V2_CATEGORIES,
  ...TAGS_V2_TOPICS,
  ...VIEWER_EXTRA_TAGS,
  ...LEGACY_INTEREST_TAGS,
])];

const INTEREST_TAG_SET = new Set(INTEREST_TAGS);

/** Normalize + validate a viewer-supplied tag. Returns the canonical tag or null. */
function normalizeInterestTag(raw) {
  const t = String(raw || '').trim().toLowerCase().replace(/^#/, '');
  return INTEREST_TAG_SET.has(t) ? t : null;
}

module.exports = {
  INTEREST_TAGS,
  INTEREST_TAG_SET,
  normalizeInterestTag,
  TAGS_V2_TREE,
  TAGS_V2_CATEGORIES,
  TAGS_V2_TOPICS,
  LEGACY_INTEREST_TAGS,
  expandTag,
  isCategoryTag,
};
