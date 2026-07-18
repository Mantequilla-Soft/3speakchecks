/**
 * Leaderboard — read-only API over the `leaderboard` collection.
 *
 * The collection is maintained by an external rollup job that keeps one doc per
 * (window, user) with all five metrics on it. `leaderboard-daily` is that job's
 * internal source of truth and is deliberately NOT read here.
 *
 *   GET /leaderboard          → one ranked board (window + metric)
 *   GET /leaderboard/summary  → the top N of every metric for a window, in one call
 *   GET /leaderboard/user/:username → a user's stat line + rank per metric
 *
 * A user with no activity in a rolling window has NO row for that window (the
 * rollup deletes them), so "absent" is read as zero everywhere below.
 */
const express = require('express');
const { hiddenListSync } = require('../utils/hiddenCreators');
const router = express.Router();
const { getDb } = require('../utils/db');
const { expandTag } = require('../utils/interestTags');

const COLLECTION = 'leaderboard';

const WINDOWS = ['7d', '30d', '365d', 'all'];
const METRICS = [
  'video_uploads',
  'short_uploads',
  'video_watch_secs',
  'short_watch_secs',
  'tags_given',
];

// Watch-duration tracking only started on this date, so for the 30d/365d/all
// windows the two *_watch_secs metrics cover a shorter period than the window
// name implies. Uploads and tags_given are full-history. Surfaced in every
// response so the UI can label the board instead of looking broken.
const WATCH_TRACKED_SINCE = '2026-07-06';

const HIVE_RE = /^[a-z][a-z0-9.-]{2,15}$/;

function parseWindow(v) {
  return WINDOWS.includes(v) ? v : '7d';
}
function parseMetric(v) {
  return METRICS.includes(v) ? v : 'video_uploads';
}
function parseLimit(v, def, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(n, max);
}

// Watch metrics are only meaningful back to WATCH_TRACKED_SINCE; say so per board.
function metaFor(window, metric) {
  const partial = metric.endsWith('_watch_secs') && window !== '7d';
  return {
    watch_tracked_since: WATCH_TRACKED_SINCE,
    partial_watch_data: partial,
  };
}

function projection() {
  const p = { _id: 0, user: 1, window: 1, from: 1, to: 1, updated_at: 1 };
  for (const m of METRICS) p[m] = 1;
  return p;
}

// The rollup omits inactive users rather than zeroing them, so any metric the
// doc doesn't carry is genuinely zero.
function normalize(doc) {
  const out = { user: doc.user };
  for (const m of METRICS) out[m] = doc[m] || 0;
  return out;
}

/**
 * GET /leaderboard?window=7d&metric=video_uploads&limit=50&page=1
 *
 * One ranked board. Rows with a zero value for the sorted metric are excluded —
 * otherwise the tail of every board is padded with users who did none of it.
 * Each row still carries all five metrics so the UI can show a full stat line.
 */
