/**
 * Listening time (routes/audioListen.js): what one beat credits, without Mongo.
 * The rules match video watch time, so the two can be compared.
 */
const { _test: L } = require('../routes/audioListen');

const T0 = Date.parse('2026-10-30T12:00:00Z');
const session = (extra = {}) => ({
  duration: 600, bucketCount: 100, lastPosition: 0, maxPosition: 0, coveredBuckets: [],
  accumulatedMs: 0, contentMs: 0, hiddenContentMs: 0, rateSum: 0, rateBeats: 0,
  lastBeatAt: new Date(T0), ...extra,
});

describe('a beat', () => {
  test('ten seconds of playback credits ten seconds and the slices it passed', () => {
    const b = L.applyBeat(session(), { now: T0 + 10000, position: 10, rate: 1 });
    expect(b.counted).toBe(true);
    expect(b.stats).toEqual({ listenedSeconds: 10, contentSeconds: 10, listenedPct: 2 });
    expect(Object.keys(b.incs)).toEqual(['buckets.0', 'buckets.1']);
  });

  test('a late beat credits at most the cap, idle time is not listening', () => {
    const b = L.applyBeat(session(), { now: T0 + 10 * 60 * 1000, position: 12 });
    expect(b.state.accumulatedMs).toBe(L.MAX_BEAT_CREDIT_MS);
  });

  test('a seek forward or a rewind credits nothing', () => {
    expect(L.applyBeat(session(), { now: T0 + 10000, position: 400 }).counted).toBe(false);
    const back = L.applyBeat(session({ lastPosition: 300, maxPosition: 300 }), { now: T0 + 10000, position: 100 });
    expect(back.counted).toBe(false);
    expect(back.stats.listenedSeconds).toBe(0);
    expect(back.state.lastPosition).toBe(100);
  });

  test('2x speed counts double audio in the same wall time', () => {
    const b = L.applyBeat(session(), { now: T0 + 10000, position: 20, rate: 2 });
    expect(b.stats.listenedSeconds).toBe(10);
    expect(b.stats.contentSeconds).toBe(20);
  });

  test('coverage counts distinct slices: replaying the same part does not raise it', () => {
    const covered = Array.from({ length: 50 }, (_, i) => i);
    const again = L.applyBeat(session({ coveredBuckets: covered, lastPosition: 0 }), { now: T0 + 10000, position: 10 });
    expect(again.stats.listenedPct).toBe(50);
  });

  test('a hidden tab still counts (audio runs in the background) and is noted', () => {
    const b = L.applyBeat(session(), { now: T0 + 10000, position: 10, hidden: true });
    expect(b.stats.contentSeconds).toBe(10);
    expect(b.state.hiddenContentMs).toBe(10000);
  });

  test('a silly playback rate is not averaged in', () => {
    expect(L.applyBeat(session(), { now: T0 + 10000, position: 10, rate: 50 }).state.rateBeats).toBe(0);
  });
});

describe('helpers', () => {
  test('the player duration wins unless it is under half the stored one', () => {
    expect(L.resolveDuration(590, 600)).toBe(590);
    expect(L.resolveDuration(6, 600)).toBe(600);
    expect(L.resolveDuration(undefined, 600)).toBe(600);
    expect(L.resolveDuration(0, 0)).toBe(0);
  });

  test('sources are short slugs, the embed when unnamed', () => {
    expect(L.normalizeSource('3Speak')).toBe('3speak');
    expect(L.normalizeSource('')).toBe('embed');
    expect(L.normalizeSource('<script>')).toBe('script');
  });

  test('the client address is the one nginx saw', () => {
    expect(L.clientIp({ headers: { 'x-real-ip': '1.2.3.4' }, ip: '127.0.0.1' })).toBe('1.2.3.4');
    expect(L.clientIp({ headers: { 'x-forwarded-for': '5.6.7.8, 10.0.0.1' }, ip: '127.0.0.1' })).toBe('5.6.7.8');
    expect(L.clientIp({ headers: {}, ip: '127.0.0.1' })).toBe('127.0.0.1');
  });
});
