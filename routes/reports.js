// POST /reports — a viewer reporting a live stream / room for abuse.
//
// Writes into the SHARED `reporteddatas` collection — the same one the mod
// frontend + Discord bot already read for post/comment/short reports — with
// `type: 'stream'`, so a stream report flows through the exact same moderation
// pipeline instead of a separate collection nothing consumes.
//
// Document shape mirrors the existing reporteddatas docs:
//   { name, type, reason, comment, reportedBy, createdAt, checked }
// name = "<host>/<roomName>", mirroring "<author>/<permlink>" for posts.
const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Map the app's report reasons onto the moderation vocabulary already in use
// in reporteddatas (sexual / violence / spam / hate_speech / … ). Unknown → other.
const REASON_MAP = {
  harassment: 'hate_speech',
  sexual: 'sexual',
  violence: 'violence',
  spam: 'spam',
  illegal: 'illegal',
  selfharm: 'selfharm',
  other: 'other',
};

// Tiny in-memory per-IP throttle (5 / 10 min), same as reviews.
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

router.post('/reports', async (req, res) => {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    if (throttled(ip)) return res.status(429).json({ error: 'Too many reports, please try again later' });

    const b = req.body || {};

    const reasonRaw = str(b.reason, 32).toLowerCase();
    if (!reasonRaw) return res.status(400).json({ error: 'reason is required' });
    const reason = REASON_MAP[reasonRaw] || 'other';

    const host = str(b.reported, 32);
    const room = str(b.roomName, 128);
    // "<host>/<roomName>" mirrors "<author>/<permlink>"; fall back to whichever exists.
    const name = host && room ? `${host}/${room}` : (host || room || 'unknown');

    // Matches the reporteddatas schema the bot + frontend already read, plus a
    // couple of harmless extras (url, app_version) for moderator triage.
    const doc = {
      name,
      type: 'stream',
      reason,
      comment: str(b.detail, 4000),
      reportedBy: str(b.reporter, 32) || 'anonymous',
      url: str(b.url, 512) || null,
      app_version: str(b.app_version, 32) || null,
      checked: false,           // triage flag, same as reportedusers
      createdAt: new Date(),
    };

    await getDb().collection('reporteddatas').insertOne(doc);
    res.status(201).json({ ok: true });
  } catch (e) {
    console.error('POST /reports failed:', e.message);
    res.status(500).json({ error: 'failed to save report' });
  }
});

module.exports = router;
