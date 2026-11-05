/**
 * routes/userFilters.js: "not interested" (one video) and "don't show this creator".
 *
 * By design these take the caller's own username without a token (see the file
 * header): they only ever remove content from the caller's own feeds. The tests pin
 * that contract: normalised keys, idempotent writes, scoping per user, and 400s.
 */
const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const { HIDDEN_VIDEOS, HIDDEN_CREATORS } = require('../../utils/userFilters');
const { pinClock, NOW } = require('./_fixtures');

const db = testDb.use();
const app = buildApp(['/', require('../../routes/userFilters')]);

afterEach(() => jest.useRealTimers());

describe('hiding one video', () => {
  test('stores one row per user and video, keyed on lowercased @-stripped names', async () => {
    pinClock();
    const res = await request(app).post('/user/hide-video')
      .send({ username: ' @Alice ', owner: '@Bob', permlink: ' vid-1 ' }).expect(200);

    expect(res.body).toEqual({ success: true, hidden: true });
    const rows = await db().collection(HIDDEN_VIDEOS).find().toArray();
    expect(rows).toEqual([{ _id: 'alice:bob:vid-1', username: 'alice', owner: 'bob', permlink: 'vid-1', createdAt: NOW }]);
  });

  test('accepts `author` as a synonym of `owner`', async () => {
    await request(app).post('/user/hide-video').send({ username: 'alice', author: 'bob', permlink: 'p' }).expect(200);
    expect(await db().collection(HIDDEN_VIDEOS).countDocuments({ owner: 'bob' })).toBe(1);
  });

  test('a double tap is harmless and keeps the first createdAt', async () => {
    pinClock(NOW);
    await request(app).post('/user/hide-video').send({ username: 'alice', owner: 'bob', permlink: 'p' }).expect(200);
    pinClock(new Date(NOW.getTime() + 60_000));
    await request(app).post('/user/hide-video').send({ username: 'alice', owner: 'bob', permlink: 'p' }).expect(200);

    const rows = await db().collection(HIDDEN_VIDEOS).find().toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].createdAt).toEqual(NOW);
  });

  test('unhiding removes only that user\'s row for that video', async () => {
    await db().collection(HIDDEN_VIDEOS).insertMany([
      { _id: 'alice:bob:p', username: 'alice', owner: 'bob', permlink: 'p' },
      { _id: 'carol:bob:p', username: 'carol', owner: 'bob', permlink: 'p' },
    ]);
    const res = await request(app).delete('/user/hide-video').send({ username: 'ALICE', owner: 'bob', permlink: 'p' }).expect(200);

    expect(res.body).toEqual({ success: true, hidden: false });
    expect(await db().collection(HIDDEN_VIDEOS).distinct('_id')).toEqual(['carol:bob:p']);
  });

  test.each([
    ['post', { owner: 'bob', permlink: 'p' }],
    ['post', { username: 'alice', permlink: 'p' }],
    ['post', { username: 'alice', owner: 'bob' }],
    ['post', { username: '  ', owner: 'bob', permlink: 'p' }],
    ['delete', { username: 'alice', owner: 'bob' }],
    ['delete', {}],
  ])('%s with a missing field %j is a 400 and writes nothing', async (method, body) => {
    const res = await request(app)[method]('/user/hide-video').send(body).expect(400);
    expect(res.body).toEqual({ success: false, error: 'username, owner and permlink are required' });
    expect(await db().collection(HIDDEN_VIDEOS).countDocuments()).toBe(0);
  });
});

