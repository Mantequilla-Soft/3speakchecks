const express = require('express');
const router = express.Router();
const { asText } = require('../utils/input');
const { proveProgressUser } = require('../utils/progressVouch');
const {
  PREMIERE_CHAT_MAX_CHARS, PREMIERE_CHAT_PER_MIN, PREMIERE_CHAT_GAP_MS,
} = require('../utils/config');
const premieres = require('../services/premieres');

/* ────────────────────────────────────────────────────────────────────
 * Premieres (services/premieres.js). Reads are public; every write takes the
 * session vouch (utils/progressVouch.js) in a POST body, never a URL.
 *
 *   GET  /premieres/upcoming?owner=&limit=      upcoming or live premieres, soonest first
 *   GET  /premieres/:owner/:permlink            one premiere (+ how many asked to be told)
 *   POST /premieres/reminders                   { user, signature, timestamp }
 *                                               the viewer's reminders not over yet, and
 *                                               `due`: the ones that have started
 *   POST /premieres/:owner/:permlink/remind     { ...vouch, on }  "Notify me" on / off
 *   GET  /premieres/:owner/:permlink/chat?after=<ms>   messages after a time (polled)
 *   POST /premieres/:owner/:permlink/chat       { ...vouch, text }  only while live
 *   POST /premieres/:owner/:permlink/chat/remove { ...vouch, id }   its author or the creator
 *
 * Chat stays here: nothing is ever posted to Hive for the viewer. A message is
 * stored with `offset`, the seconds into the video when it was sent, measured by
 * the server from the premiere's start (everyone plays at that same offset), so
 * after the premiere it replays as timecoded messages.
 * ──────────────────────────────────────────────────────────────────── */

const OWNER_RE = /^[a-z0-9][a-z0-9.-]{1,31}$/;
const PERMLINK_RE = /^[A-Za-z0-9_.-]{1,256}$/;

function videoOf(req, res) {
  const owner = asText(req.params.owner).trim().toLowerCase().replace(/^@/, '');
  const permlink = asText(req.params.permlink).trim();
  if (!OWNER_RE.test(owner) || !PERMLINK_RE.test(permlink)) {
    res.status(400).json({ success: false, error: 'invalid video' });
    return null;
  }
  return { owner, permlink };
}

// Per viewer, in memory (as the other vouched writes): reminders, and chat.
function brake(limitPerWindow, windowMs) {
  const seen = new Map();
  return (key, now = Date.now()) => {
    const list = (seen.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= limitPerWindow) return true;
    list.push(now);
    seen.set(key, list);
    if (seen.size > 5000) seen.delete(seen.keys().next().value);
    return false;
  };
}
const tooManyReminders = brake(120, 60 * 60 * 1000);
const tooManyMessages = brake(PREMIERE_CHAT_PER_MIN, 60 * 1000);
const lastMessageAt = new Map();

/** One line of plain text: no control characters, runs of space folded, capped in characters. */
function cleanText(raw) {
  const flat = asText(raw).replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e]/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(flat).slice(0, PREMIERE_CHAT_MAX_CHARS).join('');
}

router.get('/upcoming', async (req, res) => {
  const ownerRaw = asText(req.query.owner).trim().toLowerCase().replace(/^@/, '');
  if (ownerRaw && !OWNER_RE.test(ownerRaw)) return res.status(400).json({ success: false, error: 'invalid owner' });
  const limit = Math.min(24, Math.max(1, parseInt(asText(req.query.limit), 10) || 12));
  try {
    const list = await premieres.listOpen({ owner: ownerRaw || null, limit });
    res.set('Cache-Control', 'public, max-age=30');
    res.json({ success: true, now: new Date().toISOString(), premieres: list });
  } catch (err) {
    console.error('[premieres] upcoming failed:', err && err.message);
    res.status(500).json({ success: false, error: 'could not load' });
  }
});

router.post('/reminders', express.json({ limit: '2kb' }), async (req, res) => {
  const user = await proveProgressUser(req.body || {});
  if (!user) return res.status(401).json({ success: false, error: 'Invalid signature' });
  res.set('Cache-Control', 'no-store');
  try {
    const list = await premieres.remindersOf(user);
    res.json({
      success: true, now: new Date().toISOString(), reminders: list, due: list.filter((p) => p.state === 'live'),
    });
  } catch (err) {
    console.error('[premieres] reminders failed:', err && err.message);
    res.status(500).json({ success: false, error: 'could not load' });
  }
});

