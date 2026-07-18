/**
 * Resolve the transcription pipeline's auto-tags for a video.
 *
 * `subtitles-tags` is keyed by owner + ASSET permlink, but callers address videos
 * by their HIVE permlink. For legacy videos those are identical; for embed videos
 * they are NOT, so we resolve hive → asset via `embed-video` before giving up.
 *
 * Shared by GET /transcription-tags and the viewer-tag consensus endpoint.
 *
 * v2 tags (`tags_list_v2`) are the NEW closed-vocabulary taxonomy (7 categories +
 * 27 topics) written by the background tagger. They live alongside the v1 `tags`
 * and are returned additively as `tagsV2` — v1 consumers are untouched.
 *
 * NOTE: `subtitles-tags.tags_v2` (a comma STRING of v2 slugs) is a different field
 * from the `tags_v2` ARRAY on video/embed-video docs (lowercased Hive tags). Same
 * name, different collections, different meaning — don't mix them up.
 */
const splitTags = (raw) => String(raw || '')
  .split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);

// v2 list: prefer the array, fall back to the comma string. An EMPTY array means
// "analysed, nothing confident"; a missing field means "not processed yet" — both
// surface as an empty list, distinguished by `tagModelV2` being null.
const v2List = (doc) => (
  Array.isArray(doc?.tags_list_v2)
    ? doc.tags_list_v2.map((t) => String(t || '').trim().toLowerCase()).filter(Boolean)
    : splitTags(doc?.tags_v2)
);

const V2_PROJECTION = {
  tags: 1,
  created_at: 1,
  tags_list_v2: 1,
  tags_v2: 1,
  tag_model_v2: 1,
  tagged_v2_at: 1,
  unavailableOnTagging: 1,
};

const shape = (doc, assetPermlink, resolvedVia) => ({
  tags: doc ? splitTags(doc.tags) : [],
  assetPermlink,
  resolvedVia,
  taggedAt: doc?.created_at || null,
  // --- v2 (additive) ---
  tagsV2: doc ? v2List(doc) : [],
  tagModelV2: doc?.tag_model_v2 || null,
  taggedV2At: doc?.tagged_v2_at || null,
  unavailableOnTagging: doc?.unavailableOnTagging === true,
});

/**
 * @returns {Promise<{tags:string[], assetPermlink:string|null, resolvedVia:'direct'|'embed'|'none',
 *   taggedAt:Date|null, tagsV2:string[], tagModelV2:string|null, taggedV2At:Date|null,
 *   unavailableOnTagging:boolean}>}
 */
async function getTranscriptionTags(db, authorRaw, permlinkRaw) {
  const author = String(authorRaw || '').trim().toLowerCase().replace(/^@/, '');
  const permlink = String(permlinkRaw || '').trim();
  const empty = shape(null, null, 'none');
  if (!author || !permlink) return empty;

  const coll = db.collection('subtitles-tags');

  // 1. Direct hit — legacy videos, whose permlink IS the asset id.
  let doc = await coll.findOne({ author, permlink }, { projection: V2_PROJECTION });
  if (doc) return shape(doc, permlink, 'direct');

  // 2. Embed video — map the hive permlink to its asset permlink.
  const ev = await db.collection('embed-video').findOne(
    { hive_author: author, hive_permlink: permlink },
    { projection: { owner: 1, permlink: 1 } }
  );
  if (ev) {
    doc = await coll.findOne({ author: ev.owner, permlink: ev.permlink }, { projection: V2_PROJECTION });
    return shape(doc, ev.permlink, 'embed');
  }

  return empty; // not transcribed (yet)
}

module.exports = { getTranscriptionTags, splitTags };
