/**
 * Comment-count sync (services/commentCounts.js): which videos are counted, what
 * is stored per Hive post, and the two safety rules: a post whose Hive fetch
 * failed keeps its old count, and a total outage never wipes the collection.
 * Hive is stubbed at utils/hive.fetchCommentReplyCounts.
 */
process.env.COMMENT_SYNC_MAX_VIDEOS = '4';

jest.mock('../../utils/hive', () => ({
  ...jest.requireActual('../../utils/hive'),
  fetchCommentReplyCounts: jest.fn(),
}));

const { Collection } = require('mongodb');
const testDb = require('../helpers/db');
const { NOW, DAY, ago } = require('./_fixtures');
const hive = require('../../utils/hive');
const { syncCommentCounts, scheduleCommentCounts } = require('../../services/commentCounts');

const db = testDb.use();
const counts = () => db().collection('video-comment-counts');

const REAL_TIMERS = ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'];
beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: REAL_TIMERS });
  hive.fetchCommentReplyCounts.mockReset();
});
afterEach(() => jest.useRealTimers());

const legacy = (owner, permlink, extra = {}) => ({ owner, permlink, status: 'published', created: ago(DAY), ...extra });
const embed = (hiveAuthor, hivePermlink, extra = {}) => ({
  owner: hiveAuthor, permlink: `asset-${hivePermlink}`, hive_author: hiveAuthor, hive_permlink: hivePermlink,
  status: 'published', short: false, listed_on_3speak: true, createdAt: ago(DAY), ...extra,
});
/** Hive answers each listed key; anything else is a fetch miss. */
const hiveReturns = (table) => hive.fetchCommentReplyCounts.mockImplementation(async () => new Map(Object.entries(table)));

describe('which videos are counted', () => {
  test('recent published legacy videos and listed long-form embeds, deduped by Hive post', async () => {
    await db().collection('videos').insertMany([
      legacy('alice', 'v1'),
      legacy('Bob', 'v2', { author: 'Bob' }),
      legacy('alice', 'draft', { status: 'uploaded' }),
      legacy('alice', 'failed', { publishFailed: true }),
      legacy('alice', 'old', { created: ago(31 * DAY) }),
    ]);
    await db().collection('embed-video').insertMany([
      embed('alice', 'v1'),                                   // same post as the legacy row
      embed('carol', 'e1'),
      embed('carol', 'short', { short: true }),
      embed('carol', 'unlisted', { listed_on_3speak: false }),
      embed('carol', 'nohive', { hive_permlink: null }),
      embed('carol', 'oldembed', { createdAt: ago(40 * DAY) }),
    ]);
    hiveReturns({});

    const run = await syncCommentCounts();

    const asked = hive.fetchCommentReplyCounts.mock.calls[0][0].map((k) => `${k.author}/${k.permlink}`).sort();
    expect(asked).toEqual(['alice/v1', 'bob/v2', 'carol/e1']);
    expect(run).toMatchObject({ videos: 3, written: 0, capped: 0 });
  });

  test('a run is capped at COMMENT_SYNC_MAX_VIDEOS and reports how many were left out', async () => {
    await db().collection('videos').insertMany(['a', 'b', 'c', 'd', 'e', 'f'].map((p) => legacy('alice', p)));
    hiveReturns({});
    const run = await syncCommentCounts();
    expect(hive.fetchCommentReplyCounts.mock.calls[0][0]).toHaveLength(4);
    expect(run).toMatchObject({ videos: 4, capped: 2 });
  });

  test('no candidates means no Hive call', async () => {
    const run = await syncCommentCounts();
    expect(run).toMatchObject({ videos: 0 });
    expect(hive.fetchCommentReplyCounts).not.toHaveBeenCalled();
  });
});

describe('what is stored', () => {
  test('raw and 3Speak-native counts, plus the native-weighted effective count', async () => {
    await db().collection('videos').insertMany([legacy('alice', 'v1'), legacy('alice', 'quiet')]);
    hiveReturns({ 'alice/v1': { comments: 4, native3Speak: 3 }, 'alice/quiet': { comments: 0, native3Speak: 0 } });

    const run = await syncCommentCounts();

    expect(run).toMatchObject({ videos: 2, written: 2, withComments: 1, removed: 0 });
    expect(await counts().findOne({ _id: 'alice/v1' })).toEqual({
      _id: 'alice/v1', author: 'alice', permlink: 'v1', comments: 4, native3Speak: 3,
      effective: 5.5,                                       // 4 + (1.5 - 1) * 3
      updatedAt: NOW,
    });
  });

  test('running twice with the same Hive answers leaves the same rows', async () => {
    await db().collection('videos').insertOne(legacy('alice', 'v1'));
    hiveReturns({ 'alice/v1': { comments: 2, native3Speak: 0 } });
    await syncCommentCounts();
    const first = await counts().find().toArray();
    await syncCommentCounts();
    expect(await counts().find().toArray()).toEqual(first);
  });

  test('a row for a video that left the window is pruned once a run writes fresh rows', async () => {
    await counts().insertOne({ _id: 'alice/aged', comments: 9, updatedAt: ago(DAY) });
    await db().collection('videos').insertOne(legacy('alice', 'v1'));
    hiveReturns({ 'alice/v1': { comments: 1, native3Speak: 0 } });

    const run = await syncCommentCounts();

    expect(run.removed).toBe(1);
    expect(await counts().distinct('_id')).toEqual(['alice/v1']);
  });
});

