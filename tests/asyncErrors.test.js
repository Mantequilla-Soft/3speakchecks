/**
 * utils/asyncErrors.js: a rejected async route handler reaches the error
 * middleware (a JSON 500) instead of hanging the request and ending the process.
 * utils/input.js: request values that are not text read as empty.
 */
const express = require('express');
const request = require('supertest');
const { handleRouteError } = require('../utils/asyncErrors');
const { asText } = require('../utils/input');

function appWith(handler) {
  const app = express();
  app.get('/x', handler);
  app.use(handleRouteError);
  return app;
}

beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));

describe('async route handlers', () => {
  test('a rejected handler answers a JSON 500 without details', async () => {
    const app = appWith(async () => { throw new Error('secret detail'); });
    const res = await request(app).get('/x').timeout(2000).expect(500);
    expect(res.body).toEqual({ success: false, error: 'internal error' });
  });

  test('the original crash: String() of a query object inside an async handler', async () => {
    const app = appWith(async (req, res) => res.json({ u: String(req.query.u) }));
    await request(app).get('/x?u[toString]=x').timeout(2000).expect(500);
  });

  test('a synchronous throw still works as before', async () => {
    const app = appWith(() => { throw new Error('sync'); });
    await request(app).get('/x').expect(500);
  });

  test('a rejection without a reason is still answered', async () => {
    // eslint-disable-next-line prefer-promise-reject-errors
    const app = appWith(() => Promise.reject());
    await request(app).get('/x').timeout(2000).expect(500);
  });

  test('an error with a client status keeps it, and only exposes its message when marked safe', async () => {
    const app = appWith(async () => { throw Object.assign(new Error('too big'), { status: 413, expose: true }); });
    await request(app).get('/x').expect(413, { success: false, error: 'too big' });
    const hidden = appWith(async () => { throw Object.assign(new Error('internal'), { status: 409 }); });
    await request(hidden).get('/x').expect(409, { success: false, error: 'request failed' });
  });

  test('a handler that already answered is not answered twice', async () => {
    const app = appWith(async (_req, res) => { res.status(202).json({ ok: true }); throw new Error('after the answer'); });
    await request(app).get('/x').expect(202, { ok: true });
  });

  test('handlers that resolve normally and error middleware are untouched', async () => {
    const app = express();
    app.get('/ok', async (_req, res) => res.json({ ok: true }));
    app.get('/next', (_req, _res, next) => next(new Error('passed on')));
    app.use((err, _req, res, _next) => res.status(418).json({ seen: err.message })); // eslint-disable-line no-unused-vars
    await request(app).get('/ok').expect(200, { ok: true });
    await request(app).get('/next').expect(418, { seen: 'passed on' });
  });
});

describe('asText', () => {
  test.each([
    ['alice', 'alice'],
    [42, '42'],
    [true, 'true'],
    [undefined, ''],
    [null, ''],
    [{ toString: 1 }, ''],
    [['a', 'b'], ''],
    [{ $ne: null }, ''],
  ])('%p reads as %p', (value, text) => {
    expect(asText(value)).toBe(text);
  });
});
