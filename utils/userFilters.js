/**
 * Per-user feed suppression: "not interested" (one video) and "don't show this
 * creator" (every video by an author).
 *
 * Unlike hide-watched — which is a *preference* the user can toggle off — these
 * are explicit dismissals and therefore ALWAYS applied whenever we know who is
 * asking (?currentuser=). See utils/feedRank.js `filterForUser`.
 *
 * Both collections are tiny per user, so one indexed read each per request.
 */
const HIDDEN_VIDEOS = 'user-hidden-videos';
const HIDDEN_CREATORS = 'user-hidden-creators';

/** Usernames/authors are stored lowercased and @-stripped so lookups can't miss. */
function normUser(s) {
  return String(s || '').trim().toLowerCase().replace(/^@/, '');
}

/** Ensure the indexes the lookups below rely on. Safe to call repeatedly. */
async function ensureUserFilterIndexes(db) {
  await Promise.all([
    db.collection(HIDDEN_VIDEOS).createIndex({ username: 1 }),
    db.collection(HIDDEN_CREATORS).createIndex({ username: 1 }),
  ]);
}

/**
 * Fetch a user's dismissals.
 * @returns {Promise<{videos:Set<string>, creators:Set<string>}>} videos keyed "owner/permlink"
 */
async function getUserFilters(db, username) {
  const user = normUser(username);
  const empty = { videos: new Set(), creators: new Set() };
  if (!user) return empty;
  try {
    const [vids, creators] = await Promise.all([
      db.collection(HIDDEN_VIDEOS).find({ username: user }, { projection: { owner: 1, permlink: 1 } }).toArray(),
      db.collection(HIDDEN_CREATORS).find({ username: user }, { projection: { creator: 1 } }).toArray(),
    ]);
    return {
      videos: new Set(vids.map((v) => `${normUser(v.owner)}/${v.permlink}`)),
      creators: new Set(creators.map((c) => normUser(c.creator))),
    };
  } catch {
    return empty; // never let a suppression lookup break a feed
  }
}

/**
 * Drop dismissed videos + everything by dismissed creators.
 * `keyFn` maps a feed's doc shape to { owner, permlink } (hive permlink).
 */
function applyUserFilters(videos, filters, keyFn) {
  if (!filters || (!filters.videos.size && !filters.creators.size)) return videos;
  return videos.filter((v) => {
    const { owner, permlink } = keyFn(v);
    const o = normUser(owner);
    if (filters.creators.has(o)) return false;
    if (filters.videos.has(`${o}/${permlink}`)) return false;
    return true;
  });
}

/**
 * Merge a user's dismissals straight into a Mongo query (mutates + returns it).
 *
 * For feeds that paginate IN THE DATABASE (skip/limit), filtering the returned
 * page in JS would leave short pages and an inflated `total`. Excluding at the
 * query level keeps both correct.
 *
 * Note this only handles the dismissals — hide-watched stays a post-fetch filter,
 * so these feeds keep their existing watched behaviour.
 */
function applyUserFilterQuery(query, filters) {
  if (!filters) return query;

  if (filters.creators.size) {
    // Don't clobber an existing owner:$nin (e.g. HIDDEN_AUTHORS) — union them.
    const existing = Array.isArray(query.owner?.$nin) ? query.owner.$nin : [];
    query.owner = { $nin: [...new Set([...existing, ...filters.creators])] };
  }

  if (filters.videos.size) {
    const nor = [...filters.videos].map((k) => {
      const i = k.indexOf('/');
      return { owner: k.slice(0, i), permlink: k.slice(i + 1) };
    });
    query.$nor = (query.$nor || []).concat(nor);
  }
  return query;
}

module.exports = {
  HIDDEN_VIDEOS, HIDDEN_CREATORS,
  normUser, ensureUserFilterIndexes, getUserFilters, applyUserFilters, applyUserFilterQuery,
};
