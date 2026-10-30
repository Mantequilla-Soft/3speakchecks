/**
 * Listening time for every audio, measured the way video watch time is
 * (preview-player watchTracking.js): 3Speak's own audio AND outside podcast
 * episodes, from 3speak.tv's audio player and the audio.3speak.tv embed.
 *
 *   POST /audio/listen/start   { kind: 'audio'|'podcast', id, duration?, position?, source?, private? }
 *        → { sid, token, beatSeconds } or { tracked: false, reason }
 *   POST /audio/listen/beat    { sid, token, position, rate?, hidden? }
 *   GET  /audio/listen/heatmap?kind=&id=   the "most replayed" curve of one item
 *
 * `id` is the embed-audio permlink for 3Speak audio, the episode id
 * (<feed id>:<hash>) for a podcast episode.
 *
 * How time is measured (the same rules as video, so the numbers compare):
 * - The server times every beat itself and credits at most MAX_BEAT_CREDIT_MS per
 *   beat, so a late or forged beat cannot claim a long span and idle time is not
 *   listening. A session token (HMAC over sid + item) binds beats to the session.
 * - Only CONTIGUOUS forward playback counts: a beat whose position moved forward by
 *   no more than the elapsed time x the beat's playback rate plus a third (skip
 *   silence jumps over pauses on top of the rate), between 2.5x and 4x, plus 10 %
 *   for beat timing. A seek or
 *   a rewind credits nothing. Credit stays wall-clock time either way, so a fast
 *   listener is credited for the time they spent, not for the audio they got.
 * - listenedSeconds = wall-clock time spent listening; contentSeconds = audio
 *   consumed (playhead advance), which is right at any playback speed.
 * - listenedPct = distinct timeline slices (of 100) actually heard: skipping to the
 *   end is one slice, a replay cannot push it past 100.
 * - Unlike video, a hidden tab keeps counting: audio is made to run in the
 *   background. `hidden` is recorded, not used against the listener.
 *
 * Collections:
 * - listen-sessions   the open sessions (TTL), never read for statistics
 * - listen-durations  one row per session, ANONYMOUS: no IP, no name. Country is
 *                     resolved on ingest and the IP thrown away, as for video.
 * - listen-heatmaps   one doc per item: the 100 slices and how often each was heard
 * Names are never stored in those. Listener rewards keep their own ledger,
 * `ad_listener_listen`, so revoking consent is a delete:
 * - only on 3speak.tv, for a listener our own API vouches for (POST
 *   /api/podcasts/signature action 'listen', valid a day), never a warm-up handle;
 * - only while they agreed to listening (ad_viewer_prefs.listenEnabled, re-read);
 * - from AD_LISTENER_MIN_PCT heard, not on your own track, not in private mode;
 * - at most AD_LISTENER_MAX_SECONDS per item and AD_LISTENER_DAILY_MAX_SECONDS per
 *   listener per UTC day; one row per (listener, kind, id), only ever raised ($max).
 * Recording is not paying: services/adPayouts.js pays from these rows only when the
 * listener pools are switched on (AD_LISTENER_*_POOL_PCT, default 0).
 */
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const geoip = require('geoip-lite');
const { getDb } = require('../utils/db');
const { verifyDelegateVouch } = require('../utils/hiveAuth');
const {
  AD_SIGNING_DELEGATES, AD_VIEWER_PREFS_COLLECTION, AD_LISTENER_LISTEN_COLLECTION,
  AD_LISTENER_MIN_PCT, AD_LISTENER_MAX_SECONDS, AD_LISTENER_DAILY_MAX_SECONDS,
} = require('../utils/config');

const router = express.Router();

const SESSION_COLLECTION = 'listen-sessions';
const LOG_COLLECTION = 'listen-durations';
const HEATMAP_COLLECTION = 'listen-heatmaps';
const BEAT_SECONDS = Math.max(1, parseInt(process.env.LISTEN_TRACK_BEAT_SECONDS, 10) || 10);
const BUCKET_COUNT = 100;
const MAX_BEAT_CREDIT_MS = Math.max(BEAT_SECONDS * 1000 * 1.6, 8000);
// How far the playhead may run ahead of the clock and still be one stretch of
// listening: the reported rate (up to 3x in the player) plus a third for skipped
// silences, never under the old 2.5x and never over 4x, and then 10 % for a beat
// that arrives a little early or late (the server times beats, the player moves
// the playhead).
const MIN_CONTIGUOUS_RATE = 2.5;
const MAX_CONTIGUOUS_RATE = 4;
const RATE_SLACK = 4 / 3;
const BEAT_JITTER = 1.1;
const MAX_DURATION_SEC = 6 * 3600; // longer "episodes" exist (live recordings); beyond this nothing is measured
const DURATION_DISAGREEMENT_RATIO = 0.5;
// Per-process: sessions live for a few track-lengths, losing them on a restart is fine.
const SESSION_SECRET = crypto.randomBytes(32);

