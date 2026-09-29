// Offline check of routes/incubation.js.
//
// The reads now pass through to Butter Auth's hosted incubation service, which
// is stubbed here. The two internal routes still use this database, so they run
// against a throwaway mongo (MONGO_TEST_URI; never a real one).
//
//   MONGO_TEST_URI=mongodb://127.0.0.1:47018 node tests/incubation-routes.test.cjs
process.env.MONGODB_URI = process.env.MONGO_TEST_URI || 'mongodb://127.0.0.1:47019';
process.env.DATABASE_NAME = 'checker_incub_test';

const express = require('express');
const { MongoClient } = require('mongodb');

(async () => {
  // --- a stub of the hosted service -----------------------------------------
  const seen = [];
  const stub = express();
  stub.use(express.json());
  stub.use((req, _res, next) => { seen.push({ method: req.method, url: req.url, clientId: req.get('x-client-id'), body: req.body }); next(); });
  stub.post('/public/authors', (req, res) => res.json({ authors: {
    alice: { handle: 'alice', status: 'incubating', userId: 'u-alice', hiveUsername: null },
    gone: { handle: 'gone', status: 'unknown', userId: null, hiveUsername: null },
  } }));
  stub.get('/public/feed', (_req, res) => res.json({ items: [{ permlink: 'p1', onChain: false }] }));
  stub.get('/public/profile/:h', (req, res) => req.params.h === 'alice'
    ? res.json({ handle: 'alice', counts: { posts: 2 } })
    : res.status(404).json({ error: 'No such user' }));
  stub.post('/public/likes/for', (_req, res) => res.json({ items: { 'a/p': { count: 1, liked: true } } }));
  stub.get('/public/user/:h/following', (req, res) => res.json({ items: [{ name: 'carol' }, { name: 'dave' }] }));
  const stubServer = stub.listen(0);
  await new Promise(r => stubServer.once('listening', r));
  process.env.INCUBATION_HOSTED_URL = `http://127.0.0.1:${stubServer.address().port}`;

  // --- this database, for the internal routes ------------------------------
  const seed = new MongoClient(process.env.MONGODB_URI);
  await seed.connect();
  const d = seed.db(process.env.DATABASE_NAME);
  await d.dropDatabase();
  await d.collection('incubation_watch').insertMany([
    { handle: 'alice', contentSeconds: 100.4 },
    { handle: 'alice', contentSeconds: 50 },
    { handle: 'bob', contentSeconds: 999 },
  ]);
  await d.collection('embed-video').insertMany([
    { permlink: 'v1', owner: 'alice' },
    { permlink: 'v2', owner: 'alice' },
    { permlink: 'v3', owner: 'someone-else' },
  ]);

  const { connectToMongo } = require('../utils/db');
  await connectToMongo();
  const router = require('../routes/incubation');
  const { followingOf } = require('../utils/incubationHosted');
  const app = express();
  app.use(express.json());
  app.use('/incubation', router);
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (method, p, { body, headers = {} } = {}) => {
    const r = await fetch(base + p, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, cache: r.headers.get('cache-control'), body: await r.json().catch(() => null) };
  };

  let fails = 0;
  const check = (name, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : '  -> ' + JSON.stringify(extra))); if (!cond) fails++; };

  // --- pass-through reads ---------------------------------------------------
  const authors = await req('POST', '/incubation/authors', { body: { handles: ['alice', 'gone'] } });
  check('authors keeps the known handle', authors.body?.authors?.alice?.userId === 'u-alice', authors.body);
  check('authors drops a handle nobody holds', !('gone' in (authors.body?.authors || {})), authors.body);
  check('every upstream call names 3Speak', seen.every(s => s.clientId === '3speak-tv-41b6ae'), seen);

  const feed = await req('GET', '/incubation/feed?limit=5&contentType=short');
  check('feed relays the items', feed.body?.items?.[0]?.permlink === 'p1', feed.body);
  check('feed passes its query on', seen.some(s => s.url === '/public/feed?limit=5&contentType=short'), seen.map(s => s.url));
  check('feed keeps its cache header', feed.cache === 'public, max-age=30', feed.cache);

  const missing = await req('GET', '/incubation/profile/nobody');
  check('a 404 from the service stays a 404', missing.status === 404, missing);

  const likes = await req('POST', '/incubation/likes/for', { body: { items: [{ author: 'a', permlink: 'p' }], viewer: 'v' } });
  check('likes/for relays', likes.body?.items?.['a/p']?.count === 1, likes.body);
  check('likes/for refuses a non-array', (await req('POST', '/incubation/likes/for', { body: {} })).status === 400);

  check('followingOf reads the hosted follow list', JSON.stringify(await followingOf('alice')) === '["carol","dave"]');
  check('followingOf ignores a malformed name', (await followingOf('Not A Handle')).length === 0);

  // --- internal routes --------------------------------------------------------
  const watch = await req('GET', '/incubation/internal/watch/alice');
  check('watch sums this handle only', watch.body?.seconds === 150, watch.body);
  const viaNginx = await req('GET', '/incubation/internal/watch/alice', { headers: { 'X-Forwarded-For': '1.2.3.4' } });
  check('internal routes are invisible through a proxy', viaNginx.status === 404, viaNginx);
  const viaReal = await req('GET', '/incubation/internal/watch/alice', { headers: { 'X-Real-IP': '1.2.3.4' } });
  check('X-Real-IP alone also counts as proxied', viaReal.status === 404, viaReal);

  const claim = await req('POST', '/incubation/internal/claim-assets', { body: { handle: 'alice', hiveUsername: 'alice-hive' } });
  check('claim moves only that handle\'s uploads', claim.body?.claimed === 2, claim.body);
  const again = await req('POST', '/incubation/internal/claim-assets', { body: { handle: 'alice', hiveUsername: 'alice-hive' } });
  check('claim is idempotent', again.body?.claimed === 0, again.body);
  const other = await d.collection('embed-video').findOne({ permlink: 'v3' });
  check('someone else\'s upload is untouched', other.owner === 'someone-else', other);
  const same = await req('POST', '/incubation/internal/claim-assets', { body: { handle: 'carol', hiveUsername: 'carol' } });
  check('same name is refused as a no-op', same.body?.reason === 'same_name', same.body);

  // --- the service is down --------------------------------------------------
  await new Promise(r => stubServer.close(r));
  const down = await req('GET', '/incubation/feed');
  check('service down is a 502, not a crash', down.status === 502, down);

  await d.dropDatabase();
  await seed.close();
  server.close();
  console.log(fails === 0 ? '\nall passed' : `\n${fails} FAILED`);
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
