/**
 * pushNotify: "someone you follow posted" pushes. The window since the last pass
 * is stored, so a restart neither re-sends nor skips; a first pass only looks
 * back 15 minutes; only followers get a push, at most three each. webPush and the
 * following-list read are mocks; candidates come from the real test MongoDB.
 */
const testDb = require('../helpers/db');
const { NOW, MINUTE, HOUR, ago, ahead } = require('./_fixtures');

const db = testDb.use();

const ONLY_DATE = ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame',
  'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate',
  'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'];

const push = {
  isConfigured: jest.fn(),
  listSubscribers: jest.fn(),
  getPrefs: jest.fn(),
  sendToUser: jest.fn(),
};
const hive = { getFollowingList: jest.fn() };

// A fresh copy per test: the module keeps a following-list cache.
let runOnce;
let follows; // username -> [creators]
let prefs;
let pushed;
beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ONLY_DATE });
  const dbModule = require('../../utils/db');
  jest.isolateModules(() => {
    jest.doMock('../../utils/db', () => dbModule);
    jest.doMock('../../utils/webPush', () => push);
    jest.doMock('../../utils/hive', () => hive);
    ({ runOnce } = require('../../services/pushNotify'));
  });
  follows = new Map();
  prefs = new Map();
  pushed = [];
  push.isConfigured.mockReturnValue(true);
  push.listSubscribers.mockImplementation(async () => [...follows.keys()]);
  push.getPrefs.mockImplementation(async (u) => prefs.get(u) || {});
  push.sendToUser.mockImplementation(async (username, payload) => { pushed.push({ username, payload }); return { sent: 1 }; });
  hive.getFollowingList.mockReset();
  hive.getFollowingList.mockImplementation(async (u) => follows.get(u) || []);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.useRealTimers());

const embed = (author, permlink, extra = {}) => ({
  owner: author, permlink: `asset-${permlink}`, hive_author: author, hive_permlink: permlink, hive_title: `Video ${permlink}`,
  status: 'published', listed_on_3speak: true, short: false, createdAt: ago(5 * MINUTE), ...extra,
});
const state = () => db().collection('push-state').findOne({ _id: 'new-uploads' });

test('does nothing when push is not configured', async () => {
  push.isConfigured.mockReturnValue(false);
  expect(await runOnce()).toEqual({ skipped: 'not configured' });
  expect(await state()).toBeNull();
});

test('a follower is told about a new video, short and audio; with the right links and tags', async () => {
  follows.set('fan', ['Creator']);
  await db().collection('embed-video').insertMany([
    embed('creator', 'vid', { createdAt: ago(3 * MINUTE) }),
    embed('creator', 'clip', { short: true, hive_title: null, originalFilename: 'clip.mp4', createdAt: ago(2 * MINUTE) }),
  ]);
  await db().collection('embed-audio').insertOne({ owner: 'creator', post_permlink: 'song', title: 'Song', createdAt: ago(MINUTE) });

  const res = await runOnce();

  expect(res).toEqual({ candidates: 3, sent: 3 });
  expect(pushed.map((p) => p.payload)).toEqual([
    { title: '@creator posted a new video', body: 'Video vid', url: '/watch?v=creator/vid', tag: 'videos:creator/vid' },
    { title: '@creator posted a new short', body: 'clip.mp4', url: '/shorts?v=creator/clip', tag: 'shorts:creator/clip' },
    { title: '@creator posted new audio', body: 'Song', url: '/watch?v=creator/song', tag: 'audio:creator/song' },
  ]);
});

test('legacy videos count too', async () => {
  follows.set('fan', ['old']);
  await db().collection('videos').insertOne({ owner: 'old', permlink: 'legacy', status: 'published', created: ago(MINUTE) });

  await runOnce();

  expect(pushed.map((p) => p.payload)).toEqual([
    { title: '@old posted a new video', body: 'New video', url: '/watch?v=old/legacy', tag: 'videos:old/legacy' },
  ]);
});

test('only followers are notified, and only for kinds they did not switch off', async () => {
  follows.set('fan', ['creator']);
  follows.set('stranger', ['someone-else']);
  follows.set('picky', ['creator']);
  prefs.set('picky', { shorts: false });
  await db().collection('embed-video').insertMany([embed('creator', 'vid'), embed('creator', 'clip', { short: true })]);

  await runOnce();

  expect(pushed.filter((p) => p.username === 'stranger')).toEqual([]);
  expect(pushed.filter((p) => p.username === 'fan')).toHaveLength(2);
  expect(pushed.filter((p) => p.username === 'picky').map((p) => p.payload.tag)).toEqual(['videos:creator/vid']);
});

