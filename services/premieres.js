/**
 * Premieres: a scheduled post (routes/scheduledPosts.js) its creator chose to
 * "List as a premiere" (`premiere: true` on the scheduled-posts row; off unless
 * asked for). There is no copy of it anywhere else, so a reschedule, a new title
 * or thumbnail, a cancel or switching the listing off is seen at once.
 *
 *   upcoming   now < scheduledOn: a public countdown page with "Notify me".
 *   live       from scheduledOn for the video's length plus PREMIERE_GRACE_MIN:
 *              everyone plays it at the same offset and the chat is open.
 *   ended      afterwards: a normal video, the chat kept as timecoded messages.
 *
 * The cron publishes a premiere PREMIERE_PUBLISH_LEAD_MIN early
 * (services/scheduledPosts.js), so its video is linked and playable at the start;
 * the watch page holds the countdown until then.
 *
 * Collections: premiere_chat (one row per message, `offset` = seconds into the
 * video when it was sent) and premiere_reminders (who asked to be told). Both are
 * keyed to the viewer's name, so both are in utils/gdprAdmin.js.
 */
const { getDb } = require('../utils/db');
const {
  PREMIERE_CHAT_COLLECTION, PREMIERE_REMINDERS_COLLECTION, PREMIERE_GRACE_MIN, PREMIERE_DEFAULT_DURATION_S,
} = require('../utils/config');

const SCHEDULED = 'scheduled-posts';
// A cancelled or failed post is no premiere; a posted one still is (live, then ended).
const LISTED = ['scheduled', 'processing', 'posted'];
// A reminder outlives the longest possible lead (90 days) and then goes by itself.
const REMINDER_TTL_DAYS = 120;
// The longest premiere a list looks back for (a video longer than this has ended
// its chat in every list, but its own page still finds it).
const LIST_LOOKBACK_MS = 12 * 3600 * 1000;

const CHAT = () => getDb().collection(PREMIERE_CHAT_COLLECTION);
const REMINDERS = () => getDb().collection(PREMIERE_REMINDERS_COLLECTION);
const POSTS = () => getDb().collection(SCHEDULED);

let indexesEnsured = false;
async function ensureIndexes() {
  if (indexesEnsured) return;
  indexesEnsured = true;
  try {
    await CHAT().createIndex({ owner: 1, permlink: 1, at: 1 }, { name: 'premiere_chat_video_at' });
    await CHAT().createIndex({ owner: 1, permlink: 1, removedAt: 1 }, { name: 'premiere_chat_removed', sparse: true });
    await CHAT().createIndex({ user: 1 }, { name: 'premiere_chat_user' });
    await REMINDERS().createIndex({ user: 1, owner: 1, permlink: 1 }, { unique: true, name: 'premiere_reminder_unique' });
    await REMINDERS().createIndex({ owner: 1, permlink: 1 }, { name: 'premiere_reminder_video' });
    await REMINDERS().createIndex({ expireAt: 1 }, { expireAfterSeconds: 0, name: 'premiere_reminder_ttl' });
    await POSTS().createIndex(
      { premiere: 1, scheduledOn: 1 },
      { name: 'sched_premiere_date', partialFilterExpression: { premiere: true } },
    );
  } catch (err) {
    indexesEnsured = false;
    console.error('[premieres] index setup failed:', err && err.message);
  }
}

const keyOf = (owner, permlink) => `${owner}/${permlink}`;

/** The video's length in seconds per premiere row, from the embed-video it was uploaded as. */
async function durationsFor(docs) {
  const out = new Map();
  if (!docs.length) return out;
  const or = [];
  for (const d of docs) {
    or.push({ owner: d.owner, permlink: d.embedPermlink || d.permlink });
    or.push({ owner: d.owner, hive_permlink: d.permlink });
  }
  const rows = await getDb().collection('embed-video')
    .find({ $or: or }, { projection: { owner: 1, permlink: 1, hive_permlink: 1, duration: 1, thumbnail_url: 1 } })
    .toArray();
  for (const d of docs) {
    const ev = rows.find((r) => r.owner === d.owner
      && (r.permlink === (d.embedPermlink || d.permlink) || r.hive_permlink === d.permlink));
    if (ev) out.set(keyOf(d.owner, d.permlink), { duration: Number(ev.duration) || 0, thumbnail: ev.thumbnail_url || null });
  }
  return out;
}