router.get('/leaderboard', async (req, res) => {
  try {
    const window = parseWindow(req.query.window);
    const metric = parseMetric(req.query.metric);
    const limit = parseLimit(req.query.limit, 50, 100);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const skip = (page - 1) * limit;

    const db = getDb();
    const col = db.collection(COLLECTION);
    const filter = { window, [metric]: { $gt: 0 }, user: { $nin: hiddenListSync() } };

    // (window, metric) has its own index, so this sort is served by it.
    const [docs, total] = await Promise.all([
      col.find(filter, { projection: projection() })
        .sort({ [metric]: -1, user: 1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      col.countDocuments(filter),
    ]);

    const first = docs[0] || null;
    res.json({
      success: true,
      window,
      metric,
      page,
      limit,
      total,
      has_more: skip + docs.length < total,
      from: first ? first.from : null,
      to: first ? first.to : null,
      updated_at: first ? first.updated_at : null,
      ...metaFor(window, metric),
      entries: docs.map((d, i) => ({ rank: skip + i + 1, ...normalize(d) })),
    });
  } catch (err) {
    console.error('leaderboard error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to load leaderboard' });
  }
});

/**
 * GET /leaderboard/summary?window=7d&limit=10
 *
 * Top N of every metric for one window, so the page can render all five boards
 * without five round-trips.
 */
router.get('/leaderboard/summary', async (req, res) => {
  try {
    const window = parseWindow(req.query.window);
    const limit = parseLimit(req.query.limit, 10, 50);

    const db = getDb();
    const col = db.collection(COLLECTION);

    const boards = await Promise.all(METRICS.map(async (metric) => {
      const docs = await col
        .find({ window, [metric]: { $gt: 0 }, user: { $nin: hiddenListSync() } }, { projection: projection() })
        .sort({ [metric]: -1, user: 1 })
        .limit(limit)
        .toArray();
      return [metric, {
        metric,
        ...metaFor(window, metric),
        entries: docs.map((d, i) => ({ rank: i + 1, ...normalize(d) })),
      }];
    }));

    const any = boards.map(([, b]) => b.entries[0]).find(Boolean);
    res.json({
      success: true,
      window,
      limit,
      watch_tracked_since: WATCH_TRACKED_SINCE,
      updated_at: any ? any.updated_at : null,
      boards: Object.fromEntries(boards),
    });
  } catch (err) {
    console.error('leaderboard summary error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to load leaderboard summary' });
  }
});

/**
 * GET /leaderboard/user/:username?window=all
 *
 * A single creator's stat line plus their rank on each metric. Rank is derived
 * (count of users strictly ahead + 1) rather than stored. A user with no row for
 * the window is reported as all-zero with null ranks, not a 404 — absence from a
 * rolling window just means "no activity", which the caller shouldn't have to
 * special-case.
 */
router.get('/leaderboard/user/:username', async (req, res) => {
  try {
    const username = String(req.params.username || '').toLowerCase();
    if (!HIVE_RE.test(username)) {
      return res.status(400).json({ success: false, error: 'Invalid username' });
    }
    const window = parseWindow(req.query.window);

    const db = getDb();
    const col = db.collection(COLLECTION);
    const doc = await col.findOne({ window, user: username }, { projection: projection() });

    if (!doc) {
      const zero = Object.fromEntries(METRICS.map(m => [m, 0]));
      return res.json({
        success: true,
        window,
        found: false,
        watch_tracked_since: WATCH_TRACKED_SINCE,
        stats: { user: username, ...zero },
        ranks: Object.fromEntries(METRICS.map(m => [m, null])),
      });
    }

    const ranks = await Promise.all(METRICS.map(async (metric) => {
      const value = doc[metric] || 0;
      if (value <= 0) return [metric, null];
      const ahead = await col.countDocuments({ window, [metric]: { $gt: value } });
      return [metric, ahead + 1];
    }));

    res.json({
      success: true,
      window,
      found: true,
      watch_tracked_since: WATCH_TRACKED_SINCE,
      from: doc.from,
      to: doc.to,
      updated_at: doc.updated_at,
      stats: normalize(doc),
      ranks: Object.fromEntries(ranks),
    });
  } catch (err) {
    console.error('leaderboard user error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to load user leaderboard stats' });
  }
});

/**
 * Per-topic boards, from the separate `leaderboard-topics` collection: one doc
 * per (window, topic, user) with just two metrics. Topics bucket by the video's
 * UPLOAD date (not the date it was tagged), so a back-catalogue video tagged
 * today counts toward the day it was actually published.
 *
 *   GET /leaderboard/topics                                → the topic list
 *   GET /leaderboard/topic?topic=&window=&metric=&limit=&page=  → one topic board
 */
const TOPICS_COLLECTION = 'leaderboard-topics';
// Videos and shorts are tracked separately; `uploads`/`watch_secs` are the
// combined totals kept alongside them, so "top gaming creator overall" is still
// one sort. Every one of the six has a (window, topic, metric) index.
const TOPIC_METRICS = [
  'uploads', 'video_uploads', 'short_uploads',
  'watch_secs', 'video_watch_secs', 'short_watch_secs',
];
const TOPIC_RE = /^[a-z0-9-]{2,32}$/;
const TOPICS_TTL_MS = 10 * 60 * 1000;
let topicsCache = null;

