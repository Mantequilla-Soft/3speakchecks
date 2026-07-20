/**
 * Attach the display topic (`tag_v2`) to a batch of video objects.
 *
 * Two sources, in priority order:
 *   1. VIEWER tags — what people who watched the video picked. Heaviest combined
 *      vote weight wins; a human beats a model that read the transcript.
 *   2. AUTO tags — the background tagger's `tags_list_v2`, best-first.
 *
 * They key off DIFFERENT ids: `subtitles-tags` is keyed by owner + ASSET
 * permlink, `viewer-tags` by the HIVE author + permlink — hence the two key
 * functions rather than one.
 *
 * Only slugs in the v2 tree may win: viewer tags can still carry retired v1
 * values (e.g. `tutorial`) from the deployed prod frontend, and those have no
 * category for the UI to roll up to.
 *
 * Decorative by design — a failure here must never take a feed down, so it
 * logs and leaves the items untouched.
 */
const { fetchTagsV2Batch } = require('./transcriptionTags');
const { fetchViewerWeights } = require('./effectiveTags');
const { TAGS_V2_TREE } = require('./interestTags');

const V2_SLUGS = new Set([
  ...Object.keys(TAGS_V2_TREE),
  ...Object.values(TAGS_V2_TREE).flat(),
]);

const lc = (s) => String(s || '').trim().toLowerCase().replace(/^@/, '');

/**
 * @param db                 mongo db handle
 * @param {Array<object>} items  mutated in place
 * @param {(v)=>({author,permlink})|null} autoKeyFn  owner + ASSET permlink
 * @param {(v)=>({author,permlink})|null} hiveKeyFn  hive author + hive permlink
 */
async function attachTopicTags(db, items, autoKeyFn, hiveKeyFn) {
  if (!Array.isArray(items) || !items.length) return items;
  try {
    const autoKeys = items.map(autoKeyFn).filter((k) => k && k.author && k.permlink);
    const hiveKeys = items.map(hiveKeyFn).filter((k) => k && k.author && k.permlink);

    const [tagMap, viewerMap] = await Promise.all([
      fetchTagsV2Batch(db, autoKeys),
      fetchViewerWeights(db, hiveKeys),
    ]);

    for (const v of items) {
      const a = autoKeyFn(v);
      const list = a && tagMap.get(`${lc(a.author)}/${a.permlink}`);
      if (list && list.length) {
        v.tags_v2_auto = list;   // ordered, best-first
        v.tag_v2 = list[0];
        v.tag_v2_source = 'auto';
      }

      const h = hiveKeyFn(v);
      const weights = h && viewerMap.get(`${lc(h.author)}/${h.permlink}`);
      if (weights) {
        // Ties break by name so the choice is stable across requests.
        const winner = Object.entries(weights)
          .filter(([tag]) => V2_SLUGS.has(tag))
          .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0];
        if (winner) {
          v.tag_v2 = winner[0];
          v.tag_v2_source = 'viewer';
        }
      }
    }
  } catch (err) {
    console.error('attachTopicTags failed:', err && err.message);
  }
  return items;
}

module.exports = { attachTopicTags, V2_SLUGS };
