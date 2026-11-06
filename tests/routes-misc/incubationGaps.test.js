/**
 * routes/incubation.js, the parts tests/incubationRoutes.test.js leaves out:
 * the remaining pass-through reads, the 50% warm-up draw and one-post-per-account
 * rule, the admin review queue, and the internal-only routes that hold private
 * advertiser contacts and warm-up channel links.
 *
 * The hosted incubation service is a local stub; Hive (utils/hive) and the
 * channel verifier (services/verifier) are mocked.
 */
const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const { startStub } = require('./_fixtures');
const { hashForHiveUsername } = require('../../utils/hash');

// The production defaults: a 50% draw, one post per account, approval required.
delete process.env.WARMUP_FEED_SHARE;
delete process.env.WARMUP_FEED_PER_ACCOUNT;
delete process.env.WARMUP_APPROVAL_REQUIRED;

jest.mock('../../utils/hive', () => ({ ...jest.requireActual('../../utils/hive'), hiveRpcBatch: jest.fn() }));
jest.mock('../../services/verifier', () => ({ verifyAndStore: jest.fn(), unlinkIfRevoked: jest.fn() }));
const { hiveRpcBatch } = require('../../utils/hive');
const verifier = require('../../services/verifier');

let svc;
let app;
let feedByType; // contentType -> items the stub's /public/feed returns
let feedStatus;

beforeAll(async () => {
  svc = await startStub((stub) => {
    stub.get('/public/profile/:h', (req, res) => res.json({ handle: req.params.h, viewer: req.query.viewer || null }));
    stub.get('/public/user/:h/posts', (req, res) => {
      if (req.params.h === 'boom') return req.socket.destroy();
      return res.json({ items: [{ permlink: 'p1' }], limit: req.query.limit || null });
    });
    stub.get('/public/feed', (req, res) => {
      if (feedStatus !== 200) return res.status(feedStatus).json({ error: 'busy' });
      return res.json({ items: feedByType[req.query.contentType || 'all'] || [] });
    });
    stub.get('/public/replies', (req, res) => res.json({ items: [{ parent: `${req.query.parentAuthor}/${req.query.parentPermlink}` }] }));
    stub.post('/public/replies/for', (req, res) => res.json({ items: { count: req.body.permlinks.length } }));
    stub.get('/public/likes', (req, res) => res.json({ count: 2, liked: req.query.viewer === 'bob' }));
    stub.get('/public/post/:h/:p', (req, res) => (req.params.p === 'missing'
      ? res.status(404).json({ error: 'No such post' })
      : res.json({ handle: req.params.h, permlink: req.params.p })));
  });
  process.env.INCUBATION_HOSTED_URL = svc.url;
  app = buildApp(['/incubation', require('../../routes/incubation')]);
});
afterAll(() => svc.close());

const db = testDb.use();

const recent = (minutesAgo) => new Date(Date.now() - minutesAgo * 60000).toISOString();
const post = (handle, permlink, extra = {}) => ({
  handle, permlink, title: `T ${permlink}`, created: recent(10), contentType: 'video',
  author: { handle, status: 'incubating' }, ...extra,
});

beforeEach(() => {
  feedByType = {};
  feedStatus = 200;
  svc.seen.length = 0;
  hiveRpcBatch.mockReset();
  hiveRpcBatch.mockResolvedValue([{ result: [] }]);
  verifier.verifyAndStore.mockReset();
  verifier.unlinkIfRevoked.mockReset();
});

