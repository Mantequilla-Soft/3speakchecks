/**
 * Retention scoring — PURE MATH (no DB, no I/O). Shared by the retention worker
 * (services/retentionWorker.js) and documented 1:1 in algo.md.
 *
 * Turns the raw per-video watch-duration aggregates into a single, length-fair,
 * confidence-adjusted quality number `relQ` (~1.0 == average for a video of that
 * length; >1 better, <1 worse), which the feeds turn into a bounded multiplier.
 */

const {
  RETENTION_COMPLETION_PCT, RETENTION_HOOK_FRAC, RETENTION_BAYES_M,
  RETENTION_W_PCT, RETENTION_W_COMPLETION, RETENTION_W_HOOK, RETENTION_W_REPLAY,
  RETENTION_WEIGHT, RETENTION_MIN_MULT, RETENTION_MAX_MULT,
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
 * rawQuality ∈ [0,1] — a blend of the four honest engagement signals, each
 * already normalized to [0,1]. Weights are renormalized so they always sum to 1
 * (so tuning one weight can't silently rescale the whole score).
 *   pct        = avgWatchedPct / 100    (unique timeline coverage; replay-proof)
 *   completion = fraction of sessions that reached RETENTION_COMPLETION_PCT
 *   hook       = fraction of sessions that got past RETENTION_HOOK_FRAC of the video
 *   replay     = replayIntensity mapped to [0,1] (rewatched-moment strength)
 */
function rawQuality(m) {
  const pct = clamp((Number(m.avgPct) || 0) / 100, 0, 1);
  const completion = clamp(Number(m.completionRate) || 0, 0, 1);
  const hook = clamp(Number(m.hookRate) || 0, 0, 1);
  // replayIntensity is ~1.0 for a flat curve; >1 means some moments are rewatched.
  // Map [1, 3] → [0, 1] so a normal video contributes ~0 and a heavily-replayed
  // one approaches 1.
  const replay = clamp(((Number(m.replayIntensity) || 1) - 1) / 2, 0, 1);

  const wSum = RETENTION_W_PCT + RETENTION_W_COMPLETION + RETENTION_W_HOOK + RETENTION_W_REPLAY || 1;
  return (
    RETENTION_W_PCT * pct +
    RETENTION_W_COMPLETION * completion +
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
 *   mult = clamp(1 + WEIGHT·(relQ − 1), MIN_MULT, MAX_MULT)
 * relQ==1 → ×1 (neutral). Bounded so retention TILTS the ranking, never dominates.
 */
function retentionMultiplier(relQ, opts = {}) {
  const weight = opts.weight ?? RETENTION_WEIGHT;
  const min = opts.min ?? RETENTION_MIN_MULT;
  const max = opts.max ?? RETENTION_MAX_MULT;
  const rq = Number(relQ);
  if (!Number.isFinite(rq)) return 1;
  return clamp(1 + weight * (rq - 1), min, max);
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
  RETENTION_HOOK_FRAC,
};
