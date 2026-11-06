/**
 * utils/feedAge.js: the global age bound for every feed (FEED_MAX_AGE_YEARS,
 * default 6) and the tighter one for recommendation feeds (RECOMMEND_MAX_AGE_DAYS,
 * default 365). Both are read when the module loads, so each configuration gets a
 * fresh copy of the module.
 */
const F = require('./_fixtures');

/** utils/feedAge loaded with this environment. */
function loadWith(env) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  const set = (vars) => {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
  set(env);
  let mod;
  jest.isolateModules(() => { mod = require('../../utils/feedAge'); });
  set(saved);
  return mod;
}

beforeEach(() => F.pinClock());
afterEach(() => jest.useRealTimers());

describe('the defaults', () => {
  const age = loadWith({ FEED_MAX_AGE_YEARS: undefined, RECOMMEND_MAX_AGE_DAYS: undefined });

  test('feeds stop six years back, recommendations one year back', () => {
    expect(age.FEED_MAX_AGE_YEARS).toBe(6);
    expect(age.feedAgeCutoff().toISOString()).toBe('2020-11-01T12:00:00.000Z');
    expect(age.recommendAgeCutoff().toISOString()).toBe(F.daysAgo(365).toISOString());
  });

  test('the match helpers target the field each collection uses', () => {
    expect(age.feedAgeMatch()).toEqual({ created: { $gte: age.feedAgeCutoff() } });
    expect(age.feedAgeMatch('createdAt')).toEqual({ createdAt: { $gte: age.feedAgeCutoff() } });
    expect(age.recommendAgeMatch('created')).toEqual({ created: { $gte: age.recommendAgeCutoff() } });
  });

  test.each([
    ['inside the window', () => F.daysAgo(100), true],
    ['older than six years', () => F.daysAgo(7 * 365), false],
    ['undated (kept)', () => undefined, true],
    ['an unparsable date (kept)', () => 'not a date', true],
  ])('withinFeedAge: %s', (_label, created, expected) => {
    expect(age.withinFeedAge(created())).toBe(expected);
  });

  test('the cutoff rolls with the clock instead of freezing at load time', () => {
    const before = age.feedAgeCutoff();
    F.advanceClock(F.DAY);
    expect(age.feedAgeCutoff() - before).toBe(F.DAY);
  });
});

describe('FEED_MAX_AGE_YEARS <= 0 disables the global bound', () => {
  const age = loadWith({ FEED_MAX_AGE_YEARS: '0', RECOMMEND_MAX_AGE_DAYS: '0' });

  test('no cutoff, an empty match, every date kept', () => {
    expect(age.feedAgeCutoff()).toBeNull();
    expect(age.feedAgeMatch()).toEqual({});
    expect(age.withinFeedAge(F.daysAgo(10000))).toBe(true);
    expect(age.recommendAgeCutoff()).toBeNull();
    expect(age.recommendAgeMatch()).toEqual({});
  });
});

describe('the stricter of the two bounds always wins', () => {
  test('a global bound tighter than the recommendation one is used for recommendations too', () => {
    const age = loadWith({ FEED_MAX_AGE_YEARS: '0.5', RECOMMEND_MAX_AGE_DAYS: '365' });
    expect(age.recommendAgeCutoff()).toEqual(age.feedAgeCutoff());
  });

  test('RECOMMEND_MAX_AGE_DAYS <= 0 leaves only the global bound', () => {
    const age = loadWith({ FEED_MAX_AGE_YEARS: '6', RECOMMEND_MAX_AGE_DAYS: '-1' });
    expect(age.recommendAgeCutoff()).toEqual(age.feedAgeCutoff());
  });
});