describe('reads passed through to the hosted service', () => {
  test('profile and posts keep the viewer and limit, lowercase the handle', async () => {
    const profile = await request(app).get('/incubation/profile/Alice?viewer=bob').expect(200);
    expect(profile.body).toEqual({ handle: 'alice', viewer: 'bob' });
    const posts = await request(app).get('/incubation/user/ALICE/posts?limit=5').expect(200);
    expect(posts.body.limit).toBe('5');
    expect(svc.seen.map((s) => s.url)).toEqual(['/public/profile/alice?viewer=bob', '/public/user/alice/posts?limit=5']);
  });

  test('replies needs both parent fields; replies/for needs an array', async () => {
    await request(app).get('/incubation/replies?parentAuthor=alice').expect(400);
    const res = await request(app).get('/incubation/replies?parentAuthor=alice&parentPermlink=p1&limit=3').expect(200);
    expect(res.body.items[0].parent).toBe('alice/p1');
    await request(app).post('/incubation/replies/for').send({ permlinks: 'p1' }).expect(400);
    const many = await request(app).post('/incubation/replies/for').send({ permlinks: ['a', 'b'] }).expect(200);
    expect(many.body.items.count).toBe(2);
  });

  test('likes for one post needs author and permlink', async () => {
    await request(app).get('/incubation/likes?author=alice').expect(400);
    expect((await request(app).get('/incubation/likes?author=alice&permlink=p1&viewer=bob').expect(200)).body).toEqual({ count: 2, liked: true });
  });

  test('one post, and the service\'s 404 passes through', async () => {
    expect((await request(app).get('/incubation/post/Alice/p1').expect(200)).body).toEqual({ handle: 'alice', permlink: 'p1' });
    await request(app).get('/incubation/post/alice/missing').expect(404);
  });

  test('authors refuses a non-array and more than 100 handles', async () => {
    await request(app).post('/incubation/authors').send({ handles: 'alice' }).expect(400);
    await request(app).post('/incubation/authors').send({ handles: Array.from({ length: 101 }, (_, i) => `h${i}`) }).expect(400);
  });

  test('a service that hangs up is a 502', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    expect((await request(app).get('/incubation/user/boom/posts').expect(502)).body).toEqual({ error: 'Incubation service unavailable' });
  });
});

describe('GET /incubation/feed: the warm-up draw (production defaults)', () => {
  const approve = (...pairs) => db().collection('embed-video').insertMany(
    pairs.map(([owner, permlink]) => ({ owner, permlink, warmup_approved: true })),
  );

  test('one post per account, then half of the accounts, newest first, never cached', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.3);
    feedByType.all = [
      post('ann', 'a1'), post('ann', 'a2'), post('ann', 'a3'),
      post('ben', 'b1'), post('cat', 'c1'), post('dan', 'd1'),
    ];
    await approve(['ann', 'a1'], ['ann', 'a2'], ['ann', 'a3'], ['ben', 'b1'], ['cat', 'c1'], ['dan', 'd1']);
    const res = await request(app).get('/incubation/feed?limit=10').expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const items = res.body.items;
    const handles = items.map((i) => i.handle);
    // Four accounts, one post each, then a 50% draw: two posts from two accounts.
    expect(items).toHaveLength(2);
    expect(new Set(handles).size).toBe(2);
    const order = feedByType.all.map((i) => i.permlink);
    const positions = items.map((i) => order.indexOf(i.permlink));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // The whole pool is asked for, not just the shown limit.
    expect(svc.seen[0].url).toMatch(/limit=50/);
  });

  test('a single warm-up post still shows (the share rounds up)', async () => {
    feedByType.all = [post('ann', 'a1')];
    await approve(['ann', 'a1']);
    expect((await request(app).get('/incubation/feed').expect(200)).body.items.map((i) => i.permlink)).toEqual(['a1']);
  });

  test('the shown limit applies after the draw', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    feedByType.all = ['ann', 'ben', 'cat', 'dan', 'eve', 'fay'].map((h) => post(h, `${h}1`));
    await approve(...feedByType.all.map((p) => [p.handle, p.permlink]));
    expect((await request(app).get('/incubation/feed?limit=1').expect(200)).body.items).toHaveLength(1);
  });

  test('a caller may narrow the age window, never widen it past the cutoff', async () => {
    await request(app).get('/incubation/feed?maxAgeDays=0.5').expect(200);
    await request(app).get('/incubation/feed?maxAgeDays=365').expect(200);
    const [narrow, wide] = svc.seen.map((s) => Number(new URL(`http://x${s.url}`).searchParams.get('maxAgeDays')));
    expect(narrow).toBe(0.5);
    expect(wide).toBeLessThanOrEqual(3);
  });

  test('items without an asset never show while approval is required', async () => {
    feedByType.all = [post('', '', { handle: '', permlink: '' })];
    expect((await request(app).get('/incubation/feed').expect(200)).body.items).toEqual([]);
  });

  test("the service's refusal passes through", async () => {
    feedStatus = 429;
    await request(app).get('/incubation/feed').expect(429);
  });

  test('Hive answering without a result list leaves the feed unfiltered', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    hiveRpcBatch.mockResolvedValue([{ error: { message: 'rate limited' } }]);
    feedByType.all = [post('ann', 'a1')];
    await approve(['ann', 'a1']);
    expect((await request(app).get('/incubation/feed').expect(200)).body.items).toHaveLength(1);
  });

  test('a database failure holds the warm-up feed back (fails closed)', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    feedByType.all = [post('ann', 'a1')];
    await approve(['ann', 'a1']);
    jest.spyOn(require('mongodb').Collection.prototype, 'find').mockImplementation(() => { throw new Error('db down'); });
    expect((await request(app).get('/incubation/feed').expect(200)).body.items).toEqual([]);
  });
});

