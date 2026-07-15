/**
 * The ranking math that the feeds depend on. Pure functions only — no DB.
 */
const {
  rawQuality, retentionMultiplier, relativeQuality, bayesShrink, durationBand,
} = require('../utils/retentionScore');
const { curationBoost } = require('../utils/curation');
const { applyFollowBoost } = require('../utils/followBoost');

// Discover's multiplier options (the amplified ones) — the harshest case.
const DISCOVER = { weight: 1.5, min: 0.4, max: 2.5 };

describe('retentionMultiplier — the upside is ungated', () => {
  test('an average video is neutral', () => {
    expect(retentionMultiplier(1, { viewers: 50 })).toBeCloseTo(1, 5);
  });

  test('a good video is boosted from its FIRST viewer (no confidence gate on the upside)', () => {
    expect(retentionMultiplier(1.3, { ...DISCOVER, viewers: 1 })).toBeGreaterThan(1.4);
  });

  test('the boost is capped', () => {
    expect(retentionMultiplier(99, { ...DISCOVER, viewers: 500 })).toBe(2.5);
  });
});

describe('retentionMultiplier — the downside needs EVIDENCE', () => {
  // The bug this fixes: relQ is normalized against the band MEAN, so the typical
  // video sits just under 1.0 — and used to be demoted BELOW a video with no watch
  // data at all (which scores exactly x1). Having one viewer was a penalty.
  // THE INVARIANT. This is the whole point of the change: watch data must never be
  // a liability. Below the evidence floor, retention can lift a video and nothing else.
  test('with too few viewers, NO score can rank a video below one with no data at all', () => {
    const noData = 1;
    for (const viewers of [0, 1, 2, 3]) {
      for (const relQ of [0.2, 0.43, 0.75, 0.86, 0.95, 0.99]) {
        expect(retentionMultiplier(relQ, { ...DISCOVER, viewers })).toBeGreaterThanOrEqual(noData);
      }
    }
  });

  test('the deadband makes noise just under 1.0 free, even with hundreds of viewers', () => {
    expect(retentionMultiplier(0.95, { ...DISCOVER, viewers: 500 })).toBe(1);
  });

  test('a genuinely bad video WITH real viewers still sinks exactly as hard as before', () => {
    expect(retentionMultiplier(0.75, { ...DISCOVER, viewers: 13 })).toBeCloseTo(0.775, 3);
    expect(retentionMultiplier(0.43, { ...DISCOVER, viewers: 54 })).toBe(0.4); // floors out
  });

  test('the penalty ramps in with evidence rather than snapping on at a cliff', () => {
    const at3 = retentionMultiplier(0.6, { ...DISCOVER, viewers: 3 });
    const at5 = retentionMultiplier(0.6, { ...DISCOVER, viewers: 5 });
    const at10 = retentionMultiplier(0.6, { ...DISCOVER, viewers: 10 });
    expect(at3).toBe(1);              // floor: no evidence
    expect(at5).toBeLessThan(at3);    // ramping
    expect(at10).toBeLessThan(at5);   // full penalty
    expect(at10).toBeCloseTo(1 - 1.5 * 0.3, 3);
    expect(at5 - at10).toBeGreaterThan(0.1); // and the ramp is gradual, not a step
  });

  test('an unknown viewer count never demotes — a caller that cannot say how much evidence there is does not get to punish on it', () => {
    expect(retentionMultiplier(0.2, DISCOVER)).toBe(1);
  });

  // Number(null) is 0, not NaN — so a null score used to sail past isFinite() and be
  // scored as relQ=0, i.e. demoted to the floor. It must read as "no opinion".
  test('a null / undefined / empty relQ is neutral, not a zero', () => {
    expect(retentionMultiplier(undefined, { viewers: 100 })).toBe(1);
    expect(retentionMultiplier(null, { viewers: 100 })).toBe(1);
    expect(retentionMultiplier('', { viewers: 100 })).toBe(1);
    expect(retentionMultiplier(NaN, { viewers: 100 })).toBe(1);
  });
});

