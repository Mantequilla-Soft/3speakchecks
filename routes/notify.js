/**
 * Notification levels per followed creator, and the checker's own notification
 * feed for the bell.
 *
 *   POST /notify/levels  { user, signature, timestamp }
 *        -> { levels: { <creator>: 'highlights' | 'off' } }   (no entry = 'all')
 *   POST /notify/level   { user, signature, timestamp, creator, level }
 *        -> { creator, level }                                 level: all | highlights | off
 *   POST /notify/feed    { user, signature, timestamp, limit? }
 *        -> { notifications: [Notification] }
 *
 * All three take the session vouch (utils/progressVouch.js): who someone muted is
 * theirs to know, and the feed is personal.
 *
 * The feed holds what Hive has no notification for, newest first. One shape for
 * every type, so a new source (premiere reminders, say) is one more function in
 * SOURCES below and nothing changes in the client but a label:
 *
 *   {
 *     id:        stable string, unique per notification ('live:<host>/<room>/<t>')
 *     type:      'live' | 'collab_invite' | ...
 *     actor:     the account it is about (the host who went live, the inviter)
 *     title:     a line of text from that account (stream or post title)
 *     url:       in-app path to open
 *     thumbnail: https URL or null
 *     at:        ISO date the notification is dated (unseen = newer than the
 *                client's own "seen until", kept in the browser)
 *     ...type-specific fields: live (boolean, still on air) for 'live';
 *        author, permlink for 'collab_invite'
 *   }
 *
 * Each source applies the levels (utils/notifyLevels.js) itself: a creator set to
 * Off is never in this feed, Highlights keeps going live and personal invites.
 */
const express = require('express');
const { proveProgressUser } = require('../utils/progressVouch');
const { getFollowingList } = require('../utils/hive');
const { LEVELS, getLevels, setLevel, levelOf, levelAllows } = require('../utils/notifyLevels');
const { eventsForHosts, isLiveNow } = require('../services/liveNotify');
const { LIVE_NOTIFY_FEED_HOURS } = require('../utils/config');

const router = express.Router();
const CREATOR_RE = /^~?[a-z0-9][a-z0-9.-]{1,31}$/;
const MAX_FEED = 40;

// Level switches are cheap but per account: 300 an hour is far past any person.
const brake = new Map();
function tooMany(user) {
  const now = Date.now();
  const list = (brake.get(user) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (list.length >= 300) return true;
  list.push(now);
  brake.set(user, list);
  if (brake.size > 5000) brake.delete(brake.keys().next().value);
  return false;
}

async function liveSource({ user, following, levels, now }) {
  const hosts = following.filter((h) => h !== user && levelAllows(levelOf(levels, h), 'live'));
  const since = new Date(now - LIVE_NOTIFY_FEED_HOURS * 3600 * 1000);
  const events = await eventsForHosts(hosts, { since, limit: MAX_FEED });
  return events.map((ev) => ({
    id: `live:${ev._id}`,
    type: 'live',
    actor: ev.host,
    title: ev.title || ev.room,
    url: `/watch/${ev.room}`,
    thumbnail: ev.thumbnail || null,
    at: new Date(ev.started_at).toISOString(),
    live: isLiveNow(ev, now),
  }));
}

// Each source gets { user, following, levels, now } and returns Notification[].
// Exported so another router can register its own (see routes/collabs.js).
const SOURCES = [liveSource];
function addSource(fn) {
  if (!SOURCES.includes(fn)) SOURCES.push(fn);
}

router.post('/notify/levels', express.json({ limit: '2kb' }), async (req, res) => {
  const user = await proveProgressUser(req.body || {});
  if (!user) return res.status(401).json({ success: false, error: 'Invalid signature' });
  res.set('Cache-Control', 'no-store');
  const levels = await getLevels(user);
  res.json({ success: true, levels: Object.fromEntries(levels) });
});

router.post('/notify/level', express.json({ limit: '2kb' }), async (req, res) => {
  const b = req.body || {};
  const user = await proveProgressUser(b);
  if (!user) return res.status(401).json({ success: false, error: 'Invalid signature' });
  const creator = String(b.creator || '').trim().toLowerCase().replace(/^@/, '');
  const level = String(b.level || '');
  if (!CREATOR_RE.test(creator) || creator === user) return res.status(400).json({ success: false, error: 'invalid creator' });
  if (!LEVELS.includes(level)) return res.status(400).json({ success: false, error: 'invalid level', allowed: LEVELS });
  if (tooMany(user)) return res.status(429).json({ success: false, error: 'too many updates' });
  res.json({ success: true, creator, level: await setLevel(user, creator, level) });
});

router.post('/notify/feed', express.json({ limit: '2kb' }), async (req, res) => {
  const b = req.body || {};
  const user = await proveProgressUser(b);
  if (!user) return res.status(401).json({ success: false, error: 'Invalid signature' });
  res.set('Cache-Control', 'no-store');
  const limit = Math.min(Math.max(parseInt(b.limit, 10) || 20, 1), MAX_FEED);
  const [followingRaw, levels] = await Promise.all([
    getFollowingList(user).catch(() => null),
    getLevels(user),
  ]);
  const following = (followingRaw || []).map((u) => String(u).toLowerCase());
  const ctx = { user, following, levels, now: Date.now() };
  const lists = await Promise.all(SOURCES.map((fn) => fn(ctx).catch((err) => {
    console.error('[notify] source failed:', err && err.message);
    return [];
  })));
  const notifications = lists.flat()
    .filter(Boolean)
    .sort((a, b2) => (a.at < b2.at ? 1 : a.at > b2.at ? -1 : 0))
    .slice(0, limit);
  res.json({ success: true, notifications });
});

module.exports = router;
module.exports.addSource = addSource;
module.exports.SOURCES = SOURCES;
