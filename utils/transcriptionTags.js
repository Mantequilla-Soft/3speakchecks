/**
 * Resolve the transcription pipeline's auto-tags for a video.
 *
 * `subtitles-tags` is keyed by owner + ASSET permlink, but callers address videos
 * by their HIVE permlink. For legacy videos those are identical; for embed videos
 * they are NOT, so we resolve hive → asset via `embed-video` before giving up.
 *
 * Shared by GET /transcription-tags and the viewer-tag consensus endpoint.
 */
const splitTags = (raw) => String(raw || '')
  .split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);

/**
 * @returns {Promise<{tags:string[], assetPermlink:string|null, resolvedVia:'direct'|'embed'|'none', taggedAt:Date|null}>}
 */
async function getTranscriptionTags(db, authorRaw, permlinkRaw) {
  const author = String(authorRaw || '').trim().toLowerCase().replace(/^@/, '');
  const permlink = String(permlinkRaw || '').trim();
  const empty = { tags: [], assetPermlink: null, resolvedVia: 'none', taggedAt: null };
  if (!author || !permlink) return empty;

  const coll = db.collection('subtitles-tags');

  // 1. Direct hit — legacy videos, whose permlink IS the asset id.
  let doc = await coll.findOne({ author, permlink }, { projection: { tags: 1, created_at: 1 } });
  if (doc) {
    return { tags: splitTags(doc.tags), assetPermlink: permlink, resolvedVia: 'direct', taggedAt: doc.created_at || null };
  }

  // 2. Embed video — map the hive permlink to its asset permlink.
  const ev = await db.collection('embed-video').findOne(
    { hive_author: author, hive_permlink: permlink },
    { projection: { owner: 1, permlink: 1 } }
  );
  if (ev) {
    doc = await coll.findOne({ author: ev.owner, permlink: ev.permlink }, { projection: { tags: 1, created_at: 1 } });
    return {
      tags: doc ? splitTags(doc.tags) : [],
      assetPermlink: ev.permlink,
      resolvedVia: 'embed',
      taggedAt: doc?.created_at || null,
    };
  }

  return empty; // not transcribed (yet)
}

module.exports = { getTranscriptionTags, splitTags };