describe('Hive failures never corrupt the counts', () => {
  test('a post whose Hive fetch failed this run is not pruned along with aged-out videos', async () => {
    // Regression: the prune used to delete every row with updatedAt < runAt. A
    // still-in-window video whose batch failed ("leave as-is") was not refreshed, so
    // its row was deleted too and its comment boost vanished until the next
    // successful run.
    await counts().insertOne({ _id: 'alice/missed', author: 'alice', permlink: 'missed', comments: 7, native3Speak: 1, effective: 7.5, updatedAt: ago(DAY) });
    await db().collection('videos').insertMany([legacy('alice', 'missed'), legacy('alice', 'ok')]);
    hiveReturns({ 'alice/ok': { comments: 1, native3Speak: 0 } });

    await syncCommentCounts();

    expect(await counts().findOne({ _id: 'alice/missed' })).toMatchObject({ comments: 7 });
  });

  test('a total Hive outage writes nothing and prunes nothing', async () => {
    await counts().insertOne({ _id: 'alice/v1', comments: 3, updatedAt: ago(DAY) });
    await db().collection('videos').insertOne(legacy('alice', 'v1'));
    hiveReturns({});

    const run = await syncCommentCounts();

    expect(run).toMatchObject({ written: 0, removed: 0 });
    expect(await counts().findOne({ _id: 'alice/v1' })).toMatchObject({ comments: 3 });
  });

  test('a thrown error is reported in the result, and the next run is not blocked', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await db().collection('videos').insertOne(legacy('alice', 'v1'));
    hive.fetchCommentReplyCounts.mockRejectedValueOnce(new Error('rpc exploded'));

    expect(await syncCommentCounts()).toEqual({ error: 'rpc exploded' });

    hiveReturns({ 'alice/v1': { comments: 1, native3Speak: 1 } });
    expect(await syncCommentCounts()).toMatchObject({ written: 1 });
  });

  test('a Mongo read failure is reported, not thrown', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(Collection.prototype, 'find').mockImplementation(() => { throw new Error('mongo down'); });
    expect(await syncCommentCounts()).toEqual({ error: 'mongo down' });
  });
});

describe('scheduling', () => {
  test('an overlapping run is skipped', async () => {
    await db().collection('videos').insertOne(legacy('alice', 'v1'));
    let release;
    const asked = new Promise((onAsk) => {
      hive.fetchCommentReplyCounts.mockImplementation(() => new Promise((r) => { release = () => r(new Map()); onAsk(); }));
    });

    const first = syncCommentCounts();
    await asked;                                     // the first run is now waiting on Hive
    expect(await syncCommentCounts()).toEqual({ skipped: 'already-running' });
    release();
    await first;
  });

  test('first run is delayed past the boot burst, then repeats on the interval', () => {
    const timeout = jest.spyOn(global, 'setTimeout').mockImplementation(() => 0);
    const interval = jest.spyOn(global, 'setInterval').mockImplementation(() => 0);
    scheduleCommentCounts();
    expect(timeout).toHaveBeenCalledWith(expect.any(Function), 90 * 1000);
    expect(interval).toHaveBeenCalledWith(expect.any(Function), 30 * 60 * 1000);
    expect(timeout.mock.calls[0][0]).toBe(interval.mock.calls[0][0]);
  });

  test('the scheduled callback runs a sync', async () => {
    const interval = jest.spyOn(global, 'setInterval').mockImplementation(() => 0);
    const timeout = jest.spyOn(global, 'setTimeout').mockImplementation(() => 0);
    scheduleCommentCounts();
    timeout.mockRestore();
    await db().collection('videos').insertOne(legacy('alice', 'v1'));
    hiveReturns({ 'alice/v1': { comments: 2, native3Speak: 0 } });
    const logged = new Promise((r) => jest.spyOn(console, 'log').mockImplementation((tag) => { if (tag === '[commentCounts]') r(); }));
    interval.mock.calls[0][0]();
    await logged;                                    // the callback logs once its sync finished
    expect(await counts().countDocuments()).toBe(1);
  });
});
