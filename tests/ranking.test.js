/**
 * The ranking math that the feeds depend on. Pure functions only — no DB.
 */
const {
  rawQuality, retentionMultiplier, relativeQuality, bayesShrink, durationBand,
} = require('../utils/retentionScore');
const { curationBoost } = require('../utils/curation');
const { applyFollowBoost } = require('../utils/followBoost');
const { freshness, weightedOrder, interleaveExploration, interleaveByAge, ageBandIndex } = require('../utils/discoverScore');
const { mulberry32 } = require('../utils/hive');

const HOURS = { day: 24, month: 730.5, year: 8766 };
const DAY = 86400000;

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

describe('freshness — the two-stage age decay', () => {
  test('recent ordering is untouched: today > 3 days > a week', () => {
    const now = freshness(2);
    const days3 = freshness(3 * HOURS.day);
    const week = freshness(7 * HOURS.day);
    expect(now).toBeGreaterThan(days3);
    expect(days3).toBeGreaterThan(week);
  });

  // The question that prompted this: "do 5-month-old videos outrank 4-year-old
  // ones?" Under the flat floor they did NOT — both scored exactly 0.43.
  test('a 5-month-old video now outranks a 4-year-old one on age (~3x)', () => {
    const mo5 = freshness(5 * HOURS.month);
    const y4 = freshness(4 * HOURS.year);
    expect(mo5).toBeGreaterThan(y4);
    expect(mo5 / y4).toBeGreaterThan(2.5);
  });

  test('the tail keeps separating months and years until the 2-year floor', () => {
    const mo5 = freshness(5 * HOURS.month);
    const y1 = freshness(1 * HOURS.year);
    const y2 = freshness(2 * HOURS.year);
    const y4 = freshness(4 * HOURS.year);
    expect(mo5).toBeGreaterThan(y1);
    expect(y1).toBeGreaterThan(y2);
    expect(y2).toBeCloseTo(y4, 5);        // past 2y it's flat — damped, not ranked further
    expect(y4).toBeGreaterThan(0);         // ...and never zero: an old gem can still be lifted
  });

  test('an unknown date gets the ANCIENT floor, not the full one', () => {
    expect(freshness(Infinity)).toBeCloseTo(freshness(10 * HOURS.year), 5);
  });

  test('AGE_HALFLIFE_Y=0 restores the flat-floor behaviour', () => {
    expect(freshness(4 * HOURS.year, undefined, undefined, 0)).toBeCloseTo(0.43, 5);
  });
});

describe('weighted exploration', () => {
  const items = (n, weightFn) => Array.from({ length: n }, (_, i) => ({ id: i, w: weightFn(i) }));

  test('deterministic for a given seed — pagination stays stable', () => {
    const a = weightedOrder(items(50, (i) => 1 + (i % 5)), mulberry32(42), (x) => x.w);
    const b = weightedOrder(items(50, (i) => 1 + (i % 5)), mulberry32(42), (x) => x.w);
    expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id));
  });

  test('every item appears exactly once', () => {
    const out = weightedOrder(items(30, () => 1), mulberry32(7), (x) => x.w);
    expect(new Set(out.map((x) => x.id)).size).toBe(30);
  });

  test('heavier items come out earlier on average', () => {
    // half the items weigh 0.1 (the ">2y at the floor" case), half weigh 0.4
    let heavyFirstHalf = 0;
    for (let seed = 0; seed < 200; seed++) {
      const out = weightedOrder(items(20, (i) => (i < 10 ? 0.4 : 0.1)), mulberry32(seed), (x) => x.w);
      heavyFirstHalf += out.slice(0, 10).filter((x) => x.w === 0.4).length;
    }
    const share = heavyFirstHalf / (200 * 10);
    expect(share).toBeGreaterThan(0.6);   // uniform would be 0.5
  });

  test('interleaveExploration keeps its exactly-once contract with a weightOf', () => {
    const ranked = items(40, (i) => 40 - i);
    const out = interleaveExploration(ranked, mulberry32(3), { weightOf: (x) => x.w });
    expect(out).toHaveLength(40);
    expect(new Set(out.map((x) => x.id)).size).toBe(40);
    // ranked slots (not every 4th) still come from the head in order
    expect(out[0].id).toBe(0);
    expect(out[1].id).toBe(1);
  });

  test('with weightOf, the explore pool starts right below the head — the mid-band competes', () => {
    // 200 items: ids 0..199 in score order. With headSize=48, explore slots must be
    // able to surface items from just below the head (the "months old" band), which
    // the old lower-half split quarantined away from the draw entirely.
    const ranked = items(200, (i) => 200 - i);
    const out = interleaveExploration(ranked, mulberry32(9), { weightOf: (x) => x.w, headSize: 48 });
    const explorePicks = out.filter((_, i) => (i + 1) % 4 === 0).slice(0, 12); // page 1
    // heavier (lower-id) tail items should dominate early explore picks
    const fromMidBand = explorePicks.filter((x) => x.id >= 48 && x.id < 124).length;
    expect(fromMidBand).toBeGreaterThan(6);
  });

  test('zero/undefined weights do not crash the draw', () => {
    const out = weightedOrder([{ id: 1 }, { id: 2, w: 0 }], mulberry32(1), (x) => x.w);
    expect(out).toHaveLength(2);
  });
});

