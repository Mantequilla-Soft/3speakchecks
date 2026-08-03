/**
 * Shadow-ban for videos whose media is GONE.
 *
 * A dead video is worse than no video: it fills a feed slot with a card that plays
 * nothing. When the frontend gets a hard 404 loading a video's HLS manifest, it
 * reports it here and — if we can confirm it — the video is dropped from every feed
 * permanently. The video itself is untouched: the Hive post still exists, the watch
 * page still resolves. It just stops being *recommended*.
 *
 * ── The trap this is built around ────────────────────────────────────────────────
 * A 404 from ONE gateway does NOT mean the video is gone. 3Speak migrates content
 * off the hot IPFS zone (`hotipfs-3speak-1`) to colder storage after a while, so a
 * perfectly healthy old video 404s there while still being served fine by
 * `ipfs.3speak.tv`. Banning on a single-gateway 404 would quietly delete good videos
 * from the feeds forever, and nobody would notice until the archive was gutted.
 *
 * So a client report is a HINT, never a verdict:
 *   - the server re-checks the manifest ITSELF, across EVERY known gateway;
 *   - it bans only when EVERY gateway returns a definite 404;
 *   - a timeout, a 5xx or a connection error is NOT evidence of absence — the
 *     gateway being down is not the video being gone — so those abort the ban.
 * That also means a malicious client can't ban other people's videos: the worst it
 * can do is make us re-check a healthy video and conclude it's fine.
 */
const { getDb } = require('./db');
const { ENABLE_MONGO_WRITES } = require('./config');

const UNAVAILABLE_COLLECTION = 'video-unavailable';

// A PUBLISHED upload at least this old has certainly finished encoding, so "no
// manifest CID" means its stream is permanently gone / never migrated — not "still
// processing". Deliberately very generous (5 months) so only the ancient pre-video_v2
// archive is ever touched. Only such settled videos are shadow-banned for having no
// stream; uploaded/encoding/pinning docs are never status:'published', so safe too.
const NO_CID_MIN_AGE_MS = Math.max(0, Number(process.env.UNAVAILABLE_NOCID_MIN_AGE_DAYS || 150)) * 24 * 60 * 60 * 1000;

/**
 * Mongo condition to spread into a feed query, exactly like feedAgeMatch:
 *   { status: 'published', ...feedAgeMatch('created'), ...unavailableMatch() }
 * `$ne: true` (not `false`) so the overwhelming majority of docs — which have no
 * such field at all — still match.
 */
function unavailableMatch() {
  return { unavailable: { $ne: true } };
}

// Every gateway that can serve a 3Speak manifest. If ANY of these can still produce
// the file, the video is alive and must not be banned.
const GATEWAYS = [
  'https://ipfs-3speak.b-cdn.net',
  'https://hotipfs-3speak-1.b-cdn.net',
  'https://ipfs.3speak.tv',
];

const CHECK_TIMEOUT_MS = 8000;

/** Pull the bare CID out of whatever shape the doc stores. */
function extractCid(doc) {
  if (!doc) return null;
  if (doc.manifest_cid) return String(doc.manifest_cid);            // embed-video
  const v2 = String(doc.video_v2 || '');                            // legacy: ipfs://<cid>/manifest.m3u8
  const m = v2.match(/^ipfs:\/\/([^/]+)/i) || v2.match(/\/ipfs\/([^/]+)/i);
  return m ? m[1] : null;
}

/**
 * Ask one gateway whether the manifest is there.
 * Returns 'gone' (definite 404), 'alive' (2xx), or 'unknown' (anything else —
 * 5xx, timeout, DNS, TLS). 'unknown' must never be treated as 'gone'.
 */
async function probe(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), CHECK_TIMEOUT_MS);
  try {
    const r = await fetch(url, { method: 'GET', signal: ctl.signal, redirect: 'follow' });
    if (r.status === 404 || r.status === 410) return 'gone';
    if (r.ok) return 'alive';
    return 'unknown';
  } catch {
    return 'unknown';    // gateway down / aborted — proves nothing
  } finally {
    clearTimeout(t);
  }
}

/**
 * Verify across every gateway. Bans only on unanimous, definite 404s.
 * Checks the master manifest AND the 480p rendition: some old uploads only ever had
 * renditions, so a missing master alone isn't proof.
 */
async function verifyGone(cid) {
  const paths = [`/ipfs/${cid}/manifest.m3u8`, `/ipfs/${cid}/480p/index.m3u8`];
  const results = [];

  for (const host of GATEWAYS) {
    let hostVerdict = 'gone';
    for (const p of paths) {
      const v = await probe(`${host}${p}`);
      if (v === 'alive') { hostVerdict = 'alive'; break; }          // one live path is enough
      if (v === 'unknown') hostVerdict = 'unknown';                 // inconclusive, keep looking
    }
    results.push({ host, verdict: hostVerdict });
    // Short-circuit the moment anything says the content is reachable or uncertain.
    if (hostVerdict !== 'gone') return { gone: false, results };
  }

  return { gone: results.every((r) => r.verdict === 'gone'), results };
}

/**
 * Confirm-and-ban. `key` is { owner, permlink } as stored on the source doc.
 * Returns { banned, reason, results }.
 */
