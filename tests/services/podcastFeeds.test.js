/**
 * Outside podcast feeds, main-thread half (services/podcastFeeds.js): talking to
 * the worker (replies, timeouts, a dead worker), the poll tick and its new-episode
 * pushes, the clean-up of feeds nobody follows, and the optional Podping listener.
 * The worker thread, web push and the Hive RPC are fakes; feeds and subscriptions
 * live in the real test MongoDB. Each test loads a fresh copy of the service.
 */
const mockPush = {
  isConfigured: jest.fn(() => true),
  getPrefs: jest.fn(async () => ({})),
  sendToUser: jest.fn(async () => ({ sent: 1 })),
};
const mockHive = { hiveRpcCall: jest.fn() };
jest.mock('../../utils/webPush', () => mockPush);
jest.mock('../../utils/hive', () => mockHive);

jest.mock('worker_threads', () => {
  const { EventEmitter } = require('events');
  class FakeWorker extends EventEmitter {
    constructor(file) {
      super();
      this.file = file;
      this.posted = [];
      FakeWorker.spawned.push(this);
    }

    // The reply comes back on a later turn, like a real thread's would.
    postMessage(msg) {
      this.posted.push(msg);
      const reply = FakeWorker.respond(msg);
      if (reply !== undefined) setImmediate(() => this.emit('message', { id: msg.id, ...reply }));
    }
  }
  FakeWorker.spawned = [];
  FakeWorker.respond = () => undefined;
  return { Worker: FakeWorker };
});

const path = require('path');
const { ObjectId } = require('mongodb');
const { Worker } = require('worker_threads');
const { waitUntil } = require('../helpers/wait');
const testDb = require('../helpers/db');
const { DAY, MINUTE } = require('./_fixtures');

const db = testDb.use();
const col = (name) => db().collection(name);

let timers;

