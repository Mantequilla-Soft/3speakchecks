/**
 * A creator never sees, and so never earns from, an ad on their own video
 * (utils/adEligibility.js adDecision).
 *
 * They are the one viewer guaranteed to replay a video over and over, and every
 * replay used to be an impression the advertiser paid for and the creator earned
 * from. Ports scripts/test-ad-self-view, on this worker's throwaway database.
 */
const testDb = require('../helpers/db');

testDb.use();

/** A fresh copy of the module (it caches the premium set), under `env`. */
function load(env = {}) {
  const all = { ADS_ALLOWED_OWNERS: '', AD_SELF_VIEW_ALLOWED_ACCOUNTS: '', ...env };
  const saved = {};
  for (const [k, v] of Object.entries(all)) { saved[k] = process.env[k]; process.env[k] = v; }
  let mod;
  const connected = require('../../utils/db');
  jest.isolateModules(() => {
    jest.doMock('../../utils/db', () => ({ getDb: () => connected.getDb() }));
    mod = require('../../utils/adEligibility');
    jest.dontMock('../../utils/db');
  });
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return mod;
}

test.each([
  ['the author themselves', 'creator'],
  ['the author in capitals', 'CREATOR'],
  ['the author with a leading @', '@creator'],
])('%s gets no ad on their own video', async (_label, viewer) => {
  expect(await load().adDecision({ viewer, owner: 'creator', permlink: 'v' })).toEqual({ ads: false, reason: 'own_video' });
});

test.each([
  ['a different viewer', 'someone-else'],
  ['an anonymous viewer', null],
  ['an empty name', ''],
])('%s is not stopped by the self-view rule', async (_label, viewer) => {
  const decision = await load().adDecision({ viewer, owner: 'creator', permlink: 'v' });
  expect(decision.reason).not.toBe('own_video');
  // Decided on the normal path, not refused for want of a database.
  expect(decision.reason).not.toBe('unknown_premium_state');
});

test('an account listed in AD_SELF_VIEW_ALLOWED_ACCOUNTS may see ads on its own videos (for testing)', async () => {
  const decision = await load({ AD_SELF_VIEW_ALLOWED_ACCOUNTS: 'creator' }).adDecision({ viewer: 'creator', owner: 'creator', permlink: 'v' });
  expect(decision.reason).not.toBe('own_video');
});
