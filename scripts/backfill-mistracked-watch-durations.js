/**
 * Backfill `view-durations` rows written before the duration-tracking race fix
 * (see preview-player's watchTracking.js resolveDuration() + main.js
 * startWatchSession/maybeHealDuration).
 *
 * Bug recap: under HLS/MSE, the player could read `player.duration()` before
 * the full manifest was reconciled, transiently getting only the
 * buffered-so-far segment span (a real case sent 6s for a 120s video). The
 * server then trusted that client value unconditionally, so `videoDuration`
 * in view-durations got stuck at the bad short value for every session — AND
 * `lastPosition`/`maxPosition` got clamped to that same short axis on every
 * beat, permanently losing where in the REAL timeline the viewer actually
 * was. `watchedSeconds` (wall-clock total) was unaffected — it's a plain
 * accumulator, not a position — so it's the only thing usable to approximate
 * where the position fields SHOULD have landed.
 *
 * This is an APPROXIMATION, not a recovery of the true positions: it assumes
 * a viewer's max position was roughly their total watched wall-clock time
 * (min'd against the real duration). That's wrong for anyone who paused,
 * rewatched, or scrubbed — but it is far closer to reality than "position
 * never exceeded 6" for every one of these rows, and it's what turns the
 * retention curve from "everyone drops off at 6s" (an artifact) back into a
 * real, readable shape. Sessions are NOT reprocessed after this — the
 * retention worker's next scheduled run recomputes video-retention from the
 * corrected rows.
 *
 * Scope: only touches videos where the tracked duration is genuinely
 * implausible next to the video's real stored duration (< 50% of it — same
 * ratio the live-request fallback in watchTracking.js/analytics.js/
 * retentionWorker.js already uses) — never a real short-form video.
 *
 * Safe to run multiple times: after healing, a row's videoDuration equals the
 * real duration, so it no longer matches the "implausibly short" filter and
 * is skipped on a re-run.
 *
 * Usage:
 *   node backfill-mistracked-watch-durations.js --dry-run             # report only, no writes
 *   node backfill-mistracked-watch-durations.js --owner=X --permlink=Y [--dry-run]  # one video only
 *   node backfill-mistracked-watch-durations.js                       # apply platform-wide
 */
const path = require('path');
const { MongoClient } = require('mongodb');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const MONGODB_URI = process.env.MONGODB_URI;
const DATABASE_NAME = process.env.DATABASE_NAME || 'threespeak';
const WATCH_LOG = process.env.WATCH_LOG_COLLECTION || 'view-durations';
const DURATION_DISAGREEMENT_RATIO = 0.5; // tracked below 50% of the real duration is untrusted
const BATCH_SIZE = 500;

const DRY_RUN = process.argv.includes('--dry-run');
const argOwner = process.argv.find((a) => a.startsWith('--owner='));
const argPermlink = process.argv.find((a) => a.startsWith('--permlink='));
const SCOPE_OWNER = argOwner ? argOwner.split('=')[1] : null;
const SCOPE_PERMLINK = argPermlink ? argPermlink.split('=')[1] : null;

async function realDurationMap(db, pairs) {
  const [embeds, legacy] = await Promise.all([
    db.collection('embed-video').find(
      { $or: pairs.map(({ owner, permlink }) => ({ owner, $or: [{ permlink }, { hive_permlink: permlink }] })) },
      { projection: { owner: 1, permlink: 1, hive_permlink: 1, duration: 1 } },
    ).toArray(),
    db.collection('videos').find(
      { $or: pairs.map(({ owner, permlink }) => ({ owner, permlink })) },
      { projection: { owner: 1, permlink: 1, duration: 1 } },
    ).toArray(),
  ]);
  const map = new Map();
  for (const l of legacy) {
    if (Number.isFinite(l.duration) && l.duration > 0) map.set(`${l.owner}/${l.permlink}`, l.duration);
  }
  for (const e of embeds) {
    if (!Number.isFinite(e.duration) || e.duration <= 0) continue;
    map.set(`${e.owner}/${e.permlink}`, e.duration); // embed's own permlink
    if (e.hive_permlink) map.set(`${e.owner}/${e.hive_permlink}`, e.duration); // rows keyed by hive_permlink
  }
  return map;
}

async function run() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(DATABASE_NAME);
  const col = db.collection(WATCH_LOG);

  try {
    console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'APPLY'}`);
    if (SCOPE_OWNER) console.log(`Scoped to: ${SCOPE_OWNER}/${SCOPE_PERMLINK || '*'}`);

    // 1. Which (owner, permlink) videos have a session whose tracked duration
    //    could plausibly be the bug (small absolute cutoff, cheap pre-filter —
    //    the real ratio check against the video's actual duration happens per
    //    video below since it needs the embed-video/videos lookup).
    const scopeMatch = { videoDuration: { $gt: 0, $lte: 60 } };
    if (SCOPE_OWNER) scopeMatch.owner = SCOPE_OWNER;
    if (SCOPE_PERMLINK) scopeMatch.permlink = SCOPE_PERMLINK;
    const candidates = await col.aggregate([
      { $match: scopeMatch },
      { $group: { _id: { owner: '$owner', permlink: '$permlink' }, maxTracked: { $max: '$videoDuration' } } },
    ]).toArray();
    console.log(`Candidate videos (tracked duration <=60s somewhere): ${candidates.length}`);
    if (!candidates.length) { await client.close(); return; }

    const pairs = candidates.map((c) => ({ owner: c._id.owner, permlink: c._id.permlink }));
    const realDurations = await realDurationMap(db, pairs);

    const affected = candidates
      .map((c) => ({
        owner: c._id.owner,
        permlink: c._id.permlink,
        maxTracked: c.maxTracked,
        real: realDurations.get(`${c._id.owner}/${c._id.permlink}`),
      }))
      .filter((v) => v.real && v.maxTracked < v.real * DURATION_DISAGREEMENT_RATIO);

    console.log(`Videos with genuinely implausible tracked duration: ${affected.length}`);
    if (!affected.length) { await client.close(); return; }

    let rowsExamined = 0;
    let rowsHealed = 0;
    let bulk = [];

    const flush = async () => {
      if (!bulk.length) return;
      if (!DRY_RUN) await col.bulkWrite(bulk, { ordered: false });
      bulk = [];
    };

    for (const v of affected) {
      const rowFilter = {
        owner: v.owner,
        permlink: v.permlink,
        videoDuration: { $lte: v.real * DURATION_DISAGREEMENT_RATIO },
      };
      const cursor = col.find(rowFilter, {
        projection: { _id: 1, watchedSeconds: 1, contentSeconds: 1, lastPosition: 1, maxPosition: 1 },
      });

      for await (const row of cursor) {
        rowsExamined++;
        const wallClock = Number(row.watchedSeconds ?? row.contentSeconds ?? 0) || 0;
        const approxPos = Math.max(0, Math.min(wallClock, v.real));

        bulk.push({
          updateOne: {
            filter: { _id: row._id },
            update: {
              $set: {
                videoDuration: v.real,
                lastPosition: approxPos,
                maxPosition: Math.max(approxPos, Number(row.maxPosition) || 0),
              },
            },
          },
        });
        rowsHealed++;
        if (bulk.length >= BATCH_SIZE) await flush();
      }
    }
    await flush();

    console.log(`Rows examined: ${rowsExamined}`);
    console.log(`Rows ${DRY_RUN ? 'that WOULD BE' : ''} healed: ${rowsHealed}`);
    if (DRY_RUN) console.log('Dry run only — no writes made. Re-run without --dry-run to apply.');
  } finally {
    await client.close();
  }
}

run().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
