/**
 * Premium creator boost — videos by current Pro subscribers rank higher in every
 * discovery feed (discover, trending, related, shorts, and the follow feed).
 *
 * This lifts a creator's OWN uploads because THEY pay for Pro; it is not a
 * per-viewer perk and does not depend on who is watching. The boosted account is
 * the video's Hive author (see followBoost.defaultAuthorOf) matched against the
 * set of users flagged `premium: true` on the embed-users collection — the same
 * flag services/premiumSubsSync.js keeps in sync from Okinoko subs every 60s.
 *
 * Unlike followBoost there is no per-viewer set and no Hive RPC: the premium set
 * is GLOBAL and small, so it's one cheap Mongo query per TTL window, cached
 * in-process with stale-while-revalidate. A refresh never blocks a feed request,
 * and a cold miss simply returns "no boost" for that one request while it warms.
 *
 * Gated on PREMIUM_BOOST: a no-op (and it never even queries Mongo) when the
 * multiplier is <= 1. Default 1 = off; prod sets PREMIUM_BOOST=1.5.
 */
const { PREMIUM_BOOST, PREMIUM_BOOST_TTL_MS, PREMIUM_USERS_COLLECTION, PREMIUM_BOOST_BLACKLIST } = require('./config');
const { defaultAuthorOf } = require('./followBoost');

const norm = (u) => String(u || '').trim().toLowerCase().replace(/^@/, '');

let cache = null;       // { set: Set<string>, at: number }
let warming = false;

// Debug/testing accounts to EXCLUDE from the boost (the premium flag is polluted with
// them). Every OTHER premium user is boosted automatically; empty blacklist = all premium.
const BLACKLIST = new Set(PREMIUM_BOOST_BLACKLIST);

async function load(db) {
  const rows = await db
    .collection(PREMIUM_USERS_COLLECTION)
    .find({ premium: true }, { projection: { username: 1, _id: 0 } })
    .toArray();
  return new Set(rows.map((r) => norm(r.username)).filter((u) => u && !BLACKLIST.has(u)));
}

function warm(db) {
  if (warming) return;
  warming = true;
  load(db)
    .then((set) => { cache = { set, at: Date.now() }; })
    .catch(() => { /* Mongo hiccup → keep the stale set, never throw into a feed */ })
    .finally(() => { warming = false; });
}

/**
 * The set of premium usernames, or null on a cold miss / when disabled.
 * NEVER awaits when a (possibly stale) set is cached — refreshes in the background.
 * @returns {Set<string>|null}
 */
function getPremiumSet(db) {
  if (!(PREMIUM_BOOST > 1)) return null;              // disabled → don't even query Mongo
  const fresh = cache && Date.now() - cache.at < PREMIUM_BOOST_TTL_MS;
  if (!fresh && db) warm(db);                         // miss OR stale → background refresh
  return cache ? cache.set : null;                    // stale-while-revalidate; null on cold miss
}

/**
 * Multiply the score of videos whose Hive author is a premium (Pro) creator.
 * No-op (returns 0) when disabled, no set, or empty input.
 * @returns {number} how many videos were boosted
 */
function applyPremiumBoost(videos, premiumSet, opts = {}) {
  const scoreField = opts.scoreField || 'trending_score';
  const mult = opts.mult ?? PREMIUM_BOOST;
  const authorOf = opts.authorOf || defaultAuthorOf;

  if (!premiumSet || !premiumSet.size || !Array.isArray(videos) || !videos.length) return 0;
  if (!(mult > 1)) return 0;

  let n = 0;
  for (const v of videos) {
    const author = norm(authorOf(v));
    if (!author || !premiumSet.has(author)) continue;
    v.premium_match = true;
    v[scoreField] = (Number(v[scoreField]) || 0) * mult;
    n += 1;
  }
  return n;
}

/** Test/ops hook — drop the cached set. */
function invalidate() { cache = null; }

module.exports = { getPremiumSet, applyPremiumBoost, invalidate };
