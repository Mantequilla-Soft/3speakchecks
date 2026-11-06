/**
 * Retention worker (services/retentionWorker.js): turns watch rows into one cached
 * score per video. The worker runs on require and reports through parentPort, so
 * here parentPort is a fake, process.exit is stubbed, and every run is a fresh
 * copy of the module against the real test MongoDB (the worker opens its own
 * client to the same database).
 */
jest.mock('worker_threads', () => {
  const { EventEmitter } = require('events');
  const port = new EventEmitter();
  port.postMessage = (msg) => port.emit('posted', msg);
  return { parentPort: port };
});

const { parentPort } = require('worker_threads');
const testDb = require('../helpers/db');
const { DAY } = require('./_fixtures');

const db = testDb.use();
const watch = () => db().collection('view-durations');
const scores = () => db().collection('video-retention');

const daysAgo = (d) => new Date(Date.now() - d * DAY);

/** Run the worker once; resolves to { msg, code } (what it posted, how it exited). */
async function runWorker(env = {}) {
  const exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
  const posted = new Promise((resolve) => parentPort.once('posted', resolve));
  jest.isolateModules(() => {
    const saved = {};
    for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
    try {
      require('../../services/retentionWorker');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
  const msg = await posted;
  return { msg, code: exit.mock.calls[0] && exit.mock.calls[0][0] };
}

// One watch session. pct = watchedPct, sec = contentSeconds.
const session = (owner, permlink, { sid, pct, sec, dur = 100, maxPos, at = daysAgo(1), ...rest } = {}) => ({
  owner, permlink, sid, watchedPct: pct, contentSeconds: sec, videoDuration: dur,
  maxPosition: maxPos == null ? (pct * dur) / 100 : maxPos, updatedAt: at, ...rest,
});

const byId = async () => new Map((await scores().find().toArray()).map((d) => [d._id, d]));

describe('with no watch data', () => {
  test('reports zero videos, writes nothing and exits cleanly', async () => {
    const { msg, code } = await runWorker();
    expect(msg).toMatchObject({ ok: true, videos: 0 });
    expect(code).toBe(0);
    expect(await scores().countDocuments()).toBe(0);
  });
});

describe('per-video metrics', () => {
  test('sessions, viewers, watched %, completion, engaged and hook rates per video', async () => {
    await watch().insertMany([
      session('alice', 'good', { sid: 'a', pct: 80, sec: 80 }),
      session('alice', 'good', { sid: 'b', pct: 90, sec: 90 }),
      session('alice', 'good', { sid: 'c', pct: 20, sec: 20, maxPos: 5 }),
    ]);

    const { msg } = await runWorker();

    expect(msg).toMatchObject({ ok: true, videos: 1, droppedPlaceholders: 0, removed: 0, healedDurations: 0 });
    const doc = (await byId()).get('alice/good');
    expect(doc).toMatchObject({
      owner: 'alice',
      permlink: 'good',
      sessions: 3,
      viewers: 3,
      avgWatchedPct: 63.3,
      completionRate: 0.667,   // 80 and 90 reach 70%
      engagedRate: 0.667,      // 20 is under the 30% bar
      hookRate: 0.667,         // 5 of 100 seconds is not past the first 15%
      avgContentSeconds: 63,
      duration: 100,
      band: 's',
      replayIntensity: 1,
    });
    expect(doc.runAt).toBeInstanceOf(Date);
  });

  test('a replayed session (same sid) is one viewer but two sessions', async () => {
    await watch().insertMany([
      session('a', 'p', { sid: 'same', pct: 50, sec: 50 }),
      session('a', 'p', { sid: 'same', pct: 60, sec: 60 }),
    ]);
    await runWorker();
    expect((await byId()).get('a/p')).toMatchObject({ viewers: 1, sessions: 2 });
  });

  test('a video people finish scores above one they leave, in the same length band', async () => {
    const rows = [];
    for (let i = 0; i < 10; i += 1) {
      rows.push(session('a', 'kept', { sid: `k${i}`, pct: 95, sec: 95 }));
      rows.push(session('a', 'left', { sid: `l${i}`, pct: 10, sec: 10, maxPos: 3 }));
    }
    await watch().insertMany(rows);

    const { msg } = await runWorker();

    const s = await byId();
    expect(s.get('a/kept').score).toBeGreaterThan(1);
    expect(s.get('a/left').score).toBeLessThan(1);
    expect(msg.globalMean).toBeGreaterThan(0);
  });
});

describe('what counts as a session', () => {
  test('junk sessions under the minimum and rows outside the 90-day window are ignored', async () => {
    await watch().insertMany([
      session('a', 'p', { sid: 'real', pct: 50, sec: 50 }),
      session('a', 'p', { sid: 'blip', pct: 1, sec: 1 }),                    // under 2 s
      session('a', 'p', { sid: 'old', pct: 90, sec: 90, at: daysAgo(120) }), // outside the window
      session('b', 'only-old', { sid: 'x', pct: 90, sec: 90, at: daysAgo(91) }),
    ]);

    await runWorker();

    const s = await byId();
    expect(s.get('a/p')).toMatchObject({ sessions: 1, viewers: 1 });
    expect(s.has('b/only-old')).toBe(false);
  });

  test('an older row with only watchedSeconds still counts (no contentSeconds)', async () => {
    await watch().insertOne({
      owner: 'a', permlink: 'legacy', sid: 's', watchedSeconds: 40, watchedPct: 40,
      videoDuration: 100, maxPosition: 40, updatedAt: daysAgo(2),
    });
    await runWorker();
    expect((await byId()).get('a/legacy')).toMatchObject({ sessions: 1, avgContentSeconds: 40 });
  });
});

describe('videos the player cannot serve', () => {
  test.each(['deleted', 'self_deleted', 'encoding_ipfs', 'uploaded', 'failed', 'ENCODING_FAILED'])(
    'a %s video is left out of the scores (it only ever played a placeholder clip)',
    async (status) => {
      await db().collection('videos').insertOne({ owner: 'a', permlink: 'dead', status });
      await watch().insertMany([
        session('a', 'dead', { sid: 'x', pct: 5, sec: 6 }),
        session('a', 'alive', { sid: 'y', pct: 60, sec: 60 }),
      ]);

      const { msg } = await runWorker();

      expect(msg).toMatchObject({ videos: 1, droppedPlaceholders: 1 });
      expect([...(await byId()).keys()]).toEqual(['a/alive']);
    },
  );

  test('the embed record wins over a legacy one with the same key', async () => {
    await db().collection('videos').insertOne({ owner: 'a', permlink: 'p', status: 'deleted' });
    await db().collection('embed-video').insertOne({ owner: 'a', permlink: 'p', status: 'published' });
    await watch().insertOne(session('a', 'p', { sid: 's', pct: 50, sec: 50 }));

    const { msg } = await runWorker();

    expect(msg).toMatchObject({ videos: 1, droppedPlaceholders: 0 });
  });

  test('when every watched video is a placeholder nothing is scored', async () => {
    await db().collection('embed-video').insertOne({ owner: 'a', permlink: 'p', status: 'encoding_ipfs' });
    await watch().insertOne(session('a', 'p', { sid: 's', pct: 50, sec: 50 }));

    const { msg, code } = await runWorker();

    expect(msg).toMatchObject({ ok: true, videos: 0, droppedPlaceholders: 1 });
    expect(code).toBe(0);
    expect(await scores().countDocuments()).toBe(0);
  });
});

describe('mis-tracked durations', () => {
  test('a tracked duration under half the real one is replaced by the real one', async () => {
    await db().collection('embed-video').insertMany([
      { owner: 'a', permlink: 'race', status: 'published', duration: 120 },
      { owner: 'a', permlink: 'fine', status: 'published', duration: 120 },
    ]);
    await watch().insertMany([
      session('a', 'race', { sid: 's', pct: 50, sec: 3, dur: 6, maxPos: 3 }),
      session('a', 'fine', { sid: 't', pct: 50, sec: 50, dur: 100 }),
    ]);

    const { msg } = await runWorker();

    const s = await byId();
    expect(msg.healedDurations).toBe(1);
    expect(s.get('a/race')).toMatchObject({ duration: 120, band: 's' });
    expect(s.get('a/fine')).toMatchObject({ duration: 100 });
  });
});

describe('replay intensity', () => {
  test.each([
    ['a heatmap with a rewatched moment', [1, 1, 1, 1, 1, 5], 3],   // max 5 / mean of non-zero 10/6
    ['a flat heatmap', [2, 2, 2, 2, 2], 1],
    ['too few watched buckets to say', [9, 0, 0, 1], 1],
    ['an extreme spike is capped at 5', [1, 1, 1, 1, 1, 1, 1, 1, 1, 1000], 5],
  ])('%s', async (_name, buckets, expected) => {
    await watch().insertOne(session('a', 'p', { sid: 's', pct: 50, sec: 50 }));
    await db().collection('view-heatmaps').insertOne({ owner: 'a', permlink: 'p', buckets });

    await runWorker();

    expect((await byId()).get('a/p').replayIntensity).toBe(expected);
  });
});

describe('refreshing the cache', () => {
  test('a video that left the window loses its old score; a second run changes nothing', async () => {
    await scores().insertOne({ _id: 'gone/video', score: 2, runAt: daysAgo(1) });
    await watch().insertMany([
      session('a', 'p', { sid: 's1', pct: 70, sec: 70 }),
      session('b', 'q', { sid: 's2', pct: 30, sec: 30 }),
    ]);

    const first = await runWorker();
    const after1 = await scores().find({}, { projection: { runAt: 0 } }).sort({ _id: 1 }).toArray();
    const second = await runWorker();
    const after2 = await scores().find({}, { projection: { runAt: 0 } }).sort({ _id: 1 }).toArray();

    expect(first.msg.removed).toBe(1);
    expect(after1.map((d) => d._id)).toEqual(['a/p', 'b/q']);
    expect(second.msg).toMatchObject({ ok: true, videos: 2, removed: 0 });
    expect(after2).toEqual(after1);
  });
});

describe('when it cannot run', () => {
  test('a broken database address is reported to the parent and the thread exits 1', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { msg, code } = await runWorker({ MONGODB_URI: 'not-a-mongo-uri' });
    expect(msg.ok).toBe(false);
    expect(msg.error).toMatch(/Invalid scheme|mongodb/i);
    expect(code).toBe(1);
    err.mockRestore();
  });
});
