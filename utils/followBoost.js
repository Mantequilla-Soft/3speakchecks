/**
 * Follow boost — videos by creators you follow rank higher in EVERY feed, not just
 * the dedicated follow feed (`/feed/:username`).
 *
 * A follow is the strongest standing preference a viewer ever gives us, so it earns
 * a real multiplier — but it is deliberately BELOW the interest multiplier (2.0
 * global / 2.5 discover). Following someone means "show me more of them", not "show
 * me only them": discover must not quietly collapse into a follow feed.
 *
 * ── Why this never blocks the request ─────────────────────────────────────────
 * The following list comes from Hive (condenser_api.get_following, paged 1000 at a
 * time) and is cached in-process by utils/hive for 10 minutes. Discover answers in
 * ~0.12s; a cold Hive RPC can take longer than the whole request, and Hive nodes go
 * down. So a cache MISS does not stall the feed — it returns "no boost" for this one
 * request and warms the set in the background. The client loads several rows per
 * page, so the very next request already has it.
 *
 * A STALE set is served while it refreshes (stale-while-revalidate). Someone you
 * followed ten minutes ago being boosted a few seconds late is not a bug worth a
 * blocking RPC.
 */
const { getFollowingList } = require('./hive');
const { FOLLOW_BOOST, FOLLOW_BOOST_TTL_MS, FOLLOW_BOOST_MAX_USERS } = require('./config');

const sets = new Map();      // username -> { set:Set<string>, at:number }   (LRU, capped)
const warming = new Set();   // in-flight refreshes, so we fire one RPC per user

const norm = (u) => String(u || '').trim().toLowerCase().replace(/^@/, '');

// `?currentuser=` is an UNAUTHENTICATED, caller-supplied string on the hottest routes
// in the API, and a miss here fires a paged Hive RPC and allocates a Set of up to
// several thousand usernames. Two guards, and both matter:
//
//   1. Shape. Anything that isn't a possible Hive account name is rejected before we
//      touch the network, so a caller can't point us at the Hive nodes with garbage.
//   2. Size. `sets` is an LRU capped at FOLLOW_BOOST_MAX_USERS. Without a cap, a
//      caller looping over random usernames grows the map without bound — an
//      unauthenticated memory leak, and an amplifier aimed at our own RPC endpoints.
//
// Hive account names: 3–16 chars, a–z/0–9/-/., must start with a letter.
const HIVE_ACCOUNT_RE = /^[a-z][a-z0-9.-]{2,15}$/;

function evict() {
  while (sets.size > FOLLOW_BOOST_MAX_USERS) {
    sets.delete(sets.keys().next().value);     // Map iterates in insertion order → LRU
  }
}

/** Store a freshly-fetched set (resets the TTL clock). */
function remember(username, set) {
  sets.delete(username);                       // re-insert → most-recently-used last
  sets.set(username, { set, at: Date.now() });
  evict();
}

/**
 * Mark an entry as recently used WITHOUT resetting `at` — touching must not make a
 * stale set look fresh, or it would never be refreshed again.
 */
function touch(username) {
  const hit = sets.get(username);
  if (!hit) return;
  sets.delete(username);
  sets.set(username, hit);
}

function warm(username) {
  if (warming.has(username)) return;
  warming.add(username);
  getFollowingList(username)
    .then((list) => remember(username, new Set((list || []).map((u) => norm(u)))))
    .catch(() => { /* Hive down → no boost, never an error */ })
    .finally(() => { warming.delete(username); });
}

/**
 * The set of accounts `username` follows, or null if we don't have it yet.
 * NEVER awaits Hive — see the header. Returns a stale set while refreshing.
 * @returns {Set<string>|null}
 */
function getFollowSet(username) {
  const u = norm(username);
  if (!u || !HIVE_ACCOUNT_RE.test(u)) return null;

  const hit = sets.get(u);
  const fresh = hit && Date.now() - hit.at < FOLLOW_BOOST_TTL_MS;
  if (!fresh) warm(u);              // miss OR stale → refresh in the background
  if (hit) touch(u);                // keep an active user hot in the LRU
  return hit ? hit.set : null;      // stale-while-revalidate; null on a cold miss
}

/** Convenience: the follow set for `?currentuser=`, or null. */
function getFollowSetForReq(req) {
  return getFollowSet(req && req.query && req.query.currentuser);
}

// Who the viewer actually follows is the HIVE author. For an embed that is
// `author`/`hive_author` — `owner` is the asset uploader and is not always the same
// account, so preferring `author` matters.
const defaultAuthorOf = (v) => norm(v.author || v.hive_author || v.owner);

/**
 * Multiply the score of videos whose creator the caller follows.
 * No-op (returns 0) when there's no user, no follow set, or the boost is disabled.
 * @returns {number} how many videos were boosted
 */
function applyFollowBoost(videos, followSet, opts = {}) {
  const scoreField = opts.scoreField || 'trending_score';
  const mult = opts.mult ?? FOLLOW_BOOST;
  const authorOf = opts.authorOf || defaultAuthorOf;

  if (!followSet || !followSet.size || !Array.isArray(videos) || !videos.length) return 0;
  if (!(mult > 1)) return 0;

  let n = 0;
  for (const v of videos) {
    const author = authorOf(v);
    if (!author || !followSet.has(author)) continue;
    v.follow_match = true;
    v[scoreField] = (Number(v[scoreField]) || 0) * mult;
    n += 1;
  }
  return n;
}

/** Test/ops hook — drop the cached sets. */
function invalidate() { sets.clear(); }

module.exports = { getFollowSet, getFollowSetForReq, applyFollowBoost, defaultAuthorOf, invalidate };
