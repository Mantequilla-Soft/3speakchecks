/**
 * Discover feed scoring — PURE MATH (no DB, no I/O). Documented 1:1 in algo.md.
 *
 * Deliberately blind to votes, views, rewards and reshares: this feed exists to
 * surface the content those signals bury. A candidate's score is
 *
 *   discover_score = freshness × newBoost × interest × retention × jitter
 *
 * and the final ordering is then interleaved with random picks from the lower
 * half of the ranking, so unseen work always gets a slot on the page.
 *
 * Everything here is deterministic for a given seed, which is what keeps
 * pagination stable across pages (an unseeded shuffle would duplicate/skip
 * videos between page 1 and page 2).
 */
const {
  DISCOVER_HALFLIFE_H, DISCOVER_FRESH_FLOOR, DISCOVER_NEW_GRACE_H,
  DISCOVER_NEW_BOOST, DISCOVER_JITTER, DISCOVER_EXPLORE_EVERY,
  DISCOVER_RESHARE_WEIGHT, DISCOVER_RESHARE_MAX_BOOST,
} = require('./config');

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Hours since `created`. Infinity for a missing/invalid date (→ floor score). */
function ageHours(created, now = Date.now()) {
  const t = created instanceof Date ? created.getTime() : new Date(created).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return Math.max(0, (now - t) / 3600000);
}

/**
 * Half-life decay on age, floored so a great older video never scores exactly 0
 * (it can still be lifted back up by retention + interest).
 *   freshness = max(0.5 ^ (ageHours / HALFLIFE), FLOOR)
 */
function freshness(hrs, halfLifeH = DISCOVER_HALFLIFE_H, floor = DISCOVER_FRESH_FLOOR) {
  if (!Number.isFinite(hrs)) return floor;
  return Math.max(floor, Math.pow(0.5, hrs / (halfLifeH || 1)));
}

/**
 * Extra lift for really fresh uploads, so brand-new videos get their first
 * traction before any retention data exists for them.
 *
 * Tapers LINEARLY from `boost` at age 0 down to 1.0 at `graceH`. A hard cliff
 * (boost while hrs <= graceH, else 1) would drop a video ~43% the minute it
 * crossed the boundary — visible as items falling off the row for no reason.
 *   newBoost = 1 + (boost - 1) · max(0, 1 - hrs/graceH)
 */
function newBoost(hrs, graceH = DISCOVER_NEW_GRACE_H, boost = DISCOVER_NEW_BOOST) {
  if (!Number.isFinite(hrs) || !(graceH > 0)) return 1;
  return 1 + (boost - 1) * Math.max(0, 1 - hrs / graceH);
}

/**
 * Reshare boost. A reshare is a real curation signal — someone put the video on
 * their own blog — but it IS a popularity signal, so it's log-damped and hard
 * capped: it can lift a video, never run away with the feed.
 *   reshareBoost = min(1 + W · ln(1 + n), CAP)
 * n=1 → 1.17,  n=5 → 1.45,  n=20 → 1.76,  n=100 → 2.0 (capped)   [at W=0.25]
 */
function reshareBoost(count, weight = DISCOVER_RESHARE_WEIGHT, cap = DISCOVER_RESHARE_MAX_BOOST) {
  const n = Math.max(0, Number(count) || 0);
  return Math.min(cap, 1 + weight * Math.log1p(n));
}

/** Seeded per-video jitter in [1-J, 1+J] — the row isn't identical on every load. */
function jitter(rand, amount = DISCOVER_JITTER) {
  return 1 + (rand - 0.5) * 2 * amount;
}

/** Fisher–Yates with an injected RNG (never Math.random — must stay seeded). */
function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Sprinkle exploration picks through the ranking: every `every`-th slot is taken
 * from a seeded shuffle of the LOWER half of the ranked list, the rest come from
 * the top half in score order. Every item appears exactly once (no dupes, no
 * drops), so `total` and pagination stay correct.
 */
function interleaveExploration(ranked, rng, every = DISCOVER_EXPLORE_EVERY) {
  if (!Array.isArray(ranked) || ranked.length < 4 || !(every >= 2)) return ranked;

  const cut = Math.ceil(ranked.length / 2);
  const head = ranked.slice(0, cut);          // strong scores, kept in order
  const tail = shuffle(ranked.slice(cut), rng); // the discovery pool

  const out = [];
  let hi = 0;
  let ti = 0;
  for (let i = 0; hi < head.length || ti < tail.length; i++) {
    const exploreSlot = (i + 1) % every === 0;
    if (exploreSlot && ti < tail.length) out.push(tail[ti++]);
    else if (hi < head.length) out.push(head[hi++]);
    else out.push(tail[ti++]);
  }
  return out;
}

module.exports = {
  ageHours, freshness, newBoost, reshareBoost, jitter, shuffle, interleaveExploration, clamp,
};
