/**
 * POST /comments/pin (routes/commentPins.js): only the author of a video, or
 * @threespeak signing under the posting authority the author granted, can pin a
 * comment to the top of that video's thread. The signed message names the video,
 * the comment and the action, so a signature cannot be reused for anything else.
 */
const request = require('supertest');
const { Collection } = require('mongodb');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const { hiveAccount, fakeHiveChain } = require('../helpers/hive');
const { pinClock, NOW } = require('./_fixtures');
const { _test: { pinMessage, MAX_PINS } } = require('../../routes/commentPins');

const app = buildApp(['/', require('../../routes/commentPins')]);
const db = testDb.use();

const T = NOW.getTime();
const alice = hiveAccount('alice', { postingDelegates: ['threespeak', 'peakd.app'] });
const mallory = hiveAccount('mallory');
const threespeak = hiveAccount('threespeak');
const peakd = hiveAccount('peakd.app');
const busy = hiveAccount('busy-author');

// A signed pin request; `forMessage` lets a test sign one thing and send another.
function pinRequest({ signer = alice, author = 'alice', permlink = 'my-video', comment = 'c1', pinned = true, timestamp = T } = {}, forMessage = {}) {
  const m = { author, permlink, comment, action: pinned ? 'pin' : 'unpin', timestamp, ...forMessage };
  return { author, permlink, comment, pinned, timestamp, signature: signer.sign(pinMessage(m.author, m.permlink, m.comment, m.action, m.timestamp)) };
}
const send = (body) => request(app).post('/comments/pin').send(body);
const pinsOf = async (coll = 'videos', filter = { owner: 'alice', permlink: 'my-video' }) =>
  (await db().collection(coll).findOne(filter)).pinned_comments;

beforeEach(async () => {
  pinClock(NOW);
  fakeHiveChain([alice, mallory, threespeak, peakd, busy]);
  await db().collection('videos').insertOne({ owner: 'alice', permlink: 'my-video', title: 'Mine' });
});
afterEach(() => jest.useRealTimers());

describe('the signed message', () => {
  test('is "3speak-comments|<action>|<author>|<permlink>|<comment>|<ms>"', () => {
    expect(pinMessage('alice', 'v', 'c', 'pin', 5)).toBe('3speak-comments|pin|alice|v|c|5');
  });
});

describe('input', () => {
  test.each([
    ['an invalid author', { author: 'A!' }],
    ['a permlink with a slash', { permlink: '../etc' }],
    ['an upper-case comment permlink', { comment: 'Hello' }],
    ['a comment permlink that is a query object', { comment: { $ne: '' } }],
    ['pinned as the string "true"', { pinned: 'true' }],
    ['no pinned flag', { pinned: undefined }],
  ])('400 for %s', async (_label, change) => {
    await send({ ...pinRequest(), ...change }).expect(400);
    expect(await pinsOf()).toBeUndefined();
  });

  // SECURITY, denial of service (routes/commentPins.js:53-55): String(b.author)
  // runs outside any try/catch in an async handler. A JSON object whose toString
  // is not a function makes String() throw; Express 4 leaves the rejection
  // unhandled and server.js has no unhandledRejection handler, so on Node 22 one
  // unauthenticated request stops the whole checker. Correct behaviour is a 400.
  test.each([['author'], ['permlink'], ['comment']])('a %s that cannot become a string is a 400, not a process crash', async (field) => {
    await send({ ...pinRequest(), [field]: { toString: 1 } }).timeout(2000).expect(400);
  });
});

describe('who may pin', () => {
  test('401 without a signature, with the exact message to sign', async () => {
    const res = await send({ author: 'alice', permlink: 'my-video', comment: 'c1', pinned: true }).expect(401);
    expect(res.body.expected_message).toBe('3speak-comments|pin|alice|my-video|c1|<ms>');
  });

  test('401 for a timestamp that is not a number', async () => {
    await send({ ...pinRequest(), timestamp: 'now' }).expect(401);
  });

  test.each([
    ['six minutes old', -6 * 60 * 1000],
    ['six minutes in the future', 6 * 60 * 1000],
  ])('401 for a signature %s', async (_label, offset) => {
    const res = await send(pinRequest({ timestamp: T + offset })).expect(401);
    expect(res.body.error).toBe('timestamp out of tolerance');
  });

  test('a commenter cannot pin on the author video with their own key', async () => {
    await send(pinRequest({ signer: mallory })).expect(401, { success: false, error: 'Invalid signature' });
    expect(await pinsOf()).toBeUndefined();
  });

  test('a valid signature for another account cannot touch this video', async () => {
    // mallory proves she is mallory, but the video belongs to alice.
    await send(pinRequest({ signer: mallory, author: 'mallory' })).expect(404, { success: false, error: 'Video not found' });
    expect(await pinsOf()).toBeUndefined();
  });

  test('@threespeak may pin for an author who granted it posting authority', async () => {
    await send(pinRequest({ signer: threespeak })).expect(200);
    expect(await pinsOf()).toEqual(['c1']);
  });

  test('a third-party delegate the author granted (peakd.app) is refused', async () => {
    await send(pinRequest({ signer: peakd })).expect(401);
  });

  test.each([
    ['unpin (a pin signature)', { pinned: false }, {}],
    ['another comment', { comment: 'c2' }, { comment: 'c1' }],
    ['another video', { permlink: 'other-video' }, { permlink: 'my-video' }],
    ['another timestamp', { timestamp: T + 1 }, { timestamp: T }],
  ])('a signature cannot be reused for %s', async (_label, sent, signedFor) => {
    const body = pinRequest({ ...sent }, { action: 'pin', ...signedFor });
    await send(body).expect(401);
  });

  test('404 when the author is not a Hive account', async () => {
    await send(pinRequest({ signer: mallory, author: 'ghost-user' })).expect(404, { success: false, error: 'Hive account not found' });
  });

  test('a garbage signature is a 401, not a crash', async () => {
    await send({ ...pinRequest(), signature: 'nonsense' }).expect(401);
  });
});

