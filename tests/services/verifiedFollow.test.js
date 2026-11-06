/**
 * Verified-badge follow sweep: the badge account follows exactly the verified
 * creators, and only ever unfollows the accounts it followed itself (the ledger).
 *
 * The chain is the fake from helpers/hive (get_following answered from an
 * in-memory list); broadcasts are captured on dhive's BroadcastAPI and applied to
 * that list, so a second sweep sees what the first one did. The key is a
 * throwaway derived from a test seed. The ledger is the real test MongoDB.
 */
const dhive = require('@hiveio/dhive');

const BADGE = 'badge-181335';
process.env.VERIFIED_BADGE_ACCOUNT = BADGE.toUpperCase(); // normalised by the worker
process.env.VERIFIED_BADGE_POSTING_KEY = dhive.PrivateKey.fromSeed('checker-tests:badge').toString();
process.env.VERIFIED_FOLLOW_MIN_EXPECTED = '3';
process.env.VERIFIED_FOLLOW_MAX_PER_RUN = '7';
process.env.VERIFIED_UNFOLLOW_MAX_PER_RUN = '2';
process.env.VERIFIED_FOLLOW_EXCLUDED = 'Naughty, other-excluded';

const { BroadcastAPI } = require('@hiveio/dhive/lib/helpers/broadcast');
const testDb = require('../helpers/db');
const { fakeHiveChain } = require('../helpers/hive');
const vf = require('../../services/verifiedFollow');
const { NOW, DAY, ago } = require('./_fixtures');

const db = testDb.use();
const ledger = () => db().collection('verified-badge-follows');
const creators = () => db().collection('contentcreators');

const ONLY_DATE = ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame',
  'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate',
  'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'];

// The worker paces itself (4.5s between transactions, 1.5s empty-list retries,
// 3s x attempt backoff). Those exact pauses fire at once and are recorded.
let delays;
function skipDelays(...wanted) {
  const realSetTimeout = global.setTimeout;
  delays = [];
  jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms, ...args) => {
    if (wanted.includes(ms)) { delays.push(ms); return realSetTimeout(fn, 0, ...args); }
    return realSetTimeout(fn, ms, ...args);
  });
}

// The badge account's following list on the fake chain, and every transaction.
let following;
let txs;
let followingCalls;
let broadcastImpl;
function chain({ followingPages } = {}) {
  followingCalls = [];
  fakeHiveChain([], {
    'condenser_api.get_following': ([account, start, type, limit]) => {
      followingCalls.push({ account, start, type, limit });
      if (followingPages) return followingPages(followingCalls.length, start);
      const names = [...following].sort().filter((n) => n >= start).slice(0, limit);
      return names.map((n) => ({ follower: account, following: n, what: ['blog'] }));
    },
  });
  txs = [];
  broadcastImpl = null;
  jest.spyOn(BroadcastAPI.prototype, 'sendOperations').mockImplementation(async (ops) => {
    if (broadcastImpl) await broadcastImpl(ops, txs.length + 1);
    const decoded = ops.map(([type, op]) => ({ type, ...op, json: JSON.parse(op.json) }));
    txs.push(decoded);
    for (const { json: [, f] } of decoded) {
      if (f.what.length) following.add(f.following); else following.delete(f.following);
    }
    return { id: `tx${txs.length}` };
  });
}
const followed = () => txs.flat().filter((o) => o.json[1].what.length).map((o) => o.json[1].following);
const unfollowed = () => txs.flat().filter((o) => !o.json[1].what.length).map((o) => o.json[1].following);
const verify = (...names) => creators().insertMany(names.map((username) => ({ username, verified: true })));
const own = (username, extra = {}) => ledger().insertOne({ account: BADGE, username, unfollowedAt: null, source: 'auto', followedAt: ago(10 * DAY), ...extra });

beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ONLY_DATE });
  skipDelays(1500, 3000, 4500, 6000, 9000);
  following = new Set();
  chain();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.useRealTimers());

