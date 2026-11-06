/**
 * utils/slimFeed.js: feed LIST responses drop the post body (a card never reads
 * it, and it was ~80% of the payload). Shorts keep `hive_body` because it is their
 * visible caption. Detail routes are never wrapped.
 */
const request = require('supertest');
const express = require('express');
const { slimFeed, makeSlimFeed, HEAVY_FIELDS, SHORTS_HEAVY_FIELDS } = require('../../utils/slimFeed');

const card = (extra = {}) => ({ permlink: 'p', title: 'T', body: 'long body', description: 'desc', hive_body: 'caption', ...extra });

/** An app that answers `payload` from behind the given middleware. */
function appReturning(payload, middleware = slimFeed) {
  const app = express();
  app.use(middleware);
  app.get('/', (_req, res) => res.json(payload));
  return app;
}

describe('slimFeed', () => {
  test.each(['videos', 'items', 'results', 'shorts', 'trends', 'data'])('strips heavy fields from every card under `%s`', async (key) => {
    const res = await request(appReturning({ [key]: [card(), card({ permlink: 'q' })], total: 2 })).get('/').expect(200);
    expect(res.body[key]).toEqual([{ permlink: 'p', title: 'T' }, { permlink: 'q', title: 'T' }]);
    expect(res.body.total).toBe(2);
  });

  test('a bare array response is slimmed too', async () => {
    const res = await request(appReturning([card()])).get('/').expect(200);
    expect(res.body).toEqual([{ permlink: 'p', title: 'T' }]);
  });

  test('non-list keys, non-object items and scalar payloads pass through untouched', async () => {
    const payload = { video: card(), videos: [null, 3, 'x'], meta: { body: 'kept' } };
    expect((await request(appReturning(payload)).get('/').expect(200)).body).toEqual(payload);
    expect((await request(appReturning('plain')).get('/').expect(200)).body).toBe('plain');
  });

  test('shorts keep their caption (hive_body)', async () => {
    const res = await request(appReturning({ shorts: [card()] }, makeSlimFeed(SHORTS_HEAVY_FIELDS))).get('/').expect(200);
    expect(res.body.shorts).toEqual([{ permlink: 'p', title: 'T', hive_body: 'caption' }]);
  });

  test('a card with nothing to strip is passed by reference, never copied', () => {
    const untouched = { permlink: 'p' };
    let sent;
    const res = { json: (p) => { sent = p; } };
    slimFeed({}, res, () => {});
    res.json({ videos: [untouched] });
    expect(sent.videos[0]).toBe(untouched);
  });

  test('a payload that throws while being read is still sent', () => {
    const hostile = {};
    Object.defineProperty(hostile, 'videos', { get() { throw new Error('boom'); }, enumerable: true });
    let sent;
    const res = { json: (p) => { sent = p; return 'sent'; } };
    slimFeed({}, res, () => {});
    expect(res.json(hostile)).toBe('sent');
    expect(sent).toBe(hostile);
  });

  test('the field lists are what the comments promise', () => {
    expect(HEAVY_FIELDS).toEqual(['body', 'description', 'hive_body']);
    expect(SHORTS_HEAVY_FIELDS).toEqual(['body', 'description']);
  });
});
