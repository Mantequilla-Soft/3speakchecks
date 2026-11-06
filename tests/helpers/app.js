/**
 * An express app with the same global middleware as server.js (CORS, JSON bodies
 * via utils/jsonBody) and only the routers a test mounts, for supertest:
 *
 *   const request = require('supertest');
 *   const app = buildApp(['/advertise', require('../routes/advertise')]);
 *   await request(app).get('/advertise/rates').expect(200);
 *
 * server.js itself is not loaded: it connects, listens and starts the cron jobs.
 */
const express = require('express');
const cors = require('cors');
// As in server.js: async handlers' rejections reach the error middleware.
require('../../utils/asyncErrors');
const { jsonBody } = require('../../utils/jsonBody');

function buildApp(...mounts) {
  const app = express();
  app.use(cors());
  app.use(jsonBody);
  for (const [path, ...handlers] of mounts) app.use(path, ...handlers);
  // Same shape as an unhandled error in production, so a crash shows as a 500
  // in the assertion instead of an HTML stack page.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return app;
}

/** The Authorization header for routes behind validateApiKey. */
const apiKeyHeader = () => ({ Authorization: `Bearer ${process.env.API_SECRET_KEY}` });

module.exports = { buildApp, apiKeyHeader };
