/**
 * The engagement affinity cache (utils/engagementBoost.js) is keyed by a
 * caller-supplied username, so it must stay bounded: past ENGAGE_MAX_USERS the
 * least recently used viewer is dropped and re-read from MongoDB next time.
 * Scoring and the queue are covered in tests/engagementBoost.test.js.
 */
process.env.ENGAGE_MAX_USERS = '2';

const testDb = require('../helpers/db');
const { NOW } = require('./_fixtures');
const boost = require('../../utils/engagementBoost');

const db = testDb.use();
const rows = () => db().collection('user-engagement');

const REAL_TIMERS = ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'];
beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: REAL_TIMERS });
  boost.invalidate();
  boost.setWarmer(null);
});
afterEach(() => jest.useRealTimers());

const row = (name, author) => ({ _id: name, authors: { [author]: 1 }, topics: {}, topic_events: 0, updated_at: NOW });

test('the least recently used viewer is evicted once the cache is full', async () => {
  await rows().insertMany([row('aaa', 'one'), row('bbb', 'one'), row('ccc', 'one')]);
  for (const u of ['aaa', 'bbb', 'ccc']) await boost.getEngagementAffinity(db(), u);   // aaa falls out

  await rows().updateMany({}, { $set: { authors: { two: 1 } } });

  // ccc is still cached and served as it was; aaa is read again from the database.
  expect((await boost.getEngagementAffinity(db(), 'ccc')).authors).toEqual({ one: 1 });
  expect((await boost.getEngagementAffinity(db(), 'aaa')).authors).toEqual({ two: 1 });
});

test('reading a cached viewer keeps them from being the next one evicted', async () => {
  await rows().insertMany([row('aaa', 'one'), row('bbb', 'one'), row('ccc', 'one')]);
  await boost.getEngagementAffinity(db(), 'aaa');
  await boost.getEngagementAffinity(db(), 'bbb');
  await boost.getEngagementAffinity(db(), 'aaa');   // touched: bbb is now the oldest
  await boost.getEngagementAffinity(db(), 'ccc');   // evicts bbb

  await rows().updateMany({}, { $set: { authors: { two: 1 } } });

  expect((await boost.getEngagementAffinity(db(), 'aaa')).authors).toEqual({ one: 1 });
  expect((await boost.getEngagementAffinity(db(), 'bbb')).authors).toEqual({ two: 1 });
});
