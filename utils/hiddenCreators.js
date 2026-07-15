/**
 * Cached set of HIDDEN creators — `contentcreators.hidden === true`.
 *
 * A hidden creator's content is removed from the platform's discovery surfaces:
 * feeds, search, leaderboard, comments, and their profile + watch pages. This is a
 * MODERATION-VISIBILITY flag, distinct from `banned` (which gates posting/upload and
 * is read separately by /check + the login gate). Only visibility is affected here.
 *
 * The set is loaded once per TTL into an in-process Set — same "stale beats broken"
 * pattern as utils/curation.js and utils/discoverPool.js: on a load error we keep the
 * previous set rather than un-hide everyone. ~900 usernames is a few KB. Usernames are
 * lowercased so matching is case-insensitive against video `owner` / `hive_author` and
 * comment authors.
 *
 * FAIL-OPEN by construction: if the very first load fails the set is empty, so feeds
 * show everything rather than break. Hiding a creator is not safety-critical enough to
 * risk taking feeds down over a transient Mongo hiccup.
 */
const { getDb } = require('./db');

const TTL = parseInt(process.env.HIDDEN_CREATORS_TTL_MS, 10) || 5 * 60 * 1000;

let cache = { set: new Set(), at: 0, loaded: false };

async function refresh(db) {
  const rows = await (db || getDb()).collection('contentcreators')
    .find({ hidden: true }, { projection: { username: 1, _id: 0 } })
    .toArray();
  cache = {
    set: new Set(rows.map((r) => String(r.username || '').toLowerCase()).filter(Boolean)),
    at: Date.now(),
    loaded: true,
  };
  return cache.set;
}

/** The cached Set of hidden usernames (lowercased). Refreshes past the TTL. */
async function getHiddenSet(db) {
  if (cache.loaded && Date.now() - cache.at < TTL) return cache.set;
  try {
    return await refresh(db);
  } catch (e) {
    console.warn('[hidden] refresh failed, using stale set:', e.message);
    return cache.set; // stale (or empty on first-load failure) — never throw
  }
}

/** Hidden usernames as an array — for unioning into a Mongo `$nin`. */
async function hiddenList(db) {
  return [...(await getHiddenSet(db))];
}

/** Is this single username hidden? */
async function isHidden(db, username) {
  return (await getHiddenSet(db)).has(String(username || '').toLowerCase());
}

/**
 * Drop docs whose owner/author is hidden. Checks several key names because embed docs
 * use `hive_author`, legacy use `owner`, and pool docs carry both `owner` and `author`
 * — a ban is by username, and embed docs can have owner !== hive_author.
 */
async function filterHiddenDocs(db, docs, keys = ['owner', 'author', 'hive_author']) {
  if (!Array.isArray(docs) || docs.length === 0) return docs;
  const set = await getHiddenSet(db);
  if (set.size === 0) return docs;
  return docs.filter((doc) => !keys.some((k) => doc && doc[k] && set.has(String(doc[k]).toLowerCase())));
}

/** Given the usernames a request is about, return the subset that is hidden (lowercased). */
async function hiddenSubset(db, usernames) {
  const set = await getHiddenSet(db);
  const out = [];
  for (const u of usernames || []) {
    const lc = String(u || '').toLowerCase();
    if (lc && set.has(lc)) out.push(lc);
  }
  return out;
}

// ── Synchronous accessor for query builders that can't await ──────────────────
// Feed routes build a Mongo `{ $nin: [...] }` inline and can't await mid-literal.
// A background warmer keeps the in-memory set fresh so `hiddenListSync()` is a plain
// array read. Cold-start / transient-failure → empty array = fail-open (feeds show
// everything), which the async pool-read path still covers for the main feeds.
let warming = false;
function startWarmer() {
  if (warming) return;
  warming = true;
  const tick = () => { getHiddenSet().catch(() => {}); };
  tick();
  const t = setInterval(tick, TTL);
  if (t.unref) t.unref(); // don't keep the process alive for this
}

/** Current hidden usernames (lowercased) as an array, no await. Starts the warmer. */
function hiddenListSync() {
  startWarmer();
  return [...cache.set];
}

/** Sync membership check against the warm cache (no await). */
function isHiddenSync(username) {
  startWarmer();
  return cache.set.has(String(username || '').toLowerCase());
}

module.exports = {
  getHiddenSet, hiddenList, isHidden, filterHiddenDocs, hiddenSubset, refresh,
  hiddenListSync, isHiddenSync,
};
