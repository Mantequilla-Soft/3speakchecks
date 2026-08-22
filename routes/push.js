/**
 * Web push subscription endpoints.
 *
 *   GET  /push/vapid-key            → the public key a browser needs to subscribe
 *   POST /push/subscribe            → { username, subscription }
 *   POST /push/unsubscribe          → { username, endpoint? }  (no endpoint = all their devices)
 *   POST /push/test                 → admin-only, sends one notification to a user
 *
 * See utils/webPush.js for why subscribe is unsigned.
 */
const express = require('express');
const router = express.Router();
const push = require('../utils/webPush');

const HIVE_RE = /^[a-z][a-z0-9.-]{2,15}$/;
const ADMIN_KEY = process.env.PUSH_ADMIN_KEY || '';

const cleanUser = (u) => String(u || '').trim().toLowerCase().replace(/^@/, '');

function validSubscription(sub) {
  return !!(sub
    && typeof sub.endpoint === 'string'
    && /^https:\/\//.test(sub.endpoint)
    && sub.endpoint.length < 1000
    && sub.keys
    && typeof sub.keys.p256dh === 'string'
    && typeof sub.keys.auth === 'string');
}

router.get('/vapid-key', (_req, res) => {
  if (!push.isConfigured()) return res.status(503).json({ success: false, error: 'push not configured' });
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({ success: true, publicKey: push.publicKey() });
});

router.post('/subscribe', async (req, res) => {
  try {
    if (!push.isConfigured()) return res.status(503).json({ success: false, error: 'push not configured' });
    const username = cleanUser(req.body && req.body.username);
    const subscription = req.body && req.body.subscription;
    if (!HIVE_RE.test(username)) return res.status(400).json({ success: false, error: 'invalid username' });
    if (!validSubscription(subscription)) return res.status(400).json({ success: false, error: 'invalid subscription' });

    await push.saveSubscription({ username, subscription, userAgent: req.headers['user-agent'] });
    res.json({ success: true });
  } catch (err) {
    console.error('[push] subscribe error:', err.message);
    res.status(500).json({ success: false, error: 'could not save subscription' });
  }
});

router.post('/unsubscribe', async (req, res) => {
  try {
    const username = cleanUser(req.body && req.body.username);
    const endpoint = req.body && req.body.endpoint;
    if (!HIVE_RE.test(username)) return res.status(400).json({ success: false, error: 'invalid username' });
    // Deleting by endpoint alone is safe: it is unguessable, and whoever holds
    // it is the browser that owns it.
    const removed = await push.removeSubscription({
      username,
      endpoint: typeof endpoint === 'string' && endpoint ? endpoint : null,
    });
    res.json({ success: true, removed });
  } catch (err) {
    console.error('[push] unsubscribe error:', err.message);
    res.status(500).json({ success: false, error: 'could not remove subscription' });
  }
});

// Preferences are readable without auth for the same reason subscribe is
// unsigned (see utils/webPush.js): "does @x want to hear about new shorts" is
// not information worth protecting, and the UI needs it before any signing
// prompt would make sense.
router.get('/prefs', async (req, res) => {
  const username = cleanUser(req.query.username);
  if (!HIVE_RE.test(username)) return res.status(400).json({ success: false, error: 'invalid username' });
  res.json({ success: true, kinds: push.KINDS, prefs: await push.getPrefs(username) });
});

router.post('/prefs', async (req, res) => {
  try {
    const username = cleanUser(req.body && req.body.username);
    if (!HIVE_RE.test(username)) return res.status(400).json({ success: false, error: 'invalid username' });
    const prefs = (req.body && req.body.prefs) || {};
    if (typeof prefs !== 'object') return res.status(400).json({ success: false, error: 'invalid prefs' });
    res.json({ success: true, prefs: await push.savePrefs(username, prefs) });
  } catch (err) {
    console.error('[push] prefs error:', err.message);
    res.status(500).json({ success: false, error: 'could not save preferences' });
  }
});

router.post('/test', async (req, res) => {
  if (!ADMIN_KEY || req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(403).json({ success: false, error: 'forbidden' });
  }
  const username = cleanUser(req.body && req.body.username);
  if (!HIVE_RE.test(username)) return res.status(400).json({ success: false, error: 'invalid username' });
  const result = await push.sendToUser(username, {
    title: '3Speak',
    body: (req.body && req.body.body) || 'Test notification',
    url: '/',
    tag: 'test',
  });
  res.json({ success: true, ...result });
});

module.exports = router;