const KINDS = new Set(['audio', 'podcast']);
// A Hive account: listener rewards are paid on Hive, so a warm-up `~handle` never qualifies.
const HIVE_ACCOUNT_RE = /^[a-z][a-z0-9.-]{2,15}$/;
const LISTEN_VOUCH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Must match the vouch our API signs (preview-3speak server/index.cjs, /api/podcasts/signature).
const listenVouchMessage = (user, timestamp) => ['3speak-podcasts', 'listen-vouch', user, 'session', String(timestamp)].join('|');
const AUDIO_ID_RE = /^[a-z0-9._-]{1,64}$/i;
const EPISODE_RE = /^[0-9a-f]{24}:[A-Za-z0-9_-]{16}$/;

/** The client's address as nginx saw it (the checker does not trust proxies itself). */
const clientIp = (req) => String(req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0] || req.ip || '').trim();

// Generous per-address limits: a beat every 10 s per playing tab. Keyed by the real
// client address; the default key would be nginx's, one bucket for everybody.
const limiter = (max) => rateLimit({
  windowMs: 60 * 1000, max, standardHeaders: false, legacyHeaders: false,
  // ipKeyGenerator groups an IPv6 address by its /56, so one connection cannot
  // dodge the limit by cycling through its own addresses.
  keyGenerator: (req) => ipKeyGenerator(clientIp(req)), validate: { xForwardedForHeader: false, ip: false },
  message: { error: 'Too many requests' },
});

const sessionToken = (sid, kind, id) => crypto.createHmac('sha256', SESSION_SECRET).update(`${sid}.${kind}.${id}`).digest('hex');
function tokenMatches(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; }
}

function bucketIndex(pos, durationSec, n = BUCKET_COUNT) {
  if (!(durationSec > 0)) return 0;
  return Math.min(n - 1, Math.max(0, Math.floor((pos / durationSec) * n)));
}

/** The duration to measure against: the player's, unless it is wildly short of the stored one. */
function resolveDuration(clientDur, storedDur) {
  const c = Number(clientDur);
  const d = Number(storedDur);
  const storedOk = Number.isFinite(d) && d > 0 && d <= MAX_DURATION_SEC;
  const clientOk = Number.isFinite(c) && c > 0 && c <= MAX_DURATION_SEC;
  if (clientOk && storedOk && c < d * DURATION_DISAGREEMENT_RATIO) return d;
  if (clientOk) return c;
  if (storedOk) return d;
  return 0;
}

function clampPos(pos, durationSec) {
  const p = Number(pos);
  if (!Number.isFinite(p) || p < 0) return 0;
  return durationSec > 0 ? Math.min(p, durationSec) : p;
}

/** Where the listen happened: '3speak' (the site), 'embed' (audio.3speak.tv) or another app's slug. */
const normalizeSource = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 20) || 'embed';

function countryOf(ip) {
  try {
    const g = ip ? geoip.lookup(ip.replace(/^::ffff:/, '')) : null;
    return (g && g.country) || null;
  } catch {
    return null;
  }
}

/**
 * One beat applied to a session: what it credits and the new session state. Pure,
 * so the rules can be tested without Mongo.
 */
