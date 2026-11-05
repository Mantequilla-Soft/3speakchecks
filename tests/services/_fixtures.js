/**
 * Shared fixtures for tests/services: a local HTTP stub server, fixed clocks and
 * a few document builders. Nothing here talks to anything but loopback.
 */
const http = require('http');

const NOW = new Date('2026-11-01T12:00:00Z');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ago = (ms, from = NOW) => new Date(from.getTime() - ms);
const ahead = (ms, from = NOW) => new Date(from.getTime() + ms);

/**
 * A throwaway HTTP server on 127.0.0.1 and a random port.
 *
 *   const stub = await stubServer((req, res, body) => res.end('ok'));
 *   stub.url            // 'http://127.0.0.1:<port>'
 *   stub.requests       // [{ method, url, headers, body }] in arrival order
 *   await stub.close()
 *
 * The handler may be replaced between tests with stub.handle(fn). JSON helpers:
 * json(res, status, value) and text(res, status, string, headers).
 */
async function stubServer(handler = (_req, res) => res.end()) {
  let current = handler;
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      try {
        await current(req, res, body);
      } catch (err) {
        if (!res.headersSent) res.statusCode = 500;
        res.end(String(err && err.message));
      }
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    handle(fn) { current = fn; },
    close() {
      for (const s of sockets) s.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function json(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(value));
}

function text(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain', ...headers });
  res.end(body);
}

/**
 * A fetch() replacement for code that calls the global fetch with fixed outside
 * URLs (YouTube API, SoundCloud, ...). Each route is [matcher, responder]: the
 * matcher is a string prefix, a RegExp or a function of the URL; the responder
 * returns { status, body, headers } or throws to simulate a network error.
 * Unmatched URLs fail the test loudly. Every URL asked for is in .calls.
 */
function fakeFetch(routes) {
  const calls = [];
  const fn = jest.fn(async (input, init = {}) => {
    const url = String(input && input.url ? input.url : input);
    calls.push({ url, init });
    const hit = routes.find(([m]) => (typeof m === 'string' ? url.startsWith(m)
      : m instanceof RegExp ? m.test(url) : m(url, init)));
    if (!hit) throw new Error(`[fakeFetch] no route for ${url}`);
    const r = await hit[1](url, init);
    const status = r.status == null ? 200 : r.status;
    const raw = typeof r.body === 'string' ? r.body : JSON.stringify(r.body == null ? null : r.body);
    const headers = new Headers(r.headers || {});
    return {
      ok: status >= 200 && status < 300,
      status,
      headers,
      url: r.url || url,
      text: async () => raw,
      json: async () => JSON.parse(raw),
      arrayBuffer: async () => Buffer.from(raw),
    };
  });
  fn.calls = calls;
  return fn;
}

module.exports = { NOW, MINUTE, HOUR, DAY, ago, ahead, stubServer, json, text, fakeFetch };
