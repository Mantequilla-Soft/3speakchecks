/**
 * Watch-time storage window (services/watchRetention.js): watch rows age out by
 * their OWN last activity, stale sessions go with them, and a "most replayed"
 * heatmap is dropped only once its video has no watch rows left. Runs against the
 * real test MongoDB; the clock is fixed by stubbing Date.now.
 */
jest.mock('node-cron', () => ({ schedule: jest.fn() }));

const cron = require('node-cron');
const { waitUntil } = require('../helpers/wait');
const testDb = require('../helpers/db');
const { NOW, DAY } = require('./_fixtures');

const db = testDb.use();
const { purgeOldWatchRecords, schedule } = require('../../services/watchRetention');

const ago = (days) => new Date(NOW.getTime() - days * DAY);
const rows = () => db().collection('view-durations');
const sessions = () => db().collection('view-sessions');
const heatmaps = () => db().collection('view-heatmaps');

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW.getTime());
});

describe('purging watch rows', () => {
  test('a row older than a year goes, a fresh row of an OLD video stays', async () => {
    await rows().insertMany([
      { owner: 'alice', permlink: 'old', sid: 's1', updatedAt: ago(400) },
      { owner: 'alice', permlink: 'old', sid: 's2', updatedAt: ago(3) },     // rewatched recently
      { owner: 'bob', permlink: 'gone', sid: 's3', updatedAt: ago(366) },
    ]);

    await purgeOldWatchRecords();

    const left = await rows().find({}, { projection: { _id: 0, sid: 1 } }).toArray();
    expect(left).toEqual([{ sid: 's2' }]);
  });

  test('a row exactly on the cutoff is kept (the window is "older than", not "at least")', async () => {
    await rows().insertOne({ owner: 'a', permlink: 'p', updatedAt: ago(365) });
    await purgeOldWatchRecords();
    expect(await rows().countDocuments()).toBe(1);
  });

  test('a session goes when either its start or its last beat is past the window', async () => {
    await sessions().insertMany([
      { _id: 'old-start', startedAt: ago(400), lastBeatAt: ago(1) },
      { _id: 'old-beat', startedAt: ago(1), lastBeatAt: ago(400) },
      { _id: 'fresh', startedAt: ago(2), lastBeatAt: ago(1) },
    ]);

    await purgeOldWatchRecords();

    expect((await sessions().find().toArray()).map((s) => s._id)).toEqual(['fresh']);
  });
});

describe('dropping heatmaps', () => {
  test('a heatmap stays while its video still has a watch row, and goes once none are left', async () => {
    await rows().insertMany([
      { owner: 'alice', permlink: 'live', updatedAt: ago(10) },
      { owner: 'bob', permlink: 'aged', updatedAt: ago(500) },
    ]);
    await heatmaps().insertMany([
      { owner: 'alice', permlink: 'live', buckets: [1, 2] },
      { owner: 'bob', permlink: 'aged', buckets: [3] },
      { owner: 'carol', permlink: 'never-watched', buckets: [4] },
    ]);

    await purgeOldWatchRecords();

    const kept = await heatmaps().find({}, { projection: { _id: 0, owner: 1 } }).toArray();
    expect(kept).toEqual([{ owner: 'alice' }]);
  });

  test('a heatmap is matched by owner AND permlink, not by owner alone', async () => {
    await rows().insertOne({ owner: 'alice', permlink: 'one', updatedAt: ago(1) });
    await heatmaps().insertMany([
      { owner: 'alice', permlink: 'one' },
      { owner: 'alice', permlink: 'two' },
    ]);
    await purgeOldWatchRecords();
    expect((await heatmaps().find().toArray()).map((h) => h.permlink)).toEqual(['one']);
  });
});

describe('running it again', () => {
  test('is a no-op: nothing more is deleted', async () => {
    await rows().insertMany([
      { owner: 'a', permlink: 'p', updatedAt: ago(1) },
      { owner: 'a', permlink: 'q', updatedAt: ago(800) },
    ]);
    await heatmaps().insertMany([{ owner: 'a', permlink: 'p' }, { owner: 'a', permlink: 'q' }]);

    await purgeOldWatchRecords();
    const first = {
      rows: await rows().countDocuments(),
      heat: await heatmaps().countDocuments(),
    };
    await purgeOldWatchRecords();

    expect(first).toEqual({ rows: 1, heat: 1 });
    expect(await rows().countDocuments()).toBe(1);
    expect(await heatmaps().countDocuments()).toBe(1);
  });

  test('an empty database is fine', async () => {
    await expect(purgeOldWatchRecords()).resolves.toBeUndefined();
  });
});

describe('switches and schedule', () => {
  test('with Mongo writes disabled nothing is deleted', async () => {
    await rows().insertOne({ owner: 'a', permlink: 'p', updatedAt: ago(900) });
    const readOnly = loadWith({ ENABLE_MONGO_WRITES: 'false' });

    await readOnly.purgeOldWatchRecords();

    expect(await rows().countDocuments()).toBe(1);
  });

  test('WATCH_RETENTION_DAYS shortens the window', async () => {
    await rows().insertMany([
      { owner: 'a', permlink: 'p', updatedAt: ago(40) },
      { owner: 'a', permlink: 'q', updatedAt: ago(10) },
    ]);
    const short = loadWith({ WATCH_RETENTION_DAYS: '30' });

    await short.purgeOldWatchRecords();

    expect((await rows().find().toArray()).map((r) => r.permlink)).toEqual(['q']);
  });

  test('schedule() indexes updatedAt, runs daily at 04:30 and once five minutes after boot', async () => {
    const realSetTimeout = global.setTimeout;
    const delayed = [];
    jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms, ...rest) => {
      if (ms === 5 * 60 * 1000) { delayed.push(fn); return 0; }
      return realSetTimeout(fn, ms, ...rest);
    });
    cron.schedule.mockClear();

    schedule();

    expect(cron.schedule).toHaveBeenCalledWith('30 4 * * *', expect.any(Function));
    expect(delayed).toHaveLength(1);

    // Both triggers run the same purge; each logs one summary line when done.
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const finished = () => log.mock.calls.filter(([m]) => /\[watch-retention\] purged/.test(m)).length;
    await rows().insertOne({ owner: 'a', permlink: 'p', updatedAt: ago(999) });
    cron.schedule.mock.calls[0][1]();
    delayed[0]();
    await waitFor(async () => finished() === 2);
    expect(await rows().countDocuments()).toBe(0);
    await waitFor(async () => {
      const idx = await rows().indexes();
      return idx.some((i) => i.key && i.key.updatedAt === 1);
    });
  });
});

// A fresh copy of the module read with extra environment, sharing this file's
// connected utils/db (an isolated registry would otherwise get an unconnected one).
function loadWith(env) {
  const sharedDb = require('../../utils/db');
  let mod;
  jest.isolateModules(() => {
    Object.assign(process.env, env);
    try {
      jest.doMock('../../utils/db', () => sharedDb);
      mod = require('../../services/watchRetention');
    } finally {
      for (const k of Object.keys(env)) delete process.env[k];
    }
  });
  return mod;
}

// Polls a database condition between event-loop turns (no fixed sleep).
const waitFor = (check) => waitUntil(check);
