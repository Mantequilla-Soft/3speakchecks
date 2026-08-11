/**
 * Rebuild `view-heatmaps` docs poisoned by the same duration-tracking race the
 * view-durations backfill (backfill-mistracked-watch-durations.js) fixes —
 * see that script's header for the full bug description.
 *
 * A heatmap doc's `duration` is set ONCE, on first creation ($setOnInsert in
 * watchTracking.js's watchStart), from whatever resolveDuration() returned
 * for the FIRST session ever tracked for that video. If that first session
 * hit the race, the doc got permanently stuck bucketing every subsequent
 * beat — forever, even after the client fix — against the wrong short axis:
 * nearly every session's real position collapsed into the first few of its
 * 100 slots, which is why the "most replayed" bar showed a flat plateau with
 * one spike at the last bucket instead of a real replay curve.
 *
 * The existing bucket array can't be repaired in place (it's an aggregate
 * across however many sessions already hit the wrong axis, with no per-
 * session breakdown left to correct). But it doesn't need to be: the same
 * information the live watchBeat handler uses to fill buckets — a session's
 * start/max position on the timeline — survives per-row in view-durations,
 * and THOSE rows already got their own backfill (see
 * backfill-mistracked-watch-durations.js), so lastPosition/maxPosition now
 * reflect the corrected real-timeline positions.
 *
 * So this REPLAYS that same bucket-filling logic (bucketIndex + fill
 * start→max, exactly like watchBeat's b0..b1 loop, just once per session
 * instead of once per beat) over all of a video's view-durations rows, and
 * writes a fresh heatmap doc from the result — producing a real, immediately
 * visible replay curve instead of leaving the bar blank until new views
 * trickle in.
 *
 * Caveat: this is coarser than the original per-beat bucketing (one
 * start→max fill per session instead of per-beat increments that track
 * pauses/seeks/rewinds mid-session), and it can't restore true REPLAY counts
 * (rewatching the same span twice) since only the session's overall max
 * survived, not its path. It's a faithful reconstruction of "which parts of
 * the timeline this session's viewer reached," not a perfect replica of what
 * the original correct beats would have produced.
 *
 * Requires backfill-mistracked-watch-durations.js to have already run for the
 * same scope — this script trusts view-durations' startPosition/maxPosition
 * as already-corrected input.
 *
 * Safe to run multiple times — always fully replaces the doc from the
 * current view-durations rows.
 *
 * Usage:
 *   node rebuild-mistracked-heatmaps.js --dry-run             # report only, no writes
 *   node rebuild-mistracked-heatmaps.js --owner=X --permlink=Y [--dry-run]  # one video only
 *   node rebuild-mistracked-heatmaps.js                       # apply platform-wide
 */
const path = require('path');
const { MongoClient } = require('mongodb');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const MONGODB_URI = process.env.MONGODB_URI;
const DATABASE_NAME = process.env.DATABASE_NAME || 'threespeak';
const WATCH_LOG = process.env.WATCH_LOG_COLLECTION || 'view-durations';
const HEATMAP_COLLECTION = process.env.WATCH_HEATMAP_COLLECTION || 'view-heatmaps';
const BUCKET_COUNT = Math.max(10, parseInt(process.env.WATCH_BUCKET_COUNT, 10) || 100);
const DURATION_DISAGREEMENT_RATIO = 0.5; // doc duration below 50% of the real duration is untrusted

const DRY_RUN = process.argv.includes('--dry-run');
const argOwner = process.argv.find((a) => a.startsWith('--owner='));
const argPermlink = process.argv.find((a) => a.startsWith('--permlink='));
const SCOPE_OWNER = argOwner ? argOwner.split('=')[1] : null;
const SCOPE_PERMLINK = argPermlink ? argPermlink.split('=')[1] : null;

// Mirrors watchTracking.js's bucketIndex() exactly.
function bucketIndex(pos, durationSec, n) {
  if (!(durationSec > 0)) return 0;
  const i = Math.floor((pos / durationSec) * n);
  return Math.min(n - 1, Math.max(0, i));
}