describe('following verified creators', () => {
  test('follows the ones not yet followed, five ops per transaction, paced between transactions', async () => {
    await verify('c1', 'c2', 'c3', 'c4', 'c5', 'c6');

    const res = await vf.runFollowSweep();

    expect(res).toEqual({ verified: 6, followed: 6, unfollowed: 0, pending: 0 });
    expect(txs.map((t) => t.length)).toEqual([5, 1]);
    expect(txs[0][0]).toEqual({
      type: 'custom_json', required_auths: [], required_posting_auths: [BADGE], id: 'follow',
      json: ['follow', { follower: BADGE, following: 'c1', what: ['blog'] }],
    });
    expect(delays.filter((d) => d === 4500)).toHaveLength(1); // between the two, not after the last
    const rows = await ledger().find({}, { projection: { _id: 0 } }).sort({ username: 1 }).toArray();
    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual({ account: BADGE, username: 'c1', unfollowedAt: null, source: 'auto', followedAt: NOW });
  });

  test('banned, hidden, excluded and the badge account itself are never followed; names are normalised', async () => {
    await creators().insertMany([
      { username: ' C1 ', verified: true },
      { username: 'c1', verified: true },
      { username: 'c2', verified: true },
      { username: 'c3', verified: true },
      { username: 'banned1', verified: true, banned: true },
      { username: 'hidden1', verified: true, hidden: true },
      { username: 'naughty', verified: true },
      { username: BADGE, verified: true },
      { username: 'plain', verified: false },
    ]);

    expect([...await vf.getVerifiedCreators()].sort()).toEqual(['c1', 'c2', 'c3']);
    await vf.runFollowSweep();
    expect(followed().sort()).toEqual(['c1', 'c2', 'c3']);
  });

  test('at most VERIFIED_FOLLOW_MAX_PER_RUN follows per sweep; the rest follow on the next one', async () => {
    await verify(...Array.from({ length: 10 }, (_, i) => `c${String(i).padStart(2, '0')}`));

    const first = await vf.runFollowSweep();
    expect(first).toMatchObject({ followed: 7, pending: 3 });

    const second = await vf.runFollowSweep();
    expect(second).toMatchObject({ followed: 3, pending: 0 });
    expect(await ledger().countDocuments({ unfollowedAt: null })).toBe(10);
  });

  test('a sweep with nothing to do broadcasts nothing and leaves the ledger as it was', async () => {
    await verify('c1', 'c2', 'c3');
    await vf.runFollowSweep();
    const before = await ledger().find({}).sort({ username: 1 }).toArray();
    const txCount = txs.length;

    const res = await vf.runFollowSweep();

    expect(res).toEqual({ verified: 3, followed: 0, unfollowed: 0, pending: 0 });
    expect(txs).toHaveLength(txCount);
    expect(await ledger().find({}).sort({ username: 1 }).toArray()).toEqual(before);
  });
});

describe('adoption of follows made elsewhere', () => {
  test('an account already followed and verified is adopted into the ledger with no transaction', async () => {
    following = new Set(['c1', 'c2', 'stranger']);
    await verify('c1', 'c2', 'c3');

    await vf.runFollowSweep();

    expect(followed()).toEqual(['c3']);
    expect(await ledger().findOne({ username: 'c1' })).toMatchObject({ source: 'adopted', unfollowedAt: null });
    expect(await ledger().findOne({ username: 'stranger' })).toBeNull();
  });

  test('re-owning a row keeps its original followedAt', async () => {
    following = new Set(['c1']);
    await own('c1', { unfollowedAt: ago(DAY), followedAt: ago(30 * DAY) });
    await verify('c1', 'c2', 'c3');

    await vf.runFollowSweep();

    expect(await ledger().findOne({ username: 'c1' })).toMatchObject({ unfollowedAt: null, source: 'adopted', followedAt: ago(30 * DAY) });
  });
});

