/**
 * Creator analytics — YouTube-Studio-style stats for a user's OWN videos, built
 * from the watch-duration tracking (view-durations / view-heatmaps written by the
 * snapievideoplayer backend) joined with Hive votes/comments + GeoLite2 geo.
 *
 * Owner-scoped by `username`; the frontend only shows this on your own profile.
 *
 *   GET /analytics/overview       → totals + metrics + best-performing videos
 *   GET /analytics/timeseries     → daily watch-time / views for a trend chart
 *   GET /analytics/video          → per-video detail (retention + most-replayed)
 *   GET /analytics/demographics   → country + device/browser + time-of-day + new/returning
 *   GET /analytics/has-data       → does a video have any records (gates the Stats button)
 *
 * Common query params: days (7|28|90|365|0=all), content (all|videos|shorts).
 */
const express = require('express');
const router = express.Router();
const geoip = require('geoip-lite');
const { getDb } = require('../utils/db');
const { hiveRpcBatch } = require('../utils/hive');

const HIVE_RE = /^[a-z][a-z0-9.-]{2,15}$/;
const ID_RE = /^[a-z0-9._-]+$/i;
const WATCH_LOG = process.env.WATCH_LOG_COLLECTION || 'view-durations';
const WATCH_HEATMAP = process.env.WATCH_HEATMAP_COLLECTION || 'view-heatmaps';

// Watched seconds: prefer contentSeconds (speed-correct); fall back to
// watchedSeconds for rows written before that field existed.
const WATCH_SEC = { $ifNull: ['$contentSeconds', { $ifNull: ['$watchedSeconds', 0] }] };

const ALLOWED_DAYS = new Set([7, 28, 90, 365]);
function parseDays(req) {
  const d = parseInt(req.query.days, 10);
  return ALLOWED_DAYS.has(d) ? d : 0; // 0 = all time
}
function cutoffDate(days) {
  return days > 0 ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : null;
}
function dateMatch(days) {
  const c = cutoffDate(days);
  return c ? { updatedAt: { $gt: c } } : {};
}

// Videos vs Shorts filter → a match fragment on permlink (shorts live in
// embed-video with short:true).
async function contentMatch(db, username, content) {
  if (content !== 'videos' && content !== 'shorts') return {};
  const shorts = await db.collection('embed-video')
    .find({ owner: username, short: true }, { projection: { permlink: 1 } }).toArray();
  const set = shorts.map((s) => s.permlink);
  if (content === 'shorts') return { permlink: { $in: set } };
  return { permlink: { $nin: set } }; // videos = everything that isn't a short
}

// First few words of a post body (stripped of markdown/HTML/URLs) — used as a
// title for shorts, which usually have no title (just a description).
function bodySnippet(body, maxWords = 8) {
  if (!body) return '';
  const t = String(body)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')     // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')   // links → text
    .replace(/<[^>]+>/g, ' ')                  // html
    .replace(/https?:\/\/\S+/g, ' ')           // urls
    .replace(/[#*_>`~|-]+/g, ' ')              // markdown symbols
    .replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const parts = t.split(' ');
  return parts.slice(0, maxWords).join(' ') + (parts.length > maxWords ? '…' : '');
}

function parseUA(ua) {
  ua = String(ua || '');
  let device = 'Desktop';
  if (/iPad|Tablet/i.test(ua)) device = 'Tablet';
  else if (/Mobile|Android|iPhone|iPod/i.test(ua)) device = 'Mobile';
  else if (/\bTV\b|SmartTV|AppleTV/i.test(ua)) device = 'TV';
  let browser = 'Other';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/i.test(ua)) browser = 'Opera';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) browser = 'Chrome';
  else if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) browser = 'Safari';
  else if (/bot|crawl|spider|node/i.test(ua)) browser = 'Other';
  return { device, browser };
}

// Aggregate per-video watch stats for an owner, scoped by an extra match (date +
// content filters).
async function watchStatsByVideo(db, username, extra = {}) {
  return db.collection(WATCH_LOG).aggregate([
    { $match: { owner: username, ...extra } },
    { $group: {
      _id: '$permlink',
      sessions: { $sum: 1 },
      viewers: { $addToSet: '$ip' },
      watchSeconds: { $sum: WATCH_SEC },
      avgPct: { $avg: '$watchedPct' },
      avgRate: { $avg: '$avgRate' },
      duration: { $max: '$videoDuration' },
      lastWatched: { $max: '$updatedAt' },
    } },
    { $project: {
      _id: 0, permlink: '$_id', sessions: 1,
      viewers: { $size: '$viewers' },
      watchSeconds: { $round: ['$watchSeconds', 0] },
      avgPct: { $round: [{ $ifNull: ['$avgPct', 0] }, 1] },
      avgRate: { $round: [{ $ifNull: ['$avgRate', 1] }, 2] },
      duration: 1, lastWatched: 1,
    } },
    { $sort: { watchSeconds: -1 } },
  ]).toArray();
}