async function realDurationFor(db, owner, permlink) {
  const ev = await db.collection('embed-video').findOne(
    { owner, $or: [{ permlink }, { hive_permlink: permlink }] },
    { projection: { duration: 1, type: 1 } },
  );
  if (ev && Number.isFinite(ev.duration) && ev.duration > 0) return { duration: ev.duration, type: 'embed' };
  const legacy = await db.collection('videos').findOne(
    { owner, permlink }, { projection: { duration: 1 } },
  );
  if (legacy && Number.isFinite(legacy.duration) && legacy.duration > 0) return { duration: legacy.duration, type: 'legacy' };
  return null;
}

async function run() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(DATABASE_NAME);
  const heatCol = db.collection(HEATMAP_COLLECTION);
  const logCol = db.collection(WATCH_LOG);

  try {
    console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'APPLY'}`);
    if (SCOPE_OWNER) console.log(`Scoped to: ${SCOPE_OWNER}/${SCOPE_PERMLINK || '*'}`);

    const match = { duration: { $gt: 0, $lte: 60 } };
    if (SCOPE_OWNER) match.owner = SCOPE_OWNER;
    if (SCOPE_PERMLINK) match.permlink = SCOPE_PERMLINK;
    const candidates = await heatCol.find(match, { projection: { owner: 1, permlink: 1, duration: 1, sessions: 1 } }).toArray();
    console.log(`Candidate heatmap docs (duration <=60s): ${candidates.length}`);
    if (!candidates.length) { await client.close(); return; }

    let checked = 0;
    let rebuilt = 0;
    let bulk = [];

    const flush = async () => {
      if (!bulk.length) return;
      if (!DRY_RUN) await heatCol.bulkWrite(bulk, { ordered: false });
      bulk = [];
    };

    for (const doc of candidates) {
      checked++;
      const real = await realDurationFor(db, doc.owner, doc.permlink);
      if (!real || doc.duration >= real.duration * DURATION_DISAGREEMENT_RATIO) continue;

      const durationSec = Math.round(real.duration);
      const buckets = new Array(BUCKET_COUNT).fill(0);
      let sessions = 0;

      const rows = logCol.find(
        { owner: doc.owner, permlink: doc.permlink },
        { projection: { startPosition: 1, maxPosition: 1, lastPosition: 1 } },
      );
      for await (const row of rows) {
        sessions++;
        const start = Math.max(0, Math.min(Number(row.startPosition) || 0, durationSec));
        const max = Math.max(start, Math.min(Number(row.maxPosition ?? row.lastPosition) || 0, durationSec));
        const b0 = bucketIndex(start, durationSec, BUCKET_COUNT);
        const b1 = bucketIndex(max, durationSec, BUCKET_COUNT);
        for (let b = b0; b <= b1; b++) buckets[b]++;
      }

      if (!sessions) continue; // nothing to rebuild from — leave the doc alone

      rebuilt++;
      console.log(`  ${doc.owner}/${doc.permlink}: tracked=${doc.duration}s real=${durationSec}s sessions=${sessions} (was ${doc.sessions || 0}) → ${DRY_RUN ? 'WOULD REBUILD' : 'rebuilding'}`);

      bulk.push({
        updateOne: {
          filter: { owner: doc.owner, permlink: doc.permlink },
          update: {
            $set: {
              duration: durationSec, bucketCount: BUCKET_COUNT, buckets, sessions, type: real.type,
              updatedAt: new Date(),
            },
          },
        },
      });
      if (bulk.length >= 200) await flush();
    }
    await flush();

    console.log(`Docs checked: ${checked}`);
    console.log(`Docs ${DRY_RUN ? 'that WOULD BE' : ''} rebuilt: ${rebuilt}`);
    if (DRY_RUN) console.log('Dry run only — no writes made. Re-run without --dry-run to apply.');
  } finally {
    await client.close();
  }
}

run().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
