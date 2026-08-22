/**
 * Retention worker — runs in a WORKER THREAD (spawned by services/retention.js)
 * so the heavy aggregation + scoring never blocks the main event loop serving
 * user/feed queries. It has its OWN MongoDB connection (thread-isolated), does the
 * whole compute, writes the RETENTION_COLLECTION, and exits.
 *
 * Pipeline (see algo.md for the plain-English + full version):
 *   1. Aggregate view-durations (recent window, junk sessions dropped) → per-video
 *      { viewers(distinct session id — see the confidence-key note below), sessions,
 *        avgPct, completionRate, hookRate, avgContentSec, duration }.
 *   2. Aggregate view-heatmaps → per-video replayIntensity.
 *   3. rawQuality → Bayesian shrink toward the global mean → length-normalize
 *      within duration band → relQ. Bulk-upsert one doc per video, keyed _id=owner/permlink.
 *   4. Delete docs not refreshed this run (video aged out of the window).
 */
const { parentPort } = require('worker_threads');
const { MongoClient } = require('mongodb');
const {
  MONGODB_URI, DATABASE_NAME,
  RETENTION_COLLECTION, RETENTION_WINDOW_DAYS, RETENTION_MIN_SESSION_SECONDS,
  RETENTION_COMPLETION_PCT, RETENTION_ENGAGED_PCT, RETENTION_HOOK_FRAC,
} = require('../utils/config');
const {
  durationBand, rawQuality, bayesShrink, relativeQuality,
} = require('../utils/retentionScore');

const WATCH_LOG = process.env.WATCH_LOG_COLLECTION || 'view-durations';
const WATCH_HEATMAP = process.env.WATCH_HEATMAP_COLLECTION || 'view-heatmaps';
const EMBED_VIDEO_COLLECTION = 'embed-video';
const LEGACY_VIDEO_COLLECTION = 'videos';

// Statuses where the player does NOT serve the video: it answers with a short
// PLACEHOLDER notice clip ("this video was deleted / is still processing / failed").
// See getVideoSource() in the player's server.js — same status list.
const PLACEHOLDER_STATUSES = new Set([
  'delete', 'deleted', 'self_deleted',
  'encoding_ipfs', 'ipfs_pinning', 'uploaded',
  'encoding_failed', 'failed',
]);

// A player-reported duration read too early (right at 'play', before HLS/VHS
// reconciles the full manifest) can transiently land in `view-durations` as
// only the buffered-so-far segment span — a real production case sent 6s for
// a 120s video this way (fixed at the source in preview-player, but old rows
// already carry the bad number, and any stray future miss stays possible). A
// tracked duration this far below the video's real stored duration is far
// more likely to be that race than a genuinely much-shorter remux.
const DURATION_DISAGREEMENT_RATIO = 0.5; // tracked below 50% of the real duration is untrusted

// replayIntensity from a coverage-bucket array: ~1.0 for a flat "everyone watched
// it once" curve; >1 when some moments stick out (rewatched). max / mean(non-zero).
function replayIntensity(buckets) {
  if (!Array.isArray(buckets)) return 1;
  const nz = buckets.filter((v) => Number(v) > 0);
  if (nz.length < 5) return 1;
  const mean = nz.reduce((a, b) => a + b, 0) / nz.length;
  const max = Math.max(...buckets.map((v) => Number(v) || 0));
  return mean > 0 ? Math.min(5, max / mean) : 1;
}

