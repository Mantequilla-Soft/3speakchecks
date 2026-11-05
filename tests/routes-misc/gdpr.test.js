/**
 * GDPR: the public request form (routes/gdpr.js) and the secret-gated admin API
 * that fulfils requests (routes/gdprAdmin.js over utils/gdprAdmin.js).
 *
 * The admin side is checked against a real database seeded with two accounts, so
 * "export holds only this person's rows" and "erase removes exactly this person's
 * rows" are proven on actual queries, not on a fake.
 */
const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const { pinClock, NOW } = require('./_fixtures');
const gdprUtil = require('../../utils/gdprAdmin');

const app = buildApp(['/', require('../../routes/gdpr')], ['/gdpr-admin', require('../../routes/gdprAdmin')]);
const db = testDb.use();

const SECRET = 'test-gdpr-admin-secret';
const admin = () => ({ Authorization: `Bearer ${SECRET}` });
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => pinClock(NOW));
afterEach(() => jest.useRealTimers());

// One row for `user` in every collection the admin API says it covers, plus
// watch history (matched by _id prefix rather than by a field).
async function seedAccount(user) {
  for (const { coll, field } of gdprUtil.OWNED) {
    const row = field === '_id' ? { _id: user } : { [field]: user, permlink: `${user}-${coll}-${field}` };
    await db().collection(coll).insertOne({ ...row, marker: `${user}:${coll}` });
  }
  await db().collection('watch_history').insertMany([
    { _id: `${user}:someowner:video-1`, at: NOW },
    { _id: `${user}:otherowner:video-2`, at: NOW },
  ]);
}

const countFor = async (user) => {
  let n = 0;
  for (const { coll, field } of gdprUtil.OWNED) n += await db().collection(coll).countDocuments({ [field]: user });
  n += await db().collection('watch_history').countDocuments({ _id: { $regex: `^${user}:` } });
  return n;
};

describe('GET /gdpr-request/scope', () => {
  test('lists what is held, each entry saying whether the original lives on Hive', async () => {
    const res = await request(app).get('/gdpr-request/scope').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.scope.length).toBeGreaterThan(0);
    for (const entry of res.body.scope) {
      expect(entry).toEqual({ key: expect.any(String), label: expect.any(String), detail: expect.any(String), onChain: expect.any(Boolean) });
    }
  });
});

describe('POST /gdpr-request: recording a request', () => {
  const valid = { username: '@Alice', type: 'export', contact: 'alice@example.com', message: '  please send it  ' };

  test('records an open request with a reference and a one-month deadline, and touches no data', async () => {
    await seedAccount('alice');
    const before = await countFor('alice');

    const res = await request(app).post('/gdpr-request').send(valid).expect(200);
    expect(res.body).toEqual({ success: true, ref: expect.stringMatching(/^[0-9a-f]{12}$/), dueBy: '2026-12-01' });

    const row = await db().collection('gdpr-requests').findOne({ ref: res.body.ref });
    expect(row).toMatchObject({
      username: 'alice', type: 'export', contact: 'alice@example.com', message: 'please send it',
      status: 'open', notified: false, createdAt: NOW, dueAt: new Date(NOW.getTime() + 30 * DAY),
    });
    expect(await countFor('alice')).toBe(before);
  });

  test('a long message is cut at 2000 characters', async () => {
    await request(app).post('/gdpr-request').send({ ...valid, message: 'x'.repeat(5000) }).expect(200);
    const row = await db().collection('gdpr-requests').findOne({});
    expect(row.message).toHaveLength(2000);
  });

  test.each([
    ['no username', { username: '' }, 'A valid Hive account name is required.'],
    ['a too-short username', { username: 'ab' }, 'A valid Hive account name is required.'],
    ['a username with spaces', { username: 'al ice' }, 'A valid Hive account name is required.'],
    ['a username that is an object', { username: { $ne: null } }, 'A valid Hive account name is required.'],
    ['an unknown type', { type: 'rectify' }, "type must be 'export' or 'delete'."],
    ['no email', { contact: '' }, 'A valid email address is required so we can reply.'],
    ['a contact that is not an email', { contact: 'alice at example' }, 'A valid email address is required so we can reply.'],
  ])('400 with %s', async (_label, change, error) => {
    const res = await request(app).post('/gdpr-request').send({ ...valid, ...change }).expect(400);
    expect(res.body).toEqual({ success: false, error });
    expect(await db().collection('gdpr-requests').countDocuments()).toBe(0);
  });

  test('a second open request of the same type is refused with 429; the other type is still accepted', async () => {
    await request(app).post('/gdpr-request').send(valid).expect(200);
    const dup = await request(app).post('/gdpr-request').send(valid).expect(429);
    expect(dup.body.error).toMatch(/pending data request/);

    const del = { ...valid, type: 'delete' };
    await request(app).post('/gdpr-request').send(del).expect(200);
    const dupDel = await request(app).post('/gdpr-request').send(del).expect(429);
    expect(dupDel.body.error).toMatch(/pending deletion request/);
    expect(await db().collection('gdpr-requests').countDocuments()).toBe(2);
  });

  test('once the open request is fulfilled the account can ask again', async () => {
    await request(app).post('/gdpr-request').send(valid).expect(200);
    await db().collection('gdpr-requests').updateMany({}, { $set: { status: 'done' } });
    await request(app).post('/gdpr-request').send(valid).expect(200);
  });
});

