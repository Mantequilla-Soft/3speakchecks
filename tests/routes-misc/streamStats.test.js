/**
 * routes/streamStats.js: live-stream viewer, peak, end and boost capture, written by
 * the 3Speak background service behind STREAM_STATS_SECRET.
 *
 * The gate is a router-level middleware mounted at "/" in server.js, so it also
 * answers every path that reaches it unmatched. The last block pins that trap.
 */
const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const { pinClock, NOW } = require('./_fixtures');

const SECRET = process.env.STREAM_STATS_SECRET;
const db = testDb.use();
const app = buildApp(['/', require('../../routes/streamStats')]);
const stats = () => db().collection('stream-stats');
const boosts = () => db().collection('stream-boosts');

const auth = { Authorization: `Bearer ${SECRET}` };
const post = (path, body, headers = auth) => request(app).post(`/stream-stats/${path}`).set(headers).send(body);
const later = (sec) => new Date(NOW.getTime() + sec * 1000);

afterEach(() => jest.useRealTimers());

describe('the shared-secret gate', () => {
  const routes = [
    ['post', '/stream-stats/viewer'],
    ['post', '/stream-stats/peak'],
    ['post', '/stream-stats/end'],
    ['post', '/stream-stats/boost'],
    ['get', '/stream-stats/room-1'],
  ];

  test.each(routes)('%s %s without credentials is a 401 and writes nothing', async (method, path) => {
    const res = await request(app)[method](path).send({ streamId: 'room-1', peak: 3, sender: 'x' }).expect(401);
    expect(res.body).toEqual({ error: 'unauthorized' });
    expect(await stats().countDocuments()).toBe(0);
    expect(await boosts().countDocuments()).toBe(0);
  });

  test.each([
    ['a wrong bearer token', { Authorization: 'Bearer not-the-secret' }],
    ['the secret with one byte changed', { Authorization: `Bearer ${SECRET.slice(0, -1)}X` }],
    ['a prefix of the secret', { Authorization: `Bearer ${SECRET.slice(0, 4)}` }],
    ['the secret under another scheme', { Authorization: `Basic ${SECRET}` }],
    ['a wrong X-Api-Key', { 'X-Api-Key': 'nope' }],
    ['the app API key', { Authorization: `Bearer ${process.env.API_SECRET_KEY}` }],
  ])('%s is a 401', async (_label, headers) => {
    await post('viewer', { streamId: 'room-1' }, headers).expect(401);
    expect(await stats().countDocuments()).toBe(0);
  });

  test('the secret is accepted as a bearer token or as X-Api-Key', async () => {
    await post('viewer', { streamId: 'a' }, { Authorization: `Bearer  ${SECRET}  ` }).expect(201);
    await post('viewer', { streamId: 'b' }, { 'X-Api-Key': SECRET }).expect(201);
    expect(await stats().countDocuments()).toBe(2);
  });

  test('with no secret configured every route fails closed with a 503', async () => {
    const saved = process.env.STREAM_STATS_SECRET;
    let isolated;
    try {
      delete process.env.STREAM_STATS_SECRET;
      jest.isolateModules(() => { isolated = buildApp(['/', require('../../routes/streamStats')]); });
    } finally {
      process.env.STREAM_STATS_SECRET = saved;
    }
    // Even the would-be empty-string credential gets nowhere.
    const res = await request(isolated).post('/stream-stats/viewer').set('Authorization', 'Bearer ').send({ streamId: 'x' }).expect(503);
    expect(res.body.error).toMatch(/disabled/);
  });
});

describe('POST /stream-stats/viewer', () => {
  test('the first viewer creates the stream, each later one bumps the total', async () => {
    pinClock();
    await post('viewer', { streamId: 'room-1', roomName: 'Alice live', host: 'ALICE' }).expect(201);
    pinClock(later(30));
    await post('viewer', { streamId: 'room-1' }).expect(201);

    expect(await stats().findOne({ _id: 'room-1' })).toEqual({
      _id: 'room-1', startedAt: NOW, peakViewers: 0, totalViewers: 2,
      roomName: 'Alice live', host: 'alice', updatedAt: later(30), lastViewerAt: expect.any(Date),
    });
  });

  test('falls back to roomName as the stream id and trims long values', async () => {
    const long = 'r'.repeat(300);
    await post('viewer', { roomName: `  ${long}  ` }).expect(201);
    const doc = await stats().findOne();
    expect(doc._id).toHaveLength(128);
    expect(doc.roomName).toBe(doc._id);
  });

  test.each([[{}], [{ streamId: '   ' }], [{ streamId: 42 }], [{ streamId: { $gt: '' } }]])(
    'a body without a usable stream id (%j) is a 400', async (body) => {
      const res = await post('viewer', body).expect(400);
      expect(res.body.error).toMatch(/streamId/);
      expect(await stats().countDocuments()).toBe(0);
    },
  );
});