describe('GET /incubation/review: the approval queue', () => {
  beforeEach(async () => {
    feedByType.video = [post('ann', 'pending1'), post('ann', 'old', { created: '2026-01-01T00:00:00Z' })];
    feedByType.short = [
      post('ben', 'approved1', { contentType: 'short', created: recent(5) }),
      post('ben', 'rejected1', { contentType: 'short', created: recent(20) }),
      post('ben', 'noasset', { contentType: 'short', created: recent(30) }),
    ];
    await db().collection('embed-video').insertMany([
      { owner: 'ann', permlink: 'pending1', status: 'published', hiddenFromFeed: true },
      { owner: 'ben', permlink: 'approved1', status: 'published', warmup_approved: true, warmup_reviewed_by: 'mod', warmup_reviewed_at: '2026-10-30' },
      { owner: 'ben', permlink: 'rejected1', warmup_approved: false, listed_on_3speak: false },
    ]);
    await db().collection('subtitles-tags').insertOne({ author: 'ben', permlink: 'approved1', ai_generated_v2: true });
  });

  test('pending by default: never reviewed, including posts with no asset', async () => {
    const res = await request(app).get('/incubation/review').expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.approvalRequired).toBe(true);
    expect(res.body.items.map((i) => i.permlink)).toEqual(['pending1', 'noasset']);
    const pending = res.body.items.find((i) => i.permlink === 'pending1');
    expect(pending).toMatchObject({
      state: 'pending', hiddenByCreator: true, assetStatus: 'published', aiGenerated: false,
      asset: { owner: 'ann', permlink: 'pending1' },
      watchUrl: 'https://3speak.tv/watch?v=ann/pending1',
      embedUrl: 'https://play.3speak.tv/embed?v=ann/pending1',
    });
    expect(res.body.items.find((i) => i.permlink === 'noasset')).toMatchObject({ asset: null, embedUrl: null, state: 'pending' });
  });

  test('state=all lists everything since the rail opened, newest first, with who reviewed it', async () => {
    const res = await request(app).get('/incubation/review?state=all').expect(200);
    expect(res.body.items.map((i) => i.permlink)).toEqual(['approved1', 'pending1', 'rejected1', 'noasset']);
    expect(res.body.items[0]).toMatchObject({ state: 'approved', reviewedBy: 'mod', reviewedAt: '2026-10-30', aiGenerated: true });
    expect(res.body.items[2]).toMatchObject({ state: 'rejected', hiddenByCreator: true });
  });

  test.each([['approved', ['approved1']], ['rejected', ['rejected1']]])('state=%s', async (state, permlinks) => {
    expect((await request(app).get(`/incubation/review?state=${state}`).expect(200)).body.items.map((i) => i.permlink)).toEqual(permlinks);
  });

  test('videos and shorts are read separately', async () => {
    await request(app).get('/incubation/review').expect(200);
    const types = svc.seen.map((s) => new URL(`http://x${s.url}`).searchParams.get('contentType')).sort();
    expect(types).toEqual(['short', 'video']);
  });

  test("a service refusal passes through, a database failure is a 502", async () => {
    feedStatus = 503;
    await request(app).get('/incubation/review').expect(503);
    feedStatus = 200;
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(require('mongodb').Collection.prototype, 'find').mockImplementation(() => { throw new Error('db down'); });
    await request(app).get('/incubation/review').expect(502);
  });
});

