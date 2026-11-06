/**
 * routes/scheduledPosts.js: queueing a Hive post for later. The cron (services/
 * scheduledPosts.js) broadcasts it as the owner with @threespeak's posting key, so
 * the write routes must only accept owners who granted @threespeak posting authority
 * on chain. The grant is read from a fake Hive chain; the queue is real MongoDB.
 */
const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp, apiKeyHeader } = require('../helpers/app');
const { hiveAccount, fakeHiveChain } = require('../helpers/hive');
const { pinClock, NOW } = require('./_fixtures');

const db = testDb.use();
const app = buildApp(['/scheduled-posts', require('../../routes/scheduledPosts')]);
const queue = () => db().collection('scheduled-posts');

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const inFuture = (ms) => new Date(NOW.getTime() + ms).toISOString();

// alice granted @threespeak posting authority, bob did not, carol granted it with too
// little weight to act alone.
const alice = hiveAccount('alice', { postingDelegates: ['threespeak'] });
const bob = hiveAccount('bob');
const carol = hiveAccount('carol');
let chain;

beforeEach(() => {
  pinClock();
  chain = fakeHiveChain([alice, bob, {
    ...carol.chainAccount(),
    posting: { weight_threshold: 2, account_auths: [['threespeak', 1]], key_auths: [[carol.publicKey, 2]] },
  }]);
});
afterEach(() => jest.useRealTimers());

const create = (body, headers = apiKeyHeader()) => request(app).post('/scheduled-posts/create').set(headers)
  .send({ owner: 'alice', permlink: 'my-post', scheduledOn: inFuture(DAY), title: 'Hello', description: 'desc', ...body });
const update = (body, headers = apiKeyHeader()) => request(app).post('/scheduled-posts/update').set(headers)
  .send({ owner: 'alice', permlink: 'my-post', ...body });
const cancel = (body, headers = apiKeyHeader()) => request(app).post('/scheduled-posts/cancel').set(headers)
  .send({ owner: 'alice', permlink: 'my-post', ...body });

const seed = (extra = {}) => queue().insertOne({
  owner: 'alice', permlink: 'my-post', status: 'scheduled', scheduledOn: new Date(inFuture(DAY)),
  title: 'Hello', body: 'b', tags: ['a'], jsonMetadata: { app: '3speak/embed', tags: ['a'] },
  attempts: 2, lastError: 'node timeout', createdAt: NOW, updatedAt: NOW, ...extra,
});

