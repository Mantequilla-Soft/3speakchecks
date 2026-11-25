/**
 * Daily PUBLISH limit, public read (utils/publishLimit.js has the rules,
 * utils/publishQuota.js what counts):
 *
 *   GET /publish-quota/:owner?kind=video|short[&at=<ISO>][&exclude=<permlink>]
 *     at       the publish time to check, default now
 *     exclude  a scheduled post being rescheduled (never conflicts with itself)
 *
 *   200 { success: true, enabled, exempt, reason: 'pro'|'listed'|'warmup'|null,
 *         kind, limit, window_hours: 24, at, allowed,
 *         conflicts: [{ permlink, title, at, scheduled }],   publishes of the kind
 *                                                          within 24h of `at`, oldest first
 *         next_free_at }                                   earliest allowed time
 *                                                          >= max(at, now); null when
 *                                                          exempt or disabled
 *   400 a bad owner, kind or at.
 *
 * The scheduled-posts routes enforce the same answer (429, code
 * 'daily_publish_limit'). A lookup that fails answers allowed: true, as the
 * enforcement lets the publish through then too.
 *
 * Mounted at '/' before the streamStats gate (see the ordering note in server.js).
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { asText } = require('../utils/input');
const { KINDS, WINDOW_HOURS, limitsConfig, normName } = require('../utils/publishLimit');
const { quotaFor } = require('../utils/publishQuota');

const router = express.Router();

// Hive accounts, and warm-up handles (which may start with a digit).
const OWNER_RE = /^[a-z0-9][a-z0-9.-]{2,15}$/;
const DAY_MS = 24 * 3600 * 1000;
// How far `at` may be from now: a few days back, a year ahead (scheduling stops at 90 days).
const AT_PAST_MS = 7 * DAY_MS;
const AT_AHEAD_MS = 366 * DAY_MS;

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: false,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests' },
});

router.get('/publish-quota/:owner', limiter, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const owner = normName(req.params.owner);
  if (!OWNER_RE.test(owner)) return res.status(400).json({ success: false, error: 'invalid owner' });
  const kind = asText(req.query.kind).trim().toLowerCase();
  if (!KINDS.includes(kind)) return res.status(400).json({ success: false, error: 'kind must be video or short' });
  const rawAt = asText(req.query.at).trim();
  const now = Date.now();
  const at = rawAt ? Date.parse(rawAt) : now;
  if (!Number.isFinite(at) || at < now - AT_PAST_MS || at > now + AT_AHEAD_MS) {
    return res.status(400).json({ success: false, error: 'at must be an ISO-8601 date within a year from now' });
  }
  const exclude = asText(req.query.exclude).trim().slice(0, 255);

  try {
    return res.json({ success: true, ...await quotaFor(owner, kind, at, { exclude }) });
  } catch (err) {
    console.warn(`[publishQuota] GET for @${owner} failed, answering allowed:`, err.message || err);
    const cfg = limitsConfig();
    return res.json({
      success: true, enabled: cfg.enabled, exempt: false, reason: null, kind, limit: cfg.limits[kind],
      window_hours: WINDOW_HOURS, at: new Date(at).toISOString(), allowed: true, conflicts: [], next_free_at: null,
    });
  }
});

module.exports = router;