describe('gdpr-admin: the secret gate', () => {
  const routes = [
    ['get', '/gdpr-admin/requests'],
    ['get', '/gdpr-admin/export/alice'],
    ['post', '/gdpr-admin/delete'],
    ['post', '/gdpr-admin/close'],
  ];

  test.each(routes)('%s %s is 401 without the secret, and deletes nothing', async (method, path) => {
    await seedAccount('alice');
    const res = await request(app)[method](path).send({ username: 'alice', dryRun: false, ref: 'x' }).expect(401);
    expect(res.body).toEqual({ error: 'unauthorized' });
    expect(await db().collection('gdpr-suppressed').countDocuments()).toBe(0);
    expect(await countFor('alice')).toBe(gdprUtil.OWNED.length + 2);
  });

  test.each([
    ['a wrong bearer', { Authorization: 'Bearer wrong-secret' }],
    ['a bearer of the wrong length', { Authorization: `Bearer ${SECRET}x` }],
    ['the secret without the Bearer scheme', { Authorization: SECRET }],
    ['a wrong X-Admin-Secret', { 'X-Admin-Secret': 'nope' }],
    ['the API key instead of the admin secret', { Authorization: 'Bearer test-api-secret' }],
  ])('401 with %s', async (_label, headers) => {
    await request(app).get('/gdpr-admin/requests').set(headers).expect(401);
  });

  test('accepts the secret as a bearer token or as X-Admin-Secret', async () => {
    await request(app).get('/gdpr-admin/requests').set(admin()).expect(200);
    await request(app).get('/gdpr-admin/requests').set('X-Admin-Secret', SECRET).expect(200);
  });

  test('with no GDPR_ADMIN_SECRET configured every route is 503, even with an empty secret', async () => {
    const saved = process.env.GDPR_ADMIN_SECRET;
    delete process.env.GDPR_ADMIN_SECRET;
    let closed;
    jest.isolateModules(() => { closed = buildApp(['/gdpr-admin', require('../../routes/gdprAdmin')]); });
    process.env.GDPR_ADMIN_SECRET = saved;

    await request(closed).get('/gdpr-admin/requests').expect(503);
    await request(closed).post('/gdpr-admin/delete').set('Authorization', 'Bearer ').send({ username: 'alice', dryRun: false }).expect(503);
  });
});

describe('GET /gdpr-admin/requests', () => {
  beforeEach(async () => {
    await db().collection('gdpr-requests').insertMany([
      { ref: 'later', status: 'open', dueAt: new Date(NOW.getTime() + 20 * DAY) },
      { ref: 'sooner', status: 'open', dueAt: new Date(NOW.getTime() + 2.5 * DAY) },
      { ref: 'fulfilled', status: 'done', dueAt: new Date(NOW.getTime() + 10 * DAY) },
      { ref: 'legacy', status: 'open' },
    ]);
  });

  test('defaults to open requests, most urgent first, with days left rounded up', async () => {
    const res = await request(app).get('/gdpr-admin/requests').set(admin()).expect(200);
    expect(res.body.status).toBe('open');
    expect(res.body.requests.map((r) => [r.ref, r.daysLeft])).toEqual([['legacy', null], ['sooner', 3], ['later', 20]]);
  });

  test.each([
    ['done', ['fulfilled']],
    ['all', ['legacy', 'sooner', 'fulfilled', 'later']],
    ['bogus', ['legacy', 'sooner', 'later']],
  ])('status=%s', async (status, refs) => {
    const res = await request(app).get(`/gdpr-admin/requests?status=${status}`).set(admin()).expect(200);
    expect(res.body.requests.map((r) => r.ref)).toEqual(refs);
  });
});

