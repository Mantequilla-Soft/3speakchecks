/**
 * Curator page (routes/curation.js): picks on 3Speak, curation rewards and the
 * "found it early" badge, from stand-in Hive history and a stand-in Mongo.
 */
jest.mock('../utils/db', () => ({ getDb: jest.fn() }));
jest.mock('../utils/hive', () => ({ historySince: jest.fn(), hiveRpcBatch: jest.fn() }));
jest.mock('../utils/hiddenCreators', () => ({ isHiddenSync: jest.fn((u) => u === 'hiddenone') }));
const express = require('express');
const request = require('supertest');
const { getDb } = require('../utils/db');
const { historySince, hiveRpcBatch } = require('../utils/hive');
const router = require('../routes/curation');
const { votesFrom, rewardsFrom, standing, cache } = router._test;

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().slice(0, 19);
const H = 3600 * 1000;
const vote = (voter, author, permlink, weight, ago) => [0, { op: ['vote', { voter, author, permlink, weight }], timestamp: iso(ago) }];
const reward = (curator, author, permlink, vests, ago) => [0, { op: ['curation_reward', { curator, author, permlink, reward: `${vests} VESTS`, payout_must_be_claimed: true }], timestamp: iso(ago) }];

describe('votesFrom', () => {
  it('keeps this voter\'s upvotes, newest per post, and drops later unvotes', () => {
    const v = votesFrom([
      vote('fan', 'badadib', 'a', 5000, 5 * H),
      vote('fan', 'badadib', 'a', 10000, 4 * H),
      vote('other', 'badadib', 'b', 10000, 3 * H),
      vote('fan', 'badadib', 'c', 10000, 3 * H),
      vote('fan', 'badadib', 'c', 0, 2 * H),
      vote('fan', 'badadib', 'd', -10000, 2 * H),
    ], 'fan', Date.now() - 24 * H);
    expect([...v.keys()]).toEqual(['badadib/a'])
    expect(v.get('badadib/a').percent).toBe(100);
  });
});

describe('rewardsFrom', () => {
  it('sums VESTS per post for this curator', () => {
    const r = rewardsFrom([reward('fan', 'badadib', 'a', '1.5', H), reward('fan', 'badadib', 'a', '0.5', H), reward('x', 'badadib', 'a', '9', H)], 'fan', 0);
    expect(r.get('badadib/a').vests).toBe(2);
  });
});

describe('standing', () => {
  const votes = (list) => list.map(([voter, rshares, ago]) => ({ voter, rshares, time: iso(ago) }));
  it('early: under 10% of the weight before you, and the post reached 10 votes', () => {
    const list = [['a', 50, 10 * H], ['fan', 100, 9 * H], ...Array.from({ length: 9 }, (_, i) => [`v${i}`, 100, 8 * H - i])];
    const s = standing(votes(list), 'fan');
    expect(s.rank).toBe(2);
    expect(s.votes).toBe(11);
    expect(s.before).toBeCloseTo(50 / 1050, 6);
    expect(s.early).toBe(true);
  });
  it('not early with too few votes or too much weight before you', () => {
    expect(standing(votes([['fan', 100, 9 * H], ['a', 100, 8 * H]]), 'fan').early).toBe(false);
    const late = [['a', 500, 10 * H], ['fan', 100, 9 * H], ...Array.from({ length: 9 }, (_, i) => [`v${i}`, 50, 8 * H - i])];
    expect(standing(votes(late), 'fan').early).toBe(false);
  });
  it('null when the vote is not there', () => {
    expect(standing(votes([['a', 1, H]]), 'fan')).toBeNull();
  });
});

describe('GET /curation/:user', () => {
  let app;
  beforeEach(() => {
    cache.clear();
    jest.clearAllMocks();
    const coll = {
      'embed-video': [{ owner: 'badadib', permlink: 'asset1', hive_author: 'badadib', hive_permlink: 'vid', hive_title: 'My video' }],
      videos: [],
      'embed-audio': [{ owner: 'badadib', post_author: 'badadib', post_permlink: 'song', title: 'A song' }],
      contentcreators: [],
    };
    getDb.mockReturnValue({ collection: (n) => ({ find: () => ({ toArray: async () => coll[n] || [] }) }) });
    historySince.mockImplementation(async (account, since, filter) => (filter === 1
      ? [vote('fan', 'badadib', 'vid', 10000, 30 * H), vote('fan', 'badadib', 'song', 2500, 20 * H), vote('fan', 'someone', 'notours', 10000, 10 * H)]
      : [reward('fan', 'badadib', 'vid', '2000.000000', 2 * H)]));
    hiveRpcBatch.mockImplementation(async (reqs) => reqs.map((r) => {
      if (r.method === 'condenser_api.get_dynamic_global_properties') return { id: r.id, result: { total_vesting_fund_hive: '1000.000 HIVE', total_vesting_shares: '2000000.000000 VESTS' } };
      if (r.params[1] === 'vid') {
        return { id: r.id, result: [{ voter: 'fan', rshares: 10, time: iso(30 * H) }, ...Array.from({ length: 10 }, (_, i) => ({ voter: `v${i}`, rshares: 100, time: iso(29 * H - i) }))] };
      }
      return { id: r.id, result: [{ voter: 'a', rshares: 100, time: iso(21 * H) }, { voter: 'fan', rshares: 100, time: iso(20 * H) }] };
    }));
    app = express();
    app.use('/', router);
  });

  it('lists only 3Speak picks with rewards in HP and the early badge', async () => {
    const res = await request(app).get('/curation/Fan');
    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({ picks: 2, earnedHp: 1, rewardedPosts: 1, early: 1 });
    const [song, vid] = res.body.picks;
    expect(song).toMatchObject({ author: 'badadib', permlink: 'song', kind: 'audio', percent: 25, curationHp: 0, rank: 2, votes: 2, early: false });
    expect(vid).toMatchObject({ author: 'badadib', permlink: 'vid', kind: 'video', title: 'My video', percent: 100, curationHp: 1, rank: 1, votes: 11, early: true });
    expect(res.body.picks.find((p) => p.permlink === 'notours')).toBeUndefined();
  });

  it('caches per account', async () => {
    await request(app).get('/curation/fan');
    await request(app).get('/curation/fan');
    expect(historySince).toHaveBeenCalledTimes(2); // votes + rewards, once
  });

  it('leaves out reward-blocked creators', async () => {
    getDb.mockReturnValue({ collection: (n) => ({ find: () => ({ toArray: async () => (n === 'contentcreators' ? [{ username: 'badadib' }] : n === 'embed-video' ? [{ owner: 'badadib', permlink: 'vid', hive_author: 'badadib', hive_permlink: 'vid' }] : []) }) }) });
    const res = await request(app).get('/curation/fan');
    expect(res.body.picks).toEqual([]);
  });

  it('rejects a bad name and answers empty for a hidden account', async () => {
    expect((await request(app).get('/curation/x')).status).toBe(400);
    const res = await request(app).get('/curation/hiddenone');
    expect(res.body.picks).toEqual([]);
    expect(historySince).not.toHaveBeenCalled();
  });

  it('502 when Hive history fails', async () => {
    historySince.mockRejectedValue(new Error('down'));
    expect((await request(app).get('/curation/fan')).status).toBe(502);
  });
});
