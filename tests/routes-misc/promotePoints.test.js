/**
 * routes/promote.js: promoting a video with 3Speak Points. The points server
 * (hangouts) asks GET /promote/eligible before it takes any points, then credits
 * the promotion with PUT /promote/points, authenticated by a shared secret only.
 * The credit must happen once per spend however often the points server retries,
 * stack onto a running promotion and never pass MAX_PROMOTION_DAYS from now.
 *
 * The videos and the payment ledger are real MongoDB collections.
 */
const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const { pinClock, NOW } = require('./_fixtures');
const { MAX_PROMOTION_DAYS } = require('../../utils/config');
const hiddenCreators = require('../../utils/hiddenCreators');

const db = testDb.use();
const app = buildApp(['/', require('../../routes/promote')]);
const DAY = 24 * 3600 * 1000;
const SECRET = 'test-points-secret';

beforeEach(async () => {
  pinClock();
  process.env.POINTS_AWARD_SECRET = SECRET;
  await hiddenCreators.refresh(db());
});
afterEach(() => {
  jest.useRealTimers();
  delete process.env.POINTS_AWARD_SECRET;
});

/** A promotable embed video: alice's asset `vid`, Hive post alice/hive-vid. */
const embed = (extra = {}) => db().collection('embed-video').insertOne({
  owner: 'alice', permlink: 'vid', hive_author: 'alice', hive_permlink: 'hive-vid',
  status: 'published', short: false, listed_on_3speak: true, createdAt: new Date(NOW.getTime() - DAY),
  ...extra,
});
const eligible = (author = 'alice', permlink = 'hive-vid') =>
  request(app).get(`/promote/eligible/${author}/${permlink}`).expect(200);
const credit = (body, secret = SECRET) => {
  const req = request(app).put('/promote/points');
  if (secret !== null) req.set('x-points-award-secret', secret);
  return req.send({ author: 'alice', permlink: 'hive-vid', days: 1, spendId: 's-1', user: 'bob', ...body });
};
const until = async (coll = 'embed-video') => (await db().collection(coll).findOne())?.promotedUntil;
const inDays = (d) => new Date(NOW.getTime() + d * DAY);

describe('GET /promote/eligible', () => {
  test('a published, listed video with no promotion can take the full maximum', async () => {
    await embed();
    const res = await eligible();
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ success: true, eligible: true, promotedUntil: null, maxDays: MAX_PROMOTION_DAYS });
  });

  test('any video can be promoted, looked up by its Hive post or its asset key', async () => {
    await embed({ owner: 'uploader' });
    expect((await eligible('alice', 'hive-vid')).body.eligible).toBe(true);
    expect((await eligible('uploader', 'vid')).body.eligible).toBe(true);
  });

  test('a running promotion leaves only the whole days that still fit', async () => {
    await embed({ promotedUntil: new Date(NOW.getTime() + 2.5 * DAY) });
    expect((await eligible()).body).toEqual({
      success: true, eligible: true, promotedUntil: inDays(2.5).toISOString(), maxDays: MAX_PROMOTION_DAYS - 3,
    });
  });

  test('a promotion at the cap leaves no days, an ended one does not count', async () => {
    await embed({ promotedUntil: inDays(MAX_PROMOTION_DAYS) });
    expect((await eligible()).body).toMatchObject({ eligible: true, maxDays: 0 });

    await db().collection('embed-video').updateOne({}, { $set: { promotedUntil: new Date(NOW.getTime() - 1) } });
    expect((await eligible()).body).toMatchObject({ promotedUntil: null, maxDays: MAX_PROMOTION_DAYS });
  });

  test('the legacy row counts towards the running promotion too', async () => {
    await embed();
    await db().collection('videos').insertOne({ owner: 'alice', permlink: 'hive-vid', promotedUntil: inDays(6) });
    expect((await eligible()).body.maxDays).toBe(MAX_PROMOTION_DAYS - 6);
  });

  test('a video with no embed row yet is not_found', async () => {
    expect((await eligible('nobody', 'nothing')).body)
      .toEqual({ success: true, eligible: false, reason: 'not_found', promotedUntil: null, maxDays: 0 });
  });

  test.each([
    ['short', { short: true }],
    ['short', { short: undefined }],
    ['unlisted', { listed_on_3speak: false }],
    ['not_published', { status: 'encoding' }],
    ['not_published', { hive_permlink: null, owner: 'alice', permlink: 'hive-vid' }],
    ['unavailable', { unavailable: true }],
    ['unavailable', { banned: true }],
    ['unavailable', { status: 'deleted' }],
    ['unavailable', { hiddenFromFeed: true }],
    ['unavailable', { createdAt: new Date('2010-01-01T00:00:00Z') }],
    ['hidden', { hive_author: 'threespeak-fixer', owner: 'alice', permlink: 'hive-vid' }],
  ])('reason %s for %j', async (reason, extra) => {
    await embed(extra);
    expect((await eligible()).body).toMatchObject({ success: true, eligible: false, reason, maxDays: 0 });
  });

  test('a creator hidden by moderation is hidden', async () => {
    await embed();
    await db().collection('contentcreators').insertOne({ username: 'alice', hidden: true });
    await hiddenCreators.refresh(db());
    expect((await eligible()).body).toMatchObject({ eligible: false, reason: 'hidden' });
  });

  test('a database error is a 500', async () => {
    const { Collection } = require('mongodb');
    jest.spyOn(Collection.prototype, 'findOne').mockRejectedValueOnce(new Error('down'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await request(app).get('/promote/eligible/alice/hive-vid').expect(500);
  });
});

