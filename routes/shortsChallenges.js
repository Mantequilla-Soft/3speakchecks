/**
 * 🏁 Weekly Shorts challenge (utils/shortsChallenge.js has the model; weeks run
 * Sunday to Saturday, UTC).
 *
 * Public:
 *   GET /shorts-challenges                  this week, next week and the 8 before,
 *                                           each with its checked-entry count
 *   GET /shorts-challenges/:week            one week ('2026-W48'), with its count
 *   GET /shorts-challenges/:week/entries    the week's CHECKED entries, newest
 *                                           first, in the tag feed's video shape
 *                                           (?page, ?limit)
 *
 * Admin (Authorization: Bearer AD_ADMIN_SECRET, the same admin secret the ads
 * admin uses, so the one admin frontend reaches both; 503 while it is unset):
 *   GET /admin/shorts-challenges            every week, with pending / checked /
 *                                           rejected counts
 *   PUT /admin/shorts-challenges/:week      create or change a week's prompts:
 *                                           { theme?, texts: { en: { title, prompt }, ... } }
 *   GET /admin/shorts-challenges/:week/entries?status=pending|checked|rejected|all
 *                                           the entries to review, with the Short's
 *                                           caption, picture and link
 *   PUT /admin/shorts-challenge-entries/:owner/:permlink
 *                                           { checked: true|false, by?: 'name' }:
 *                                           true counts it, false turns it down
 *
 * Every gate is scoped to its own paths: this router is mounted at '/' (see the
 * streamStats ordering note in server.js).
 */
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { getDb } = require('../utils/db');
const { hiddenListSync } = require('../utils/hiddenCreators');
const { unavailableMatch } = require('../utils/unavailable');
const { hiddenFromFeedMatch } = require('../utils/hiddenFromFeed');
const {
  CHALLENGES, ENTRIES, weekIdOf, isWeekId, tagOf, weekStart, weekEnd, cleanTexts,
  ensureReady, syncEntries, statusOf, statusFilter,
} = require('../utils/shortsChallenge');

const router = express.Router();

const ACCOUNT_RE = /^[a-z][a-z0-9.-]{2,15}$/;
const PERMLINK_RE = /^[a-z0-9-]{1,255}$/;
const THEME_RE = /^[A-Za-z0-9_-]{1,40}$/;
const PAST_COUNT = 8;
const MAX_LIMIT = 50;

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: false,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests' },
});

const ADMIN_SECRET = () => process.env.AD_ADMIN_SECRET || '';
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ab, bb); } catch { return false; }
}
function requireAdmin(req, res, next) {
  const secret = ADMIN_SECRET();
  if (!secret) return res.status(503).json({ success: false, error: 'Challenge admin disabled (no AD_ADMIN_SECRET set)' });
  const header = String(req.get('authorization') || '');
  const provided = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!provided || !safeEqual(provided, secret)) return res.status(401).json({ success: false, error: 'unauthorized' });
  return next();
}

const pageOf = (req) => Math.max(parseInt(req.query.page, 10) || 1, 1);
const limitOf = (req, def = 24) => Math.min(Math.max(parseInt(req.query.limit, 10) || def, 1), MAX_LIMIT);

/** A challenge doc as the API shows it. */
function publicChallenge(doc, counts = {}) {
  if (!doc) return null;
  return {
    week: doc.week,
    tag: doc.tag,
    theme: doc.theme,
    texts: doc.texts || {},
    starts_at: doc.starts_at,
    ends_at: doc.ends_at,
    entries: counts[doc.week] || 0,
  };
}

/** Checked entries per week, for these weeks. */
async function checkedCounts(db, weeks) {
  if (!weeks.length) return {};
  const rows = await db.collection(ENTRIES).aggregate([
    { $match: { week: { $in: weeks }, checked: true } },
    { $group: { _id: '$week', n: { $sum: 1 } } },
  ]).toArray();
  return Object.fromEntries(rows.map((r) => [r._id, r.n]));
}

/** The Short as the tag feed shows a video (the frontend's Card3 reads this shape). */
function feedShape(ev, entry) {
  const author = ev.hive_author || entry.hive_author || ev.owner;
  return {
    owner: ev.owner,
    author,
    permlink: ev.hive_permlink || entry.hive_permlink || ev.permlink,
    title: ev.hive_title || ev.embed_title || '',
    body: ev.hive_body || '',
    status: 'published',
    created: ev.createdAt,
    created_at: ev.createdAt,
    duration: ev.duration || 0,
    tags: ev.hive_tags || [],
    tags_v2: (ev.hive_tags || []).map((t) => String(t).toLowerCase()),
    images: {
      thumbnail: ev.thumbnail_url || `https://img.3speak.tv/${ev.permlink}/thumbnail.png`,
      poster: ev.thumbnail_url || `https://img.3speak.tv/${ev.permlink}/poster.jpg`,
    },
    spkvideo: {
      duration: ev.duration || 0,
      video_v2: ev.permlink,
      play_url: ev.manifest_cid ? `https://ipfs.3speak.tv/ipfs/${ev.manifest_cid}` : null,
    },
    short: true,
    embed_url: ev.embed_url || null,
    embed_permlink: ev.permlink,
  };
}

