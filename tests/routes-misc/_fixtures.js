/**
 * Shared building blocks for the tests in tests/routes-misc.
 *
 * Kept small on purpose: data builders that only one file needs live in that file.
 * What is here is what several route files share: a pinned clock that leaves the
 * MongoDB driver's own timers alone, a stub HTTP service on a loopback port, an XML
 * parser for feed output, and Hive-signed request helpers.
 */
const express = require('express');
const { XMLParser, XMLValidator } = require('fast-xml-parser');

/** The moment every test in this folder treats as "now" unless it says otherwise. */
const NOW = new Date('2026-11-01T12:00:00.000Z');

/**
 * Pin Date (and only Date) to `at`. setTimeout, setImmediate and nextTick stay real,
 * so the MongoDB driver, supertest and express-rate-limit keep working. Undo with
 * jest.useRealTimers() (an afterEach in the calling file).
 */
function pinClock(at = NOW) {
  jest.useFakeTimers({
    now: new Date(at),
    doNotFake: [
      'nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
      'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance',
    ],
  });
  return new Date(at);
}

/**
 * A stub HTTP service on 127.0.0.1:<random port>. `configure(app)` adds the routes.
 * Every request is recorded in `seen` as { method, url, headers, body }.
 *
 *   const svc = await startStub((app) => app.get('/x', (_q, r) => r.json({ ok: 1 })));
 *   process.env.SOMETHING_URL = svc.url;
 *   ...
 *   await svc.close();
 */
async function startStub(configure) {
  const app = express();
  const seen = [];
  app.use(express.json({ limit: '5mb' }));
  app.use((req, _res, next) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: req.body });
    next();
  });
  configure(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    seen,
    close: () => new Promise((resolve) => (server.listening ? server.close(() => resolve()) : resolve())),
  };
}

/**
 * Parse an XML string. Throws when the document is not well formed, so a test that
 * calls this has already asserted "valid XML". Attributes come back as `@_name`.
 */
function parseXml(xml) {
  const valid = XMLValidator.validate(String(xml));
  if (valid !== true) throw new Error(`invalid XML: ${JSON.stringify(valid.err)}`);
  return new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false }).parse(String(xml));
}

/** Always an array, for XML nodes that are a single object when there is one child. */
const asList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

/** supertest's binary parser: collect the body into a Buffer (images, audio). */
function binaryParser(res, callback) {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

module.exports = { NOW, pinClock, startStub, parseXml, asList, binaryParser };
