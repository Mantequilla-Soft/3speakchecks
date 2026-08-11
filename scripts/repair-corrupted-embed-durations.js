/**
 * Repair `embed-video.duration` values corrupted by the player's duration
 * self-heal (preview-player's /api/duration → db.js updateEmbedDuration).
 *
 * Root cause: under HLS/MSE the player could read player.duration() before
 * the manifest was reconciled and get only the buffered-so-far segment span
 * (typically ~6s — the first segment). main.js's self-heal then POSTed that
 * to /api/duration, which wrote it STRAIGHT onto the authoritative
 * embed-video.duration with no validation. Unlike the view-durations /
 * view-heatmaps damage, this corrupts the video's real length everywhere it
 * is shown — duration badges on cards, feeds, search — not just analytics.
 * (A server-side guard now refuses shrinking writes; this repairs the
 * damage already done.)
 *
 * Recovery source, in priority order:
 *   1. The video's own HLS manifest — sum of #EXTINF segment durations. This
 *      is AUTHORITATIVE (it is the real media timeline), not an estimate.
 *   2. Nothing. If the manifest can't be fetched/parsed the doc is left
 *      alone and reported, rather than guessed at — a wrong duration written
 *      over another wrong duration helps nobody.
 *
 * Detection: stored duration is small (<=60s) AND at least one recorded
 * watch session for that video accumulated far more wall-clock time than the
 * stored duration claims (>2x). A genuinely short video can't have sessions
 * consistently watching many multiples of its length.
 *
 * Safe to run multiple times — a repaired doc no longer matches the filter.
 *
 * Usage:
 *   node repair-corrupted-embed-durations.js --dry-run
 *   node repair-corrupted-embed-durations.js --owner=X --permlink=Y [--dry-run]
 *   node repair-corrupted-embed-durations.js
 */
const path = require('path');
const { MongoClient } = require('mongodb');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const MONGODB_URI = process.env.MONGODB_URI;
const DATABASE_NAME = process.env.DATABASE_NAME || 'threespeak';
const WATCH_LOG = process.env.WATCH_LOG_COLLECTION || 'view-durations';
const GATEWAYS = [
  'https://hotipfs-3speak-1.b-cdn.net/ipfs',
  'https://ipfs.3speak.tv/ipfs',
];
const FETCH_TIMEOUT_MS = 15000;

const DRY_RUN = process.argv.includes('--dry-run');
const argOwner = process.argv.find((a) => a.startsWith('--owner='));
const argPermlink = process.argv.find((a) => a.startsWith('--permlink='));
const SCOPE_OWNER = argOwner ? argOwner.split('=')[1] : null;
const SCOPE_PERMLINK = argPermlink ? argPermlink.split('=')[1] : null;

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function sumExtinf(text) {
  const durs = [...text.matchAll(/#EXTINF:\s*([0-9.]+)/g)].map((m) => parseFloat(m[1]));
  if (!durs.length) return null;
  const total = durs.reduce((a, b) => a + b, 0);
  return Number.isFinite(total) && total > 0 ? total : null;
}

/** True duration from the HLS manifest: master → variant playlist → Σ EXTINF. */
async function durationFromManifest(manifestCid) {
  if (!manifestCid) return null;
  for (const base of GATEWAYS) {
    const master = await fetchText(`${base}/${manifestCid}/manifest.m3u8`);
    if (!master) continue;

    // A master playlist lists variant playlists; a media playlist has EXTINFs directly.
    const direct = sumExtinf(master);
    if (direct) return direct;

    const variant = master.split('\n').map((l) => l.trim())
      .find((l) => l && !l.startsWith('#') && l.endsWith('.m3u8'));
    if (!variant) continue;

    const media = await fetchText(`${base}/${manifestCid}/${variant}`);
    if (!media) continue;
    const total = sumExtinf(media);
    if (total) return total;
  }
  return null;
}

async function run() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(DATABASE_NAME);
  const embeds = db.collection('embed-video');

  try {
    console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'APPLY'}`);
    if (SCOPE_OWNER) console.log(`Scoped to: ${SCOPE_OWNER}/${SCOPE_PERMLINK || '*'}`);

    // Videos whose stored duration is implausibly small next to how long
    // people actually watched them.
    const match = {};
    if (SCOPE_OWNER) match.owner = SCOPE_OWNER;
    if (SCOPE_PERMLINK) match.permlink = SCOPE_PERMLINK;

    const suspects = await db.collection(WATCH_LOG).aggregate([
      ...(Object.keys(match).length ? [{ $match: match }] : []),
      { $group: { _id: { owner: '$owner', permlink: '$permlink' }, maxWatched: { $max: '$watchedSeconds' } } },
      { $match: { maxWatched: { $gt: 60 } } },
      { $lookup: { from: 'embed-video', let: { o: '$_id.owner', p: '$_id.permlink' },
          pipeline: [
            { $match: { $expr: { $and: [ { $eq: ['$owner', '$$o'] },
                { $or: [ { $eq: ['$permlink', '$$p'] }, { $eq: ['$hive_permlink', '$$p'] } ] } ] } } },
            { $project: { duration: 1, manifest_cid: 1, permlink: 1 } },
            { $limit: 1 },
          ], as: 'ev' } },
      { $addFields: { ev: { $arrayElemAt: ['$ev', 0] } } },
      { $match: { 'ev.duration': { $gt: 0, $lte: 60 },
          $expr: { $lt: ['$ev.duration', { $multiply: ['$maxWatched', 0.5] }] } } },
    ], { allowDiskUse: true }).toArray();

    console.log(`Videos with an implausibly short STORED duration: ${suspects.length}`);
    if (!suspects.length) { await client.close(); return; }

    let repaired = 0;
    let unresolved = 0;

    for (const s of suspects) {
      const { owner, permlink } = s._id;
      const stored = s.ev?.duration;
      const real = await durationFromManifest(s.ev?.manifest_cid);

      if (!real) {
        unresolved++;
        console.log(`  ${owner}/${permlink}: stored=${stored}s maxWatched=${s.maxWatched}s → NO MANIFEST, skipped`);
        continue;
      }
      const rounded = Math.round(real);
      // Only act if the manifest actually disagrees with what's stored.
      if (rounded <= stored) {
        console.log(`  ${owner}/${permlink}: manifest agrees (${rounded}s) — leaving alone`);
        continue;
      }

      repaired++;
      console.log(`  ${owner}/${permlink}: stored=${stored}s → manifest=${rounded}s (maxWatched=${s.maxWatched}s) ${DRY_RUN ? 'WOULD FIX' : 'fixing'}`);
      if (!DRY_RUN) {
        await embeds.updateOne({ _id: s.ev._id }, { $set: { duration: rounded } });
      }
    }

    console.log(`Repaired: ${repaired}`);
    console.log(`Unresolved (no usable manifest): ${unresolved}`);
    if (DRY_RUN) console.log('Dry run only — no writes made. Re-run without --dry-run to apply.');
  } finally {
    await client.close();
  }
}

run().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
