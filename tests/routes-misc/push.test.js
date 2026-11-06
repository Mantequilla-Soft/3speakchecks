/**
 * Web push (routes/push.js over utils/webPush.js): the subscription lifecycle,
 * per-person preferences, the admin test send, and how dead browser
 * subscriptions are cleaned up. The web-push library is mocked; nothing is sent.
 */
jest.mock('web-push');

process.env.VAPID_PUBLIC_KEY = 'test-vapid-public';
process.env.VAPID_PRIVATE_KEY = 'test-vapid-private';

const request = require('supertest');
const webpush = require('web-push');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const { pinClock, NOW } = require('./_fixtures');
const push = require('../../utils/webPush');

const app = buildApp(['/push', require('../../routes/push')]);
const db = testDb.use();
const subs = () => db().collection('push-subscriptions');

const ADMIN = { 'x-admin-key': 'test-push-admin-key' };
const sub = (n = 1) => ({ endpoint: `https://push.example.com/send/device-${n}`, keys: { p256dh: `p256-${n}`, auth: `auth-${n}` } });

// A copy of the router and util loaded with no VAPID keys at all.
function unconfigured() {
  const saved = [process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY];
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  let loaded;
  jest.isolateModules(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    loaded = { app: buildApp(['/push', require('../../routes/push')]), util: require('../../utils/webPush') };
  });
  [process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY] = saved;
  return loaded;
}

beforeEach(() => {
  pinClock(NOW);
  webpush.sendNotification.mockReset().mockResolvedValue({ statusCode: 201 });
});
afterEach(() => jest.useRealTimers());

describe('configuration', () => {
  test('VAPID details are set from the environment at load', () => {
    jest.isolateModules(() => {
      const wp = require('web-push');
      require('../../utils/webPush');
      expect(wp.setVapidDetails).toHaveBeenCalledWith('mailto:admin@3speak.tv', 'test-vapid-public', 'test-vapid-private');
    });
  });

  test('GET /push/vapid-key hands out the public key, cacheable for an hour', async () => {
    const res = await request(app).get('/push/vapid-key').expect(200);
    expect(res.body).toEqual({ success: true, publicKey: 'test-vapid-public' });
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
  });

  test('without VAPID keys the key and subscribe endpoints answer 503 and sending is a no-op', async () => {
    const off = unconfigured();
    await request(off.app).get('/push/vapid-key').expect(503);
    await request(off.app).post('/push/subscribe').send({ username: 'alice', subscription: sub() }).expect(503);
    await expect(off.util.sendToUser('alice', { title: 'x' })).resolves.toEqual({ sent: 0, gone: 0 });
    await expect(off.util.ensureIndexes()).resolves.toBeUndefined();
    expect(await subs().countDocuments()).toBe(0);
  });
});

