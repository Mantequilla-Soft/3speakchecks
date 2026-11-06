/**
 * Premium sync from Okinoko subscriptions (services/premiumSubsSync.js): who ends
 * up with embed-users.premium after a run, given recurring subs and one-time
 * passes from Hasura (stubbed fetch). Rows the sync does not own (manual grants,
 * other sources) must never be touched, and a Hasura outage must change nothing.
 */
const { Collection } = require('mongodb');
const testDb = require('../helpers/db');
const { NOW, HOUR, DAY, ago, ahead, fakeFetch } = require('./_fixtures');
const { syncPremiumFromSubs } = require('../../services/premiumSubsSync');

const db = testDb.use();
const users = () => db().collection('embed-users');
const HASURA = 'https://api.okinoko.io/hasura/v1/graphql';

const REAL_TIMERS = ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'];

/** Hasura answers: `subs` rows for the subscription query, `passes` rows for the one-time query. */
let subs;
let passes;
let realFetch;
function hasura(handler) {
  global.fetch = fakeFetch([[HASURA, handler]]);
}
const answer = (_url, init) => {
  const { query } = JSON.parse(init.body);
  return { body: { data: { rows: query.includes('oki_subs_subscription_current') ? subs : passes } } };
};

beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: REAL_TIMERS });
  subs = [];
  passes = [];
  realFetch = global.fetch;
  hasura(answer);
});
afterEach(() => {
  global.fetch = realFetch;
  jest.useRealTimers();
});

const sub = (who, extra = {}) => ({ subscriber: `hive:${who}`, offer_id: 5, status: 'active', next_billing_at: ahead(10 * DAY).toISOString(), ...extra });
const pass = (who, boughtAt) => ({ buyer: `hive:${who}`, offer_id: 4, indexer_ts: boughtAt.toISOString() });

describe('promoting', () => {
  test('a recurring subscriber becomes premium with no expiry; a new user row is created', async () => {
    subs = [sub('Alice')];

    const run = await syncPremiumFromSubs();

    expect(run).toEqual({ active: 1, promoted: 1, demoted: 0, expiredTrials: 0, errors: 0 });
    const row = await users().findOne({ username: 'alice' });
    expect(row).toMatchObject({ username: 'alice', premium: true, premium_source: 'subs', premium_synced_at: NOW, banned: false });
    expect(row).not.toHaveProperty('premium_expires_at');
  });

  test('a one-time pass grants premium until 24h after the latest purchase', async () => {
    passes = [pass('bob', ago(2 * HOUR)), pass('bob', ago(20 * HOUR))];

    await syncPremiumFromSubs();

    expect(await users().findOne({ username: 'bob' })).toMatchObject({
      premium: true, premium_source: 'subs', premium_expires_at: new Date(NOW - 2 * HOUR + DAY),
    });
  });

  test('asks Hasura for the configured offers and a cutoff of now minus the pass validity', async () => {
    await syncPremiumFromSubs();
    const bodies = global.fetch.calls.map((c) => JSON.parse(c.init.body).variables);
    expect(bodies).toEqual(expect.arrayContaining([
      { offerIds: [5] },
      { offerIds: [4], cutoff: ago(DAY).toISOString() },
    ]));
  });

  test('a recurring sub beats a pass, and upgrading clears the old pass expiry', async () => {
    await users().insertOne({ username: 'carol', premium: true, premium_source: 'subs', premium_expires_at: ahead(HOUR) });
    subs = [sub('carol')];
    passes = [pass('carol', ago(HOUR))];

    await syncPremiumFromSubs();

    const row = await users().findOne({ username: 'carol' });
    expect(row.premium).toBe(true);
    expect(row).not.toHaveProperty('premium_expires_at');
  });

  test('an existing user keeps their other fields, and is not un-banned', async () => {
    await users().insertOne({ username: 'dave', banned: true, upload_limit: 10 });
    subs = [sub('dave')];
    await syncPremiumFromSubs();
    expect(await users().findOne({ username: 'dave' })).toMatchObject({ banned: true, upload_limit: 10, premium: true });
  });

  test.each([
    ['a non-Hive subscriber', sub('x', { subscriber: 'evm:0xabc' })],
    ['an empty Hive name', sub('x', { subscriber: 'hive:' })],
    ['a subscription whose billing date has passed', sub('erin', { next_billing_at: ago(HOUR).toISOString() })],
  ])('ignores %s', async (_name, row) => {
    subs = [row];
    expect((await syncPremiumFromSubs()).active).toBe(0);
    expect(await users().countDocuments()).toBe(0);
  });

  test('a sub with no billing date counts as active; a pass with a junk timestamp does not', async () => {
    subs = [sub('frank', { next_billing_at: null })];
    passes = [{ buyer: 'hive:gina', indexer_ts: 'not a date' }, { buyer: 'evm:0x1', indexer_ts: NOW.toISOString() }];
    await syncPremiumFromSubs();
    expect(await users().distinct('username')).toEqual(['frank']);
  });

  test('running twice leaves the same rows (one per user, same fields)', async () => {
    subs = [sub('alice')];
    passes = [pass('bob', ago(HOUR))];
    await syncPremiumFromSubs();
    const first = await users().find({}, { projection: { _id: 0 } }).sort({ username: 1 }).toArray();
    await syncPremiumFromSubs();
    expect(await users().find({}, { projection: { _id: 0 } }).sort({ username: 1 }).toArray()).toEqual(first);
  });
});

