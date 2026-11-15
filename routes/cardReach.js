/**
 * Card reach: how often a video's card was SEEN, on which surface (Home tabs,
 * search, a channel, related videos...), and how often the video was OPENED and
 * from where (one of those surfaces, an outside link, an embed). Creator stats
 * turn it into impressions, click-through rate and "where viewers found it".
 *
 *   POST /reach/seen  { rate, items: [{ a, p, s }] }   cards seen (sampled)
 *   POST /reach/open  { a, p, s }                      a video opened from s
 *   GET  /creator-stats/reach?username=&days=&content=  the creator's numbers
 *
 * The names stay clear of "analytics", "impression" and "track": blocker lists
 * match those words in URLs and would silently drop the requests.
 *
 * WHAT IS STORED: one counter row per (day, video, surface) with `seen` and
 * `opens`, nothing about who saw or opened it. The caller's address is only used
 * for the in-memory throttles below, never written. Rows expire after
 * CARD_REACH_TTL_DAYS.
 *
 * SAMPLING: a page decides once per page view whether it reports what it shows
 * (probability `rate`), so each reported card stands for 1/rate cards. The rate
 * must be one of CARD_REACH_RATES, which keeps a client from claiming a tiny one
 * to multiply its reports. Opens are never sampled.
 *
 * WHAT IS NOT COUNTED: agents that say they are automated (utils/crawlerUa.js),
 * datacenter addresses (utils/datacenterIp.js), more than CARD_REACH_SEEN_PER_HOUR
 * cards per address an hour, and a second open of one video from one address
 * within CARD_REACH_OPEN_WINDOW_MIN (a reload is not a second visit).
 *
 * The old `views` counter is not used anywhere here.
 */
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const { getDb } = require('../utils/db');
const { clientIp } = require('../utils/clientIp');
const { isCrawlerUa } = require('../utils/crawlerUa');
const { isDatacenterIp } = require('../utils/datacenterIp');
const {
  CARD_REACH_COLLECTION, CARD_REACH_TTL_DAYS, CARD_REACH_RATES,
  CARD_REACH_SEEN_PER_HOUR, CARD_REACH_OPEN_WINDOW_MIN, ENABLE_MONGO_WRITES,
} = require('../utils/config');

const router = express.Router();

// Where a card can be seen (and so opened from) inside the app.
const CARD_SURFACES = ['home', 'discover', 'following', 'new', 'trending', 'interests', 'search',
  'channel', 'related', 'shorts', 'playlist', 'tag', 'community', 'other'];
// Where an open can come from without a card: classified by the page from
// document.referrer (or the embed page itself).
const OUTSIDE_SOURCES = ['direct', 'search_engine', 'social', 'hive_apps', 'external', 'embed'];
const CARD_SET = new Set(CARD_SURFACES);
const OPEN_SET = new Set([...CARD_SURFACES, ...OUTSIDE_SOURCES]);

const AUTHOR_RE = /^[a-z0-9][a-z0-9.-]{1,15}$/;
const PERMLINK_RE = /^[a-z0-9][a-z0-9._-]{0,254}$/i;
const MAX_ITEMS = 60;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const col = () => getDb().collection(CARD_REACH_COLLECTION);

let indexesEnsured = false;
async function ensureIndexes() {
  if (indexesEnsured) return;
  indexesEnsured = true;
  try {
    await col().createIndex({ author: 1, day: 1 });
    await col().createIndex({ at: 1 }, { expireAfterSeconds: CARD_REACH_TTL_DAYS * 86400 });
  } catch (err) {
    indexesEnsured = false;
    console.error('[cardReach] index setup failed:', err && err.message);
  }
}

const dayOf = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

function cleanRef(a, p) {
  const author = String(a || '').trim().toLowerCase().replace(/^@/, '');
  const permlink = String(p || '').trim();
  if (!AUTHOR_RE.test(author) || !PERMLINK_RE.test(permlink)) return null;
  return { author, permlink };
}