/** Where a premiere stands at `now`: its window and its state. */
function windowOf(startAt, durationS, now = Date.now()) {
  const start = new Date(startAt).getTime();
  const length = durationS > 0 ? durationS : PREMIERE_DEFAULT_DURATION_S;
  const chatUntil = start + length * 1000 + PREMIERE_GRACE_MIN * 60 * 1000;
  const state = now < start ? 'upcoming' : (now < chatUntil ? 'live' : 'ended');
  return { start, chatUntil, state };
}

/** What anyone may see of a premiere. Never the post body or the embed asset id. */
function publicShape(doc, media, now = Date.now()) {
  const duration = media?.duration || 0;
  const { start, chatUntil, state } = windowOf(doc.scheduledOn, duration, now);
  return {
    owner: doc.owner,
    permlink: doc.permlink,
    title: doc.title || '',
    thumbnail: doc.thumbnail || media?.thumbnail || null,
    startAt: new Date(start).toISOString(),
    duration,
    chatUntil: new Date(chatUntil).toISOString(),
    state,
  };
}

/** One premiere by its Hive address, or null (not listed as one, cancelled, unknown). */
async function findPremiere(owner, permlink, now = Date.now()) {
  const doc = await POSTS().findOne(
    { owner, permlink, premiere: true, status: { $in: LISTED } },
    { projection: { owner: 1, permlink: 1, title: 1, thumbnail: 1, scheduledOn: 1, embedPermlink: 1 } },
  );
  if (!doc) return null;
  const media = await durationsFor([doc]);
  return publicShape(doc, media.get(keyOf(owner, permlink)), now);
}

// The chat is polled every few seconds by everyone watching, so its premiere
// lookups share one read per video for a few seconds (the state itself is
// recomputed from the clock on every call).
const CACHE_MS = 5000;
const cache = new Map();
async function findPremiereCached(owner, permlink, now = Date.now()) {
  const key = keyOf(owner, permlink);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.doc ? publicShape(hit.doc, hit.media, now) : null;
  const doc = await POSTS().findOne(
    { owner, permlink, premiere: true, status: { $in: LISTED } },
    { projection: { owner: 1, permlink: 1, title: 1, thumbnail: 1, scheduledOn: 1, embedPermlink: 1 } },
  );
  const media = doc ? (await durationsFor([doc])).get(key) : null;
  cache.set(key, { doc, media, at: Date.now() });
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  return doc ? publicShape(doc, media, now) : null;
}
const clearCache = () => cache.clear();

/** Premieres not over yet (upcoming or live), soonest first; one creator's with `owner`. */
async function listOpen({ owner = null, limit = 12, now = Date.now() } = {}) {
  const q = {
    premiere: true,
    status: { $in: LISTED },
    scheduledOn: { $gte: new Date(now - LIST_LOOKBACK_MS) },
  };
  if (owner) q.owner = owner;
  const docs = await POSTS()
    .find(q, { projection: { owner: 1, permlink: 1, title: 1, thumbnail: 1, scheduledOn: 1, embedPermlink: 1 } })
    .sort({ scheduledOn: 1 })
    .limit(Math.max(limit * 3, 30))
    .toArray();
  const media = await durationsFor(docs);
  return docs
    .map((d) => publicShape(d, media.get(keyOf(d.owner, d.permlink)), now))
    .filter((p) => p.state !== 'ended')
    .slice(0, limit);
}

/** Has `user` asked to be told, and how many have. */
async function reminderInfo(owner, permlink, user = null) {
  const [count, mine] = await Promise.all([
    REMINDERS().countDocuments({ owner, permlink }),
    user ? REMINDERS().findOne({ user, owner, permlink }, { projection: { _id: 1 } }) : null,
  ]);
  return { count, reminded: !!mine };
}

async function setReminder(user, owner, permlink, on) {
  await ensureIndexes();
  if (!on) {
    await REMINDERS().deleteOne({ user, owner, permlink });
    return;
  }
  const now = new Date();
  await REMINDERS().updateOne(
    { user, owner, permlink },
    {
      $setOnInsert: { user, owner, permlink, createdAt: now },
      $set: { expireAt: new Date(now.getTime() + REMINDER_TTL_DAYS * 86400 * 1000) },
    },
    { upsert: true },
  );
}

