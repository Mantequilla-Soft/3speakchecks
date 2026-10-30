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

describe('listener rewards (recording only)', () => {
  const base = { listener: 'alice', source: '3speak', private: false, kind: 'audio', id: 'abc', owner: 'bob' };

  test('only a named 3speak.tv listen from 50% heard, not private, not your own track', () => {
    expect(L.qualifies(base, { listenedPct: 50 })).toBe(true);
    expect(L.qualifies(base, { listenedPct: 49.9 })).toBe(false);
    expect(L.qualifies({ ...base, listener: null }, { listenedPct: 90 })).toBe(false);
    expect(L.qualifies({ ...base, source: 'embed' }, { listenedPct: 90 })).toBe(false);
    expect(L.qualifies({ ...base, private: true }, { listenedPct: 90 })).toBe(false);
    expect(L.qualifies({ ...base, owner: 'alice' }, { listenedPct: 90 })).toBe(false);
    // An outside episode has no 3Speak owner.
    expect(L.qualifies({ ...base, kind: 'podcast', owner: null }, { listenedPct: 90 })).toBe(true);
  });

  test('at most 60 minutes per item and 4 hours a day', () => {
    expect(L.creditSeconds(1800, 0)).toBe(1800);
    expect(L.creditSeconds(5400, 0)).toBe(3600);
    expect(L.creditSeconds(3600, 4 * 3600 - 600)).toBe(600);
    expect(L.creditSeconds(3600, 4 * 3600)).toBe(0);
  });

  test('a listener is only named for a vouched 3speak.tv listen with a Hive account', async () => {
    const now = Date.now();
    expect(await L.proveListener({ listener: 'alice', listenerSig: 'x', listenerTs: now }, 'embed')).toBeNull();
    expect(await L.proveListener({ listener: '~warmup', listenerSig: 'x', listenerTs: now }, '3speak')).toBeNull();
    expect(await L.proveListener({ listener: 'alice', listenerSig: 'x', listenerTs: now - 2 * 86400000 }, '3speak')).toBeNull();
    expect(L.listenVouchMessage('alice', 123)).toBe('3speak-podcasts|listen-vouch|alice|session|123');
  });

  describe('the ledger', () => {
    function fakeDb({ listenEnabled = true, todayOthers = 0 } = {}) {
      const writes = [];
      return {
        writes,
        collection: (name) => ({
          findOne: async () => (name === 'ad_viewer_prefs' ? { listenEnabled } : null),
          aggregate: () => ({ toArray: async () => (todayOthers ? [{ t: todayOthers }] : []) }),
          updateOne: async (q, u) => { writes.push({ q, u }); },
        }),
      };
    }
    const s = { ...base, feed_id: null };
    const now = new Date('2026-10-30T12:00:00Z');

    test('writes one row per listener and item, only ever raised', async () => {
      const db = fakeDb();
      await L.recordListenerReward(db, s, { listenedPct: 60, contentSeconds: 700 }, now);
      expect(db.writes).toHaveLength(1);
      const { q, u } = db.writes[0];
      expect(q).toEqual({ listener: 'alice', kind: 'audio', id: 'abc' });
      expect(u.$max).toEqual({ seconds: 700, listenedPct: 60 });
      expect(u.$setOnInsert).toMatchObject({ payoutId: null, day: '2026-10-30', source: '3speak' });
    });

    test('nothing for someone who did not agree to listening, or with today used up', async () => {
      const off = fakeDb({ listenEnabled: false });
      await L.recordListenerReward(off, s, { listenedPct: 90, contentSeconds: 700 }, now);
      const full = fakeDb({ todayOthers: 4 * 3600 });
      await L.recordListenerReward(full, s, { listenedPct: 90, contentSeconds: 700 }, now);
      expect(off.writes).toHaveLength(0);
      expect(full.writes).toHaveLength(0);
    });
  });
});
