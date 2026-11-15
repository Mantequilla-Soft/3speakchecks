/**
 * Shorts from this video: clip ranges for a creator's OWN long video, picked by
 * real viewers (utils/clipIdeas.js has the scoring).
 *
 *   POST /creator-stats/clip-ideas  { user, signature, timestamp, permlink, lang? }
 *     → { success, duration, suggestions: [{ start, end, score, reasons }], signals }
 *
 * `reasons` are { kind: 'replay', lift } | { kind: 'comments', count } |
 * { kind: 'chat', count } | { kind: 'quote', text }. `signals` says what data the
 * video had: { replay, comments, chat, transcript }.
 *
 * The session vouch (utils/progressVouch.js) proves who asks, and only the video's
 * owner gets an answer (anyone else: 404, as if there were no such video). The
 * replay data is the creator's own stats; the comments, chat and transcript are
 * public anyway. Sources, all read only:
 *   view-heatmaps + view-durations  the player's anonymous watch aggregates
 *   Hive replies on the post        timestamped comments and mirrored stream chat
 *   premiere_chat                   a premiere's timecoded chat
 *   subtitles + IPFS                the transcript (routes/subtitleProxy.js)
 * Nothing is written. One answer per video and language is kept CLIP_IDEAS_CACHE_MS.
 *
 * Mounted before the streamStats auth gate (see server.js).
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const { getDb } = require('../utils/db');
const { clientIp } = require('../utils/clientIp');
const { proveProgressUser } = require('../utils/progressVouch');
const { getMutedSet } = require('../utils/commentMutes');
const { hiveRpcCall } = require('../utils/hive');
const { buildClipIdeas } = require('../utils/clipIdeas');
const { fetchSubtitleText, CID_RE } = require('./subtitleProxy');
const {
  PREMIERE_CHAT_COLLECTION, CLIP_IDEAS_MIN_SESSIONS, CLIP_IDEAS_MAX, CLIP_IDEAS_CACHE_MS, CLIP_IDEAS_MAX_ROWS,
} = require('../utils/config');

const router = express.Router();
const WATCH_LOG = process.env.WATCH_LOG_COLLECTION || 'view-durations';
const WATCH_HEATMAP = process.env.WATCH_HEATMAP_COLLECTION || 'view-heatmaps';
const PERMLINK_RE = /^[a-z0-9][a-z0-9._-]{0,254}$/i;
const LANG_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i;

const limiter = rateLimit({
  windowMs: 60 * 1000, max: 30, standardHeaders: false, legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(clientIp(req) || ''), validate: { xForwardedForHeader: false, ip: false },
  message: { success: false, error: 'Too many requests' },
});

const cache = new Map();
function cached(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CLIP_IDEAS_CACHE_MS) return hit.value;
  if (hit) cache.delete(key);
  return null;
}
function remember(key, value) {
  if (CLIP_IDEAS_CACHE_MS <= 0) return;
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
}

/**
 * The owner's video by either permlink: { asset, hiveAuthor, hivePermlink,
 * duration, short }, or null. New uploads live in embed-video (keyed by the asset
 * permlink, the Hive one in hive_permlink); old ones in videos.
 */
async function ownVideo(db, owner, permlink) {
  const ev = await db.collection('embed-video').findOne(
    { owner, $or: [{ permlink }, { hive_permlink: permlink }] },
    { projection: { permlink: 1, hive_permlink: 1, hive_author: 1, duration: 1, short: 1 } },
  );
  if (ev) {
    return {
      asset: ev.permlink,
      hiveAuthor: ev.hive_author || owner,
      hivePermlink: ev.hive_permlink || ev.permlink,
      duration: Number(ev.duration) || 0,
      short: ev.short === true,
    };
  }
  const v = await db.collection('videos').findOne({ owner, permlink }, { projection: { permlink: 1, duration: 1 } });
  if (!v) return null;
  return { asset: v.permlink, hiveAuthor: owner, hivePermlink: v.permlink, duration: Number(v.duration) || 0, short: false };
}

