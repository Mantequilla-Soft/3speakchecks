/**
 * Watch-time retention cleanup.
 *
 * Deletes individual watch-time ROWS (view-durations sessions) once the ROW
 * itself is older than WATCH_RETENTION_DAYS (default 90 ≈ 3 months), by the row's
 * own `updatedAt` — NOT by the video's post date. So an old video that gets
 * watched again keeps its fresh rows and can re-enter the retention ranking; only
 * stale watch data ages out. Old view-sessions are pruned too, and a video's
 * "most replayed" heatmap is dropped only once it has NO remaining rows at all.
 */
const cron = require('node-cron');
const { getDb } = require('../utils/db');
const { ENABLE_MONGO_WRITES } = require('../utils/config');

const WATCH_LOG = process.env.WATCH_LOG_COLLECTION || 'view-durations';
const WATCH_HEATMAP = process.env.WATCH_HEATMAP_COLLECTION || 'view-heatmaps';
const WATCH_SESSION = process.env.WATCH_SESSION_COLLECTION || 'view-sessions';
const RETENTION_DAYS = parseInt(process.env.WATCH_RETENTION_DAYS, 10) || 90;

async function purgeOldWatchRecords() {
  if (!ENABLE_MONGO_WRITES) {
    console.log('[watch-retention] skipped (mongo writes disabled)');
    return;
  }
  const db = getDb();
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  // 1. Delete watch rows whose OWN last activity is older than the window. A new
  //    watch of an old video is a fresh row (recent updatedAt) → it survives, so
  //    the video re-enters ranking instead of being permanently purged.
  const rowRes = await db.collection(WATCH_LOG).deleteMany({ updatedAt: { $lt: cutoff } });

  // 2. Prune stale sessions (they also carry a TTL; this is a backstop).
  const sesRes = await db.collection(WATCH_SESSION).deleteMany({
    $or: [{ startedAt: { $lt: cutoff } }, { lastBeatAt: { $lt: cutoff } }],
  });

  // 3. Drop the "most replayed" heatmap only for videos that have NO watch rows
  //    left at all (fully aged out) — otherwise the aggregate would linger forever.
  const liveVids = new Set(
    (await db.collection(WATCH_LOG)
      .aggregate([{ $group: { _id: { owner: '$owner', permlink: '$permlink' } } }]).toArray())
      .map((d) => `${d._id.owner}/${d._id.permlink}`)
  );
  const heatmaps = await db.collection(WATCH_HEATMAP)
    .find({}, { projection: { owner: 1, permlink: 1 } }).toArray();
  const deadIds = heatmaps
    .filter((h) => !liveVids.has(`${h.owner}/${h.permlink}`))
    .map((h) => h._id);
  let deadHeatmaps = 0;
  if (deadIds.length) {
    const hr = await db.collection(WATCH_HEATMAP).deleteMany({ _id: { $in: deadIds } });
    deadHeatmaps = hr.deletedCount || 0;
  }

  console.log(`[watch-retention] purged ${rowRes.deletedCount} watch rows, ${sesRes.deletedCount} sessions, ${deadHeatmaps} dead heatmaps (rows older than ${RETENTION_DAYS}d)`);
}

// Daily at 04:30, plus one delayed run ~5 min after startup.
function schedule() {
  // Index the field both this cleanup and the retention worker filter on.
  getDb().collection(WATCH_LOG).createIndex({ updatedAt: 1 }).catch(() => {});
  cron.schedule('30 4 * * *', () => {
    purgeOldWatchRecords().catch((e) => console.error('[watch-retention] error:', e.message));
  });
  setTimeout(() => {
    purgeOldWatchRecords().catch((e) => console.error('[watch-retention] error:', e.message));
  }, 5 * 60 * 1000);
  console.log(`Watch-retention cleanup scheduled (daily 04:30, rows older than ${RETENTION_DAYS}d)`);
}

module.exports = { purgeOldWatchRecords, schedule };