async function run() {
  const startedAt = Date.now();
  const cutoff = new Date(startedAt - RETENTION_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  // Small pool: this worker runs one sequential aggregation + a heatmap read +
  // chunked bulk writes — it never needs the default 100 connections, and a big
  // burst every 5 min was adding pressure to the shared Mongo (pool saturation →
  // ECONNREFUSED on the main service). Cap it hard.
  const client = new MongoClient(MONGODB_URI, { maxPoolSize: 4, minPoolSize: 0, waitQueueTimeoutMS: 20000 });
  await client.connect();
  const db = client.db(DATABASE_NAME);

  try {
    // ── 1. Per-video watch metrics (the aggregation runs on the Mongo server) ──
    let rows = await db.collection(WATCH_LOG).aggregate([
      // Junk-session filter on the SAME coalesced value used downstream — matching
      // `contentSeconds` alone would silently drop older watchedSeconds-only rows.
      { $match: {
        updatedAt: { $gte: cutoff },
        $expr: { $gte: [{ $ifNull: ['$contentSeconds', { $ifNull: ['$watchedSeconds', 0] }] }, RETENTION_MIN_SESSION_SECONDS] },
      } },
      { $group: {
        _id: { owner: '$owner', permlink: '$permlink' },
        sessions: { $sum: 1 },
        // Confidence key. The GDPR sweep (2026-07-15) removed BOTH `viewerId` and
        // `ip` from this collection — and backfilled them out of history — so those
        // two branches now match nothing and `sid` is the only identifier left. With
        // one row per session this makes `viewers` effectively a SESSION count (a
        // viewer who replays counts twice); routes/analytics.js made the same trade.
        // Without the `sid` fallback the $addToSet is empty on every video, viewers
        // is 0, bayesShrink() returns the global mean verbatim and EVERY relQ lands
        // on exactly 1.0 — the whole ranking silently no-ops. Keep the fallback.
        viewers: { $addToSet: { $ifNull: ['$viewerId', { $ifNull: ['$ip', '$sid'] }] } },
        sumPct: { $sum: { $ifNull: ['$watchedPct', 0] } },
        completed: { $sum: { $cond: [{ $gte: [{ $ifNull: ['$watchedPct', 0] }, RETENTION_COMPLETION_PCT] }, 1, 0] } },
        // The LOW bar — "watched a meaningful chunk", not "finished". Credits the
        // sessions that land between a bounce and a completion instead of scoring
        // them as failures. See rawQuality() in utils/retentionScore.js.
        engaged: { $sum: { $cond: [{ $gte: [{ $ifNull: ['$watchedPct', 0] }, RETENTION_ENGAGED_PCT] }, 1, 0] } },
        hooked: { $sum: { $cond: [{ $gte: [
          { $cond: [{ $gt: [{ $ifNull: ['$videoDuration', 0] }, 0] },
            { $divide: [{ $ifNull: ['$maxPosition', 0] }, '$videoDuration'] }, 0] },
          RETENTION_HOOK_FRAC] }, 1, 0] } },
        sumContentSec: { $sum: { $ifNull: ['$contentSeconds', { $ifNull: ['$watchedSeconds', 0] }] } },
        duration: { $max: { $ifNull: ['$videoDuration', 0] } },
      } },
      { $project: {
        _id: 0, owner: '$_id.owner', permlink: '$_id.permlink',
        sessions: 1, viewers: { $size: '$viewers' },
        avgPct: { $cond: [{ $gt: ['$sessions', 0] }, { $divide: ['$sumPct', '$sessions'] }, 0] },
        completionRate: { $cond: [{ $gt: ['$sessions', 0] }, { $divide: ['$completed', '$sessions'] }, 0] },
        engagedRate: { $cond: [{ $gt: ['$sessions', 0] }, { $divide: ['$engaged', '$sessions'] }, 0] },
        hookRate: { $cond: [{ $gt: ['$sessions', 0] }, { $divide: ['$hooked', '$sessions'] }, 0] },
        avgContentSec: { $cond: [{ $gt: ['$sessions', 0] }, { $divide: ['$sumContentSec', '$sessions'] }, 0] },
        duration: 1,
      } },
    ], { allowDiskUse: true }).toArray();

    if (!rows.length) {
      await client.close();
      return { videos: 0, ms: Date.now() - startedAt };
    }

    // ── 1a. Drop videos the player cannot actually serve. A deleted/failed/still-
    // encoding video keeps its watch page: the player answers with a ~6s PLACEHOLDER
    // notice clip instead of the content, the visitor watches that clip to the end,
    // and the tracker logs it against the ORIGINAL duration — 6s of a 135s video =
    // 4.4% watched. So a dead video does not merely score badly, it scores like the
    // worst-retained video on the site, and it drags the global mean (the Bayesian
    // prior EVERY video is shrunk toward) and its band mean down with it. Measured
    // 2026-08-20: 1121 of 5385 tracked videos, 3469 sessions (13% of the dataset).
    // Legacy videos live in `videos`, newer ones in `embed-video`; check both.
    const statusOf = new Map();
    for (const coll of [LEGACY_VIDEO_COLLECTION, EMBED_VIDEO_COLLECTION]) {
      const docs = await db.collection(coll)
        .find({ $or: rows.map((r) => ({ owner: r.owner, permlink: r.permlink })) },
          { projection: { owner: 1, permlink: 1, status: 1 } })
        .toArray();
      // embed-video is the newer record and runs second, so it wins on a conflict.
      for (const d of docs) statusOf.set(`${d.owner}/${d.permlink}`, String(d.status || '').toLowerCase());
    }
    const beforeFilter = rows.length;
    rows = rows.filter((r) => !PLACEHOLDER_STATUSES.has(statusOf.get(`${r.owner}/${r.permlink}`)));
    const droppedPlaceholders = beforeFilter - rows.length;
    if (!rows.length) {
      await client.close();
      return { videos: 0, droppedPlaceholders, ms: Date.now() - startedAt };
    }

    // ── 1b. Guard against the mis-tracked-duration bug: swap in the video's
    // real stored duration wherever the tracked one looks implausibly short.
    // `duration` here already went through resolveDuration() at write time
    // (see watchTracking.js), so this only catches OLD rows written before
    // that guard existed, or a future bug elsewhere with the same shape.
    const embedDocs = await db.collection(EMBED_VIDEO_COLLECTION)
      .find({ $or: rows.map((r) => ({ owner: r.owner, permlink: r.permlink })) },
        { projection: { owner: 1, permlink: 1, duration: 1 } })
      .toArray();
    const realDurationMap = new Map();
    for (const d of embedDocs) {
      if (Number.isFinite(d.duration) && d.duration > 0) realDurationMap.set(`${d.owner}/${d.permlink}`, d.duration);
    }
    let healedCount = 0;
    for (const r of rows) {
      const real = realDurationMap.get(`${r.owner}/${r.permlink}`);
      if (real && r.duration > 0 && r.duration < real * DURATION_DISAGREEMENT_RATIO) {
        r.duration = real;
        healedCount++;
      }
    }

    // ── 2. replayIntensity from the heatmaps (one small doc per video) ──
    const heatKeys = rows.map((r) => ({ owner: r.owner, permlink: r.permlink }));
    const heatDocs = await db.collection(WATCH_HEATMAP)
      .find({ $or: heatKeys }, { projection: { owner: 1, permlink: 1, buckets: 1 } }).toArray();
    const replayMap = new Map();
    for (const h of heatDocs) replayMap.set(`${h.owner}/${h.permlink}`, replayIntensity(h.buckets));
    for (const r of rows) r.replayIntensity = replayMap.get(`${r.owner}/${r.permlink}`) || 1;

    // ── 3a. rawQuality + global mean (the Bayesian prior) ──
    for (const r of rows) r.raw = rawQuality(r);
    const globalMean = rows.reduce((a, r) => a + r.raw, 0) / rows.length;

    // ── 3b. Bayesian-shrink, then per-duration-band means for length-normalization ──
    const bandSum = {}; const bandN = {};
    for (const r of rows) {
      r.q = bayesShrink(r.raw, r.viewers, globalMean);
      r.band = durationBand(r.duration);
      bandSum[r.band] = (bandSum[r.band] || 0) + r.q;
      bandN[r.band] = (bandN[r.band] || 0) + 1;
    }
    const bandMean = {};
    for (const b of Object.keys(bandSum)) bandMean[b] = bandSum[b] / bandN[b];

    // ── 3c. relQ + bulk upsert ──
    const runAt = new Date(startedAt);
    const ops = rows.map((r) => {
      const relQ = relativeQuality(r.q, bandMean[r.band]);
      return {
        updateOne: {
          filter: { _id: `${r.owner}/${r.permlink}` },
          update: { $set: {
            owner: r.owner, permlink: r.permlink,
            viewers: r.viewers, sessions: r.sessions,
            avgWatchedPct: Math.round(r.avgPct * 10) / 10,
            completionRate: Math.round(r.completionRate * 1000) / 1000,
            engagedRate: Math.round(r.engagedRate * 1000) / 1000,
            hookRate: Math.round(r.hookRate * 1000) / 1000,
            avgContentSeconds: Math.round(r.avgContentSec),
            replayIntensity: Math.round(r.replayIntensity * 100) / 100,
            duration: r.duration, band: r.band,
            q: Math.round(r.q * 1000) / 1000,
            score: Math.round(relQ * 1000) / 1000,   // relQ — what the feeds read
            runAt,
          } },
          upsert: true,
        },
      };
    });
    const coll = db.collection(RETENTION_COLLECTION);
    // Chunk the bulk writes so a huge catalog can't build one giant command.
    for (let i = 0; i < ops.length; i += 1000) {
      await coll.bulkWrite(ops.slice(i, i + 1000), { ordered: false });
    }
    // ── 4. Drop rows that aged out of the window (not refreshed this run). ──
    const del = await coll.deleteMany({ runAt: { $lt: runAt } });

    await client.close();
    return {
      videos: rows.length,
      droppedPlaceholders,
      globalMean: Math.round(globalMean * 1000) / 1000,
      removed: del.deletedCount || 0,
      healedDurations: healedCount,
      ms: Date.now() - startedAt,
    };
  } catch (err) {
    try { await client.close(); } catch { /* noop */ }
    throw err;
  }
}

run()
  .then((summary) => { if (parentPort) parentPort.postMessage({ ok: true, ...summary }); process.exit(0); })
  .catch((err) => { if (parentPort) parentPort.postMessage({ ok: false, error: String(err && err.message || err) }); process.exit(1); });
