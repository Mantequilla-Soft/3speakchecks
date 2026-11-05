/**
 * tagSync: a change-stream watcher that keeps embed-video.hive_tags_lower equal
 * to the lowercased hive_tags. Change streams need a replica set and the test
 * mongod is standalone, so the collection is a stand-in whose watch() returns an
 * event emitter the test drives: inserts, updates, errors and reconnects.
 */
const { EventEmitter } = require('events');

let current; // the stream the watcher is listening on
const updates = [];
const watchCalls = [];
let failUpdate = null;
const mockCollection = {
  watch: jest.fn((pipeline, opts) => {
    watchCalls.push({ pipeline, opts });
    current = new EventEmitter();
    current.close = jest.fn(async () => {});
    return current;
  }),
  updateOne: jest.fn(async (filter, update) => {
    if (failUpdate) throw failUpdate;
    updates.push({ filter, update });
  }),
};
jest.mock('../../utils/db', () => ({ getDb: () => ({ collection: () => mockCollection }) }));

const { startTagSyncWatcher } = require('../../services/tagSync');

// Each 'change' handler is async; let it finish before asserting.
const settle = () => new Promise((resolve) => setImmediate(resolve));
const change = async (fullDocument) => { current.emit('change', { operationType: 'insert', fullDocument }); await settle(); };

beforeEach(() => {
  updates.length = 0;
  watchCalls.length = 0;
  failUpdate = null;
  jest.spyOn(console, 'error').mockImplementation(() => {});
  startTagSyncWatcher();
});

describe('keeping hive_tags_lower in sync', () => {
  test('watches inserts, replaces and updates that touch hive_tags, with the full document', () => {
    expect(watchCalls[0]).toEqual({
      pipeline: [{
        $match: {
          $or: [
            { operationType: 'insert' },
            { operationType: 'replace' },
            { operationType: 'update', 'updateDescription.updatedFields.hive_tags': { $exists: true } },
          ],
        },
      }],
      opts: { fullDocument: 'updateLookup' },
    });
  });

  test('writes the lowercased tags, turning non-strings into strings', async () => {
    await change({ _id: 1, hive_tags: ['Music', 'LIVE', 42] });
    expect(updates).toEqual([{ filter: { _id: 1 }, update: { $set: { hive_tags_lower: ['music', 'live', '42'] } } }]);
  });

  test.each([
    ['tags removed', { hive_tags: [], hive_tags_lower: ['old'] }, []],
    ['tags missing', { hive_tags_lower: ['old'] }, []],
    ['a stale lower copy', { hive_tags: ['A', 'b'], hive_tags_lower: ['a'] }, ['a', 'b']],
  ])('%s -> rewritten', async (_label, doc, expected) => {
    await change({ _id: 2, ...doc });
    expect(updates).toEqual([{ filter: { _id: 2 }, update: { $set: { hive_tags_lower: expected } } }]);
  });

  test('an already-synced doc is not written again (its own write does not loop)', async () => {
    await change({ _id: 3, hive_tags: ['A', 'B'], hive_tags_lower: ['a', 'b'] });
    await change({ _id: 4, hive_tags: [], hive_tags_lower: [] });
    expect(updates).toEqual([]);
  });

  test('an event without a document (deleted meanwhile) is ignored', async () => {
    await change(null);
    expect(updates).toEqual([]);
  });

  test('a failing write is logged and the watcher keeps going', async () => {
    failUpdate = new Error('not primary');
    await change({ _id: 5, hive_tags: ['X'] });
    expect(console.error).toHaveBeenCalledWith('[tagSync] Error syncing hive_tags_lower:', 'not primary');

    failUpdate = null;
    await change({ _id: 6, hive_tags: ['Y'] });
    expect(updates).toEqual([{ filter: { _id: 6 }, update: { $set: { hive_tags_lower: ['y'] } } }]);
  });
});

describe('reconnecting after a stream error', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('closes the broken stream and reopens after 5s, 10s, 15s ... then gives up after 5 retries', () => {
    for (let i = 1; i <= 5; i++) {
      const broken = current;
      broken.emit('error', new Error('cursor killed'));
      expect(broken.close).toHaveBeenCalled();
      expect(broken.listenerCount('change')).toBe(0);
      const before = watchCalls.length;
      jest.advanceTimersByTime(5000 * i - 1);
      expect(watchCalls.length).toBe(before);   // not yet
      jest.advanceTimersByTime(1);
      expect(watchCalls.length).toBe(before + 1);
    }
    current.emit('error', new Error('cursor killed'));
    jest.advanceTimersByTime(60 * 1000);
    expect(watchCalls).toHaveLength(6);         // the first open plus five retries, no more
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/Giving up after 5 retries/));
  });

  test('a change that arrives after a reconnect resets the retry count', () => {
    current.emit('error', new Error('blip'));
    jest.advanceTimersByTime(5000);
    current.emit('change', { fullDocument: null });
    current.emit('error', new Error('blip again'));
    jest.advanceTimersByTime(5000);              // back to the first delay, not 10s
    expect(watchCalls).toHaveLength(3);
  });
});
