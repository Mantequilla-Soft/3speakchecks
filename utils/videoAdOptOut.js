/**
 * Per-video ad opt-out: a creator who carries ads in general turns them off on
 * ONE video.
 *
 * The record of the choice is the Hive post itself. The uploader writes
 * `json_metadata["3speak"].ads = false` into the post, which the creator signs as
 * part of publishing it, so nobody has to trust a claim made to this server: the
 * sync route reads the post off the chain and mirrors what it finds, and calling
 * it for someone else's video can only ever copy THEIR choice. No extra wallet
 * prompt, no delegated signature, and an edit of the post's metadata turns ads
 * back on through the same path.
 *
 * The mirror (AD_VIDEO_OPTOUTS_COLLECTION) exists because the serve decision is
 * made per playback and cannot afford an RPC round trip. It is keyed by the EMBED
 * ASSET (`owner/permlink` as the player asks for it), not the Hive permlink: the
 * ad session only ever knows the asset.
 *
 * 🚨 A post may only opt out an asset its own author owns. A remix can reuse
 * somebody else's embed, and without that check a remixer could switch ads off on
 * the original creator's video by publishing a post that points at it.
 */
const { getDb } = require('./db');
const { hiveRpcBatch } = require('./hive');
const { AD_VIDEO_OPTOUTS_COLLECTION } = require('./config');

const META_NS = '3speak';
const ID_RE = /^[a-z0-9._-]+$/i;

const norm = (u) => String(u || '').trim().toLowerCase().replace(/^@/, '');
const keyOf = (owner, permlink) => `${norm(owner)}/${String(permlink || '').trim()}`;

let indexed = false;
async function ensureIndexes() {
  if (indexed) return;
  indexed = true;
  try {
    await getDb().collection(AD_VIDEO_OPTOUTS_COLLECTION).createIndex({ owner: 1 });
  } catch (err) {
    indexed = false;
    console.error('[video-ad-optout] index creation failed:', err && err.message);
  }
}

function parseMeta(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw || '{}') || {}; } catch { return {}; }
}

/**
 * Only a literal `false` is off, same rule as the account-level setting in the
 * frontend's utils/adSettings.js: anything malformed falls back to ads on.
 */
function adsOffIn(meta) {
  const ns = meta && meta[META_NS];
  return !!ns && typeof ns === 'object' && ns.ads === false;
}

/**
 * Which embed asset does this post play? `video.info` is what the uploader writes
 * (and what peakd/ecency read to build the player); a post without it plays an
 * asset under its own name, which is how legacy uploads are keyed.
 */
function assetOf(author, permlink, meta) {
  const info = meta && meta.video && meta.video.info;
  const owner = norm(info && info.author) || norm(author);
  const assetPermlink = String((info && info.permlink) || permlink || '').trim();
  return { owner, permlink: assetPermlink };
}

/**
 * Mirror one post's choice. `meta` is its json_metadata (string or object).
 *
 * Returns `{ owner, permlink, adsEnabled }`, or `{ refused }` when the post points
 * at an asset its author does not own.
 */
async function applyVideoAdFlag(author, hivePermlink, meta) {
  const a = norm(author);
  const parsed = parseMeta(meta);
  const asset = assetOf(a, hivePermlink, parsed);
  if (!ID_RE.test(asset.owner) || !ID_RE.test(asset.permlink)) return { refused: 'bad_asset' };
  if (asset.owner !== a) return { refused: 'not_asset_owner' };

  await ensureIndexes();
  const coll = getDb().collection(AD_VIDEO_OPTOUTS_COLLECTION);
  const _id = keyOf(asset.owner, asset.permlink);

  if (adsOffIn(parsed)) {
    await coll.updateOne(
      { _id },
      { $set: { owner: asset.owner, permlink: asset.permlink, hiveAuthor: a, hivePermlink, updatedAt: new Date() } },
      { upsert: true },
    );
    return { ...asset, adsEnabled: false };
  }
  // No flag means the default, ads on. Deleting rather than writing `true` keeps
  // the collection a list of exceptions, which is all the serve path reads.
  await coll.deleteOne({ _id });
  return { ...asset, adsEnabled: true };
}

/**
 * Read the post from the chain and mirror it. `{ notFound: true }` when the post
 * does not exist (yet): a fresh broadcast takes a block or two to become readable,
 * so the caller is expected to retry on that answer. `null` = the chain could not
 * be read at all.
 */
async function syncVideoAdFlagFromChain(author, hivePermlink) {
  const [res] = await hiveRpcBatch([{
    jsonrpc: '2.0', id: 1, method: 'condenser_api.get_content', params: [norm(author), hivePermlink],
  }]);
  if (!res) return null;
  if (res.error) {
    const raw = JSON.stringify(res.error);
    return /does not exist/i.test(raw) ? { notFound: true } : null;
  }
  const c = res.result;
  // Older nodes answer a missing post with a zeroed stub (author: "").
  if (!c || c.author !== norm(author) || c.permlink !== hivePermlink) return { notFound: true };
  return applyVideoAdFlag(c.author, c.permlink, c.json_metadata);
}

/** Serve path: has this asset been opted out? A point read by _id. */
async function videoOptedOut(owner, permlink) {
  if (!owner || !permlink) return false;
  const doc = await getDb().collection(AD_VIDEO_OPTOUTS_COLLECTION)
    .findOne({ _id: keyOf(owner, permlink) }, { projection: { _id: 1 } });
  return !!doc;
}

module.exports = { applyVideoAdFlag, syncVideoAdFlagFromChain, videoOptedOut, adsOffIn };