test.each([
  ['unlisted on 3Speak', { listed_on_3speak: false }],
  ['not published', { status: 'encoding' }],
  ['without a Hive post', { hive_permlink: null }],
  ['older than the first-run look-back', { createdAt: ago(16 * MINUTE) }],
  ['dated in the future', { createdAt: ahead(MINUTE) }],
])('a video %s is not announced', async (_label, extra) => {
  follows.set('fan', ['creator']);
  await db().collection('embed-video').insertOne(embed('creator', 'vid', extra));

  expect(await runOnce()).toEqual({ candidates: 0, sent: 0 });
});

test('at most three pushes per subscriber per pass', async () => {
  follows.set('fan', ['creator']);
  await db().collection('embed-video').insertMany([1, 2, 3, 4, 5].map((i) => embed('creator', `v${i}`, { createdAt: ago((10 - i) * MINUTE) })));

  await runOnce();

  expect(pushed.map((p) => p.payload.tag)).toEqual(['videos:creator/v1', 'videos:creator/v2', 'videos:creator/v3']);
});

test('the window is stored: a second pass only sees what is newer, and advances even when quiet', async () => {
  follows.set('fan', ['creator']);
  await db().collection('embed-video').insertOne(embed('creator', 'first'));
  await runOnce();
  expect((await state()).lastAt).toEqual(NOW);

  jest.setSystemTime(ahead(10 * MINUTE));
  await db().collection('embed-video').insertOne(embed('creator', 'second', { createdAt: ahead(5 * MINUTE) }));
  await runOnce();

  expect(pushed.map((p) => p.payload.tag)).toEqual(['videos:creator/first', 'videos:creator/second']);

  jest.setSystemTime(ahead(HOUR));
  expect(await runOnce()).toEqual({ candidates: 0, sent: 0 });
  expect((await state()).lastAt).toEqual(ahead(HOUR));
});

test('a stored window older than 15 minutes is honoured, so nothing published while down is lost', async () => {
  follows.set('fan', ['creator']);
  await db().collection('push-state').insertOne({ _id: 'new-uploads', lastAt: ago(2 * HOUR) });
  await db().collection('embed-video').insertOne(embed('creator', 'while-down', { createdAt: ago(HOUR) }));

  await runOnce();

  expect(pushed.map((p) => p.payload.tag)).toEqual(['videos:creator/while-down']);
});

test('following lists are cached for an hour', async () => {
  follows.set('fan', ['creator']);
  await db().collection('embed-video').insertOne(embed('creator', 'a'));
  await runOnce();
  jest.setSystemTime(ahead(30 * MINUTE));
  await db().collection('embed-video').insertOne(embed('creator', 'b', { createdAt: ahead(29 * MINUTE) }));
  await runOnce();
  expect(hive.getFollowingList).toHaveBeenCalledTimes(1);

  jest.setSystemTime(ahead(2 * HOUR));
  await db().collection('embed-video').insertOne(embed('creator', 'c', { createdAt: ahead(119 * MINUTE) }));
  await runOnce();
  expect(hive.getFollowingList).toHaveBeenCalledTimes(2);
});

test('a failed following lookup reuses the stale list rather than notifying nobody', async () => {
  follows.set('fan', ['creator']);
  await db().collection('embed-video').insertOne(embed('creator', 'a'));
  await runOnce();

  jest.setSystemTime(ahead(2 * HOUR));
  hive.getFollowingList.mockRejectedValue(new Error('all nodes down'));
  await db().collection('embed-video').insertOne(embed('creator', 'b', { createdAt: ahead(119 * MINUTE) }));
  await runOnce();

  expect(pushed.map((p) => p.payload.tag)).toEqual(['videos:creator/a', 'videos:creator/b']);
});

test('a failed following lookup with nothing cached notifies that person of nothing', async () => {
  follows.set('fan', ['creator']);
  hive.getFollowingList.mockRejectedValue(new Error('all nodes down'));
  await db().collection('embed-video').insertOne(embed('creator', 'a'));

  expect(await runOnce()).toEqual({ candidates: 1, sent: 0 });
});
