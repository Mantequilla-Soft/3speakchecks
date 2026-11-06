/**
 * Pulse hot set against a real MongoDB (services/pulseHotSet.js): the watch
 * aggregation itself (window, junk-session filter, distinct viewer keys,
 * threshold), a full build from view-durations to the list, and the in-memory
 * refresh that keeps the previous list when a build fails. Selection rules and
 * the route are covered with a fake database in tests/pulseHotSet.test.js.
 */
const { Collection } = require('mongodb');
const testDb = require('../helpers/db');
const { NOW, HOUR, DAY, ago } = require('./_fixtures');
const {
  aggregateWatched, buildHotSet, refreshOnce, getHotSet, schedulePulseHotSet, _setHotSet,
} = require('../../services/pulseHotSet');

const db = testDb.use();
const watches = () => db().collection('view-durations');

const REAL_TIMERS = ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'];
beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: REAL_TIMERS });
  _setHotSet(null);
});
afterEach(() => jest.useRealTimers());

const watch = (owner, permlink, key, extra = {}) => ({
  owner, permlink, sid: key, contentSeconds: 30, updatedAt: ago(HOUR), ...extra,
});
const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));

describe('the watch aggregation', () => {
  const cutoff = ago(48 * HOUR);

  test('counts distinct sessions per video inside the window and applies the threshold', async () => {
    await watches().insertMany([
      ...many(5, (i) => watch('alice', 'hot', `s${i}`)),
      watch('alice', 'hot', 's0'),                                     // a replay of the same session
      ...many(4, (i) => watch('alice', 'warm', `s${i}`)),
      ...many(5, (i) => watch('alice', 'old', `s${i}`, { updatedAt: ago(49 * HOUR) })),
    ]);

    const rows = await aggregateWatched(db(), { cutoff, minSessions: 5 });

    expect(rows).toEqual([{ owner: 'alice', permlink: 'hot', sessions: 5, lastWatchedAt: ago(HOUR) }]);
  });

  test('a viewer id beats an IP, which beats a session id, as the counting key', async () => {
    await watches().insertMany([
      watch('a', 'p', 's1', { viewerId: 'v1' }),
      watch('a', 'p', 's2', { viewerId: 'v1' }),        // same viewer, two sessions: 1
      watch('a', 'p', 's3', { ip: 'ip1' }),
      watch('a', 'p', 's4', { ip: 'ip1' }),             // same address: 1
      watch('a', 'p', 's5'),                            // sid only: 1
    ]);
    const [row] = await aggregateWatched(db(), { cutoff, minSessions: 1 });
    expect(row.sessions).toBe(3);
  });

  test('junk sessions under the minimum length are dropped; watchedSeconds is the fallback length', async () => {
    await watches().insertMany([
      watch('a', 'p', 's1', { contentSeconds: 1 }),
      watch('a', 'p', 's2', { contentSeconds: undefined, watchedSeconds: 1.5 }),
      watch('a', 'p', 's3', { contentSeconds: undefined }),            // no length at all
      watch('a', 'p', 's4', { contentSeconds: undefined, watchedSeconds: 10 }),
      watch('a', 'p', 's5', { contentSeconds: 2 }),
    ]);
    const [row] = await aggregateWatched(db(), { cutoff, minSessions: 1 });
    expect(row.sessions).toBe(2);
  });

  test('lastWatchedAt is the latest watch of the video', async () => {
    await watches().insertMany([watch('a', 'p', 's1', { updatedAt: ago(5 * HOUR) }), watch('a', 'p', 's2', { updatedAt: ago(2 * HOUR) })]);
    const [row] = await aggregateWatched(db(), { cutoff, minSessions: 1 });
    expect(row.lastWatchedAt).toEqual(ago(2 * HOUR));
  });
});

