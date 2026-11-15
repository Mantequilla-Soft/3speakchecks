const { verifyDelegateVouch } = require('./hiveAuth');
const { AD_SIGNING_DELEGATES } = require('./config');

/**
 * Who is asking, from the vouch our API hands a signed-in page (POST
 * /api/podcasts/signature, action 'progress'): "@threespeak verified a session
 * for <user>", over `3speak-podcasts|progress-vouch|<user>|session|<ms>`. Good
 * for a day, so a page that saves progress every few seconds never asks the
 * wallet. It proves a session and nothing more: it moves that person's progress
 * bars and reads their own Continue listening / watching. Null when it fails.
 */
const PROGRESS_VOUCH_MAX_AGE_MS = 24 * 3600 * 1000;
const USER_RE = /^~?[a-z0-9][a-z0-9.-]{1,31}$/;

// Must match podcastMessage() in routes/podcasts.js and the signer in the
// frontend's server/index.cjs exactly.
const vouchMessage = (user, timestamp) => ['3speak-podcasts', 'progress-vouch', user, 'session', String(timestamp)].join('|');

async function proveProgressUser(b) {
  const user = String((b && b.user) || '').trim().toLowerCase().replace(/^@/, '');
  if (!USER_RE.test(user)) return null;
  const signature = typeof b.signature === 'string' ? b.signature.slice(0, 200) : '';
  const timestamp = parseInt(b.timestamp, 10);
  if (!signature || !Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > PROGRESS_VOUCH_MAX_AGE_MS) return null;
  try {
    const v = await verifyDelegateVouch({ message: vouchMessage(user, timestamp), signature, delegates: AD_SIGNING_DELEGATES });
    return v.ok ? user : null;
  } catch (_) {
    return null;
  }
}

module.exports = { proveProgressUser, PROGRESS_VOUCH_MAX_AGE_MS };
