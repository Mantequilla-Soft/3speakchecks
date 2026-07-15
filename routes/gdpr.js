/**
 * GDPR data-subject requests — "send me my data" (Art. 15) and "delete my data"
 * (Art. 17), submitted from the About / Contact tab in the app's settings.
 *
 *   POST /gdpr-request        → record a request, notify the privacy inbox
 *   GET  /gdpr-request/scope  → what we hold that is tied to a user (drives the UI copy)
 *
 * Two things this endpoint deliberately does NOT do:
 *
 *   1. It does not delete anything. A request is RECORDED and a human fulfils it.
 *      A self-service delete button that fires straight at the database is how you
 *      erase the wrong account from an unauthenticated POST. The law gives us one
 *      month (Art. 12(3)) — that is ample for a human to action it.
 *   2. It does not claim to touch the blockchain. Posts, comments, votes and
 *      viewer-tags are broadcast to Hive by the USER'S OWN KEYS. We are a
 *      front-end reading a public ledger; we cannot unpublish from it, and saying
 *      otherwise in a confirmation email would be a lie. The response copy says so.
 *
 * Mail goes out over an HTTP email API (Resend by default — no SMTP server to run).
 * If no API key is configured the request is still durably stored and the endpoint
 * still returns success: losing the request would be far worse than losing the
 * notification. `mailed: false` on the stored row flags the ones a human must go
 * looking for.
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getDb } = require('../utils/db');

const COLLECTION = 'gdpr-requests';
const HIVE_RE = /^[a-z][a-z0-9.-]{2,15}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TYPES = new Set(['export', 'delete']);

const MAIL_API_URL = process.env.GDPR_MAIL_API_URL || 'https://api.resend.com/emails';
const MAIL_API_KEY = process.env.GDPR_MAIL_API_KEY || '';
// TEMPORARY (2026-07-14): tibfox is the interim data-protection contact. Move this
// to a monitored role address (privacy@…) rather than a person — a data-subject
// request must not sit unread because one individual is on holiday, and the one-month
// Art. 12(3) clock runs regardless. Override with GDPR_MAIL_FROM / GDPR_MAIL_TO.
const MAIL_FROM = process.env.GDPR_MAIL_FROM || 'tibfox@3speak.tv';
const MAIL_TO = process.env.GDPR_MAIL_TO || 'tibfox@3speak.tv';

// Rate limit: a data-subject request is a once-in-a-blue-moon action. This exists
// to stop someone hammering the endpoint to spam the privacy inbox, not to gate
// legitimate use — the window is per Hive account.
const RATE_LIMIT_MS = 60 * 60 * 1000; // 1 per account per hour

/**
 * The personal data we hold that is keyed to a Hive account, and can therefore be
 * exported or deleted. Single source of truth: the UI renders this list verbatim,
 * so the promise the user reads is the promise the code keeps.
 *
 * `onChain: true` means the authoritative copy was signed and broadcast by the
 * user to Hive. We can drop OUR cached copy; the ledger record is beyond anyone's
 * reach, including ours. That distinction is the whole honesty of this feature.
 */
const DATA_SCOPE = [
  { key: 'videos', label: 'Video records', detail: 'Uploads, titles, descriptions, thumbnails and encoding metadata.', onChain: true },
  { key: 'playlists', label: 'Playlists', detail: 'Playlists you created and the videos in them.', onChain: false },
  { key: 'reshares', label: 'Reshares', detail: 'Videos you reshared.', onChain: true },
  { key: 'viewer-tags', label: 'Viewer tags', detail: 'Topic labels you applied to videos when voting.', onChain: true },
  { key: 'watch_history', label: 'Watch history', detail: 'Which videos you watched, if you left watch history enabled.', onChain: false },
  { key: 'user-filters', label: 'Feed preferences', detail: 'Creators and videos you hid, and your selected interests.', onChain: false },
  { key: 'subscriptions', label: 'Subscription records', detail: 'Your 3Speak Pro subscription and payment records, if any.', onChain: true },
];

// GET /gdpr-request/scope — what we hold. Drives the explainer in the settings UI.
router.get('/gdpr-request/scope', (_req, res) => {
  res.json({ success: true, scope: DATA_SCOPE });
});

async function notify(row) {
  if (!MAIL_API_KEY) return false;
  const lines = [
    `Type:     ${row.type === 'export' ? 'DATA EXPORT (Art. 15)' : 'DELETION (Art. 17)'}`,
    `Hive account: ${row.username}`,
    `Reply to: ${row.contact}`,
    `Received: ${row.createdAt.toISOString()}`,
    `Due by:   ${row.dueAt.toISOString()}  (one month, Art. 12(3))`,
    `Ref:      ${row.ref}`,
    '',
    'Message:',
    row.message || '(none)',
  ].join('\n');

  const resp = await fetch(MAIL_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${MAIL_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: MAIL_FROM,
      to: [MAIL_TO],
      reply_to: row.contact,
      subject: `[GDPR ${row.type}] @${row.username} — due ${row.dueAt.toISOString().slice(0, 10)}`,
      text: lines,
    }),
  });
  if (!resp.ok) throw new Error(`mail api ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  return true;
}

// POST /gdpr-request  body: { username, type: 'export'|'delete', contact, message? }
router.post('/gdpr-request', async (req, res) => {
  try {
    const username = String(req.body?.username || '').trim().toLowerCase().replace(/^@/, '');
    const type = String(req.body?.type || '').trim();
    const contact = String(req.body?.contact || '').trim();
    const message = String(req.body?.message || '').trim().slice(0, 2000);

    if (!HIVE_RE.test(username)) return res.status(400).json({ success: false, error: 'A valid Hive account name is required.' });
    if (!TYPES.has(type)) return res.status(400).json({ success: false, error: "type must be 'export' or 'delete'." });
    if (!EMAIL_RE.test(contact)) return res.status(400).json({ success: false, error: 'A valid email address is required so we can reply.' });

    const db = getDb();
    const coll = db.collection(COLLECTION);

    const recent = await coll.findOne(
      { username, createdAt: { $gt: new Date(Date.now() - RATE_LIMIT_MS) } },
      { projection: { _id: 1 } },
    );
    if (recent) {
      return res.status(429).json({ success: false, error: 'We already have a recent request for this account. We will be in touch — no need to send another.' });
    }

    const now = new Date();
    const row = {
      ref: crypto.randomBytes(6).toString('hex'),
      username,
      type,
      contact,
      message,
      status: 'open',
      createdAt: now,
      // Art. 12(3): one month to respond. Stored so it can be sorted/alerted on
      // rather than living in someone's head.
      dueAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      mailed: false,
    };

    await coll.insertOne(row);

    // Store first, notify second. A mail failure must never lose the request —
    // ignoring a data-subject request is among the most complained-about things
    // there is, and "our email broke" is not a defence.
    let mailed = false;
    try {
      mailed = await notify(row);
      if (mailed) await coll.updateOne({ ref: row.ref }, { $set: { mailed: true } });
    } catch (err) {
      console.error(`[gdpr] request ${row.ref} stored but NOT emailed:`, err.message);
    }

    res.json({
      success: true,
      ref: row.ref,
      dueBy: row.dueAt.toISOString().slice(0, 10),
    });
  } catch (err) {
    console.error('gdpr-request error:', err);
    res.status(500).json({ success: false, error: 'Could not record your request. Please email us directly.' });
  }
});

module.exports = router;
module.exports.DATA_SCOPE = DATA_SCOPE;