// ─── internal routes ─────────────────────────────────────────────────────────

describe('internal routes are unreachable through a proxy', () => {
  test.each([
    ['GET', '/incubation/internal/contact/user-123456'],
    ['GET', '/incubation/internal/contact-by-handle/ann'],
    ['PUT', '/incubation/internal/contact/user-123456'],
    ['GET', '/incubation/internal/social/user-123456'],
    ['POST', '/incubation/internal/social/verify'],
    ['POST', '/incubation/internal/social/unlink'],
    ['POST', '/incubation/internal/claim-assets'],
  ])('%s %s with CF-Connecting-IP is a 404', async (method, path) => {
    const res = await request(app)[method.toLowerCase()](path).set('CF-Connecting-IP', '1.2.3.4').send({});
    expect(res.status).toBe(404);
    expect(await db().collection('incubation_contacts').countDocuments()).toBe(0);
  });

  test('a remote socket address is refused even without proxy headers', () => {
    const { isInternal } = require('../../routes/incubation');
    expect(isInternal({ socket: { remoteAddress: '203.0.113.7' }, headers: {} })).toBe(false);
    expect(isInternal({ socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: {} })).toBe(true);
    expect(isInternal({ headers: {} })).toBe(false);
  });
});

describe('advertiser contacts (private, internal only)', () => {
  const USER = 'user-123456';
  const put = (body, user = USER) => request(app).put(`/incubation/internal/contact/${user}`).send(body);

  test('nothing given yet: nulls', async () => {
    expect((await request(app).get(`/incubation/internal/contact/${USER}`).expect(200)).body)
      .toEqual({ email: null, address: null, addressComplete: false, updatedAt: null });
  });

  test.each([
    ['a malformed user id', { email: 'a@b.co' }, 'bad id!'],
    ['no email', {}, USER],
    ['an invalid email', { email: 'not-an-email' }, USER],
  ])('%s is a 400', async (_label, body, user) => {
    await put(body, user).expect(400);
  });

  test('save, clean and read back; the address counts once street, city and country are there', async () => {
    const res = await put({
      handle: ' Ann ', email: ' Biz@Example.COM ',
      address: { line1: 'Main St 1\u0000\n', city: 'Berlin', country: 'DE', extra: 'dropped' },
    }).expect(200);
    expect(res.body).toEqual({
      ok: true, email: 'biz@example.com', addressComplete: true,
      address: { line1: 'Main St 1', line2: null, postalCode: null, city: 'Berlin', region: null, country: 'DE' },
    });
    const read = await request(app).get(`/incubation/internal/contact/${USER}`).expect(200);
    expect(read.body).toMatchObject({ email: 'biz@example.com', addressComplete: true });
    const byHandle = await request(app).get('/incubation/internal/contact-by-handle/ann').expect(200);
    expect(byHandle.body).toMatchObject({ found: true, userId: USER, email: 'biz@example.com', addressComplete: true });
    expect((await request(app).get('/incubation/internal/contact-by-handle/nobody').expect(200)).body).toEqual({ found: false });
  });

  test('an incomplete address is saved but not complete', async () => {
    const res = await put({ email: 'a@b.co', address: { line1: 'Main St 1' } }).expect(200);
    expect(res.body.addressComplete).toBe(false);
  });

  test('saving twice keeps one row and its first creation time', async () => {
    await put({ email: 'a@b.co' }).expect(200);
    const first = await db().collection('incubation_contacts').findOne({ userId: USER });
    await put({ email: 'c@d.co' }).expect(200);
    const rows = await db().collection('incubation_contacts').find({ userId: USER }).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: 'c@d.co', createdAt: first.createdAt });
  });

  test('a malformed user id or handle on read is a 400', async () => {
    await request(app).get('/incubation/internal/contact/x').expect(400);
    await request(app).get('/incubation/internal/contact-by-handle/-bad!').expect(400);
  });

  test('a write that fails is a 500 and never logs the body', async () => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(require('mongodb').Collection.prototype, 'updateOne').mockRejectedValue(new Error('db down'));
    await put({ email: 'secret@example.com', address: { line1: 'Home 5' } }).expect(500);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret@example|Home 5/);
  });

  test('a read that fails is a 500', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(require('mongodb').Collection.prototype, 'findOne').mockRejectedValue(new Error('db down'));
    await request(app).get(`/incubation/internal/contact/${USER}`).expect(500);
    await request(app).get('/incubation/internal/contact-by-handle/ann').expect(500);
  });
});

