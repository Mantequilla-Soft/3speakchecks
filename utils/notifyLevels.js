/**
 * Notification level per followed creator: All, Highlights or Off.
 *
 * One row per (follower, creator) the follower changed; no row means 'all', so a
 * new follow notifies about everything without anyone writing anything. Saved
 * through routes/notify.js with the session vouch, read by every notifier:
 *
 *   all         everything the creator does: videos, shorts, stories, audio, going live
 *   highlights  the big moments only: videos, audio and going live (no shorts, no stories)
 *   off         nothing from this creator: no push, no "went live" in the bell, and
 *               no place in the "Live now from people you follow" row on Home
 *
 * The kinds are the push kinds of utils/webPush.js plus 'stories' (the 24h stories
 * the bell injects). The account-wide push switches still apply on top: a level
 * can only narrow what reaches someone, never widen it.
 */
const { getDb } = require('./db');
const { NOTIFY_LEVELS_COLLECTION } = require('./config');

const LEVELS = ['all', 'highlights', 'off'];
const DEFAULT_LEVEL = 'all';
const HIGHLIGHT_KINDS = new Set(['videos', 'audio', 'live', 'podcasts']);

const col = () => getDb().collection(NOTIFY_LEVELS_COLLECTION);

let indexed = false;
async function ensureIndexes() {
  if (indexed) return;
  indexed = true;
  try {
    await col().createIndex({ user: 1, creator: 1 }, { unique: true });
  } catch (err) {
    indexed = false;
    console.error('[notifyLevels] index setup failed:', err && err.message);
  }
}

/** Does a creator at `level` reach the follower with a `kind` notification? */
function levelAllows(level, kind) {
  if (level === 'off') return false;
  if (level === 'highlights') return HIGHLIGHT_KINDS.has(kind);
  return true;
}

/** Map creator -> level, only for the creators this follower changed. */
async function getLevels(user) {
  const rows = await col().find({ user }, { projection: { creator: 1, level: 1 } }).limit(5000).toArray();
  return new Map(rows.filter((r) => LEVELS.includes(r.level)).map((r) => [r.creator, r.level]));
}

/** Several followers at once (the push passes): Map user -> Map creator -> level. */
async function getLevelsFor(users) {
  const out = new Map(users.map((u) => [u, new Map()]));
  if (!users.length) return out;
  const rows = await col().find({ user: { $in: users } }, { projection: { user: 1, creator: 1, level: 1 } }).toArray();
  for (const r of rows) if (out.has(r.user) && LEVELS.includes(r.level)) out.get(r.user).set(r.creator, r.level);
  return out;
}

/** 'all' removes the row: the default needs no storage. Returns the level now in force. */
async function setLevel(user, creator, level) {
  await ensureIndexes();
  if (level === DEFAULT_LEVEL) {
    await col().deleteOne({ user, creator });
    return DEFAULT_LEVEL;
  }
  await col().updateOne(
    { user, creator },
    { $set: { user, creator, level, updatedAt: new Date() } },
    { upsert: true },
  );
  return level;
}

const levelOf = (levels, creator) => (levels && levels.get(creator)) || DEFAULT_LEVEL;

module.exports = {
  LEVELS, DEFAULT_LEVEL, HIGHLIGHT_KINDS, ensureIndexes, levelAllows, getLevels, getLevelsFor, setLevel, levelOf,
};
