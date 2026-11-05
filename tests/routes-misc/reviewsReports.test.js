/**
 * The two anonymous inboxes: POST /reviews (feedback) and POST /reports (a viewer
 * reporting a live stream into the shared moderation collection). Both clean what
 * they store and throttle each client to 5 posts per 10 minutes.
 *
 * Each test posts from its own X-Forwarded-For address, so the module-level
 * throttle of one test never leaks into another.
 */
const request = require('supertest');
const { Collection } = require('mongodb');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const { pinClock, NOW } = require('./_fixtures');

const app = buildApp(['/', require('../../routes/reviews')], ['/', require('../../routes/reports')]);
const db = testDb.use();

let ipCounter = 0;
const freshIp = () => `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;
const post = (path, body, ip = freshIp()) => request(app).post(path).set('X-Forwarded-For', ip).send(body);

beforeEach(() => pinClock(NOW));
afterEach(() => jest.useRealTimers());

describe('POST /reviews', () => {
  test('stores a cleaned review, waiting for triage', async () => {
    await request(app).post('/reviews').set('X-Forwarded-For', freshIp()).set('User-Agent', 'TestBrowser/1')
      .send({
        stars: 4, area: ' Upload ', username: ' alice ', permlink: 'my-video', comment: '  great  ',
        aspects: ['Speed', 'speed', ' UI ', 7, '', 'x'.repeat(40)], recommend: true, app_version: '1.81.0', path: '/upload',
      })
      .expect(201, { ok: true });

    const row = await db().collection('reviews').findOne({}, { projection: { _id: 0 } });
    expect(row).toEqual({
      area: 'upload', username: 'alice', permlink: 'my-video', stars: 4,
      aspects: ['speed', 'ui', 'x'.repeat(32)], recommend: true, comment: 'great',
      app_version: '1.81.0', path: '/upload', user_agent: 'TestBrowser/1', processed: false, created_at: NOW,
    });
  });

  test('an anonymous review needs only stars; the rest gets safe defaults', async () => {
    await post('/reviews', { stars: 5, recommend: 'yes', aspects: 'not-a-list' }).expect(201);
    const row = await db().collection('reviews').findOne({});
    expect(row).toMatchObject({ area: 'global', username: null, permlink: null, aspects: [], recommend: null, comment: '', app_version: null, path: null });
  });

  test('aspects are capped at twelve and the comment at 4000 characters', async () => {
    const aspects = Array.from({ length: 20 }, (_, i) => `a${i}`);
    await post('/reviews', { stars: 3, aspects, comment: 'c'.repeat(9000), username: { $gt: '' } }).expect(201);
    const row = await db().collection('reviews').findOne({});
    expect(row.aspects).toHaveLength(12);
    expect(row.comment).toHaveLength(4000);
    expect(row.username).toBeNull();
  });

  test.each([[undefined], [0], [6], [2.5], ['three'], [null]])('400 for stars = %p', async (stars) => {
    const res = await post('/reviews', { stars }).expect(400);
    expect(res.body.error).toBe('stars must be an integer between 1 and 5');
    expect(await db().collection('reviews').countDocuments()).toBe(0);
  });

  test('builds its triage index on first use', async () => {
    await post('/reviews', { stars: 1 }).expect(201);
    await new Promise((r) => setImmediate(r));
    const indexes = await db().collection('reviews').indexes();
    expect(indexes.map((i) => i.key)).toContainEqual({ processed: 1, created_at: -1 });
  });

  test('a database failure is a 500 without details', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(Collection.prototype, 'insertOne').mockRejectedValue(new Error('disk full'));
    await post('/reviews', { stars: 2 }).expect(500, { error: 'failed to save review' });
  });
});

describe('POST /reports', () => {
  test('stores a stream report in the shared moderation collection', async () => {
    await post('/reports', {
      reason: 'Harassment', reported: 'hosty', roomName: 'room-1', detail: ' shouting ', reporter: 'viewer1',
      url: 'https://3speak.tv/live/hosty', app_version: '1.0',
    }).expect(201, { ok: true });
    const row = await db().collection('reporteddatas').findOne({}, { projection: { _id: 0 } });
    expect(row).toEqual({
      name: 'hosty/room-1', type: 'stream', reason: 'hate_speech', comment: 'shouting', reportedBy: 'viewer1',
      url: 'https://3speak.tv/live/hosty', app_version: '1.0', checked: false, createdAt: NOW,
    });
  });

  test.each([
    ['harassment', 'hate_speech'],
    ['sexual', 'sexual'],
    ['violence', 'violence'],
    ['spam', 'spam'],
    ['illegal', 'illegal'],
    ['selfharm', 'selfharm'],
    ['other', 'other'],
    ['something-new', 'other'],
  ])('reason %p is filed as %p', async (reason, filed) => {
    await post('/reports', { reason, reported: 'h' }).expect(201);
    expect((await db().collection('reporteddatas').findOne({})).reason).toBe(filed);
  });

  // BUG (routes/reports.js:51): REASON_MAP[reasonRaw] is a plain object lookup, so
  // a reason named after an Object.prototype member ("__proto__", "constructor")
  // is not "unknown": the report is stored with reason {} or a function (dropped
  // by BSON, so no reason at all) instead of 'other', and the moderation tools get
  // a row outside their vocabulary.
  test.skip.each([['__proto__'], ['constructor']])('BUG: reason %p is filed as "other"', async (reason) => {
    await post('/reports', { reason, reported: 'h' }).expect(201);
    expect((await db().collection('reporteddatas').findOne({})).reason).toBe('other');
  });

  test.each([
    [{ reported: 'hosty' }, 'hosty'],
    [{ roomName: 'room-9' }, 'room-9'],
    [{}, 'unknown'],
  ])('the name falls back to whichever of host and room exists (%p)', async (where, name) => {
    await post('/reports', { reason: 'spam', ...where }).expect(201);
    const row = await db().collection('reporteddatas').findOne({});
    expect(row).toMatchObject({ name, reportedBy: 'anonymous', url: null, app_version: null, comment: '' });
  });

  test.each([[undefined], [''], ['   '], [42]])('400 without a usable reason (%p)', async (reason) => {
    await post('/reports', { reason, reported: 'h' }).expect(400, { error: 'reason is required' });
  });

  test('a database failure is a 500 without details', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(Collection.prototype, 'insertOne').mockRejectedValue(new Error('disk full'));
    await post('/reports', { reason: 'spam' }).expect(500, { error: 'failed to save report' });
  });
});

describe.each([
  ['/reviews', { stars: 5 }, 'reviews'],
  ['/reports', { reason: 'spam' }, 'reporteddatas'],
])('the per-client throttle on %s', (path, body, collection) => {
  test('the sixth post within ten minutes is refused, another client is not affected', async () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i += 1) await post(path, body, ip).expect(201);
    const res = await post(path, body, ip).expect(429);
    expect(res.body.error).toMatch(/^Too many/);
    await post(path, body).expect(201);
    expect(await db().collection(collection).countDocuments()).toBe(6);
  });

  test('the budget comes back after ten minutes', async () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i += 1) await post(path, body, ip).expect(201);
    await post(path, body, ip).expect(429);
    jest.setSystemTime(NOW.getTime() + 10 * 60 * 1000 + 1);
    await post(path, body, ip).expect(201);
  });

  test('without a forwarded address the socket address is the key', async () => {
    // The only test in this file that posts without the header, so the socket
    // address starts with a full budget.
    await request(app).post(path).send(body).expect(201);
    expect(await db().collection(collection).countDocuments()).toBe(1);
  });

  // SECURITY (routes/reviews.js:39, routes/reports.js:44): the throttle keys on the
  // FIRST X-Forwarded-For entry. nginx (nginx/3speak-checker.okinoko.io.conf:12)
  // uses $proxy_add_x_forwarded_for, which keeps whatever the client sent and
  // appends the real address, so a client picks its own throttle key and can post
  // without limit (and grow the in-memory map without bound).
  test.skip('BUG: a client cannot dodge the throttle by sending its own X-Forwarded-For', async () => {
    const realClient = '203.0.113.7';
    for (let i = 0; i < 5; i += 1) await post(path, body, `198.51.100.${i}, ${realClient}`).expect(201);
    await post(path, body, `198.51.100.99, ${realClient}`).expect(429);
  });
});
