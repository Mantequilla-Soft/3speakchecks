/**
 * Daily publish limit against the real test MongoDB: GET /publish-quota/:owner
 * (routes/publishQuota.js) and its enforcement in POST /scheduled-posts/create,
 * /update and /publish (routes/scheduledPosts.js). What counts is read from
 * scheduled-posts and embed-video (utils/publishQuota.js); the posting grant from
 * a fake Hive chain; warm-up handles from a stand-in for the incubation service.
 */
jest.mock('../utils/incubationHosted', () => ({ call: jest.fn() }));

const request = require('supertest');
const testDb = require('./helpers/db');
const { buildApp, apiKeyHeader } = require('./helpers/app');
const { hiveAccount, fakeHiveChain } = require('./helpers/hive');
const { pinClock, NOW } = require('./routes-misc/_fixtures');
const { call } = require('../utils/incubationHosted');
const warmupAudio = require('../utils/warmupAudio');
const appDb = require('../utils/db');

const db = testDb.use();
const app = buildApp(
  ['/', require('../routes/publishQuota')],
  ['/scheduled-posts', require('../routes/scheduledPosts')],
);
const queue = () => db().collection('scheduled-posts');

const H = 3600 * 1000;
const DAY = 24 * H;
const iso = (ms) => new Date(NOW.getTime() + ms).toISOString();
const when = (ms) => new Date(NOW.getTime() + ms);

const badadib = hiveAccount('badadib', { postingDelegates: ['threespeak'] });
const fan = hiveAccount('fan');

const ENV = ['PUBLISH_DAILY_LIMITS_ENABLED', 'PUBLISH_LIMIT_VIDEOS_PER_DAY', 'PUBLISH_LIMIT_SHORTS_PER_DAY', 'PUBLISH_LIMIT_EXEMPT'];
beforeEach(() => {
  pinClock();
  fakeHiveChain([badadib, fan]);
  for (const k of ENV) delete process.env[k];
  warmupAudio._test.ownerCache.clear();
  call.mockReset();
  call.mockResolvedValue({ status: 404, body: { error: 'not found' } }); // a Hive account
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  jest.useRealTimers();
  for (const k of ENV) delete process.env[k];
});

/** An upload; `hive` = the Hive permlink it was published under (null = not on Hive). */
const upload = (permlink, { short = false, at = -3 * H, hive = `${permlink}-post`, owner = 'badadib', ...extra } = {}) =>
  db().collection('embed-video').insertOne({
    owner, permlink, short, status: 'published', createdAt: when(at), hive_permlink: hive,
    hive_title: hive ? `Title ${permlink}` : null, frontend_app: '3speak-tv', ...extra,
  });
/** A scheduled post of the upload `embed`. */
const schedule = (permlink, embed, { at = 30 * H, status = 'scheduled', owner = 'badadib', ...extra } = {}) =>
  queue().insertOne({
    owner, permlink, embedPermlink: embed, status, scheduledOn: status === 'draft' ? null : when(at),
    title: `Post ${permlink}`, body: 'b', tags: [], jsonMetadata: {}, attempts: 0, createdAt: NOW, updatedAt: NOW, ...extra,
  });

const quota = (query, owner = 'badadib') => request(app).get(`/publish-quota/${owner}`).query(query);
const post = (path, body) => request(app).post(`/scheduled-posts/${path}`).set(apiKeyHeader()).send(body);
const create = (extra = {}) => post('create', {
  owner: 'badadib', permlink: 'new-post', embedPermlink: 'new-video', scheduledOn: iso(10 * H), title: 'New', ...extra,
});

