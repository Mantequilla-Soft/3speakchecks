/**
 * routes/incubation.js: the reads pass through to Butter Auth's hosted incubation
 * service (a local stub here), the internal routes use this database.
 */
const express = require('express');
const request = require('supertest');
const testDb = require('./helpers/db');
const { buildApp } = require('./helpers/app');

// Deterministic feed: no random 50% draw, no one-post-per-account pick (both have
// their own tests below with the randomness pinned).
process.env.WARMUP_FEED_SHARE = '1';
process.env.WARMUP_FEED_PER_ACCOUNT = '0';

jest.mock('../utils/hive', () => ({ ...jest.requireActual('../utils/hive'), hiveRpcBatch: jest.fn() }));
const { hiveRpcBatch } = require('../utils/hive');

const seen = [];
let feedItems = [];
let stubServer;
let app;
let followingOf;

beforeAll(async () => {
  const stub = express();
  stub.use(express.json());
  stub.use((req, _res, next) => { seen.push({ method: req.method, url: req.url, clientId: req.get('x-client-id'), body: req.body }); next(); });
  stub.post('/public/authors', (_req, res) => res.json({ authors: {
    alice: { handle: 'alice', status: 'incubating', userId: 'u-alice', hiveUsername: null },
    gone: { handle: 'gone', status: 'unknown', userId: null, hiveUsername: null },
  } }));
  stub.get('/public/feed', (_req, res) => res.json({ items: feedItems }));
  stub.get('/public/profile/:h', (req, res) => (req.params.h === 'alice'
    ? res.json({ handle: 'alice', counts: { posts: 2 } })
    : res.status(404).json({ error: 'No such user' })));
  stub.post('/public/likes/for', (_req, res) => res.json({ items: { 'a/p': { count: 1, liked: true } } }));
  stub.get('/public/user/:h/following', (_req, res) => res.json({ items: [{ name: 'carol' }, { name: 'dave' }] }));
  stubServer = stub.listen(0, '127.0.0.1');
  await new Promise((r) => stubServer.once('listening', r));
  process.env.INCUBATION_HOSTED_URL = `http://127.0.0.1:${stubServer.address().port}`;

  app = buildApp(['/incubation', require('../routes/incubation')]);
  ({ followingOf } = require('../utils/incubationHosted'));
});

afterAll(() => new Promise((r) => (stubServer.listening ? stubServer.close(r) : r())));

const db = testDb.use();

const warmupPost = (handle, permlink, extra = {}) => ({
  handle, permlink, created: new Date().toISOString(), onChain: false,
  author: { handle, status: 'incubating' }, ...extra,
});

beforeEach(async () => {
  seen.length = 0;
  feedItems = [];
  // Nobody exists on Hive unless a test says so.
  hiveRpcBatch.mockResolvedValue([{ result: [] }]);
  await db().collection('incubation_watch').insertMany([
    { handle: 'alice', contentSeconds: 100.4 },
    { handle: 'alice', contentSeconds: 50 },
    { handle: 'bob', contentSeconds: 999 },
  ]);
  await db().collection('embed-video').insertMany([
    { permlink: 'v1', owner: 'alice' },
    { permlink: 'v2', owner: 'alice' },
    { permlink: 'v3', owner: 'someone-else' },
  ]);
  await db().collection('incubation_listen').insertMany([
    { handle: 'alice', kind: 'audio', id: 'a1', listenedSeconds: 300.4 },
    { handle: 'alice', kind: 'podcast', id: 'e1', listenedSeconds: 600 },
    { handle: 'bob', kind: 'audio', id: 'a1', listenedSeconds: 999 },
  ]);
  await db().collection('embed-audio').insertMany([
    { permlink: 'a1', owner: 'alice', status: 'published' },
    { permlink: 'a2', owner: 'alice', status: 'deleted' },
    { permlink: 'a3', owner: 'alice', status: 'failed' },
    { permlink: 'a4', owner: 'someone-else', status: 'published' },
  ]);
});

describe('reads passed through to the hosted service', () => {
  test('authors keeps known handles, drops unknown ones, and names 3Speak upstream', async () => {
    const res = await request(app).post('/incubation/authors').send({ handles: ['alice', 'gone'] }).expect(200);
    expect(res.body.authors.alice.userId).toBe('u-alice');
    expect(res.body.authors).not.toHaveProperty('gone');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.clientId === '3speak-tv-41b6ae')).toBe(true);
  });

  test('a 404 from the service stays a 404', async () => {
    await request(app).get('/incubation/profile/nobody').expect(404);
  });

  test('likes/for relays, and refuses a body without an items array', async () => {
    const res = await request(app).post('/incubation/likes/for').send({ items: [{ author: 'a', permlink: 'p' }], viewer: 'v' }).expect(200);
    expect(res.body.items['a/p'].count).toBe(1);
    await request(app).post('/incubation/likes/for').send({}).expect(400);
  });

  test('followingOf reads the hosted follow list and ignores a malformed name', async () => {
    expect(await followingOf('alice')).toEqual(['carol', 'dave']);
    expect(await followingOf('Not A Handle')).toEqual([]);
  });
});

