// Announcements: the one-off popup 3speak.tv shows logged-in users when it opens.
//
//   GET  /announcements/latest            → { announcement }: the newest active one for everybody
//   POST /announcements/latest            → { announcement, personal }: the same, plus the newest
//                                           one addressed to the account a 3Speak vouch proves
//   POST /announcements/:number/replies   → a viewer's reply, if that announcement allows one
//
// The announcements themselves are written straight into Mongo by a separate admin
// frontend on another server; this checker only READS them. Each document in
// `announcements`:
//
//   {
//     number:     12,                         // int, unique, higher = newer (REQUIRED)
//     message:    "Text of the popup",        // plain text, newlines kept (REQUIRED)
//     link:       "https://3speak.tv/..." ,   // optional, https:// or a /path on 3speak.tv
//     linkText:   "Read more",                // optional, button label for `link`
//     imagePath:  "https://.../banner.png",   // optional, https:// or a /path on 3speak.tv
//     canRespond: false,                      // optional, true = show a reply box
//     active:     true,                       // optional, false = never shown (default shown)
//     username:   "alice",                    // optional, ONLY @alice gets it; also ["alice","bob"]
//     createdAt:  ISODate(...)                // optional, for the admin's own sorting
//   }
//
// The browser remembers the highest `number` it has shown and pops up only for a
// higher one, so publishing = inserting a document with a bigger number. Addressed
// announcements are tracked separately (per account), so a personal message never
// swallows the general announcement that came before it.
//
// An addressed announcement is private: it is only ever returned to a request that
// carries a 'read-vouch' for that account, signed by @threespeak's own posting key
// (the 3Speak API issues one for a session it verified). Typing a name gets nothing.
//
// Replies land in `announcement_replies` with processed:false for triage:
//
//   { number, text, username, claimed_username, signed_by, app_version,
//     processed: false, created_at }
//
// `username` is set ONLY when the 3Speak API vouched for the session that sent it
// (a 'reply-vouch' signed by @threespeak's own posting key, the same mechanism as
// /advertise/mine). Anything else is a claim, so it goes in `claimed_username`
// and must be read as such: anyone can type any name into a POST.
const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');
const { verifyDelegateVouch } = require('../utils/hiveAuth');
const { AD_SIGNING_DELEGATES } = require('../utils/config');

const COLLECTION = 'announcements';
const REPLIES = 'announcement_replies';
const HIVE_RE = /^[a-z][a-z0-9.-]{2,15}$/;
// A Hive account, or a ButrAuth warm-up handle written `~handle` (no Hive name yet;
// `~` cannot occur in a Hive name, so the two can never be confused). Address a
// warm-up user with username: "~handle".
const isRecipientName = (n) => HIVE_RE.test(n) || (n.startsWith('~') && HIVE_RE.test(n.slice(1)));
const MAX_REPLY = 2000;
const VOUCH_MAX_AGE_MS = 10 * 60 * 1000;

// Keep in lockstep with POST /api/announcements/reply-signature in the 3Speak API
// (preview-3speak/server/index.cjs). Bound to the announcement number, with its own
// action word, so no other vouch or user-signed message can stand in for it.
const replyVouchMessage = (account, number, timestamp) =>
  ['3speak-announce', 'reply-vouch', account, String(number), String(timestamp)].join('|');
// Keep in lockstep with POST /api/announcements/read-signature in the same file.
const readVouchMessage = (account, timestamp) =>
  ['3speak-announce', 'read-vouch', account, String(timestamp)].join('|');

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Only absolute https URLs or a same-site path ("/watch?v=..."). Rules out
// javascript:, data: and protocol-relative "//evil" whatever the admin tool stores.
function safeUrl(v) {
  const s = str(v, 2000);
  if (!s) return null;
  if (s.startsWith('/') && !s.startsWith('//')) return s;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch (_) {
    return null;
  }
}

// Who an announcement is addressed to, normalised. [] = everybody.
function targetsOf(doc) {
  const raw = Array.isArray(doc.username) ? doc.username : [doc.username];
  return raw
    .map((u) => (typeof u === 'string' ? u.trim().toLowerCase().replace(/^@/, '') : ''))
    .filter(Boolean);
}

// The account a vouch proves, or null. Never throws: a bad proof is just no proof.
async function provenAccount(b, message) {
  const name = str(b.username, 32).toLowerCase().replace(/^@/, '');
  if (!isRecipientName(name) || !b.signature || !b.timestamp) return { name, proven: null, signer: null };
  const ts = Number(b.timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > VOUCH_MAX_AGE_MS) return { name, proven: null, signer: null };
  try {
    const v = await verifyDelegateVouch({
      message: message(name, ts),
      signature: String(b.signature),
      delegates: AD_SIGNING_DELEGATES,
    });
    return v.ok ? { name, proven: name, signer: v.signer } : { name, proven: null, signer: null };
  } catch (_) {
    return { name, proven: null, signer: null };
  }
}

// What goes to the browser. The recipient list never does: on a multi-recipient
// announcement it would tell each of them who else got it.
function present(doc) {
  if (!doc || !Number.isInteger(doc.number) || doc.number < 1) return null;
  const message = str(doc.message, 5000);
  if (!message) return null;
  const link = safeUrl(doc.link);
  return {
    number: doc.number,
    message,
    link,
    linkText: link ? (str(doc.linkText, 80) || null) : null,
    imagePath: safeUrl(doc.imagePath),
    canRespond: doc.canRespond === true,
  };
}