describe('POST /push/subscribe', () => {
  test('stores one row per browser, normalising the name and clipping the user agent', async () => {
    await request(app).post('/push/subscribe').set('User-Agent', 'U'.repeat(500))
      .send({ username: '@Alice', subscription: sub(1) }).expect(200, { success: true });
    const row = await subs().findOne({});
    expect(row).toMatchObject({ username: 'alice', endpoint: sub(1).endpoint, keys: sub(1).keys, createdAt: NOW, updatedAt: NOW });
    expect(row.userAgent).toHaveLength(200);
  });

  test('re-subscribing the same browser updates its keys instead of adding a row', async () => {
    await request(app).post('/push/subscribe').send({ username: 'alice', subscription: sub(1) }).expect(200);
    jest.setSystemTime(NOW.getTime() + 60000);
    const rotated = { ...sub(1), keys: { p256dh: 'new-p256', auth: 'new-auth' } };
    await request(app).post('/push/subscribe').send({ username: 'alice', subscription: rotated }).expect(200);

    const rows = await subs().find({}).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ keys: rotated.keys, createdAt: NOW, updatedAt: new Date(NOW.getTime() + 60000) });
  });

  test('a phone and a laptop are two subscriptions', async () => {
    await request(app).post('/push/subscribe').send({ username: 'alice', subscription: sub(1) }).expect(200);
    await request(app).post('/push/subscribe').send({ username: 'alice', subscription: sub(2) }).expect(200);
    expect(await subs().countDocuments({ username: 'alice' })).toBe(2);
    expect(await push.listSubscribers()).toEqual(['alice']);
  });

  test.each([
    ['no username', { username: '' }],
    ['a two-letter username', { username: 'al' }],
    ['a username with a slash', { username: 'al/ice' }],
  ])('400 with %s', async (_label, change) => {
    const res = await request(app).post('/push/subscribe').send({ username: 'alice', subscription: sub(), ...change }).expect(400);
    expect(res.body.error).toBe('invalid username');
  });

  test.each([
    ['no subscription', undefined],
    ['an http (not https) endpoint', { ...sub(), endpoint: 'http://push.example.com/x' }],
    ['a javascript: endpoint', { ...sub(), endpoint: 'javascript:alert(1)' }],
    ['an endpoint of 1000+ characters', { ...sub(), endpoint: `https://push.example.com/${'a'.repeat(1000)}` }],
    ['an endpoint that is not a string', { ...sub(), endpoint: ['https://push.example.com'] }],
    ['no keys', { endpoint: sub().endpoint }],
    ['a numeric auth key', { endpoint: sub().endpoint, keys: { p256dh: 'p', auth: 5 } }],
  ])('400 with %s', async (_label, subscription) => {
    const res = await request(app).post('/push/subscribe').send({ username: 'alice', subscription }).expect(400);
    expect(res.body.error).toBe('invalid subscription');
    expect(await subs().countDocuments()).toBe(0);
  });
});

describe('POST /push/unsubscribe', () => {
  beforeEach(async () => {
    for (const [user, n] of [['alice', 1], ['alice', 2], ['bob', 3]]) {
      await request(app).post('/push/subscribe').send({ username: user, subscription: sub(n) }).expect(200);
    }
  });

  test('with an endpoint removes only that browser', async () => {
    const res = await request(app).post('/push/unsubscribe').send({ username: 'alice', endpoint: sub(1).endpoint }).expect(200);
    expect(res.body).toEqual({ success: true, removed: 1 });
    expect((await subs().find({}).toArray()).map((r) => r.endpoint).sort()).toEqual([sub(2).endpoint, sub(3).endpoint]);
  });

  test('without an endpoint removes every browser of that person, nobody else', async () => {
    const res = await request(app).post('/push/unsubscribe').send({ username: 'alice', endpoint: '' }).expect(200);
    expect(res.body.removed).toBe(2);
    expect(await subs().countDocuments({ username: 'bob' })).toBe(1);
  });

  test('an endpoint that is not a string is ignored rather than used as a query', async () => {
    const res = await request(app).post('/push/unsubscribe').send({ username: 'carol', endpoint: { $ne: null } }).expect(200);
    expect(res.body.removed).toBe(0);
    expect(await subs().countDocuments()).toBe(3);
  });

  test('400 for an invalid username', async () => {
    await request(app).post('/push/unsubscribe').send({ username: 'x' }).expect(400);
  });

  // SECURITY (routes/push.js:52-62): the unsubscribe-all branch trusts the username
  // in the body. Anyone can silently switch off every notification of any account
  // with one unauthenticated POST. The "endpoint is unguessable" argument in the
  // code covers only the by-endpoint branch.
  test.skip('BUG: removing all of an account push subscriptions requires proof that it is that account', async () => {
    await request(app).post('/push/unsubscribe').send({ username: 'alice' }).expect(401);
    expect(await subs().countDocuments({ username: 'alice' })).toBe(2);
  });
});