async function resolveVideoMeta(db, username, permlinks) {
  const [embeds, legacy] = await Promise.all([
    db.collection('embed-video').find(
      { owner: username, permlink: { $in: permlinks } },
      { projection: { permlink: 1, hive_author: 1, hive_permlink: 1, hive_title: 1, hive_body: 1, embed_url: 1, originalFilename: 1, thumbnail_url: 1, duration: 1, createdAt: 1, short: 1, views: 1 } },
    ).toArray(),
    db.collection('videos').find(
      { owner: username, permlink: { $in: permlinks } },
      { projection: { permlink: 1, title: 1, thumbnail: 1, duration: 1, created: 1, createdAt: 1, views: 1 } },
    ).toArray(),
  ]);
  const meta = {};
  for (const e of embeds) {
    // Snapie/embed shorts store their Hive post as `embed_url` (@author/permlink);
    // hive_permlink is often null. Parse it so we can fetch the real title/body/votes.
    const ep = (e.embed_url || '').replace(/^@/, '').split('/');
    meta[e.permlink] = {
      hiveTitle: e.hive_title || null,
      short: e.short === true,
      docSnippet: e.short === true ? bodySnippet(e.hive_body) : '', // from the embed doc, if present
      filename: e.originalFilename || '',
      thumbnail: e.thumbnail_url || `https://img.3speak.tv/${e.permlink}/thumbnail.png`,
      hiveAuthor: e.hive_author || ep[0] || username,
      hivePermlink: e.hive_permlink || ep[1] || e.permlink,
      duration: e.duration || 0,
      createdAt: e.createdAt || null,
      views: e.views || 0,
    };
  }
  for (const l of legacy) {
    if (meta[l.permlink]) continue;
    meta[l.permlink] = {
      hiveTitle: l.title || null,
      short: false,
      docSnippet: '',
      filename: '',
      thumbnail: l.thumbnail || `https://img.3speak.tv/${l.permlink}/thumbnail.png`,
      hiveAuthor: username,
      hivePermlink: l.permlink,
      duration: l.duration || 0,
      createdAt: l.created || l.createdAt || null,
      views: l.views || 0,
    };
  }
  return meta;
}

async function resolveAssetPermlink(db, owner, permlink) {
  const ev = await db.collection('embed-video').findOne(
    { owner, $or: [{ permlink }, { hive_permlink: permlink }] },
    { projection: { permlink: 1 } },
  );
  return ev?.permlink || permlink;
}

async function fetchHiveEngagement(refs) {
  const batch = refs.map((r, i) => ({
    jsonrpc: '2.0', id: i, method: 'condenser_api.get_content',
    params: [r.hiveAuthor, r.hivePermlink],
  }));
  if (!batch.length) return {};
  let results = [];
  try { results = await hiveRpcBatch(batch); } catch { results = []; }
  const byId = {};
  for (const r of results || []) if (r && r.id != null) byId[r.id] = r.result;
  const out = {};
  refs.forEach((r, i) => {
    const c = byId[i];
    out[`${r.hiveAuthor}/${r.hivePermlink}`] = {
      votes: c?.net_votes || 0,
      comments: c?.children || 0,
      payout: c ? parseFloat(c.pending_payout_value || c.total_payout_value || '0') || 0 : 0,
      created: c?.created || null,
      title: c?.title || null,
      snippet: bodySnippet(c?.body), // Hive post body → title fallback for shorts
    };
  });
  return out;
}

function fmtVideo(v, meta, eng) {
  const m = meta[v.permlink] || {};
  const e = (m.hivePermlink && eng[`${m.hiveAuthor}/${m.hivePermlink}`]) || {};
  // Title: prefer the Hive title. Shorts are usually untitled → use the first
  // words of the description (embed doc, else the Hive post body); never the raw
  // upload filename (fall back to "Untitled short"). Videos keep filename/permlink.
  const title = m.short
    ? (m.hiveTitle || e.title || m.docSnippet || e.snippet || 'Untitled short')
    : (m.hiveTitle || e.title || m.filename || v.permlink);
  return {
    permlink: v.permlink,
    hiveAuthor: m.hiveAuthor || null,
    hivePermlink: m.hivePermlink || v.permlink,
    title,
    thumbnail: m.thumbnail || null,
    short: !!m.short,
    duration: v.duration || m.duration || 0,
    realViews: m.views || 0,
    sessions: v.sessions,
    viewers: v.viewers,
    watchSeconds: v.watchSeconds,
    watchPerView: v.sessions ? Math.round(v.watchSeconds / v.sessions) : 0,
    avgPct: v.avgPct,
    avgRate: v.avgRate,
    votes: e.votes || 0,
    comments: e.comments || 0,
    payout: e.payout || 0,
    created: e.created || m.createdAt || null,
    lastWatched: v.lastWatched,
  };
}

