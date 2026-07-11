/**
 * Discover pool scheduler (main thread). Spawns discoverWorker.js in a WORKER
 * THREAD every DISCOVER_INTERVAL_MIN minutes (hourly by default) so building the
 * pool — which samples the whole back catalogue — never competes with user/feed
 * queries on the main event loop.
 *
 * The worker writes DISCOVER_POOL_COLLECTION; the feed reads it via
 * utils/discoverPool.js. See algo.md ("Discover feed").
 */
const path = require('path');
const { Worker } = require('worker_threads');
const { getDb } = require('../utils/db');
const {
  ENABLE_MONGO_WRITES, DISCOVER_ENABLED, DISCOVER_INTERVAL_MIN, DISCOVER_POOL_COLLECTION,
} = require('../utils/config');

const WORKER_PATH = path.join(__dirname, 'discoverWorker.js');
let running = false;

function runOnce() {
  if (running) {
    console.log('[discover] previous run still in progress — skipping this tick');
    return;
  }
  running = true;
  const startedAt = Date.now();
  let worker;
  try {
    worker = new Worker(WORKER_PATH);
  } catch (err) {
    // A synchronous spawn failure would otherwise leave `running` stuck true and
    // silently disable the pool rebuild forever — always release the guard.
    running = false;
    console.error('[discover] failed to spawn worker:', err && err.message);
    return;
  }
  worker.once('message', (msg) => {
    if (msg && msg.ok) {
      const s = msg.sources || {};
      console.log(`[discover] pool ${msg.pool} videos in ${msg.ms}ms `
        + `(recent=${s.recent} random=${s.random} retention=${s.retention}, skipped=${msg.skipped}, removed=${msg.removed})`);
    } else {
      console.error('[discover] worker reported failure:', msg && msg.error);
    }
  });
  worker.once('error', (err) => console.error('[discover] worker error:', err && err.message));
  worker.once('exit', (code) => {
    running = false;
    if (code !== 0) console.error(`[discover] worker exited with code ${code} after ${Date.now() - startedAt}ms`);
  });
}

async function scheduleDiscover() {
  if (!DISCOVER_ENABLED) {
    console.log('[discover] disabled (DISCOVER_ENABLED=false)');
    return;
  }
  if (!ENABLE_MONGO_WRITES) {
    console.log('[discover] skipped — ENABLE_MONGO_WRITES=false');
    return;
  }
  try {
    const coll = getDb().collection(DISCOVER_POOL_COLLECTION);
    // `runAt` is what the stale-sweep deletes by; `base` is the feed's sort key.
    await coll.createIndex({ runAt: 1 });
    await coll.createIndex({ base: -1 });
  } catch (e) { console.warn('[discover] index ensure failed:', e && e.message); }

  const intervalMs = Math.max(1, DISCOVER_INTERVAL_MIN) * 60 * 1000;
  // First pass shortly after boot so the feed isn't empty on a fresh deploy.
  setTimeout(runOnce, 15 * 1000);
  setInterval(runOnce, intervalMs);
  console.log(`[discover] scheduled every ${DISCOVER_INTERVAL_MIN} min (worker thread), first run in 15s`);
}

module.exports = { scheduleDiscover, runOnce };
