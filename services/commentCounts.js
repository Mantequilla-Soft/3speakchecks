/**
 * Comment-count background sync.
 *
 * Comment counts exist only on Hive. This job fetches the top-level comment count
 * (and how many of those were posted through the 3Speak frontend) for every published
 * video younger than COMMENT_SYNC_MAX_AGE_DAYS — bounding the fetch to a few thousand
 * recent videos — and writes them into `video-comment-counts` for the feeds to read
 * cheaply. It runs IN-PROCESS (not a worker thread): the work is Hive network I/O, not
 * CPU, so it yields the event loop on every await and never blocks feed serving.
 *
 * Rows for videos that age past the window are dropped each run, so the collection
 * stays bounded and the comment boost only ever applies to reasonably-fresh videos —
 * which is also where a "lively discussion" signal is most meaningful.
 */
const { getDb } = require('../utils/db');
const { fetchCommentReplyCounts } = require('../utils/hive');
const {
  COMMENT_SYNC_ENABLED, COMMENT_SYNC_INTERVAL_MIN, COMMENT_SYNC_MAX_AGE_DAYS,
  COMMENT_SYNC_MAX_VIDEOS, COMMENT_NATIVE_MULT, ENABLE_MONGO_WRITES,
} = require('../utils/config');

const COLLECTION = 'video-comment-counts';
const DAY = 24 * 60 * 60 * 1000;

let running = false;

const lc = (s) => String(s || '').trim().toLowerCase();

async function syncCommentCounts() {
  if (!COMMENT_SYNC_ENABLED) return { skipped: 'disabled' };
  if (running) return { skipped: 'already-running' };
  running = true;
  const startedAt = Date.now();
  const runAt = new Date(startedAt);
  const cutoff = new Date(startedAt - COMMENT_SYNC_MAX_AGE_DAYS * DAY);

  try {
    const db = getDb();

    // Candidate videos: published, within the age window, with a Hive author+permlink.
    const [legacy, embed] = await Promise.all([
      db.collection('videos').find(
        { status: 'published', publishFailed: { $ne: true }, created: { $gte: cutoff } },
        { projection: { owner: 1, author: 1, permlink: 1 } },
      ).toArray(),
      db.collection('embed-video').find(
        {
          status: 'published', short: false, listed_on_3speak: true,
          createdAt: { $gte: cutoff }, hive_author: { $ne: null }, hive_permlink: { $ne: null },
        },
        { projection: { hive_author: 1, hive_permlink: 1 } },
      ).toArray(),
    ]);

    // Dedupe by HIVE author/permlink (an embed and a legacy row can point at one post).
    const keyMap = new Map();
    for (const v of legacy) {
      const author = lc(v.author || v.owner);
      if (author && v.permlink) keyMap.set(`${author}/${v.permlink}`, { author, permlink: v.permlink });
    }
    for (const e of embed) {
      const author = lc(e.hive_author);
      if (author && e.hive_permlink) keyMap.set(`${author}/${e.hive_permlink}`, { author, permlink: e.hive_permlink });
    }
    let authorPerms = [...keyMap.values()];
    let capped = 0;
    if (authorPerms.length > COMMENT_SYNC_MAX_VIDEOS) {
      capped = authorPerms.length - COMMENT_SYNC_MAX_VIDEOS;
      authorPerms = authorPerms.slice(0, COMMENT_SYNC_MAX_VIDEOS);   // safety cap
    }
    if (!authorPerms.length) { running = false; return { videos: 0, ms: Date.now() - startedAt }; }

    // Fetch from Hive (batched). Posts whose batch failed are absent → we skip them
    // (keep the old stored value) rather than zeroing a count on a transient error.
    const counts = await fetchCommentReplyCounts(authorPerms);

    const ops = [];
    let withComments = 0;
    for (const ap of authorPerms) {
      const c = counts.get(`${ap.author}/${ap.permlink}`);
      if (!c) continue;                                    // transient fetch miss → leave as-is
      if (c.comments > 0) withComments += 1;
      const effective = c.comments + (COMMENT_NATIVE_MULT - 1) * c.native3Speak;
      ops.push({
        updateOne: {
          filter: { _id: `${ap.author}/${ap.permlink}` },
          update: { $set: {
            author: ap.author, permlink: ap.permlink,
            comments: c.comments, native3Speak: c.native3Speak,
            effective: Math.round(effective * 100) / 100,
            updatedAt: runAt,
          } },
          upsert: true,
        },
      });
    }

    let removed = 0;
    if (ENABLE_MONGO_WRITES) {
      for (let i = 0; i < ops.length; i += 1000) {
        await db.collection(COLLECTION).bulkWrite(ops.slice(i, i + 1000), { ordered: false });
      }
      // Drop rows not refreshed this run (video aged out of the window, or deleted).
      // Only prune if we actually wrote something — a total Hive outage (ops empty)
      // must not wipe the whole collection.
      if (ops.length) {
        const del = await db.collection(COLLECTION).deleteMany({ updatedAt: { $lt: runAt } });
        removed = del.deletedCount || 0;
      }
    }

    return {
      videos: authorPerms.length, written: ops.length, withComments, removed, capped,
      ms: Date.now() - startedAt,
    };
  } catch (err) {
    console.error('[commentCounts] sync failed:', err && err.message);
    return { error: String((err && err.message) || err) };
  } finally {
    running = false;
  }
}

/** Kick off on boot (after a short delay) then on an interval. Never overlaps. */
function scheduleCommentCounts() {
  if (!COMMENT_SYNC_ENABLED) {
    console.log('[commentCounts] disabled (COMMENT_SYNC_ENABLED=false)');
    return;
  }
  const intervalMs = Math.max(5, COMMENT_SYNC_INTERVAL_MIN) * 60 * 1000;
  const runOnce = () => {
    syncCommentCounts()
      .then((s) => { if (s && !s.skipped) console.log('[commentCounts]', JSON.stringify(s)); })
      .catch((e) => console.error('[commentCounts] run error:', e && e.message));
  };
  // Delay the first run so it doesn't pile onto the boot burst (Hive + Mongo warmup).
  setTimeout(runOnce, 90 * 1000);
  setInterval(runOnce, intervalMs);
  console.log(`[commentCounts] scheduled every ${COMMENT_SYNC_INTERVAL_MIN} min (videos < ${COMMENT_SYNC_MAX_AGE_DAYS}d), first run in ~90s`);
}

module.exports = { syncCommentCounts, scheduleCommentCounts };
