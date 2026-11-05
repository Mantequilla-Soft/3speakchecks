/**
 * A stand-in for utils/hive.js for the feed tests.
 *
 * The feeds read Hive for following lists, post rewards, live vote counts and
 * follower counts. None of that may touch the network, and all of it should be
 * set per test, so this module answers from plain in-memory maps:
 *
 *   jest.mock('../../utils/hive', () => require('./_hiveMock').create());
 *   const hive = require('../../utils/hive');
 *   hive.__state.following.set('alice', ['bob']);
 *
 * Kept free of app requires (apart from the real module's pure helpers) so the
 * jest.mock factory cannot run into a circular load.
 *
 * The functions are plain async functions, not jest.fn(), because the suite runs
 * with restoreMocks and must not lose an implementation between tests. Calls are
 * recorded in __state.calls instead.
 */
function create() {
  const actual = jest.requireActual('../../utils/hive');
  const state = {
    following: new Map(),   // username -> [followed usernames]
    rewards: new Map(),     // "author/permlink" -> { reward, title, body, tags, sound }
    live: new Map(),        // "author/permlink" -> { reward, votes, comments, author_reputation }
    followers: new Map(),   // username -> follower count
    rpc: [],                // queued hiveRpcBatch answers, one array per call
    failFollowing: false,
    calls: [],
  };
  const keyOf = (ap) => `${ap.author}/${ap.permlink}`;
  const pick = (map, aps) => {
    const out = new Map();
    for (const ap of aps || []) if (map.has(keyOf(ap))) out.set(keyOf(ap), map.get(keyOf(ap)));
    return out;
  };

  return {
    mulberry32: actual.mulberry32,
    hiveReputationToScore: actual.hiveReputationToScore,
    reputationCache: new Map(),
    __state: state,
    __reset() {
      state.following.clear();
      state.rewards.clear();
      state.live.clear();
      state.followers.clear();
      state.rpc.length = 0;
      state.calls.length = 0;
      state.failFollowing = false;
      this.reputationCache.clear();
    },
    async getFollowingList(username) {
      state.calls.push(['getFollowingList', username]);
      if (state.failFollowing) throw new Error('hive down');
      return state.following.get(String(username || '').toLowerCase()) || [];
    },
    async fetchHiveRewards(aps) {
      state.calls.push(['fetchHiveRewards', aps.length]);
      return pick(state.rewards, aps);
    },
    async fetchLivePageData(aps) {
      state.calls.push(['fetchLivePageData', aps.length]);
      return pick(state.live, aps);
    },
    async fetchFollowerCounts(names) {
      state.calls.push(['fetchFollowerCounts', names]);
      return new Map((names || []).filter((n) => state.followers.has(n)).map((n) => [n, state.followers.get(n)]));
    },
    async hiveRpcBatch(requests) {
      state.calls.push(['hiveRpcBatch', requests]);
      const next = state.rpc.shift();
      if (next instanceof Error) throw next;
      return next || [];
    },
  };
}

module.exports = { create };