describe('age-stratified interleave — compose the page to a target distribution', () => {
  const now = Date.now();
  // 7 bands: <10h, 10h-7d, 7-30d, 30d-6mo, 6mo-1y, 1y-2y, >2y.
  const WEIGHTS = [0.16, 0.40, 0.22, 0.11, 0.06, 0.03, 0.02];
  const NB = WEIGHTS.length;
  // A representative age (days) for each band.
  const daysForBand = [0.2, 3, 20, 100, 280, 550, 1500];
  const makeList = (perBand) => {
    const out = [];
    for (let b = 0; b < NB; b++) {
      for (let k = 0; k < perBand; k++) {
        out.push({ id: `${b}-${k}`, band: b, created: new Date(now - daysForBand[b] * DAY) });
      }
    }
    // interleave the bands so the input isn't already grouped (proves the scheduler works)
    return out.sort((a, b) => (a.id < b.id ? -1 : 1));
  };

  const bandMix = (page) => {
    const c = new Array(NB).fill(0);
    for (const v of page) c[ageBandIndex(v.created, now)]++;
    return c.map((n) => n / page.length);
  };

  test('page 1 matches the target within a couple of percent', () => {
    const out = interleaveByAge(makeList(200), WEIGHTS, now);
    const mix = bandMix(out.slice(0, 48));
    WEIGHTS.forEach((target, b) => expect(Math.abs(mix[b] - target)).toBeLessThan(0.06));
  });

  test('the mix holds on a DEEP page too (pagination stays consistent)', () => {
    const out = interleaveByAge(makeList(200), WEIGHTS, now);
    const mix = bandMix(out.slice(144, 192)); // page 4
    WEIGHTS.forEach((target, b) => expect(Math.abs(mix[b] - target)).toBeLessThan(0.08));
  });

  test('every item appears exactly once', () => {
    const list = makeList(50);
    const out = interleaveByAge(list, WEIGHTS, now);
    expect(out).toHaveLength(list.length);
    expect(new Set(out.map((v) => v.id)).size).toBe(list.length);
  });

  test('within a band, score order (input order) is preserved — quality picks which', () => {
    const list = [
      { id: 'fresh-best', created: new Date(now - 1 * DAY) },
      { id: 'fresh-worst', created: new Date(now - 2 * DAY) },
      { id: 'old-best', created: new Date(now - 900 * DAY) },
      { id: 'old-worst', created: new Date(now - 901 * DAY) },
    ];
    const out = interleaveByAge(list, WEIGHTS, now);
    expect(out.indexOf(list[0])).toBeLessThan(out.indexOf(list[1])); // fresh-best before fresh-worst
    expect(out.indexOf(list[2])).toBeLessThan(out.indexOf(list[3])); // old-best before old-worst
  });

  test('a thin/empty band backfills from the others (no gaps, still exactly-once)', () => {
    // Only the fresher bands 0-4 have videos; 1y-2y and >2y are absent.
    const list = [];
    for (const b of [0, 1, 2, 3, 4]) for (let k = 0; k < 40; k++) {
      list.push({ id: `${b}-${k}`, created: new Date(now - daysForBand[b] * DAY) });
    }
    const out = interleaveByAge(list, WEIGHTS, now);
    expect(out).toHaveLength(list.length);
    // The absent bands' quota flows to the present bands, so the page skews fresher
    // rather than leaving holes. The highest-weight present band (10h-7d, 0.40) leads.
    const mix = bandMix(out.slice(0, 48));
    expect(mix[5]).toBe(0);
    expect(mix[6]).toBe(0);
    expect(mix[1]).toBeGreaterThanOrEqual(0.4);
    expect(mix[1]).toBeGreaterThan(mix[0]);
  });

  test('a zero-weight band still appears (exactly-once), just served last', () => {
    const w = [1, 0, 0, 0, 0, 0, 0]; // only the <10h band has weight
    const list = [
      { id: 'a', created: new Date(now - 5 * 3600 * 1000) }, // <10h → band 0 (weight 1)
      { id: 'b', created: new Date(now - 1500 * DAY) },       // >2y  → band 6 (weight 0)
    ];
    const out = interleaveByAge(list, w, now);
    expect(out.map((v) => v.id)).toEqual(['a', 'b']);
  });

  test('degenerate inputs pass through untouched', () => {
    expect(interleaveByAge([], WEIGHTS)).toEqual([]);
    const one = [{ id: 'x', created: new Date() }];
    expect(interleaveByAge(one, WEIGHTS)).toEqual(one);
  });
});

