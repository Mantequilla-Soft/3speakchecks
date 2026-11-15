/**
 * Earnings over time (routes/creatorEarnings.js): a daily HBD series per source
 * from HafSQL (a stand-in) and the checker's own ad payouts, stream boosts and
 * Lightning tips, valued at the rates a Hive node (a stand-in) gives.
 */
const mockQuery = jest.fn();
jest.mock('../../utils/hafsql', () => ({ query: (...args) => mockQuery(...args) }));
jest.mock('../../utils/hive', () => ({ hiveRpcBatch: jest.fn() }));
const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const { hiveRpcBatch } = require('../../utils/hive');

const db = testDb.use();
const router = require('../../routes/creatorEarnings');
const app = buildApp(['/', router]);
const { TIP_MEMO_RE, reset } = router._test;

const HEAD = 100000000;
const DAY_BLOCKS = 28800;
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000);

function hafsqlFor({ author = [], benefactor = [], curation = [], transfers = [] }) {
  mockQuery.mockImplementation(async (sql) => {
    if (/from hafsql\.follows/.test(sql)) return [{ head: HEAD }];
    if (/operation_author_reward_table/.test(sql)) return author;
    if (/operation_comment_benefactor_reward_table/.test(sql)) return benefactor;
    if (/operation_curation_reward_table/.test(sql)) return curation;
    if (/operation_transfer_table/.test(sql)) return transfers;
    throw new Error(`unexpected ${sql}`);
  });
}

beforeEach(() => {
  reset();
  mockQuery.mockReset();
  // 0.25 HBD per HIVE; 500 HIVE per million VESTS.
  hiveRpcBatch.mockResolvedValue([
    { id: 1, result: { base: '0.250 HBD', quote: '1.000 HIVE' } },
    { id: 2, result: { total_vesting_fund_hive: '500.000 HIVE', total_vesting_shares: '1000000.000000 VESTS' } },
  ]);
});

describe('tip memos', () => {
  test('a 3speak.tv link or the word tip; not "tipping point" style words', () => {
    expect(TIP_MEMO_RE.test('Great show https://3speak.tv/watch?v=badadib/x')).toBe(true);
    expect(TIP_MEMO_RE.test('!tip @badadib')).toBe(true);
    expect(TIP_MEMO_RE.test('a tip for you')).toBe(true);
    expect(TIP_MEMO_RE.test('multiple payment')).toBe(false);
    expect(TIP_MEMO_RE.test('stipend')).toBe(false);
  });
});

describe('GET /creator-stats/earnings', () => {
  test('a day per row, each source valued in HBD, Lightning in sats', async () => {
    hafsqlFor({
      // Today: 1 HBD + 4 HIVE (1 HBD) + 2,000 VESTS (1 HIVE = 0.25 HBD).
      author: [{ block: HEAD - 10, permlink: 'post-a', hbd: 1, hive: 4, vests: 2000 }],
      benefactor: [{ block: HEAD - DAY_BLOCKS - 10, permlink: 'x', hbd: 0.5, hive: 0, vests: 0 }],
      curation: [{ block: HEAD - 10, amount: 4000, symbol: 'VESTS' }],
      transfers: [
        { block: HEAD - 10, amount: 2, symbol: 'HIVE', memo: 'thanks https://3speak.tv/watch?v=badadib/post-a' },
        { block: HEAD - 10, amount: 3, symbol: 'HBD', memo: 'rent' },
      ],
    });
    await db().collection('ad_payouts').insertMany([
      { account: 'badadib', status: 'paid', hbd: 0.4, paidAt: new Date() },
      { account: 'badadib', status: 'pending', hbd: 9, paidAt: new Date() },
    ]);
    await db().collection('stream-boosts').insertOne({ host: 'badadib', sender: 'fan', amount: 1.5, createdAt: new Date() });
    await db().collection('supports').insertMany([
      { author: 'badadib', currency: 'SATS', amount: 210, hbd_value: 0, tippedAt: new Date() },
      { author: 'badadib', currency: 'HBD', amount: 1, hbd_value: 1, tippedAt: new Date() },
    ]);

    const { body } = await request(app).get('/creator-stats/earnings?username=badadib&days=7').expect(200);
    expect(body.series).toHaveLength(7);
    expect(body.series[6]).toEqual({ date: today(), votes: 2.25, curation: 0.5, tips: 0.5, ads: 0.4, boosts: 1.5, lightningSats: 210 });
    expect(body.series[5]).toMatchObject({ votes: 0.5 });
    expect(body.totals).toEqual({ votes: 2.75, curation: 0.5, tips: 0.5, ads: 0.4, boosts: 1.5, lightningSats: 210 });
    expect(body.byPost).toEqual({ 'post-a': 2.25 });
    expect(body.rates).toEqual({ hbdPerHive: 0.25, hivePerMvests: 500 });
  });

  test('outside the range is left out; the default range is 28 days', async () => {
    hafsqlFor({});
    await db().collection('ad_payouts').insertOne({ account: 'badadib', status: 'paid', hbd: 5, paidAt: daysAgo(40) });
    const { body } = await request(app).get('/creator-stats/earnings?username=badadib').expect(200);
    expect(body.days).toBe(28);
    expect(body.series).toHaveLength(28);
    expect(body.totals.ads).toBe(0);
  });

  test('no Hive rates: 503, and a bad name is a 400', async () => {
    hafsqlFor({});
    hiveRpcBatch.mockResolvedValue([]);
    await request(app).get('/creator-stats/earnings?username=badadib&days=7').expect(503);
    await request(app).get('/creator-stats/earnings?username=No').expect(400);
  });
});