describe('GET /publish-quota/:owner', () => {
  test('a bad owner, kind or time is a 400', async () => {
    await quota({ kind: 'video' }, 'X').expect(400);
    await quota({ kind: 'video' }, 'a').expect(400);
    await quota({}).expect(400);
    await quota({ kind: 'audio' }).expect(400);
    await quota({ kind: 'video', at: 'tomorrow' }).expect(400);
    await quota({ kind: 'video', at: iso(400 * DAY) }).expect(400);
    await quota({ kind: 'video', at: iso(-30 * DAY) }).expect(400);
    await quota({ kind: ['video', 'short'] }).expect(400);
  });

  test('nothing published: allowed now, the next free time is now, never cached', async () => {
    const res = await quota({ kind: 'video' }).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      success: true, enabled: true, exempt: false, reason: null, kind: 'video', limit: 1, window_hours: 24,
      at: NOW.toISOString(), allowed: true, conflicts: [], next_free_at: NOW.toISOString(),
    });
  });

  test('one video a day: a video published 3h ago blocks the next 21 hours, and the 21 before it', async () => {
    await upload('vid1');
    const res = await quota({ kind: 'video' }).expect(200);
    expect(res.body.allowed).toBe(false);
    expect(res.body.conflicts).toEqual([{ permlink: 'vid1-post', title: 'Title vid1', at: iso(-3 * H), scheduled: false }]);
    expect(res.body.next_free_at).toBe(iso(21 * H));
    expect((await quota({ kind: 'video', at: iso(21 * H) })).body).toMatchObject({ allowed: true, conflicts: [], next_free_at: iso(21 * H) });
    expect((await quota({ kind: 'video', at: iso(21 * H - 1) })).body.allowed).toBe(false);
    // Shorts are counted apart
    expect((await quota({ kind: 'short' })).body).toMatchObject({ allowed: true, limit: 3, conflicts: [] });
  });

  test('a scheduled video counts at its time, both ways; exactly 24h apart is free', async () => {
    await upload('vid2', { hive: null, at: -1 * H });
    await schedule('sched2', 'vid2', { at: 30 * H });
    expect((await quota({ kind: 'video' })).body.allowed).toBe(true); // 30h away
    const near = (await quota({ kind: 'video', at: iso(10 * H) })).body;
    expect(near.allowed).toBe(false);
    expect(near.conflicts).toEqual([{ permlink: 'sched2', title: 'Post sched2', at: iso(30 * H), scheduled: true }]);
    expect(near.next_free_at).toBe(iso(54 * H));
    expect((await quota({ kind: 'video', at: iso(6 * H) })).body.allowed).toBe(true);
    expect((await quota({ kind: 'video', at: iso(54 * H) })).body.allowed).toBe(true);
  });

  test('three Shorts a day, in a sliding window', async () => {
    await upload('s1', { short: true, at: -5 * H });
    await upload('s2', { short: true, at: -4 * H });
    expect((await quota({ kind: 'short' })).body.allowed).toBe(true);
    await upload('s3', { short: true, at: -3 * H });
    const res = (await quota({ kind: 'short' })).body;
    expect(res.allowed).toBe(false);
    expect(res.conflicts.map((c) => c.permlink)).toEqual(['s1-post', 's2-post', 's3-post']);
    expect(res.next_free_at).toBe(iso(19 * H));
    expect((await quota({ kind: 'video' })).body.allowed).toBe(true);
  });

  test('never counted: VODs, deleted, not on Hive, replacements, audio, drafts, cancelled, failed, unknown kind', async () => {
    await upload('vod1', { frontend_app: '3speak-hangouts' });
    await upload('vod2', { stream_vod: true, frontend_app: 'x' });
    await upload('vod3', { originalFilename: 'stream-room-120s.mp4' });
    await upload('gone', { status: 'deleted' });
    await upload('local', { hive: null });
    await upload('swap', { replacesPermlink: 'vid0' });
    for (const [p, status] of [['d1', 'draft'], ['c1', 'cancelled'], ['f1', 'failed']]) {
      await upload(`v-${p}`, { hive: null });
      await schedule(p, `v-${p}`, { at: H, status });
    }
    await schedule('aud1', null, { at: H, audioPermlink: 'a-ep1' });
    await schedule('nokind', 'no-such-upload', { at: H });
    const res = (await quota({ kind: 'video' })).body;
    expect(res).toMatchObject({ allowed: true, conflicts: [] });
  });

  test('a VOD the upload server checked and turned down (stream_vod: false) counts', async () => {
    await upload('fake-vod', { stream_vod: false, frontend_app: '3speak-hangouts' });
    expect((await quota({ kind: 'video' })).body.allowed).toBe(false);
  });

  test('a scheduled post that went out counts once, at its scheduled time, not at the upload', async () => {
    await upload('vid3', { at: -3 * DAY, hive: 'sched3' });
    await schedule('sched3', 'vid3', { at: -2 * H, status: 'posted' });
    const res = (await quota({ kind: 'video' })).body;
    expect(res.conflicts).toEqual([{ permlink: 'sched3', title: 'Post sched3', at: iso(-2 * H), scheduled: false }]);
    expect((await quota({ kind: 'video', at: iso(-3 * DAY + H) })).body.allowed).toBe(true);
  });

  test('exclude: a post being rescheduled never conflicts with itself', async () => {
    await upload('vid4', { hive: null });
    await schedule('sched4', 'vid4', { at: 5 * H });
    expect((await quota({ kind: 'video', at: iso(6 * H) })).body.allowed).toBe(false);
    expect((await quota({ kind: 'video', at: iso(6 * H), exclude: 'sched4' })).body).toMatchObject({ allowed: true, conflicts: [] });
  });

  test('exclude also skips the upload row published under that permlink', async () => {
    await upload('vid5', { at: -2 * H, hive: 'sched5' });
    expect((await quota({ kind: 'video' })).body.allowed).toBe(false);
    expect((await quota({ kind: 'video', exclude: 'sched5' })).body.allowed).toBe(true);
  });

  test('exempt: the env list, 3Speak Pro and warm-up handles; a lapsed Pro pass is not', async () => {
    await upload('vid6');
    const open = { enabled: true, exempt: true, allowed: true, conflicts: [], next_free_at: null };
    process.env.PUBLISH_LIMIT_EXEMPT = 'someone, @Badadib';
    expect((await quota({ kind: 'video' })).body).toMatchObject({ ...open, reason: 'listed' });
    delete process.env.PUBLISH_LIMIT_EXEMPT;

    await db().collection('embed-users').insertOne({ username: 'badadib', premium: true, premium_expires_at: when(-H) });
    expect((await quota({ kind: 'video' })).body).toMatchObject({ exempt: false, allowed: false });
    await db().collection('embed-users').updateOne({ username: 'badadib' }, { $set: { premium_expires_at: when(DAY) } });
    expect((await quota({ kind: 'video' })).body).toMatchObject({ ...open, reason: 'pro' });
    await db().collection('embed-users').updateOne({ username: 'badadib' }, { $set: { premium_expires_at: null } });
    expect((await quota({ kind: 'video' })).body).toMatchObject({ ...open, reason: 'pro' });

    await upload('w1', { owner: '1warmup' });
    call.mockResolvedValue({ status: 200, body: { handle: '1warmup', hiveUsername: null } });
    expect((await quota({ kind: 'video' }, '1warmup')).body).toMatchObject({ ...open, reason: 'warmup' });
  });

  test('an incubation service that does not answer means a Hive account', async () => {
    await upload('vid7');
    call.mockRejectedValue(new Error('down'));
    expect((await quota({ kind: 'video' })).body).toMatchObject({ exempt: false, reason: null, allowed: false });
  });

  test('flag off: allowed, nothing listed', async () => {
    await upload('vid8');
    process.env.PUBLISH_DAILY_LIMITS_ENABLED = 'false';
    expect((await quota({ kind: 'video' })).body).toEqual({
      success: true, enabled: false, exempt: false, reason: null, kind: 'video', limit: 1, window_hours: 24,
      at: NOW.toISOString(), allowed: true, conflicts: [], next_free_at: null,
    });
  });

  test('limits from the env', async () => {
    await upload('vid9');
    process.env.PUBLISH_LIMIT_VIDEOS_PER_DAY = '2';
    expect((await quota({ kind: 'video' })).body).toMatchObject({ limit: 2, allowed: true });
  });

  test('a database error answers allowed (fail open)', async () => {
    await upload('vid10');
    jest.spyOn(appDb.getDb(), 'collection').mockImplementation(() => { throw new Error('mongo down'); });
    expect((await quota({ kind: 'video', at: iso(H) }).expect(200)).body).toEqual({
      success: true, enabled: true, exempt: false, reason: null, kind: 'video', limit: 1, window_hours: 24,
      at: iso(H), allowed: true, conflicts: [], next_free_at: null,
    });
  });
});

