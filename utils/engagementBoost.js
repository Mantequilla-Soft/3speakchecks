/**
 * Engagement affinity — videos by creators YOU have engaged with, and about the
 * topics you engage with, rank higher on discover and interests.
 *
 * "Engaged" means you deliberately did something about someone's video in the last
 * ENGAGE_WINDOW_DAYS (90):
 *
 *   commented — you wrote a reply under it                 → Hive (bridge.get_account_posts)
 *   reshared  — you put it on your own blog                → `reshares`        (Go playlists svc)
 *   saved     — you added it to a playlist / Watch Later   → `playlists.items`
 *
 * This is the same family of signals as utils/curation.js, but read from the OTHER
 * side. Curation asks "how many people cared about this video" and boosts it for
 * everyone. This asks "whose videos does THIS viewer care about" and boosts them for
 * one person. Self-engagement is excluded, as it is there, but for a different
 * reason: creators are by far the heaviest commenters on their own threads, so
 * counting those replies would turn every creator's discover page into their own
 * back catalogue. Container accounts (snap/wave aggregators) are excluded too — see
 * creditedAuthor() in services/engagementSync.js.
 *
 * ── Why the set is precomputed, and not fetched here ──────────────────────────
 * Two of the three signals are ours (Mongo, tiny). Comments are not: they exist only
 * on Hive, and walking 90 days of one account's replies costs 2-8 paged RPCs —
 * measured at 0.23s for a light commenter and 1.1s for an active one. Discover
 * answers in ~0.12s, so that walk can never sit in the request path, and doing it
 * per-viewer would turn our own traffic into an amplifier aimed at the Hive nodes.
 *
 * So services/engagementSync.js precomputes the whole affinity into `user-engagement`
 * (one row per viewer) and this module only ever does a single indexed `_id` read,
 * cached in-process. A cold viewer is queued for the sync and gets NO boost for that
 * one request — never a stall, exactly the contract utils/followBoost.js uses.
 *
 * Unlike followBoost's in-memory set, the row survives a restart: after a deploy the
 * first request for a known viewer costs ~1ms of Mongo and is fully boosted, rather
 * than going cold and re-walking Hive for everyone who browses.
 *
 * ── Why one bounded multiplier for both halves ────────────────────────────────
 * An active commenter engages with a LOT of accounts — measured live, one moderately
 * active viewer had 76 distinct parent authors across 155 comments in 90 days. A flat
 * per-author multiplier would therefore light up a large slice of the catalogue and
 * stop discriminating. So the author term is WEIGHTED by how much you engaged and
 * log-damped, and the topic term is a SHARE of your total engagement rather than a
 * raw count — a topic that is 40% of what you engage with earns 0.4 of the topic
 * weight, while a topic you touched once barely registers.
 *
 *   engagementBoost = min(CAP, 1 + Wa·ln(1+authorWeight) + Wt·topicShare)
 *
 * Capped BELOW the explicit interest multiplier (3.0 exact / 1.8 sibling): a topic
 * the viewer picked by hand must always outrank one we inferred from behaviour.
 */
const {
  ENGAGE_BOOST_ENABLED, ENGAGE_MAX_BOOST, ENGAGE_AUTHOR_WEIGHT, ENGAGE_TOPIC_WEIGHT,
  ENGAGE_TOPIC_MIN_SHARE, ENGAGE_TOPIC_FULL_EVENTS, ENGAGE_CACHE_TTL_MS, ENGAGE_MAX_USERS, ENGAGE_SYNC_TTL_MS,
  ENGAGE_COMBINE_WITH_FOLLOW, FOLLOW_BOOST, ENGAGE_COLLECTION,
} = require('./config');

const norm = (u) => String(u || '').trim().toLowerCase().replace(/^@/, '');

// Same two guards as utils/followBoost.js, and for the same reason: `?currentuser=`
// is an UNAUTHENTICATED caller-supplied string on the hottest routes in the API.
// Shape, so garbage never reaches Mongo or the sync queue; and size, because an
// uncapped per-username map is an unauthenticated memory leak.
const HIVE_ACCOUNT_RE = /^[a-z][a-z0-9.-]{2,15}$/;