describe('POST /stream-stats/peak', () => {
  test('keeps the highest peak ever reported, rounded', async () => {
    await post('peak', { streamId: 'room-1', peak: 12.6 }).expect(201);
    await post('peak', { streamId: 'room-1', peak: 4 }).expect(201);
    await post('peak', { streamId: 'room-1', peak: '20' }).expect(201);
    expect(await stats().findOne({ _id: 'room-1' })).toMatchObject({ peakViewers: 20, totalViewers: 0 });
  });

  test('does not disturb the viewer total', async () => {
    await post('viewer', { streamId: 'room-1' }).expect(201);
    await post('peak', { streamId: 'room-1', peak: 5 }).expect(201);
    expect(await stats().findOne({ _id: 'room-1' })).toMatchObject({ peakViewers: 5, totalViewers: 1 });
  });

  test.each([[undefined], ['many'], [-1]])('a peak of %p is a 400', async (peak) => {
    const res = await post('peak', { streamId: 'room-1', peak }).expect(400);
    expect(res.body.error).toMatch(/peak/);
  });

  test('a null peak reads as 0 (Number(null) is 0) and never lowers a stored peak', async () => {
    await post('peak', { streamId: 'room-1', peak: 8 }).expect(201);
    await post('peak', { streamId: 'room-1', peak: null }).expect(201);
    expect((await stats().findOne({ _id: 'room-1' })).peakViewers).toBe(8);
  });

  test('a missing stream id is a 400', async () => {
    await post('peak', { peak: 3 }).expect(400);
  });
});

describe('POST /stream-stats/end', () => {
  test('computes the duration from the stored start', async () => {
    pinClock();
    await post('viewer', { streamId: 'room-1' }).expect(201);
    pinClock(later(3600));
    const res = await post('end', { streamId: 'room-1' }).expect(201);

    expect(res.body).toEqual({ ok: true, durationSec: 3600 });
    expect(await stats().findOne({ _id: 'room-1' })).toMatchObject({ startedAt: NOW, endedAt: later(3600), durationSec: 3600 });
  });

  test('an explicit duration wins over the timestamps', async () => {
    const res = await post('end', { streamId: 'room-1', durationSec: 99.4, startedAt: NOW.toISOString(), endedAt: later(10).toISOString() }).expect(201);
    expect(res.body.durationSec).toBe(99);
  });

  test('computes from a startedAt in the body and stores it', async () => {
    const res = await post('end', { streamId: 'room-2', startedAt: NOW.toISOString(), endedAt: later(90).toISOString() }).expect(201);
    expect(res.body.durationSec).toBe(90);
    expect(await stats().findOne({ _id: 'room-2' })).toMatchObject({ startedAt: NOW, peakViewers: 0, totalViewers: 0 });
  });

  test('an end before the start is clamped to zero, never negative', async () => {
    const res = await post('end', { streamId: 'room-3', startedAt: later(60).toISOString(), endedAt: NOW.toISOString() }).expect(201);
    expect(res.body.durationSec).toBe(0);
  });

  test('a stream nobody saw start gets startedAt = endedAt and a null duration', async () => {
    pinClock();
    const res = await post('end', { streamId: 'ghost', startedAt: 'garbage' }).expect(201);
    expect(res.body).toEqual({ ok: true, durationSec: null });
    expect(await stats().findOne({ _id: 'ghost' })).toMatchObject({ startedAt: NOW, endedAt: NOW });
  });

  // num() treats null as the number 0, so a caller that serialises "no duration" as
  // JSON null records a zero-length stream instead of the computed one.
  // (routes/streamStats.js:40 num(), used at :120)
  test('durationSec: null is treated as 0 instead of "compute it from the start"', async () => {
    const res = await post('end', { streamId: 'room-4', startedAt: NOW.toISOString(), endedAt: later(120).toISOString(), durationSec: null }).expect(201);
    expect(res.body.durationSec).toBe(120);
  });

  test('an unreadable endedAt is a 400', async () => {
    const res = await post('end', { streamId: 'room-1', endedAt: 'yesterday-ish' }).expect(400);
    expect(res.body.error).toBe('endedAt is invalid');
  });

  test('a missing stream id is a 400', async () => {
    await post('end', {}).expect(400);
  });
});