/** A viewer's reminded premieres that are not over, soonest first. */
async function remindersOf(user, now = Date.now()) {
  const rows = await REMINDERS().find({ user }, { projection: { owner: 1, permlink: 1 } }).limit(200).toArray();
  if (!rows.length) return [];
  const docs = await POSTS()
    .find(
      { premiere: true, status: { $in: LISTED }, $or: rows.map((r) => ({ owner: r.owner, permlink: r.permlink })) },
      { projection: { owner: 1, permlink: 1, title: 1, thumbnail: 1, scheduledOn: 1, embedPermlink: 1 } },
    )
    .toArray();
  const media = await durationsFor(docs);
  return docs
    .map((d) => publicShape(d, media.get(keyOf(d.owner, d.permlink)), now))
    .filter((p) => p.state !== 'ended')
    .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
}

/**
 * For a notification sender: reminders whose premiere has started within
 * `lookbackMs` and that were not handed out yet, as { id, user, owner, permlink,
 * title, startAt }. Call markReminded(ids) once they are delivered. Nothing in
 * the checker sends them yet; the frontend shows its own banner while open.
 */
async function dueReminders({ now = Date.now(), lookbackMs = 30 * 60 * 1000, limit = 500 } = {}) {
  const started = await POSTS()
    .find(
      { premiere: true, status: { $in: LISTED }, scheduledOn: { $lte: new Date(now), $gte: new Date(now - lookbackMs) } },
      { projection: { owner: 1, permlink: 1, title: 1, scheduledOn: 1 } },
    )
    .toArray();
  if (!started.length) return [];
  const byKey = new Map(started.map((d) => [keyOf(d.owner, d.permlink), d]));
  const rows = await REMINDERS()
    .find({ notifiedAt: { $exists: false }, $or: started.map((d) => ({ owner: d.owner, permlink: d.permlink })) })
    .limit(limit)
    .toArray();
  return rows.map((r) => {
    const d = byKey.get(keyOf(r.owner, r.permlink));
    return {
      id: String(r._id), user: r.user, owner: r.owner, permlink: r.permlink, title: d.title || '', startAt: new Date(d.scheduledOn).toISOString(),
    };
  });
}

async function markReminded(ids) {
  const { ObjectId } = require('mongodb');
  const list = (ids || []).filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
  if (!list.length) return 0;
  const r = await REMINDERS().updateMany({ _id: { $in: list } }, { $set: { notifiedAt: new Date() } });
  return r.modifiedCount;
}

/* ─── chat ───────────────────────────────────────────────────────────── */

const chatShape = (m) => ({
  id: String(m._id), user: m.user, text: m.text, offset: m.offset, at: new Date(m.at).toISOString(),
});

/** Messages after `afterMs` (ms of `at`), oldest first, and ids removed since then. */
async function chatSince(owner, permlink, afterMs = 0, limit = 300) {
  const after = new Date(Math.max(0, afterMs));
  const [rows, removed] = await Promise.all([
    CHAT().find({ owner, permlink, at: { $gt: after }, removedAt: { $exists: false } })
      .sort({ at: 1 }).limit(limit).toArray(),
    afterMs > 0
      ? CHAT().find({ owner, permlink, removedAt: { $gt: after } }, { projection: { _id: 1 } }).limit(500).toArray()
      : [],
  ]);
  return { messages: rows.map(chatShape), removed: removed.map((r) => String(r._id)) };
}

async function addChat({ owner, permlink, user, text, offset, at = new Date() }) {
  await ensureIndexes();
  const doc = { owner, permlink, user, text, offset, at };
  const r = await CHAT().insertOne(doc);
  return chatShape({ ...doc, _id: r.insertedId });
}

/** Take a message down: its author, or the premiere's creator. True when it was. */
async function removeChat({ owner, permlink, id, by }) {
  const { ObjectId } = require('mongodb');
  if (!ObjectId.isValid(id)) return false;
  const q = { _id: new ObjectId(id), owner, permlink, removedAt: { $exists: false } };
  if (by !== owner) q.user = by;
  const r = await CHAT().updateOne(q, { $set: { removedAt: new Date(), removedBy: by } });
  return r.modifiedCount > 0;
}

module.exports = {
  ensureIndexes,
  windowOf,
  publicShape,
  findPremiere,
  findPremiereCached,
  clearCache,
  listOpen,
  reminderInfo,
  setReminder,
  remindersOf,
  dueReminders,
  markReminded,
  chatSince,
  addChat,
  removeChat,
  SCHEDULED,
};
