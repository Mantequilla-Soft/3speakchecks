/**
 * utils/concurrencyGate.js: caps concurrent requests of one kind (the RSS feeds),
 * queues a few, turns the rest away with 503 + Retry-After, and always gives the
 * slot back, whether the response finished or the client left.
 */
const express = require('express');
const http = require('http');
const request = require('supertest');
const { createConcurrencyGate } = require('../utils/concurrencyGate');

// An app whose /work requests stay open until the test lets them go.
const gatedApp = (opts) => {
  const gate = createConcurrencyGate({ name: 'test', ...opts });
  const held = [];
  const app = express();
  app.get('/work', gate, (req, res) => { held.push(res); });
  const finishOne = () => held.shift().send('done');
  return { app, gate, held, finishOne };
};

const until = async (cond, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('createConcurrencyGate', () => {
  let server;
  afterEach(async () => { if (server) await new Promise((r) => server.close(r)); server = null; });
  const listen = (app) => new Promise((r) => { server = http.createServer(app).listen(0, () => r(server)); });

  it('runs up to max at once, queues the next ones and starts them in arrival order', async () => {
    const { app, gate, held, finishOne } = gatedApp({ max: 2, maxQueue: 5, queueTimeoutMs: 5000 });
    await listen(app);
    const agent = request(server);
    const replies = [1, 2, 3, 4].map(() => agent.get('/work').then((r) => r));
    await until(() => held.length === 2 && gate.stats().waiting === 2);
    expect(gate.stats()).toEqual({ running: 2, waiting: 2 });

    finishOne();                                   // a slot frees: the 3rd starts
    await until(() => held.length === 2 && gate.stats().waiting === 1);
    expect(gate.stats().running).toBe(2);

    while (held.length || gate.stats().waiting) {
      if (held.length) finishOne();
      await new Promise((r) => setTimeout(r, 5));
    }
    const done = await Promise.all(replies);
    expect(done.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(gate.stats()).toEqual({ running: 0, waiting: 0 });
  });

  it('answers 503 with Retry-After once the queue is full', async () => {
    const { app, gate, held } = gatedApp({ max: 1, maxQueue: 1, queueTimeoutMs: 5000, retryAfterSec: 42 });
    await listen(app);
    const agent = request(server);
    const first = agent.get('/work').then((r) => r);
    await until(() => held.length === 1);
    const second = agent.get('/work').then((r) => r);
    await until(() => gate.stats().waiting === 1);

    const third = await agent.get('/work');
    expect(third.status).toBe(503);
    expect(third.headers['retry-after']).toBe('42');

    held.shift().send('done');
    await until(() => held.length === 1);
    held.shift().send('done');
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(gate.stats()).toEqual({ running: 0, waiting: 0 });
  });

  it('turns a waiter away after queueTimeoutMs, without losing the running slot', async () => {
    const { app, gate, held } = gatedApp({ max: 1, maxQueue: 5, queueTimeoutMs: 50 });
    await listen(app);
    const agent = request(server);
    const first = agent.get('/work').then((r) => r);
    await until(() => held.length === 1);

    const late = await agent.get('/work');
    expect(late.status).toBe(503);
    expect(gate.stats()).toEqual({ running: 1, waiting: 0 });

    held.shift().send('done');
    expect((await first).status).toBe(200);
    await until(() => gate.stats().running === 0);
  });

  it('gives the slot back when a running client disconnects', async () => {
    const { app, gate, held } = gatedApp({ max: 1, maxQueue: 5, queueTimeoutMs: 5000 });
    await listen(app);
    const { port } = server.address();
    const req = http.get({ port, path: '/work' });
    req.on('error', () => {});
    await until(() => held.length === 1);
    req.destroy();
    await until(() => gate.stats().running === 0);

    // The next request gets straight in.
    const next = request(server).get('/work').then((r) => r);
    await until(() => held.length === 2);
    held.pop().send('done');
    expect((await next).status).toBe(200);
  });

  it('drops a waiting client that disconnects from the queue', async () => {
    const { app, gate, held } = gatedApp({ max: 1, maxQueue: 5, queueTimeoutMs: 5000 });
    await listen(app);
    const { port } = server.address();
    const first = request(server).get('/work').then((r) => r);
    await until(() => held.length === 1);
    const req = http.get({ port, path: '/work' });
    req.on('error', () => {});
    await until(() => gate.stats().waiting === 1);
    req.destroy();
    await until(() => gate.stats().waiting === 0);

    held.shift().send('done');
    expect((await first).status).toBe(200);
    await until(() => gate.stats().running === 0);
    expect(held.length).toBe(0);                   // the one that left never ran
  });
});
