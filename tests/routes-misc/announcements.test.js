/**
 * routes/announcements.js: the popup 3speak.tv shows on open, personal announcements
 * that only a 3Speak-vouched session may read, and replies.
 *
 * A vouch is a message signed by @threespeak's own posting key (real signature, fake
 * chain). The router keeps a 60 s snapshot, a per-IP reply throttle and a Hive
 * account cache in memory, so every test starts an hour after the previous one on a
 * pinned clock: no state leaks from one test into the next.
 */
const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const { hiveAccount, fakeHiveChain } = require('../helpers/hive');
const { pinClock, NOW } = require('./_fixtures');

jest.mock('../../utils/hive', () => ({ ...jest.requireActual('../../utils/hive'), hiveRpcCall: jest.fn() }));
const { hiveRpcCall } = require('../../utils/hive');

const db = testDb.use();
const app = buildApp(['/', require('../../routes/announcements')]);
const anns = () => db().collection('announcements');
const replies = () => db().collection('announcement_replies');

const threespeak = hiveAccount('threespeak');
const alice = hiveAccount('alice');
const HOUR = 3600 * 1000;

let tick = 0;
let now;
let ipSeq = 0;
beforeEach(() => {
  tick += 1;
  now = pinClock(new Date(NOW.getTime() + tick * HOUR)).getTime();
  fakeHiveChain([threespeak, alice]);
  hiveRpcCall.mockReset();
});
afterEach(() => jest.useRealTimers());

const readMsg = (account, ts) => ['3speak-announce', 'read-vouch', account, String(ts)].join('|');
const replyMsg = (account, number, ts) => ['3speak-announce', 'reply-vouch', account, String(number), String(ts)].join('|');
const readVouch = (username, { signer = threespeak, ts = now, as = username } = {}) =>
  ({ username, timestamp: ts, signature: signer.sign(readMsg(as, ts)) });
const replyVouch = (username, number, { signer = threespeak, ts = now } = {}) =>
  ({ username, timestamp: ts, signature: signer.sign(replyMsg(username, number, ts)) });

const latest = () => request(app).get('/announcements/latest');
const personal = (body) => request(app).post('/announcements/latest').send(body);
// A fresh client IP per call unless a test pins one, so the throttle only bites on purpose.
const reply = (number, body, ip = `10.0.0.${++ipSeq % 250}`) =>
  request(app).post(`/announcements/${number}/replies`).set('X-Real-IP', ip).send(body);

describe('GET /announcements/latest', () => {
  test('returns the newest active general announcement, shaped for the browser', async () => {
    await anns().insertMany([
      { number: 1, message: 'old news' },
      { number: 2, message: '  Hello\neveryone  ', link: 'https://3speak.tv/x', linkText: 'Read more', imagePath: '/img/banner.png', canRespond: true },
      { number: 3, message: 'switched off', active: false },
      { number: 4, message: 'only for alice', username: 'alice' },
    ]);

    const res = await latest().expect(200);

    expect(res.headers['cache-control']).toBe('public, max-age=60');
    expect(res.body).toEqual({ announcement: {
      number: 2, message: 'Hello\neveryone', link: 'https://3speak.tv/x', linkText: 'Read more',
      imagePath: '/img/banner.png', canRespond: true,
    } });
  });

  test('skips malformed documents instead of showing them', async () => {
    await anns().insertMany([
      { number: 9, message: '   ' },
      { number: 8.5, message: 'fractional number' },
      { number: 0, message: 'zero' },
      { number: 7, message: 42 },
      { number: 6, message: 'the good one', canRespond: 'yes' },
    ]);
    expect((await latest().expect(200)).body.announcement).toMatchObject({ number: 6, canRespond: false });
  });

  test.each([
    ['javascript:alert(1)', null],
    ['data:text/html,hi', null],
    ['//evil.example/x', null],
    ['http://insecure.example/', null],
    ['not a url', null],
    ['https://ok.example/a b', 'https://ok.example/a%20b'],
    ['/watch?v=a/b', '/watch?v=a/b'],
  ])('a link of %p is shown as %p, and its label only with a link', async (link, shown) => {
    await anns().insertOne({ number: 1, message: 'm', link, linkText: 'Go', imagePath: link });
    const { announcement } = (await latest().expect(200)).body;
    expect(announcement.link).toBe(shown);
    expect(announcement.imagePath).toBe(shown);
    expect(announcement.linkText).toBe(shown ? 'Go' : null);
  });

  test('is null when there is nothing to show', async () => {
    expect((await latest().expect(200)).body).toEqual({ announcement: null });
  });

  test('is answered from memory for a minute, then re-read', async () => {
    await anns().insertOne({ number: 1, message: 'first' });
    expect((await latest()).body.announcement.number).toBe(1);

    await anns().insertOne({ number: 2, message: 'second' });
    pinClock(new Date(now + 59 * 1000));
    expect((await latest()).body.announcement.number).toBe(1);
    pinClock(new Date(now + 61 * 1000));
    expect((await latest()).body.announcement.number).toBe(2);
  });

  test('a database failure is a 500', async () => {
    const { Collection } = require('mongodb');
    jest.spyOn(Collection.prototype, 'find').mockImplementation(() => { throw new Error('down'); });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await latest().expect(500);
    await personal({}).expect(500);
  });
});

