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
  DISCOVER_AGE_HALFLIFE_Y, DISCOVER_AGE_FLOOR,
  DISCOVER_ULTRAFRESH_HOURS, DISCOVER_RECENCY_BOOST, DISCOVER_RECENCY_HALFLIFE_H,
} = require('./config');

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// Age-band upper bounds in DAYS, aligned 1:1 with DISCOVER_AGE_WEIGHTS.
//   [0]<10h  [1]10h–7d  [2]7–30d  [3]30d–6mo  [4]6mo–1y  [5]1y–2y  [6]>2y
// The first band is the ultra-fresh window (default 10h) so brand-new uploads get
// their own guaranteed, front-loaded share of the page — see the weights in config.
const AGE_BAND_DAYS = [(DISCOVER_ULTRAFRESH_HOURS || 10) / 24, 7, 30, 182.5, 365, 730, Infinity];
const DAY_MS = 86400000;

/** Which age band a `created` date falls in. Unknown/invalid date → the oldest band. */
function ageBandIndex(created, now = Date.now()) {
  const t = created instanceof Date ? created.getTime() : new Date(created).getTime();
  const days = Number.isFinite(t) ? (now - t) / DAY_MS : Infinity;
  for (let i = 0; i < AGE_BAND_DAYS.length; i += 1) if (days < AGE_BAND_DAYS[i]) return i;
  return AGE_BAND_DAYS.length - 1;
}

/** Hours since `created`. Infinity for a missing/invalid date (→ the ancient floor). */
function ageHours(created, now = Date.now()) {
  const t = created instanceof Date ? created.getTime() : new Date(created).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return Math.max(0, (now - t) / 3600000);
}

const HOURS_PER_YEAR = 24 * 365.25;

/**
 * Two-stage age decay.
 *
 * Stage 1 — the fast half-life (hours). This is what makes this week's uploads
 * beat last week's; it bottoms out at the FLOOR after ~3.7 days.
 *
 * Stage 2 — the long AGE TAIL (years) on the floor itself. The flat floor used to
 * make everything past ~3.7 days age-equal: a 5-month-old video and a 4-year-old
 * one scored identically, so the archive competed head-on with recent work and
 * >2y videos saturated the feed. The floor now keeps decaying, slowly:
 *
 *   freshness = max( 0.5^(hrs / HALFLIFE_H),
 *                    FLOOR · max(0.5^(years / AGE_HALFLIFE_Y), AGE_FLOOR) )
 *
 * Defaults (1y half-life, 0.25 tail floor) bottom out exactly at the 2-year mark:
 * 4 days → 0.43, 5 months → 0.32, 1 year → 0.22, ≥2 years → 0.107 flat. Ancient is
 * damped, not dead — retention (×2.5) and curation (×2.5) can still resurface a
 * genuinely great old video, which is the point of a discovery feed.
 *
 * A missing/invalid date now gets the ANCIENT floor, not the full one — unknown
 * age must not outrank known-old.
 */