function topicProjection() {
  const p = { _id: 0, user: 1, topic: 1, window: 1, from: 1, to: 1, updated_at: 1 };
  for (const m of TOPIC_METRICS) p[m] = 1;
  return p;
}

router.get('/leaderboard/topics', async (req, res) => {
  try {
    if (topicsCache && topicsCache.expires > Date.now()) {
      return res.json({ success: true, topics: topicsCache.topics, cached: true });
    }
    const db = getDb();
    const topics = (await db.collection(TOPICS_COLLECTION).distinct('topic')).sort();
    topicsCache = { topics, expires: Date.now() + TOPICS_TTL_MS };
    res.json({ success: true, topics });
  } catch (err) {
    console.error('leaderboard topics error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to load topics' });
  }
});

router.get('/leaderboard/topic', async (req, res) => {
  try {
    const topic = String(req.query.topic || '').toLowerCase();
    if (!TOPIC_RE.test(topic)) {
      return res.status(400).json({ success: false, error: 'Invalid topic' });
    }
    const window = parseWindow(req.query.window);
    const metric = TOPIC_METRICS.includes(req.query.metric) ? req.query.metric : TOPIC_METRICS[0];
    const limit = parseLimit(req.query.limit, 50, 100);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const skip = (page - 1) * limit;

    const db = getDb();
    const col = db.collection(TOPICS_COLLECTION);

    // A CATEGORY rolls up: its own board plus every topic beneath it (selecting
    // "Tech & Science" must cover technology + education + science + programming,
    // as well as videos tagged with the bare category). Plain topics keep the
    // simple indexed path below.
    const bucket = expandTag(topic);
    const rolledUp = bucket.length > 1;

    let docs;
    let total;

    if (rolledUp) {
      // Per-topic rows must be summed per creator, so this can't use the plain
      // (window, topic, metric) index path — group first, then rank.
      //
      // ⚠️ Approximate by construction: `leaderboard-topics` is pre-aggregated
      // per topic, so a video tagged with TWO topics of the same category (e.g.
      // technology + education) contributes to both rows and is counted twice
      // here. De-duplicating would need per-video tags, which this collection
      // doesn't carry — hence `approx: true` in the response.
      const sums = Object.fromEntries(TOPIC_METRICS.map((m) => [m, { $sum: `$${m}` }]));
      const base = [
        { $match: { window, topic: { $in: bucket }, user: { $nin: hiddenListSync() } } },
        {
          $group: {
            _id: '$user',
            ...sums,
            from: { $min: '$from' },
            to: { $max: '$to' },
            updated_at: { $max: '$updated_at' },
          },
        },
        { $match: { [metric]: { $gt: 0 } } },
        { $sort: { [metric]: -1, _id: 1 } },
      ];
      const [rows, counted] = await Promise.all([
        col.aggregate([...base, { $skip: skip }, { $limit: limit }]).toArray(),
        col.aggregate([...base, { $count: 'n' }]).toArray(),
      ]);
      docs = rows.map((r) => ({ ...r, user: r._id }));
      total = counted[0]?.n || 0;
    } else {
      const filter = { window, topic, [metric]: { $gt: 0 }, user: { $nin: hiddenListSync() } };
      // Served by the (window, topic, metric) index.
      [docs, total] = await Promise.all([
        col.find(filter, { projection: topicProjection() })
          .sort({ [metric]: -1, user: 1 })
          .skip(skip)
          .limit(limit)
          .toArray(),
        col.countDocuments(filter),
      ]);
    }

    // Same caveat as the main board: watch-time only exists from the tracking
    // start date, so any watch metric is partial on a window longer than 7d.
    const partial = metric.endsWith('watch_secs') && window !== '7d';
    const first = docs[0] || null;
    res.json({
      success: true,
      window,
      topic,
      metric,
      page,
      limit,
      total,
      has_more: skip + docs.length < total,
      from: first ? first.from : null,
      to: first ? first.to : null,
      updated_at: first ? first.updated_at : null,
      watch_tracked_since: WATCH_TRACKED_SINCE,
      partial_watch_data: partial,
      rolled_up: rolledUp,        // category board = itself + its topics
      rolled_up_topics: rolledUp ? bucket : null,
      approx: rolledUp,           // see the double-count caveat above
      entries: docs.map((d, i) => ({
        rank: skip + i + 1,
        user: d.user,
        ...Object.fromEntries(TOPIC_METRICS.map(m => [m, d[m] || 0])),
      })),
    });
  } catch (err) {
    console.error('leaderboard topic error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to load topic leaderboard' });
  }
});