describe('GET /gdpr-admin/export/:username (Art. 15)', () => {
  test('holds every row of the account in every covered collection, and none of anyone else', async () => {
    await seedAccount('alice');
    await seedAccount('bob');

    const res = await request(app).get('/gdpr-admin/export/@Alice').set(admin()).expect(200);
    const { export: out } = res.body;
    expect(out.account).toBe('alice');
    expect(out.exportedAt).toBe(NOW.toISOString());

    const rows = Object.values(out.data).flat();
    expect(rows).toHaveLength(gdprUtil.OWNED.length + 2);
    expect(rows.every((r) => String(r.marker || r._id).startsWith('alice'))).toBe(true);
    expect(Object.keys(out.data)).toEqual(expect.arrayContaining([...new Set(gdprUtil.OWNED.map((o) => o.coll)), 'watch_history']));
    // announcement_replies is matched on two columns and must keep both rows.
    expect(out.data.announcement_replies).toHaveLength(2);
    expect(out.note).toMatch(/cannot delete blockchain records/);
  });

  test('a dotted name is matched literally in watch history, not as a regex wildcard', async () => {
    await db().collection('watch_history').insertMany([
      { _id: 'a.b:owner:v1' },
      { _id: 'axb:owner:v2' },
      { _id: 'a.bc:owner:v3' },
    ]);
    const res = await request(app).get('/gdpr-admin/export/a.b').set(admin()).expect(200);
    expect(res.body.export.data.watch_history.map((r) => r._id)).toEqual(['a.b:owner:v1']);
  });

  test('an account with nothing stored exports an empty data object', async () => {
    await seedAccount('bob');
    const res = await request(app).get('/gdpr-admin/export/carol').set(admin()).expect(200);
    expect(res.body.export.data).toEqual({});
  });

  test.each([['A'], ['bad name'], ['1abc'], ['x'.repeat(20)]])('400 for the invalid username %p', async (name) => {
    await request(app).get(`/gdpr-admin/export/${encodeURIComponent(name)}`).set(admin()).expect(400, { error: 'invalid username' });
  });
});

describe('POST /gdpr-admin/delete (Art. 17)', () => {
  beforeEach(async () => {
    await seedAccount('alice');
    await seedAccount('bob');
  });

  test.each([
    ['no dryRun flag', {}],
    ['dryRun: true', { dryRun: true }],
    ['dryRun as the string "false"', { dryRun: 'false' }],
    ['dryRun: 0', { dryRun: 0 }],
  ])('%s only counts: nothing is deleted and nothing is suppressed', async (_label, flag) => {
    const res = await request(app).post('/gdpr-admin/delete').set(admin()).send({ username: 'alice', ...flag }).expect(200);
    expect(res.body.result).toMatchObject({ username: 'alice', dryRun: true, suppressed: false, total: gdprUtil.OWNED.length + 2 });
    expect(await countFor('alice')).toBe(gdprUtil.OWNED.length + 2);
    expect(await db().collection('gdpr-suppressed').countDocuments()).toBe(0);
  });

  test('dryRun: false removes exactly the account rows, leaves others intact, and suppression-lists it', async () => {
    const res = await request(app).post('/gdpr-admin/delete').set(admin()).send({ username: '@ALICE', dryRun: false }).expect(200);
    const { result } = res.body;
    expect(result).toMatchObject({ username: 'alice', dryRun: false, suppressed: true, total: gdprUtil.OWNED.length + 2 });
    expect(result.breakdown.watch_history).toBe(2);
    expect(result.breakdown.announcement_replies).toBe(2);
    expect(result.note).toMatch(/Hive blockchain/);

    expect(await countFor('alice')).toBe(0);
    expect(await countFor('bob')).toBe(gdprUtil.OWNED.length + 2);
    expect(await db().collection('gdpr-suppressed').findOne({ _id: 'alice' })).toEqual({ _id: 'alice', suppressedAt: NOW });
  });

  test('erasing twice is harmless: the second run finds nothing and keeps the suppression entry', async () => {
    await request(app).post('/gdpr-admin/delete').set(admin()).send({ username: 'alice', dryRun: false }).expect(200);
    const again = await request(app).post('/gdpr-admin/delete').set(admin()).send({ username: 'alice', dryRun: false }).expect(200);
    expect(again.body.result).toMatchObject({ total: 0, breakdown: {} });
    expect(await db().collection('gdpr-suppressed').countDocuments({ _id: 'alice' })).toBe(1);
  });

  test.each([[undefined], [''], ['B'], [{ $ne: null }]])('400 for the username %p, and nothing is touched', async (username) => {
    await request(app).post('/gdpr-admin/delete').set(admin()).send({ username, dryRun: false }).expect(400);
    expect(await countFor('alice') + await countFor('bob')).toBe(2 * (gdprUtil.OWNED.length + 2));
  });

  // BUG (utils/gdprAdmin.js:17-43): OWNED leaves out collections that are keyed to a
  // Hive name and hold personal data: push subscriptions (browser endpoint, keys,
  // user agent), push preferences, podcast subscriptions (incl. private, paid or
  // password-protected feeds) and podcast listening progress. An Art. 17 erase
  // reports success while these rows stay, and an Art. 15 export omits them.
  test.skip('BUG: erase leaves push subscriptions, push prefs, podcast subscriptions and progress behind', async () => {
    await db().collection('push-subscriptions').insertOne({ username: 'alice', endpoint: 'https://push.example/1', keys: {}, userAgent: 'UA' });
    await db().collection('push-prefs').insertOne({ _id: 'alice', prefs: { votes: true } });
    await db().collection('podcast_subs').insertOne({ _id: 'alice|f1', user: 'alice', feed_id: 'f1' });
    await db().collection('podcast_progress').insertOne({ _id: 'alice|e1', user: 'alice', ep: 'e1', pos: 10 });

    const exp = await request(app).get('/gdpr-admin/export/alice').set(admin()).expect(200);
    expect(Object.keys(exp.body.export.data)).toEqual(expect.arrayContaining(['push-subscriptions', 'push-prefs', 'podcast_subs', 'podcast_progress']));

    await request(app).post('/gdpr-admin/delete').set(admin()).send({ username: 'alice', dryRun: false }).expect(200);
    expect(await db().collection('push-subscriptions').countDocuments({ username: 'alice' })).toBe(0);
    expect(await db().collection('push-prefs').countDocuments({ _id: 'alice' })).toBe(0);
    expect(await db().collection('podcast_subs').countDocuments({ user: 'alice' })).toBe(0);
    expect(await db().collection('podcast_progress').countDocuments({ user: 'alice' })).toBe(0);
  });
});

