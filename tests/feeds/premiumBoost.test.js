/**
 * utils/premiumBoost.js: videos by current Pro subscribers (embed-users
 * `premium: true`) rank higher in every discovery feed. Off unless PREMIUM_BOOST
 * is above 1 (prod sets 1.5); debug accounts on PREMIUM_BOOST_BLACKLIST never
 * count. The set is global, cached, and never awaited on the request path.
 */
process.env.PREMIUM_BOOST = '1.5';
process.env.PREMIUM_BOOST_BLACKLIST = 'debugger, TESTER';

const testDb = require('../helpers/db');
const F = require('./_fixtures');
const { getPremiumSet, applyPremiumBoost, invalidate } = require('../../utils/premiumBoost');
const { PREMIUM_BOOST_TTL_MS } = require('../../utils/config');

const db = testDb.use();
const users = () => db().collection('embed-users');

beforeEach(() => {
  F.pinClock();
  invalidate();
});
afterEach(() => jest.useRealTimers());

describe('getPremiumSet', () => {
  test('a cold miss is "no boost" for this request and warms the set behind it', async () => {
    await users().insertMany([
      { username: 'Pro1', premium: true },
      { username: '@pro2', premium: true },
      { username: 'debugger', premium: true },
      { username: 'tester', premium: true },
      { username: 'lapsed', premium: false },
    ]);

    expect(getPremiumSet(db())).toBeNull();
    await F.waitFor(() => getPremiumSet(null) !== null);

    expect([...getPremiumSet(db())].sort()).toEqual(['pro1', 'pro2']);
  });

  test('a stale set is served while it refreshes; a failed refresh keeps it', async () => {
    await users().insertOne({ username: 'pro1', premium: true });
    getPremiumSet(db());
    await F.waitFor(() => getPremiumSet(null) !== null);

    await users().insertOne({ username: 'pro2', premium: true });
    F.advanceClock(PREMIUM_BOOST_TTL_MS);
    const broken = { collection: () => ({ find: () => ({ toArray: async () => { throw new Error('down'); } }) }) };
    expect([...getPremiumSet(broken)]).toEqual(['pro1']);
    await F.flushPromises();
    expect([...getPremiumSet(broken)]).toEqual(['pro1']);      // still the old set, no throw

    await F.flushPromises();                                    // let that second failed refresh finish
    expect([...getPremiumSet(db())]).toEqual(['pro1']);       // stale, and a real refresh starts
    await F.waitFor(() => getPremiumSet(db()).size === 2);    // later requests see the refreshed set
    expect([...getPremiumSet(null)].sort()).toEqual(['pro1', 'pro2']);
  });

  test('without a db handle it only reads the cache', () => {
    expect(getPremiumSet(null)).toBeNull();
  });
});

describe('applyPremiumBoost', () => {
  test('multiplies a Pro creator\'s videos by PREMIUM_BOOST, matched on the Hive author', () => {
    const videos = [
      { author: 'PRO1', owner: 'uploader', s: 10 },
      { owner: 'free', s: 10 },
    ];
    expect(applyPremiumBoost(videos, new Set(['pro1']), { scoreField: 's' })).toBe(1);
    expect(videos.map((v) => [v.s, !!v.premium_match])).toEqual([[15, true], [10, false]]);
  });

  test.each([
    ['no set', null, {}],
    ['an empty set', new Set(), {}],
    ['a multiplier of 1', new Set(['pro1']), { mult: 1 }],
  ])('no-op with %s', (_label, premiumSet, opts) => {
    const videos = [{ author: 'pro1', trending_score: 10 }];
    expect(applyPremiumBoost(videos, premiumSet, opts)).toBe(0);
    expect(videos[0].trending_score).toBe(10);
  });
});

describe('PREMIUM_BOOST=1 (the default)', () => {
  test('is off and never even queries Mongo', () => {
    process.env.PREMIUM_BOOST = '1';
    let off;
    jest.isolateModules(() => { off = require('../../utils/premiumBoost'); });
    process.env.PREMIUM_BOOST = '1.5';
    const neverCalled = { collection: () => { throw new Error('should not be called'); } };
    expect(off.getPremiumSet(neverCalled)).toBeNull();
    expect(off.applyPremiumBoost([{ author: 'pro1', trending_score: 1 }], new Set(['pro1']))).toBe(0);
  });
});