describe('warm-up channel links (internal only)', () => {
  const USER = 'UserABC123';
  const ID = 'warmup:userabc123';
  const links = () => db().collection('social_links');

  test('the bio code is md5 of the warm-up id, with the platforms and links', async () => {
    await links().insertOne({ hive_username: ID, platform: 'youtube', platform_username: 'annmusic', verified: true, verified_at: '2026-10-01' });
    const res = await request(app).get(`/incubation/internal/social/${USER}`).expect(200);
    expect(res.body).toEqual({
      code: hashForHiveUsername(ID),
      platforms: ['youtube', 'tiktok', 'instagram'],
      links: [{ platform: 'youtube', platform_username: 'annmusic', verified: true, verified_at: '2026-10-01', last_error: null }],
    });
    await request(app).get('/incubation/internal/social/no').expect(400);
  });

  test.each([
    ['a malformed user id', { userId: 'x', platform: 'youtube', platform_username: 'a' }],
    ['an unsupported platform', { userId: USER, platform: 'soundcloud', platform_username: 'a' }],
    ['no channel name', { userId: USER, platform: 'youtube', platform_username: '  ' }],
  ])('verify: %s is a 400', async (_label, body) => {
    await request(app).post('/incubation/internal/social/verify').send(body).expect(400);
    expect(verifier.verifyAndStore).not.toHaveBeenCalled();
  });

  test('verify stores the link under the warm-up id, past the per-platform switches', async () => {
    verifier.verifyAndStore.mockResolvedValue({ platform: 'tiktok', platform_username: 'ann', verified: true });
    const res = await request(app).post('/incubation/internal/social/verify')
      .send({ userId: USER, platform: 'TikTok', platform_username: ' ann ' }).expect(200);
    expect(res.body).toEqual({ platform: 'tiktok', platform_username: 'ann', verified: true, verified_at: null, last_error: null });
    expect(verifier.verifyAndStore).toHaveBeenCalledWith({ hive_username: ID, platform: 'tiktok', platform_username: 'ann' }, { ignoreLinkSwitch: true });
  });

  test.each([
    ['CHANNEL_NOT_FOUND', 404],
    ['CHANNEL_ALREADY_LINKED', 409],
    ['TOO_MANY_LINKS', 409],
    ['SOMETHING_ELSE', 502],
  ])('verify: %s is a %i', async (code, status) => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    verifier.verifyAndStore.mockRejectedValue(Object.assign(new Error('nope'), { code }));
    await request(app).post('/incubation/internal/social/verify').send({ userId: USER, platform: 'youtube', platform_username: 'a' }).expect(status);
  });

  test.each([
    ['deleted', 200],
    ['not_found', 404],
    ['still_present', 409],
    ['lookup_failed', 502],
  ])('unlink: %s is a %i', async (status, http) => {
    verifier.unlinkIfRevoked.mockResolvedValue({ status });
    await request(app).post('/incubation/internal/social/unlink').send({ userId: USER, platform: 'youtube', platform_username: 'a' }).expect(http);
    expect(verifier.unlinkIfRevoked).toHaveBeenCalledWith({ hive_username: ID, platform: 'youtube', platform_username: 'a' });
  });

  test('unlink: missing fields are a 400, a crash a 500', async () => {
    await request(app).post('/incubation/internal/social/unlink').send({ userId: USER }).expect(400);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    verifier.unlinkIfRevoked.mockRejectedValue(new Error('boom'));
    await request(app).post('/incubation/internal/social/unlink').send({ userId: USER, platform: 'youtube', platform_username: 'a' }).expect(500);
  });
});

