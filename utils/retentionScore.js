/**
 * Retention scoring — PURE MATH (no DB, no I/O). Shared by the retention worker
 * (services/retentionWorker.js) and documented 1:1 in algo.md.
 *
 * Turns the raw per-video watch-duration aggregates into a single, length-fair,
 * confidence-adjusted quality number `relQ` (~1.0 == average for a video of that
 * length; >1 better, <1 worse), which the feeds turn into a bounded multiplier.
 */

const {
  RETENTION_COMPLETION_PCT, RETENTION_HOOK_FRAC, RETENTION_BAYES_M, RETENTION_ENGAGED_PCT,
  RETENTION_W_PCT, RETENTION_W_COMPLETION, RETENTION_W_ENGAGED, RETENTION_W_HOOK, RETENTION_W_REPLAY,
  RETENTION_WEIGHT, RETENTION_MIN_MULT, RETENTION_MAX_MULT,
  RETENTION_PENALTY_MIN_VIEWERS, RETENTION_PENALTY_FULL_VIEWERS, RETENTION_PENALTY_DEADBAND,
} = require('./config');

// Duration bands (seconds). Retention % is heavily length-biased — a 30s clip
// trivially out-retains a 25-min doc — so we only ever compare a video to OTHER
// videos in its own band. Keep these boundaries in sync with algo.md.
const DURATION_BANDS = [
  { key: 'xs', maxSec: 60 },     // < 1 min  (shorts / clips)
  { key: 's', maxSec: 300 },     // 1–5 min
  { key: 'm', maxSec: 1200 },    // 5–20 min
  { key: 'l', maxSec: 3600 },    // 20–60 min
  { key: 'xl', maxSec: Infinity }, // 60 min+
];

