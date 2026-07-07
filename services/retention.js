/**
 * Retention ranking scheduler (main thread). Spawns retentionWorker.js in a
 * WORKER THREAD every RETENTION_INTERVAL_MIN minutes so the aggregation never
 * competes with user/feed queries on the main event loop. The worker writes the
 * cached RETENTION_COLLECTION; feeds read it via utils/retentionRank.js.
 *
 * See algo.md for the calculation.
 */
const path = require('path');
const { Worker } = require('worker_threads');
const { getDb } = require('../utils/db');
const {
  ENABLE_MONGO_WRITES, RETENTION_ENABLED, RETENTION_INTERVAL_MIN, RETENTION_COLLECTION,
} = require('../utils/config');

const WORKER_PATH = path.join(__dirname, 'retentionWorker.js');
let running = false;

function runOnce() {
  if (running) {
    console.log('[retention] previous run still in progress — skipping this tick');
    return;
  }
  running = true;
  const startedAt = Date.now();
  const worker = new Worker(WORKER_PATH);
  worker.once('message', (msg) => {
    if (msg && msg.ok) {
      console.log(`[retention] scored ${msg.videos} videos in ${msg.ms}ms (globalMean=${msg.globalMean}, removed=${msg.removed})`);
    } else {
      console.error('[retention] worker reported failure:', msg && msg.error);
    }
  });
  worker.once('error', (err) => console.error('[retention] worker error:', err && err.message));
  worker.once('exit', (code) => {
    running = false;
    if (code !== 0) console.error(`[retention] worker exited with code ${code} after ${Date.now() - startedAt}ms`);
  });
}

async function scheduleRetention() {
  if (!RETENTION_ENABLED) {
    console.log('[retention] disabled (RETENTION_ENABLED=false)');
    return;
  }
  if (!ENABLE_MONGO_WRITES) {
    console.log('[retention] skipped — ENABLE_MONGO_WRITES=false');
    return;
  }
  // Index the housekeeping field the worker deletes by. `_id` (owner/permlink) is
  // already indexed and is what the feeds look up with $in.
  try {
    await getDb().collection(RETENTION_COLLECTION).createIndex({ runAt: 1 });
  } catch (e) { console.warn('[retention] index ensure failed:', e && e.message); }

  const intervalMs = Math.max(1, RETENTION_INTERVAL_MIN) * 60 * 1000;
  // First pass a minute after boot (let the process settle), then on the interval.
  setTimeout(runOnce, 60 * 1000);
  setInterval(runOnce, intervalMs);
  console.log(`[retention] scheduled every ${RETENTION_INTERVAL_MIN} min (worker thread), first run in 1 min`);
}

module.exports = { scheduleRetention, runOnce };