function freshness(hrs, halfLifeH = DISCOVER_HALFLIFE_H, floor = DISCOVER_FRESH_FLOOR,
                   ageHalfLifeY = DISCOVER_AGE_HALFLIFE_Y, ageFloor = DISCOVER_AGE_FLOOR) {
  const tailAt = (years) => (ageHalfLifeY > 0
    ? Math.max(Math.pow(0.5, years / ageHalfLifeY), ageFloor)
    : 1);
  if (!Number.isFinite(hrs)) return floor * tailAt(Infinity);
  const fast = Math.pow(0.5, hrs / (halfLifeH || 1));
  return Math.max(fast, floor * tailAt(hrs / HOURS_PER_YEAR));
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
 * RECENCY boost: a CONTINUOUS recency premium folded into `base`, decoupled from the
 * discrete age bands. Strongest for a brand-new upload, its extra lift halving every
 * `halfLifeH`, back to ×1 after a few days:
 *   recencyBoost = 1 + STRENGTH · 0.5^(hrs / halfLifeH)
 *
 * This is "newer ranks higher" as a real gradient — unlike newBoost (a mild <12h taper)
 * or the <10h age band (composition, not score). It's what lifts recent videos on SCORE
 * everywhere ranking is score-driven: the interests feed (no bands), the follow feed, and
 * the within-band ordering of discover — so a recent video isn't left behind by an older
 * one carrying strong curation / retention / comment multipliers.
 */
function recencyBoost(hrs, strength = DISCOVER_RECENCY_BOOST, halfLifeH = DISCOVER_RECENCY_HALFLIFE_H) {
  if (!Number.isFinite(hrs) || !(strength > 0) || !(halfLifeH > 0)) return 1;
  return 1 + strength * Math.pow(0.5, hrs / halfLifeH);
}

// The reshare boost used to live here. It is now one of three terms in the shared
// curation boost (utils/curation.js) — reshares + playlist saves + viewer tags —
// which is what the pool worker folds into `base`. Reshares kept their weight.

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
 * Weighted order without replacement (Efraimidis–Spirakis): each item draws the
 * key u^(1/w) from the seeded RNG and the keys are sorted descending. An item's
 * chance of coming out early is proportional to its weight, every item still
 * appears exactly once, and the result is deterministic for a given seed.
 */
function weightedOrder(items, rng, weightOf) {
  return items
    .map((it) => {
      const w = Math.max(Number(weightOf(it)) || 0, 1e-9);
      return { it, key: Math.pow(rng(), 1 / w) };
    })
    .sort((a, b) => b.key - a.key)
    .map((x) => x.it);
}

/**
 * Sprinkle exploration picks through the ranking: every `every`-th slot is taken
 * from the exploration tail, the rest come from the head in score order. Every
 * item appears exactly once (no dupes, no drops), so `total` and pagination stay
 * correct, and everything is deterministic for a given seed.
 *
 * THE PARTITION IS THE WHOLE GAME here, and it has been wrong twice:
 *
 *   - Uniform draw from the lower HALF (original): the lower half is mostly the
 *     all-time random pool sample, so 58% of the exploration slots on a live page
 *     were >2y-old videos — the ranked slots were 100% fresh, so effectively every
 *     ancient video a user saw arrived through this one door (~15-23% of the page).
 *   - Score-WEIGHTED draw from the lower half: no better (measured 83% of explore
 *     slots >2y). Once the freshness age tail cleanly separated ages, every fresh
 *     and mid-age video moved into the top half — the lower half became PURELY
 *     ancient, and no weighting can fix composition. The draw pool must contain
 *     the mid-band for weights to matter at all.
 *
 * So with `weightOf`: the head is only the top `headSize` (≈ one page) in strict
 * score order, and EVERYTHING below it competes for the explore slots, drawn by
 * score^`pow` (weightedOrder). The weight already carries freshness (age tail),
 * retention and curation, so the odds per slot are: weak-fresh and months-old
 * first, years-old rarely, ancient rarest — but never zero, which is the point of
 * a discovery feed. Simulated on the live pool (5 seeds): >2y went from ~23% of
 * the page to ~5%, and the previously-invisible 30d–2y band to ~10%.
 *
 * Without `weightOf` the legacy behaviour (uniform draw from the lower half) is
 * preserved for any caller that wants a plain shuffle.
 */
function interleaveExploration(ranked, rng, opts = {}) {
  const every = opts.every ?? DISCOVER_EXPLORE_EVERY;
  const weightOf = opts.weightOf ?? null;
  const pow = opts.pow ?? 1;              // legacy fallback path — defaults inline now
  if (!Array.isArray(ranked) || ranked.length < 4 || !(every >= 2)) return ranked;

  const cut = weightOf
    ? Math.min(opts.headSize ?? 48, Math.ceil(ranked.length / 2))
    : Math.ceil(ranked.length / 2);
  const head = ranked.slice(0, cut);          // strong scores, kept in order
  const rest = ranked.slice(cut);             // the exploration pool
  const tail = weightOf
    ? weightedOrder(rest, rng, (it) => Math.pow(Math.max(Number(weightOf(it)) || 0, 1e-9), pow))
    : shuffle(rest, rng);

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

/**
 * Age-stratified interleave — compose the page to a TARGET age distribution.
 *
 * `ranked` is already in score order. We split it into the AGE_BAND_DAYS bands and
 * emit ONE ordering whose age composition matches `weights` at every depth, using a
 * virtual-time (WFQ / stride) scheduler:
 *
 *   vt(band) = (emitted[band] + 0.5) / weight[band]
 *
 * At each output slot, among bands that still have items we take the one with the
 * smallest virtual time — i.e. the band that is furthest behind its quota. This
 * makes page 1 AND page 5 carry the same mix (so pagination is consistent), and
 * because we only ever advance within a band's own score-sorted list, quality still
 * decides WHICH videos of each age appear — the weights only decide HOW MANY.
 *
 * Robust by construction:
 *  - A band with too few videos simply runs dry; its slots flow to the others
 *    (highest-weight-first), so a thin <7d band backfills from 7–30d rather than
 *    leaving gaps.
 *  - A band with items but weight 0 gets a huge vt, so it is served only after every
 *    weighted band is exhausted — it still appears (exactly-once holds), just last.
 *  - Every item is emitted exactly once → `total` and pagination stay correct.
 *
 * Deterministic: no RNG here. The per-load seed already lives in each item's
 * discover_score (via jitter), so the within-band order breathes per seed and the
 * scheduler is a pure function of that order.
 */
function interleaveByAge(ranked, weights, now = Date.now()) {
  if (!Array.isArray(ranked) || ranked.length < 2 || !Array.isArray(weights) || !weights.length) {
    return ranked;
  }
  const nb = weights.length;
  const w = weights.map((x) => Math.max(Number(x) || 0, 0));
  const bands = Array.from({ length: nb }, () => []);
  for (const v of ranked) {
    // Clamp the band index into the weight vector in case someone configures fewer
    // weights than AGE_BAND_DAYS has bands — extra-old videos fall into the last one.
    bands[Math.min(ageBandIndex(v.created, now), nb - 1)].push(v);
  }

  const emitted = new Array(nb).fill(0);
  const pos = new Array(nb).fill(0);
  const vt = (i) => (emitted[i] + 0.5) / (w[i] || 1e-9);

  const out = [];
  while (out.length < ranked.length) {
    let pick = -1;
    for (let i = 0; i < nb; i += 1) {
      if (pos[i] >= bands[i].length) continue;       // band drained
      if (pick < 0 || vt(i) < vt(pick)) pick = i;
    }
    if (pick < 0) break;                             // all bands drained
    out.push(bands[pick][pos[pick]]);
    pos[pick] += 1;
    emitted[pick] += 1;
  }
  return out;
}

/**
 * Compose the list so a guaranteed SHARE of every prefix goes to interest matches.
 *
 * A score multiplier cannot deliver top-of-feed prominence here, because `base`
 * spans roughly 15x between its median and p99: a x3 boost lifts a median match
 * to ~0.7, which still loses to the ~3% of non-matching videos scoring above
 * that, and those are exactly the ones filling the first screen. Pushing the
 * multiplier high enough to win would also float weak matches over genuinely
 * strong other videos — buying position by wrecking quality.
 *
 * Position is the honest lever. For output slot i, the target match count is
 * round((i+1) * share); a match is emitted whenever we are behind that target and
 * one is left. So the ratio holds at the TOP as well as overall, rather than
 * averaging out over a long tail.
 *
 * Both streams keep their incoming order, so whatever ranked and composed them
 * (score, then age bands) still governs within each. Every item is emitted
 * exactly once, so `total` and pagination stay correct.
 *
 * Deterministic: no RNG — the per-load seed already lives in discover_score.
 */
function interleaveByInterest(ranked, share, isMatch) {
  if (!Array.isArray(ranked) || ranked.length < 2) return ranked;
  const s = Number(share);
  if (!(s > 0) || s >= 1) return ranked;          // 0 or >=1 → nothing to compose

  const matches = [];
  const rest = [];
  for (const e of ranked) (isMatch(e) ? matches : rest).push(e);
  if (!matches.length || !rest.length) return ranked;

  const out = [];
  let mi = 0;
  let ri = 0;
  while (mi < matches.length || ri < rest.length) {
    if (mi >= matches.length) { out.push(rest[ri++]); continue; }
    if (ri >= rest.length) { out.push(matches[mi++]); continue; }
    const target = Math.round((out.length + 1) * s);
    out.push(mi < target ? matches[mi++] : rest[ri++]);
  }
  return out;
}

module.exports = {
  ageHours, freshness, newBoost, recencyBoost, jitter, shuffle, weightedOrder,
  interleaveExploration, interleaveByAge, interleaveByInterest,
  ageBandIndex, AGE_BAND_DAYS, clamp,
};
