// POST /reviews — user feedback ("help us make 3Speak better"), written to the
// `reviews` collection with processed:false so it can be triaged later.
//
// No auth: a review may be anonymous (username optional) and may reference a
// specific video (permlink optional). `area` says where it came from
// (global / stream / upload / …). Lightly rate-limited per IP to deter spam.
const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');

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

router.post('/reviews', async (req, res) => {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
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

    const doc = {
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
      processed: false,          // triage flag — set true once reviewed
      created_at: new Date(),
    };

    ensureIndex();
    await getDb().collection('reviews').insertOne(doc);
    res.status(201).json({ ok: true });
  } catch (e) {
    console.error('POST /reviews failed:', e.message);
    res.status(500).json({ error: 'failed to save review' });
  }
});

module.exports = router;