describe('pinning', () => {
  test('the newest pin goes first and only three are kept', async () => {
    for (const c of ['c1', 'c2', 'c3', 'c4']) await send(pinRequest({ comment: c })).expect(200);
    expect(MAX_PINS).toBe(3);
    expect(await pinsOf()).toEqual(['c4', 'c3', 'c2']);
  });

  test('pinning a comment again moves it to the front instead of duplicating it', async () => {
    for (const c of ['c1', 'c2', 'c1']) await send(pinRequest({ comment: c })).expect(200);
    const res = await send(pinRequest({ comment: 'c2' })).expect(200);
    expect(res.body).toEqual({ success: true, pinned_comments: ['c2', 'c1'] });
  });

  test('unpinning removes the comment; the last unpin drops the field', async () => {
    await send(pinRequest({ comment: 'c1' })).expect(200);
    await send(pinRequest({ comment: 'c2' })).expect(200);
    await send(pinRequest({ comment: 'c1', pinned: false })).expect(200, { success: true, pinned_comments: ['c2'] });
    await send(pinRequest({ comment: 'c2', pinned: false })).expect(200, { success: true, pinned_comments: [] });
    const row = await db().collection('videos').findOne({ owner: 'alice' });
    expect(row).not.toHaveProperty('pinned_comments');
    expect(row.title).toBe('Mine');
  });

  test('unpinning a comment that was never pinned is harmless', async () => {
    await send(pinRequest({ comment: 'c9', pinned: false })).expect(200, { success: true, pinned_comments: [] });
  });

  test.each([
    ['by owner', { owner: 'alice', permlink: 'embed-one' }, 'embed-one'],
    ['by its Hive post', { owner: 'uploader-acct', permlink: 'internal-id', hive_author: 'alice', hive_permlink: 'hive-post' }, 'hive-post'],
  ])('an embed-video row is found %s', async (_label, row, permlink) => {
    await db().collection('embed-video').insertOne(row);
    await send(pinRequest({ permlink })).expect(200);
    expect((await db().collection('embed-video').findOne({})).pinned_comments).toEqual(['c1']);
  });

  test('a video held in both collections gets the pin on both rows', async () => {
    await db().collection('embed-video').insertOne({ owner: 'alice', permlink: 'my-video' });
    await send(pinRequest()).expect(200);
    expect(await pinsOf('videos')).toEqual(['c1']);
    expect(await pinsOf('embed-video')).toEqual(['c1']);
  });

  test('another author video with the same permlink is never touched', async () => {
    await db().collection('videos').insertOne({ owner: 'mallory', permlink: 'my-video' });
    await send(pinRequest()).expect(200);
    expect(await pinsOf('videos', { owner: 'mallory' })).toBeUndefined();
  });

  test('404 for a video the author does not have', async () => {
    await send(pinRequest({ permlink: 'no-such-video' })).expect(404);
  });
});

describe('limits and failures', () => {
  test('an author is braked after 120 changes in an hour, and the brake lifts an hour later', async () => {
    await db().collection('videos').insertOne({ owner: 'busy-author', permlink: 'v' });
    const body = pinRequest({ signer: busy, author: 'busy-author', permlink: 'v' });
    for (let i = 0; i < 120; i += 1) await send(body).expect(200);
    await send(body).expect(429);

    jest.setSystemTime(T + 60 * 60 * 1000 + 1);
    // A fresh signature: the old one is now outside the tolerance window.
    await send(pinRequest({ signer: busy, author: 'busy-author', permlink: 'v', timestamp: T + 60 * 60 * 1000 })).expect(200);
  });

  test('a database failure is a 502 and leaves the row alone', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(Collection.prototype, 'updateOne').mockRejectedValue(new Error('primary stepped down'));
    await send(pinRequest()).expect(502, { success: false, error: 'could not save the pin' });
  });
});
