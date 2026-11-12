/**
 * The Buttercloud S3 archive (snapievideoplayer issue #54).
 *
 * The hotnode archiver copies a video's whole CID folder into ONE public S3 bucket
 * and writes three fields on its `embed-video` / `videos` doc:
 *   - `storage_state`: `hot` (still on the hotnode, S3 copy as backup), `archived`
 *     (off the hotnode, so possibly gone from IPFS entirely) or `promoting`
 *     (on its way back to the hotnode, not there yet)
 *   - `s3_url`: `https://<S3 host>/<bucket>/<cid>/manifest.m3u8`
 *   - `s3_migrated_at`, `s3_files`, ... (bookkeeping, unused here)
 *
 * The bucket is served by a Bunny zone (S3_CDN_HOST) and straight from s3.3speak.tv
 * when Bunny is down or out of credit. Both send CORS.
 *
 * These are the player's rules (snapievideoplayer hlsGateways.js s3Parts and
 * server.js storagePlan), kept the same here, so the checker and the player agree
 * on which videos have a usable S3 copy. The bucket is checked as well as the host:
 * S3 paths are names, not hashes, so another bucket on s3.3speak.tv could hold
 * anything under a CID's name. S3_BUCKET unset accepts the bucket the doc names,
 * which only ever comes from the archiver.
 */

const S3_DIRECT_HOST = 's3.3speak.tv';
const S3_CDN_HOST = (process.env.S3_CDN_HOST || 'buttercloud.b-cdn.net').trim().toLowerCase();
const S3_HOSTS = [S3_CDN_HOST, S3_DIRECT_HOST];

const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,62}$/;
const S3_BUCKET = (() => {
  const bucket = (process.env.S3_BUCKET || '').trim();
  if (!bucket) return '';
  if (!BUCKET_RE.test(bucket)) {
    console.warn(`[storage] S3_BUCKET "${bucket}" is not a bucket name: ignored, any bucket on our S3 hosts is accepted`);
    return '';
  }
  return bucket;
})();

const S3_STATES = ['hot', 'archived', 'promoting'];
// Not on the hotnode: IPFS may no longer have it, the S3 copy is THE copy.
const OFF_HOTNODE_STATES = ['archived', 'promoting'];

/**
 * `{ host, bucket, cid, cidPath }` for `https://<S3 host>/<bucket>/<cid>/<file>`,
 * else null. Read from the parsed URL, so `..` cannot climb out of the bucket.
 */
function s3Parts(url) {
  let u;
  try { u = new URL(String(url || '')); } catch (_) { return null; }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || u.port || u.username || u.password) return null;
  if (!S3_HOSTS.includes(host)) return null;
  const m = u.pathname.match(/^\/([^/]+)\/(([^/]+)\/.+)$/);
  if (!m) return null;
  const [, bucket, cidPath, cid] = m;
  if (!BUCKET_RE.test(bucket)) return null;
  if (S3_BUCKET && bucket !== S3_BUCKET) return null;
  return { host, bucket, cid, cidPath };
}

const isS3Url = (url) => !!s3Parts(url);

/**
 * The doc's S3 copy, `{ bucket, cid }`, or null when it has none we can use: no
 * or unknown `storage_state`, an `s3_url` outside our hosts or bucket, or one for
 * another CID than the doc plays (`cid`, when given).
 */
function s3CopyOf(doc, cid = null) {
  if (!doc || !S3_STATES.includes(doc.storage_state)) return null;
  const p = s3Parts(doc.s3_url);
  if (!p) return null;
  if (cid && p.cid !== String(cid)) return null;
  return { bucket: p.bucket, cid: p.cid };
}

/** True when the doc says the video left the hotnode, so IPFS may not have it. */
const isOffHotnode = (doc) => !!doc && OFF_HOTNODE_STATES.includes(doc.storage_state);

/** `file` (a path inside the CID folder) on each S3 host, the Bunny zone first. */
function s3UrlsFor(copy, file = 'manifest.m3u8') {
  if (!copy) return [];
  return S3_HOSTS.map((h) => `https://${h}/${copy.bucket}/${copy.cid}/${file}`);
}

/** The same object on the other S3 host, or [] for a URL that is not in the bucket. */
function s3Siblings(url) {
  const p = s3Parts(url);
  if (!p) return [];
  const u = new URL(url);
  return S3_HOSTS.filter((h) => h !== p.host).map((h) => {
    const alt = new URL(u.href);
    alt.hostname = h;
    return alt.href;
  });
}

/** Do these two URLs name the same CID folder of the same bucket? */
function sameS3Folder(a, b) {
  const x = s3Parts(a);
  const y = s3Parts(b);
  return !!(x && y && x.bucket === y.bucket && x.cid === y.cid);
}

/** Mongo projection fields the helpers above read. */
const S3_PROJECTION = { storage_state: 1, s3_url: 1 };

module.exports = {
  S3_BUCKET,
  S3_CDN_HOST,
  S3_DIRECT_HOST,
  S3_HOSTS,
  S3_PROJECTION,
  s3Parts,
  isS3Url,
  s3CopyOf,
  isOffHotnode,
  s3UrlsFor,
  s3Siblings,
  sameS3Folder,
};
