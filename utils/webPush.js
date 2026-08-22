/**
 * Web push plumbing: VAPID setup, the subscription store, and one sender.
 *
 * Subscriptions are keyed by (username, endpoint) — one row per browser, so a
 * person on a phone and a laptop gets both. The endpoint IS the address; it is
 * issued by the browser's own push service and is unguessable, which is what
 * makes a dead or hijacked row uninteresting to an attacker.
 *
 * ON AUTH: subscribe takes the username at face value, with no signature. That
 * is a deliberate call, not an oversight. The only thing a forged subscription
 * buys you is receiving "someone you follow posted a video" for an account that
 * isn't yours — and Hive following lists are PUBLIC on-chain, as is every video
 * we would announce. There is no private information in the payload to leak, so
 * a signing prompt on a notifications toggle would cost real friction to protect
 * nothing. If the payload ever carries something non-public (a DM, a payout, a
 * moderation notice) this has to become a signed endpoint first — see
 * utils/hiveAuth.js `verifyHiveAuthority`, which is what routes/verify.js uses.
 */
const webpush = require('web-push');
const { getDb } = require('./db');

const COLLECTION = 'push-subscriptions';
const PREFS_COLLECTION = 'push-prefs';

// What a person can be notified about. Kept here rather than in the route so the
// worker and the API can never disagree about which kinds exist.
const KINDS = [
  // from the platform: a creator you follow published something
  'videos', 'shorts', 'audio',
  // from Hive itself: things that happened to YOU
  'replies', 'mentions', 'follows', 'votes', 'reblogs',
];

// On by default, EXCEPT the two that scale with a post's success rather than
// with anything the reader did. One popular video is dozens of votes and
// reblogs, and a phone buzzing thirty times is how someone learns to turn
// notifications off altogether.
const DEFAULT_PREFS = {
  videos: true, shorts: true, audio: true,
  replies: true, mentions: true, follows: true,
  votes: false, reblogs: false,
};

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@3speak.tv';

const configured = !!(PUBLIC_KEY && PRIVATE_KEY);
if (configured) webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
else console.warn('[push] VAPID keys missing — push endpoints will report unconfigured');

function isConfigured() { return configured; }
function publicKey() { return PUBLIC_KEY; }

async function ensureIndexes() {
  if (!configured) return;
  const col = getDb().collection(COLLECTION);
  await col.createIndex({ username: 1, endpoint: 1 }, { unique: true });
  await col.createIndex({ username: 1 });
  await col.createIndex({ endpoint: 1 });
}

async function saveSubscription({ username, subscription, userAgent }) {
  const col = getDb().collection(COLLECTION);
  const now = new Date();
  await col.updateOne(
    { username, endpoint: subscription.endpoint },
    {
      $set: {
        username,
        endpoint: subscription.endpoint,
        keys: subscription.keys,
        userAgent: String(userAgent || '').slice(0, 200),
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
}

async function removeSubscription({ username, endpoint }) {
  const filter = endpoint ? { endpoint } : { username };
  const res = await getDb().collection(COLLECTION).deleteMany(filter);
  return res.deletedCount;
}

async function listSubscribers() {
  return getDb().collection(COLLECTION).distinct('username');
}

/** Per-person, not per-device: the choice is about content, not hardware. */
async function getPrefs(username) {
  const doc = await getDb().collection(PREFS_COLLECTION).findOne({ _id: username });
  return { ...DEFAULT_PREFS, ...(doc && doc.prefs) };
}

async function savePrefs(username, prefs) {
  const clean = {};
  for (const k of KINDS) if (typeof prefs[k] === 'boolean') clean[k] = prefs[k];
  await getDb().collection(PREFS_COLLECTION).updateOne(
    { _id: username },
    { $set: { prefs: { ...DEFAULT_PREFS, ...clean }, updatedAt: new Date() } },
    { upsert: true },
  );
  return getPrefs(username);
}

/**
 * Deliver one payload to every browser a person registered.
 *
 * 404/410 means the browser threw the subscription away (permission revoked,
 * profile wiped, app uninstalled). Those rows are deleted rather than retried:
 * left in place they would be retried forever, and the push services rate-limit
 * senders that keep pushing to dead endpoints.
 */
async function sendToUser(username, payload) {
  if (!configured) return { sent: 0, gone: 0 };
  const col = getDb().collection(COLLECTION);
  const subs = await col.find({ username }).toArray();
  const body = JSON.stringify(payload);

  let sent = 0;
  let gone = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, { TTL: 6 * 60 * 60 });
      sent += 1;
    } catch (err) {
      const code = err && err.statusCode;
      if (code === 404 || code === 410) {
        gone += 1;
        await col.deleteOne({ _id: s._id }).catch(() => {});
      } else {
        console.warn(`[push] send failed for ${username}: ${code || (err && err.message)}`);
      }
    }
  }));
  return { sent, gone };
}

module.exports = {
  COLLECTION,
  KINDS,
  DEFAULT_PREFS,
  getPrefs,
  savePrefs,
  isConfigured,
  publicKey,
  ensureIndexes,
  saveSubscription,
  removeSubscription,
  listSubscribers,
  sendToUser,
};
