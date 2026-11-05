/**
 * embedCategorySync: an embed-video's community is its Hive post's `category`,
 * which the indexer never stores. The worker reads it with get_content and
 * persists it, only for recent published docs still missing it. The chain is a
 * fake behind hiveRpcBatch; writes go to the real test MongoDB.
 */
jest.mock('../../utils/hive', () => ({ hiveRpcBatch: jest.fn() }));

const testDb = require('../helpers/db');
const { hiveRpcBatch } = require('../../utils/hive');
const { syncEmbedCategories } = require('../../services/embedCategorySync');
const { NOW, DAY, ago } = require('./_fixtures');

const db = testDb.use();
const ev = () => db().collection('embed-video');

const ONLY_DATE = ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame',
  'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate',
  'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'];

// Posts on the fake chain, keyed author/permlink -> category ('' = no category).
let categories;
function chain() {
  categories = new Map();
  hiveRpcBatch.mockImplementation(async (batch) => batch.map((r) => {
    const [a, p] = r.params;
    const key = `${a}/${p}`;
    if (!categories.has(key)) return { id: r.id, result: { author: '', permlink: '' } };
    return { id: r.id, result: { author: a, permlink: p, category: categories.get(key) } };
  }));
}
const video = (author, permlink, extra = {}) => ({
  owner: author, permlink: `asset-${permlink}`, hive_author: author, hive_permlink: permlink,
  status: 'published', createdAt: ago(DAY), ...extra,
});

beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ONLY_DATE });
  hiveRpcBatch.mockReset();
  chain();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.useRealTimers());

test('stores the post category on recent published docs that lack one', async () => {
  categories.set('alice/p1', 'hive-181335');
  await ev().insertOne(video('alice', 'p1'));

  const res = await syncEmbedCategories();

  expect(res).toEqual({ scanned: 1, updated: 1 });
  expect((await ev().findOne({ hive_permlink: 'p1' })).category).toBe('hive-181335');
});

test.each([
  ['already has a category', { category: 'hive-1' }],
  ['is older than the window', { createdAt: ago(91 * DAY) }],
  ['is not published', { status: 'encoding' }],
  ['has no Hive post', { hive_permlink: null }],
])('a doc that %s is not looked at', async (_label, extra) => {
  categories.set('alice/p1', 'hive-181335');
  await ev().insertOne(video('alice', 'p1', extra));

  expect(await syncEmbedCategories()).toEqual({ scanned: 0, updated: 0 });
  expect(hiveRpcBatch).not.toHaveBeenCalled();
});

test('a deleted post or one with no category is left for the next run', async () => {
  categories.set('alice/blank', '');
  await ev().insertMany([video('alice', 'gone'), video('alice', 'blank')]);

  const res = await syncEmbedCategories();

  expect(res).toEqual({ scanned: 2, updated: 0 });
  expect(await ev().countDocuments({ category: { $exists: true } })).toBe(0);
});

test('asks the chain in batches of 20', async () => {
  const docs = Array.from({ length: 21 }, (_, i) => video('bob', `p${i}`));
  docs.forEach((d) => categories.set(`bob/${d.hive_permlink}`, 'hive-2'));
  await ev().insertMany(docs);

  const res = await syncEmbedCategories();

  expect(hiveRpcBatch.mock.calls.map(([b]) => b.length)).toEqual([20, 1]);
  expect(hiveRpcBatch.mock.calls[0][0][0]).toEqual({
    jsonrpc: '2.0', id: 0, method: 'condenser_api.get_content', params: ['bob', expect.any(String)],
  });
  expect(res).toEqual({ scanned: 21, updated: 21 });
});

test('running twice changes nothing the second time', async () => {
  categories.set('alice/p1', 'hive-3');
  await ev().insertOne(video('alice', 'p1'));
  await syncEmbedCategories();
  hiveRpcBatch.mockClear();

  expect(await syncEmbedCategories()).toEqual({ scanned: 0, updated: 0 });
  expect(hiveRpcBatch).not.toHaveBeenCalled();
});

test('a total Hive outage writes nothing', async () => {
  hiveRpcBatch.mockResolvedValue([]);
  await ev().insertOne(video('alice', 'p1'));

  expect(await syncEmbedCategories()).toEqual({ scanned: 1, updated: 0 });
  expect((await ev().findOne({})).category).toBeUndefined();
});

test('a failing bulk write is logged and the run still returns', async () => {
  categories.set('alice/p1', 'hive-3');
  await ev().insertOne(video('alice', 'p1'));
  const { Collection } = require('mongodb');
  jest.spyOn(Collection.prototype, 'bulkWrite').mockRejectedValue(new Error('not primary'));

  await expect(syncEmbedCategories()).resolves.toEqual({ scanned: 1, updated: 0 });
  expect(console.error).toHaveBeenCalledWith('[embedCategorySync] bulkWrite error:', 'not primary');
});
