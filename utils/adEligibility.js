/**
 * The single place that decides whether a given playback carries an ad.
 *
 * There are three independent reasons not to serve one, and they belong together so
 * no caller can honour one and forget the others:
 *
 *   • The video's OWNER is not on the serving allowlist. While ADS_ALLOWED_OWNERS is
 *     non-empty this is the first and hardest gate: ads run on those accounts' videos
 *     and nowhere else, whatever a campaign booked. It lives here rather than in the
 *     session route so that every future caller — stitcher, forecast, a report — gets
 *     the same answer without having to remember the rule.
 *
 *   • The VIEWER pays for Pro. Someone paying to support the platform being shown
 *     ads is the clearest possible way to make Pro feel worthless, so premium
 *     always wins over any inventory pressure.
 *   • The CREATOR turned ads off. Their videos carry none, and the forecast drops
 *     them too, so nothing is sold that we have promised not to use.
 *
 * The premium set is read from the same `embed-users.premium` flag that
 * services/premiumSubsSync.js keeps in step with Okinoko subs every 60s, and that
 * utils/premiumBoost.js already uses for the creator ranking boost. Unlike that
 * one, this gates on `premium_expires_at` locally as well: the sync can be up to a
 * minute behind, and a one-day pass that lapsed thirty seconds ago should not
 * start showing ads mid-session.
 *
 * Cached in-process with stale-while-revalidate, same shape as premiumBoost — the
 * premium set is global and tiny, so this is one cheap Mongo query per TTL window
 * and never blocks a playback decision. A cold miss is deliberately FAIL-SAFE: it
 * answers "no ads" rather than risking an ad in front of a paying subscriber.
 */
const { getDb } = require('./db');
const { PREMIUM_USERS_COLLECTION, AD_CREATOR_PREFS_COLLECTION, ADS_ALLOWED_OWNERS } = require('./config');

const TTL_MS = parseInt(process.env.AD_ELIGIBILITY_TTL_MS, 10) || 60 * 1000;

const norm = (u) => String(u || '').trim().toLowerCase().replace(/^@/, '');

let cache = null;      // { map: Map<string, number|null>, at: number }
let warming = false;

async function load(db) {
  const rows = await db.collection(PREMIUM_USERS_COLLECTION)
    .find({ premium: true }, { projection: { username: 1, premium_expires_at: 1, _id: 0 } })
    .toArray();
  const map = new Map();
  for (const r of rows) {
    const u = norm(r.username);
    if (!u) continue;
    const exp = r.premium_expires_at ? new Date(r.premium_expires_at).getTime() : null;
    map.set(u, Number.isFinite(exp) ? exp : null);   // null = no expiry
  }
  return map;
}

function warm(db) {
  if (warming) return;
  warming = true;
  load(db)
    .then((map) => { cache = { map, at: Date.now() }; })
    .catch((err) => console.error('[ad-eligibility] premium refresh failed:', err && err.message))
    .finally(() => { warming = false; });
}

/**
 * Is this viewer a current Pro subscriber?
 *
 * Returns null — not false — when the set has never loaded, so the caller can tell
 * "definitely not premium" apart from "we don't know yet" and fail safe.
 */
async function isPremiumViewer(username) {
  const u = norm(username);
  if (!u) return false;                    // anonymous viewers are not subscribers
  const db = getDb();

  if (!cache) {
    try { cache = { map: await load(db), at: Date.now() }; }
    catch (err) {
      console.error('[ad-eligibility] premium load failed:', err && err.message);
      return null;                          // unknown → caller fails safe
    }
  } else if (Date.now() - cache.at > TTL_MS) {
    warm(db);                               // stale-while-revalidate; never blocks
  }

  if (!cache.map.has(u)) return false;
  const expiresAt = cache.map.get(u);
  // A lapsed one-day pass is not premium, even if the 60s sync has not caught up.
  return expiresAt === null || expiresAt > Date.now();
}

/** Has this creator turned ads off on their own videos? */
async function creatorOptedOut(owner) {
  const o = norm(owner);
  if (!o) return false;
  const doc = await getDb().collection(AD_CREATOR_PREFS_COLLECTION)
    .findOne({ _id: o }, { projection: { adsEnabled: 1 } });
  return !!doc && doc.adsEnabled === false;
}

/**
 * Should this playback carry an ad? `{ ads, reason }`.
 *
 * `reason` is always populated on a refusal so the caller can log or display why
 * without re-deriving it, and so "no ads because you pay for Pro" can be shown to
 * the viewer as the benefit it is rather than as nothing happening.
 */
async function adDecision({ viewer, owner }) {
  // Hardest gate first, and cheapest: no database work for a video that could never
  // carry an ad anyway.
  if (ADS_ALLOWED_OWNERS.length) {
    const o = norm(owner);
    if (!o || !ADS_ALLOWED_OWNERS.includes(o)) {
      return { ads: false, reason: 'owner_not_in_trial' };
    }
  }

  const premium = await isPremiumViewer(viewer);
  // null = the premium set could not be read. Fail safe: no ad. An ad withheld
  // costs us a fraction of a cent; an ad in front of a subscriber costs trust.
  if (premium === null) return { ads: false, reason: 'unknown_premium_state' };
  if (premium) return { ads: false, reason: 'premium_viewer' };

  if (await creatorOptedOut(owner)) return { ads: false, reason: 'creator_opted_out' };

  return { ads: true, reason: null };
}

module.exports = { adDecision, isPremiumViewer, creatorOptedOut, ADS_ALLOWED_OWNERS };
