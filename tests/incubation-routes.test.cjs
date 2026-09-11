// Offline check of routes/incubation.js against a throwaway mongo.
// Deliberately does NOT touch the live checker or its database.
// Point at any throwaway mongo with MONGO_TEST_URI; never a real one.
process.env.MONGODB_URI = process.env.MONGO_TEST_URI || 'mongodb://127.0.0.1:47019';
process.env.DATABASE_NAME = 'checker_incub_test';

const express = require('express');
const { MongoClient } = require('mongodb');
const { connectToMongo, getDb } = require('../utils/db');
const router = require('../routes/incubation');

(async () => {
  const seed = new MongoClient(process.env.MONGODB_URI);
  await seed.connect();
  const d = seed.db(process.env.DATABASE_NAME);
  await d.dropDatabase();
  await d.collection('incubation_accounts').insertMany([
    { butrauthUserId: 'u-alice', handle: 'alice', status: 'incubating', hiveUsername: null },
    { butrauthUserId: 'u-bob',   handle: 'bob',   status: 'graduated',  hiveUsername: 'bob-hive' },
  ]);
  await d.collection('incubation_comments').insertMany([
    { butrauthUserId: 'u-alice', handle: 'alice', kind: 'post', permlink: 'p1', title: 'Alice One',
      body: 'b', parentAuthor: '', parentPermlink: 'hive-181335', jsonMetadata: {},
      videoId: 'v1', createdAt: new Date(), publishedAt: null },
    { butrauthUserId: 'u-alice', handle: 'alice', kind: 'post', permlink: 'p2', title: 'Already Live',
      body: 'b', parentAuthor: '', parentPermlink: 'hive-181335', jsonMetadata: {},
      createdAt: new Date(), publishedAt: new Date(), publishedAs: { author: 'alice', permlink: 'p2' } },
    { butrauthUserId: 'u-alice', handle: 'alice', kind: 'comment', permlink: 'r1', title: '',
      body: 'nice video', parentAuthor: 'someone', parentPermlink: 'their-vid',
      jsonMetadata: {}, createdAt: new Date(), publishedAt: null },
  ]);
  await d.collection('incubation_profiles').insertOne({
    butrauthUserId: 'u-alice', handle: 'alice',
    profile: { name: 'Alice A', about: 'hi', interests: ['music', 'gaming'] },
  });
  await d.collection('incubation_follows').insertMany([
    { butrauthUserId: 'u-alice', following: 'carol', state: 'following' },
    { butrauthUserId: 'u-alice', following: 'dave', state: 'unfollowed' },
  ]);
  await seed.close();

  await connectToMongo();
  const app = express();
  app.use(express.json());
  app.use('/incubation', router);
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json().catch(() => null) }; };

  let fails = 0;
  const check = (name, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : '  -> ' + JSON.stringify(extra))); if (!cond) fails++; };

  const prof = await get('/incubation/profile/alice');
  check('profile returns interests', JSON.stringify(prof.body?.interests) === '["music","gaming"]', prof.body);
  check('profile counts only unpublished-agnostic posts (2 total)', prof.body?.counts?.posts === 2, prof.body?.counts);
  check('following count excludes unfollowed', prof.body?.counts?.following === 1, prof.body?.counts);
  check('followers is null, not 0', prof.body?.counts?.followers === null, prof.body?.counts);

  const posts = await get('/incubation/user/alice/posts');
  check('posts excludes already-published rows', posts.body?.items?.length === 1, posts.body?.items?.map(i => i.permlink));
  check('post marked onChain:false', posts.body?.items?.[0]?.onChain === false, posts.body?.items?.[0]);

  const feed = await get('/incubation/feed');
  check('feed excludes published rows', feed.body?.items?.length === 1, feed.body?.items?.map(i => i.permlink));
  check('feed attaches resolved author', feed.body?.items?.[0]?.author?.userId === 'u-alice', feed.body?.items?.[0]?.author);

  const replies = await get('/incubation/replies?parentAuthor=someone&parentPermlink=their-vid');
  check('replies found for a real Hive parent', replies.body?.items?.length === 1, replies.body);
  const badReplies = await get('/incubation/replies');
  check('replies without params is 400', badReplies.status === 400, badReplies);

  const missing = await get('/incubation/profile/nobody');
  check('unknown handle is 404', missing.status === 404, missing);

  const r = await fetch(base + '/incubation/authors', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handles: ['alice', 'bob', 'ghost'] }) });
  const authors = (await r.json()).authors;
  check('batch authors resolves graduated user to hive account', authors?.bob?.hiveUsername === 'bob-hive', authors);
  check('batch authors omits unknown handle', authors?.ghost === undefined, authors);

  server.close();
  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