function applyBeat(s, { now, position, rate, hidden }) {
  const gap = Math.max(0, now - new Date(s.lastBeatAt).getTime());
  const credit = Math.min(gap, MAX_BEAT_CREDIT_MS);
  const durSec = s.duration;
  const n = s.bucketCount || BUCKET_COUNT;
  const lastPos = Number(s.lastPosition) || 0;
  const curPos = clampPos(position, durSec);
  const r = Number(rate);
  const rateOk = Number.isFinite(r) && r > 0 && r <= 4;
  const pace = Math.min(MAX_CONTIGUOUS_RATE, Math.max(MIN_CONTIGUOUS_RATE, rateOk ? r * RATE_SLACK : 0)) * BEAT_JITTER;
  const contiguousMax = Math.max((credit / 1000) * pace, 12);
  const covered = new Set(Array.isArray(s.coveredBuckets) ? s.coveredBuckets : []);
  const incs = {};
  let { accumulatedMs = 0, contentMs = 0, hiddenContentMs = 0 } = s;
  let counted = false;
  if (durSec > 0 && curPos >= lastPos && curPos - lastPos <= contiguousMax) {
    counted = true;
    accumulatedMs += credit;
    contentMs += (curPos - lastPos) * 1000;
    if (hidden) hiddenContentMs += (curPos - lastPos) * 1000;
    const b0 = bucketIndex(lastPos, durSec, n);
    const b1 = bucketIndex(curPos, durSec, n);
    for (let b = b0; b <= b1; b += 1) {
      incs[`buckets.${b}`] = (incs[`buckets.${b}`] || 0) + 1;
      covered.add(b);
    }
  }
  return {
    counted,
    incs,
    state: {
      accumulatedMs, contentMs, hiddenContentMs,
      lastPosition: curPos,
      maxPosition: Math.max(Number(s.maxPosition) || 0, curPos),
      coveredBuckets: [...covered],
      rateSum: (s.rateSum || 0) + (rateOk ? r : 0),
      rateBeats: (s.rateBeats || 0) + (rateOk ? 1 : 0),
      lastBeatAt: new Date(now),
    },
    stats: {
      listenedSeconds: Math.round(accumulatedMs / 1000),
      contentSeconds: Math.round(contentMs / 1000),
      listenedPct: Math.min(100, Math.round((covered.size / n) * 1000) / 10),
    },
  };
}

/**
 * Who is listening, when 3speak.tv's API vouches for it; else null (anonymous).
 * Only for listens on 3speak.tv: an embed cannot know who is listening.
 */
async function proveListener(b, source) {
  if (source !== '3speak' || !b.listener) return null;
  const user = String(b.listener).trim().toLowerCase();
  const signature = typeof b.listenerSig === 'string' ? b.listenerSig.slice(0, 200) : '';
  const timestamp = parseInt(b.listenerTs, 10);
  if (!HIVE_ACCOUNT_RE.test(user) || !signature || !Number.isFinite(timestamp)) return null;
  if (Math.abs(Date.now() - timestamp) > LISTEN_VOUCH_MAX_AGE_MS) return null;
  try {
    const v = await verifyDelegateVouch({ message: listenVouchMessage(user, timestamp), signature, delegates: AD_SIGNING_DELEGATES });
    return v.ok ? user : null;
  } catch {
    return null;
  }
}

/** Whether this listen may earn at all, before anything is read from the database. */
function qualifies(s, { listenedPct }) {
  if (!s.listener || s.source !== '3speak' || s.private) return false;
  // A creator listening to their own track must not earn as its listener.
  if (s.kind === 'audio' && s.owner && String(s.owner).toLowerCase() === s.listener) return false;
  return listenedPct >= AD_LISTENER_MIN_PCT;
}

/** Seconds to credit: capped per item, and by what is left of today's allowance. */
function creditSeconds(contentSeconds, otherSecondsToday) {
  const perItem = Math.min(Math.max(0, Math.round(contentSeconds) || 0), AD_LISTENER_MAX_SECONDS);
  return Math.max(0, Math.min(perItem, AD_LISTENER_DAILY_MAX_SECONDS - (otherSecondsToday || 0)));
}

/** A qualifying listen into the ledger, for listeners who agreed to it. Never throws. */
async function recordListenerReward(db, s, stats, now = new Date()) {
  try {
    if (!qualifies(s, stats)) return;
    const prefs = await db.collection(AD_VIEWER_PREFS_COLLECTION).findOne({ _id: s.listener }, { projection: { listenEnabled: 1 } });
    if (!prefs || prefs.listenEnabled !== true) return;
    const ledger = db.collection(AD_LISTENER_LISTEN_COLLECTION);
    const day = now.toISOString().slice(0, 10);
    // Today's other listening counts against the daily allowance. A row is dated by
    // the day it was first written, which is when nearly all of its seconds accrue.
    const others = await ledger.aggregate([
      { $match: { listener: s.listener, day, $nor: [{ kind: s.kind, id: s.id }] } },
      { $group: { _id: null, t: { $sum: '$seconds' } } },
    ]).toArray();
    const seconds = creditSeconds(stats.contentSeconds, others[0] ? others[0].t : 0);
    if (seconds <= 0) return;
    await ledger.updateOne(
      { listener: s.listener, kind: s.kind, id: s.id },
      {
        $max: { seconds, listenedPct: stats.listenedPct },
        $set: { owner: s.owner || null, feed_id: s.feed_id || null, at: now },
        $setOnInsert: { payoutId: null, firstAt: now, day, source: s.source },
      },
      { upsert: true },
    );
  } catch (err) {
    // A reward ledger must never break measuring.
    console.error('[listen] listener reward:', err.message);
  }
}