// A body sent with navigator.sendBeacon arrives as text/plain (a JSON content
// type would need a CORS preflight a beacon cannot make), so parse it here.
function bodyOf(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  const raw = typeof req.body === 'string' ? req.body : Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  try { return JSON.parse(raw); } catch { return {}; }
}
const textBody = express.text({ type: 'text/plain', limit: '16kb' });

function automated(req) {
  return isCrawlerUa(req.get('user-agent')) || isDatacenterIp(clientIp(req));
}

// Per-address budgets, in memory. The key is a hash of the address with a
// per-process salt, so even this map holds no address.
const SALT = crypto.randomBytes(16);
const addrKey = (req) => crypto.createHmac('sha256', SALT).update(clientIp(req) || '').digest('hex').slice(0, 24);

const seenBudget = new Map(); // addr -> { start, n }
function takeSeenBudget(addr, want, now = Date.now()) {
  let b = seenBudget.get(addr);
  if (!b || now - b.start > HOUR) { b = { start: now, n: 0 }; seenBudget.set(addr, b); }
  const allowed = Math.max(0, Math.min(want, CARD_REACH_SEEN_PER_HOUR - b.n));
  b.n += allowed;
  if (seenBudget.size > 50000) seenBudget.delete(seenBudget.keys().next().value);
  return allowed;
}

const recentOpens = new Map(); // `${addr}|${author}/${permlink}` -> at
function firstOpen(addr, ref, now = Date.now()) {
  const key = `${addr}|${ref.author}/${ref.permlink}`;
  const at = recentOpens.get(key);
  if (at && now - at < CARD_REACH_OPEN_WINDOW_MIN * 60 * 1000) return false;
  recentOpens.delete(key);
  recentOpens.set(key, now);
  if (recentOpens.size > 50000) recentOpens.delete(recentOpens.keys().next().value);
  return true;
}

const limiter = (max) => rateLimit({
  windowMs: 60 * 1000, max, standardHeaders: false, legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(clientIp(req) || ''), validate: { xForwardedForHeader: false, ip: false },
  message: { success: false, error: 'Too many requests' },
});

function incOp(day, ref, surface, field, by) {
  return {
    updateOne: {
      filter: { _id: `${day}|${ref.author}/${ref.permlink}|${surface}` },
      update: {
        $inc: { [field]: by },
        $setOnInsert: { day, at: new Date(`${day}T00:00:00Z`), author: ref.author, permlink: ref.permlink, surface },
      },
      upsert: true,
    },
  };
}

router.post('/reach/seen', limiter(30), textBody, async (req, res) => {
  // Nothing here is worth an error to the page: it never retries, it just stops.
  if (automated(req)) return res.status(204).end();
  const b = bodyOf(req);
  const rate = Number(b.rate);
  if (!CARD_REACH_RATES.includes(rate)) return res.status(400).json({ success: false, error: 'bad rate' });
  const items = Array.isArray(b.items) ? b.items.slice(0, MAX_ITEMS) : [];
  // One count per card and surface per batch, whatever the batch repeats.
  const unique = new Map();
  for (const it of items) {
    const ref = cleanRef(it && it.a, it && it.p);
    const s = String((it && it.s) || '');
    if (!ref || !CARD_SET.has(s)) continue;
    unique.set(`${ref.author}/${ref.permlink}|${s}`, { ref, s });
  }
  const allowed = takeSeenBudget(addrKey(req), unique.size);
  if (!allowed || !ENABLE_MONGO_WRITES) return res.status(204).end();
  const day = dayOf();
  const weight = Math.round((1 / rate) * 100) / 100;
  const ops = [...unique.values()].slice(0, allowed).map(({ ref, s }) => incOp(day, ref, s, 'seen', weight));
  try {
    await ensureIndexes();
    await col().bulkWrite(ops, { ordered: false });
    res.status(204).end();
  } catch (err) {
    console.error('[cardReach] seen failed:', err && err.message);
    res.status(500).json({ success: false, error: 'internal error' });
  }
});

