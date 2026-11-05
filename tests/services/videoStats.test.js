/**
 * Feed-card stats cache (services/videoStats.js): feeds get payout / votes /
 * comments from `video-stats` without waiting on Hive, cold or stale keys are
 * queued (bounded), and the background drain writes what Hive returned and
 * nothing else. Hive is stubbed at utils/hive.fetchHiveVideoStats.
 */
process.env.VIDEO_STATS_ENABLED = 'true';
process.env.VIDEO_STATS_TTL_MIN = '20';
process.env.VIDEO_STATS_DRAIN_BATCH = '3';
process.env.VIDEO_STATS_QUEUE_MAX = '5';

jest.mock('../../utils/hive', () => ({
  ...jest.requireActual('../../utils/hive'),
  fetchHiveVideoStats: jest.fn(),
}));

const express = require('express');
const { Collection } = require('mongodb');
const request = require('supertest');
const testDb = require('../helpers/db');
const { NOW, MINUTE } = require('./_fixtures');
const hive = require('../../utils/hive');
const {
  attachVideoStats, videoStatsMiddleware, drainVideoStats, scheduleVideoStats, keyOf,
} = require('../../services/videoStats');

const db = testDb.use();
const stats = () => db().collection('video-stats');

const REAL_TIMERS = ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'];

/** Hive answers every asked key with these numbers (or only the listed ones). */
function hiveAnswers(table) {
  hive.fetchHiveVideoStats.mockImplementation(async (aps) => new Map(aps
    .map((ap) => `${ap.author}/${ap.permlink}`)
    .filter((k) => table[k])
    .map((k) => [k, table[k]])));
}

/** Empty the module's in-memory queue so tests stay independent. */
async function drainAll() {
  hive.fetchHiveVideoStats.mockResolvedValue(new Map());
  while (await drainVideoStats()) { /* keep going */ }
}

/** The keys currently queued, read by draining them through a recording stub. */
async function queuedKeys() {
  const asked = [];
  hive.fetchHiveVideoStats.mockImplementation(async (aps) => { asked.push(...aps.map((a) => `${a.author}/${a.permlink}`)); return new Map(); });
  while (await drainVideoStats()) { /* keep going */ }
  return asked;
}

beforeEach(async () => {
  jest.useFakeTimers({ now: NOW, doNotFake: REAL_TIMERS });
  hive.fetchHiveVideoStats.mockReset();
  await drainAll();
  hive.fetchHiveVideoStats.mockReset();
});
afterEach(() => jest.useRealTimers());

describe('which Hive post a feed item is', () => {
  test.each([
    ['a plain author string', { author: 'Alice', permlink: 'p' }, 'alice/p'],
    ['an author object with a username', { author: { username: 'bob' }, permlink: 'p' }, 'bob/p'],
    ['an author object with only an id', { author: { id: 'carol' }, permlink: 'p' }, 'carol/p'],
    ['a legacy owner', { owner: 'dave', permlink: 'p' }, 'dave/p'],
    ['an embed hive key', { hive_author: 'erin', hive_permlink: 'hp' }, 'erin/hp'],
    ['no permlink', { author: 'alice' }, null],
    ['no author', { permlink: 'p' }, null],
    ['not an object', 'alice/p', null],
    ['null', null, null],
  ])('%s', (_name, item, key) => {
    expect(keyOf(item)).toBe(key);
  });
});