async function confirmAndBan(db, { owner, permlink, reportedBy, reportedUrl }) {
  const embeds = db.collection('embed-video');
  const legacy = db.collection('videos');

  // The doc is the source of truth for the CID — NOT the URL the client sent. A
  // client-supplied URL would let anyone point us at a 404 and ban an unrelated video.
  let doc = await embeds.findOne({ owner, permlink });
  let coll = embeds;
  if (!doc) {
    doc = await embeds.findOne({ owner, hive_permlink: permlink });
  }
  if (!doc) {
    doc = await legacy.findOne({ owner, permlink });
    coll = legacy;
  }
  if (!doc) return { banned: false, reason: 'unknown-video' };
  if (doc.unavailable === true) return { banned: true, reason: 'already-banned' };

  const source = coll === embeds ? 'embed' : 'legacy';
  const cid = extractCid(doc);

  // No manifest CID at all → no playable stream, EVER. For a settled published upload
  // that's a permanent dead end (old pre-video_v2/IPFS archive, or lost encode output)
  // — hide it from feeds exactly like a confirmed-gone one. Guarded hard so a still-
  // processing upload can't be caught: it must be status:'published' AND old enough
  // (NO_CID_MIN_AGE_MS) that encoding is certainly finished. verifyGone would have
  // nothing to fetch here, so we decide from our own doc.
  if (!cid) {
    const createdMs = doc.created ? new Date(doc.created).getTime() : 0;
    const oldEnough = createdMs > 0 && (Date.now() - createdMs) >= NO_CID_MIN_AGE_MS;
    if (doc.status !== 'published' || !oldEnough) return { banned: false, reason: 'no-cid' };
    if (!ENABLE_MONGO_WRITES) return { banned: false, reason: 'writes-disabled' };
    await writeBan(db, coll, doc, { owner, permlink, cid: null, source, reason: 'no-stream', reportedBy, reportedUrl });
    console.log(`[unavailable] shadow-banned ${owner}/${permlink} — no playable stream (published, no manifest CID)`);
    return { banned: true, reason: 'no-stream' };
  }

  const { gone, results } = await verifyGone(cid);
  if (!gone) return { banned: false, reason: 'still-reachable', results };

  if (!ENABLE_MONGO_WRITES) return { banned: false, reason: 'writes-disabled', results };

  await writeBan(db, coll, doc, { owner, permlink, cid, source, reason: 'confirmed-gone', reportedBy, reportedUrl, results });
  return { banned: true, reason: 'confirmed-gone', cid, results };
}

/**
 * Write the shadow-ban: flag the source doc, upsert the audit row, and evict the
 * video from the precomputed pools (rebuilt on a cron, so they'd otherwise keep
 * surfacing it until the next rebuild). Shared by both ban reasons.
 */
async function writeBan(db, coll, doc, { owner, permlink, cid, source, reason, reportedBy, reportedUrl, results }) {
  const now = new Date();
  await coll.updateOne(
    { _id: doc._id },
    { $set: { unavailable: true, unavailableAt: now } },
  );
  await db.collection(UNAVAILABLE_COLLECTION).updateOne(
    { _id: `${owner}/${permlink}` },
    {
      $set: {
        owner,
        permlink,
        cid: cid || null,
        source,
        reason,
        reportedBy: reportedBy || null,
        reportedUrl: reportedUrl || null,
        gateways: results || null,
        checkedAt: now,
      },
    },
    { upsert: true },
  );

  const evict = { $or: [{ owner, permlink }, { owner, assetPermlink: permlink }] };
  await Promise.all([
    db.collection('discover-pool').deleteMany(evict).catch(() => {}),
    db.collection('interest-pool').deleteMany(evict).catch(() => {}),
  ]);
}

/** How many videos are currently shadow-banned (for /video/unavailable-stats). */
async function unavailableCount() {
  const db = await getDb();
  return db.collection(UNAVAILABLE_COLLECTION).countDocuments();
}

/**
 * Reinstate a video after its source file is replaced with a fresh, playable one:
 *   - lift the `unavailable` shadow-ban + drop the audit row (inverse of writeBan);
 *   - flip a `status:'deleted'` doc back to `'published'` so the "Deleted" badge
 *     (Card3 reads `video.status === 'deleted'`) disappears.
 * The `videos`/`embed-video` collections are shared with the embed service, so
 * writing them here is the source of truth. Pools repopulate on their next cron
 * rebuild. Returns whether anything was actually changed.
 */
async function reinstateVideo(db, owner, permlink) {
  const now = new Date();
  const eMatch = { $or: [{ owner, permlink }, { hive_author: owner, hive_permlink: permlink }] };
  const liftBan = { $set: { unavailable: false, reinstatedAt: now }, $unset: { unavailableAt: '' } };
  const undelete = { $set: { status: 'published', reinstatedAt: now } };
  const [v1, e1, v2, e2, a] = await Promise.all([
    db.collection('videos').updateMany({ owner, permlink, unavailable: true }, liftBan),
    db.collection('embed-video').updateMany({ ...eMatch, unavailable: true }, liftBan),
    db.collection('videos').updateMany({ owner, permlink, status: 'deleted' }, undelete),
    db.collection('embed-video').updateMany({ ...eMatch, status: 'deleted' }, undelete),
    db.collection(UNAVAILABLE_COLLECTION).deleteOne({ _id: `${owner}/${permlink}` }),
  ]);
  return (v1.modifiedCount + e1.modifiedCount + v2.modifiedCount + e2.modifiedCount + a.deletedCount) > 0;
}

module.exports = {
  UNAVAILABLE_COLLECTION,
  unavailableMatch,
  confirmAndBan,
  reinstateVideo,
  verifyGone,
  extractCid,
  unavailableCount,
  GATEWAYS,
};
