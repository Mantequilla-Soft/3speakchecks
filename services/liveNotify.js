/**
 * "Went live" notifications.
 *
 * Every LIVE_NOTIFY_INTERVAL_SEC this polls the public GET /streams of each
 * streaming server (hangouts, LIVE_STREAMS_API_URLS) and records each standalone
 * stream that is live as one row in `live_events`:
 *
 *   _id         host/room/<room createdAt>   (a room made again under the same
 *                                             name is a new stream, a pause is not)
 *   host, room, title, thumbnail, visibility
 *   started_at  when this pass first saw it live
 *   last_live_at  the last pass that saw it live (the bell says "live now" while
 *                 this is recent, "was live" after)
 *
 * Nothing is written per follower. The bell feed (routes/notify.js) reads the
 * rows for the hosts a person follows when they ask, so a host with 10,000
 * followers costs one row, not 10,000.
 *
 * Web push is the one fan-out: for each NEW row, every push subscriber who
 * follows the host gets "@host is live", unless they switched the `live` kind
 * off or set that creator to Off (utils/notifyLevels.js). Same following-list
 * cache as the upload pushes (services/pushNotify.js).
 *
 * The very first pass on an empty collection only records what is live and
 * pushes nothing, so a deploy in the middle of a stream does not announce it
 * late; the same goes for a stream seen after a gap (the row already exists).
 *
 * Hosts in LIVE_EXCLUDED_HOSTS are never recorded, so they reach no bell or push.
 *
 * Fails quiet: a server that does not answer is skipped for this pass.
 */
const { getDb } = require('../utils/db');
const {
  LIVE_EVENTS_COLLECTION, LIVE_EVENTS_TTL_DAYS, LIVE_STREAMS_API_URLS, LIVE_NOTIFY_INTERVAL_SEC,
  LIVE_EXCLUDED_HOSTS,
} = require('../utils/config');
const push = require('../utils/webPush');
const { followingOf } = require('./pushNotify');
const { getLevelsFor, levelOf, levelAllows } = require('../utils/notifyLevels');

const HOST_RE = /^[a-z][a-z0-9.-]{2,15}$/;
const ROOM_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const TIMEOUT_MS = 5000;
const STATE_ID = '__state';
// A big fan base should not turn one pass into minutes of pushing.
const MAX_SUBSCRIBERS_PER_PASS = 2000;

const col = () => getDb().collection(LIVE_EVENTS_COLLECTION);

let indexed = false;
async function ensureIndexes() {
  if (indexed) return;
  indexed = true;
  try {
    await col().createIndex({ host: 1, started_at: -1 });
    await col().createIndex({ started_at: 1 }, { expireAfterSeconds: LIVE_EVENTS_TTL_DAYS * 86400 });
  } catch (err) {
    indexed = false;
    console.error('[liveNotify] index setup failed:', err && err.message);
  }
}

const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : '');

/** Live standalone streams across every server, deduped by host/room. */
async function fetchLiveStreams(bases = LIVE_STREAMS_API_URLS) {
  const out = new Map();
  for (const base of bases) {
    let list;
    try {
      const res = await fetch(`${base}/streams`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) continue;
      list = await res.json();
    } catch {
      continue;
    }
    if (!Array.isArray(list)) continue;
    for (const s of list) {
      if (!s || s.mode !== 'standalone' || s.live !== true || s.visibility === 'unlisted') continue;
      const host = String(s.host || '').toLowerCase();
      const room = String(s.name || '');
      if (!HOST_RE.test(host) || !ROOM_RE.test(room)) continue;
      if (LIVE_EXCLUDED_HOSTS.includes(host)) continue;
      const key = `${host}/${room}`;
      if (out.has(key)) continue;
      out.set(key, {
        host,
        room,
        title: clip(s.title, 200) || room,
        thumbnail: /^https:\/\//.test(String(s.thumbnail || '')) ? clip(s.thumbnail, 500) : null,
        visibility: s.visibility === 'hive-internal' ? 'hive-internal' : 'public',
        createdAt: clip(s.createdAt, 40),
      });
    }
  }
  return [...out.values()];
}

/** One pass: record new live streams, push the new ones. Returns counts for the log. */
async function runOnce({ bases } = {}) {
  await ensureIndexes();
  const now = new Date();
  const streams = await fetchLiveStreams(bases);
  const state = await col().findOne({ _id: STATE_ID });
  const seeded = !!state;

  const fresh = [];
  for (const s of streams) {
    const _id = `${s.host}/${s.room}/${s.createdAt}`;
    const r = await col().updateOne(
      { _id },
      {
        $set: { title: s.title, thumbnail: s.thumbnail, visibility: s.visibility, last_live_at: now },
        $setOnInsert: { host: s.host, room: s.room, started_at: now },
      },
      { upsert: true },
    );
    if (r.upsertedCount) fresh.push(s);
  }
  if (!seeded) await col().updateOne({ _id: STATE_ID }, { $set: { seeded_at: now } }, { upsert: true });

  let sent = 0;
  if (seeded && fresh.length && push.isConfigured()) sent = await pushFresh(fresh);
  if (fresh.length || sent) console.log(`[liveNotify] ${fresh.length} stream(s) went live, ${sent} push(es) sent`);
  return { live: streams.length, fresh: seeded ? fresh.length : 0, seeded: !seeded, sent };
}

async function pushFresh(fresh) {
  const subscribers = (await push.listSubscribers()).slice(0, MAX_SUBSCRIBERS_PER_PASS);
  const levels = await getLevelsFor(subscribers);
  let sent = 0;
  for (const username of subscribers) {
    try {
      const [following, prefs] = await Promise.all([followingOf(username), push.getPrefs(username)]);
      if (prefs.live === false) continue;
      for (const s of fresh) {
        if (s.host === username || !following.has(s.host)) continue;
        if (!levelAllows(levelOf(levels.get(username), s.host), 'live')) continue;
        const res = await push.sendToUser(username, {
          title: `@${s.host} is live`,
          body: s.title,
          url: `/watch/${s.room}`,
          tag: `live:${s.host}/${s.room}`,
        });
        sent += res.sent;
      }
    } catch (err) {
      console.warn(`[liveNotify] push failed for ${username}: ${err.message}`);
    }
  }
  return sent;
}

/** Rows a follower should see: live events of the hosts they follow, newest first. */
async function eventsForHosts(hosts, { since, limit = 20 } = {}) {
  if (!hosts.length) return [];
  return col().find({ host: { $in: hosts }, started_at: { $gte: since } })
    .sort({ started_at: -1 }).limit(limit).toArray();
}

/** "Live now" means a pass saw it within two intervals. */
const isLiveNow = (ev, now = Date.now()) => !!ev.last_live_at
  && now - new Date(ev.last_live_at).getTime() <= 2 * LIVE_NOTIFY_INTERVAL_SEC * 1000 + 15000;

function schedule() {
  const tick = () => runOnce().catch((e) => console.error('[liveNotify] run:', e.message));
  setTimeout(() => {
    tick();
    setInterval(tick, LIVE_NOTIFY_INTERVAL_SEC * 1000);
  }, 45 * 1000);
  console.log(`"Went live" notifications every ${LIVE_NOTIFY_INTERVAL_SEC}s (first pass in 45 s)`);
}

module.exports = { runOnce, fetchLiveStreams, eventsForHosts, isLiveNow, ensureIndexes, schedule, STATE_ID };
