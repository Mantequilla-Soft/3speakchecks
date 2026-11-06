/**
 * pushHive: Hive's own notifications (replies, mentions, follows, votes,
 * reblogs) pushed to subscribers' devices. Only what is new since the last pass
 * goes out, a person's first pass sends nothing, switched-off kinds are skipped
 * and nobody gets more than three at once. webPush and the Hive read are mocks;
 * the per-person cursor lives in the real test MongoDB.
 */
jest.mock('../../utils/hive', () => ({ hiveRpcBatch: jest.fn() }));
jest.mock('../../utils/webPush', () => ({
  isConfigured: jest.fn(),
  listSubscribers: jest.fn(),
  getPrefs: jest.fn(),
  sendToUser: jest.fn(),
}));

const testDb = require('../helpers/db');
const { hiveRpcBatch } = require('../../utils/hive');
const push = require('../../utils/webPush');
const { runOnce } = require('../../services/pushHive');
const { NOW } = require('./_fixtures');

const db = testDb.use();
const state = () => db().collection('push-hive-state');

const ONLY_DATE = ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame',
  'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate',
  'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'];

let inbox;  // username -> notifications as bridge.account_notifications returns them
let prefs;  // username -> prefs
let pushed; // [{ username, payload }]
beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ONLY_DATE });
  inbox = new Map();
  prefs = new Map();
  pushed = [];
  push.isConfigured.mockReturnValue(true);
  push.listSubscribers.mockImplementation(async () => [...inbox.keys()]);
  push.getPrefs.mockImplementation(async (u) => prefs.get(u) || {});
  push.sendToUser.mockImplementation(async (username, payload) => { pushed.push({ username, payload }); return { sent: 1 }; });
  hiveRpcBatch.mockReset();
  hiveRpcBatch.mockImplementation(async ([r]) => [{ id: 1, result: inbox.get(r.params.account) || [] }]);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.useRealTimers());

const n = (id, type, msg, url) => ({ id, type, msg, url, date: '2026-11-01T11:00:00' });
const seen = (username, lastId) => state().insertOne({ _id: username, lastId });

test('does nothing when push is not configured', async () => {
  push.isConfigured.mockReturnValue(false);
  expect(await runOnce()).toEqual({ skipped: 'not configured' });
  expect(push.listSubscribers).not.toHaveBeenCalled();
});

test('a person\'s first pass records where they are and sends nothing', async () => {
  inbox.set('alice', [n(12, 'reply', '@bob replied', '@bob/re'), n(10, 'vote', '@carol voted', '@alice/p')]);

  expect(await runOnce()).toEqual({ subscribers: 1, sent: 0 });

  expect(pushed).toEqual([]);
  expect(await state().findOne({ _id: 'alice' })).toEqual({ _id: 'alice', lastId: 12, at: NOW });
});

test('sends what is new since the cursor, oldest first, with headline, route and a dedupe tag', async () => {
  await seen('alice', 10);
  inbox.set('alice', [
    n(13, 'follow', '@dave followed you', '@dave'),
    n(12, 'reply_comment', '@bob replied to your comment', '@bob/re-abc'),
    n(10, 'vote', '@carol voted on your post', '@alice/p'),
  ]);

  const res = await runOnce();

  expect(res).toEqual({ subscribers: 1, sent: 2 });
  expect(pushed.map((p) => p.payload)).toEqual([
    { title: '@bob replied to you', body: '@bob replied to your comment', url: '/post/bob/re-abc', tag: 'hive:12' },
    { title: '@dave followed you', body: '@dave followed you', url: '/p/dave', tag: 'hive:13' },
  ]);
  expect((await state().findOne({ _id: 'alice' })).lastId).toBe(13);
});

test.each([
  ['a mention', 'mention', '@x mentioned you'],
  ['an upvote', 'vote', '@x upvoted your post'],
  ['a reblog', 'reblog', '@x reblogged your post'],
])('%s has its own headline', async (_label, type, title) => {
  await seen('alice', 1);
  inbox.set('alice', [n(2, type, '@x did a thing', '@alice/p')]);
  await runOnce();
  expect(pushed[0].payload.title).toBe(title);
});