router.post('/reach/open', limiter(60), textBody, async (req, res) => {
  if (automated(req)) return res.status(204).end();
  const b = bodyOf(req);
  const ref = cleanRef(b.a, b.p);
  const s = String(b.s || '');
  if (!ref || !OPEN_SET.has(s)) return res.status(400).json({ success: false, error: 'bad item' });
  if (!firstOpen(addrKey(req), ref) || !ENABLE_MONGO_WRITES) return res.status(204).end();
  try {
    await ensureIndexes();
    await col().bulkWrite([incOp(dayOf(), ref, s, 'opens', 1)]);
    res.status(204).end();
  } catch (err) {
    console.error('[cardReach] open failed:', err && err.message);
    res.status(500).json({ success: false, error: 'internal error' });
  }
});

/* ── reading it back for creator stats ─────────────────────────────────── */

const HIVE_RE = /^[a-z][a-z0-9.-]{2,15}$/;
const ALLOWED_DAYS = new Set([7, 28, 90, 365]);
const WATCH_LOG = process.env.WATCH_LOG_COLLECTION || 'view-durations';
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map(); // key -> { at, promise }

// The videos and shorts of a creator, by both of their names: a card may carry
// the Hive permlink or (shorts) the asset permlink. `key` is what stats use (the
// asset permlink, as in routes/analytics.js).
async function creatorItems(db, username) {
  const [embeds, legacy] = await Promise.all([
    db.collection('embed-video').find({ owner: username }, {
      projection: { permlink: 1, hive_permlink: 1, hive_author: 1, embed_url: 1, short: 1, is_openpod_stream: 1, originalFilename: 1 },
    }).toArray(),
    db.collection('videos').find({ owner: username }, { projection: { permlink: 1 } }).toArray(),
  ]);
  const byName = new Map(); // `${author}/${permlink}` -> { key, short, stream }
  for (const e of embeds) {
    const ep = String(e.embed_url || '').replace(/^@/, '').split('/');
    const author = String(e.hive_author || ep[0] || username).toLowerCase();
    const info = {
      key: e.permlink,
      short: e.short === true,
      stream: e.is_openpod_stream === true || /^stream-/.test(String(e.originalFilename || '')),
    };
    byName.set(`${username}/${e.permlink}`, info);
    if (e.hive_permlink || ep[1]) byName.set(`${author}/${e.hive_permlink || ep[1]}`, info);
  }
  for (const l of legacy) {
    const k = `${username}/${l.permlink}`;
    if (!byName.has(k)) byName.set(k, { key: l.permlink, short: false, stream: false });
  }
  return byName;
}

function inContent(info, content) {
  if (content === 'shorts') return !!info && info.short;
  if (content === 'videos') return !info || !info.short;
  if (content === 'streams') return !!info && info.stream;
  return true;
}