describe('attaching cached stats to a feed', () => {
  test('stamps cached numbers (marked authoritative) on every item of the same post and keeps other stats fields', async () => {
    await stats().insertOne({ _id: 'alice/p', reward: 1.25, votes: 7, comments: 2, updatedAt: NOW });
    const a = { author: 'alice', permlink: 'p', stats: { views: 10 } };
    const dup = { owner: 'alice', permlink: 'p' };

    await attachVideoStats([a, dup]);

    expect(a.stats).toEqual({ views: 10, total_hive_reward: 1.25, num_votes: 7, num_comments: 2, has_stats: true });
    expect(dup.stats).toEqual({ total_hive_reward: 1.25, num_votes: 7, num_comments: 2, has_stats: true });
    expect(await queuedKeys()).toEqual([]);        // fresh row, nothing to refresh
  });

  test('a cached row with missing numbers reads as zeros, and still counts as authoritative', async () => {
    await stats().insertOne({ _id: 'alice/zero', updatedAt: NOW });
    const v = { author: 'alice', permlink: 'zero' };
    await attachVideoStats([v]);
    expect(v.stats).toEqual({ total_hive_reward: 0, num_votes: 0, num_comments: 0, has_stats: true });
  });

  test('a cold post gets no stats yet and is queued; a stale one is served AND queued', async () => {
    await stats().insertMany([
      { _id: 'alice/stale', reward: 3, votes: 1, comments: 0, updatedAt: new Date(NOW - 21 * MINUTE) },
      { _id: 'alice/undated', reward: 1, votes: 1, comments: 1 },
    ]);
    const cold = { author: 'bob', permlink: 'new' };
    const stale = { author: 'alice', permlink: 'stale' };
    const undated = { author: 'alice', permlink: 'undated' };

    await attachVideoStats([cold, stale, undated, { title: 'no key' }]);

    expect(cold.stats).toBeUndefined();
    expect(stale.stats.total_hive_reward).toBe(3);
    expect((await queuedKeys()).sort()).toEqual(['alice/stale', 'alice/undated', 'bob/new']);
  });

  test('the queue dedupes and is capped, so a flood of cold keys cannot grow it without bound', async () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ author: 'a', permlink: `p${i}` }));
    await attachVideoStats([...items, ...items]);
    expect(await queuedKeys()).toEqual(['a/p0', 'a/p1', 'a/p2', 'a/p3', 'a/p4']);
  });

  test('a cache read failure serves the feed unchanged and queues nothing', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const find = jest.spyOn(Collection.prototype, 'find')
      .mockReturnValue({ toArray: async () => { throw new Error('mongo down'); } });
    const v = { author: 'alice', permlink: 'p', stats: { views: 1 } };

    await attachVideoStats([v]);

    expect(v.stats).toEqual({ views: 1 });
    find.mockRestore();
    expect(await queuedKeys()).toEqual([]);
  });

  test('empty or keyless input is a no-op', async () => {
    await expect(attachVideoStats([])).resolves.toBeUndefined();
    await expect(attachVideoStats(null)).resolves.toBeUndefined();
    await expect(attachVideoStats([{ title: 'x' }])).resolves.toBeUndefined();
  });
});