describe('a full build', () => {
  test('from watch log to list: old published videos, most watched first, hidden creators out', async () => {
    await watches().insertMany([
      ...many(7, (i) => watch('alice', 'embed-old', `s${i}`)),
      ...many(6, (i) => watch('bob', 'legacy-old', `s${i}`)),
      ...many(9, (i) => watch('alice', 'embed-new', `s${i}`)),
      ...many(9, (i) => watch('hidden', 'p', `s${i}`)),
    ]);
    await db().collection('embed-video').insertMany([
      { owner: 'alice', permlink: 'embed-old', hive_author: 'alice', status: 'published', createdAt: ago(200 * DAY) },
      { owner: 'alice', permlink: 'embed-new', hive_author: 'alice', status: 'published', createdAt: ago(3 * DAY) },
      { owner: 'hidden', permlink: 'p', hive_author: 'hidden', status: 'published', createdAt: ago(200 * DAY) },
    ]);
    await db().collection('videos').insertOne({ owner: 'bob', permlink: 'legacy-old', status: 'published', created: ago(400 * DAY) });

    const { body, stats } = await buildHotSet(db(), { now: NOW, hiddenCreators: new Set(['hidden']) });

    expect(body).toEqual({
      generatedAt: NOW.toISOString(), windowHours: 48, minSessions: 5, count: 2,
      videos: [
        { collection: 'embed-video', owner: 'alice', permlink: 'embed-old', sessions: 7, lastWatchedAt: ago(HOUR) },
        { collection: 'videos', owner: 'bob', permlink: 'legacy-old', sessions: 6, lastWatchedAt: ago(HOUR) },
      ],
    });
    expect(stats).toEqual({ watched: 4, skipped: { unpublished: 0, banned: 0, unavailable: 0, hidden: 1, young: 1, overLimit: 0 } });
  });

  test('with no hidden set given, the moderation list is read from the database', async () => {
    const { body } = await buildHotSet(db(), { now: NOW });
    expect(body.count).toBe(0);
  });
});

describe('the in-memory list', () => {
  async function seedOneHotVideo() {
    await watches().insertMany(many(5, (i) => watch('alice', 'p', `s${i}`)));
    await db().collection('embed-video').insertOne({ owner: 'alice', permlink: 'p', status: 'published', createdAt: ago(100 * DAY) });
  }

  test('is null until the first build, then holds the built list', async () => {
    expect(getHotSet()).toBeNull();
    await seedOneHotVideo();
    await refreshOnce();
    expect(getHotSet()).toMatchObject({ count: 1, videos: [{ owner: 'alice', permlink: 'p' }] });
  });

  test('a failed rebuild keeps serving the previous list', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await seedOneHotVideo();
    await refreshOnce();
    const previous = getHotSet();

    jest.spyOn(Collection.prototype, 'aggregate').mockImplementation(() => { throw new Error('maxTimeMS expired'); });
    await refreshOnce();

    expect(getHotSet()).toBe(previous);
    expect(console.error).toHaveBeenCalledWith('[pulse-hot-set] build failed, keeping the previous list:', 'maxTimeMS expired');
  });

  test('a failed first build stays null (the route answers 503, never an empty list)', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(Collection.prototype, 'aggregate').mockImplementation(() => { throw new Error('down'); });
    await refreshOnce();
    expect(getHotSet()).toBeNull();
  });

  test('a tick while a build is still running is skipped', async () => {
    let release;
    jest.spyOn(Collection.prototype, 'aggregate').mockImplementationOnce(() => ({
      toArray: () => new Promise((r) => { release = () => r([]); }),
    }));
    const first = refreshOnce();
    await refreshOnce();                              // skipped: does not wait for the first
    expect(Collection.prototype.aggregate).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(getHotSet()).toMatchObject({ count: 0 });
  });

  test('is not scheduled while PULSE_HOTSET_ENABLED is off (the default)', () => {
    const timeout = jest.spyOn(global, 'setTimeout');
    const interval = jest.spyOn(global, 'setInterval');
    schedulePulseHotSet();
    expect(timeout).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
  });

  test('when enabled, builds a minute after boot and then every PULSE_HOTSET_INTERVAL_MIN', () => {
    let mod;
    process.env.PULSE_HOTSET_ENABLED = 'true';
    process.env.PULSE_HOTSET_INTERVAL_MIN = '15';
    try {
      jest.isolateModules(() => { mod = require('../../services/pulseHotSet'); });
    } finally {
      delete process.env.PULSE_HOTSET_ENABLED;
      delete process.env.PULSE_HOTSET_INTERVAL_MIN;
    }
    const timeout = jest.spyOn(global, 'setTimeout').mockImplementation(() => 0);
    const interval = jest.spyOn(global, 'setInterval').mockImplementation(() => 0);

    mod.schedulePulseHotSet();

    expect(timeout).toHaveBeenCalledWith(mod.refreshOnce, 60 * 1000);
    expect(interval).toHaveBeenCalledWith(mod.refreshOnce, 15 * 60 * 1000);
  });
});