describe('unfollowing', () => {
  test('an account we badged that lost verified is unfollowed and its row closed', async () => {
    following = new Set(['c1', 'c2', 'c3', 'lost']);
    await own('lost');
    await verify('c1', 'c2', 'c3');

    const res = await vf.runFollowSweep();

    expect(res).toMatchObject({ unfollowed: 1 });
    expect(txs[0][0].json).toEqual(['follow', { follower: BADGE, following: 'lost', what: [] }]);
    expect(await ledger().findOne({ username: 'lost' })).toMatchObject({ unfollowedAt: NOW, unfollowReason: 'unverified' });
  });

  test('a follow somebody else made is never removed, verified or not', async () => {
    following = new Set(['c1', 'c2', 'c3', 'by-hand']);
    await verify('c1', 'c2', 'c3');

    await vf.runFollowSweep();

    expect(unfollowed()).toEqual([]);
    expect(following.has('by-hand')).toBe(true);
  });

  test('an excluded creator we badged earlier loses the badge even while verified', async () => {
    following = new Set(['c1', 'c2', 'c3', 'naughty']);
    await own('naughty');
    await verify('c1', 'c2', 'c3', 'naughty');

    await vf.runFollowSweep();

    expect(unfollowed()).toEqual(['naughty']);
  });

  test('a ledger row whose follow was already removed by hand is closed without a transaction', async () => {
    following = new Set(['c1', 'c2', 'c3']);
    await own('gone-by-hand');
    await verify('c1', 'c2', 'c3');

    await vf.runFollowSweep();

    expect(txs).toHaveLength(0);
    expect(await ledger().findOne({ username: 'gone-by-hand' })).toMatchObject({ unfollowedAt: NOW, unfollowReason: 'manual' });
  });

  test('at most VERIFIED_UNFOLLOW_MAX_PER_RUN unfollows per sweep', async () => {
    following = new Set(['c1', 'c2', 'c3', 'x1', 'x2', 'x3']);
    await Promise.all(['x1', 'x2', 'x3'].map((n) => own(n)));
    await verify('c1', 'c2', 'c3');

    const res = await vf.runFollowSweep();

    expect(res).toMatchObject({ unfollowed: 2, pending: 1 });
    expect(unfollowed()).toEqual(['x1', 'x2']);
    expect(await ledger().findOne({ username: 'x3' })).toMatchObject({ unfollowedAt: null });
  });
});

describe('when in doubt, broadcast nothing', () => {
  test('fewer verified creators than the sanity floor: no chain read, no transaction, no ledger change', async () => {
    following = new Set(['x1']);
    await own('x1');
    await verify('c1', 'c2');

    const res = await vf.runFollowSweep();

    expect(res).toEqual({ error: 'verified set below sanity floor', verified: 2 });
    expect(followingCalls).toHaveLength(0);
    expect(txs).toHaveLength(0);
    expect(await ledger().findOne({ username: 'x1' })).toMatchObject({ unfollowedAt: null });
  });

  test('a following list that cannot be read skips the sweep', async () => {
    chain({ followingPages: () => { throw new Error('503 Service Unavailable'); } });
    await verify('c1', 'c2', 'c3');

    const res = await vf.runFollowSweep();

    expect(res).toEqual({ error: '503 Service Unavailable' });
    expect(txs).toHaveLength(0);
  });

  test('an empty first page is asked again: a lagging node does not cause a re-follow of everyone', async () => {
    const real = ['c1', 'c2', 'c3'].map((n) => ({ follower: BADGE, following: n, what: ['blog'] }));
    chain({ followingPages: (call) => (call < 3 ? [] : real) });
    await verify('c1', 'c2', 'c3');

    await vf.runFollowSweep();

    expect(followingCalls).toHaveLength(3);
    expect(delays.filter((d) => d === 1500)).toHaveLength(2);
    expect(txs).toHaveLength(0);
  });

  test('two sweeps at once: the second is skipped', async () => {
    await verify('c1', 'c2', 'c3');
    const [a, b] = await Promise.all([vf.runFollowSweep(), vf.runFollowSweep()]);
    expect([a, b]).toContainEqual({ skipped: true });
    expect(followed().sort()).toEqual(['c1', 'c2', 'c3']);
  });
});

