const express = require('express');
const request = require('supertest');
const { jsonBody, OWN_PARSER } = require('../utils/jsonBody');

const big = { text: 'x'.repeat(200 * 1024) };

function app() {
  const a = express();
  a.use(jsonBody);
  a.post('/subtitles/edit', express.json({ limit: '2mb' }), (req, res) => res.json({ size: req.body.text.length }));
  a.post('/other', (req, res) => res.json({ size: req.body.text.length }));
  a.put('/subtitles/edit', (req, res) => res.json({ parsed: typeof req.body === 'object' }));
  return a;
}

describe('the app-wide JSON parser', () => {
  test('a route that parses its own body gets its own limit', async () => {
    expect(OWN_PARSER.has('/subtitles/edit')).toBe(true);
    await request(app()).post('/subtitles/edit').send(big).expect(200, { size: big.text.length });
  });

  test('every other route keeps the default 100 kB limit', async () => {
    await request(app()).post('/other').send(big).expect(413);
    await request(app()).post('/other').send({ text: 'ok' }).expect(200, { size: 2 });
  });

  test('only POST is left to the route', async () => {
    await request(app()).put('/subtitles/edit').send({ a: 1 }).expect(200, { parsed: true });
  });
});