describe('who may write', () => {
  test.each([
    ['create', create],
    ['update', (b, h) => update({ updates: { title: 'x' }, ...b }, h)],
    ['cancel', cancel],
  ])('%s without the app key is a 401 and never asks the chain', async (_name, call) => {
    await seed();
    await call({}, {}).expect(401);
    await call({}, { Authorization: 'Bearer wrong' }).expect(401);
    expect(chain.calls).toHaveLength(0);
    expect((await queue().findOne()).status).toBe('scheduled');
  });

  test.each([
    ['create', create],
    ['update', (b) => update({ updates: { title: 'x' }, ...b })],
    ['cancel', cancel],
  ])('%s for an owner who never granted @threespeak posting authority is a 403', async (_name, call) => {
    const res = await call({ owner: 'bob' }).expect(403);
    expect(res.body.error).toMatch(/has not granted @threespeak/);
    expect(await queue().countDocuments({ owner: 'bob' })).toBe(0);
  });

  test('a grant below the account\'s weight threshold does not count', async () => {
    await create({ owner: 'carol' }).expect(403);
  });

  test('an account that does not exist is a 403', async () => {
    await create({ owner: 'ghost' }).expect(403);
  });

  test('when the chain cannot be read the answer is a 502, not a guess', async () => {
    chain.spy.mockRejectedValue(new Error('all nodes down'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    for (const call of [create, (b) => update({ updates: { title: 'x' }, ...b }), cancel]) {
      expect((await call({})).status).toBe(502);
    }
    expect(await queue().countDocuments()).toBe(0);
  });

  // SECURITY: the file header promises "Write paths require a Hive posting-key signature
  // from the owner", and buildCreateMessage/verifySignedPayload exist for it, but no
  // route calls them. The only checks are validateApiKey and the on-chain grant. The
  // app key ships in the frontend bundle, so anyone can queue a post (body, tags and
  // beneficiaries of their choosing) that the cron then publishes AS any user who
  // granted @threespeak, or rewrite or cancel that user's queued posts.
  // (routes/scheduledPosts.js:51, :212, :324; helpers at :28-41 are unused)
  test.skip('BUG: create without a signature from the owner is refused', async () => {
    await create({ beneficiaries: [{ account: 'mallory', weight: 10000 }] }).expect(401);
    expect(await queue().countDocuments()).toBe(0);
  });
});

describe('POST /scheduled-posts/create', () => {
  test('queues the post with safe defaults and answers 201 with its id', async () => {
    const res = await create({ tags: ['music', 'live'] }).expect(201);

    expect(res.body).toEqual({ success: true, id: expect.any(String), scheduledOn: inFuture(DAY) });
    const doc = await queue().findOne({ owner: 'alice' }, { projection: { _id: 0 } });
    expect(doc).toEqual({
      owner: 'alice', permlink: 'my-post', status: 'scheduled', scheduledOn: new Date(inFuture(DAY)),
      title: 'Hello', description: 'desc', body: 'desc', tags: ['music', 'live'],
      jsonMetadata: { app: '3speak/embed', tags: ['music', 'live'] }, beneficiaries: [],
      payoutOptions: 'default', thumbnail: null, parentAuthor: '', parentPermlink: 'hive-181335',
      embedPermlink: null, reblog: false, attempts: 0, lastError: null, createdAt: NOW, updatedAt: NOW,
    });
  });

  test('keeps a client jsonMetadata object and the explicit body, and normalises the payout option', async () => {
    await create({ body: 'full body', jsonMetadata: { app: 'x', video: { a: 1 } }, payoutOptions: 'PowerUp', reblog: true }).expect(201);
    expect(await queue().findOne()).toMatchObject({ body: 'full body', jsonMetadata: { app: 'x', video: { a: 1 } }, payoutOptions: 'powerup', reblog: true });
  });

  test('reblog must be exactly true, and non-array tags or beneficiaries become empty', async () => {
    await create({ reblog: 'yes', tags: 'music', beneficiaries: { account: 'x' }, jsonMetadata: 'not-an-object' }).expect(201);
    expect(await queue().findOne()).toMatchObject({ reblog: false, tags: [], beneficiaries: [], jsonMetadata: { app: '3speak/embed', tags: [] } });
  });

  test('re-scheduling the same permlink updates the entry instead of adding a second one', async () => {
    await create({ title: 'first' }).expect(201);
    await create({ title: 'second', scheduledOn: inFuture(2 * DAY) }).expect(201);
    const rows = await queue().find().toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: 'second', scheduledOn: new Date(inFuture(2 * DAY)) });
  });

  test.each([
    ['no owner', { owner: undefined }, 'owner is required'],
    ['an owner that is not a string', { owner: ['alice'] }, 'owner is required'],
    ['no permlink', { permlink: '' }, 'permlink is required'],
    ['an unreadable date', { scheduledOn: 'next tuesday' }, 'scheduledOn must be a valid ISO-8601 date'],
    ['a time in the past', { scheduledOn: inFuture(-MIN) }, 'scheduledOn must be between 5 minutes and 90 days from now'],
    ['a time under five minutes away', { scheduledOn: inFuture(4 * MIN) }, 'scheduledOn must be between 5 minutes and 90 days from now'],
    ['a time over 90 days away', { scheduledOn: inFuture(91 * DAY) }, 'scheduledOn must be between 5 minutes and 90 days from now'],
    ['an unknown payout option', { payoutOptions: 'burn' }, 'payoutOptions must be default | powerup | decline'],
  ])('%s is a 422', async (_label, body, error) => {
    const res = await create(body).expect(422);
    expect(res.body.error).toBe(error);
    expect(await queue().countDocuments()).toBe(0);
  });

  test.each([[5 * MIN], [90 * DAY]])('the window edges (%d ms ahead) are accepted', async (lead) => {
    await create({ scheduledOn: inFuture(lead) }).expect(201);
  });

  test('a failed write is a 500', async () => {
    const { Collection } = require('mongodb');
    jest.spyOn(Collection.prototype, 'findOneAndUpdate').mockRejectedValue(new Error('down'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    expect((await create({}).expect(500)).body.error).toBe('Could not save scheduled post');
  });
});

describe('GET /scheduled-posts/:username', () => {
  test('lists the owner\'s posts soonest first, without the heavy body and metadata', async () => {
    await seed({ permlink: 'later', scheduledOn: new Date(inFuture(3 * DAY)) });
    await seed({ permlink: 'sooner', scheduledOn: new Date(inFuture(DAY)), status: 'posted', postedAt: NOW, broadcastTxId: 'tx1' });
    await seed({ owner: 'bob', permlink: 'not-mine' });

    const res = await request(app).get('/scheduled-posts/ALICE').expect(200);

    expect(res.body.count).toBe(2);
    expect(res.body.scheduled_posts.map((p) => p.permlink)).toEqual(['sooner', 'later']);
    expect(res.body.scheduled_posts[0]).toMatchObject({ status: 'posted', broadcastTxId: 'tx1', attempts: 2, lastError: 'node timeout' });
    for (const p of res.body.scheduled_posts) {
      expect(p).not.toHaveProperty('body');
      expect(p).not.toHaveProperty('jsonMetadata');
    }
  });

  test('filters by status and caps the limit at 100', async () => {
    await queue().insertMany(Array.from({ length: 120 }, (_, i) => ({ owner: 'alice', permlink: `p${i}`, status: 'scheduled', scheduledOn: new Date(NOW.getTime() + i) })));
    await seed({ permlink: 'gone', status: 'cancelled' });

    expect((await request(app).get('/scheduled-posts/alice?limit=500').expect(200)).body.count).toBe(100);
    expect((await request(app).get('/scheduled-posts/alice?limit=3').expect(200)).body.count).toBe(3);
    const cancelled = await request(app).get('/scheduled-posts/alice?status=cancelled').expect(200);
    expect(cancelled.body.scheduled_posts.map((p) => p.permlink)).toEqual(['gone']);
  });

  test('a blank username is a 400', async () => {
    await request(app).get('/scheduled-posts/%20').expect(400);
  });

  test('a database failure is a 500', async () => {
    const { Collection } = require('mongodb');
    jest.spyOn(Collection.prototype, 'find').mockImplementation(() => { throw new Error('down'); });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await request(app).get('/scheduled-posts/alice').expect(500);
  });
});

describe('POST /scheduled-posts/update', () => {
  test('changes only whitelisted fields, never status or bookkeeping', async () => {
    await seed();
    const res = await update({ updates: { title: 'New', body: 'new body', status: 'posted', attempts: 99, broadcastTxId: 'fake', postedAt: 'now' } }).expect(200);

    expect(res.body).toMatchObject({ success: true, id: expect.any(String) });
    const doc = await queue().findOne();
    expect(doc).toMatchObject({ title: 'New', body: 'new body', status: 'scheduled', attempts: 2, updatedAt: NOW });
    expect(doc).not.toHaveProperty('broadcastTxId');
    expect(doc).not.toHaveProperty('postedAt');
  });

  test('moving the time re-arms the post: attempts and the last error are reset', async () => {
    await seed();
    await update({ updates: { scheduledOn: inFuture(2 * DAY) } }).expect(200);
    expect(await queue().findOne()).toMatchObject({ scheduledOn: new Date(inFuture(2 * DAY)), attempts: 0, lastError: null });
  });

  test('tag and thumbnail edits are mirrored into the broadcast metadata', async () => {
    await seed({ jsonMetadata: { app: '3speak/embed', tags: ['old'], video: { duration: 10 } } });
    await update({ updates: { tags: ['new'], thumbnail: 'https://img/x.jpg' } }).expect(200);
    expect((await queue().findOne()).jsonMetadata).toEqual({
      app: '3speak/embed', tags: ['new'], image: ['https://img/x.jpg'], video: { duration: 10, thumbnail: 'https://img/x.jpg' },
    });
  });

  test('clearing the thumbnail removes it from the metadata too', async () => {
    await seed({ jsonMetadata: { tags: [], image: ['https://img/x.jpg'], video: { thumbnail: 'https://img/x.jpg' } } });
    await update({ updates: { thumbnail: null, tags: 'not-a-list' } }).expect(200);
    expect((await queue().findOne()).jsonMetadata).toEqual({ tags: [], video: {} });
  });

  test('reblog is coerced to a strict boolean and the payout option normalised', async () => {
    await seed();
    await update({ updates: { reblog: 1, payoutOptions: 'DECLINE' } }).expect(200);
    expect(await queue().findOne()).toMatchObject({ reblog: false, payoutOptions: 'decline' });
  });

  test.each(['posted', 'processing', 'cancelled', 'failed'])('a post in status %s is no longer editable (404)', async (status) => {
    await seed({ status });
    await update({ updates: { title: 'x', tags: ['t'] } }).expect(404);
    expect((await queue().findOne()).title).toBe('Hello');
  });

  test.each([
    [{ owner: 7 }, 'owner required'],
    [{ permlink: null }, 'permlink required'],
    [{ updates: undefined }, 'updates object required'],
    [{ updates: 'title=x' }, 'updates object required'],
    [{ updates: { payoutOptions: 'burn' } }, 'payoutOptions must be default | powerup | decline'],
    [{ updates: { scheduledOn: 'soon' } }, 'scheduledOn must be a valid ISO-8601 date'],
    [{ updates: { scheduledOn: inFuture(MIN) } }, 'scheduledOn must be between 5 minutes and 90 days from now'],
  ])('%j is a 422', async (body, error) => {
    await seed();
    const res = await update(body).expect(422);
    expect(res.body.error).toBe(error);
  });
});

describe('POST /scheduled-posts/cancel', () => {
  test.each(['scheduled', 'failed'])('a %s post is cancelled', async (status) => {
    await seed({ status });
    const res = await cancel({}).expect(200);
    expect(res.body).toMatchObject({ success: true, status: 'cancelled' });
    expect(await queue().findOne()).toMatchObject({ status: 'cancelled', updatedAt: NOW });
  });

  test.each(['posted', 'processing', 'cancelled'])('a %s post cannot be cancelled (404)', async (status) => {
    await seed({ status });
    await cancel({}).expect(404);
    expect((await queue().findOne()).status).toBe(status);
  });

  test('only the named owner\'s post is touched', async () => {
    await seed({ owner: 'bob' });
    await cancel({}).expect(404);
    expect((await queue().findOne()).status).toBe('scheduled');
  });

  test('a missing owner or permlink is a 422', async () => {
    await cancel({ permlink: '' }).expect(422);
    await cancel({ owner: '' }).expect(422);
  });

  test('a database failure is a 500', async () => {
    const { Collection } = require('mongodb');
    jest.spyOn(Collection.prototype, 'findOneAndUpdate').mockRejectedValue(new Error('down'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await cancel({}).expect(500);
  });
});