describe('broadcast failures', () => {
  test('a per-block collision is retried with a growing backoff and then succeeds', async () => {
    let attempts = 0;
    broadcastImpl = async () => {
      attempts++;
      if (attempts <= 2) throw new Error('already submitted 5 custom json operation(s) this block');
    };
    await verify('c1', 'c2', 'c3');

    const res = await vf.runFollowSweep();

    expect(res).toMatchObject({ followed: 3 });
    // The 1.5s empty-list retries happen too (nobody is followed yet); only the backoff is checked.
    expect(delays.filter((d) => d % 3000 === 0)).toEqual([3000, 6000]);
  });

  test('a non-transient error stops the run; only what made it on chain enters the ledger', async () => {
    broadcastImpl = async (_ops, n) => { if (n === 2) throw new Error('missing required posting authority'); };
    await verify(...Array.from({ length: 7 }, (_, i) => `c${i}`));

    const res = await vf.runFollowSweep();

    expect(res).toMatchObject({ followed: 5, pending: 2 });
    expect(await ledger().countDocuments()).toBe(5);
    expect(await ledger().findOne({ username: 'c6' })).toBeNull();
  });

  test('a transient error that outlasts the retries gives up after four attempts', async () => {
    let attempts = 0;
    broadcastImpl = async () => { attempts++; throw new Error('network timeout'); };
    await verify('c1', 'c2', 'c3');

    const res = await vf.runFollowSweep();

    expect(attempts).toBe(4);
    expect(res).toMatchObject({ followed: 0, pending: 3 });
    expect(await ledger().countDocuments()).toBe(0);
  });
});

describe('getFollowing', () => {
  test('pages through more than 1000 follows, advancing past the repeated start name', async () => {
    const names = Array.from({ length: 1500 }, (_, i) => `u${String(i).padStart(4, '0')}`);
    following = new Set(names.map((n) => n.toUpperCase()));
    chain();

    const all = await vf.getFollowing(BADGE);

    expect(all.size).toBe(1500);
    expect(all.has('u1499')).toBe(true); // lowercased
    expect(followingCalls.map((c) => c.start)).toEqual(['', 'U0999']);
  });

  test('a genuinely empty account stays empty after the retries', async () => {
    chain({ followingPages: () => null });
    expect((await vf.getFollowing(BADGE)).size).toBe(0);
    expect(followingCalls).toHaveLength(3);
  });
});

describe('getOwnedFollows', () => {
  test('only open rows of this badge account count', async () => {
    await own('mine');
    await own('closed', { unfollowedAt: ago(DAY) });
    await ledger().insertOne({ account: 'other-badge', username: 'theirs', unfollowedAt: null });
    expect([...await vf.getOwnedFollows()]).toEqual(['mine']);
  });
});