describe('hiding a creator', () => {
  test('stores one normalised row per user and creator', async () => {
    pinClock();
    await request(app).post('/user/hide-creator').send({ username: 'Alice', creator: '@Spammer' }).expect(200);
    expect(await db().collection(HIDDEN_CREATORS).find().toArray())
      .toEqual([{ _id: 'alice:spammer', username: 'alice', creator: 'spammer', createdAt: NOW }]);
  });

  test('you cannot hide yourself, whatever the spelling', async () => {
    const res = await request(app).post('/user/hide-creator').send({ username: 'alice', creator: '@ALICE' }).expect(400);
    expect(res.body.error).toBe('you cannot hide yourself');
    expect(await db().collection(HIDDEN_CREATORS).countDocuments()).toBe(0);
  });

  test('unhiding removes the row and is a no-op the second time', async () => {
    await db().collection(HIDDEN_CREATORS).insertOne({ _id: 'alice:spammer', username: 'alice', creator: 'spammer' });
    await request(app).delete('/user/hide-creator').send({ username: 'alice', creator: 'spammer' }).expect(200);
    await request(app).delete('/user/hide-creator').send({ username: 'alice', creator: 'spammer' }).expect(200);
    expect(await db().collection(HIDDEN_CREATORS).countDocuments()).toBe(0);
  });

  test.each([
    ['post', { username: 'alice' }],
    ['post', { creator: 'bob' }],
    ['delete', { username: 'alice' }],
    ['delete', { creator: 'bob' }],
  ])('%s without username and creator (%j) is a 400', async (method, body) => {
    const res = await request(app)[method]('/user/hide-creator').send(body).expect(400);
    expect(res.body.error).toBe('username and creator are required');
  });
});

describe('listing what a user dismissed', () => {
  test('returns only that user\'s videos and creators, newest first, without internal ids', async () => {
    const t = (min) => new Date(NOW.getTime() + min * 60_000);
    await db().collection(HIDDEN_VIDEOS).insertMany([
      { _id: 'alice:bob:old', username: 'alice', owner: 'bob', permlink: 'old', createdAt: t(1) },
      { _id: 'alice:bob:new', username: 'alice', owner: 'bob', permlink: 'new', createdAt: t(5) },
      { _id: 'carol:bob:x', username: 'carol', owner: 'bob', permlink: 'x', createdAt: t(9) },
    ]);
    await db().collection(HIDDEN_CREATORS).insertMany([
      { _id: 'alice:spam', username: 'alice', creator: 'spam', createdAt: t(2) },
      { _id: 'carol:spam', username: 'carol', creator: 'spam', createdAt: t(3) },
    ]);

    const res = await request(app).get('/user/hidden/@Alice').expect(200);

    expect(res.body).toEqual({
      success: true,
      videos: [
        { owner: 'bob', permlink: 'new', createdAt: t(5).toISOString() },
        { owner: 'bob', permlink: 'old', createdAt: t(1).toISOString() },
      ],
      creators: [{ creator: 'spam', createdAt: t(2).toISOString() }],
    });
  });

  test('a user who dismissed nothing gets empty lists', async () => {
    const res = await request(app).get('/user/hidden/nobody').expect(200);
    expect(res.body).toEqual({ success: true, videos: [], creators: [] });
  });

  test('a blank username is a 400', async () => {
    await request(app).get('/user/hidden/%20').expect(400);
  });
});

describe('when the database fails', () => {
  // The routes hold their own reference to getDb, so the failure is injected one
  // level down, in the driver every route shares.
  const { Collection } = require('mongodb');

  test.each([
    ['post', '/user/hide-video', { username: 'a', owner: 'b', permlink: 'p' }, 'updateOne'],
    ['delete', '/user/hide-video', { username: 'a', owner: 'b', permlink: 'p' }, 'deleteOne'],
    ['post', '/user/hide-creator', { username: 'a', creator: 'b' }, 'updateOne'],
    ['delete', '/user/hide-creator', { username: 'a', creator: 'b' }, 'deleteOne'],
    ['get', '/user/hidden/a', undefined, 'find'],
  ])('%s %s answers a generic 500 without leaking the error', async (method, path, body, op) => {
    jest.spyOn(Collection.prototype, op).mockImplementation(() => { throw new Error('mongo exploded at 10.0.0.1'); });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app)[method](path).send(body).expect(500);
    expect(res.body).toEqual({ success: false, error: 'Internal server error' });
  });
});