let indexesEnsured = false;
async function ensureIndexes(db) {
  if (indexesEnsured) return;
  indexesEnsured = true;
  try {
    await db.collection(SESSION_COLLECTION).createIndex({ sid: 1 }, { unique: true });
    await db.collection(SESSION_COLLECTION).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    const log = db.collection(LOG_COLLECTION);
    await log.createIndex({ sid: 1 }, { unique: true });
    await log.createIndex({ kind: 1, owner: 1, updatedAt: -1 });   // a creator's audio stats
    await log.createIndex({ kind: 1, id: 1, updatedAt: -1 });      // one item's stats
    await log.createIndex({ kind: 1, feed_id: 1, updatedAt: -1 }); // one show's stats
    await db.collection(HEATMAP_COLLECTION).createIndex({ kind: 1, id: 1 }, { unique: true });
    const ledger = db.collection(AD_LISTENER_LISTEN_COLLECTION);
    await ledger.createIndex({ listener: 1, kind: 1, id: 1 }, { unique: true });
    await ledger.createIndex({ kind: 1, payoutId: 1 });   // what the payout reads
    await ledger.createIndex({ listener: 1, day: 1 });    // the daily allowance
  } catch (err) {
    indexesEnsured = false;
    console.error('[listen] indexes:', err.message);
  }
}

/** What is being listened to: { owner, feed_id, storedDuration } or null when it does not exist. */
async function findItem(db, kind, id) {
  if (kind === 'audio') {
    const a = await db.collection('embed-audio').findOne({ permlink: id }, { projection: { owner: 1, duration: 1, mp3_duration: 1, status: 1 } });
    if (!a || a.status === 'deleted') return null;
    return { owner: a.owner || null, feed_id: null, storedDuration: Number(a.duration) || Number(a.mp3_duration) || 0 };
  }
  const ep = await db.collection('podcast_episodes').findOne({ _id: id }, { projection: { feed_id: 1, duration: 1 } });
  if (!ep) return null;
  return { owner: null, feed_id: String(ep.feed_id || id.slice(0, 24)), storedDuration: Number(ep.duration) || 0 };
}

