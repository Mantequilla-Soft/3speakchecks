/**
 * Secret-gated GDPR admin API — drives the fulfilment logic in utils/gdprAdmin.js
 * from an external admin frontend (on another host). Same operations as the CLI.
 *
 *   GET  /gdpr-admin/requests?status=open|done|all   → list data-subject requests
 *   GET  /gdpr-admin/export/:username                → Art. 15 export (JSON)
 *   POST /gdpr-admin/delete   { username, dryRun }   → Art. 17 purge + suppression list
 *   POST /gdpr-admin/close    { ref }                → mark a request fulfilled
 *
 * AUTH: a shared secret in `Authorization: Bearer <secret>` (or `X-Admin-Secret`),
 * compared in constant time. FAIL-CLOSED: if GDPR_ADMIN_SECRET is unset the whole
 * router 503s — these operations (bulk delete!) must never be reachable unauthed.
 * The checker's CORS is already permissive, so a cross-origin admin host works; the
 * secret is the gate.
 *
 * SAFETY: delete is a DRY RUN by default. It only really deletes when the body has
 * `dryRun: false` explicitly — a missing/true flag just counts.
 */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getDb } = require('../utils/db');
const gdpr = require('../utils/gdprAdmin');

const ADMIN_SECRET = process.env.GDPR_ADMIN_SECRET || '';

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ab, bb); } catch { return false; }
}

// Gate every route below.
router.use((req, res, next) => {
  if (!ADMIN_SECRET) {
    // Not configured → refuse rather than expose admin ops. Log once-ish.
    return res.status(503).json({ error: 'gdpr admin disabled (no GDPR_ADMIN_SECRET set)' });
  }
  const hdr = req.get('authorization') || '';
  const bearer = hdr.startsWith('Bearer ') ? hdr.slice(7) : '';
  const provided = bearer || req.get('x-admin-secret') || '';
  if (!provided || !timingSafeEqual(provided, ADMIN_SECRET)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  return next();
});

// GET /gdpr-admin/requests?status=open|done|all
router.get('/requests', async (req, res) => {
  try {
    const status = ['open', 'done', 'all'].includes(req.query.status) ? req.query.status : 'open';
    res.json({ success: true, status, requests: await gdpr.listRequests(getDb(), { status }) });
  } catch (err) {
    console.error('[gdpr-admin] requests:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /gdpr-admin/export/:username
router.get('/export/:username', async (req, res) => {
  try {
    const username = gdpr.normUser(req.params.username);
    if (!gdpr.HIVE_RE.test(username)) return res.status(400).json({ error: 'invalid username' });
    res.json({ success: true, export: await gdpr.exportUser(getDb(), username) });
  } catch (err) {
    console.error('[gdpr-admin] export:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// POST /gdpr-admin/delete { username, dryRun }
router.post('/delete', async (req, res) => {
  try {
    const username = gdpr.normUser(req.body?.username);
    if (!gdpr.HIVE_RE.test(username)) return res.status(400).json({ error: 'invalid username' });
    // Real delete ONLY on an explicit dryRun:false. Anything else (missing/true) counts.
    const dryRun = req.body?.dryRun !== false;
    const result = await gdpr.deleteUser(getDb(), username, { dryRun });
    if (!dryRun) console.log(`[gdpr-admin] PURGED @${username}: ${result.total} rows, suppression-listed`);
    res.json({ success: true, result });
  } catch (err) {
    console.error('[gdpr-admin] delete:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// POST /gdpr-admin/close { ref }
router.post('/close', async (req, res) => {
  try {
    const ref = String(req.body?.ref || '').trim();
    if (!ref) return res.status(400).json({ error: 'ref required' });
    res.json({ success: true, result: await gdpr.closeRequest(getDb(), ref) });
  } catch (err) {
    console.error('[gdpr-admin] close:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;