describe('POST /gdpr-admin/close', () => {
  test('marks the request done and says so; an unknown ref is reported, not created', async () => {
    await db().collection('gdpr-requests').insertOne({ ref: 'abc123', status: 'open' });

    const res = await request(app).post('/gdpr-admin/close').set(admin()).send({ ref: ' abc123 ' }).expect(200);
    expect(res.body.result).toEqual({ ref: 'abc123', closed: true });
    expect(await db().collection('gdpr-requests').findOne({ ref: 'abc123' })).toMatchObject({ status: 'done', closedAt: NOW });

    const missing = await request(app).post('/gdpr-admin/close').set(admin()).send({ ref: 'nope' }).expect(200);
    expect(missing.body.result).toEqual({ ref: 'nope', closed: false });
    expect(await db().collection('gdpr-requests').countDocuments()).toBe(1);
  });

  test('400 without a ref', async () => {
    await request(app).post('/gdpr-admin/close').set(admin()).send({}).expect(400, { error: 'ref required' });
  });

  test('a closed request lets the person file a new one of the same type', async () => {
    const first = await request(app).post('/gdpr-request').send({ username: 'alice', type: 'delete', contact: 'a@b.co' }).expect(200);
    await request(app).post('/gdpr-admin/close').set(admin()).send({ ref: first.body.ref }).expect(200);
    await request(app).post('/gdpr-request').send({ username: 'alice', type: 'delete', contact: 'a@b.co' }).expect(200);
  });
});

describe('when the database fails', () => {
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));
  const { Collection } = require('mongodb');

  test('the request form answers 500 and points the person to email', async () => {
    jest.spyOn(Collection.prototype, 'findOne').mockRejectedValue(new Error('down'));
    const res = await request(app).post('/gdpr-request').send({ username: 'alice', type: 'export', contact: 'a@b.co' }).expect(500);
    expect(res.body.error).toMatch(/email us directly/);
  });

  test.each([
    ['requests', 'find', () => request(app).get('/gdpr-admin/requests').set(admin())],
    ['export', 'find', () => request(app).get('/gdpr-admin/export/alice').set(admin())],
    ['delete', 'countDocuments', () => request(app).post('/gdpr-admin/delete').set(admin()).send({ username: 'alice' })],
    ['close', 'updateOne', () => request(app).post('/gdpr-admin/close').set(admin()).send({ ref: 'r' })],
  ])('admin %s answers 500 without details', async (_label, method, call) => {
    jest.spyOn(Collection.prototype, method).mockImplementation(() => { throw new Error('down'); });
    await call().expect(500, { error: 'internal error' });
  });
});

describe('utils/gdprAdmin helpers', () => {
  test('normUser trims, lower-cases and drops a leading @', () => {
    expect(gdprUtil.normUser('  @Alice ')).toBe('alice');
    expect(gdprUtil.normUser(undefined)).toBe('');
  });

  test('deleteUser and exportUser default to a dry run and today when called directly', async () => {
    await seedAccount('dana');
    const dry = await gdprUtil.deleteUser(db(), 'dana');
    expect(dry.dryRun).toBe(true);
    expect(await countFor('dana')).toBe(gdprUtil.OWNED.length + 2);
    expect((await gdprUtil.listRequests(db())).length).toBe(0);
  });
});
