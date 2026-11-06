/**
 * POST /client-errors (routes/clientErrors.js): the frontend's error boundary
 * reports a broken page with navigator.sendBeacon (a text/plain body). What is
 * stored is route, error and browser only: never a query string, never an account.
 */
const request = require('supertest');
const { Collection } = require('mongodb');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const { pinClock, NOW } = require('./_fixtures');

const app = buildApp(['/client-errors', require('../../routes/clientErrors')]);
const db = testDb.use();
const stored = () => db().collection('client_errors').find({}, { projection: { _id: 0 } }).toArray();
const beacon = (body, target = app) => request(target).post('/client-errors').set('Content-Type', 'text/plain;charset=UTF-8')
  .send(typeof body === 'string' ? body : JSON.stringify(body));

beforeEach(() => {
  pinClock(NOW);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.useRealTimers());

describe('storing a report', () => {
  test('a sendBeacon text/plain body is parsed and stored with its browser and site', async () => {
    await beacon({ kind: 'chunk', route: '/watch', message: 'Loading chunk 12 failed', stack: 'at x', componentStack: 'in Watch', appVersion: '1.81.62' })
      .set('Origin', 'https://3speak.tv').set('User-Agent', 'Firefox/140')
      .expect(204);
    expect(await stored()).toEqual([{
      kind: 'chunk', route: '/watch', message: 'Loading chunk 12 failed', stack: 'at x', componentStack: 'in Watch',
      appVersion: '1.81.62', site: 'https://3speak.tv', userAgent: 'Firefox/140', createdAt: NOW,
    }]);
  });

  test('an application/json body works too', async () => {
    await request(app).post('/client-errors').send({ message: 'boom' }).expect(204);
    expect((await stored())[0]).toMatchObject({ kind: 'render', message: 'boom' });
  });

  test.each([
    ['/watch?v=alice/post&access_token=secret', '/watch'],
    ['/callback#token=abc', '/callback'],
    ['/a?b#c', '/a'],
  ])('the route %p is stored as %p: query strings and fragments can carry tokens', async (route, kept) => {
    await beacon({ route, message: 'x' }).expect(204);
    expect((await stored())[0].route).toBe(kept);
  });

  test('anything but kind "chunk" is a render error, and non-string fields are dropped', async () => {
    await beacon({ kind: 'evil', message: 'm', stack: 42, route: ['x'], appVersion: { v: 1 } }).expect(204);
    expect((await stored())[0]).toMatchObject({ kind: 'render', stack: null, route: '', appVersion: null, site: null });
  });

  test('every field is clipped to its limit', async () => {
    await beacon({ route: `/${'r'.repeat(400)}`, message: 'm'.repeat(900), stack: 's'.repeat(5000), componentStack: 'c'.repeat(4000), appVersion: 'v'.repeat(50) })
      .set('User-Agent', 'u'.repeat(400)).expect(204);
    const [row] = await stored();
    expect([row.route.length, row.message.length, row.stack.length, row.componentStack.length, row.appVersion.length, row.userAgent.length])
      .toEqual([300, 500, 4000, 3000, 20, 300]);
  });

  test('a stack alone is enough', async () => {
    await beacon({ stack: 'Error\n at y' }).expect(204);
  });

  test('the collection keeps reports for 30 days (TTL index)', async () => {
    await beacon({ message: 'x' }).expect(204);
    const ttl = (await db().collection('client_errors').indexes()).find((i) => i.key.createdAt === 1);
    expect(ttl.expireAfterSeconds).toBe(30 * 24 * 3600);
  });
});

describe('refusing a report', () => {
  test('400 for a body that is not JSON', async () => {
    await beacon('{not json').expect(400, { error: 'Invalid JSON' });
  });

  test.each([[{}], [{ message: '', stack: '' }], [{ route: '/x' }]])('400 for an empty report %p', async (body) => {
    await beacon(body).expect(400, { error: 'Empty report' });
    expect(await stored()).toEqual([]);
  });

  test('500 when the report cannot be stored', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(Collection.prototype, 'insertOne').mockRejectedValue(new Error('down'));
    await beacon({ message: 'x' }).expect(500, { error: 'Could not store report' });
  });

  test('a broken page cannot flood the collection: 300 reports per 10 minutes for everyone together', async () => {
    // A fresh copy of the router (its limiter is module state) on this file's
    // connected database layer.
    const shared = require('../../utils/db');
    let fresh;
    jest.isolateModules(() => {
      jest.doMock('../../utils/db', () => shared);
      fresh = buildApp(['/client-errors', require('../../routes/clientErrors')]);
    });
    jest.dontMock('../../utils/db');
    jest.spyOn(Collection.prototype, 'insertOne').mockResolvedValue({ acknowledged: true });
    jest.spyOn(Collection.prototype, 'createIndex').mockResolvedValue('ok');
    for (let i = 0; i < 300; i += 1) await beacon({ message: `m${i}` }, fresh).expect(204);
    await beacon({ message: 'one too many' }, fresh).set('X-Forwarded-For', '198.51.100.1').expect(429, { error: 'Too many reports' });
  });
});