beforeEach(() => {
  Worker.spawned.length = 0;
  Worker.respond = () => undefined;
  mockPush.isConfigured.mockReset().mockReturnValue(true);
  mockPush.getPrefs.mockReset().mockResolvedValue({});
  mockPush.sendToUser.mockReset().mockResolvedValue({ sent: 1 });
  mockHive.hiveRpcCall.mockReset();
  // Boot delay, tick, gc, podping, first restart, ask timeouts (default, tick, a test's own).
  timers = captureTimers([45 * 1000, 60 * 1000, 60 * 60 * 1000, 9000, 10 * 1000, 30 * 1000, 10 * 60 * 1000, 1234]);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

// The service's own timers (by their delays) are captured instead of started; the
// Mongo driver's timers pass through. Each returns something with unref().
function captureTimers(delays) {
  const realTimeout = global.setTimeout;
  const realInterval = global.setInterval;
  const realClear = global.clearTimeout;
  const list = [];
  const fake = (kind) => (fn, ms, ...rest) => {
    if (!delays.includes(ms)) return (kind === 'timeout' ? realTimeout : realInterval)(fn, ms, ...rest);
    const t = { kind, fn, ms, unref() { return t; } };
    list.push(t);
    return t;
  };
  jest.spyOn(global, 'setTimeout').mockImplementation(fake('timeout'));
  jest.spyOn(global, 'setInterval').mockImplementation(fake('interval'));
  jest.spyOn(global, 'clearTimeout').mockImplementation((t) => (t && t.fn ? undefined : realClear(t)));
  list.find1 = (kind, ms) => list.find((t) => t.kind === kind && t.ms === ms);
  return list;
}

// A fresh copy of the service read with extra environment, sharing this file's
// connected utils/db.
function load(env = {}) {
  const sharedDb = require('../../utils/db');
  let mod;
  jest.isolateModules(() => {
    const saved = {};
    for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
    try {
      jest.doMock('../../utils/db', () => sharedDb);
      mod = require('../../services/podcastFeeds');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
  return mod;
}

// start() fires an index build it does not wait for; wait until every index it
// asks for (plus _id) is there.
const INDEX_COUNTS = { podcast_feeds: 7, podcast_subs: 3, podcast_episodes: 3, podcast_progress: 4 };
async function waitForIndexes() {
  await waitUntil(async () => {
    const counts = await Promise.all(Object.keys(INDEX_COUNTS).map((c) => col(c).indexes().then((x) => x.length, () => 0)));
    return counts.every((n, j) => n >= Object.values(INDEX_COUNTS)[j]);
  }, { message: 'indexes never built' });
}

async function startService(env) {
  const svc = load(env);
  svc.start();
  await waitForIndexes();
  return svc;
}

describe('talking to the worker', () => {
  test('before the worker runs every question is answered "unavailable"', async () => {
    const svc = load();
    await expect(svc.ask('tick')).resolves.toEqual({ ok: false, code: 'unavailable' });
  });

  test('start() runs the feed worker and builds the indexes the reads need', async () => {
    const svc = await startService();

    expect(Worker.spawned).toHaveLength(1);
    expect(Worker.spawned[0].file).toBe(path.join(__dirname, '../../services/podcastFeedsWorker.js'));
    const feedIdx = await col('podcast_feeds').indexes();
    expect(feedIdx.find((i) => i.key.url_key === 1)).toMatchObject({ unique: true });
    const ttl = (await col('podcast_progress').indexes()).find((i) => i.name === 'at_1');
    expect(ttl.expireAfterSeconds).toBe(180 * 24 * 3600);
    expect(svc.enabled()).toBe(true);
    expect(svc.collections).toEqual({
      FEEDS: 'podcast_feeds', EPISODES: 'podcast_episodes', SUBS: 'podcast_subs', PROGRESS: 'podcast_progress',
    });
  });

  test('a question gets the reply with its own id; other ids are ignored', async () => {
    Worker.respond = (msg) => ({ ok: true, echo: msg.url });
    const svc = await startService();
    Worker.spawned[0].emit('message', { id: 999, ok: true, stray: true });

    const r = await svc.ask('probe', { url: 'https://feeds.example.com/a.xml' });

    expect(r).toEqual({ id: expect.any(Number), ok: true, echo: 'https://feeds.example.com/a.xml' });
    expect(Worker.spawned[0].posted[0]).toMatchObject({ type: 'probe', url: 'https://feeds.example.com/a.xml' });
  });

  test('no reply in time is a timeout, and a late reply changes nothing', async () => {
    const svc = await startService();
    const answer = svc.ask('notes', {}, 1234);
    const timer = timers.find1('timeout', 1234);

    timer.fn();
    await expect(answer).resolves.toEqual({ ok: false, code: 'timeout' });
    const { id } = Worker.spawned[0].posted[0];
    expect(() => Worker.spawned[0].emit('message', { id, ok: true })).not.toThrow();
  });

  test('a worker that dies answers what was pending, and is restarted after a back-off', async () => {
    const svc = await startService();
    const pending = svc.ask('tick');

    Worker.spawned[0].emit('exit', 1);

    await expect(pending).resolves.toMatchObject({ ok: false, code: 'worker_exit' });
    await expect(svc.ask('tick')).resolves.toEqual({ ok: false, code: 'unavailable' });
    const restart = timers.find1('timeout', 10 * 1000);    // first restart: 10 s
    expect(restart).toBeDefined();
    restart.fn();
    expect(Worker.spawned).toHaveLength(2);
  });

  test.each([
    ['PODCAST_FEEDS_ENABLED', 'false'],
    ['ENABLE_MONGO_WRITES', 'false'],
  ])('%s=%s: nothing starts', (name, value) => {
    const svc = load({ [name]: value });
    svc.start();
    expect(Worker.spawned).toHaveLength(0);
    expect(svc.enabled()).toBe(false);
    expect(timers).toHaveLength(0);
  });
});

describe('the poll tick and new-episode pushes', () => {
  const feedId = new ObjectId();
  const sub = (user, extra = {}) => ({ _id: `${user}|${feedId.toHexString()}`, user, feed_id: feedId, ...extra });

  // Start the service, run the first (boot) tick, and return the repeating tick.
  async function tickFn(env) {
    await startService(env);
    timers.find1('timeout', 45 * 1000).fn();           // first tick + schedules the rest
    return timers.find1('interval', 60 * 1000).fn;
  }

  const announceReply = (episodes) => ({
    ok: true, polled: 1, changed: 1, errors: 0,
    announce: [{ feed_id: feedId.toHexString(), title: 'The Show', episodes }],
  });

  test('every follower who wants it gets a push per new episode, at most two per show', async () => {
    await col('podcast_subs').insertMany([
      sub('ann'),
      sub('ben', { notify: false }),          // muted this show
      sub('cat'),                             // switched podcast pushes off
    ]);
    mockPush.getPrefs.mockImplementation(async (u) => (u === 'cat' ? { podcasts: false } : {}));
    const tick = await tickFn();
    Worker.respond = () => announceReply([
      { id: 'ep-1', title: 'Pilot' }, { id: 'ep 2', title: 'Second' }, { id: 'ep-3', title: 'Third' },
    ]);

    await tick();

    expect(mockPush.sendToUser.mock.calls).toEqual([
      ['ann', { title: 'New episode: The Show', body: 'Pilot', url: '/audio?type=external&episode=ep-1', tag: 'podcast:ep-1' }],
      ['ann', { title: 'New episode: The Show', body: 'Second', url: '/audio?type=external&episode=ep%202', tag: 'podcast:ep 2' }],
    ]);
  });

  test('a failing push for one follower does not stop the others', async () => {
    await col('podcast_subs').insertMany([sub('dee'), sub('eve')]);
    mockPush.sendToUser.mockImplementation(async (u) => { if (u === 'dee') throw new Error('gone'); return { sent: 1 }; });
    mockPush.getPrefs.mockRejectedValue(new Error('prefs down'));   // treated as defaults
    const tick = await tickFn();
    Worker.respond = () => announceReply([{ id: 'e', title: 'T' }]);

    await tick();

    expect(mockPush.sendToUser.mock.calls.map((c) => c[0])).toEqual(['dee', 'eve']);
  });

  test.each([
    ['push is not configured', () => mockPush.isConfigured.mockReturnValue(false), announceReply([{ id: 'e' }])],
    ['the worker skipped (a tick still running)', () => {}, { ok: true, skipped: true }],
    ['the tick failed', () => {}, { ok: false, code: 'boom', error: 'mongo' }],
    ['nothing new', () => {}, { ok: true, polled: 3, changed: 0, errors: 0, announce: [] }],
  ])('no push when %s', async (_name, arrange, reply) => {
    await col('podcast_subs').insertOne(sub('fay'));
    arrange();
    const tick = await tickFn();
    Worker.respond = () => reply;

    await tick();

    expect(mockPush.sendToUser).not.toHaveBeenCalled();
  });

  test('a failed tick is logged with its code', async () => {
    const tick = await tickFn();
    Worker.respond = () => ({ ok: false, code: 'timeout' });
    await tick();
    expect(console.warn).toHaveBeenCalledWith('[podcasts] tick failed:', 'timeout', '');
  });
});

describe('cleaning up feeds nobody follows', () => {
  const feed = (extra) => ({ _id: new ObjectId(), url_key: `k${Math.random()}`, subscribers: 0, created_at: new Date(Date.now() - 30 * DAY), ...extra });

  async function runGc() {
    await startService();
    await timers.find1('interval', 60 * 60 * 1000).fn();
  }

  test('a feed orphaned for over a week goes, with its episodes; a recent orphan stays', async () => {
    const old = feed({ orphaned_at: new Date(Date.now() - 8 * DAY) });
    const recent = feed({ orphaned_at: new Date(Date.now() - 2 * DAY) });
    const followed = feed({ subscribers: 3, orphaned_at: new Date(Date.now() - 30 * DAY) });
    await col('podcast_feeds').insertMany([old, recent, followed]);
    await col('podcast_episodes').insertMany([
      { _id: 'o1', feed_id: old._id }, { _id: 'r1', feed_id: recent._id }, { _id: 'f1', feed_id: followed._id },
    ]);

    await runGc();

    const left = (await col('podcast_feeds').find().toArray()).map((f) => String(f._id)).sort();
    expect(left).toEqual([String(recent._id), String(followed._id)].sort());
    expect((await col('podcast_episodes').find().toArray()).map((e) => e._id).sort()).toEqual(['f1', 'r1']);
  });

  test('a row left behind by a failed probe goes after a day; a fresh one stays', async () => {
    const stale = feed({ created_at: new Date(Date.now() - 2 * DAY) });
    const fresh = feed({ created_at: new Date(Date.now() - 10 * MINUTE) });
    await col('podcast_feeds').insertMany([stale, fresh]);

    await runGc();

    expect((await col('podcast_feeds').find().toArray()).map((f) => String(f._id))).toEqual([String(fresh._id)]);
  });

  test('a feed whose counter says 0 but has subscriptions is repaired, not deleted', async () => {
    const f = feed({ orphaned_at: new Date(Date.now() - 9 * DAY) });
    await col('podcast_feeds').insertOne(f);
    await col('podcast_subs').insertMany([
      { _id: `a|${f._id}`, user: 'a', feed_id: f._id },
      { _id: `b|${f._id}`, user: 'b', feed_id: f._id },
    ]);

    await runGc();

    const row = await col('podcast_feeds').findOne({ _id: f._id });
    expect(row.subscribers).toBe(2);
    expect(row).not.toHaveProperty('orphaned_at');
  });

  test('a second clean-up changes nothing', async () => {
    await col('podcast_feeds').insertMany([feed({ orphaned_at: new Date(Date.now() - 8 * DAY) }), feed({ subscribers: 1 })]);
    await runGc();
    const after1 = await col('podcast_feeds').find().toArray();
    await timers.find1('interval', 60 * 60 * 1000).fn();
    expect(await col('podcast_feeds').find().toArray()).toEqual(after1);
  });
});

describe('Podping', () => {
  const HEAD = 100000;
  const pingOp = (urls, id = 'pp_podcast_update') => ({ type: 'custom_json_operation', value: { id, json: JSON.stringify({ iris: urls }) } });
  const block = (...ops) => ({ transactions: [{ operations: ops }] });

  function chain({ head = HEAD, blocks = [] } = {}) {
    mockHive.hiveRpcCall.mockImplementation(async (method) => {
      if (method === 'condenser_api.get_dynamic_global_properties') return head == null ? null : { head_block_number: head };
      if (method === 'block_api.get_block_range') return blocks === null ? null : { blocks };
      throw new Error(`unexpected ${method}`);
    });
  }
  const rangeAsked = () => mockHive.hiveRpcCall.mock.calls.filter((c) => c[0] === 'block_api.get_block_range').map((c) => c[1]);

  async function podpingFn() {
    await startService({ PODCAST_PODPING_ENABLED: 'true' });
    return timers.find1('interval', 9000).fn;
  }

  const followed = (key, extra = {}) => ({
    _id: new ObjectId(), url_key: key, alt_keys: [], subscribers: 1,
    last_fetch_at: new Date(Date.now() - 30 * MINUTE), next_poll_at: new Date(Date.now() + DAY), ...extra,
  });

  test('is off unless asked for', async () => {
    await startService();
    expect(timers.find1('interval', 9000)).toBeUndefined();
  });

  test('a ping for a followed feed makes it due now, and a tick follows', async () => {
    const show = followed('feeds.example.com/show.xml');
    const moved = followed('new.example.com/feed', { alt_keys: ['old.example.com/feed'] });
    const justFetched = followed('feeds.example.com/fresh.xml', { last_fetch_at: new Date(Date.now() - MINUTE) });
    const unfollowed = followed('feeds.example.com/nobody.xml', { subscribers: 0 });
    await col('podcast_feeds').insertMany([show, moved, justFetched, unfollowed]);
    chain({ blocks: [block(
      pingOp(['https://www.feeds.example.com/show.xml/', 'https://old.example.com/feed']),
      pingOp(['https://feeds.example.com/fresh.xml', 'https://feeds.example.com/nobody.xml']),
      { type: 'vote_operation', value: { voter: 'x' } },
    )] });
    const ping = await podpingFn();

    await ping();

    const due = (await col('podcast_feeds').find({ podping_at: { $exists: true } }).toArray()).map((f) => String(f._id)).sort();
    expect(due).toEqual([String(show._id), String(moved._id)].sort());
    const row = await col('podcast_feeds').findOne({ _id: show._id });
    expect(row.next_poll_at.getTime()).toBeLessThanOrEqual(Date.now());
    expect(Worker.spawned[0].posted.map((m) => m.type)).toContain('tick');
  });

  test('a fresh start reads from the head, then saves where it got to', async () => {
    chain({ blocks: [block(), block()] });
    const ping = await podpingFn();

    await ping();

    expect(rangeAsked()).toEqual([{ starting_block_num: HEAD, count: 1 }]);
    expect(await col('podcast-state').findOne({ _id: 'podping' })).toMatchObject({ block: HEAD + 1 });
  });

  test('a restart resumes after the saved block, at most 50 blocks a call', async () => {
    await col('podcast-state').insertOne({ _id: 'podping', block: HEAD - 80 });
    chain({ blocks: [block()] });
    const ping = await podpingFn();

    await ping();

    expect(rangeAsked()).toEqual([{ starting_block_num: HEAD - 79, count: 50 }]);
  });

  test('far behind (a long outage) it skips ahead instead of replaying', async () => {
    await col('podcast-state').insertOne({ _id: 'podping', block: HEAD - 5000 });
    chain({ blocks: [block()] });
    const ping = await podpingFn();

    await ping();

    expect(rangeAsked()).toEqual([{ starting_block_num: HEAD, count: 1 }]);
  });

  test.each([
    ['no head block', { head: null }],
    ['a broken block range answer', { blocks: null }],
  ])('%s: nothing is changed', async (_name, opts) => {
    await col('podcast_feeds').insertOne(followed('feeds.example.com/show.xml'));
    chain(opts);
    const ping = await podpingFn();

    await ping();

    expect(await col('podcast_feeds').countDocuments({ podping_at: { $exists: true } })).toBe(0);
    expect(await col('podcast-state').countDocuments()).toBe(0);
  });

  test('a node error is a warning, and the listener keeps going', async () => {
    mockHive.hiveRpcCall.mockRejectedValueOnce(new Error('node down'));
    const ping = await podpingFn();

    await ping();
    chain({ blocks: [block()] });
    await ping();

    expect(console.warn).toHaveBeenCalledWith('[podcasts] podping:', 'node down');
    expect(rangeAsked()).toHaveLength(1);
  });

  test('a call still running when the next is due is not doubled', async () => {
    chain({ blocks: [block()] });
    const ping = await podpingFn();

    await Promise.all([ping(), ping()]);

    expect(rangeAsked()).toHaveLength(1);
  });
});