describe('PUT /promote/points: access and input', () => {
  test('without POINTS_AWARD_SECRET the route does not exist', async () => {
    delete process.env.POINTS_AWARD_SECRET;
    await embed();
    await credit({}, SECRET).expect(404);
    expect(await until()).toBeUndefined();
  });

  test.each([
    ['no secret header', null],
    ['a wrong secret', 'wrong'],
    ['a longer secret', `${SECRET}x`],
  ])('%s is a 401 and credits nothing', async (_label, secret) => {
    await embed();
    await credit({}, secret).expect(401);
    expect(await until()).toBeUndefined();
  });

  test('the app key is not needed (and not enough)', async () => {
    await embed();
    await request(app).put('/promote/points').set('Authorization', `Bearer ${process.env.API_SECRET_KEY}`)
      .send({ author: 'alice', permlink: 'hive-vid', days: 1, spendId: 's-1' }).expect(401);
    await credit({}).expect(200);
  });

  test.each([
    [{ author: '' }],
    [{ permlink: { $ne: null } }],
    [{ days: 0 }],
    [{ days: 1.5 }],
    [{ days: 'two' }],
    [{ days: null }],
    [{ days: true }],
    [{ spendId: '' }],
    [{ spendId: 'x'.repeat(65) }],
  ])('%j is a 400', async (body) => {
    await embed();
    expect((await credit(body).expect(400)).body.code).toBe('invalid');
  });

  test('days may come as a numeric string', async () => {
    await embed();
    expect((await credit({ days: '2' }).expect(200)).body).toMatchObject({ addedDays: 2 });
  });
});

describe('PUT /promote/points: crediting', () => {
  test('credits days from now, on the embed and legacy rows, and records the spend', async () => {
    await embed();
    await db().collection('videos').insertOne({ owner: 'alice', permlink: 'hive-vid' });

    const res = await credit({ days: 3, points: 15000 }).expect(200);

    expect(res.body).toEqual({ success: true, promotedUntil: inDays(3).toISOString(), addedDays: 3 });
    expect(await until('embed-video')).toEqual(inDays(3));
    expect(await until('videos')).toEqual(inDays(3));
    expect(await db().collection('promotion_payments').find({}, { projection: { _id: 0 } }).toArray()).toEqual([{
      trx_id: 'points:s-1', author: 'alice', permlink: 'hive-vid', method: 'points', user: 'bob', days: 3, points: 15000, processedAt: NOW,
    }]);
  });

  test('the same spendId twice credits once, the repeat says alreadyCredited', async () => {
    await embed();
    await credit({ days: 2 }).expect(200);
    const again = await credit({ days: 2 }).expect(200);
    expect(again.body).toEqual({ success: true, alreadyCredited: true, promotedUntil: inDays(2).toISOString() });
    expect(await until()).toEqual(inDays(2));
    expect(await db().collection('promotion_payments').countDocuments()).toBe(1);
  });

  test('a repeat after the promotion reached the cap is still alreadyCredited, not too_long', async () => {
    await embed();
    await credit({ days: MAX_PROMOTION_DAYS }).expect(200);
    expect((await credit({ days: MAX_PROMOTION_DAYS }).expect(200)).body.alreadyCredited).toBe(true);
  });

  test('two requests racing with the same spendId credit exactly once', async () => {
    await embed();
    const results = await Promise.all([credit({ days: 2 }), credit({ days: 2 })]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(await until()).toEqual(inDays(2));
    expect(await db().collection('promotion_payments').countDocuments()).toBe(1);
  });

  test('stacks onto a running promotion', async () => {
    await embed({ promotedUntil: inDays(2) });
    expect((await credit({ days: 3 }).expect(200)).body.promotedUntil).toBe(inDays(5).toISOString());
  });

  test('more days than still fit is too_long with the days that do, and nothing is recorded', async () => {
    await embed({ promotedUntil: inDays(5) });
    const res = await credit({ days: 3 }).expect(409);
    expect(res.body).toMatchObject({ success: false, code: 'too_long', maxDays: 2 });
    expect(await until()).toEqual(inDays(5));
    expect(await db().collection('promotion_payments').countDocuments()).toBe(0);
    // Exactly what fits lands on the cap.
    expect((await credit({ days: 2, spendId: 's-2' }).expect(200)).body.promotedUntil).toBe(inDays(7).toISOString());
  });

  test('a video that is not indexed is a 404 not_found', async () => {
    expect((await credit({}).expect(404)).body).toMatchObject({ code: 'not_found' });
  });

  test('an ineligible video is a 409 with the reason, and nothing is recorded', async () => {
    await embed({ short: true });
    expect((await credit({}).expect(409)).body).toMatchObject({ code: 'ineligible', reason: 'short' });
    expect(await db().collection('promotion_payments').countDocuments()).toBe(0);
  });

  test('if writing the credit fails, the reservation is released so a retry credits it', async () => {
    await embed();
    const { Collection } = require('mongodb');
    jest.spyOn(Collection.prototype, 'updateOne').mockRejectedValueOnce(new Error('write conflict'));
    jest.spyOn(console, 'error').mockImplementation(() => {});

    await credit({ days: 2 }).expect(500);
    expect(await db().collection('promotion_payments').countDocuments()).toBe(0);

    jest.restoreAllMocks();
    expect((await credit({ days: 2 }).expect(200)).body).toMatchObject({ addedDays: 2 });
    expect(await until()).toEqual(inDays(2));
  });

  test('a ledger error other than a duplicate is a 500', async () => {
    await embed();
    const { Collection } = require('mongodb');
    jest.spyOn(Collection.prototype, 'insertOne').mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 1 }));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await credit({}).expect(500);
    expect(await until()).toBeUndefined();
  });
});