// GET /analytics/overview?username=X&days=&content=
router.get('/analytics/overview', async (req, res) => {
  try {
    const username = String(req.query.username || '').toLowerCase();
    if (!HIVE_RE.test(username)) return res.status(400).json({ success: false, error: 'invalid username' });
    const db = getDb();
    const days = parseDays(req);
    const content = req.query.content;
    const extra = { ...dateMatch(days), ...(await contentMatch(db, username, content)) };

    const perVideo = await watchStatsByVideo(db, username, extra);
    const emptyTotals = { videos: 0, sessions: 0, viewers: 0, watchSeconds: 0, avgViewDuration: 0, avgPct: 0, avgRate: 1, engagementRate: 0, payout: 0 };
    if (!perVideo.length) {
      return res.json({ success: true, username, days, content: content || 'all', totals: emptyTotals, videos: [], best: { byWatchTime: [], byVotes: [], byComments: [] } });
    }
    const permlinks = perVideo.map((v) => v.permlink);
    const meta = await resolveVideoMeta(db, username, permlinks);
    const refs = perVideo.map((v) => meta[v.permlink]).filter((m) => m && m.hivePermlink)
      .map((m) => ({ hiveAuthor: m.hiveAuthor, hivePermlink: m.hivePermlink }));
    const eng = await fetchHiveEngagement(refs);

    const videos = perVideo.map((v) => fmtVideo(v, meta, eng));
    const uniqueViewers = (await db.collection(WATCH_LOG).distinct('ip', { owner: username, ...extra })).length;

    let totalWatch = 0, totalSessions = 0, totalVotes = 0, totalComments = 0, totalPayout = 0, totalRealViews = 0, pctW = 0, rateW = 0;
    for (const v of videos) {
      totalWatch += v.watchSeconds; totalSessions += v.sessions;
      totalVotes += v.votes; totalComments += v.comments; totalPayout += v.payout;
      totalRealViews += v.realViews;
      pctW += (v.avgPct || 0) * v.sessions; rateW += (v.avgRate || 1) * v.sessions;
    }
    const totals = {
      videos: videos.length,
      sessions: totalSessions,
      viewers: uniqueViewers,
      watchSeconds: totalWatch,
      avgViewDuration: totalSessions ? Math.round(totalWatch / totalSessions) : 0,
      avgPct: totalSessions ? Math.round((pctW / totalSessions) * 10) / 10 : 0,
      avgRate: totalSessions ? Math.round((rateW / totalSessions) * 100) / 100 : 1,
      // Likes+comments per REAL view (the video's own view counter), not per
      // tracked session — otherwise all-time votes over a small tracked sample
      // inflates it wildly.
      engagementRate: totalRealViews ? Math.round(((totalVotes + totalComments) / totalRealViews) * 1000) / 10 : 0,
      votes: totalVotes,
      comments: totalComments,
      payout: Math.round(totalPayout * 100) / 100,
    };

    const topN = (key) => [...videos].sort((a, b) => (b[key] || 0) - (a[key] || 0)).slice(0, 8);
    res.json({
      success: true, username, days, content: content || 'all',
      totals,
      videos,
      best: { byWatchTime: topN('watchSeconds'), byVotes: topN('votes'), byComments: topN('comments') },
    });
  } catch (err) {
    console.error('analytics/overview error:', err);
    res.status(500).json({ success: false, error: 'internal error' });
  }
});