const EMBED_FIELDS = {
  owner: 1, permlink: 1, hive_author: 1, hive_permlink: 1, hive_title: 1, embed_title: 1, hive_body: 1,
  createdAt: 1, duration: 1, hive_tags: 1, thumbnail_url: 1, manifest_cid: 1, embed_url: 1, status: 1,
};

/** The embed-video docs of these entries, by owner/permlink. */
async function embedsOf(db, entries, extraMatch = {}) {
  if (!entries.length) return new Map();
  const docs = await db.collection('embed-video').find(
    { $or: entries.map((e) => ({ owner: e.owner, permlink: e.permlink })), ...extraMatch },
    { projection: EMBED_FIELDS },
  ).toArray();
  return new Map(docs.map((d) => [`${d.owner}/${d.permlink}`, d]));
}

// ── Public ───────────────────────────────────────────────────────────────────

router.get('/shorts-challenges', limiter, async (req, res) => {
  const db = getDb();
  await ensureReady(db);
  const now = new Date();
  const thisWeek = weekIdOf(now);
  const col = db.collection(CHALLENGES);
  const [current, next, past] = await Promise.all([
    col.findOne({ _id: thisWeek }),
    col.find({ starts_at: { $gt: now } }).sort({ starts_at: 1 }).limit(1).next(),
    col.find({ ends_at: { $lt: weekStart(thisWeek) } }).sort({ starts_at: -1 }).limit(PAST_COUNT).toArray(),
  ]);
  const counts = await checkedCounts(db, [current, ...past].filter(Boolean).map((c) => c.week));
  res.set('Cache-Control', 'public, max-age=60');
  return res.json({
    success: true,
    week: thisWeek,
    current: publicChallenge(current, counts),
    next: publicChallenge(next, counts),
    past: past.map((c) => publicChallenge(c, counts)),
  });
});

router.get('/shorts-challenges/:week', limiter, async (req, res) => {
  const week = String(req.params.week).toUpperCase();
  if (!isWeekId(week)) return res.status(400).json({ success: false, error: 'Bad week (use 2026-W48)' });
  const db = getDb();
  await ensureReady(db);
  const doc = await db.collection(CHALLENGES).findOne({ _id: week });
  if (!doc) return res.status(404).json({ success: false, error: 'No challenge that week' });
  const counts = await checkedCounts(db, [week]);
  res.set('Cache-Control', 'public, max-age=60');
  return res.json({ success: true, challenge: publicChallenge(doc, counts) });
});

router.get('/shorts-challenges/:week/entries', limiter, async (req, res) => {
  const week = String(req.params.week).toUpperCase();
  if (!isWeekId(week)) return res.status(400).json({ success: false, error: 'Bad week (use 2026-W48)' });
  const db = getDb();
  await ensureReady(db);
  const challenge = await db.collection(CHALLENGES).findOne({ _id: week });
  if (!challenge) return res.status(404).json({ success: false, error: 'No challenge that week' });
  await syncEntries(db, challenge).catch((err) => console.warn('[shorts-challenge] sync failed:', err.message));

  const page = pageOf(req);
  const limit = limitOf(req);
  const hidden = hiddenListSync();
  const filter = { week, checked: true, ...(hidden.length ? { owner: { $nin: hidden } } : {}) };
  const [total, rows] = await Promise.all([
    db.collection(ENTRIES).countDocuments(filter),
    db.collection(ENTRIES).find(filter).sort({ posted_at: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
  ]);
  // Only what is still up: published, not taken down, not hidden from feeds
  const embeds = await embedsOf(db, rows, { status: 'published', ...unavailableMatch(), ...hiddenFromFeedMatch() });
  const videos = rows.map((e) => embeds.get(`${e.owner}/${e.permlink}`) && feedShape(embeds.get(`${e.owner}/${e.permlink}`), e)).filter(Boolean);
  res.set('Cache-Control', 'public, max-age=60');
  return res.json({ success: true, week, tag: challenge.tag, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)), videos });
});

// ── Admin ────────────────────────────────────────────────────────────────────

router.get('/admin/shorts-challenges', requireAdmin, async (req, res) => {
  const db = getDb();
  await ensureReady(db);
  const [docs, rows] = await Promise.all([
    db.collection(CHALLENGES).find({}).sort({ starts_at: 1 }).toArray(),
    db.collection(ENTRIES).aggregate([
      { $group: {
        _id: '$week',
        checked: { $sum: { $cond: ['$checked', 1, 0] } },
        rejected: { $sum: { $cond: [{ $and: [{ $ne: ['$checked', true] }, { $ne: ['$reviewed_at', null] }] }, 1, 0] } },
        total: { $sum: 1 },
      } },
    ]).toArray(),
  ]);
  const byWeek = Object.fromEntries(rows.map((r) => [r._id, r]));
  const thisWeek = weekIdOf();
  return res.json({
    success: true,
    week: thisWeek,
    challenges: docs.map((d) => {
      const r = byWeek[d.week] || { checked: 0, rejected: 0, total: 0 };
      return {
        ...publicChallenge(d),
        entries: { checked: r.checked, rejected: r.rejected, pending: r.total - r.checked - r.rejected, total: r.total },
        updated_at: d.updated_at,
      };
    }),
  });
});

