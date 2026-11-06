/**
 * ENABLE_MONGO_WRITES=false (a read-only replica, a migration window): every
 * mutating route in scope answers 503 and the database is left exactly as it was.
 * Reads keep working, and the background classifiers / bans quietly skip their
 * writes. Against a real MongoDB.
 */
process.env.ENABLE_MONGO_WRITES = 'false';
jest.mock('../../utils/hive', () => require('./_hiveMock').create());

const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp, apiKeyHeader } = require('../helpers/app');
const F = require('./_fixtures');
const hive = require('../../utils/hive');

const db = testDb.use();
const app = buildApp(
  ['/', require('../../routes/videos')],
  ['/', require('../../routes/user')],
  ['/', require('../../routes/stories')],
  ['/feeds', require('../../routes/watchedFeed')],
);

beforeEach(async () => {
  F.pinClock();
  hive.__reset();
  await F.resetFeedCaches(db());
  await db().collection('embed-video').insertOne(F.storyVideo({ owner: 'meno', permlink: 'clip' }));
  await db().collection('videos').insertOne(F.legacyVideo({ owner: 'meno', permlink: 'old' }));
});
afterEach(() => jest.useRealTimers());

/** Every document in the collections these routes write, for a before/after compare. */
async function snapshot() {
  const out = {};
  for (const name of ['embed-video', 'videos', 'embed-users', 'watch_history', 'video-unavailable']) {
    out[name] = await db().collection(name).find().sort({ _id: 1 }).toArray();
  }
  return out;
}

test.each([
  ['put', '/video/thumbnail', { owner: 'meno', permlink: 'old', thumbnail: 'https://t' }],
  ['put', '/video/openpod', { owner: 'meno', permlink: 'clip' }],
  ['put', '/video/listing', { owner: 'meno', permlink: 'old', listed: false }],
  ['put', '/video/nsfw', { owner: 'meno', permlink: 'old', nsfw: true }],
  ['post', '/video/reinstate', { owner: 'meno', permlink: 'old' }],
  ['put', '/user/trailer', { username: 'meno', permlink: 'old' }],
  ['post', '/stories/keep', { author: 'meno', permlink: 'snap-clip', signature: 'x', timestamp: Date.now() }],
  ['post', '/stories/register', { author: 'meno', permlink: 'snap-clip' }],
])('%s %s answers 503 and writes nothing', async (method, path, body) => {
  const before = await snapshot();
  const res = await request(app)[method](path).set(apiKeyHeader()).send(body).expect(503);
  expect(res.body.success).toBe(false);
  expect(await snapshot()).toEqual(before);
});

// Every other mutation in routes/videos.js starts with
// `if (!ENABLE_MONGO_WRITES) return res.status(503)`. PATCH .../reusable
// (routes/videos.js:439-474) has no such check, so it writes the shared `videos`
// collection even while writes are switched off.
test.skip('BUG: PATCH /api/video/:owner/:permlink/reusable still writes while writes are disabled', async () => {
  const before = await snapshot();
  await request(app).patch('/api/video/meno/old/reusable')
    .set('Authorization', `Bearer ${process.env.UPLOAD_SECRET_TOKEN}`).send({ reusable: true }).expect(503);
  expect(await snapshot()).toEqual(before);
});

test('reads still work', async () => {
  await request(app).get('/videodetails/meno/old').expect(200);
  await request(app).get('/user/meno/counts').expect(200);
});

test('the watched feed still answers, but leaves unflagged history rows unflagged', async () => {
  await db().collection('watch_history').insertOne(F.watched('fan', 'meno', 'clip'));
  const res = await request(app).get('/feeds/watched/fan').expect(200);
  expect(res.body.total).toBe(1);
  const row = await db().collection('watch_history').findOne({});
  expect(row).not.toHaveProperty('short');
  expect(row).not.toHaveProperty('audio');
});

test('a video confirmed dead is NOT banned while writes are off', async () => {
  jest.spyOn(global, 'fetch').mockImplementation(async () => new Response(null, { status: 404 }));
  await db().collection('embed-video').insertOne(F.embedVideo({ owner: 'dead', permlink: 'gone' }));
  await db().collection('videos').insertOne(F.legacyVideo({ owner: 'dead', permlink: 'ancient', video_v2: '', created: F.daysAgo(400) }));

  const confirmed = await request(app).post('/video/report-unavailable').send({ author: 'dead', permlink: 'gone' }).expect(200);
  const noStream = await request(app).post('/video/report-unavailable').send({ author: 'dead', permlink: 'ancient' }).expect(200);

  expect(confirmed.body).toMatchObject({ banned: false, reason: 'writes-disabled' });
  expect(noStream.body).toMatchObject({ banned: false, reason: 'writes-disabled' });
  expect(await db().collection('video-unavailable').countDocuments()).toBe(0);
});