// GET /analytics/timeseries?username=X&days=&content=  → daily watch-time + views
router.get('/analytics/timeseries', async (req, res) => {
  try {
    const username = String(req.query.username || '').toLowerCase();
    if (!HIVE_RE.test(username)) return res.status(400).json({ success: false, error: 'invalid username' });
    const db = getDb();
    const days = parseDays(req) || 28; // default to a 28-day trend
    const content = req.query.content;
    const extra = { ...dateMatch(days), ...(await contentMatch(db, username, content)) };

    const rows = await db.collection(WATCH_LOG).aggregate([
      { $match: { owner: username, ...extra } },
      { $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$updatedAt' } },
        watchSeconds: { $sum: WATCH_SEC },
        views: { $sum: 1 },
        viewers: { $addToSet: '$ip' },
      } },
      { $project: { _id: 0, date: '$_id', watchSeconds: { $round: ['$watchSeconds', 0] }, views: 1, viewers: { $size: '$viewers' } } },
      { $sort: { date: 1 } },
    ]).toArray();

    // Fill missing days with zeros so the chart is continuous.
    const byDate = Object.fromEntries(rows.map((r) => [r.date, r]));
    const series = [];
    const start = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000);
    for (let i = 0; i < days; i++) {
      const d = new Date(start.getTime() + i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      series.push(byDate[d] || { date: d, watchSeconds: 0, views: 0, viewers: 0 });
    }
    res.json({ success: true, username, days, content: content || 'all', series });
  } catch (err) {
    console.error('analytics/timeseries error:', err);
    res.status(500).json({ success: false, error: 'internal error' });
  }
});

// GET /analytics/has-data?username=X&permlink=Y
router.get('/analytics/has-data', async (req, res) => {
  try {
    const username = String(req.query.username || '').toLowerCase();
    const permlink = String(req.query.permlink || '').trim();
    if (!HIVE_RE.test(username) || !ID_RE.test(permlink)) {
      return res.status(400).json({ success: false, error: 'invalid username/permlink' });
    }
    const db = getDb();
    const assetPermlink = await resolveAssetPermlink(db, username, permlink);
    const sessions = await db.collection(WATCH_LOG).countDocuments({ owner: username, permlink: assetPermlink });
    res.json({ success: true, hasData: sessions > 0, sessions });
  } catch (err) {
    console.error('analytics/has-data error:', err);
    res.status(500).json({ success: false, error: 'internal error' });
  }
});

// GET /analytics/video?username=X&permlink=Y  (all-time; retention + most-replayed)
router.get('/analytics/video', async (req, res) => {
  try {
    const username = String(req.query.username || '').toLowerCase();
    const permlink = String(req.query.permlink || '').trim();
    if (!HIVE_RE.test(username) || !ID_RE.test(permlink)) {
      return res.status(400).json({ success: false, error: 'invalid username/permlink' });
    }
    const db = getDb();
    const assetPermlink = await resolveAssetPermlink(db, username, permlink);

    const rows = await db.collection(WATCH_LOG)
      .find({ owner: username, permlink: assetPermlink }, { projection: { ip: 1, watchedSeconds: 1, contentSeconds: 1, watchedPct: 1, startPosition: 1, lastPosition: 1, maxPosition: 1, videoDuration: 1, avgRate: 1 } })
      .toArray();
    if (!rows.length) return res.json({ success: true, username, permlink: assetPermlink, sessions: 0 });

    const duration = rows.reduce((m, r) => Math.max(m, r.videoDuration || 0), 0) || 1;
    const sessions = rows.length;
    const viewers = new Set(rows.map((r) => r.ip)).size;
    const watchSeconds = rows.reduce((s, r) => s + (r.contentSeconds ?? r.watchedSeconds ?? 0), 0);
    const avgPct = Math.round((rows.reduce((s, r) => s + (r.watchedPct || 0), 0) / sessions) * 10) / 10;
    const avgRate = Math.round((rows.reduce((s, r) => s + (r.avgRate || 1), 0) / sessions) * 100) / 100;

    const N = 100;
    const retention = new Array(N).fill(0);
    for (const r of rows) {
      const a = Math.max(0, Number(r.startPosition) || 0);
      const b = Math.max(a, Number(r.maxPosition) || 0, Number(r.lastPosition) || 0);
      const b0 = Math.min(N - 1, Math.floor((a / duration) * N));
      const b1 = Math.min(N - 1, Math.floor((b / duration) * N));
      for (let i = b0; i <= b1; i++) retention[i]++;
    }
    const retentionPct = retention.map((c) => Math.round((c / sessions) * 1000) / 10);

    const hm = await db.collection(WATCH_HEATMAP).findOne({ owner: username, permlink: assetPermlink });
    let replay = { bucketCount: N, normalized: [] };
    if (hm && Array.isArray(hm.buckets)) {
      const max = hm.buckets.reduce((m, x) => Math.max(m, Number(x) || 0), 0);
      replay = {
        bucketCount: hm.bucketCount || hm.buckets.length,
        normalized: max > 0 ? hm.buckets.map((x) => Math.round(((Number(x) || 0) / max) * 1000) / 1000) : hm.buckets.map(() => 0),
      };
    }

    res.json({
      success: true, username, permlink: assetPermlink, duration,
      sessions, viewers, watchSeconds, avgPct, avgRate,
      retention: retentionPct,
      replay,
    });
  } catch (err) {
    console.error('analytics/video error:', err);
    res.status(500).json({ success: false, error: 'internal error' });
  }
});