describe('POST /announcements/latest: personal announcements', () => {
  beforeEach(() => anns().insertMany([
    { number: 1, message: 'for everybody' },
    { number: 5, message: 'for two of you', username: ['@Alice', 'bob'] },
    { number: 6, message: 'for carol', username: 'carol' },
  ]));

  test('a valid read-vouch for alice gets her announcement, without the recipient list', async () => {
    const res = await personal(readVouch('alice')).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.announcement.number).toBe(1);
    expect(res.body.personal).toEqual({ number: 5, message: 'for two of you', link: null, linkText: null, imagePath: null, canRespond: false });
    expect(JSON.stringify(res.body)).not.toMatch(/bob|username/);
  });

  test('typing a name without a vouch gets only the general announcement', async () => {
    const res = await personal({ username: 'alice' }).expect(200);
    expect(res.body).toEqual({ announcement: expect.objectContaining({ number: 1 }), personal: null });
  });

  test.each([
    ['signed by alice herself, not by @threespeak', () => readVouch('alice', { signer: alice })],
    ['a vouch for carol presented as alice', () => readVouch('alice', { as: 'carol' })],
    ['a reply-vouch used as a read-vouch', () => ({ ...replyVouch('alice', 5), username: 'alice' })],
    ['a vouch older than ten minutes', () => readVouch('alice', { ts: now - 11 * 60 * 1000 })],
    ['a vouch from the future', () => readVouch('alice', { ts: now + 11 * 60 * 1000 })],
    ['a signature that is not a signature', () => ({ username: 'alice', timestamp: now, signature: 'zz-not-hex' })],
    ['a non-numeric timestamp', () => ({ ...readVouch('alice'), timestamp: 'today' })],
    ['an invalid account name', () => readVouch('A!'),],
  ])('%s proves nothing', async (_label, body) => {
    const res = await personal(body()).expect(200);
    expect(res.body.personal).toBeNull();
    expect(res.body.announcement.number).toBe(1);
  });

  test('an account with nothing addressed to it gets no personal announcement', async () => {
    expect((await personal(readVouch('dave')).expect(200)).body.personal).toBeNull();
  });
});

describe('warm-up users (~handle)', () => {
  test('an announcement addressed to "~kim" reaches the vouched warm-up session ~kim', async () => {
    await anns().insertOne({ number: 3, message: 'hi kim', username: '~kim' });
    expect((await personal(readVouch('~kim')).expect(200)).body.personal.number).toBe(3);
    expect(hiveRpcCall).not.toHaveBeenCalled();
  });

  test('a bare "lee" reaches ~lee only while no Hive account is called lee', async () => {
    await anns().insertOne({ number: 3, message: 'hi lee', username: 'lee' });
    hiveRpcCall.mockResolvedValue([]);
    expect((await personal(readVouch('~lee')).expect(200)).body.personal.number).toBe(3);
    expect(hiveRpcCall).toHaveBeenCalledWith('condenser_api.get_accounts', [['lee']]);
  });

  test('once the Hive name exists the warm-up user stops matching, and that is remembered', async () => {
    await anns().insertOne({ number: 3, message: 'hi max', username: 'max' });
    hiveRpcCall.mockResolvedValue([{ name: 'max' }]);
    expect((await personal(readVouch('~max')).expect(200)).body.personal).toBeNull();
    pinClock(new Date(now + 2 * HOUR));
    expect((await personal(readVouch('~max', { ts: now + 2 * HOUR })).expect(200)).body.personal).toBeNull();
    expect(hiveRpcCall).toHaveBeenCalledTimes(1);
  });

  test('when Hive cannot answer, a private message is never shown on a guess', async () => {
    await anns().insertOne({ number: 3, message: 'hi ned', username: 'ned' });
    hiveRpcCall.mockResolvedValue(null);
    expect((await personal(readVouch('~ned')).expect(200)).body.personal).toBeNull();
  });
});

