/**
 * The global COMMENT mutelist: accounts (well-known bots) whose comments 3Speak never
 * shows in its comment sections and never counts. Comments only: a muted account's
 * own posts are not touched (that is `contentcreators.hidden`, utils/hiddenCreators.js).
 *
 * The list is the UNION of two sources:
 *   1. data/comment-mutelist.json, versioned in this repo:
 *        [{ "user": "ai-agent-hunter", "reason": "bot", "added": "2026-11-15" }, ...]
 *      Add a line there and deploy (the checker auto-deploys on merge to main).
 *   2. the Mongo collection `comment_mutes` (COMMENT_MUTES_COLLECTION), for adding a
 *      bot without a deploy. One document per account, keyed by the Hive name:
 *        db.comment_mutes.insertOne({ _id: 'some-bot', reason: 'bot', at: new Date() })
 *      and to take it off again:
 *        db.comment_mutes.deleteOne({ _id: 'some-bot' })
 *      Lowercase Hive name, no '@'. Picked up within COMMENT_MUTES_TTL_MS (5 min) on
 *      every checker process. No index beyond _id is needed. A name in the repo file
 *      stays muted whatever the collection says; remove it from the file to unmute.
 *
 * Same "stale beats broken" cache as utils/hiddenCreators.js: one in-process Set per
 * TTL; a failed Mongo read keeps the previous set (or, on the very first load, the
 * repo list alone). Never throws, so a Mongo hiccup can't break comments or feeds.
 * Names are lowercased and must be valid Hive account names; anything else is dropped.
 */
const { getDb } = require('./db');
const { COMMENT_MUTES_COLLECTION, COMMENT_MUTES_TTL_MS } = require('./config');

const HIVE_RE = /^[a-z][a-z0-9.-]{2,15}$/;
const MAX_ROWS = 5000;

/** A Hive account name, lowercased and without '@', or '' when it isn't one. */
function normalize(u) {
  const s = String(u || '').trim().replace(/^@/, '').toLowerCase();
  return HIVE_RE.test(s) ? s : '';
}

function loadRepoList() {
  let rows = [];
  try {
    rows = require('../data/comment-mutelist.json');
  } catch (e) {
    console.warn('[commentMutes] data/comment-mutelist.json unreadable:', e.message);
  }
  const out = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const user = normalize(r && r.user);
    if (user) out.set(user, { user, reason: String((r && r.reason) || ''), added: String((r && r.added) || '') });
  }
  return out;
}

const REPO = loadRepoList();

let cache = { set: new Set(REPO.keys()), at: 0, loaded: false };

async function refresh(db) {
  const rows = await (db || getDb()).collection(COMMENT_MUTES_COLLECTION)
    .find({}, { projection: { _id: 1 } })
    .limit(MAX_ROWS)
    .toArray();
  const set = new Set(REPO.keys());
  for (const r of rows) {
    const u = normalize(r && r._id);
    if (u) set.add(u);
  }
  cache = { set, at: Date.now(), loaded: true };
  return set;
}

/** The cached Set of muted usernames (lowercased). Refreshes past the TTL, never throws. */
async function getMutedSet(db) {
  if (cache.loaded && Date.now() - cache.at < COMMENT_MUTES_TTL_MS) return cache.set;
  try {
    return await refresh(db);
  } catch (e) {
    console.warn('[commentMutes] refresh failed, using stale set:', e && e.message);
    return cache.set;
  }
}

/** Is this one account on the mutelist? */
async function isMuted(db, username) {
  return (await getMutedSet(db)).has(String(username || '').trim().replace(/^@/, '').toLowerCase());
}

/** Of the given usernames, the ones on the mutelist (lowercased, deduped). */
async function mutedSubset(db, usernames) {
  const set = await getMutedSet(db);
  if (set.size === 0) return [];
  const out = new Set();
  for (const u of usernames || []) {
    const lc = String(u || '').trim().replace(/^@/, '').toLowerCase();
    if (lc && set.has(lc)) out.add(lc);
  }
  return [...out];
}

/** Drop rows whose `key` (default 'author') is a muted account. */
async function filterMuted(db, rows, key = 'author') {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const set = await getMutedSet(db);
  if (set.size === 0) return rows;
  return rows.filter((r) => !(r && r[key] && set.has(String(r[key]).toLowerCase())));
}

/** Test hook: forget the Mongo part of the cache. */
function reset() {
  cache = { set: new Set(REPO.keys()), at: 0, loaded: false };
}

module.exports = {
  getMutedSet, isMuted, mutedSubset, filterMuted, normalize, refresh,
  repoList: () => [...REPO.values()],
  _test: { reset },
};
