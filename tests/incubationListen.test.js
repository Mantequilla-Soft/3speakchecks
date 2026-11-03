/**
 * Warm-up listening (routes/audioListen.js → incubation_listen): the listening goal
 * of the musician and podcaster warm-up tracks, without Mongo.
 */
const { _test: L } = require('../routes/audioListen');

const base = { incListener: 'newbie', source: '3speak', private: false, kind: 'audio', id: 'abc', owner: 'bob', feed_id: null };

describe('warm-up handles', () => {
  test('the Hive account charset, lowercased, like the player', () => {
    expect(L.incubationName(' NewBie ')).toBe('newbie');
    expect(L.incubationName('a.b-1')).toBe('a.b-1');
    expect(L.incubationName('ab')).toBeNull();
    expect(L.incubationName('a'.repeat(17))).toBeNull();
    expect(L.incubationName('~warmup')).toBeNull();
    expect(L.incubationName(undefined)).toBeNull();
  });
});

describe('what a session is worth', () => {
  test('wall-clock listening, not the playhead', () => {
    expect(L.incubationListenSeconds(base, { listenedSeconds: 300, contentSeconds: 900 })).toBe(300);
  });

  test('capped per item', () => {
    expect(L.INCUBATION_LISTEN_MAX_SECONDS).toBe(1200);
    expect(L.incubationListenSeconds(base, { listenedSeconds: 5000 })).toBe(1200);
  });

  test('only on 3speak.tv, not in private mode, not for no handle', () => {
    expect(L.incubationListenSeconds({ ...base, source: 'embed' }, { listenedSeconds: 300 })).toBe(0);
    expect(L.incubationListenSeconds({ ...base, private: true }, { listenedSeconds: 300 })).toBe(0);
    expect(L.incubationListenSeconds({ ...base, incListener: null }, { listenedSeconds: 300 })).toBe(0);
  });

  test('not your own track; an outside episode has no 3Speak owner', () => {
    expect(L.incubationListenSeconds({ ...base, owner: 'newbie' }, { listenedSeconds: 300 })).toBe(0);
    expect(L.incubationListenSeconds({ ...base, owner: 'NewBie' }, { listenedSeconds: 300 })).toBe(0);
    expect(L.incubationListenSeconds({ ...base, kind: 'podcast', owner: null }, { listenedSeconds: 300 })).toBe(300);
  });

  test('nothing listened is nothing', () => {
    expect(L.incubationListenSeconds(base, { listenedSeconds: 0 })).toBe(0);
    expect(L.incubationListenSeconds(base, { listenedSeconds: NaN })).toBe(0);
  });
});

describe('the incubation_listen row', () => {
  function fakeDb({ fail = false } = {}) {
    const writes = [];
    return {
      writes,
      collection: (name) => ({
        updateOne: async (q, u, o) => {
          if (fail) throw new Error('down');
          writes.push({ name, q, u, o });
        },
      }),
    };
  }
  const now = new Date('2026-11-03T12:00:00Z');

  test('one row per handle and item, only ever raised, no consent needed', async () => {
    const db = fakeDb();
    await L.recordIncubationListen(db, base, { listenedSeconds: 400, listenedPct: 5 }, now);
    expect(db.writes).toHaveLength(1);
    const { name, q, u, o } = db.writes[0];
    expect(name).toBe('incubation_listen');
    expect(q).toEqual({ handle: 'newbie', kind: 'audio', id: 'abc' });
    expect(u.$max).toEqual({ listenedSeconds: 400 });
    expect(u.$set).toMatchObject({ at: now, owner: 'bob' });
    expect(u.$setOnInsert).toEqual({ firstAt: now });
    expect(o).toEqual({ upsert: true });
  });

  test('nothing written when the session does not count', async () => {
    const db = fakeDb();
    await L.recordIncubationListen(db, { ...base, private: true }, { listenedSeconds: 400 }, now);
    await L.recordIncubationListen(db, { ...base, owner: 'newbie' }, { listenedSeconds: 400 }, now);
    expect(db.writes).toHaveLength(0);
  });

  test('a database error never breaks the beat', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(L.recordIncubationListen(fakeDb({ fail: true }), base, { listenedSeconds: 400 }, now)).resolves.toBeUndefined();
    spy.mockRestore();
  });
});
