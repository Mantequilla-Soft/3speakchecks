const { getDb } = require('../utils/db');
const {
  AD_VIEWER_PREFS_COLLECTION, VIEWER_PROGRESS_COLLECTION, VIEWER_PROGRESS_SYNC_MIN, ENABLE_MONGO_WRITES,
} = require('../utils/config');

/**
 * Where each viewer left a video, for Continue watching on the home page.
 *
 * The player already knows: every playback on 3speak.tv opens a session in
 * `view-sessions` (same database) with the viewer's name and the playhead of the
 * last heartbeat. Those sessions expire minutes after the video would have ended,
 * so this copies them into `viewer_progress`, one row per (viewer, video):
 *   { viewer, owner, permlink, type, position, duration, pct, at, hidden? }
 * `owner`/`permlink` are the player's keys (the upload's asset id for new
 * uploads), `at` is the last heartbeat, `pct` the playhead as a share of the video.
 *
 * 🚨 Only viewers who opted into viewer rewards. That opt-in is the consent to
 * store a name with what they watch (see AD_VIEWER_WATCH_COLLECTION); nobody
 * else gets a row, and opting out deletes these with the watch rows.
 *
 * A session only counts once it has a heartbeat: one that opened and never played
 * would otherwise reset a row to its starting point.
 */

const PROGRESS = () => getDb().collection(VIEWER_PROGRESS_COLLECTION);
const SESSIONS = 'view-sessions';
const TYPES = ['embed', 'legacy'];       // not live streams, not audio
const ROW_TTL_DAYS = 180;

let indexesEnsured = false;
async function ensureIndexes() {
  if (indexesEnsured) return;
  indexesEnsured = true;
  try {
    const col = PROGRESS();
    await col.createIndex({ viewer: 1, owner: 1, permlink: 1 }, { unique: true });
    await col.createIndex({ viewer: 1, at: -1 });
    // A video left half way half a year ago is not something to continue.
    await col.createIndex({ at: 1 }, { expireAfterSeconds: ROW_TTL_DAYS * 86400 });
  } catch (err) {
    indexesEnsured = false;
    console.error('[viewerProgress] index setup failed:', err && err.message);
  }
}

const isDuplicate = (err) => err && (err.code === 11000
  || (Array.isArray(err.writeErrors) && err.writeErrors.length > 0 && err.writeErrors.every((e) => (e.code ?? e.err?.code) === 11000)));

/**
 * Copy the sessions with a heartbeat since `since` (only `viewer`'s when given)
 * into viewer_progress. Returns { sessions, written }.
 */
async function syncViewerProgress({ since, viewer = null } = {}) {
  if (!ENABLE_MONGO_WRITES) return { sessions: 0, written: 0, skipped: 'writes off' };
  const db = getDb();
  const q = {
    lastBeatAt: { $gte: since },
    viewer: viewer || { $type: 'string' },
    type: { $in: TYPES },
    private: { $ne: true },
  };
  const sessions = await db.collection(SESSIONS).find(q, {
    projection: {
      viewer: 1, owner: 1, permlink: 1, type: 1, lastPosition: 1, heatmapDuration: 1, durationMs: 1, startedAt: 1, lastBeatAt: 1,
    },
  }).toArray();
  if (!sessions.length) return { sessions: 0, written: 0 };

  const names = [...new Set(sessions.map((s) => s.viewer))];
  const opted = new Set((await db.collection(AD_VIEWER_PREFS_COLLECTION)
    .find({ _id: { $in: names }, rewardsEnabled: true }, { projection: { _id: 1 } })
    .toArray()).map((p) => p._id));

  const ops = [];
  for (const s of sessions) {
    if (!opted.has(s.viewer) || !s.owner || !s.permlink) continue;
    const last = new Date(s.lastBeatAt);
    if (!(last > new Date(s.startedAt))) continue;
    const duration = Number(s.heatmapDuration) || Math.round((Number(s.durationMs) || 0) / 1000);
    if (!(duration > 0)) continue;
    const position = Math.max(0, Math.min(duration, Math.round(Number(s.lastPosition) || 0)));
    ops.push({
      updateOne: {
        // Never back in time: two sessions for one video (two tabs, two devices)
        // land in either order, and the later heartbeat wins. When the stored row
        // is newer the filter misses, the upsert collides with it, and that
        // duplicate-key error is the expected "nothing to do".
        filter: { viewer: s.viewer, owner: s.owner, permlink: s.permlink, $or: [{ at: { $lt: last } }, { at: { $exists: false } }] },
        update: {
          $set: { type: s.type, position, duration, pct: Math.round((position / duration) * 1000) / 10, at: last },
          $setOnInsert: { firstAt: new Date() },
        },
        upsert: true,
      },
    });
  }
  if (!ops.length) return { sessions: sessions.length, written: 0 };

  await ensureIndexes();
  let written = ops.length;
  try {
    await PROGRESS().bulkWrite(ops, { ordered: false });
  } catch (err) {
    if (!isDuplicate(err)) throw err;
    written -= err.writeErrors.length;
  }
  return { sessions: sessions.length, written };
}

/** Every VIEWER_PROGRESS_SYNC_MIN minutes, overlapping the last run, never overlapping itself. */
function scheduleViewerProgress() {
  const intervalMs = Math.max(1, VIEWER_PROGRESS_SYNC_MIN) * 60 * 1000;
  // A session can outlive its last heartbeat by a few minutes only, so a first
  // run that looks back a few hours misses nothing a restart could have.
  let since = new Date(Date.now() - 6 * 3600 * 1000);
  let running = false;
  const runOnce = async () => {
    if (running) return;
    running = true;
    const started = new Date();
    try {
      const r = await syncViewerProgress({ since });
      since = new Date(started.getTime() - 5 * 60 * 1000);
      if (r.written) console.log('[viewerProgress]', JSON.stringify(r));
    } catch (err) {
      console.error('[viewerProgress] run error:', err && err.message);
    } finally {
      running = false;
    }
  };
  setTimeout(runOnce, 60 * 1000);
  setInterval(runOnce, intervalMs);
  console.log(`[viewerProgress] scheduled every ${VIEWER_PROGRESS_SYNC_MIN} min`);
}

module.exports = { syncViewerProgress, scheduleViewerProgress, ensureIndexes };
