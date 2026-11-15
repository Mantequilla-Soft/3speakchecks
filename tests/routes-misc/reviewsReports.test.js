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
      app_version: '1.81.0', path: '/upload', user_agent: 'TestBrowser/1', screenshot: null, processed: false, created_at: NOW,
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
    // Built in the background (the route does not wait for it): poll, bounded.
    const { performance } = require('perf_hooks');
    const deadline = performance.now() + 5000;
    let keys = [];
    while (performance.now() < deadline) {
      keys = (await db().collection('reviews').indexes()).map((i) => i.key);
      if (keys.some((k) => k.processed === 1 && k.created_at === -1)) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(keys).toContainEqual({ processed: 1, created_at: -1 });
  });

  test('a database failure is a 500 without details', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(Collection.prototype, 'insertOne').mockRejectedValue(new Error('disk full'));
    await post('/reviews', { stars: 2 }).expect(500, { error: 'failed to save review' });
  });
});

describe('POST /reviews with a screenshot', () => {
  // A real PNG header plus padding: the route checks the first bytes, not the pixels.
  const png = (size = 64) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(size)]);
  const dataUrl = (mime, buf) => `data:${mime};base64,${buf.toString('base64')}`;

  test('is kept apart in review_screenshots; the review row only points at it', async () => {
    const buf = png(300 * 1024); // well over the app-wide 100 kB body limit
    await post('/reviews', { stars: 4, comment: 'the button is cut off', screenshot: dataUrl('image/png', buf) }).expect(201, { ok: true });

    const review = await db().collection('reviews').findOne({});
    const shot = await db().collection('review_screenshots').findOne({});
    expect(review.screenshot).toEqual({ id: shot._id, mime: 'image/png', bytes: buf.length });
    expect(shot).toMatchObject({ review_id: review._id, mime: 'image/png', bytes: buf.length, created_at: NOW });
    expect(Buffer.from(shot.data.buffer).equals(buf)).toBe(true);
  });

  test.each([
    ['a GIF', dataUrl('image/gif', Buffer.from('GIF89a0000000000'))],
    ['a JPEG label on PNG bytes', dataUrl('image/jpeg', png())],
    ['not a data URL', 'https://example.com/shot.png'],
    ['an object', { $gt: '' }],
    ['more than 750 kB', dataUrl('image/png', png(750 * 1024))],
  ])('400 and nothing stored for %s', async (_label, screenshot) => {
    const res = await post('/reviews', { stars: 3, screenshot }).expect(400);
    expect(res.body.error).toBe('screenshot must be a PNG, JPEG or WebP image of at most 750 kB');
    expect(await db().collection('reviews').countDocuments()).toBe(0);
    expect(await db().collection('review_screenshots').countDocuments()).toBe(0);
  });

  test('JPEG and WebP are taken too', async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(32)]);
    await post('/reviews', { stars: 5, screenshot: dataUrl('image/jpeg', jpeg) }).expect(201);
    await post('/reviews', { stars: 5, screenshot: dataUrl('image/webp', webp) }).expect(201);
    const mimes = (await db().collection('review_screenshots').find({}).toArray()).map((d) => d.mime).sort();
    expect(mimes).toEqual(['image/jpeg', 'image/webp']);
  });

  test('an empty screenshot field is the same as none', async () => {
    await post('/reviews', { stars: 2, screenshot: '' }).expect(201);
    expect((await db().collection('reviews').findOne({})).screenshot).toBeNull();
    expect(await db().collection('review_screenshots').countDocuments()).toBe(0);
  });

  test('when the review cannot be saved, its screenshot is removed again', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const real = Collection.prototype.insertOne;
    jest.spyOn(Collection.prototype, 'insertOne').mockImplementation(function (...a) {
      return this.collectionName === 'reviews' ? Promise.reject(new Error('disk full')) : real.apply(this, a);
    });
    await post('/reviews', { stars: 2, screenshot: dataUrl('image/png', png()) }).expect(500, { error: 'failed to save review' });
    jest.restoreAllMocks();
    expect(await db().collection('review_screenshots').countDocuments()).toBe(0);
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
  test.each([['__proto__'], ['constructor']])('reason %p is filed as "other"', async (reason) => {
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
  test('a client cannot dodge the throttle by sending its own X-Forwarded-For', async () => {
    const realClient = '203.0.113.7';
    for (let i = 0; i < 5; i += 1) await post(path, body, `198.51.100.${i}, ${realClient}`).expect(201);
    await post(path, body, `198.51.100.99, ${realClient}`).expect(429);
  });
});
