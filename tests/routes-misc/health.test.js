/**
 * routes/health.js: GET /healthz drives the frontend's maintenance screen, so it
 * must report an OUTAGE, not a blip. It caches the Mongo ping for 8 s and only says
 * ok:false after at least 3 failed pings spread over at least 30 s.
 *
 * The cache and the failure streak are module state, so each test loads a fresh
 * copy of the router (sharing this file's connected database layer).
 */
const request = require('supertest');
const { Db } = require('mongodb');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const { NOW } = require('./_fixtures');

testDb.use();
const T = NOW.getTime();

function freshApp(dbModule) {
  let router;
  jest.isolateModules(() => {
    const shared = dbModule || require('../../utils/db');
    jest.doMock('../../utils/db', () => shared);
    router = require('../../routes/health');
  });
  jest.dontMock('../../utils/db'); // the harness must get the real layer back in afterAll
  return buildApp(['/', router]);
}
// What the app's database layer is in this file (connected by testDb.use()).
let connectedDb;
beforeAll(() => { connectedDb = require('../../utils/db'); });

const healthz = (app) => request(app).get('/healthz').expect(200).then((r) => r.body);
const pingFails = () => jest.spyOn(Db.prototype, 'command').mockRejectedValue(new Error('network drop'));

// Date AND setTimeout are fake here: every ping races a 1.5 s timeout that the
// route never clears (routes/health.js:31-35), and a real one would keep the
// Jest worker alive after the file ends. The driver and supertest do not wait on
// global timers, so faking them is safe.
beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'hrtime', 'performance'] }));
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  delete process.env.MAINTENANCE_MODE;
});

test('GET / names the service and its main endpoints', async () => {
  const res = await request(freshApp(connectedDb)).get('/').expect(200);
  expect(res.body).toMatchObject({ message: 'Pancreas API is running', version: expect.any(String) });
  expect(res.body.endpoints.feed).toMatch(/^GET \/feed/);
});

describe('GET /healthz', () => {
  test('a live database is ok:true, mongo up, fresh', async () => {
    expect(await healthz(freshApp(connectedDb))).toEqual({ ok: true, maintenance: false, mongo: 'up', cached: false, ts: T });
  });

  test('answers from cache for 8 seconds, then pings again', async () => {
    const app = freshApp(connectedDb);
    const ping = jest.spyOn(Db.prototype, 'command');
    await healthz(app);
    jest.setSystemTime(T + 7999);
    expect(await healthz(app)).toMatchObject({ cached: true, ts: T, ok: true });
    jest.setSystemTime(T + 8000);
    expect(await healthz(app)).toMatchObject({ cached: false, ts: T + 8000 });
    expect(ping).toHaveBeenCalledTimes(2);
  });

  test('MAINTENANCE_MODE=true forces the maintenance screen without touching Mongo', async () => {
    process.env.MAINTENANCE_MODE = 'TRUE';
    const ping = jest.spyOn(Db.prototype, 'command');
    expect(await healthz(freshApp(connectedDb))).toEqual({ ok: false, maintenance: true, mongo: 'n/a', ts: T });
    expect(ping).not.toHaveBeenCalled();
  });

  test('one failed ping is a blip: ok stays true, mongo is "degraded"', async () => {
    pingFails();
    expect(await healthz(freshApp(connectedDb))).toMatchObject({ ok: true, mongo: 'degraded' });
  });

  test('ok:false only once the failures have lasted 30 s and numbered at least 3', async () => {
    const app = freshApp(connectedDb);
    pingFails();
    const at = async (ms) => { jest.setSystemTime(T + ms); return healthz(app); };

    expect(await at(0)).toMatchObject({ ok: true, mongo: 'degraded' });       // fail 1
    expect(await at(9000)).toMatchObject({ ok: true, mongo: 'degraded' });    // fail 2
    expect(await at(18000)).toMatchObject({ ok: true, mongo: 'degraded' });   // fail 3, only 18 s
    expect(await at(30000)).toMatchObject({ ok: false, mongo: 'down' });      // fail 4, 30 s
    expect(await at(31000)).toMatchObject({ ok: false, cached: true });       // the outage is cached too
  });

  test('two failures 40 s apart are still not an outage (too few pings)', async () => {
    const app = freshApp(connectedDb);
    pingFails();
    await healthz(app);
    jest.setSystemTime(T + 40000);
    expect(await healthz(app)).toMatchObject({ ok: true, mongo: 'degraded' });
  });

  test('one good ping ends the streak: the count starts again from zero', async () => {
    const app = freshApp(connectedDb);
    const fail = pingFails();
    for (const ms of [0, 10000, 20000, 30000]) { jest.setSystemTime(T + ms); await healthz(app); }
    fail.mockRestore();
    jest.setSystemTime(T + 40000);
    expect(await healthz(app)).toMatchObject({ ok: true, mongo: 'up' });

    pingFails();
    jest.setSystemTime(T + 50000);
    expect(await healthz(app)).toMatchObject({ ok: true, mongo: 'degraded' });
  });

  test('a hanging database is given up on after 1.5 s and reported as degraded', async () => {
    const app = freshApp(connectedDb);
    const ping = jest.spyOn(Db.prototype, 'command').mockReturnValue(new Promise(() => {}));
    const pending = request(app).get('/healthz');
    const answered = pending.then((r) => r.body);
    while (!ping.mock.calls.length) await new Promise((r) => setImmediate(r));
    await jest.advanceTimersByTimeAsync(1499);
    let settled = false;
    answered.then(() => { settled = true; });
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(await answered).toMatchObject({ ok: true, mongo: 'degraded' });
  });

  test('a database layer that never connected counts as a failed ping, not a crash', async () => {
    const app = freshApp({ getDb: () => { throw new Error('not connected'); } });
    expect(await healthz(app)).toMatchObject({ ok: true, mongo: 'degraded', cached: false });
  });
});