router.get('/:owner/:permlink', async (req, res) => {
  const v = videoOf(req, res);
  if (!v) return undefined;
  try {
    const p = await premieres.findPremiere(v.owner, v.permlink);
    res.set('Cache-Control', 'public, max-age=10');
    if (!p) return res.status(404).json({ success: false, error: 'not a premiere', now: new Date().toISOString() });
    const { count } = await premieres.reminderInfo(v.owner, v.permlink);
    return res.json({ success: true, now: new Date().toISOString(), premiere: { ...p, reminders: count } });
  } catch (err) {
    console.error('[premieres] lookup failed:', err && err.message);
    return res.status(500).json({ success: false, error: 'could not load' });
  }
});

router.post('/:owner/:permlink/remind', express.json({ limit: '2kb' }), async (req, res) => {
  const v = videoOf(req, res);
  if (!v) return undefined;
  const b = req.body || {};
  const user = await proveProgressUser(b);
  if (!user) return res.status(401).json({ success: false, error: 'Invalid signature' });
  if (tooManyReminders(user)) return res.status(429).json({ success: false, error: 'too many updates' });
  try {
    const p = await premieres.findPremiere(v.owner, v.permlink);
    if (!p) return res.status(404).json({ success: false, error: 'not a premiere' });
    const on = b.on !== false;
    // Asking to be told about something that already started tells nobody anything.
    if (on && p.state !== 'upcoming') return res.status(409).json({ success: false, error: 'already started' });
    await premieres.setReminder(user, v.owner, v.permlink, on);
    const info = await premieres.reminderInfo(v.owner, v.permlink, user);
    return res.json({ success: true, reminded: info.reminded, reminders: info.count });
  } catch (err) {
    console.error('[premieres] remind failed:', err && err.message);
    return res.status(500).json({ success: false, error: 'could not save' });
  }
});

router.get('/:owner/:permlink/chat', async (req, res) => {
  const v = videoOf(req, res);
  if (!v) return undefined;
  const after = Math.max(0, parseInt(asText(req.query.after), 10) || 0);
  try {
    const p = await premieres.findPremiereCached(v.owner, v.permlink);
    if (!p) return res.status(404).json({ success: false, error: 'not a premiere' });
    const { messages, removed } = await premieres.chatSince(v.owner, v.permlink, after);
    res.set('Cache-Control', p.state === 'ended' ? 'public, max-age=60' : 'no-store');
    return res.json({
      success: true, now: new Date().toISOString(), state: p.state, open: p.state === 'live', messages, removed,
    });
  } catch (err) {
    console.error('[premieres] chat read failed:', err && err.message);
    return res.status(500).json({ success: false, error: 'could not load' });
  }
});

router.post('/:owner/:permlink/chat', express.json({ limit: '4kb' }), async (req, res) => {
  const v = videoOf(req, res);
  if (!v) return undefined;
  const b = req.body || {};
  const user = await proveProgressUser(b);
  if (!user) return res.status(401).json({ success: false, error: 'Invalid signature' });
  const text = cleanText(b.text);
  if (!text) return res.status(400).json({ success: false, error: 'empty message' });
  const now = Date.now();
  if (now - (lastMessageAt.get(user) || 0) < PREMIERE_CHAT_GAP_MS || tooManyMessages(user, now)) {
    return res.status(429).json({ success: false, error: 'slow down' });
  }
  try {
    const p = await premieres.findPremiereCached(v.owner, v.permlink, now);
    if (!p) return res.status(404).json({ success: false, error: 'not a premiere' });
    if (p.state !== 'live') return res.status(409).json({ success: false, error: p.state === 'upcoming' ? 'not started' : 'chat closed' });
    lastMessageAt.set(user, now);
    if (lastMessageAt.size > 5000) lastMessageAt.delete(lastMessageAt.keys().next().value);
    const elapsed = (now - Date.parse(p.startAt)) / 1000;
    const offset = Math.max(0, Math.round((p.duration > 0 ? Math.min(elapsed, p.duration) : elapsed) * 10) / 10);
    const message = await premieres.addChat({ ...v, user, text, offset, at: new Date(now) });
    return res.status(201).json({ success: true, message });
  } catch (err) {
    console.error('[premieres] chat write failed:', err && err.message);
    return res.status(500).json({ success: false, error: 'could not save' });
  }
});

router.post('/:owner/:permlink/chat/remove', express.json({ limit: '2kb' }), async (req, res) => {
  const v = videoOf(req, res);
  if (!v) return undefined;
  const b = req.body || {};
  const user = await proveProgressUser(b);
  if (!user) return res.status(401).json({ success: false, error: 'Invalid signature' });
  try {
    const ok = await premieres.removeChat({ ...v, id: asText(b.id), by: user });
    if (!ok) return res.status(404).json({ success: false, error: 'no such message of yours' });
    return res.json({ success: true });
  } catch (err) {
    console.error('[premieres] chat remove failed:', err && err.message);
    return res.status(500).json({ success: false, error: 'could not save' });
  }
});

module.exports = router;
module.exports._cleanText = cleanText;
