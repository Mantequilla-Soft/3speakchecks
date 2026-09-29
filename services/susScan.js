/**
 * Suspicious views / ad impressions scanner.
 *
 * Every SUS_SCAN_INTERVAL_MIN (default 120) it looks at the last window of view and
 * ad data for patterns a person should look at, and posts NEW findings to a Discord
 * webhook (SUS_ALERT_WEBHOOK_URL) as one embed. It never changes any data: it is a
 * smoke alarm, not a judge. The follow-up ("which sessions, since when, how much
 * money") is done by hand; this only says where to look.
 *
 * Why it exists: Reflectionbot (2026-09) played videos in a headless Chrome for
 * weeks, was 62% of all tracked sessions, and created one paid ad impression per
 * page load before anyone noticed. A bot that sends a normal Chrome user agent is
 * not stopped by any UA rule, so the signals here are about SHAPE, not identity.
 *
 * Detectors (window = the last SUS_SCAN_WINDOW_H hours, default 2):
 *   crawler_sessions       view-durations from a known crawler UA (should be 0: nginx
 *                          answers their tracking calls with a 204)
 *   ua_country_burst       one UA + country makes most of a video's sessions
 *   video_view_spike       a video far above its own 7-day rate
 *   repeat_ip_views        one address replaying the same video (views.ipHash)
 *   ad_impression_spike    a creator's ad impressions far above their 7-day rate
 *   ads_without_watching   more ad impressions than watch sessions on a video
 *   self_view_ads          ad sessions where the viewer is the video's owner
 *
 * A finding is alerted ONCE per (detector, subject, UTC day), remembered in the
 * `sus_alerts` collection, so a pattern that persists does not repeat every run.
 *
 * Windows are `_id` ranges: every row's ObjectId carries its creation time and _id
 * is always indexed, while `views` has no index on its own timestamp.
 */
const { ObjectId } = require('mongodb');
const { getDb } = require('../utils/db');

const WINDOW_H = Math.max(1, parseFloat(process.env.SUS_SCAN_WINDOW_H) || 2);
const WEBHOOK = (process.env.SUS_ALERT_WEBHOOK_URL || '').trim();
const ALERTS = 'sus_alerts';
const BASELINE_DAYS = 7;

// Same families nginx treats as crawlers (conf.d/blocked-bots.conf $is_crawler).
const CRAWLER_RE = /reflectionbot|googlebot|google-inspectiontool|storebot-google|bingbot|bingpreview|duckduckbot|applebot|yandex|baiduspider|sogou|petalbot|bytespider|amazonbot|gptbot|oai-searchbot|chatgpt-user|claudebot|claude-user|claude-searchbot|anthropic-ai|perplexitybot|perplexity-user|ccbot|meta-externalagent|meta-webindexer|semrushbot|ahrefsbot|mj12bot|dotbot|dataforseobot|headlesschrome|lighthouse/i;

// Thresholds. Deliberately conservative: an alert channel that cries wolf gets muted.
const T = {
  crawlerMin: 3,
  burstMin: 15, burstShare: 0.6,
  spikeMin: 25, spikeRatio: 5,
  repeatIpMin: 10,
  impSpikeMin: 30, impSpikeRatio: 4,
  noWatchMin: 20, noWatchRatio: 2,
  selfViewMin: 3,
};

const idAt = (date) => ObjectId.createFromTime(Math.floor(date.getTime() / 1000));
const dayKey = (d) => d.toISOString().slice(0, 10);
const shortUa = (ua) => {
  const s = String(ua || '');
  const bot = CRAWLER_RE.exec(s);
  if (bot) return bot[0];
  const m = /(Chrome|Firefox|Safari|Edg)\/(\d+)/.exec(s);
  const os = /Android|iPhone|Windows|Macintosh|Linux/.exec(s);
  return `${m ? `${m[1]} ${m[2]}` : s.slice(0, 40)}${os ? ` on ${os[0]}` : ''}`;
};

