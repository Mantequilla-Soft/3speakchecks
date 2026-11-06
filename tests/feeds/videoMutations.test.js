/**
 * The creator mutations in routes/videos.js, against a real MongoDB, and what each
 * one does to the feeds:
 *   PATCH /api/video/:owner/:permlink/reusable   (upload token)
 *   PUT   /video/thumbnail | /video/openpod | /video/listing | /video/nsfw  (app key)
 *   POST  /video/reinstate                       (app key)
 */
jest.mock('../../utils/hive', () => require('./_hiveMock').create());

const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp, apiKeyHeader } = require('../helpers/app');
const F = require('./_fixtures');
const hive = require('../../utils/hive');

const db = testDb.use();
const app = buildApp(['/feeds', require('../../routes/feeds')], ['/', require('../../routes/videos')]);
const videos = () => db().collection('videos');
const embeds = () => db().collection('embed-video');
const put = (path, body) => request(app).put(path).set(apiKeyHeader()).send(body);

beforeEach(async () => {
  F.pinClock();
  hive.__reset();
  await F.resetFeedCaches(db());
});
afterEach(() => jest.useRealTimers());

describe('the app key', () => {
  test.each([
    ['put', '/video/thumbnail'],
    ['put', '/video/openpod'],
    ['put', '/video/listing'],
    ['put', '/video/nsfw'],
    ['post', '/video/reinstate'],
  ])('%s %s needs it', async (method, path) => {
    await request(app)[method](path).send({ owner: 'a', permlink: 'b' }).expect(401);
    await request(app)[method](path).set('Authorization', 'Bearer wrong').send({ owner: 'a', permlink: 'b' }).expect(401);
  });
});

describe('PATCH /api/video/:owner/:permlink/reusable', () => {
  const patch = (token, body) => request(app).patch('/api/video/leg/v/reusable')
    .set('Authorization', `Bearer ${token}`).send(body);

  test('needs the upload token', async () => {
    expect((await patch('nope', { reusable: true }).expect(401)).body).toEqual({ success: false, error: 'Unauthorized' });
  });

  test('needs a boolean', async () => {
    await patch(process.env.UPLOAD_SECRET_TOKEN, { reusable: 'yes' }).expect(400);
  });

  test('a missing video is a 404', async () => {
    await patch(process.env.UPLOAD_SECRET_TOKEN, { reusable: true }).expect(404);
  });

  test('sets the flag, which the read endpoint then reports', async () => {
    await videos().insertOne(F.legacyVideo({ owner: 'leg', permlink: 'v' }));
    expect((await patch(process.env.UPLOAD_SECRET_TOKEN, { reusable: true }).expect(200)).body).toEqual({ success: true, reusable: true });
    expect((await request(app).get('/api/video/leg/v').expect(200)).body.reusable).toBe(true);
  });
});

describe('PUT /video/thumbnail', () => {
  test.each([
    [{ owner: 'a', permlink: 'b' }, 'owner, permlink, and thumbnail are required'],
    [{ owner: 'a', permlink: 'b', thumbnail: 'ftp://x' }, 'Thumbnail must be a valid URL or IPFS CID (starting with ipfs://, http://, or https://)'],
  ])('rejects %j', async (body, message) => {
    expect((await put('/video/thumbnail', body).expect(400)).body.message).toBe(message);
  });

  test('a video in no collection is a 404', async () => {
    await put('/video/thumbnail', { owner: 'a', permlink: 'b', thumbnail: 'https://t' }).expect(404);
  });

  test('updates every collection holding the video, each on the field its readers use', async () => {
    await videos().insertOne(F.legacyVideo({ owner: 'cr', permlink: 'same' }));
    await embeds().insertOne(F.embedVideo({ owner: 'cr', permlink: 'asset', hive_permlink: 'same' }));
    await db().collection('embed-audio').insertOne({ owner: 'cr', permlink: 'track', post_permlink: 'same' });

    const res = await put('/video/thumbnail', { owner: 'cr', permlink: 'same', thumbnail: 'ipfs://QmNew' }).expect(200);

    expect(res.body.data).toMatchObject({ owner: 'cr', permlink: 'same', thumbnail: 'ipfs://QmNew', collections: ['videos', 'embed-video', 'embed-audio'] });
    expect(await videos().findOne({ permlink: 'same' })).toMatchObject({ thumbnail: 'ipfs://QmNew', thumbnail_url: 'ipfs://QmNew' });
    expect(await embeds().findOne({ permlink: 'asset' })).toMatchObject({ thumbnail_url: 'ipfs://QmNew' });
    expect(await db().collection('embed-audio').findOne({ permlink: 'track' })).toMatchObject({ thumbnail_url: 'ipfs://QmNew' });
  });
});

