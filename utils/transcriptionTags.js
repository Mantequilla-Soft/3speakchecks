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
 * The same pipeline also writes `ai_generated_v2`, surfaced here as `aiGenerated`.
 * The watch page and the shorts panel draw a small AI badge off it.
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
  // AI-generation detection, written by the same pipeline (backfill started
  // 2026-09-23). Three states, and they are not the same thing: true = detected,
  // false = looked at and not detected, absent = never looked at. Only an
  // explicit `true` earns the badge.
  ai_generated_v2: 1,
  ai_generated_evidence_v2: 1,
  ai_generated_checked_at: 1,
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
  // --- AI-generation detection (additive) ---
  // Strict `=== true`: a row the detector has not reached yet must not read as
  // "not AI", and must never read as AI either.
  aiGenerated: doc?.ai_generated_v2 === true,
  aiGeneratedEvidence: Array.isArray(doc?.ai_generated_evidence_v2) ? doc.ai_generated_evidence_v2 : [],
  aiGeneratedCheckedAt: doc?.ai_generated_checked_at || null,
});

/**
 * @returns {Promise<{tags:string[], assetPermlink:string|null, resolvedVia:'direct'|'embed'|'none',
 *   taggedAt:Date|null, tagsV2:string[], tagModelV2:string|null, taggedV2At:Date|null,
 *   unavailableOnTagging:boolean, aiGenerated:boolean, aiGeneratedEvidence:string[],
 *   aiGeneratedCheckedAt:Date|null}>}
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

/**
 * Batch v2 tags for many videos at once — for feed payloads, where a per-video
 * lookup would be one query per card. Keys are owner + ASSET permlink (how
 * `subtitles-tags` is keyed), same as the single-video resolver above.
 *
 * @param {Array<{author:string, permlink:string}>} keys
 * @returns {Promise<Map<string, string[]>>} "author/permlink" -> ordered v2 slugs
 */
async function fetchTagsV2Batch(db, keys) {
  const map = new Map();
  const orConds = [];
  const seen = new Set();
  for (const k of keys || []) {
    if (!k || !k.author || !k.permlink) continue;
    const author = String(k.author).trim().toLowerCase();
    const id = `${author}/${k.permlink}`;
    if (seen.has(id)) continue;
    seen.add(id);
    orConds.push({ author, permlink: k.permlink });
  }
  if (!orConds.length) return map;
  const docs = await db.collection('subtitles-tags')
    .find({ $or: orConds }, { projection: { author: 1, permlink: 1, tags_list_v2: 1, tags_v2: 1 } })
    .toArray();
  for (const d of docs) {
    const list = v2List(d);
    if (list.length) map.set(`${String(d.author).toLowerCase()}/${d.permlink}`, list);
  }
  return map;
}

/**
 * Which of these videos the pipeline flagged as AI-generated — for feed cards,
 * which address a video by EITHER pair: the hive author/permlink (most feeds) or
 * the owner + ASSET permlink (shorts rails). So each key is tried both ways: as a
 * direct `subtitles-tags` key, and through `embed-video`'s hive→asset mapping.
 * Two queries for the whole batch, whatever its size.
 *
 * Only an explicit `ai_generated_v2: true` counts (never-checked rows are absent).
 *
 * @param {Array<{author:string, permlink:string}>} keys
 * @returns {Promise<string[]>} the flagged keys, as "author/permlink" in the
 *   caller's own spelling (author lowercased)
 */
async function fetchAiFlagsBatch(db, keys) {
  const wanted = new Map(); // "author/permlink" -> {author, permlink}
  for (const k of keys || []) {
    if (!k || !k.author || !k.permlink) continue;
    const author = String(k.author).trim().toLowerCase().replace(/^@/, '');
    const permlink = String(k.permlink).trim();
    if (author && permlink) wanted.set(`${author}/${permlink}`, { author, permlink });
  }
  if (!wanted.size) return [];
  const pairs = [...wanted.values()];

  // hive pair -> asset pair, for embed videos.
  const evs = await db.collection('embed-video')
    .find(
      { $or: pairs.map((p) => ({ hive_author: p.author, hive_permlink: p.permlink })) },
      { projection: { owner: 1, permlink: 1, hive_author: 1, hive_permlink: 1 } }
    )
    .toArray();
  const assetToCaller = new Map(); // "owner/asset" -> [caller keys]
  const link = (asset, caller) => {
    const list = assetToCaller.get(asset) || [];
    if (!list.includes(caller)) list.push(caller);
    assetToCaller.set(asset, list);
  };
  for (const id of wanted.keys()) link(id, id);
  for (const ev of evs) {
    if (!ev.owner || !ev.permlink) continue;
    link(`${String(ev.owner).toLowerCase()}/${ev.permlink}`, `${String(ev.hive_author).toLowerCase()}/${ev.hive_permlink}`);
  }

  const orConds = [...assetToCaller.keys()].map((id) => {
    const i = id.indexOf('/');
    return { author: id.slice(0, i), permlink: id.slice(i + 1) };
  });
  const docs = await db.collection('subtitles-tags')
    .find({ $or: orConds, ai_generated_v2: true }, { projection: { author: 1, permlink: 1 } })
    .toArray();

  const out = new Set();
  for (const d of docs) {
    for (const caller of assetToCaller.get(`${String(d.author).toLowerCase()}/${d.permlink}`) || []) {
      if (wanted.has(caller)) out.add(caller);
    }
  }
  return [...out];
}

module.exports = { getTranscriptionTags, splitTags, fetchTagsV2Batch, fetchAiFlagsBatch };
