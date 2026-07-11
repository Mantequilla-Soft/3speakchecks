/**
 * Canonical interest taxonomy — the ONLY tags a viewer may assign via the vote
 * dialog. Mirrors the frontend's INTERESTS list (src/utils/interests.js) and the
 * distinct set the transcription pipeline emits into `subtitles-tags` (minus the
 * `general` catch-all). Keep the three in sync.
 */
const INTEREST_TAGS = [
  'news', 'travel', 'health', 'technology', 'art', 'music', 'tutorial', 'nature',
  'education', 'vlog', 'gaming', 'cryptocurrency', 'finance', 'food', 'sports', 'science',
];

const INTEREST_TAG_SET = new Set(INTEREST_TAGS);

/** Normalize + validate a viewer-supplied tag. Returns the canonical tag or null. */
function normalizeInterestTag(raw) {
  const t = String(raw || '').trim().toLowerCase().replace(/^#/, '');
  return INTEREST_TAG_SET.has(t) ? t : null;
}

module.exports = { INTEREST_TAGS, INTEREST_TAG_SET, normalizeInterestTag };