describe('/push/prefs', () => {
  test('a person with no saved choice gets the defaults: everything on except votes and reblogs', async () => {
    const res = await request(app).get('/push/prefs?username=alice').expect(200);
    expect(res.body.kinds).toEqual(push.KINDS);
    expect(res.body.prefs).toEqual(push.DEFAULT_PREFS);
    expect(res.body.prefs).toMatchObject({ votes: false, reblogs: false, replies: true });
  });

  test('saving keeps only known kinds with boolean values, on top of the defaults', async () => {
    const res = await request(app).post('/push/prefs')
      .send({ username: 'alice', prefs: { votes: true, videos: false, shorts: 'no', hacked: true, $where: true } })
      .expect(200);
    expect(res.body.prefs).toEqual({ ...push.DEFAULT_PREFS, votes: true, videos: false });
    const read = await request(app).get('/push/prefs?username=ALICE').expect(200);
    expect(read.body.prefs).toEqual(res.body.prefs);
    expect(await db().collection('push-prefs').findOne({ _id: 'alice' })).toMatchObject({ updatedAt: NOW });
  });

  test('preferences are per person: one account saving does not change another', async () => {
    await request(app).post('/push/prefs').send({ username: 'alice', prefs: { videos: false } }).expect(200);
    const bob = await request(app).get('/push/prefs?username=bob').expect(200);
    expect(bob.body.prefs.videos).toBe(true);
  });

  test('missing prefs reset to the defaults', async () => {
    await request(app).post('/push/prefs').send({ username: 'alice', prefs: { videos: false } }).expect(200);
    const res = await request(app).post('/push/prefs').send({ username: 'alice' }).expect(200);
    expect(res.body.prefs).toEqual(push.DEFAULT_PREFS);
  });

  test.each([
    ['GET with a bad username', () => request(app).get('/push/prefs?username=no')],
    ['POST with a bad username', () => request(app).post('/push/prefs').send({ username: '' })],
    ['POST with prefs that are a string', () => request(app).post('/push/prefs').send({ username: 'alice', prefs: 'all-off' })],
  ])('400 for %s', async (_label, call) => {
    await call().expect(400);
  });

  // SECURITY (routes/push.js:80-91): writing preferences is unauthenticated, so
  // anyone can turn off another account's notifications. The code comment only
  // argues for unauthenticated READS.
  test.skip('BUG: changing an account notification preferences requires proof that it is that account', async () => {
    await request(app).post('/push/prefs').send({ username: 'alice', prefs: { replies: false } }).expect(401);
  });

  // SECURITY, denial of service (routes/push.js:75): GET /push/prefs runs
  // cleanUser(req.query.username) outside a try/catch in an async handler.
  // Express 4's query parser turns ?username[toString]=x into an object whose
  // toString is a string, String() throws, the rejection is unhandled and on
  // Node 22 the checker process exits. Correct behaviour is a 400.
  test('a username query that cannot become a string is a 400, not a process crash', async () => {
    await request(app).get('/push/prefs?username[toString]=x').timeout(2000).expect(400);
  });
});

describe('when the database fails', () => {
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));

  test.each([
    ['subscribe', 'updateOne', () => request(app).post('/push/subscribe').send({ username: 'alice', subscription: sub() }), 'could not save subscription'],
    ['unsubscribe', 'deleteMany', () => request(app).post('/push/unsubscribe').send({ username: 'alice' }), 'could not remove subscription'],
    ['saving prefs', 'updateOne', () => request(app).post('/push/prefs').send({ username: 'alice', prefs: {} }), 'could not save preferences'],
  ])('%s answers 500 without details', async (_label, method, call, error) => {
    const { Collection } = require('mongodb');
    jest.spyOn(Collection.prototype, method).mockRejectedValue(new Error('primary stepped down'));
    await call().expect(500, { success: false, error });
  });
});