describe('the background drain', () => {
  test('refreshes the oldest queued keys in batches and upserts what Hive returned', async () => {
    await attachVideoStats(['p1', 'p2', 'p3', 'p4'].map((p) => ({ author: 'alice', permlink: p })));
    hiveAnswers({
      'alice/p1': { reward: 1, votes: 2, comments: 3 },
      'alice/p2': { reward: 0, votes: 0, comments: 0 },
      'alice/p3': { reward: 5, votes: 1, comments: 0 },
    });

    const run = await drainVideoStats();

    expect(run).toMatchObject({ requested: 3, fetched: 3, queued: 1 });
    expect(hive.fetchHiveVideoStats).toHaveBeenCalledWith(
      [{ author: 'alice', permlink: 'p1' }, { author: 'alice', permlink: 'p2' }, { author: 'alice', permlink: 'p3' }],
      { ttl: 0 },
    );
    expect(await stats().find().sort({ _id: 1 }).toArray()).toEqual([
      { _id: 'alice/p1', author: 'alice', permlink: 'p1', reward: 1, votes: 2, comments: 3, updatedAt: NOW },
      { _id: 'alice/p2', author: 'alice', permlink: 'p2', reward: 0, votes: 0, comments: 0, updatedAt: NOW },
      { _id: 'alice/p3', author: 'alice', permlink: 'p3', reward: 5, votes: 1, comments: 0, updatedAt: NOW },
    ]);
  });

  test('a key Hive did not answer keeps its old row instead of being zeroed', async () => {
    await stats().insertOne({ _id: 'alice/p', author: 'alice', permlink: 'p', reward: 9, votes: 9, comments: 9, updatedAt: new Date(NOW - 60 * MINUTE) });
    await attachVideoStats([{ author: 'alice', permlink: 'p' }]);
    hiveAnswers({});

    expect(await drainVideoStats()).toMatchObject({ fetched: 0 });
    expect((await stats().findOne({ _id: 'alice/p' })).reward).toBe(9);
  });

  test('a Hive error is reported, not thrown, and writes nothing', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await attachVideoStats([{ author: 'alice', permlink: 'p' }]);
    hive.fetchHiveVideoStats.mockRejectedValue(new Error('nodes down'));

    expect(await drainVideoStats()).toEqual({ error: 'nodes down' });
    expect(await stats().countDocuments()).toBe(0);
  });

  test('an empty queue does no work at all', async () => {
    expect(await drainVideoStats()).toBeNull();
    expect(hive.fetchHiveVideoStats).not.toHaveBeenCalled();
  });

  test('two overlapping drains never run at once', async () => {
    await attachVideoStats([{ author: 'alice', permlink: 'p' }]);
    let release;
    hive.fetchHiveVideoStats.mockImplementation(() => new Promise((r) => { release = () => r(new Map()); }));

    const first = drainVideoStats();
    await new Promise((r) => setImmediate(r));
    await attachVideoStats([{ author: 'bob', permlink: 'q' }]);
    expect(await drainVideoStats()).toBeNull();      // busy
    release();
    await first;
    expect(hive.fetchHiveVideoStats).toHaveBeenCalledTimes(1);
  });

  test('the schedule drains on its interval', async () => {
    const spy = jest.spyOn(global, 'setInterval').mockImplementation(() => 0);
    scheduleVideoStats();
    expect(spy).toHaveBeenCalledWith(expect.any(Function), 20 * 1000);

    await attachVideoStats([{ author: 'alice', permlink: 'p' }]);
    hiveAnswers({ 'alice/p': { reward: 2, votes: 1, comments: 0 } });
    const logged = new Promise((r) => jest.spyOn(console, 'log').mockImplementation((tag) => { if (tag === '[videoStats]') r(); }));
    spy.mock.calls[0][0]();
    await logged;                                    // logged once the drain wrote its batch
    expect(await stats().countDocuments()).toBe(1);
  });
});

describe('the response middleware', () => {
  function appServing(payload) {
    const app = express();
    app.use(videoStatsMiddleware);
    app.get('/', (_req, res) => res.json(payload));
    return app;
  }

  beforeEach(async () => {
    await stats().insertOne({ _id: 'alice/p', reward: 1, votes: 2, comments: 3, updatedAt: NOW });
  });

  test.each(['videos', 'items', 'results', 'shorts', 'trends', 'data'])('fills stats in a `%s` list', async (field) => {
    const res = await request(appServing({ [field]: [{ author: 'alice', permlink: 'p' }], other: 1 })).get('/');
    expect(res.body[field][0].stats).toMatchObject({ num_votes: 2, has_stats: true });
    expect(res.body.other).toBe(1);
  });

  test('fills stats in a bare array response', async () => {
    const res = await request(appServing([{ author: 'alice', permlink: 'p' }])).get('/');
    expect(res.body[0].stats.num_comments).toBe(3);
  });

  test('passes any other payload through untouched', async () => {
    const res = await request(appServing({ ok: true })).get('/');
    expect(res.body).toEqual({ ok: true });
  });
});