async function detect(db, now) {
  const from = new Date(now.getTime() - WINDOW_H * 3600e3);
  const baseFrom = new Date(from.getTime() - BASELINE_DAYS * 864e5);
  const winId = { $gte: idAt(from) };
  const baseId = { $gte: idAt(baseFrom), $lt: idAt(from) };
  const buckets = (BASELINE_DAYS * 24) / WINDOW_H;   // windows in the baseline period
  const vd = db.collection('view-durations');
  const out = [];

  // ── crawler_sessions ──
  const crawlers = await vd.aggregate([
    { $match: { _id: winId, userAgent: CRAWLER_RE } },
    { $group: { _id: '$userAgent', n: { $sum: 1 }, vids: { $addToSet: { $concat: ['$owner', '/', '$permlink'] } } } },
  ]).toArray();
  const byFamily = {};
  for (const c of crawlers) {
    const fam = shortUa(c._id);
    byFamily[fam] = byFamily[fam] || { n: 0, vids: new Set() };
    byFamily[fam].n += c.n;
    c.vids.forEach((v) => byFamily[fam].vids.add(v));
  }
  for (const [fam, v] of Object.entries(byFamily)) {
    if (v.n < T.crawlerMin) continue;
    out.push({ type: 'crawler_sessions', subject: fam,
      text: `${v.n} watch sessions from crawler **${fam}** on ${v.vids.size} video(s). Its tracking calls should be answered by nginx, so check how they got through.` });
  }

  // ── per-video session counts (shared by burst / spike / ads_without_watching) ──
  const winPerVideo = await vd.aggregate([
    { $match: { _id: winId } },
    { $group: { _id: { o: '$owner', p: '$permlink' }, n: { $sum: 1 } } },
  ]).toArray();
  const sessionsOf = new Map(winPerVideo.map((r) => [`${r._id.o}/${r._id.p}`, r.n]));

  // ── ua_country_burst ──
  const bursts = await vd.aggregate([
    { $match: { _id: winId } },
    { $group: { _id: { o: '$owner', p: '$permlink', ua: '$userAgent', c: '$country' }, n: { $sum: 1 }, pct: { $avg: '$watchedPct' } } },
    { $match: { n: { $gte: T.burstMin } } },
  ]).toArray();
  for (const b of bursts) {
    const key = `${b._id.o}/${b._id.p}`;
    const total = sessionsOf.get(key) || b.n;
    if (b.n / total < T.burstShare) continue;
    out.push({ type: 'ua_country_burst', subject: key, video: key,
      text: `${b.n} of ${total} sessions from one browser (**${shortUa(b._id.ua)}**) in **${b._id.c || '??'}**, avg watched ${Math.round(b.pct || 0)}%.` });
  }

  // ── video_view_spike ──
  const hot = winPerVideo.filter((r) => r.n >= T.spikeMin);
  if (hot.length) {
    const base = await vd.aggregate([
      { $match: { _id: baseId, $or: hot.map((r) => ({ owner: r._id.o, permlink: r._id.p })) } },
      { $group: { _id: { o: '$owner', p: '$permlink' }, n: { $sum: 1 } } },
    ]).toArray();
    const baseOf = new Map(base.map((r) => [`${r._id.o}/${r._id.p}`, r.n / buckets]));
    for (const r of hot) {
      const key = `${r._id.o}/${r._id.p}`;
      const usual = baseOf.get(key) || 0;
      const ratio = r.n / Math.max(1, usual);
      if (ratio < T.spikeRatio) continue;
      out.push({ type: 'video_view_spike', subject: key, video: key,
        text: `${r.n} sessions in ${WINDOW_H}h, usually ~${usual.toFixed(1)} (${ratio.toFixed(0)}x).` });
    }
  }

  // ── repeat_ip_views (views.ipHash is salted per video, so this is per video) ──
  const repeats = await db.collection('views').aggregate([
    { $match: { _id: winId } },
    { $group: { _id: { a: '$author', p: '$permlink', ip: '$ipHash' }, n: { $sum: 1 }, ua: { $first: '$userAgent' } } },
    { $match: { n: { $gte: T.repeatIpMin } } },
    { $sort: { n: -1 } },
  ]).toArray();
  for (const r of repeats) {
    const key = `${r._id.a}/${r._id.p}`;
    out.push({ type: 'repeat_ip_views', subject: `${key}#${String(r._id.ip).slice(0, 8)}`, video: key,
      text: `One address counted **${r.n} views** of this video in ${WINDOW_H}h (${shortUa(r.ua)}).` });
  }

  // ── ad_impression_spike (per creator) ──
  const imps = db.collection('ad_impressions');
  const impWin = await imps.aggregate([
    { $match: { _id: winId, owner: { $ne: null } } },
    { $group: { _id: '$owner', n: { $sum: 1 }, done: { $sum: { $cond: ['$completed', 1, 0] } } } },
    { $match: { n: { $gte: T.impSpikeMin } } },
  ]).toArray();
  if (impWin.length) {
    const base = await imps.aggregate([
      { $match: { _id: baseId, owner: { $in: impWin.map((r) => r._id) } } },
      { $group: { _id: '$owner', n: { $sum: 1 } } },
    ]).toArray();
    const baseOf = new Map(base.map((r) => [r._id, r.n / buckets]));
    for (const r of impWin) {
      const usual = baseOf.get(r._id) || 0;
      const ratio = r.n / Math.max(1, usual);
      if (ratio < T.impSpikeRatio) continue;
      out.push({ type: 'ad_impression_spike', subject: r._id,
        text: `@${r._id}: **${r.n} ad impressions** in ${WINDOW_H}h (${r.done} completed), usually ~${usual.toFixed(1)} (${ratio.toFixed(0)}x). These are paid from the creator pool.` });
    }
  }

  // ── ads_without_watching (per video) ──
  const impVid = await imps.aggregate([
    { $match: { _id: winId, owner: { $ne: null }, permlink: { $ne: null } } },
    { $group: { _id: { o: '$owner', p: '$permlink' }, n: { $sum: 1 } } },
    { $match: { n: { $gte: T.noWatchMin } } },
  ]).toArray();
  for (const r of impVid) {
    const key = `${r._id.o}/${r._id.p}`;
    const sessions = sessionsOf.get(key) || 0;
    if (r.n <= T.noWatchRatio * Math.max(1, sessions)) continue;
    out.push({ type: 'ads_without_watching', subject: key, video: key,
      text: `**${r.n} ad impressions** but only ${sessions} watch session(s) in ${WINDOW_H}h: ads are being fetched without the video being watched.` });
  }

  // ── self_view_ads ──
  const self = await db.collection(process.env.AD_SESSIONS_COLLECTION || 'ad_sessions').aggregate([
    { $match: { _id: winId, viewer: { $ne: null }, $expr: { $eq: ['$viewer', '$owner'] } } },
    { $group: { _id: '$owner', n: { $sum: 1 }, vids: { $addToSet: '$permlink' } } },
    { $match: { n: { $gte: T.selfViewMin } } },
  ]).toArray();
  for (const r of self) {
    out.push({ type: 'self_view_ads', subject: r._id,
      text: `@${r._id} requested **${r.n} ads on their own videos** (${r.vids.length} video(s)) in ${WINDOW_H}h.` });
  }

  return out;
}