describe('demoting', () => {
  test('a sync-managed user who is no longer active loses premium and the sync tags', async () => {
    await users().insertOne({ username: 'lapsed', premium: true, premium_source: 'subs', premium_expires_at: ago(HOUR) });

    const run = await syncPremiumFromSubs();

    expect(run.demoted).toBe(1);
    const row = await users().findOne({ username: 'lapsed' });
    expect(row).toMatchObject({ premium: false, premium_synced_at: NOW });
    expect(row).not.toHaveProperty('premium_source');
    expect(row).not.toHaveProperty('premium_expires_at');
  });

  test('manual grants and other sources are never demoted', async () => {
    await users().insertMany([
      { username: 'manual', premium: true },
      { username: 'partner', premium: true, premium_source: 'partner-deal' },
    ]);
    const run = await syncPremiumFromSubs();
    expect(run.demoted).toBe(0);
    expect(await users().countDocuments({ premium: true })).toBe(2);
  });

  test('other-source grants are left untouched by a subscription; a trial user who pays is taken over', async () => {
    await users().insertMany([
      { username: 'partner', premium: true, premium_source: 'partner-deal', premium_expires_at: ahead(DAY) },
      { username: 'trial', premium: true, premium_source: 'testing', premium_expires_at: ago(1000), testing_started: ago(DAY) },
      { username: 'former', premium: false },
    ]);
    subs = [sub('partner'), sub('trial'), sub('former')];

    const run = await syncPremiumFromSubs();

    expect(run).toMatchObject({ promoted: 2, expiredTrials: 0 });
    expect(await users().findOne({ username: 'partner' }, { projection: { _id: 0 } }))
      .toEqual({ username: 'partner', premium: true, premium_source: 'partner-deal', premium_expires_at: ahead(DAY) });
    const trial = await users().findOne({ username: 'trial' });
    expect(trial).toMatchObject({ premium: true, premium_source: 'subs', testing_started: ago(DAY) });
    expect(trial).not.toHaveProperty('premium_expires_at');
    expect(await users().findOne({ username: 'former' })).toMatchObject({ premium: true, premium_source: 'subs' });
  });

  test('an expired Pro trial is switched off but keeps testing_started; a running one stays', async () => {
    await users().insertMany([
      { username: 'trial-done', premium: true, premium_source: 'testing', premium_expires_at: ago(1000), testing_started: ago(DAY) },
      { username: 'trial-on', premium: true, premium_source: 'testing', premium_expires_at: ahead(HOUR), testing_started: ago(HOUR) },
    ]);

    const run = await syncPremiumFromSubs();

    expect(run.expiredTrials).toBe(1);
    const done = await users().findOne({ username: 'trial-done' });
    expect(done).toMatchObject({ premium: false, testing_started: ago(DAY) });
    expect(done).not.toHaveProperty('premium_source');
    expect((await users().findOne({ username: 'trial-on' })).premium).toBe(true);
  });

  test('a manually granted premium survives a subscription that later lapses', async () => {
    // Regression: the promote pass used to set premium_source: 'subs' on EVERY active
    // subscriber, including one whose premium was granted by hand (no source tag).
    // Once that user's subscription ended, the demote pass saw the 'subs' tag and
    // switched their manual premium off.
    await users().insertOne({ username: 'vip', premium: true });
    subs = [sub('vip')];
    await syncPremiumFromSubs();
    expect(await users().findOne({ username: 'vip' })).not.toHaveProperty('premium_source');

    subs = [];
    await syncPremiumFromSubs();

    expect((await users().findOne({ username: 'vip' })).premium).toBe(true);
  });
});