/**
 * GET /leaderboard/badges/:username
 *
 * Profile badges ("Top 10 video creator") derived from the same ranks. For each
 * metric we take the user's BEST standing across all four windows and emit a
 * badge if it lands inside a tier. Ties on tier are broken toward the longer
 * window, so an all-time Top 10 outranks a 7-day Top 10.
 *
 * Hit on every profile view, so results are cached briefly — the underlying
 * rollup only moves once a day.
 */
const TIERS = [
  { tier: 'top1', label: '#1', max: 1 },
  { tier: 'top3', label: 'Top 3', max: 3 },
  { tier: 'top10', label: 'Top 10', max: 10 },
  { tier: 'top50', label: 'Top 50', max: 50 },
  { tier: 'top100', label: 'Top 100', max: 100 },
];
// Longest window first: the tie-break preference when two windows earn the same tier.
const WINDOWS_BY_PRESTIGE = ['all', '365d', '30d', '7d'];
const BADGE_TTL_MS = 5 * 60 * 1000;
const badgeCache = new Map();

function tierFor(rank) {
  return TIERS.find(t => rank <= t.max) || null;
}

router.get('/leaderboard/badges/:username', async (req, res) => {
  try {
    const username = String(req.params.username || '').toLowerCase();
    if (!HIVE_RE.test(username)) {
      return res.status(400).json({ success: false, error: 'Invalid username' });
    }

    const cached = badgeCache.get(username);
    if (cached && cached.expires > Date.now()) {
      return res.json({ ...cached.payload, cached: true });
    }

    const db = getDb();
    const col = db.collection(COLLECTION);

    const docs = await col
      .find({ user: username }, { projection: projection() })
      .toArray();
    const byWindow = new Map(docs.map(d => [d.window, d]));

    // best[metric] = the strongest tier this user holds on that metric, across windows.
    const best = new Map();
    for (const window of WINDOWS_BY_PRESTIGE) {
      const doc = byWindow.get(window);
      if (!doc) continue; // no activity in that window at all
      for (const metric of METRICS) {
        const value = doc[metric] || 0;
        if (value <= 0) continue;
        const ahead = await col.countDocuments({ window, [metric]: { $gt: value } });
        const rank = ahead + 1;
        const tier = tierFor(rank);
        if (!tier) continue;
        const current = best.get(metric);
        // Strictly better rank wins; equal ranks keep the earlier (longer) window.
        if (!current || rank < current.rank) {
          best.set(metric, {
            metric,
            window,
            rank,
            value,
            tier: tier.tier,
            tier_label: tier.label,
          });
        }
      }
    }

    const badges = METRICS
      .map(m => best.get(m))
      .filter(Boolean)
      .sort((a, b) => a.rank - b.rank);

    const payload = {
      success: true,
      username,
      watch_tracked_since: WATCH_TRACKED_SINCE,
      badges,
    };
    badgeCache.set(username, { payload, expires: Date.now() + BADGE_TTL_MS });
    res.json(payload);
  } catch (err) {
    console.error('leaderboard badges error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to load leaderboard badges' });
  }
});

module.exports = router;