/** Keep only findings not yet alerted today; remember the new ones. */
async function onlyNew(db, findings, now) {
  const col = db.collection(ALERTS);
  const fresh = [];
  for (const f of findings) {
    const _id = `${f.type}|${f.subject}|${dayKey(now)}`;
    try {
      await col.insertOne({ _id, ...f, at: now });
      fresh.push(f);
    } catch (e) {
      if (e.code !== 11000) throw e;   // seen today already
      await col.updateOne({ _id }, { $set: { lastAt: now, lastText: f.text } }).catch(() => {});
    }
  }
  return fresh;
}

/** A watch link for a video key (embed asset id -> its Hive post when we know it). */
async function linksFor(db, findings) {
  const keys = [...new Set(findings.filter((f) => f.video).map((f) => f.video))];
  const map = new Map();
  if (!keys.length) return map;
  const pairs = keys.map((k) => ({ owner: k.slice(0, k.indexOf('/')), permlink: k.slice(k.indexOf('/') + 1) }));
  const rows = await db.collection('embed-video').find({ $or: pairs },
    { projection: { owner: 1, permlink: 1, hive_author: 1, hive_permlink: 1 } }).toArray();
  for (const r of rows) {
    if (r.hive_author && r.hive_permlink) map.set(`${r.owner}/${r.permlink}`, `https://3speak.tv/watch?v=${r.hive_author}/${r.hive_permlink}`);
  }
  for (const k of keys) if (!map.has(k)) map.set(k, `https://play.3speak.tv/embed?v=${k}`);
  return map;
}

const LABEL = {
  crawler_sessions: '🤖 Crawler sessions',
  ua_country_burst: '🎯 One browser dominates a video',
  video_view_spike: '📈 View spike',
  repeat_ip_views: '🔁 Same address replaying',
  ad_impression_spike: '💸 Ad impression spike',
  ads_without_watching: '👻 Ads without watching',
  self_view_ads: '🪞 Ads on own videos',
};

async function sendWebhook(findings, links, now) {
  const shown = findings.slice(0, 24);
  const fields = shown.map((f) => ({
    name: `${LABEL[f.type] || f.type}${f.video ? `: ${f.video}` : ''}`.slice(0, 256),
    value: `${f.text}${f.video ? `\n${links.get(f.video)}` : ''}`.slice(0, 1024),
  }));
  if (findings.length > shown.length) {
    fields.push({ name: `…and ${findings.length - shown.length} more`, value: 'Ask for the full list.' });
  }
  const body = {
    username: '3Speak sus-scan',
    embeds: [{
      title: `Suspicious activity: ${findings.length} new finding${findings.length === 1 ? '' : 's'}`,
      description: `Views and ad impressions in the last ${WINDOW_H}h. Nothing was changed; this is a pointer for a closer look.`,
      color: findings.some((f) => /^ad_|ads_|self_view/.test(f.type)) ? 0xe03e3e : 0xf0a020,
      fields,
      footer: { text: 'checker.3speak.tv · services/susScan.js · one alert per pattern per day' },
      timestamp: now.toISOString(),
    }],
  };
  const r = await fetch(WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`webhook ${r.status}`);
}

let running = false;
/**
 * One scan. `dryRun` detects and prints without remembering or sending (for the CLI).
 * Resolves the findings; never throws into the scheduler.
 */
async function runOnce({ dryRun = false } = {}) {
  if (running) return [];
  running = true;
  const now = new Date();
  try {
    const db = getDb();
    const all = await detect(db, now);
    if (dryRun) return all;
    const fresh = await onlyNew(db, all, now);
    console.log(`[susScan] ${all.length} finding(s), ${fresh.length} new${fresh.length && !WEBHOOK ? ' (no SUS_ALERT_WEBHOOK_URL, not sent)' : ''}`);
    if (fresh.length && WEBHOOK) await sendWebhook(fresh, await linksFor(db, fresh), now);
    return fresh;
  } catch (e) {
    console.error('[susScan] run failed:', e && e.message);
    return [];
  } finally {
    running = false;
  }
}

module.exports = { runOnce, detect, linksFor, sendWebhook, WINDOW_H, T };