/** The transcript text, in `lang` when there is one, else English, else any. */
async function transcriptOf(db, owner, permlinks, lang) {
  const doc = await db.collection('subtitles').findOne(
    { author: owner, permlink: { $in: permlinks } },
    { projection: { subtitles: 1 } },
  );
  const subs = (doc && doc.subtitles) || {};
  const langs = Object.keys(subs).filter((l) => typeof subs[l] === 'string' && CID_RE.test(subs[l]));
  const pick = [lang, lang && lang.split('-')[0], 'en'].find((l) => l && langs.includes(l)) || langs[0];
  if (!pick) return '';
  const got = await fetchSubtitleText(subs[pick]);
  return got && typeof got.text === 'string' ? got.text.slice(0, 2 * 1024 * 1024) : '';
}

// One source failing (Hive down, IPFS slow) leaves the others to speak.
const soft = (p, fallback) => p.catch((err) => {
  console.warn('[clip-ideas] source failed:', err && err.message);
  return fallback;
});

router.post('/creator-stats/clip-ideas', limiter, express.json({ limit: '2kb' }), async (req, res) => {
  const b = req.body || {};
  const user = await proveProgressUser(b);
  if (!user) return res.status(401).json({ success: false, error: 'Invalid signature' });
  const permlink = String(b.permlink || '').trim();
  if (!PERMLINK_RE.test(permlink)) return res.status(400).json({ success: false, error: 'invalid permlink' });
  const lang = LANG_RE.test(String(b.lang || '')) ? String(b.lang).toLowerCase() : '';
  res.set('Cache-Control', 'no-store');

  try {
    const db = getDb();
    const video = await ownVideo(db, user, permlink);
    if (!video) return res.status(404).json({ success: false, error: 'not found' });
    const key = `${user}/${video.asset}/${lang}`;
    const hit = cached(key);
    if (hit) return res.json(hit);

    const permlinks = [...new Set([video.asset, video.hivePermlink, permlink])];
    const [heatmap, rows, replies, premiereChat, subtitles, muted] = await Promise.all([
      soft(db.collection(WATCH_HEATMAP).findOne({ owner: user, permlink: video.asset }), null),
      soft(db.collection(WATCH_LOG)
        .find({ owner: user, permlink: video.asset }, { projection: { startPosition: 1, maxPosition: 1, lastPosition: 1 } })
        .limit(CLIP_IDEAS_MAX_ROWS)
        .toArray(), []),
      video.short ? [] : soft(hiveRpcCall('condenser_api.get_content_replies', [video.hiveAuthor, video.hivePermlink]), []),
      video.short ? [] : soft(db.collection(PREMIERE_CHAT_COLLECTION)
        .find({ owner: user, permlink: { $in: permlinks }, removedAt: { $exists: false } }, { projection: { user: 1, offset: 1 } })
        .limit(5000)
        .toArray(), []),
      video.short ? '' : soft(transcriptOf(db, user, permlinks, lang), ''),
      soft(getMutedSet(db), new Set()),
    ]);

    // The creator's own comments and the muted bots are not viewers' picks.
    const people = (Array.isArray(replies) ? replies : []).filter((r) => {
      const a = String((r && r.author) || '').toLowerCase();
      return a && a !== user && !muted.has(a);
    });
    const chat = (premiereChat || []).filter((c) => c && c.user !== user && !muted.has(String(c.user || '').toLowerCase()));

    const duration = video.duration || Number(heatmap && heatmap.duration) || 0;
    // A Short already is one: no suggestions for it.
    const built = video.short
      ? { suggestions: [], signals: { replay: false, comments: 0, chat: 0, transcript: false } }
      : buildClipIdeas({
        duration,
        heatmap,
        rows,
        replies: people,
        premiereChat: chat,
        subtitles,
        opts: { minSessions: CLIP_IDEAS_MIN_SESSIONS, max: CLIP_IDEAS_MAX },
      });
    const body = { success: true, permlink: video.asset, duration, short: video.short, ...built };
    remember(key, body);
    return res.json(body);
  } catch (err) {
    console.error('[clip-ideas] failed:', err && err.message);
    return res.status(500).json({ success: false, error: 'could not load' });
  }
});

module.exports = router;
module.exports._test = { ownVideo, transcriptOf, reset: () => cache.clear() };
