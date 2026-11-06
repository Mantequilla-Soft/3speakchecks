/**
 * Web push subscription endpoints.
 *
 *   GET  /push/vapid-key            → the public key a browser needs to subscribe
 *   POST /push/subscribe            → { username, subscription }
 *   POST /push/unsubscribe          → { username, endpoint? }  (no endpoint = all their devices)
 *   POST /push/prefs                → { username, prefs, signature, timestamp }
 *   POST /push/test                 → admin-only, sends one notification to a user
 *
 * See utils/webPush.js for why subscribe is unsigned.
 *
 * Switching notifications OFF for an account does affect that account, so the two
 * writes that act on an account as a whole need proof that the caller is it:
 *   - unsubscribe without an endpoint (every browser of the account): always.
 *     The app only ever unsubscribes its own endpoint, which needs no proof.
 *   - saving preferences: when PUSH_REQUIRE_PROOF=true. Until the app sends the
 *     proof, an unproven save is still taken and logged once per account.
 *
 * The proof is the same session vouch our API (3speak.tv server/index.cjs,
 * POST /api/podcasts/signature { action: 'push', payload: 'session' }) signs for
 * listening progress and listener rewards: "we verified a session for @x", signed
 * with @threespeak's own posting key (AD_SIGNING_DELEGATES), reusable for a day.
 * Every login type gets one without a wallet prompt.
 */
const express = require('express');
const router = express.Router();
const push = require('../utils/webPush');
const { verifyDelegateVouch } = require('../utils/hiveAuth');
const { AD_SIGNING_DELEGATES } = require('../utils/config');

const HIVE_RE = /^[a-z][a-z0-9.-]{2,15}$/;
const ADMIN_KEY = process.env.PUSH_ADMIN_KEY || '';

const { asText } = require('../utils/input');

const cleanUser = (u) => asText(u).trim().toLowerCase().replace(/^@/, '');

// Read per request so the switch is visible in one place; flipping it still
// means a restart like any other env change.
const proofRequired = () => String(process.env.PUSH_REQUIRE_PROOF || '').trim().toLowerCase() === 'true';

const VOUCH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Must match the vouch our API signs (signVouch in 3speak.tv server/index.cjs).
const pushVouchMessage = (user, timestamp) => ['3speak-podcasts', 'push-vouch', user, 'session', String(timestamp)].join('|');

/** 'ok', or why not: 'missing', 'expired', 'invalid'. Never throws. */
async function proofFor(body, user) {
  const signature = typeof body.signature === 'string' ? body.signature.slice(0, 200) : '';
  const timestamp = parseInt(asText(body.timestamp), 10);
  if (!signature || !Number.isFinite(timestamp)) return 'missing';
  if (Math.abs(Date.now() - timestamp) > VOUCH_MAX_AGE_MS) return 'expired';
  try {
    const v = await verifyDelegateVouch({ message: pushVouchMessage(user, timestamp), signature, delegates: AD_SIGNING_DELEGATES });
    return v.ok ? 'ok' : 'invalid';
  } catch (_) {
    return 'invalid'; // a signature that does not even parse
  }
}

// One log line per account while unproven saves are still let through.
const loggedUnproven = new Set();
function logUnproven(user, why) {
  if (loggedUnproven.has(user)) return;
  if (loggedUnproven.size >= 5000) loggedUnproven.clear();
  loggedUnproven.add(user);
  console.warn(`[push] prefs saved for @${user} without a valid session vouch (${why}); PUSH_REQUIRE_PROOF is off`);
}

const proofError = (why) => (why === 'missing' ? 'Signature required' : why === 'expired' ? 'timestamp out of tolerance' : 'Invalid signature');

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
    // it is the browser that owns it. Every browser of an account at once is
    // only for the account itself.
    const byEndpoint = typeof endpoint === 'string' && endpoint ? endpoint : null;
    if (!byEndpoint) {
      const why = await proofFor(req.body || {}, username);
      if (why !== 'ok') return res.status(401).json({ success: false, error: proofError(why) });
    }
    const removed = await push.removeSubscription({ username, endpoint: byEndpoint });
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
    const why = await proofFor(req.body || {}, username);
    if (why !== 'ok') {
      if (proofRequired()) return res.status(401).json({ success: false, error: proofError(why) });
      logUnproven(username, why);
    }
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