describe('enforced in the scheduled-posts routes', () => {
  const refusal = (kind, limit, conflicts, nextFree) => ({
    error: expect.stringMatching(new RegExp(`^Free accounts can publish ${limit} ${kind === 'short' ? 'Shorts?' : 'videos?'} per 24 hours\\. Schedule it for ${nextFree.replace(/[.]/g, '\\.')} or later`)),
    code: 'daily_publish_limit', kind, limit, conflicts, next_free_at: nextFree,
    upgrade_url: 'https://3speak.tv/wallet/badadib#pro',
  });

  describe('create', () => {
    test('a second video within 24h is a 429 and queues nothing; at the free time it is queued', async () => {
      await upload('vid1');
      await upload('new-video', { hive: null, at: 0 });
      const res = await create().expect(429);
      expect(res.body).toEqual(refusal('video', 1, [{ permlink: 'vid1-post', title: 'Title vid1', at: iso(-3 * H), scheduled: false }], iso(21 * H)));
      expect(await queue().countDocuments()).toBe(0);
      await create({ scheduledOn: iso(21 * H) }).expect(201);
      expect(await queue().countDocuments({ status: 'scheduled' })).toBe(1);
    });

    test('a fourth Short in a window is a 429; the third is fine', async () => {
      await upload('s1', { short: true, at: -5 * H });
      await upload('s2', { short: true, at: -4 * H });
      await upload('new-video', { short: true, hive: null, at: 0 });
      await create({ scheduledOn: iso(H) }).expect(201);
      const res = await create({ permlink: 'another', scheduledOn: iso(2 * H) }).expect(429);
      expect(res.body).toEqual(refusal('short', 3, [
        { permlink: 's1-post', title: 'Title s1', at: iso(-5 * H), scheduled: false },
        { permlink: 's2-post', title: 'Title s2', at: iso(-4 * H), scheduled: false },
        { permlink: 'new-post', title: 'New', at: iso(H), scheduled: true },
      ], iso(19 * H)));
    });

    test('re-scheduling the same permlink through create does not conflict with itself', async () => {
      await upload('new-video', { hive: null, at: 0 });
      await create({ scheduledOn: iso(10 * H) }).expect(201);
      await create({ scheduledOn: iso(12 * H) }).expect(201);
      expect((await queue().findOne()).scheduledOn).toEqual(when(12 * H));
    });

    test('drafts, audio posts and unknown uploads are never limited', async () => {
      await upload('vid1');
      await upload('new-video', { hive: null, at: 0 });
      await create({ draft: true, scheduledOn: undefined }).expect(201);
      await create({ permlink: 'audio-post', embedPermlink: null, audioPermlink: 'a-ep1' }).expect(201);
      await create({ permlink: 'mystery', embedPermlink: 'not-uploaded' }).expect(201);
    });

    test('exempt and flag-off owners pass; the posting grant still comes first', async () => {
      await upload('vid1');
      await upload('new-video', { hive: null, at: 0 });
      await db().collection('embed-users').insertOne({ username: 'badadib', premium: true });
      await create().expect(201);
      await db().collection('embed-users').deleteMany({});
      process.env.PUBLISH_DAILY_LIMITS_ENABLED = 'false';
      await create({ permlink: 'p2' }).expect(201);
      delete process.env.PUBLISH_DAILY_LIMITS_ENABLED;
      await upload('fan-vid', { owner: 'fan' });
      await upload('new-video', { owner: 'fan', hive: null, at: 0 });
      await create({ owner: 'fan' }).expect(403);
      expect(call).not.toHaveBeenCalled(); // no warm-up lookup for a Hive owner here
    });

    test('a lookup error lets it through (fail open)', async () => {
      await upload('vid1');
      await upload('new-video', { hive: null, at: 0 });
      const real = appDb.getDb();
      const original = real.collection.bind(real);
      jest.spyOn(real, 'collection').mockImplementation((name, ...rest) => {
        if (name === 'embed-video') throw new Error('mongo down');
        return original(name, ...rest);
      });
      await create().expect(201);
      expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/letting it through/), 'mongo down');
    });
  });

  describe('update', () => {
    beforeEach(async () => {
      await upload('va', { hive: null, at: 0 });
      await upload('vb', { hive: null, at: 0 });
      await schedule('pa', 'va', { at: 30 * H });
      await schedule('pb', 'vb', { at: 60 * H });
    });
    const update = (permlink, updates) => post('update', { owner: 'badadib', permlink, updates });

    test('moving a post next to another is a 429 and leaves it as it was', async () => {
      const res = await update('pb', { scheduledOn: iso(40 * H), title: 'x' }).expect(429);
      expect(res.body).toEqual(refusal('video', 1, [{ permlink: 'pa', title: 'Post pa', at: iso(30 * H), scheduled: true }], iso(54 * H)));
      expect(await queue().findOne({ permlink: 'pb' })).toMatchObject({ scheduledOn: when(60 * H), title: 'Post pb' });
    });

    test('moving a post near its own old time, or to the same time, is fine', async () => {
      await update('pa', { scheduledOn: iso(31 * H) }).expect(200);
      await update('pb', { scheduledOn: iso(60 * H) }).expect(200);
      await update('pb', { title: 'only the title' }).expect(200);
    });

    test('the time of a draft is ignored, as before', async () => {
      await upload('vd', { hive: null, at: 0 });
      await schedule('pd', 'vd', { status: 'draft' });
      await update('pd', { scheduledOn: iso(31 * H) }).expect(200);
      expect((await queue().findOne({ permlink: 'pd' })).scheduledOn).toBeNull();
    });

    test('a new embed in the same update decides the kind', async () => {
      await upload('vs', { short: true, hive: null, at: 0 });
      await update('pb', { scheduledOn: iso(40 * H), embedPermlink: 'vs' }).expect(200);
    });
  });

  describe('publish', () => {
    beforeEach(async () => {
      await upload('vid1', { at: -H });
      await upload('vd', { hive: null, at: 0 });
      await schedule('pd', 'vd', { status: 'draft' });
    });

    test('a draft published now next to a video is a 429; at the free time it is scheduled', async () => {
      const res = await post('publish', { owner: 'badadib', permlink: 'pd', scheduledOn: NOW.toISOString() }).expect(429);
      expect(res.body).toEqual(refusal('video', 1, [{ permlink: 'vid1-post', title: 'Title vid1', at: iso(-H), scheduled: false }], iso(23 * H)));
      expect((await queue().findOne({ permlink: 'pd' })).status).toBe('draft');
      await post('publish', { owner: 'badadib', permlink: 'pd', scheduledOn: iso(23 * H) }).expect(200);
      expect((await queue().findOne({ permlink: 'pd' })).status).toBe('scheduled');
    });

    test('no draft is still a 404', async () => {
      await post('publish', { owner: 'badadib', permlink: 'nope', scheduledOn: NOW.toISOString() }).expect(404);
    });
  });
});
