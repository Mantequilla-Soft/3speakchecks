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

  const cid = extractCid(doc);
  if (!cid) return { banned: false, reason: 'no-cid' };

  const { gone, results } = await verifyGone(cid);
  if (!gone) return { banned: false, reason: 'still-reachable', results };

  if (!ENABLE_MONGO_WRITES) return { banned: false, reason: 'writes-disabled', results };

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
        cid,
        source: coll === embeds ? 'embed' : 'legacy',
        reportedBy: reportedBy || null,
        reportedUrl: reportedUrl || null,
        gateways: results,
        checkedAt: now,
      },
    },
    { upsert: true },
  );

  // The precomputed pools are rebuilt on a cron, so a banned video would otherwise
  // keep surfacing from them until the next rebuild. Evict it now.
  const evict = { $or: [{ owner, permlink }, { owner, assetPermlink: permlink }] };
  await Promise.all([
    db.collection('discover-pool').deleteMany(evict).catch(() => {}),
    db.collection('interest-pool').deleteMany(evict).catch(() => {}),
  ]);

  return { banned: true, reason: 'confirmed-gone', cid, results };
}

/** How many videos are currently shadow-banned (for /video/unavailable-stats). */
async function unavailableCount() {
  const db = await getDb();
  return db.collection(UNAVAILABLE_COLLECTION).countDocuments();
}

module.exports = {
  UNAVAILABLE_COLLECTION,
  unavailableMatch,
  confirmAndBan,
  verifyGone,
  extractCid,
  unavailableCount,
  GATEWAYS,
};