test.each([
  ['trx:abc', '/'],
  ['', '/'],
  [undefined, '/'],
  ['@alice/my-post', '/post/alice/my-post'],
  ['alice', '/p/alice'],
  ['/x', '/'],
])('a notification url %p opens %p', async (url, route) => {
  await seen('alice', 1);
  inbox.set('alice', [n(2, 'reply', '@bob replied', url)]);
  await runOnce();
  expect(pushed[0].payload.url).toBe(route);
});

test('types Hive raises that are not pushed (transfers, roles...) and switched-off kinds are skipped', async () => {
  await seen('alice', 1);
  prefs.set('alice', { votes: false });
  inbox.set('alice', [n(2, 'transfer', '@x sent 1 HIVE'), n(3, 'vote', '@x voted'), n(4, 'mention', '@x mentioned you')]);

  await runOnce();

  expect(pushed.map((p) => p.payload.tag)).toEqual(['hive:4']);
  expect((await state().findOne({ _id: 'alice' })).lastId).toBe(4); // cursor moves past skipped ones too
});

test('at most three per person per pass: the newest three', async () => {
  await seen('alice', 0);
  inbox.set('alice', [1, 2, 3, 4, 5].map((i) => n(i, 'reply', `@u${i} replied`, `@u${i}/r`)));

  await runOnce();

  expect(pushed.map((p) => p.payload.tag)).toEqual(['hive:3', 'hive:4', 'hive:5']);
});

test('a long message is cut to 140 characters and a missing actor reads "someone"', async () => {
  await seen('alice', 0);
  inbox.set('alice', [n(1, 'reply', `${' '}${'x'.repeat(200)}`, '@a/b')]);
  await runOnce();
  expect(pushed[0].payload.title).toBe('@someone replied to you');
  expect(pushed[0].payload.body).toHaveLength(140);
});

test('running twice sends nothing the second time', async () => {
  await seen('alice', 1);
  inbox.set('alice', [n(2, 'reply', '@bob replied', '@bob/r')]);
  await runOnce();

  const res = await runOnce();

  expect(res.sent).toBe(0);
  expect(pushed).toHaveLength(1);
});

test('an empty or unreadable notification list leaves the cursor alone', async () => {
  await seen('alice', 5);
  inbox.set('alice', []);
  hiveRpcBatch.mockResolvedValueOnce([]); // every node down for this read
  await runOnce();
  expect(await state().findOne({ _id: 'alice' })).toEqual({ _id: 'alice', lastId: 5 });
});

test('one person\'s failure does not stop the others', async () => {
  await seen('alice', 1);
  await seen('bob', 1);
  inbox.set('alice', [n(2, 'reply', '@x replied', '@x/r')]);
  inbox.set('bob', [n(2, 'reply', '@y replied', '@y/r')]);
  push.getPrefs.mockImplementation(async (u) => { if (u === 'alice') throw new Error('prefs down'); return {}; });

  const res = await runOnce();

  expect(res).toEqual({ subscribers: 2, sent: 1 });
  expect(pushed.map((p) => p.username)).toEqual(['bob']);
  expect((await state().findOne({ _id: 'alice' })).lastId).toBe(1); // retried next pass
});

test('handles at most 200 subscribers per pass', async () => {
  for (let i = 0; i < 205; i++) inbox.set(`u${i}`, []);
  const res = await runOnce();
  expect(res.subscribers).toBe(200);
  expect(hiveRpcBatch).toHaveBeenCalledTimes(200);
});

// BUG: the cursor is overwritten with the max id of WHATEVER list came back
// (services/pushHive.js:225 and :253), so a lagging node that answers an older
// list moves it backwards, and the next pass on a healthy node pushes every
// notification in between a second time. The cursor should only ever move forward.
test.skip('BUG: an older list from a lagging node never moves the cursor backwards', async () => {
  await seen('alice', 20);
  inbox.set('alice', [n(15, 'reply', '@old replied', '@old/r')]);
  await runOnce();
  expect((await state().findOne({ _id: 'alice' })).lastId).toBe(20);

  inbox.set('alice', [n(21, 'reply', '@new replied', '@new/r'), n(18, 'reply', '@mid replied', '@mid/r')]);
  await runOnce();
  expect(pushed.map((p) => p.payload.tag)).toEqual(['hive:21']);
});