// Every page load of 3speak.tv asks for this, so it is answered from memory. Mongo is
// the slow part of this box (see utils/feedCache.js); a new announcement shows up
// within CACHE_MS, which is plenty for something published by hand. One read covers
// everybody: the newest general announcement, and the recent addressed ones to pick
// from per request.
const CACHE_MS = 60 * 1000;
const SCAN_LIMIT = 200;
let cached = { at: 0, value: null };

async function snapshot() {
  if (cached.value && Date.now() - cached.at < CACHE_MS) return cached.value;
  const docs = await getDb().collection(COLLECTION)
    .find({ active: { $ne: false } })
    .sort({ number: -1 })
    .limit(SCAN_LIMIT)
    .toArray();
  let general = null;
  const addressed = [];
  for (const doc of docs) {
    const shown = present(doc);
    if (!shown) continue;
    const targets = targetsOf(doc);
    if (targets.length) addressed.push({ targets, shown });
    else if (!general) general = shown;
  }
  cached = { at: Date.now(), value: { general, addressed } };
  return cached.value;
}

// Indexes created once, lazily: getDb() is not connected at require time.
// `number` is unique so the admin tool cannot publish two announcements under one
// number (one of them would never be seen by anybody who saw the other).
let indexed = false;
function ensureIndexes() {
  if (indexed) return;
  indexed = true;
  const db = getDb();
  Promise.all([
    db.collection(COLLECTION).createIndex({ number: -1 }, { unique: true }),
    db.collection(REPLIES).createIndex({ number: 1, created_at: -1 }),
    db.collection(REPLIES).createIndex({ processed: 1, created_at: -1 }),
  ]).catch((e) => { indexed = false; console.error('[announcements] index create failed:', e.message); });
}

// Per-IP throttle for replies (5 / 10 min), same shape as routes/reviews.js.
const hits = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 5;
function throttled(ip) {
  if (!ip) return false;
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= MAX_PER_WINDOW) { hits.set(ip, arr); return true; }
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (!v.some((t) => now - t < WINDOW_MS)) hits.delete(k);
  }
  return false;
}
const clientIp = (req) => String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.ip || '')
  .split(',')[0].trim();

router.get('/announcements/latest', async (_req, res) => {
  try {
    ensureIndexes();
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ announcement: (await snapshot()).general });
  } catch (e) {
    console.error('GET /announcements/latest failed:', e.message);
    res.status(500).json({ error: 'failed to load announcement' });
  }
});

// body: { username, signature, timestamp } — a read-vouch from the 3Speak API.
router.post('/announcements/latest', async (req, res) => {
  try {
    ensureIndexes();
    res.set('Cache-Control', 'no-store');
    const { general, addressed } = await snapshot();
    const { proven } = await provenAccount(req.body || {}, readVouchMessage);
    const mine = proven ? addressed.find((a) => a.targets.includes(proven)) : null;
    res.json({ announcement: general, personal: mine ? mine.shown : null });
  } catch (e) {
    console.error('POST /announcements/latest failed:', e.message);
    res.status(500).json({ error: 'failed to load announcement' });
  }
});

router.post('/announcements/:number/replies', async (req, res) => {
  try {
    const number = Number(req.params.number);
    if (!Number.isInteger(number) || number < 1) return res.status(400).json({ error: 'invalid announcement' });

    const b = req.body || {};
    const text = str(b.text, MAX_REPLY + 1);
    if (!text) return res.status(400).json({ error: 'text is required' });
    if (text.length > MAX_REPLY) return res.status(400).json({ error: `text must be at most ${MAX_REPLY} characters` });

    if (throttled(clientIp(req))) return res.status(429).json({ error: 'Too many replies, please try again later' });

    const db = getDb();
    const ann = await db.collection(COLLECTION).findOne(
      { number, active: { $ne: false } },
      { projection: { canRespond: 1, username: 1 } },
    );
    if (!ann) return res.status(404).json({ error: 'announcement not found' });

    const { name, proven: username, signer: signedBy } =
      await provenAccount(b, (acc, ts) => replyVouchMessage(acc, number, ts));

    // An addressed announcement takes replies from its recipients only, and to
    // anyone else it does not exist (same 404 as a wrong number).
    const targets = targetsOf(ann);
    if (targets.length && !(username && targets.includes(username))) {
      return res.status(404).json({ error: 'announcement not found' });
    }
    if (ann.canRespond !== true) return res.status(403).json({ error: 'this announcement does not take replies' });

    ensureIndexes();
    await db.collection(REPLIES).insertOne({
      number,
      text,
      username,
      claimed_username: username ? null : (isRecipientName(name) ? name : null),
      signed_by: signedBy,
      app_version: str(b.app_version, 32) || null,
      processed: false,
      created_at: new Date(),
    });
    res.status(201).json({ ok: true, verified: !!username });
  } catch (e) {
    console.error('POST /announcements/:number/replies failed:', e.message);
    res.status(500).json({ error: 'failed to save reply' });
  }
});

module.exports = router;