const cache = new Map();       // username -> { affinity:Object|null, at:number }  (LRU, capped)
const queue = new Set();       // usernames awaiting a background sync
let warmer = null;             // set by services/engagementSync.js

/** services/engagementSync.js registers itself here, so utils never imports services. */
function setWarmer(fn) { warmer = typeof fn === 'function' ? fn : null; }

/** The sync drains this; returns AND clears up to `max` queued usernames. */
function takeQueued(max = 25) {
  const out = [];
  for (const u of queue) {
    if (out.length >= max) break;
    out.push(u);
  }
  for (const u of out) queue.delete(u);
  return out;
}

/**
 * Drop a username from the queue. The sync calls this the moment it STARTS a
 * viewer, because requestSync() both queues them and kicks an immediate warm — so
 * without this the next tick would dequeue and walk Hive for them a second time.
 */
function dequeue(username) { queue.delete(norm(username)); }

/**
 * Drop a viewer's cached affinity so the next request re-reads Mongo.
 *
 * The sync calls this after writing a row. Otherwise a viewer whose row was just
 * built would keep being served the CACHED miss (no boost) for up to
 * ENGAGE_CACHE_TTL_MS — ten minutes of browsing with the feature silently off,
 * which is exactly the window a first-time viewer is in.
 */
function forget(username) { cache.delete(norm(username)); }

function evict() {
  while (cache.size > ENGAGE_MAX_USERS) {
    cache.delete(cache.keys().next().value);    // Map iterates insertion order → LRU
  }
}

function remember(username, affinity) {
  cache.delete(username);                        // re-insert → most-recently-used last
  cache.set(username, { affinity, at: Date.now() });
  evict();
}

/**
 * Mark an entry recently used WITHOUT resetting `at` — touching must not make a
 * stale entry look fresh, or it would never be refreshed again.
 */
function touch(username) {
  const hit = cache.get(username);
  if (!hit) return;
  cache.delete(username);
  cache.set(username, hit);
}

/** Queue a viewer for the background sync, and let it start one immediately if idle. */
function requestSync(username) {
  queue.add(username);
  if (warmer) warmer(username);
}

/**
 * A viewer's affinity: `{ authors: {name: weight}, topics: {tag: share} }`, or null.
 *
 * Awaits ONE indexed `_id` read at most (~1ms, and only on a cold in-process miss) —
 * never Hive. A missing or stale row returns what we have (null / the stale row) and
 * queues a refresh in the background.
 */
async function getEngagementAffinity(db, username) {
  if (!ENGAGE_BOOST_ENABLED) return null;
  const u = norm(username);
  if (!u || !HIVE_ACCOUNT_RE.test(u)) return null;

  const hit = cache.get(u);
  if (hit && Date.now() - hit.at < ENGAGE_CACHE_TTL_MS) {
    touch(u);
    // A row we hold but that the sync has let go stale still needs refreshing, even
    // while the in-process copy of it is fresh.
    if (isStale(hit.affinity)) requestSync(u);
    return hit.affinity;
  }

  let row = null;
  try {
    row = await db.collection(ENGAGE_COLLECTION).findOne({ _id: u });
  } catch (e) {
    // A broken read degrades to "no boost", which leaves the feed exactly as it was.
    console.warn('[engagement] affinity read failed:', e && e.message);
    if (hit) { touch(u); return hit.affinity; }   // stale beats broken
    return null;
  }

  const affinity = row
    ? { authors: row.authors || {}, topics: row.topics || {}, topic_events: row.topic_events || 0, updated_at: row.updated_at }
    : null;
  remember(u, affinity);
  if (!affinity || isStale(affinity)) requestSync(u);
  return affinity;
}

function isStale(affinity) {
  if (!affinity) return true;
  const at = affinity.updated_at ? new Date(affinity.updated_at).getTime() : 0;
  return !at || Date.now() - at > ENGAGE_SYNC_TTL_MS;
}

/**
 * The multiplier for one candidate. Pure — no I/O, safe in the hot loop.
 * @param {{authors:Object,topics:Object}|null} affinity
 * @param {string} author   the video's HIVE author
 * @param {string} topic    the video's winning topic tag (may be null)
 */