describe('configuration variants', () => {
  // A fresh copy of the module under other env, sharing this file's database and
  // the dhive instance the fake chain is installed on.
  function loadWith(env, dbModule = require('../../utils/db')) {
    const saved = {};
    for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
    let mod;
    jest.isolateModules(() => {
      jest.doMock('../../utils/db', () => dbModule);
      jest.doMock('@hiveio/dhive', () => dhive);
      mod = require('../../services/verifiedFollow');
    });
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    jest.dontMock('../../utils/db');
    jest.dontMock('@hiveio/dhive');
    return mod;
  }

  test('dry run: reports what it would do, broadcasts nothing and writes no ledger row', async () => {
    const dry = loadWith({ VERIFIED_FOLLOW_DRY_RUN: 'true' });
    following = new Set(['c1', 'lost']);
    await own('lost');
    await own('gone-by-hand');
    await verify('c1', 'c2', 'c3');

    const res = await dry.runFollowSweep();

    expect(res).toEqual({
      verified: 3, followed: 0, unfollowed: 0, wouldFollow: ['c2', 'c3'], wouldUnfollow: ['lost'], pending: 0, dryRun: true,
    });
    expect(txs).toHaveLength(0);
    expect(await ledger().findOne({ username: 'c1' })).toBeNull(); // not even adopted
    expect(await ledger().findOne({ username: 'gone-by-hand' })).toMatchObject({ unfollowedAt: null });
  });

  test('unfollow switched off: lost badges stay, follows still happen', async () => {
    const mod = loadWith({ VERIFIED_UNFOLLOW_ENABLED: 'false' });
    following = new Set(['lost']);
    await own('lost');
    await verify('c1', 'c2', 'c3');

    const res = await mod.runFollowSweep();

    expect(res).toMatchObject({ followed: 3, unfollowed: 0 });
    expect(following.has('lost')).toBe(true);
  });

  test('adoption switched off: existing follows are not taken into the ledger', async () => {
    const mod = loadWith({ VERIFIED_FOLLOW_ADOPT_EXISTING: 'false' });
    following = new Set(['c1']);
    await verify('c1', 'c2', 'c3');

    await mod.runFollowSweep();

    expect(await ledger().findOne({ username: 'c1' })).toBeNull();
  });

  test('ENABLE_MONGO_WRITES=false: broadcasts still go out but nothing is recorded', async () => {
    const mod = loadWith({ ENABLE_MONGO_WRITES: 'false' });
    await verify('c1', 'c2', 'c3');

    await mod.runFollowSweep();

    expect(followed()).toHaveLength(3);
    expect(await ledger().countDocuments()).toBe(0);
  });

  describe('schedule()', () => {
    function captureTimers() {
      const timers = [];
      jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms) => { timers.push({ kind: 'timeout', fn, ms }); return 0; });
      jest.spyOn(global, 'setInterval').mockImplementation((fn, ms) => { timers.push({ kind: 'interval', fn, ms }); return 0; });
      return timers;
    }

    test.each([
      ['switched off', { VERIFIED_FOLLOW_ENABLED: 'false' }],
      ['no badge account', { VERIFIED_BADGE_ACCOUNT: '' }],
      ['no posting key', { VERIFIED_BADGE_POSTING_KEY: '' }],
      ['a key that does not parse', { VERIFIED_BADGE_POSTING_KEY: 'garbage' }],
    ])('does not start when %s', (_label, env) => {
      const mod = loadWith(env);
      const timers = captureTimers();
      mod.schedule();
      expect(timers).toHaveLength(0);
    });

    test('first sweep after VERIFIED_FOLLOW_FIRST_RUN_MIN, then every VERIFIED_FOLLOW_INTERVAL_HOURS', async () => {
      // An in-memory database with no verified creators, so each tick stops at the
      // sanity floor and settles within the test.
      const reads = [];
      const coll = {
        createIndex: async () => {},
        find: (q) => { reads.push(q); return { toArray: async () => [] }; },
      };
      const mod = loadWith(
        { VERIFIED_FOLLOW_FIRST_RUN_MIN: '2', VERIFIED_FOLLOW_INTERVAL_HOURS: '0.01', ENABLE_MONGO_WRITES: 'false' },
        { getDb: () => ({ collection: () => coll }) },
      );
      const timers = captureTimers();
      const settle = () => new Promise((resolve) => setImmediate(resolve));

      mod.schedule();
      expect(timers).toEqual([expect.objectContaining({ kind: 'timeout', ms: 2 * 60 * 1000 })]);
      expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/unfollow is inert/));

      timers[0].fn();
      await settle();
      expect(timers[1]).toEqual(expect.objectContaining({ kind: 'interval', ms: 5 * 60 * 1000 })); // floored at 5 min
      expect(reads).toHaveLength(1);
      timers[1].fn();
      await settle();
      expect(reads).toHaveLength(2);
      expect(txs).toHaveLength(0);
    });
  });
});