describe('POST /incubation/internal/claim-assets: graduation', () => {
  const claim = (body) => request(app).post('/incubation/internal/claim-assets').send(body);

  test.each([
    [{ handle: 'ann' }],
    [{ handle: 'ann', hiveUsername: 'X' }],
    [{ handle: '-bad', hiveUsername: 'ann.hive' }],
  ])('%p is a 400', async (body) => {
    await claim(body).expect(400);
  });

  test("the advertiser's contact and warm-up links move to the new Hive account", async () => {
    await db().collection('incubation_contacts').insertMany([
      { userId: 'user-123456', handle: 'ann', email: 'a@b.co' },
      { userId: 'user-999999', handle: 'other', email: 'x@y.co' },
    ]);
    await db().collection('social_links').insertMany([
      { hive_username: 'warmup:user-123456', platform: 'youtube', platform_username: 'annmusic' },
      { hive_username: 'warmup:user-123456', platform: 'tiktok', platform_username: 'ann' },
      { hive_username: 'ann.hive', platform: 'tiktok', platform_username: 'ann' }, // already linked
    ]);
    await db().collection('embed-video').insertOne({ owner: 'ann', permlink: 'v1' });
    const res = await claim({ handle: 'ann', hiveUsername: 'ann.hive', userId: 'user-123456' }).expect(200);
    expect(res.body).toEqual({ claimed: 1, audioClaimed: 0, from: 'ann', to: 'ann.hive', linksMoved: 1 });

    const contact = await db().collection('incubation_contacts').findOne({ userId: 'user-123456' });
    expect(contact).toMatchObject({ hiveAccount: 'ann.hive', graduatedAt: expect.any(Date) });
    expect(await db().collection('incubation_contacts').findOne({ userId: 'user-999999' })).not.toHaveProperty('hiveAccount');

    const rows = await db().collection('social_links').find({}, { projection: { _id: 0, hive_username: 1, platform: 1, moved_from_warmup: 1 } }).toArray();
    expect(rows).toEqual(expect.arrayContaining([
      { hive_username: 'ann.hive', platform: 'youtube', moved_from_warmup: 'warmup:user-123456' },
      { hive_username: 'ann.hive', platform: 'tiktok' },
    ]));
    expect(rows).toHaveLength(2); // the duplicate warm-up copy is dropped
  });

  test('without a user id the contact is found by handle; the same name moves links but no uploads', async () => {
    await db().collection('incubation_contacts').insertOne({ userId: 'user-123456', handle: 'carol', email: 'a@b.co' });
    await db().collection('embed-video').insertOne({ owner: 'carol', permlink: 'v1' });
    const res = await claim({ handle: 'carol', hiveUsername: 'carol' }).expect(200);
    expect(res.body).toEqual({ claimed: 0, audioClaimed: 0, reason: 'same_name', linksMoved: 0 });
    expect((await db().collection('incubation_contacts').findOne({ handle: 'carol' })).hiveAccount).toBe('carol');
    expect((await db().collection('embed-video').findOne({ permlink: 'v1' })).owner_claimed_from).toBeUndefined();
  });

  test('moving links failing does not stop the claim', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await db().collection('embed-video').insertOne({ owner: 'dan', permlink: 'v1' });
    const find = require('mongodb').Collection.prototype.find;
    jest.spyOn(require('mongodb').Collection.prototype, 'find').mockImplementation(function (...args) {
      if (this.collectionName === 'social_links') throw new Error('links down');
      return find.apply(this, args);
    });
    const res = await claim({ handle: 'dan', hiveUsername: 'dan.hive', userId: 'user-123456' }).expect(200);
    expect(res.body).toMatchObject({ claimed: 1, linksMoved: 0 });
  });

  test('a database failure is a 500', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(require('mongodb').Collection.prototype, 'updateMany').mockRejectedValue(new Error('db down'));
    await claim({ handle: 'dan', hiveUsername: 'dan.hive' }).expect(500);
  });
});

describe('internal counters fail safely', () => {
  test.each([['watch'], ['listen'], ['audio']])('/internal/%s is a 500 when the database fails, 400 on a bad handle', async (what) => {
    await request(app).get(`/incubation/internal/${what}/-bad!`).expect(400);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(require('mongodb').Collection.prototype, 'aggregate').mockImplementation(() => { throw new Error('db down'); });
    jest.spyOn(require('mongodb').Collection.prototype, 'countDocuments').mockRejectedValue(new Error('db down'));
    await request(app).get(`/incubation/internal/${what}/ann`).expect(500);
  });
});
