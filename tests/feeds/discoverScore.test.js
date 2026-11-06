/**
 * utils/discoverScore.js, the parts tests/ranking.test.js does not already pin:
 * the fresh-upload taper, the seeded jitter and shuffle, the legacy (uniform)
 * exploration interleave, the interest-share composer and the edge cases of
 * every composer. Pure functions, no database.
 */
const {
  ageHours, freshness, newBoost, jitter, shuffle, weightedOrder,
  interleaveExploration, interleaveByAge, interleaveByInterest, ageBandIndex, clamp, AGE_BAND_DAYS,
} = require('../../utils/discoverScore');
const { mulberry32 } = jest.requireActual('../../utils/hive');
const F = require('./_fixtures');

const range = (n) => Array.from({ length: n }, (_, i) => i);

describe('ageHours and ageBandIndex', () => {
  const now = F.NOW.getTime();

  test('hours since creation, never negative; unknown dates are infinitely old', () => {
    expect(ageHours(new Date(now - 3 * F.HOUR), now)).toBe(3);
    expect(ageHours(new Date(now + F.HOUR).toISOString(), now)).toBe(0);
    expect(ageHours('garbage', now)).toBe(Infinity);
  });

  test('a string date lands in the same band as the Date', () => {
    const d = new Date(now - 20 * F.DAY);
    expect(ageBandIndex(d.toISOString(), now)).toBe(ageBandIndex(d, now));
    expect(ageBandIndex(undefined, now)).toBe(AGE_BAND_DAYS.length - 1);
  });
});

describe('freshness edge cases', () => {
  test('an unknown age gets the ANCIENT floor, not the full one', () => {
    expect(freshness(Infinity)).toBeCloseTo(freshness(24 * 365 * 50), 10);
  });

  test('with the year tail switched off, the floor is flat', () => {
    expect(freshness(24 * 365 * 5, 72, 0.4, 0)).toBe(0.4);
  });
});

describe('newBoost: a gentle lift for the first hours that tapers, never a cliff', () => {
  test.each([
    [0, 1.15],
    [6, 1.075],
    [12, 1],
    [48, 1],
  ])('at %ih old: x%f', (hrs, expected) => {
    expect(newBoost(hrs, 12, 1.15)).toBeCloseTo(expected, 10);
  });

  test('unknown age or no grace window: neutral', () => {
    expect(newBoost(Infinity)).toBe(1);
    expect(newBoost(1, 0)).toBe(1);
  });
});

describe('seeded randomness', () => {
  test('jitter stays within +/- the amount', () => {
    expect(jitter(0, 0.15)).toBeCloseTo(0.85);
    expect(jitter(1, 0.15)).toBeCloseTo(1.15);
    expect(jitter(0.5, 0.15)).toBe(1);
  });

  test('shuffle is a permutation, deterministic for a seed, and leaves its input alone', () => {
    const input = range(20);
    const a = shuffle(input, mulberry32(7));
    expect(a).not.toBe(input);
    expect(input).toEqual(range(20));
    expect([...a].sort((x, y) => x - y)).toEqual(range(20));
    expect(shuffle(input, mulberry32(7))).toEqual(a);
    expect(shuffle(input, mulberry32(8))).not.toEqual(a);
  });

  test('weightedOrder emits every item exactly once; a non-numeric weight is treated as ~0', () => {
    const items = ['a', 'b', 'c', 'd'];
    const out = weightedOrder(items, mulberry32(1), (x) => (x === 'b' ? 'oops' : 1));
    expect([...out].sort()).toEqual(items);
  });

  test('clamp', () => {
    expect([clamp(-1, 0, 1), clamp(0.5, 0, 1), clamp(2, 0, 1)]).toEqual([0, 0.5, 1]);
  });
});

describe('interleaveExploration without weights (uniform draw from the lower half)', () => {
  test('every 4th slot is taken from the shuffled lower half; head order is kept', () => {
    const ranked = range(12);
    const out = interleaveExploration(ranked, mulberry32(3), { every: 4 });
    expect([...out].sort((a, b) => a - b)).toEqual(ranked);
    const exploreSlots = [3, 7, 11].map((i) => out[i]);
    expect(exploreSlots.every((x) => x >= 6)).toBe(true);
    const head = out.filter((x) => x < 6);
    expect(head).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test.each([
    ['fewer than four items', range(3), { every: 4 }],
    ['every < 2', range(10), { every: 1 }],
  ])('returns the input unchanged for %s', (_label, ranked, opts) => {
    expect(interleaveExploration(ranked, mulberry32(1), opts)).toBe(ranked);
  });

  test('a non-array is returned as is', () => {
    expect(interleaveExploration(null, mulberry32(1))).toBeNull();
  });
});

describe('interleaveByInterest: a guaranteed share of every prefix', () => {
  const isMatch = (e) => e.m;
  const list = (pattern) => pattern.split('').map((c, i) => ({ id: i, m: c === 'm' }));

  test('at share 0.5, matches alternate from the very first slot, each stream keeping its order', () => {
    const out = interleaveByInterest(list('rrrrmmmm'), 0.5, isMatch);
    expect(out.map((e) => (e.m ? 'm' : 'r')).join('')).toBe('mrmrmrmr');
    expect(out.filter(isMatch).map((e) => e.id)).toEqual([4, 5, 6, 7]);
  });

  test('when one stream runs dry the other fills the rest', () => {
    const out = interleaveByInterest(list('rrrrrrm'), 0.65, isMatch);
    expect(out.map((e) => (e.m ? 'm' : 'r')).join('')).toBe('mrrrrrr');
    const outMatches = interleaveByInterest(list('mmmmmr'), 0.65, isMatch);
    expect(outMatches).toHaveLength(6);
    expect(outMatches[outMatches.length - 1].m).toBe(true);
  });

  test.each([
    ['share 0', 0],
    ['share >= 1', 1],
    ['a non-numeric share', 'x'],
  ])('%s leaves the order alone', (_label, share) => {
    const ranked = list('rmrm');
    expect(interleaveByInterest(ranked, share, isMatch)).toBe(ranked);
  });

  test('all matches, no matches, or a single item: unchanged', () => {
    for (const p of ['mmm', 'rrr', 'm']) {
      const ranked = list(p);
      expect(interleaveByInterest(ranked, 0.5, isMatch)).toBe(ranked);
    }
  });
});

describe('interleaveByAge edge cases', () => {
  const now = F.NOW.getTime();
  const at = (days) => ({ created: new Date(now - days * F.DAY) });

  test('no weights, or fewer than two items: unchanged', () => {
    const ranked = [at(1), at(100)];
    expect(interleaveByAge(ranked, [], now)).toBe(ranked);
    expect(interleaveByAge([at(1)], [1, 1], now)).toEqual([at(1)]);
  });

  test('fewer weights than bands: the oldest videos share the last weight, nobody is dropped', () => {
    const ranked = [at(1000), at(0.1), at(3), at(400)];
    const out = interleaveByAge(ranked, [1, 1], now);
    expect(out).toHaveLength(4);
    expect(new Set(out)).toEqual(new Set(ranked));
  });

  test('a band with weight 0 still appears, after every weighted band', () => {
    const ranked = [at(1000), at(1000), at(3), at(3)];
    const out = interleaveByAge(ranked, [0, 1, 0, 0, 0, 0, 0], now);
    expect(out.map((v) => Math.round((now - v.created) / F.DAY))).toEqual([3, 3, 1000, 1000]);
  });
});