describe('when Hasura fails', () => {
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));

  test.each([
    ['an HTTP error', () => ({ status: 502, body: 'bad gateway' })],
    ['a GraphQL error', () => ({ body: { errors: [{ message: 'field not found' }] } })],
    ['a GraphQL error without a message', () => ({ body: { errors: [{}] } })],
    ['a network error', () => { throw new TypeError('fetch failed'); }],
  ])('%s changes nothing: nobody is demoted on a failed read', async (_name, handler) => {
    await users().insertOne({ username: 'alice', premium: true, premium_source: 'subs' });
    hasura(handler);

    expect(await syncPremiumFromSubs()).toEqual({ active: 0, promoted: 0, demoted: 0, errors: 1 });
    expect(await users().findOne({ username: 'alice' })).toMatchObject({ premium: true, premium_source: 'subs' });
  });

  test('an empty data object is read as nobody active', async () => {
    hasura(() => ({ body: {} }));
    expect(await syncPremiumFromSubs()).toMatchObject({ active: 0, errors: 0 });
  });
});

describe('when Mongo fails', () => {
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));

  test('a failed promote is counted and the run carries on', async () => {
    subs = [sub('alice'), sub('bob')];
    const real = Collection.prototype.updateOne;
    jest.spyOn(Collection.prototype, 'updateOne').mockImplementation(function (filter, ...rest) {
      if (filter.username === 'alice') return Promise.reject(new Error('write failed'));
      return real.call(this, filter, ...rest);
    });

    const run = await syncPremiumFromSubs();

    expect(run).toMatchObject({ active: 2, promoted: 1, errors: 1 });
    expect(await users().distinct('username')).toEqual(['bob']);
  });

  test('a failed stale-row scan stops before demoting anyone', async () => {
    await users().insertOne({ username: 'lapsed', premium: true, premium_source: 'subs' });
    jest.spyOn(Collection.prototype, 'find').mockImplementation(() => ({ toArray: async () => { throw new Error('read failed'); } }));
    expect(await syncPremiumFromSubs()).toEqual({ active: 0, promoted: 0, demoted: 0, errors: 1 });
    jest.restoreAllMocks();
    expect((await users().findOne({ username: 'lapsed' })).premium).toBe(true);
  });

  test('failed demote and trial sweeps are counted as errors', async () => {
    await users().insertOne({ username: 'lapsed', premium: true, premium_source: 'subs' });
    jest.spyOn(Collection.prototype, 'updateOne').mockRejectedValue(new Error('demote failed'));
    jest.spyOn(Collection.prototype, 'updateMany').mockRejectedValue(new Error('sweep failed'));
    expect(await syncPremiumFromSubs()).toMatchObject({ demoted: 0, expiredTrials: 0, errors: 2 });
  });
});