router.post('/start', express.json({ limit: '4kb' }), limiter(60), async (req, res) => {
  try {
    const b = req.body || {};
    const kind = KINDS.has(b.kind) ? b.kind : '';
    const id = typeof b.id === 'string' ? b.id.trim() : '';
    if (!kind || !(kind === 'audio' ? AUDIO_ID_RE : EPISODE_RE).test(id)) {
      return res.status(400).json({ error: 'Invalid kind/id' });
    }
    const db = getDb();
    await ensureIndexes(db);
    const item = await findItem(db, kind, id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    const duration = Math.round(resolveDuration(b.duration, item.storedDuration));
    if (duration <= 0) return res.json({ tracked: false, reason: 'no_duration' });

    const now = new Date();
    const hm = await db.collection(HEATMAP_COLLECTION).findOneAndUpdate(
      { kind, id },
      {
        $setOnInsert: {
          kind, id, owner: item.owner, feed_id: item.feed_id, duration,
          bucketCount: BUCKET_COUNT, buckets: new Array(BUCKET_COUNT).fill(0), createdAt: now,
        },
        $inc: { sessions: 1 },
        $set: { updatedAt: now },
      },
      { upsert: true, returnDocument: 'after' },
    );
    const hmDoc = (hm && hm.value) || hm;
    const axis = (hmDoc && hmDoc.duration) || duration;
    const isPrivate = b.private === true || b.private === 'true';
    const source = normalizeSource(b.source);
    const listener = await proveListener(b, source);
    const sid = crypto.randomBytes(16).toString('hex');
    const startPosition = clampPos(b.position, axis);
    await db.collection(SESSION_COLLECTION).insertOne({
      sid, kind, id, owner: item.owner, feed_id: item.feed_id,
      duration: axis, bucketCount: (hmDoc && hmDoc.bucketCount) || BUCKET_COUNT,
      source,
      // Named only when our API vouched for it (see proveListener). Never copied
      // into listen-durations, which stays anonymous.
      listener,
      country: isPrivate ? null : countryOf(clientIp(req)),
      private: isPrivate,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
      accumulatedMs: 0, contentMs: 0, hiddenContentMs: 0,
      startPosition, lastPosition: startPosition, maxPosition: startPosition,
      coveredBuckets: [], rateSum: 0, rateBeats: 0,
      startedAt: now, lastBeatAt: now,
      // A few track-lengths, so a paused tab can resume.
      expiresAt: new Date(now.getTime() + axis * 4000 + 5 * 60 * 1000),
    });
    res.json({ sid, token: sessionToken(sid, kind, id), beatSeconds: BEAT_SECONDS });
  } catch (err) {
    console.error('[listen] start:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/beat', express.json({ limit: '4kb' }), limiter(240), async (req, res) => {
  try {
    const sid = typeof req.body?.sid === 'string' ? req.body.sid : '';
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    if (!sid || !token) return res.status(400).json({ error: 'Invalid beat' });
    const db = getDb();
    const sessions = db.collection(SESSION_COLLECTION);
    const s = await sessions.findOne({ sid });
    if (!s) return res.status(410).json({ error: 'no_session' });
    if (!tokenMatches(token, sessionToken(sid, s.kind, s.id))) return res.status(403).json({ error: 'bad_token' });

    const now = Date.now();
    const hidden = req.body?.hidden === true || req.body?.hidden === 'true';
    const beat = applyBeat(s, { now, position: req.body?.position, rate: req.body?.rate, hidden });
    // Only the session whose last beat we read moves on: two beats racing each
    // other must not both be credited against the same starting point.
    const upd = await sessions.updateOne({ sid, lastBeatAt: s.lastBeatAt }, { $set: beat.state });
    if (!upd.modifiedCount) return res.json({ ...beat.stats, duplicate: true });

    if (Object.keys(beat.incs).length) {
      await db.collection(HEATMAP_COLLECTION).updateOne({ kind: s.kind, id: s.id }, { $inc: beat.incs, $set: { updatedAt: new Date(now) } });
    }
    const st = beat.state;
    await db.collection(LOG_COLLECTION).updateOne(
      { sid },
      {
        $set: {
          kind: s.kind, id: s.id, owner: s.owner, feed_id: s.feed_id,
          source: s.source, country: s.country ?? null, private: !!s.private, userAgent: s.userAgent,
          ...beat.stats,
          hiddenSeconds: Math.round((st.hiddenContentMs || 0) / 1000),
          duration: s.duration,
          lastPosition: st.lastPosition, maxPosition: st.maxPosition,
          avgRate: st.rateBeats > 0 ? Math.round((st.rateSum / st.rateBeats) * 100) / 100 : null,
          updatedAt: new Date(now),
        },
        $setOnInsert: { sid, startPosition: Number(s.startPosition) || 0, startedAt: new Date(s.startedAt) },
      },
      { upsert: true },
    );
    if (beat.counted) await recordListenerReward(db, s, beat.stats);
    res.json({ ...beat.stats, duration: s.duration, position: st.lastPosition });
  } catch (err) {
    console.error('[listen] beat:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/heatmap', limiter(120), async (req, res) => {
  const kind = KINDS.has(req.query.kind) ? req.query.kind : '';
  const id = String(req.query.id || '');
  if (!kind || !(kind === 'audio' ? AUDIO_ID_RE : EPISODE_RE).test(id)) return res.status(400).json({ error: 'Invalid kind/id' });
  try {
    const doc = await getDb().collection(HEATMAP_COLLECTION).findOne({ kind, id });
    if (!doc || !Array.isArray(doc.buckets)) return res.json({ tracked: false });
    const max = Math.max(0, ...doc.buckets);
    res.set('Cache-Control', 'public, max-age=300');
    res.json({
      tracked: true, duration: doc.duration, bucketCount: doc.bucketCount, sessions: doc.sessions || 0, max,
      buckets: doc.buckets, normalized: doc.buckets.map((v) => (max > 0 ? Math.round((v / max) * 1000) / 1000 : 0)),
    });
  } catch (err) {
    console.error('[listen] heatmap:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
module.exports._test = { MAX_CONTIGUOUS_RATE, applyBeat, bucketIndex, resolveDuration, normalizeSource, clientIp, qualifies, creditSeconds, listenVouchMessage, proveListener, recordListenerReward, MAX_BEAT_CREDIT_MS, BUCKET_COUNT };