describe('POST /stream-stats/boost', () => {
  test('logs each boost with a normalised sender and the stream identity', async () => {
    pinClock();
    await post('boost', { streamId: 'room-1', roomName: 'R', host: 'Alice', sender: 'BOB', message: '  hi!  ', amount: '1.5' }).expect(201);
    await post('boost', { streamId: 'room-1', sender: 'carol', amount: 'lots' }).expect(201);

    const rows = await boosts().find({}, { projection: { _id: 0 } }).sort({ sender: 1 }).toArray();
    expect(rows).toEqual([
      { streamId: 'room-1', roomName: 'R', host: 'alice', sender: 'bob', message: 'hi!', amount: 1.5, createdAt: NOW },
      { streamId: 'room-1', roomName: null, host: null, sender: 'carol', message: null, amount: null, createdAt: NOW },
    ]);
  });

  test('caps a long message at 2000 characters', async () => {
    await post('boost', { streamId: 'room-1', sender: 'bob', message: 'x'.repeat(5000) }).expect(201);
    expect((await boosts().findOne()).message).toHaveLength(2000);
  });

  test.each([[{ sender: 'bob' }], [{ streamId: 'room-1' }], [{ streamId: 'room-1', sender: ['bob'] }]])(
    'a boost without stream or sender (%j) is a 400', async (body) => {
      await post('boost', body).expect(400);
      expect(await boosts().countDocuments()).toBe(0);
    },
  );
});

describe('GET /stream-stats/:streamId', () => {
  test('returns the aggregate with its boost count', async () => {
    await stats().insertOne({ _id: 'room-1', totalViewers: 7, peakViewers: 3 });
    await boosts().insertMany([{ streamId: 'room-1' }, { streamId: 'room-1' }, { streamId: 'other' }]);
    const res = await request(app).get('/stream-stats/room-1').set(auth).expect(200);
    expect(res.body).toEqual({ _id: 'room-1', totalViewers: 7, peakViewers: 3, boostCount: 2 });
  });

  test('an unknown stream is a 404', async () => {
    await request(app).get('/stream-stats/nope').set(auth).expect(404);
  });

  test('a blank stream id is a 400', async () => {
    await request(app).get('/stream-stats/%20').set(auth).expect(400);
  });
});

describe('when the database fails', () => {
  const { Collection } = require('mongodb');
  test.each([
    ['viewer', 'updateOne', { streamId: 'a' }],
    ['peak', 'updateOne', { streamId: 'a', peak: 1 }],
    ['end', 'updateOne', { streamId: 'a', durationSec: 1 }],
    ['boost', 'insertOne', { streamId: 'a', sender: 'b' }],
  ])('POST %s answers a 500 without the driver message', async (path, op, body) => {
    jest.spyOn(Collection.prototype, op).mockRejectedValue(new Error('secret-host:27017 down'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post(path, body).expect(500);
    expect(JSON.stringify(res.body)).not.toMatch(/secret-host/);
  });

  test('GET answers a 500 too', async () => {
    jest.spyOn(Collection.prototype, 'findOne').mockRejectedValue(new Error('down'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await request(app).get('/stream-stats/a').set(auth).expect(500);
  });
});

describe('mounted at "/" the gate answers every path that reaches it', () => {
  // server.js mounts this router last, at "/". Any route mounted AFTER it, or any
  // unknown path, gets this 401 instead of a 404. That is why new routers must be
  // mounted before it.
  test('an unrelated path behind the router is a 401, not a 404', async () => {
    const express = require('express');
    const late = express.Router().get('/mounted-too-late', (_req, res) => res.json({ ok: true }));
    const order = buildApp(['/', require('../../routes/streamStats')], ['/', late]);
    await request(order).get('/mounted-too-late').expect(401);
    await request(order).get('/mounted-too-late').set(auth).expect(200);
  });
});
