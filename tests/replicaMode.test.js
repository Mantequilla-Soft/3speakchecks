/**
 * Several checker instances on one Mongo: only the BACKGROUND_JOBS instance may run
 * the shared jobs, and every instance answers /health/latency for the frontend's
 * instance pick.
 */
const fs = require('fs');
const path = require('path');
const request = require('supertest');

jest.mock('../utils/db', () => {
  const command = jest.fn();
  return { getDb: () => ({ command }), __command: command };
});

const { buildApp } = require('./helpers/app');

describe('BACKGROUND_JOBS', () => {
  const load = (value) => {
    jest.resetModules();
    if (value === undefined) delete process.env.BACKGROUND_JOBS;
    else process.env.BACKGROUND_JOBS = value;
    return require('../utils/config').BACKGROUND_JOBS;
  };
  afterAll(() => { delete process.env.BACKGROUND_JOBS; jest.resetModules(); });

  test('on unless set to exactly "false", so a lone instance behaves as before', () => {
    expect(load(undefined)).toBe(true);
    expect(load('')).toBe(true);
    expect(load('true')).toBe(true);
    expect(load('false')).toBe(false);
  });
});

describe('server.js job gate', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const gate = src.indexOf('if (!BACKGROUND_JOBS)');
  const at = (needle) => {
    const i = src.indexOf(needle);
    if (i < 0) throw new Error(`not found in server.js: ${needle}`);
    return i;
  };

  test('the gate exists', () => {
    expect(gate).toBeGreaterThan(0);
  });

  // Each of these moves money, broadcasts to Hive or rewrites shared rows. Above the
  // gate it would run once per instance: double payouts, double posts.
  test.each([
    'scheduleAudioPayouts()',
    'scheduleScheduledPosts()',
    'scheduleCollectSubs()',
    'scheduleVerifiedFollow()',
    'adPayouts.schedule()',
    'adPaymentWatch.runOnce()',
    'lightningSupports.runOnce()',
    'podpingFeeds.runOnce()',
    'syncPremiumFromSubs()',
    'calculateAndFlagTrendingVideos()',
    'startTagSyncWatcher()',
    'scheduleRetention()',
    'scheduleDiscover()',
    'scheduleListenConsolidation()',
    'scheduleWatchRetention()',
    'susScan.runOnce()',
    'pushNotify.runOnce()',
  ])('%s runs only behind the gate', (call) => {
    expect(at(call)).toBeGreaterThan(gate);
  });

  // Per-process state the routes answer from: every instance needs it.
  test.each([
    'startFeedPoolWarmer(getDb)',
    'adSettings.schedule()',
    'podcastFeeds.start({ shared: BACKGROUND_JOBS })',
  ])('%s runs on every instance', (call) => {
    expect(at(call)).toBeLessThan(gate);
  });
});

describe('GET /health/latency', () => {
  // The route and the mock from ONE module registry (the block above resets it).
  let db;
  let app;
  beforeEach(() => {
    jest.resetModules();
    db = require('../utils/db');
    const router = require('../routes/health');
    app = () => buildApp(['/', router]);
  });

  test('one Mongo round trip, reported as db_ms, never cached', async () => {
    db.__command.mockResolvedValue({ ok: 1 });
    const res = await request(app()).get('/health/latency').expect(200);
    expect(db.__command).toHaveBeenCalledTimes(1);
    expect(db.__command).toHaveBeenCalledWith({ ping: 1 });
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.db_ms).toBe('number');
    expect(res.body.db_ms).toBeGreaterThanOrEqual(0);
    expect(typeof res.body.instance).toBe('string');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  test('every request pings again (a cached answer would hide the trip)', async () => {
    db.__command.mockResolvedValue({ ok: 1 });
    await request(app()).get('/health/latency').expect(200);
    await request(app()).get('/health/latency').expect(200);
    expect(db.__command).toHaveBeenCalledTimes(2);
  });

  test('503 when the database does not answer, so the client picks another instance', async () => {
    db.__command.mockRejectedValue(new Error('no primary'));
    const res = await request(app()).get('/health/latency').expect(503);
    expect(res.body.ok).toBe(false);
  });
});