function durationBand(durationSec) {
  const d = Number(durationSec) || 0;
  for (const b of DURATION_BANDS) if (d < b.maxSec) return b.key;
  return 'xl';
}

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * rawQuality ∈ [0,1] — a blend of the five honest engagement signals, each
 * already normalized to [0,1]. Weights are renormalized so they always sum to 1
 * (so tuning one weight can't silently rescale the whole score).
 *   pct        = avgWatchedPct / 100    (unique timeline coverage; replay-proof)
 *   completion = fraction of sessions that reached RETENTION_COMPLETION_PCT (70)
 *   engaged    = fraction of sessions that reached RETENTION_ENGAGED_PCT (30)
 *   hook       = fraction of sessions that got past RETENTION_HOOK_FRAC of the video
 *   replay     = replayIntensity mapped to [0,1] (rewatched-moment strength)
 *
 * `engaged` is the low bar, and it exists because the high bar was throwing away
 * real evidence. In an ideal world a half-watched video isn't "good" — but 70% is a
 * hard line, and on the live data the sessions between 30% and 70% (13% of all
 * sessions) counted for nothing but the `pct` term. A third of a video watched is
 * not a bounce, and with a dataset this thin we would rather credit partial watch
 * time as value than demand a completion rate almost nothing clears. Ladder the two
 * and a video that holds people halfway scores between a bounce and a finish, which
 * is exactly what it is.
 */
function rawQuality(m) {
  const pct = clamp((Number(m.avgPct) || 0) / 100, 0, 1);
  const completion = clamp(Number(m.completionRate) || 0, 0, 1);
  const engaged = clamp(Number(m.engagedRate) || 0, 0, 1);
  const hook = clamp(Number(m.hookRate) || 0, 0, 1);
  // replayIntensity is ~1.0 for a flat curve; >1 means some moments are rewatched.
  // Map [1, 3] → [0, 1] so a normal video contributes ~0 and a heavily-replayed
  // one approaches 1.
  const replay = clamp(((Number(m.replayIntensity) || 1) - 1) / 2, 0, 1);

  const wSum = RETENTION_W_PCT + RETENTION_W_COMPLETION + RETENTION_W_ENGAGED
    + RETENTION_W_HOOK + RETENTION_W_REPLAY || 1;
  return (
    RETENTION_W_PCT * pct +
    RETENTION_W_COMPLETION * completion +
    RETENTION_W_ENGAGED * engaged +
    RETENTION_W_HOOK * hook +
    RETENTION_W_REPLAY * replay
  ) / wSum;
}

/**
 * Bayesian shrinkage toward the global mean C. With few distinct viewers we don't
 * trust `raw`, so we pull it toward the average; as viewers → ∞ we trust it fully.
 * This is what keeps a single 100%-watched view from rocketing a brand-new video
 * (and, symmetrically, keeps low-data videos NEUTRAL rather than buried).
 *   q = (viewers·raw + M·C) / (viewers + M)
 */
function bayesShrink(raw, viewers, globalMean, M = RETENTION_BAYES_M) {
  const v = Math.max(0, Number(viewers) || 0);
  return (v * raw + M * globalMean) / (v + M || 1);
}

/**
 * Length-normalize: divide the shrunk quality by the mean quality of the video's
 * OWN duration band. ~1.0 == typical for that length. Clamped so a tiny/edge band
 * can't produce absurd multipliers.
 */
function relativeQuality(q, bandMeanQ) {
  const mean = bandMeanQ > 0 ? bandMeanQ : q || 1;
  return clamp(q / mean, 0.2, 3);
}

/**
 * The bounded feed multiplier applied to a video's existing feed score.
 *
 * UPSIDE — unchanged, and deliberately ungated:
 *   mult = clamp(1 + WEIGHT·(relQ − 1), MIN_MULT, MAX_MULT)
 * A video people watch through is boosted from its very first viewer.
 *
 * DOWNSIDE — gated on EVIDENCE, which the old symmetric formula was not.
 *
 * `relQ` is `q` over the mean `q` of its duration band, and that mean is dragged
 * upward by the handful of genuinely-great videos in the band. So the TYPICAL video
 * lands a little under 1.0 — and a video with NO watch data at all gets exactly ×1,
 * because we have nothing to say about it. Put together, the old formula ranked a
 * video that one person watched to 90% BELOW an identical video nobody has ever
 * opened. Having a little data was a penalty. Live numbers when this was found: 650
 * of 1044 scored videos (62%) sat below ×1, and 633 of those had ≤1 distinct viewer.
 *
 * Two gates fix that, and both only touch relQ < 1:
 *
 *   confidence = clamp((viewers − MIN) / (FULL − MIN), 0, 1)
 *   shortfall  = max(0, (1 − relQ) − PENALTY_DEADBAND)   the noise band under 1.0 is free
 *   mult       = clamp(1 − WEIGHT · confidence · shortfall, MIN_MULT, MAX_MULT)
 *
 * MIN is a HARD floor, not the start of a soft ramp. At or below MIN distinct
 * viewers, confidence is exactly 0 and retention can only boost — one person
 * bouncing is not a verdict. (A soft ramp from zero still cost a badly-scoring
 * 1-viewer video ~14%, which is the same inversion wearing a smaller hat.)
 *
 * A genuinely bad video with real viewers still sinks exactly as hard as before
 * (54 viewers, relQ 0.43 → the MIN_MULT floor). What stops happening is punishing a
 * video for the crime of having been watched once.
 *
 * @param {number} relQ
 * @param {object} [opts] {weight,min,max} and `viewers` — the DISTINCT viewer count
 *   from the video-retention row. Omit `viewers` and the demotion is skipped: a
 *   caller that can't say how much evidence there is doesn't get to demote on it.
 */
function retentionMultiplier(relQ, opts = {}) {
  const weight = opts.weight ?? RETENTION_WEIGHT;
  const min = opts.min ?? RETENTION_MIN_MULT;
  const max = opts.max ?? RETENTION_MAX_MULT;

  // Guard BEFORE Number(): Number(null) is 0, not NaN, so a null score would sail
  // past an isFinite() check and land in the demotion branch as "relQ = 0".
  if (relQ == null || relQ === '') return 1;
  const rq = Number(relQ);
  if (!Number.isFinite(rq)) return 1;

  if (rq >= 1) return clamp(1 + weight * (rq - 1), min, max);

  const minViewers = opts.penaltyMinViewers ?? RETENTION_PENALTY_MIN_VIEWERS;
  const fullViewers = opts.penaltyFullViewers ?? RETENTION_PENALTY_FULL_VIEWERS;
  const deadband = opts.deadband ?? RETENTION_PENALTY_DEADBAND;

  const viewers = opts.viewers == null ? NaN : Number(opts.viewers);
  const span = Math.max(1, fullViewers - minViewers);
  const confidence = Number.isFinite(viewers)
    ? clamp((viewers - minViewers) / span, 0, 1)
    : 0;                                    // unknown evidence → no demotion, ever
  if (confidence <= 0) return clamp(1, min, max);

  const shortfall = Math.max(0, (1 - rq) - deadband);
  return clamp(1 - weight * confidence * shortfall, min, max);
}

module.exports = {
  DURATION_BANDS,
  durationBand,
  rawQuality,
  bayesShrink,
  relativeQuality,
  retentionMultiplier,
  clamp,
  RETENTION_COMPLETION_PCT,
  RETENTION_ENGAGED_PCT,
  RETENTION_HOOK_FRAC,
};