router.put('/admin/shorts-challenges/:week', requireAdmin, async (req, res) => {
  const week = String(req.params.week).toUpperCase();
  if (!isWeekId(week)) return res.status(400).json({ success: false, error: 'Bad week (use 2026-W48)' });
  const { texts, error } = cleanTexts(req.body?.texts);
  if (error) return res.status(400).json({ success: false, error });
  const theme = req.body?.theme == null ? null : String(req.body.theme);
  if (theme != null && !THEME_RE.test(theme)) return res.status(400).json({ success: false, error: 'theme: letters, digits, - and _ only' });
  const db = getDb();
  await ensureReady(db);
  const now = new Date();
  await db.collection(CHALLENGES).updateOne(
    { _id: week },
    {
      $set: { texts, updated_at: now, ...(theme ? { theme } : {}) },
      $setOnInsert: {
        week,
        tag: tagOf(week),
        starts_at: weekStart(week),
        ends_at: weekEnd(week),
        created_at: now,
        ...(theme ? {} : { theme: `week-${week.toLowerCase()}` }),
      },
    },
    { upsert: true },
  );
  const doc = await db.collection(CHALLENGES).findOne({ _id: week });
  return res.json({ success: true, challenge: publicChallenge(doc) });
});

router.get('/admin/shorts-challenges/:week/entries', requireAdmin, async (req, res) => {
  const week = String(req.params.week).toUpperCase();
  if (!isWeekId(week)) return res.status(400).json({ success: false, error: 'Bad week (use 2026-W48)' });
  const db = getDb();
  await ensureReady(db);
  const challenge = await db.collection(CHALLENGES).findOne({ _id: week });
  if (!challenge) return res.status(404).json({ success: false, error: 'No challenge that week' });
  // The team wants to see what came in just now
  await syncEntries(db, challenge, { force: true }).catch((err) => console.warn('[shorts-challenge] sync failed:', err.message));

  const status = ['pending', 'checked', 'rejected'].includes(req.query.status) ? req.query.status : 'all';
  const page = pageOf(req);
  const limit = limitOf(req, 50);
  const filter = { week, ...statusFilter(status) };
  const [total, rows] = await Promise.all([
    db.collection(ENTRIES).countDocuments(filter),
    db.collection(ENTRIES).find(filter).sort({ posted_at: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
  ]);
  const embeds = await embedsOf(db, rows);
  return res.json({
    success: true,
    week,
    tag: challenge.tag,
    status,
    page,
    limit,
    total,
    entries: rows.map((e) => {
      const ev = embeds.get(`${e.owner}/${e.permlink}`) || null;
      const author = e.hive_author || ev?.hive_author || e.owner;
      return {
        owner: e.owner,
        permlink: e.permlink,
        hive_author: e.hive_author || ev?.hive_author || null,
        hive_permlink: e.hive_permlink || ev?.hive_permlink || null,
        status: statusOf(e),
        checked: !!e.checked,
        reviewed_at: e.reviewed_at || null,
        reviewed_by: e.reviewed_by || null,
        posted_at: e.posted_at,
        found_at: e.found_at,
        video_status: ev?.status || 'gone',
        caption: ev?.hive_body || ev?.hive_title || ev?.embed_title || '',
        thumbnail: ev?.thumbnail_url || null,
        url: `https://3speak.tv/shorts?v=${author}/${e.permlink}`,
      };
    }),
  });
});

router.put('/admin/shorts-challenge-entries/:owner/:permlink', requireAdmin, async (req, res) => {
  const owner = String(req.params.owner).toLowerCase();
  const permlink = String(req.params.permlink);
  if (!ACCOUNT_RE.test(owner) || !PERMLINK_RE.test(permlink)) return res.status(400).json({ success: false, error: 'Bad owner or permlink' });
  if (typeof req.body?.checked !== 'boolean') return res.status(400).json({ success: false, error: 'checked must be true or false' });
  const by = typeof req.body?.by === 'string' ? req.body.by.trim().slice(0, 64) || null : null;
  const db = getDb();
  await ensureReady(db);
  const res2 = await db.collection(ENTRIES).findOneAndUpdate(
    { owner, permlink },
    { $set: { checked: req.body.checked, reviewed_at: new Date(), reviewed_by: by } },
    { returnDocument: 'after' },
  );
  const entry = res2 && Object.prototype.hasOwnProperty.call(res2, 'value') ? res2.value : res2;
  if (!entry) return res.status(404).json({ success: false, error: 'No such entry' });
  return res.json({ success: true, entry: { owner: entry.owner, permlink: entry.permlink, week: entry.week, status: statusOf(entry), checked: entry.checked, reviewed_at: entry.reviewed_at, reviewed_by: entry.reviewed_by } });
});

module.exports = router;