function engagementMultiplier(affinity, author, topic) {
  if (!ENGAGE_BOOST_ENABLED || !affinity) return 1;

  const aw = Math.max(0, Number(affinity.authors && affinity.authors[author]) || 0);
  const rawShare = Math.max(0, Number(topic && affinity.topics && affinity.topics[topic]) || 0);
  // Below the floor a topic is noise — one stray comment inside a 90-day window —
  // and boosting on it would quietly widen the feed rather than focus it.
  const share = rawShare >= ENGAGE_TOPIC_MIN_SHARE ? Math.min(1, rawShare) : 0;
  if (!aw && !share) return 1;

  // A share is a proportion, and a proportion of almost nothing is not evidence: two
  // engaged videos that happen to share a topic read as "100% of what you like". The
  // term ramps in with how many engagements we could actually resolve a topic for.
  const evidence = ENGAGE_TOPIC_FULL_EVENTS > 0
    ? Math.min(1, (Number(affinity.topic_events) || 0) / ENGAGE_TOPIC_FULL_EVENTS)
    : 1;

  const boost = 1
    + ENGAGE_AUTHOR_WEIGHT * Math.log1p(aw)
    + ENGAGE_TOPIC_WEIGHT * share * evidence;

  return Math.min(ENGAGE_MAX_BOOST, Math.max(1, boost));
}

// Who the viewer engaged with is the HIVE author — `owner` is the asset uploader and
// is not always the same account. Same rule as utils/followBoost.js.
const defaultAuthorOf = (v) => norm(v.author || v.hive_author || v.owner);
const defaultTopicOf = (v) => (v.winnerTag ? String(v.winnerTag).toLowerCase() : null);

/**
 * Multiply the score of videos by creators / about topics the caller engaged with.
 *
 * ⚠️ MUST run AFTER applyFollowBoost — with ENGAGE_COMBINE_WITH_FOLLOW='max' (the
 * default) a creator you both follow AND engage with gets the LARGER of the two
 * multipliers, not their product. Following someone and replying to them is one
 * preference expressed twice, and ×1.6 × ×2.0 = ×3.2 would put "a creator I like"
 * above an interest the viewer picked by hand. That correction needs `follow_match`,
 * which applyFollowBoost sets.
 *
 * @returns {number} how many videos were boosted
 */
function applyEngagementBoost(videos, affinity, opts = {}) {
  if (!ENGAGE_BOOST_ENABLED || !affinity || !Array.isArray(videos) || !videos.length) return 0;
  const authorsOk = affinity.authors && Object.keys(affinity.authors).length;
  const topicsOk = affinity.topics && Object.keys(affinity.topics).length;
  if (!authorsOk && !topicsOk) return 0;

  const scoreField = opts.scoreField || 'trending_score';
  const authorOf = opts.authorOf || defaultAuthorOf;
  const topicOf = opts.topicOf || defaultTopicOf;
  const combineMax = (opts.combine || ENGAGE_COMBINE_WITH_FOLLOW) === 'max';

  let n = 0;
  for (const v of videos) {
    const mult = engagementMultiplier(affinity, authorOf(v), topicOf(v));
    if (mult <= 1) continue;

    // Divide out the follow boost already applied to this same author, then take the
    // larger of the two. `follow_match` is set by applyFollowBoost; when it hasn't
    // run (or the boost is off) this is a no-op.
    const already = combineMax && v.follow_match && FOLLOW_BOOST > 1 ? FOLLOW_BOOST : 1;
    const effective = Math.max(mult, already) / already;
    if (effective <= 1) continue;

    v.engagement_match = true;
    v.engagement_boost = mult;
    v[scoreField] = (Number(v[scoreField]) || 0) * effective;
    n += 1;
  }
  return n;
}

/** Test/ops hook — drop the in-process cache and the pending queue. */
function invalidate() { cache.clear(); queue.clear(); }

module.exports = {
  getEngagementAffinity, engagementMultiplier, applyEngagementBoost,
  defaultAuthorOf, defaultTopicOf, setWarmer, takeQueued, dequeue, forget, invalidate,
  HIVE_ACCOUNT_RE,
};