describe('GET /incubation/feed: the warm-up rail', () => {
  const approve = (...pairs) => db().collection('embed-video').insertMany(
    pairs.map(([owner, permlink, extra]) => ({ owner, permlink, warmup_approved: true, ...extra })),
  );
  const shown = async (query = '') => (await request(app).get(`/incubation/feed${query}`).expect(200)).body.items.map((i) => i.permlink);

  test('shows approved posts, asks the service for the query and caches for 30s', async () => {
    feedItems = [warmupPost('alice', 'p1')];
    await approve(['alice', 'p1']);
    const res = await request(app).get('/incubation/feed?limit=5&contentType=short').expect(200);
    expect(res.body.items.map((i) => i.permlink)).toEqual(['p1']);
    expect(seen.find((s) => s.url.startsWith('/public/feed')).url).toMatch(/limit=5.*contentType=short/);
    expect(res.headers['cache-control']).toBe('public, max-age=30');
  });

  test('nothing shows until 3Speak approved it (fails closed)', async () => {
    feedItems = [warmupPost('alice', 'p1'), warmupPost('alice', 'p2')];
    await approve(['alice', 'p1']);
    await db().collection('embed-video').insertOne({ owner: 'alice', permlink: 'p2', warmup_approved: false });
    expect(await shown()).toEqual(['p1']);
  });

  test('hidden-from-feed and unlisted uploads stay out even when approved', async () => {
    feedItems = [warmupPost('alice', 'p1'), warmupPost('alice', 'hid'), warmupPost('alice', 'unl')];
    await approve(['alice', 'p1'], ['alice', 'hid', { hiddenFromFeed: true }], ['alice', 'unl', { listed_on_3speak: false }]);
    expect(await shown()).toEqual(['p1']);
  });

  test('only people still warming up: graduated and erased authors go', async () => {
    feedItems = [
      warmupPost('alice', 'p1'),
      warmupPost('grad', 'g1', { author: { handle: 'grad', status: 'graduated' } }),
      warmupPost('gone', 'x1', { author: null }),
    ];
    await approve(['alice', 'p1'], ['grad', 'g1'], ['gone', 'x1']);
    expect(await shown()).toEqual(['p1']);
  });

  test('a handle that already exists on Hive is out; a Hive outage leaves the feed as it was', async () => {
    feedItems = [warmupPost('alice', 'p1'), warmupPost('onhive', 'h1')];
    await approve(['alice', 'p1'], ['onhive', 'h1']);
    hiveRpcBatch.mockRejectedValueOnce(new Error('all nodes down'));
    expect(await shown()).toEqual(['p1', 'h1']);
    hiveRpcBatch.mockResolvedValue([{ result: [{ name: 'onhive' }] }]);
    expect(await shown()).toEqual(['p1']);
  });

  test('AI-generated uploads are dropped', async () => {
    feedItems = [warmupPost('alice', 'p1'), warmupPost('alice', 'ai')];
    await approve(['alice', 'p1'], ['alice', 'ai']);
    await db().collection('subtitles-tags').insertOne({ author: 'alice', permlink: 'ai', ai_generated_v2: true });
    expect(await shown()).toEqual(['p1']);
  });

  test('posts from before the warm-up rail opened, or older than the cutoff, are dropped', async () => {
    feedItems = [warmupPost('alice', 'p1'), warmupPost('alice', 'old', { created: '2026-01-01T00:00:00Z' })];
    await approve(['alice', 'p1'], ['alice', 'old']);
    expect(await shown()).toEqual(['p1']);
  });
});

describe('internal routes (this database, never through the proxy)', () => {
  test('watch sums this handle only', async () => {
    const res = await request(app).get('/incubation/internal/watch/alice').expect(200);
    expect(res.body.seconds).toBe(150);
  });

  test.each([
    ['X-Forwarded-For', '/incubation/internal/watch/alice'],
    ['X-Real-IP', '/incubation/internal/watch/alice'],
    ['X-Real-IP', '/incubation/internal/listen/alice'],
    ['X-Forwarded-For', '/incubation/internal/audio/alice'],
  ])('a request with %s (came through nginx) gets 404 on %s', async (header, path) => {
    await request(app).get(path).set(header, '1.2.3.4').expect(404);
  });

  test('listen sums this handle only, and refuses a malformed handle', async () => {
    const res = await request(app).get('/incubation/internal/listen/alice').expect(200);
    expect(res.body).toMatchObject({ handle: 'alice', seconds: 900 });
    await request(app).get('/incubation/internal/listen/Not%20A%20Handle').expect(400);
  });

  test('audio counts live uploads, not deleted or failed ones', async () => {
    const res = await request(app).get('/incubation/internal/audio/alice').expect(200);
    expect(res.body).toMatchObject({ handle: 'alice', uploads: 1 });
  });

  test('claim-assets moves only that handle\'s videos and audio, once', async () => {
    const claim = await request(app).post('/incubation/internal/claim-assets').send({ handle: 'alice', hiveUsername: 'alice-hive' }).expect(200);
    expect(claim.body).toMatchObject({ claimed: 2, audioClaimed: 3 });

    const again = await request(app).post('/incubation/internal/claim-assets').send({ handle: 'alice', hiveUsername: 'alice-hive' }).expect(200);
    expect(again.body).toMatchObject({ claimed: 0, audioClaimed: 0 });

    const moved = await db().collection('embed-audio').findOne({ permlink: 'a1' });
    expect(moved).toMatchObject({ owner: 'alice-hive', owner_claimed_from: 'alice' });
    expect((await db().collection('embed-audio').findOne({ permlink: 'a4' })).owner).toBe('someone-else');
    expect((await db().collection('embed-video').findOne({ permlink: 'v3' })).owner).toBe('someone-else');
  });

  test('claiming onto the same name is a no-op', async () => {
    const res = await request(app).post('/incubation/internal/claim-assets').send({ handle: 'carol', hiveUsername: 'carol' }).expect(200);
    expect(res.body.reason).toBe('same_name');
  });
});

describe('the hosted service is down', () => {
  test('a read is a 502, not a crash', async () => {
    await new Promise((r) => stubServer.close(r));
    await request(app).get('/incubation/feed').expect(502);
  });
});