describe('ageBandIndex', () => {
  const now = Date.now();
  const HOUR = 3600 * 1000;
  test('boundaries land in the expected band (7 bands, <10h first)', () => {
    expect(ageBandIndex(new Date(now - 5 * HOUR), now)).toBe(0);   // <10h
    expect(ageBandIndex(new Date(now - 1 * DAY), now)).toBe(1);    // 10h-7d
    expect(ageBandIndex(new Date(now - 20 * DAY), now)).toBe(2);   // 7-30d
    expect(ageBandIndex(new Date(now - 100 * DAY), now)).toBe(3);  // 30d-6mo
    expect(ageBandIndex(new Date(now - 300 * DAY), now)).toBe(4);  // 6mo-1y
    expect(ageBandIndex(new Date(now - 600 * DAY), now)).toBe(5);  // 1y-2y
    expect(ageBandIndex(new Date(now - 2000 * DAY), now)).toBe(6); // >2y
  });
  test('an unknown/invalid date is treated as oldest', () => {
    expect(ageBandIndex(null, now)).toBe(6);
    expect(ageBandIndex(undefined, now)).toBe(6);
  });
});

describe('recencyBoost — a continuous "newer ranks higher" premium', () => {
  const { recencyBoost } = require('../utils/discoverScore');
  test('strongest brand-new, decaying SMOOTHLY with age (not a step)', () => {
    expect(recencyBoost(0)).toBeGreaterThan(recencyBoost(6));
    expect(recencyBoost(6)).toBeGreaterThan(recencyBoost(24));
    expect(recencyBoost(24)).toBeGreaterThan(recencyBoost(72));
    expect(recencyBoost(24)).not.toBe(recencyBoost(0));   // NOT flat — a 1-day video differs from brand-new
  });
  test('halves its EXTRA lift every half-life', () => {
    // recencyBoost = 1 + S·0.5^(hrs/H); the premium above 1 halves each half-life.
    const H = 18; // matches the default
    const p0 = recencyBoost(0, 2, H) - 1;
    const p1 = recencyBoost(H, 2, H) - 1;
    const p2 = recencyBoost(2 * H, 2, H) - 1;
    expect(p1).toBeCloseTo(p0 / 2, 5);
    expect(p2).toBeCloseTo(p0 / 4, 5);
  });
  test('fades toward ×1 for old content, never below 1', () => {
    expect(recencyBoost(7 * 24)).toBeLessThan(1.1);
    expect(recencyBoost(365 * 24)).toBeGreaterThanOrEqual(1);
  });
  test('lifts a recent video over an engaged older one on base', () => {
    // recent, no engagement: freshness × recencyBoost
    const recent = freshness(4) * recencyBoost(4);
    // 3-day-old with strong curation + retention
    const older = freshness(3 * 24) * recencyBoost(3 * 24) * 2 * 1.5;
    expect(recent).toBeGreaterThan(older);
  });
  test('non-finite / disabled → neutral', () => {
    expect(recencyBoost(Infinity)).toBe(1);
    expect(recencyBoost(5, 0)).toBe(1);      // strength 0 = off
    expect(recencyBoost(5, 2, 0)).toBe(1);   // half-life 0 = off
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