describe('POST /announcements/:number/replies', () => {
  test('an unverified reply is stored as a claim, for triage', async () => {
    await anns().insertOne({ number: 4, message: 'tell us', canRespond: true });
    const res = await reply(4, { text: '  love it  ', username: '@Alice', app_version: 'v'.repeat(40) }).expect(201);

    expect(res.body).toEqual({ ok: true, verified: false });
    expect(await replies().find({}, { projection: { _id: 0 } }).toArray()).toEqual([{
      number: 4, text: 'love it', username: null, claimed_username: 'alice', signed_by: null,
      app_version: 'v'.repeat(32), processed: false, created_at: new Date(now),
    }]);
  });

  test('a reply with a reply-vouch for this announcement is verified and names the signer', async () => {
    await anns().insertOne({ number: 4, message: 'tell us', canRespond: true });
    const res = await reply(4, { text: 'hi', ...replyVouch('alice', 4) }).expect(201);
    expect(res.body.verified).toBe(true);
    expect(await replies().findOne()).toMatchObject({ username: 'alice', claimed_username: null, signed_by: 'threespeak' });
  });

  test('a reply-vouch for another announcement number does not verify this one', async () => {
    await anns().insertOne({ number: 4, message: 'tell us', canRespond: true });
    const res = await reply(4, { text: 'hi', ...replyVouch('alice', 3) }).expect(201);
    expect(res.body.verified).toBe(false);
    expect(await replies().findOne()).toMatchObject({ username: null, claimed_username: 'alice' });
  });

  test('a garbage claimed name is not stored at all', async () => {
    await anns().insertOne({ number: 4, message: 'tell us', canRespond: true });
    await reply(4, { text: 'hi', username: '<b>x</b>' }).expect(201);
    expect((await replies().findOne()).claimed_username).toBeNull();
  });

  test('an announcement that takes no replies is a 403', async () => {
    await anns().insertOne({ number: 4, message: 'read only' });
    await reply(4, { text: 'hi' }).expect(403);
    expect(await replies().countDocuments()).toBe(0);
  });

  test.each([
    ['an unknown number', { number: 99, message: 'x', canRespond: true }],
    ['an inactive announcement', { number: 4, message: 'x', canRespond: true, active: false }],
  ])('%s is a 404', async (_label, doc) => {
    await anns().insertOne(doc);
    await reply(4, { text: 'hi' }).expect(404);
  });

  test('an addressed announcement does not exist for anyone but its vouched recipients', async () => {
    await anns().insertOne({ number: 4, message: 'private', canRespond: true, username: 'alice' });
    await reply(4, { text: 'hi', username: 'alice' }).expect(404);
    await reply(4, { text: 'hi', ...replyVouch('mallory', 4) }).expect(404);
    await reply(4, { text: 'hi', ...replyVouch('alice', 4) }).expect(201);
    expect(await replies().countDocuments()).toBe(1);
  });

  test.each([['0'], ['-1'], ['1.5'], ['abc']])('announcement number %p is a 400', async (number) => {
    await reply(number, { text: 'hi' }).expect(400);
  });

  test.each([
    [{}, 'text is required'],
    [{ text: '   ' }, 'text is required'],
    [{ text: ['an', 'array'] }, 'text is required'],
    [{ text: 'x'.repeat(2001) }, 'text must be at most 2000 characters'],
  ])('a reply %j is a 400', async (body, error) => {
    await anns().insertOne({ number: 4, message: 'tell us', canRespond: true });
    expect((await reply(4, body).expect(400)).body.error).toBe(error);
  });

  test('exactly 2000 characters is accepted', async () => {
    await anns().insertOne({ number: 4, message: 'tell us', canRespond: true });
    await reply(4, { text: 'x'.repeat(2000) }).expect(201);
  });

  test('one address gets five replies per ten minutes; another address is unaffected', async () => {
    await anns().insertOne({ number: 4, message: 'tell us', canRespond: true });
    for (let i = 0; i < 5; i += 1) await reply(4, { text: `r${i}` }, '192.0.2.7').expect(201);
    await reply(4, { text: 'one too many' }, '192.0.2.7').expect(429);
    await reply(4, { text: 'other person' }, '192.0.2.8').expect(201);

    pinClock(new Date(now + 11 * 60 * 1000));
    await reply(4, { text: 'after the window' }, '192.0.2.7').expect(201);
    expect(await replies().countDocuments()).toBe(7);
  });

  test('the throttle reads the first X-Forwarded-For hop when there is no X-Real-IP', async () => {
    await anns().insertOne({ number: 4, message: 'tell us', canRespond: true });
    const send = () => request(app).post('/announcements/4/replies').set('X-Forwarded-For', '198.51.100.1, 10.0.0.1').send({ text: 'x' });
    for (let i = 0; i < 5; i += 1) await send().expect(201);
    await send().expect(429);
  });

  test('a database failure is a 500', async () => {
    const { Collection } = require('mongodb');
    jest.spyOn(Collection.prototype, 'findOne').mockRejectedValue(new Error('down'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await reply(4, { text: 'hi' }).expect(500);
  });
});
