/**
 * Pushes the notifications Hive itself raises: replies, mentions, follows,
 * votes and reblogs — the same stream the bell in the nav shows.
 *
 * The bell polls Hive from the browser, which only works while someone has the
 * tab open. This is the same data fetched server-side so it can reach a closed
 * browser, which is the entire point of push.
 *
 * COST NOTE: one Hive call per subscriber per pass, so it scales with
 * subscribers, not with activity — unlike pushNotify, which is two indexed
 * finds no matter how many people are listening. Fine at the numbers this
 * starts at; past a few hundred subscribers this wants batching, a longer
 * interval, or moving to a stream. MAX_SUBSCRIBERS_PER_PASS is the stopgap so
 * it degrades by lagging rather than by hammering the API.
 */
const { getDb } = require('../utils/db');
const { hiveRpcBatch } = require('../utils/hive');
const push = require('../utils/webPush');

const STATE_COLLECTION = 'push-hive-state';
const MAX_PER_SUBSCRIBER = 3;
const MAX_SUBSCRIBERS_PER_PASS = 200;
const FETCH_LIMIT = 25;

// Hive's notification types, mapped onto the kinds a person can switch off.
// Anything not listed (transfer, set_role, subscribe, error…) is not pushed.
const TYPE_TO_KIND = {
  reply: 'replies',
  reply_comment: 'replies',
  mention: 'mentions',
  follow: 'follows',
  vote: 'votes',
  reblog: 'reblogs',
};

const HEADLINE = {
  replies: (who) => `@${who} replied to you`,
  mentions: (who) => `@${who} mentioned you`,
  follows: (who) => `@${who} followed you`,
  votes: (who) => `@${who} upvoted your post`,
  reblogs: (who) => `@${who} reblogged your post`,
};

// Mirrors getNotificationRoute in the frontend so a notification opens the same
// place whether it was tapped in the bell or on a lock screen.
function routeFor(url) {
  if (!url || typeof url !== 'string') return '/';
  if (url.startsWith('trx:')) return '/';
  const normalized = url.startsWith('@') ? url.slice(1) : url;
  if (!normalized.includes('/')) return `/p/${normalized}`;
  const [author, permlink] = normalized.split('/');
  if (author && permlink) return `/post/${author}/${permlink}`;
  return author ? `/p/${author}` : '/';
}

const actorOf = (n) => String(n.msg || '').replace(/^@/, '').split(' ')[0] || 'someone';

async function notificationsFor(username) {
  const res = await hiveRpcBatch([{
    jsonrpc: '2.0',
    id: 1,
    method: 'bridge.account_notifications',
    params: { account: username, limit: FETCH_LIMIT },
  }]);
  const list = res && res[0] && res[0].result;
  return Array.isArray(list) ? list : [];
}

async function runOnce() {
  if (!push.isConfigured()) return { skipped: 'not configured' };
  const db = getDb();
  const state = db.collection(STATE_COLLECTION);
  const subscribers = (await push.listSubscribers()).slice(0, MAX_SUBSCRIBERS_PER_PASS);

  let sent = 0;
  for (const username of subscribers) {
    try {
      const [prefs, seen, list] = await Promise.all([
        push.getPrefs(username),
        state.findOne({ _id: username }),
        notificationsFor(username),
      ]);
      if (!list.length) continue;

      const maxId = Math.max(...list.map((n) => Number(n.id) || 0));

      // First pass for this person: record where they are and send nothing.
      // Announcing a backlog of everything that ever happened to them would be
      // the worst possible introduction to the feature.
      if (!seen || typeof seen.lastId !== 'number') {
        await state.updateOne({ _id: username }, { $set: { lastId: maxId, at: new Date() } }, { upsert: true });
        continue;
      }

      const fresh = list
        .filter((n) => Number(n.id) > seen.lastId)
        .map((n) => ({ ...n, kind: TYPE_TO_KIND[n.type] }))
        .filter((n) => n.kind && prefs[n.kind] !== false)
        .sort((a, b) => Number(a.id) - Number(b.id))
        .slice(-MAX_PER_SUBSCRIBER);

      for (const n of fresh) {
        const who = actorOf(n);
        const res = await push.sendToUser(username, {
          title: (HEADLINE[n.kind] || (() => 'New activity'))(who),
          body: String(n.msg || '').slice(0, 140),
          url: routeFor(n.url),
          tag: `hive:${n.id}`,
        });
        sent += res.sent;
      }

      await state.updateOne({ _id: username }, { $set: { lastId: maxId, at: new Date() } }, { upsert: true });
    } catch (err) {
      // One person's bad pass must not stop everyone else's.
      console.warn(`[push] hive pass failed for ${username}: ${err.message}`);
    }
  }

  if (sent) console.log(`[push] ${sent} Hive notification(s) sent`);
  return { subscribers: subscribers.length, sent };
}

module.exports = { runOnce };
