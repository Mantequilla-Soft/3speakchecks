/**
 * Watch-time retention cleanup.
 *
 * Deletes the watch-time records (view-durations rows, the view-heatmaps
 * aggregate, and any leftover view-sessions) for videos whose POST DATE is older
 * than WATCH_RETENTION_DAYS (default 90 ≈ 3 months). The post date comes from the
 * video's embed-video / legacy `videos` doc; if it can't be determined the
 * records are left untouched (never guess-delete).
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

  // The set of videos that have watch data (one heatmap doc per video), plus any
  // that have duration rows but no heatmap doc.
  const videos = await db.collection(WATCH_HEATMAP)
    .find({}, { projection: { owner: 1, permlink: 1 } }).toArray();
  const seen = new Set(videos.map((v) => `${v.owner}/${v.permlink}`));
  const durVids = await db.collection(WATCH_LOG).aggregate([
    { $group: { _id: { owner: '$owner', permlink: '$permlink' } } },
  ]).toArray();
  for (const d of durVids) {
    const key = `${d._id.owner}/${d._id.permlink}`;
    if (!seen.has(key)) { seen.add(key); videos.push({ owner: d._id.owner, permlink: d._id.permlink }); }
  }

  let purgedVideos = 0;
  let purgedRows = 0;
  for (const { owner, permlink } of videos) {
    if (!owner || !permlink) continue;

    // Resolve the video's post date from its doc.
    let postDate = null;
    const ev = await db.collection('embed-video').findOne({ owner, permlink }, { projection: { createdAt: 1 } });
    if (ev?.createdAt) postDate = new Date(ev.createdAt);
    if (!postDate) {
      const lv = await db.collection('videos').findOne({ owner, permlink }, { projection: { created: 1, createdAt: 1 } });
      const raw = lv?.created || lv?.createdAt;
      if (raw) postDate = new Date(raw);
    }
    if (!postDate || isNaN(postDate.getTime()) || postDate >= cutoff) continue;

    const r = await db.collection(WATCH_LOG).deleteMany({ owner, permlink });
    await db.collection(WATCH_HEATMAP).deleteMany({ owner, permlink });
    await db.collection(WATCH_SESSION).deleteMany({ owner, permlink });
    purgedVideos += 1;
    purgedRows += r.deletedCount || 0;
  }

  console.log(`[watch-retention] purged ${purgedRows} watch records across ${purgedVideos} videos older than ${RETENTION_DAYS} days`);
}

// Daily at 04:30, plus one delayed run ~5 min after startup.
function schedule() {
  cron.schedule('30 4 * * *', () => {
    purgeOldWatchRecords().catch((e) => console.error('[watch-retention] error:', e.message));
  });
  setTimeout(() => {
    purgeOldWatchRecords().catch((e) => console.error('[watch-retention] error:', e.message));
  }, 5 * 60 * 1000);
  console.log(`Watch-retention cleanup scheduled (daily 04:30, >${RETENTION_DAYS}d old videos)`);
}

module.exports = { purgeOldWatchRecords, schedule };
