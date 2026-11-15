/**
 * "Your stream clips are ready" (H13): when the clips of a live stream are cut
 * (after the stream: from the Pro DVR at once, or from the VOD recording), the
 * hangouts server calls POST /stream-stats/clips-ready (routes/streamStats.js,
 * the same shared secret as the other stream stats). Each person it names gets
 * one row per stream here:
 *
 *   stream_clip_notices { user, room, host, title, role: 'host' | 'clipper',
 *                         count, at, created_at, expiresAt (TTL) }
 *
 * The host is told about every clip of the stream, each clipper about their own.
 * The bell reads the rows (streamClipSource, a source of routes/notify.js), and
 * the first time a row is written it is also pushed to that person's browsers.
 * Both lead to /clips on 3speak.tv, where the clips are posted as Shorts. Rows
 * expire with the clips (CLIP_KEEP_HOURS on the hangouts server, 48 h).
 */
const { getDb } = require('../utils/db');
const push = require('../utils/webPush');

const COLL = 'stream_clip_notices';
const KEEP_MS = 48 * 3600 * 1000;
const ACCOUNT_RE = /^[a-z0-9][a-z0-9.-]{1,31}$/;
const ROOM_RE = /^[A-Za-z0-9_-]{1,128}$/;

const col = () => getDb().collection(COLL);
let indexed = null;
function ensureIndexes() {
  indexed ??= (async () => {
    const c = col();
    await c.createIndex({ user: 1, room: 1 }, { unique: true });
    await c.createIndex({ user: 1, at: -1 });
    await c.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  })().catch((e) => { indexed = null; throw e; });
  return indexed;
}

/** Pure: who is told what, from the body the hangouts server sends. */
function noticesFrom(body) {
  const b = body && typeof body === 'object' ? body : {};
  const room = typeof b.room === 'string' && ROOM_RE.test(b.room) ? b.room : null;
  const host = typeof b.host === 'string' && ACCOUNT_RE.test(b.host.toLowerCase()) ? b.host.toLowerCase() : null;
  if (!room || !host) return null;
  const title = typeof b.title === 'string' ? b.title.trim().slice(0, 200) : '';
  const total = Math.max(0, Math.min(1000, parseInt(b.total, 10) || 0));
  if (!total) return null;
  const out = [{ user: host, role: 'host', count: total }];
  const seen = new Set([host]);
  for (const c of Array.isArray(b.clippers) ? b.clippers.slice(0, 100) : []) {
    const user = typeof c?.user === 'string' ? c.user.toLowerCase() : '';
    const count = Math.max(0, Math.min(1000, parseInt(c?.count, 10) || 0));
    if (!ACCOUNT_RE.test(user) || seen.has(user) || !count) continue;
    seen.add(user);
    out.push({ user, role: 'clipper', count });
  }
  return { room, host, title, notices: out };
}

function pushPayload(n, { host, title, room }) {
  return {
    title: n.role === 'host'
      ? `${n.count === 1 ? 'A clip' : `${n.count} clips`} of your stream ${n.count === 1 ? 'is' : 'are'} ready`
      : `Your ${n.count === 1 ? 'clip' : 'clips'} of @${host}'s stream ${n.count === 1 ? 'is' : 'are'} ready`,
    body: title || 'Post them as Shorts on 3Speak.',
    url: '/clips',
    tag: `clips:${room}`,
  };
}

/** Store the notices (one row per person and stream) and push the new ones. */
async function recordClipsReady(body, { now = new Date() } = {}) {
  const parsed = noticesFrom(body);
  if (!parsed) return null;
  await ensureIndexes();
  let pushed = 0;
  for (const n of parsed.notices) {
    const res = await col().updateOne(
      { user: n.user, room: parsed.room },
      {
        $set: { host: parsed.host, title: parsed.title, role: n.role, count: n.count, at: now, expiresAt: new Date(now.getTime() + KEEP_MS) },
        $setOnInsert: { created_at: now },
      },
      { upsert: true },
    );
    if (res && res.upsertedCount) {
      try {
        const r = await push.sendToUser(n.user, pushPayload(n, parsed));
        pushed += r.sent || 0;
      } catch (err) {
        console.warn(`[streamClipNotices] push failed for ${n.user}: ${err.message}`);
      }
    }
  }
  return { notices: parsed.notices.length, pushed };
}

/** The bell (routes/notify.js): the signed-in person's ready stream clips. */
async function streamClipSource({ user, now = Date.now() }) {
  const rows = await col().find({ user, expiresAt: { $gt: new Date(now) } }).sort({ at: -1 }).limit(20).toArray();
  return rows.map((r) => ({
    id: `clips:${r.room}`,
    type: 'stream_clips',
    actor: r.host,
    title: r.title || r.room,
    url: '/clips',
    thumbnail: null,
    at: new Date(r.at).toISOString(),
    count: r.count,
    role: r.role,
    room: r.room,
  }));
}

module.exports = { recordClipsReady, streamClipSource, noticesFrom, pushPayload, COLL };