describe('PUT /video/openpod', () => {
  test('needs owner and permlink, and an embed video to mark', async () => {
    await put('/video/openpod', { owner: 'a' }).expect(400);
    await put('/video/openpod', { owner: 'a', permlink: 'b' }).expect(404);
  });

  test('marks a stream recording, the room defaulting to the permlink', async () => {
    await embeds().insertOne(F.embedVideo({ owner: 'host', permlink: 'room-42' }));
    const res = await put('/video/openpod', { owner: 'host', permlink: 'room-42' }).expect(200);
    expect(res.body.data).toEqual({ owner: 'host', permlink: 'room-42', room: 'room-42' });
    expect(await embeds().findOne({ permlink: 'room-42' })).toMatchObject({ is_openpod_stream: true, openpod_room: 'room-42' });
  });
});

describe('PUT /video/listing', () => {
  test('needs a boolean `listed`', async () => {
    await put('/video/listing', { owner: 'a', permlink: 'b', listed: 'no' }).expect(400);
    await put('/video/listing', { owner: 'a', permlink: 'b', listed: false }).expect(404);
  });

  test('unlisting takes a video out of the feeds, relisting brings it back', async () => {
    await embeds().insertOne(F.embedVideo({ owner: 'cr', permlink: 'flip' }));
    expect((await request(app).get('/feeds/new').expect(200)).body.total).toBe(1);

    const res = await put('/video/listing', { owner: 'cr', permlink: 'hive-flip', listed: false }).expect(200);
    expect(res.body.data).toEqual({ owner: 'cr', permlink: 'hive-flip', listed: false, collections: ['embed-video'] });
    await F.resetFeedCaches(db());
    expect((await request(app).get('/feeds/new').expect(200)).body.total).toBe(0);

    await put('/video/listing', { owner: 'cr', permlink: 'flip', listed: true }).expect(200);
    await F.resetFeedCaches(db());
    expect((await request(app).get('/feeds/new').expect(200)).body.total).toBe(1);
  });

  test('a legacy video is updated too', async () => {
    await videos().insertOne(F.legacyVideo({ owner: 'cr', permlink: 'l' }));
    await put('/video/listing', { owner: 'cr', permlink: 'l', listed: false }).expect(200);
    expect(await videos().findOne({ permlink: 'l' })).toMatchObject({ listed_on_3speak: false });
  });
});

describe('PUT /video/nsfw', () => {
  test('needs a boolean `nsfw`', async () => {
    await put('/video/nsfw', { owner: 'a', permlink: 'b' }).expect(400);
    await put('/video/nsfw', { owner: 'a', permlink: 'b', nsfw: true }).expect(404);
  });

  test('flagging hides the video from viewers who did not opt in', async () => {
    await videos().insertOne(F.legacyVideo({ owner: 'cr', permlink: 'spicy' }));
    await embeds().insertOne(F.embedVideo({ owner: 'cr', permlink: 'spicy-e', hive_permlink: 'spicy' }));

    const res = await put('/video/nsfw', { owner: 'cr', permlink: 'spicy', nsfw: true }).expect(200);

    expect(res.body.data.collections).toEqual(['videos', 'embed-video']);
    expect((await request(app).get('/feeds/new').expect(200)).body.total).toBe(0);
    expect((await request(app).get('/feeds/new').query({ nsfw: 'true' }).expect(200)).body.total).toBe(1);
  });
});

describe('POST /video/reinstate', () => {
  test('needs owner and permlink', async () => {
    await request(app).post('/video/reinstate').set(apiKeyHeader()).send({ owner: 'a' }).expect(400);
  });

  test('lifts a dead-media ban and undeletes the doc, so the video is back in the feeds', async () => {
    await embeds().insertOne(F.embedVideo({ owner: 'cr', permlink: 'back', unavailable: true, unavailableAt: F.daysAgo(1), status: 'deleted' }));
    await db().collection('video-unavailable').insertOne({ _id: 'cr/back', reason: 'confirmed-gone' });

    const res = await request(app).post('/video/reinstate').set(apiKeyHeader()).send({ owner: 'cr', permlink: 'back' }).expect(200);

    expect(res.body).toMatchObject({ success: true, message: 'Video reinstated', data: { cleared: true } });
    const doc = await embeds().findOne({ permlink: 'back' });
    expect(doc).toMatchObject({ unavailable: false, status: 'published' });
    expect(doc).not.toHaveProperty('unavailableAt');
    expect(await db().collection('video-unavailable').countDocuments()).toBe(0);
    expect((await request(app).get('/feeds/new').expect(200)).body.total).toBe(1);
  });

  test('is idempotent: nothing flagged, nothing to clear', async () => {
    await videos().insertOne(F.legacyVideo({ owner: 'cr', permlink: 'fine' }));
    const res = await request(app).post('/video/reinstate').set(apiKeyHeader()).send({ owner: 'cr', permlink: 'fine' }).expect(200);
    expect(res.body).toMatchObject({ message: 'Nothing to clear', data: { cleared: false } });
  });
});