describe('POST /push/test (admin) and delivery', () => {
  beforeEach(async () => {
    await request(app).post('/push/subscribe').send({ username: 'alice', subscription: sub(1) }).expect(200);
    await request(app).post('/push/subscribe').send({ username: 'alice', subscription: sub(2) }).expect(200);
    await request(app).post('/push/subscribe').send({ username: 'bob', subscription: sub(3) }).expect(200);
  });

  test.each([
    ['no admin key', {}],
    ['a wrong admin key', { 'x-admin-key': 'guess' }],
    ['the API key as admin key', { 'x-admin-key': 'test-api-secret' }],
  ])('403 with %s, and nothing is sent', async (_label, headers) => {
    await request(app).post('/push/test').set(headers).send({ username: 'alice' }).expect(403);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  test('with PUSH_ADMIN_KEY unset the test endpoint is closed, even to an empty key', async () => {
    const saved = process.env.PUSH_ADMIN_KEY;
    delete process.env.PUSH_ADMIN_KEY;
    let closed;
    jest.isolateModules(() => { closed = buildApp(['/push', require('../../routes/push')]); });
    process.env.PUSH_ADMIN_KEY = saved;
    await request(closed).post('/push/test').set('x-admin-key', '').send({ username: 'alice' }).expect(403);
  });

  test('400 for an invalid username', async () => {
    await request(app).post('/push/test').set(ADMIN).send({ username: '-' }).expect(400);
  });

  test('sends one payload to every browser of the person, and only theirs', async () => {
    const res = await request(app).post('/push/test').set(ADMIN).send({ username: 'alice', body: 'Hello' }).expect(200);
    expect(res.body).toEqual({ success: true, sent: 2, gone: 0 });
    expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
    const [target, payload, options] = webpush.sendNotification.mock.calls[0];
    expect([sub(1).endpoint, sub(2).endpoint]).toContain(target.endpoint);
    expect(JSON.parse(payload)).toEqual({ title: '3Speak', body: 'Hello', url: '/', tag: 'test' });
    expect(options).toEqual({ TTL: 6 * 60 * 60 });
  });

  test('the default body is "Test notification"', async () => {
    await request(app).post('/push/test').set(ADMIN).send({ username: 'bob' }).expect(200);
    expect(JSON.parse(webpush.sendNotification.mock.calls[0][1]).body).toBe('Test notification');
  });

  test.each([[404], [410]])('a browser that answers %i is deleted and counted as gone', async (statusCode) => {
    webpush.sendNotification.mockImplementation(async ({ endpoint }) => {
      if (endpoint === sub(1).endpoint) throw Object.assign(new Error('gone'), { statusCode });
      return { statusCode: 201 };
    });
    const res = await request(app).post('/push/test').set(ADMIN).send({ username: 'alice' }).expect(200);
    expect(res.body).toMatchObject({ sent: 1, gone: 1 });
    expect((await subs().find({ username: 'alice' }).toArray()).map((r) => r.endpoint)).toEqual([sub(2).endpoint]);
  });

  test('a temporary failure (500) keeps the subscription for the next send', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    webpush.sendNotification.mockRejectedValue(Object.assign(new Error('busy'), { statusCode: 500 }));
    const res = await request(app).post('/push/test').set(ADMIN).send({ username: 'alice' }).expect(200);
    expect(res.body).toMatchObject({ sent: 0, gone: 0 });
    expect(await subs().countDocuments({ username: 'alice' })).toBe(2);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('500'));
  });

  test('a failure without a status code is logged by its message', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    webpush.sendNotification.mockRejectedValue(new Error('socket hang up'));
    await push.sendToUser('bob', { title: 't' });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('socket hang up'));
  });
});

describe('utils/webPush indexes', () => {
  test('ensureIndexes makes (username, endpoint) unique, so a browser cannot be stored twice', async () => {
    await push.ensureIndexes();
    const indexes = await subs().indexes();
    expect(indexes.find((i) => i.unique && i.key.username === 1 && i.key.endpoint === 1)).toBeTruthy();
    await subs().insertOne({ username: 'alice', endpoint: 'https://e/1' });
    await expect(subs().insertOne({ username: 'alice', endpoint: 'https://e/1' })).rejects.toThrow(/duplicate key/);
  });
});
