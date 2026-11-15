// POST /reviews — user feedback ("help us make 3Speak better"), written to the
// `reviews` collection with processed:false so it can be triaged later.
//
// No auth: a review may be anonymous (username optional) and may reference a
// specific video (permlink optional). `area` says where it came from
// (global / stream / upload / …). Lightly rate-limited per IP to deter spam.
//
// Optional `screenshot`: a data URL (PNG, JPEG or WebP, at most 750 kB of image).
// It is kept PRIVATE in `review_screenshots` (never on a public image host: a
// screenshot can show a wallet or a DM), and the review row only carries its
// id, type and size. Read one with `node scripts/review-screenshot.js <reviewId>`.
const express = require('express');
const { ObjectId, Binary } = require('mongodb');
const router = express.Router();
const { getDb } = require('../utils/db');
const { clientIp } = require('../utils/clientIp');

// The global parser stops at 100 kB; a review with a screenshot is bigger. This
// path is listed in utils/jsonBody.js OWN_PARSER so this parser is the one used.
// 1 MB is also nginx's default body limit, which the checker vhosts keep for
// `location /`: 750 kB of image is ~1000 kB as base64, so the whole review fits.
const reviewJson = express.json({ limit: '1mb' });

const MAX_SCREENSHOT_BYTES = 750 * 1024;
const SCREENSHOT_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

// The first bytes of each allowed type, so a renamed file of another kind is refused.
function magicMatches(mime, buf) {
  if (mime === 'image/png') return buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47;
  if (mime === 'image/jpeg') return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (mime === 'image/webp') return buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

/** undefined = none sent; null = sent but not acceptable; else { mime, buf }. */
function parseScreenshot(v) {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') return null;
  const m = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(v);
  if (!m || !SCREENSHOT_MIMES.has(m[1])) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > MAX_SCREENSHOT_BYTES || !magicMatches(m[1], buf)) return null;
  return { mime: m[1], buf };
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Tiny in-memory per-IP throttle (5 / 10 min). Enough to stop trivial spamming
// with no extra dependency; the map resets on restart, which is fine here.
const hits = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 5;
function throttled(ip) {
  if (!ip) return false;
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= MAX_PER_WINDOW) { hits.set(ip, arr); return true; }
  arr.push(now); hits.set(ip, arr);
  return false;
}

// Create the triage index once (lazily — getDb() isn't connected at require time).
let indexed = false;
function ensureIndex() {
  if (indexed) return;
  indexed = true;
  getDb().collection('reviews')
    .createIndex({ processed: 1, created_at: -1 })
    .catch((e) => { indexed = false; console.error('[reviews] index create failed:', e.message); });
}

router.post('/reviews', reviewJson, async (req, res) => {
  try {
    const ip = clientIp(req);
    if (throttled(ip)) return res.status(429).json({ error: 'Too many reviews, please try again later' });

    const b = req.body || {};

    const stars = Number(b.stars);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
      return res.status(400).json({ error: 'stars must be an integer between 1 and 5' });
    }

    // aspects: free-ish tags, but normalised + de-duped + capped so the collection
    // stays clean regardless of what the client sends.
    let aspects = Array.isArray(b.aspects)
      ? b.aspects.map((a) => str(a, 32).toLowerCase()).filter(Boolean)
      : [];
    aspects = [...new Set(aspects)].slice(0, 12);

    const recommend = (b.recommend === true || b.recommend === false) ? b.recommend : null;

    const shot = parseScreenshot(b.screenshot);
    if (shot === null) {
      return res.status(400).json({ error: 'screenshot must be a PNG, JPEG or WebP image of at most 750 kB' });
    }

    const reviewId = new ObjectId();
    const doc = {
      _id: reviewId,
      area: str(b.area, 32).toLowerCase() || 'global',
      username: str(b.username, 32) || null,
      permlink: str(b.permlink, 255) || null,
      stars,
      aspects,
      recommend,
      comment: str(b.comment, 4000),
      app_version: str(b.app_version, 32) || null,
      path: str(b.path, 255) || null,
      user_agent: str(req.headers['user-agent'], 400) || null,
      screenshot: null,          // { id, mime, bytes } when one was attached
      processed: false,          // triage flag — set true once reviewed
      created_at: new Date(),
    };

    ensureIndex();
    const db = getDb();
    if (shot) {
      const shotId = new ObjectId();
      await db.collection('review_screenshots').insertOne({
        _id: shotId, review_id: reviewId, mime: shot.mime, bytes: shot.buf.length,
        data: new Binary(shot.buf), created_at: doc.created_at,
      });
      doc.screenshot = { id: shotId, mime: shot.mime, bytes: shot.buf.length };
    }
    try {
      await db.collection('reviews').insertOne(doc);
    } catch (e) {
      // No review row to hang it on: drop the screenshot rather than keep an orphan.
      if (doc.screenshot) await db.collection('review_screenshots').deleteOne({ _id: doc.screenshot.id }).catch(() => {});
      throw e;
    }
    res.status(201).json({ ok: true });
  } catch (e) {
    console.error('POST /reviews failed:', e.message);
    res.status(500).json({ error: 'failed to save review' });
  }
});

module.exports = router;
