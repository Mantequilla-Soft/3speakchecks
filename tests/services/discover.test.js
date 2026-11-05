/**
 * Discover pool scheduler (services/discover.js): spawns the discover worker thread on a
 * timer, never runs two at once, and always releases its "running" guard (spawn
 * failure, crash, non-zero exit). The Worker class is a fake, so no thread starts.
 */
jest.mock('worker_threads', () => {
  const { EventEmitter } = require('events');
  class FakeWorker extends EventEmitter {
    constructor(file) {
      super();
      if (FakeWorker.failNext) { FakeWorker.failNext = false; throw new Error('cannot spawn'); }
      this.file = file;
      FakeWorker.spawned.push(this);
    }
  }
  FakeWorker.spawned = [];
  FakeWorker.failNext = false;
  return { Worker: FakeWorker };
});

const path = require('path');
const { Worker } = require('worker_threads');
const testDb = require('../helpers/db');

const db = testDb.use();
const mod = require('../../services/discover');

const ERR = () => jest.spyOn(console, 'error').mockImplementation(() => {});

// Finish whatever run a test left open, so the module guard starts clear.
afterEach(() => {
  for (const w of Worker.spawned) w.emit('exit', 0);
  Worker.spawned.length = 0;
  Worker.failNext = false;
});

describe('one run at a time', () => {
  test('runOnce spawns the worker file next to the service', () => {
    mod.runOnce();
    expect(Worker.spawned).toHaveLength(1);
    expect(Worker.spawned[0].file).toBe(path.join(__dirname, '../../services/discoverWorker.js'));
  });

  test('a tick while the previous run is still going spawns nothing', () => {
    mod.runOnce();
    mod.runOnce();
    expect(Worker.spawned).toHaveLength(1);
  });

  test('after the worker exits the next tick runs again', () => {
    mod.runOnce();
    Worker.spawned[0].emit('exit', 0);
    mod.runOnce();
    expect(Worker.spawned).toHaveLength(2);
  });

  test('a crash (non-zero exit) also releases the guard, and is logged', () => {
    const err = ERR();
    mod.runOnce();
    Worker.spawned[0].emit('error', new Error('boom'));
    Worker.spawned[0].emit('exit', 1);
    mod.runOnce();
    expect(Worker.spawned).toHaveLength(2);
    expect(err.mock.calls.map((c) => c.join(' ')).join('\n')).toMatch(/boom[\s\S]*exited with code 1/);
  });

  test('a spawn that throws does not leave the job stuck', () => {
    const err = ERR();
    Worker.failNext = true;
    mod.runOnce();
    expect(Worker.spawned).toHaveLength(0);
    mod.runOnce();
    expect(Worker.spawned).toHaveLength(1);
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/failed to spawn/), 'cannot spawn');
  });
});

describe('the worker report', () => {
  test.each([
    ['a success is logged, not reported as an error', { ok: true, pool: 3, ms: 5, sources: { recent: 1, random: 1, retention: 1 }, skipped: 0, removed: 0 }, 0],
    ['a failure message is reported', { ok: false, error: 'mongo down' }, 1],
    ['an empty message counts as a failure', null, 1],
  ])('%s', (_name, msg, errors) => {
    const err = ERR();
    mod.runOnce();
    Worker.spawned[0].emit('message', msg);
    expect(err).toHaveBeenCalledTimes(errors);
    if (errors) expect(err.mock.calls[0][0]).toMatch(/worker reported failure/);
  });
});

describe('scheduling', () => {
  // Timer calls with the scheduler's own delays are captured; everything else
  // (the Mongo driver's timers) goes to the real functions.
  function captureTimers(delays) {
    const realTimeout = global.setTimeout;
    const realInterval = global.setInterval;
    const captured = [];
    jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms, ...rest) => {
      if (delays.includes(ms)) { captured.push({ kind: 'timeout', fn, ms }); return 0; }
      return realTimeout(fn, ms, ...rest);
    });
    jest.spyOn(global, 'setInterval').mockImplementation((fn, ms, ...rest) => {
      if (delays.includes(ms)) { captured.push({ kind: 'interval', fn, ms }); return 0; }
      return realInterval(fn, ms, ...rest);
    });
    return captured;
  }

  test('ensures the indexes, then a first run 15 seconds after boot and one every 60 minutes', async () => {
    const timers = captureTimers([15 * 1000, 60 * 60 * 1000]);

    await mod.scheduleDiscover();

    expect(timers.map(({ kind, ms }) => [kind, ms])).toEqual([
      ['timeout', 15 * 1000],
      ['interval', 60 * 60 * 1000],
    ]);
    const keys = (await db().collection('discover-pool').indexes()).map((i) => Object.keys(i.key).join(','));
    expect(keys).toEqual(expect.arrayContaining(['runAt', 'base']));

    // Both timers start a run.
    timers[0].fn();
    expect(Worker.spawned).toHaveLength(1);
    Worker.spawned[0].emit('exit', 0);
    timers[1].fn();
    expect(Worker.spawned).toHaveLength(2);
  });

  test('an index failure is only a warning: the job is still scheduled', async () => {
    const timers = captureTimers([15 * 1000, 60 * 60 * 1000]);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const shared = require('../../utils/db');
    jest.spyOn(shared, 'getDb').mockImplementation(() => { throw new Error('no db'); });
    const isolated = load({});

    await isolated.scheduleDiscover();

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/index ensure failed/), 'no db');
    expect(timers).toHaveLength(2);
  });

  test.each([
    ['DISCOVER_ENABLED', 'false'],
    ['ENABLE_MONGO_WRITES', 'false'],
  ])('%s=%s schedules nothing', async (name, value) => {
    const timers = captureTimers([15 * 1000, 60 * 60 * 1000]);
    const isolated = load({ [name]: value });
    await isolated.scheduleDiscover();
    expect(timers).toHaveLength(0);
  });
});

// A fresh copy of the service read with extra environment, sharing this file's
// utils/db and fake Worker.
function load(env) {
  const sharedDb = require('../../utils/db');
  let m;
  jest.isolateModules(() => {
    Object.assign(process.env, env);
    try {
      jest.doMock('../../utils/db', () => sharedDb);
      m = require('../../services/discover');
    } finally {
      for (const k of Object.keys(env)) delete process.env[k];
    }
  });
  return m;
}