describe('rawQuality — partial watch time counts', () => {
  const base = { avgPct: 40, completionRate: 0, hookRate: 1, replayIntensity: 1 };

  test('sessions that reach the engaged bar but not completion now score higher than a bounce', () => {
    const bounced = rawQuality({ ...base, engagedRate: 0 });
    const halfWatched = rawQuality({ ...base, engagedRate: 1 });
    expect(halfWatched).toBeGreaterThan(bounced);
  });

  test('but a video people FINISH still beats one they merely half-watch', () => {
    const half = rawQuality({ avgPct: 40, completionRate: 0, engagedRate: 1, hookRate: 1, replayIntensity: 1 });
    const finished = rawQuality({ avgPct: 95, completionRate: 1, engagedRate: 1, hookRate: 1, replayIntensity: 1 });
    expect(finished).toBeGreaterThan(half);
  });

  test('stays within [0,1]', () => {
    const max = rawQuality({ avgPct: 100, completionRate: 1, engagedRate: 1, hookRate: 1, replayIntensity: 5 });
    const min = rawQuality({ avgPct: 0, completionRate: 0, engagedRate: 0, hookRate: 0, replayIntensity: 1 });
    expect(max).toBeLessThanOrEqual(1);
    expect(min).toBeGreaterThanOrEqual(0);
  });

  test('a missing engagedRate (a row written before the field existed) is not an error', () => {
    expect(Number.isFinite(rawQuality(base))).toBe(true);
  });
});

describe('curationBoost', () => {
  test('no curation is exactly neutral', () => {
    expect(curationBoost({})).toBe(1);
    expect(curationBoost({ reshares: 0, saves: 0, tags: 0 })).toBe(1);
  });

  test('every manual vote lifts the video', () => {
    expect(curationBoost({ reshares: 1 })).toBeGreaterThan(1);
    expect(curationBoost({ saves: 1 })).toBeGreaterThan(1);
    expect(curationBoost({ tags: 1 })).toBeGreaterThan(1);
  });

  test('the signals stack', () => {
    const all = curationBoost({ reshares: 1, saves: 1, tags: 1 });
    expect(all).toBeGreaterThan(curationBoost({ saves: 1 }));
  });

  test('log-damped: the 10th save is worth far less than the 1st', () => {
    const first = curationBoost({ saves: 1 }) - 1;
    const tenth = curationBoost({ saves: 10 }) - curationBoost({ saves: 9 });
    expect(tenth).toBeLessThan(first / 5);
  });

  test('hard-capped, so one motivated person cannot mint a #1 slot', () => {
    expect(curationBoost({ reshares: 1e6, saves: 1e6, tags: 1e6 })).toBe(2.5);
  });

  test('reshareWeight:0 lets trending/shorts opt out of double-counting reshares', () => {
    expect(curationBoost({ reshares: 50 }, { reshareWeight: 0 })).toBe(1);
    expect(curationBoost({ reshares: 50, saves: 1 }, { reshareWeight: 0 }))
      .toBeCloseTo(curationBoost({ saves: 1 }, { reshareWeight: 0 }), 5);
  });
});

describe('applyFollowBoost', () => {
  const mk = () => ([
    { author: 'alice', owner: 'alice', trending_score: 10 },
    { author: 'bob', owner: 'bob', trending_score: 10 },
  ]);

  test('boosts only followed creators', () => {
    const vids = mk();
    const n = applyFollowBoost(vids, new Set(['alice']), { mult: 2 });
    expect(n).toBe(1);
    expect(vids[0].trending_score).toBe(20);
    expect(vids[0].follow_match).toBe(true);
    expect(vids[1].trending_score).toBe(10);
    expect(vids[1].follow_match).toBeUndefined();
  });

  test('matches the HIVE author, not the asset owner (they differ for embeds)', () => {
    const vids = [{ author: 'alice', owner: 'uploader-bot', trending_score: 10 }];
    applyFollowBoost(vids, new Set(['alice']), { mult: 2 });
    expect(vids[0].trending_score).toBe(20);
  });

  test('a cold cache (null set) is a silent no-op — the feed is never blocked on Hive', () => {
    const vids = mk();
    expect(applyFollowBoost(vids, null, { mult: 2 })).toBe(0);
    expect(vids[0].trending_score).toBe(10);
  });
});

describe('the band normalization that caused all this', () => {
  test('relQ under 1 is the NORMAL case: a right-skewed band drags its own mean up', () => {
    const band = [0.5, 0.5, 0.5, 0.5, 0.9]; // one good video among four typical ones
    const mean = band.reduce((a, b) => a + b) / band.length;
    const typical = relativeQuality(0.5, mean);
    expect(typical).toBeLessThan(1);   // the MAJORITY of a band scores below 1.0
    // ...which is exactly why the demotion has to be gated on evidence: this video
    // is perfectly normal, and under the old formula it was demoted for it.
    expect(retentionMultiplier(typical, { ...DISCOVER, viewers: 1 })).toBe(1);
  });

  test('bayesShrink keeps a single 100% view from rocketing a video', () => {
    expect(bayesShrink(1, 1, 0.5)).toBeLessThan(0.55);
  });

  test('duration bands', () => {
    expect(durationBand(30)).toBe('xs');
    expect(durationBand(600)).toBe('m');
    expect(durationBand(99999)).toBe('xl');
  });
});
