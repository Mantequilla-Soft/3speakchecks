/**
 * An outside podcast episode that is really 3Speak audio: its link names the
 * 3Speak post (a 3Speak RSS feed followed as a podcast, routes/rss.js, or any feed
 * linking the post). 3speak.tv reads owner + HIVE permlink from that link (the same
 * check that gives the episode votes and comments) and sends them; this finds the
 * creator's own track behind the post, so listening and ads count for it like when
 * it plays on 3Speak.
 */
const ID_RE = /^[a-z0-9._-]+$/i;

/** The embed-audio permlink behind owner/postPermlink, or null (no such audio, not this owner's, bad input). */
async function linkedAudioPermlink(db, owner, postPermlink) {
  const o = typeof owner === 'string' ? owner.trim().toLowerCase().slice(0, 32) : '';
  const p = typeof postPermlink === 'string' ? postPermlink.trim().slice(0, 255) : '';
  if (!ID_RE.test(o) || !ID_RE.test(p)) return null;
  const row = await db.collection('embed-audio').findOne(
    // A few rows store "author/permlink" (see routes/rss.js fromAudio).
    { owner: o, post_permlink: { $in: [p, `${o}/${p}`] } },
    { projection: { permlink: 1, status: 1 } },
  );
  if (!row || !row.permlink || (row.status && row.status !== 'published')) return null;
  return String(row.permlink);
}

module.exports = { linkedAudioPermlink, ID_RE };
