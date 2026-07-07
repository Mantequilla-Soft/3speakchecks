/**
 * Retention worker — runs in a WORKER THREAD (spawned by services/retention.js)
 * so the heavy aggregation + scoring never blocks the main event loop serving
 * user/feed queries. It has its OWN MongoDB connection (thread-isolated), does the
 * whole compute, writes the RETENTION_COLLECTION, and exits.
 *
 * Pipeline (see algo.md for the plain-English + full version):
 *   1. Aggregate view-durations (recent window, junk sessions dropped) → per-video
 *      { viewers(distinct IP), sessions, avgPct, completionRate, hookRate, avgContentSec, duration }.
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
  RETENTION_COMPLETION_PCT, RETENTION_HOOK_FRAC,
} = require('../utils/config');
const {
  durationBand, rawQuality, bayesShrink, relativeQuality,
} = require('../utils/retentionScore');

const WATCH_LOG = process.env.WATCH_LOG_COLLECTION || 'view-durations';
const WATCH_HEATMAP = process.env.WATCH_HEATMAP_COLLECTION || 'view-heatmaps';

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
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(DATABASE_NAME);

  try {
    // ── 1. Per-video watch metrics (the aggregation runs on the Mongo server) ──
    const rows = await db.collection(WATCH_LOG).aggregate([
      { $match: { updatedAt: { $gte: cutoff }, contentSeconds: { $gte: RETENTION_MIN_SESSION_SECONDS } } },
      { $group: {
        _id: { owner: '$owner', permlink: '$permlink' },
        sessions: { $sum: 1 },
        viewers: { $addToSet: '$ip' },                       // distinct IPs = confidence (not sessions)
        sumPct: { $sum: { $ifNull: ['$watchedPct', 0] } },
        completed: { $sum: { $cond: [{ $gte: [{ $ifNull: ['$watchedPct', 0] }, RETENTION_COMPLETION_PCT] }, 1, 0] } },
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
        hookRate: { $cond: [{ $gt: ['$sessions', 0] }, { $divide: ['$hooked', '$sessions'] }, 0] },
        avgContentSec: { $cond: [{ $gt: ['$sessions', 0] }, { $divide: ['$sumContentSec', '$sessions'] }, 0] },
        duration: 1,
      } },
    ], { allowDiskUse: true }).toArray();

    if (!rows.length) {
      await client.close();
      return { videos: 0, ms: Date.now() - startedAt };
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
    return { videos: rows.length, globalMean: Math.round(globalMean * 1000) / 1000, removed: del.deletedCount || 0, ms: Date.now() - startedAt };
  } catch (err) {
    try { await client.close(); } catch { /* noop */ }
    throw err;
  }
}

run()
  .then((summary) => { if (parentPort) parentPort.postMessage({ ok: true, ...summary }); process.exit(0); })
  .catch((err) => { if (parentPort) parentPort.postMessage({ ok: false, error: String(err && err.message || err) }); process.exit(1); });