// GET /analytics/demographics?username=X&days=&content=
router.get('/analytics/demographics', async (req, res) => {
  try {
    const username = String(req.query.username || '').toLowerCase();
    if (!HIVE_RE.test(username)) return res.status(400).json({ success: false, error: 'invalid username' });
    const db = getDb();
    const days = parseDays(req);
    const content = req.query.content;
    const extra = { ...dateMatch(days), ...(await contentMatch(db, username, content)) };
    const match = { owner: username, ...extra };

    // Sessions per distinct IP → countries (viewers = distinct IPs).
    const perIp = await db.collection(WATCH_LOG).aggregate([
      { $match: match },
      { $group: { _id: '$ip', sessions: { $sum: 1 } } },
    ]).toArray();
    const countries = {};
    let located = 0, unknown = 0;
    for (const row of perIp) {
      const g = row._id ? geoip.lookup(row._id) : null;
      if (g && g.country) {
        located += 1;
        const c = countries[g.country] || (countries[g.country] = { country: g.country, sessions: 0, viewers: 0 });
        c.sessions += row.sessions; c.viewers += 1;
      } else { unknown += 1; }
    }
    const byCountry = Object.values(countries).sort((a, b) => b.viewers - a.viewers);

    // Device / browser from userAgent (parse the distinct UAs, then sum counts).
    const uaAgg = await db.collection(WATCH_LOG).aggregate([
      { $match: match },
      { $group: { _id: '$userAgent', sessions: { $sum: 1 } } },
    ]).toArray();
    const devices = {}, browsers = {};
    for (const u of uaAgg) {
      const { device, browser } = parseUA(u._id);
      devices[device] = (devices[device] || 0) + u.sessions;
      browsers[browser] = (browsers[browser] || 0) + u.sessions;
    }
    const toSorted = (obj, key) => Object.entries(obj).map(([k, sessions]) => ({ [key]: k, sessions })).sort((a, b) => b.sessions - a.sessions);

    // Where the view happened: '3speak' (native site) vs 'player' (embed iframe).
    // Rows predating source tracking have no field → count them as 'player'.
    const srcAgg = await db.collection(WATCH_LOG).aggregate([
      { $match: match },
      { $group: { _id: { $ifNull: ['$source', 'player'] }, sessions: { $sum: 1 } } },
    ]).toArray();
    const bySource = srcAgg
      .map((s) => ({ source: s._id || 'player', sessions: s.sessions }))
      .sort((a, b) => b.sessions - a.sessions);

    // When viewers watch: 7×24 (day-of-week × hour, UTC) session matrix.
    const dowHour = await db.collection(WATCH_LOG).aggregate([
      { $match: match },
      { $group: { _id: { dow: { $dayOfWeek: '$startedAt' }, hour: { $hour: '$startedAt' } }, sessions: { $sum: 1 } } },
    ]).toArray();
    const heatmap = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (const d of dowHour) {
      const dow = (d._id.dow || 1) - 1; // Mongo $dayOfWeek: 1=Sun..7=Sat → 0..6
      const hour = d._id.hour || 0;
      if (dow >= 0 && dow < 7 && hour >= 0 && hour < 24) heatmap[dow][hour] += d.sessions;
    }

    // New vs returning: a viewer is "returning" if they have more than one watch
    // session in this range (i.e. they came back), otherwise "new".
    let newViewers = 0, returningViewers = 0;
    for (const r of perIp) {
      if ((r.sessions || 0) >= 2) returningViewers += 1; else newViewers += 1;
    }

    res.json({
      success: true, username, days, content: content || 'all',
      totalViewers: perIp.length,
      locatedViewers: located,
      unknownViewers: unknown,
      byCountry,
      byDevice: toSorted(devices, 'device'),
      byBrowser: toSorted(browsers, 'browser'),
      bySource,                  // [{ source, sessions }] — 3speak vs embed player
      whenHeatmap: heatmap,      // [7][24] sessions
      newViewers,
      returningViewers,
    });
  } catch (err) {
    console.error('analytics/demographics error:', err);
    res.status(500).json({ success: false, error: 'internal error' });
  }
});

module.exports = router;