async function loadReach(username, days, content) {
  const db = getDb();
  const since = days > 0 ? dayOf(Date.now() - (days - 1) * DAY) : '0000-00-00';
  const byName = await creatorItems(db, username);
  // Authors to read: the creator, plus any other Hive author a short of theirs is posted under.
  const authors = [...new Set([...byName.keys()].map((k) => k.split('/')[0]).concat(username))];
  const rows = await col().find(
    { author: { $in: authors }, day: { $gte: since } },
    { projection: { _id: 0, day: 1, author: 1, permlink: 1, surface: 1, seen: 1, opens: 1 } },
  ).toArray();

  const totals = { impressions: 0, clicks: 0, opens: 0 };
  const surfaces = {};
  const videos = {};
  let firstDay = null;
  for (const r of rows) {
    const name = `${r.author}/${r.permlink}`;
    const info = byName.get(name);
    // Another creator's video under a shared author name is not this creator's.
    if (r.author !== username && !info) continue;
    if (!inContent(info, content)) continue;
    const key = info ? info.key : r.permlink;
    const seen = Number(r.seen) || 0;
    const opens = Number(r.opens) || 0;
    const fromCard = CARD_SET.has(r.surface);
    const s = surfaces[r.surface] || (surfaces[r.surface] = { surface: r.surface, impressions: 0, opens: 0 });
    s.impressions += seen; s.opens += opens;
    const v = videos[key] || (videos[key] = { permlink: key, impressions: 0, clicks: 0, opens: 0 });
    v.impressions += seen; v.opens += opens;
    if (fromCard) v.clicks += opens;
    totals.impressions += seen; totals.opens += opens;
    if (fromCard) totals.clicks += opens;
    if (!firstDay || r.day < firstDay) firstDay = r.day;
  }

  // Embeds on other sites never load our pages, so their opens are not in the
  // counters: they come from the player's own watch sessions (the trusted ones
  // creator stats already count), everything not watched on 3speak.tv itself.
  const embedMatch = { owner: username, source: { $nin: ['3speak', null] } };
  if (days > 0) embedMatch.updatedAt = { $gt: new Date(Date.now() - days * DAY) };
  const embedRows = await db.collection(WATCH_LOG).aggregate([
    { $match: embedMatch },
    { $group: { _id: '$permlink', sessions: { $sum: 1 } } },
  ]).toArray();
  let embedSessions = 0;
  const keyInfo = new Map([...byName.values()].map((i) => [i.key, i]));
  for (const e of embedRows) {
    if (!inContent(keyInfo.get(e._id), content)) continue;
    embedSessions += e.sessions;
    const v = videos[e._id] || (videos[e._id] = { permlink: e._id, impressions: 0, clicks: 0, opens: 0 });
    v.embedSessions = (v.embedSessions || 0) + e.sessions;
  }

  const round = (n) => Math.round(n);
  const ctr = (clicks, imp) => (imp > 0 ? Math.round((Math.min(clicks, imp) / imp) * 1000) / 10 : null);
  // "Where viewers found it": opens per source, the embed sessions as their own.
  const found = Object.values(surfaces)
    .filter((s) => s.opens > 0 && s.surface !== 'embed')
    .map((s) => ({ source: s.surface, opens: s.opens }));
  const embedOpens = (surfaces.embed?.opens || 0) + embedSessions;
  if (embedOpens > 0) found.push({ source: 'embed', opens: embedOpens });
  found.sort((a, b) => b.opens - a.opens);

  return {
    since: firstDay,
    totals: {
      impressions: round(totals.impressions),
      clicks: totals.clicks,
      opens: totals.opens + embedSessions,
      ctr: ctr(totals.clicks, totals.impressions),
    },
    bySurface: Object.values(surfaces)
      .filter((s) => CARD_SET.has(s.surface) && s.impressions > 0)
      .map((s) => ({ surface: s.surface, impressions: round(s.impressions), clicks: s.opens, ctr: ctr(s.opens, s.impressions) }))
      .sort((a, b) => b.impressions - a.impressions),
    found,
    videos: Object.values(videos)
      .map((v) => ({ permlink: v.permlink, impressions: round(v.impressions), clicks: v.clicks, opens: v.opens + (v.embedSessions || 0), ctr: ctr(v.clicks, v.impressions) }))
      .sort((a, b) => b.impressions - a.impressions || b.opens - a.opens),
  };
}

router.get('/creator-stats/reach', async (req, res) => {
  try {
    const username = String(req.query.username || '').toLowerCase();
    if (!HIVE_RE.test(username)) return res.status(400).json({ success: false, error: 'invalid username' });
    const d = parseInt(req.query.days, 10);
    const days = ALLOWED_DAYS.has(d) ? d : 0;
    const content = ['videos', 'shorts', 'streams'].includes(req.query.content) ? req.query.content : 'all';
    const key = `${username}:${days}:${content}`;
    let hit = cache.get(key);
    if (!hit || Date.now() - hit.at > CACHE_MS) {
      hit = { at: Date.now(), promise: loadReach(username, days, content) };
      cache.set(key, hit);
      hit.promise.catch(() => cache.delete(key));
      if (cache.size > 1000) cache.delete(cache.keys().next().value);
    }
    res.json({ success: true, username, days, content, ...(await hit.promise) });
  } catch (err) {
    console.error('creator-stats/reach error:', err && err.message);
    res.status(500).json({ success: false, error: 'internal error' });
  }
});

module.exports = router;
module.exports._test = {
  CARD_SURFACES, OUTSIDE_SOURCES, takeSeenBudget, firstOpen, loadReach, bodyOf,
  reset: () => { seenBudget.clear(); recentOpens.clear(); cache.clear(); indexesEnsured = false; },
};
