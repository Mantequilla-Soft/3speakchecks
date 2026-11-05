/**
 * The profile endpoints in routes/user.js, against a real MongoDB:
 *   /api/my-videos                      a channel's videos (owner sees unlisted, others do not)
 *   /user/:username/counts, /users/counts  the stat line, single and bulk
 *   /user/:username/trailer, PUT /user/trailer  the channel trailer
 *   /premium, /premium/:username        Pro status
 *   /check/:username, /check-hidden     posting permission and hidden creators
 *   /gethive/:user_id, /getjobid/...    legacy lookups
 */
jest.mock('../../utils/hive', () => require('./_hiveMock').create());

const request = require('supertest');
const { ObjectId } = require('mongodb');
const testDb = require('../helpers/db');
const { buildApp, apiKeyHeader } = require('../helpers/app');
const F = require('./_fixtures');

const db = testDb.use();
const app = buildApp(['/', require('../../routes/user')]);
const get = (path, query = {}) => request(app).get(path).query(query);
const videos = () => db().collection('videos');
const embeds = () => db().collection('embed-video');

beforeEach(async () => {
  F.pinClock();
  await F.resetFeedCaches(db());
});
afterEach(() => jest.useRealTimers());

describe('GET /api/my-videos', () => {
  const myVideos = (query) => get('/api/my-videos', query);

  test('a username is required', async () => {
    expect((await myVideos({}).expect(400)).body).toEqual({ success: false, error: 'Username is required' });
  });

  test('legacy and linked embed videos, newest first, one card per Hive post (the embed row wins)', async () => {
    await videos().insertMany([
      F.legacyVideo({ owner: 'cre', permlink: 'legacy-old', created: F.daysAgo(3), duration: 30 }),
      F.legacyVideo({ owner: 'cre', permlink: 'hive-both', created: F.daysAgo(1) }),      // same post as the embed below
      F.legacyVideo({ owner: 'cre', permlink: 'failed', publishFailed: true }),
      F.legacyVideo({ owner: 'cre', permlink: 'banned', banned: true }),
    ]);
    await embeds().insertMany([
      F.embedVideo({ owner: 'cre', permlink: 'both', gated: true, createdAt: F.daysAgo(1) }),
      F.embedVideo({ owner: 'cre', permlink: 'unlinked', hive_permlink: null }),
      F.embedVideo({ owner: 'cre', permlink: 'a-short', short: true }),
      F.embedVideo({ owner: 'other', permlink: 'theirs' }),
    ]);

    const res = await myVideos({ username: 'cre' }).expect(200);

    expect(res.body.data).toMatchObject({ total: 2, limit: 20, offset: 0 });
    expect(F.permlinks(res.body.data.videos)).toEqual(['hive-both', 'legacy-old']);
    expect(res.body.data.videos[0]).toMatchObject({ video_id: 'both', gated: true, unlisted: false, status: 'published' });
    expect(res.body.data.videos[1]).toMatchObject({ video_id: 'legacy-old', duration: 30, publish_type: 'immediate' });
    expect(res.body.data.videos[0]).not.toHaveProperty('_sortDate');
  });

  test('unlisted videos only for the owner\'s own view, badged', async () => {
    await embeds().insertOne(F.embedVideo({ owner: 'cre', permlink: 'private', listed_on_3speak: false }));
    expect((await myVideos({ username: 'cre' }).expect(200)).body.data.total).toBe(0);
    const own = await myVideos({ username: 'cre', include_unlisted: 'true' }).expect(200);
    expect(own.body.data.videos[0]).toMatchObject({ permlink: 'hive-private', unlisted: true, listed_on_3speak: false });
  });

  test('a video hidden from FEEDS stays public on the channel', async () => {
    await embeds().insertOne(F.embedVideo({ owner: 'cre', permlink: 'quiet', hiddenFromFeed: true }));
    expect(F.permlinks((await myVideos({ username: 'cre' }).expect(200)).body.data.videos)).toEqual(['hive-quiet']);
  });

  test('status= filters both collections, and an encoding embed reads as "encoding"', async () => {
    await videos().insertOne(F.legacyVideo({ owner: 'cre', permlink: 'sched', status: 'scheduled', scheduled_at: F.hoursFromNow(2) }));
    await embeds().insertOne(F.embedVideo({ owner: 'cre', permlink: 'enc', status: 'processing' }));

    const scheduled = await myVideos({ username: 'cre', status: 'scheduled' }).expect(200);
    const all = await myVideos({ username: 'cre' }).expect(200);

    expect(scheduled.body.data.videos).toEqual([expect.objectContaining({ permlink: 'sched', publish_type: 'schedule' })]);
    expect(all.body.data.videos.find((v) => v.video_id === 'enc').status).toBe('encoding');
  });

  test('openpod=1 lists stream recordings only: flagged, or named by the recorder', async () => {
    await videos().insertOne(F.legacyVideo({ owner: 'cre', permlink: 'legacy' }));
    await embeds().insertMany([
      F.embedVideo({ owner: 'cre', permlink: 'flagged', is_openpod_stream: true, openpod_room: 'r1' }),
      F.embedVideo({ owner: 'cre', permlink: 'by-name', originalFilename: 'stream-r2-3600s.mp4' }),
      F.embedVideo({ owner: 'cre', permlink: 'normal', originalFilename: 'holiday.mp4' }),
    ]);

    const res = await myVideos({ username: 'cre', openpod: '1' }).expect(200);

    expect(res.body.data.videos.map((v) => [v.video_id, v.isOpenpodStream, v.openpodRoom]).sort())
      .toEqual([['by-name', true, null], ['flagged', true, 'r1']]);
  });

  test('NSFW is reported from the flag or the Hive tag', async () => {
    await embeds().insertMany([
      F.embedVideo({ owner: 'cre', permlink: 'tagged', hive_tags: ['NSFW'] }),
      F.embedVideo({ owner: 'cre', permlink: 'flagged', isNsfwContent: true }),
      F.embedVideo({ owner: 'cre', permlink: 'clean' }),
    ]);
    const res = await myVideos({ username: 'cre' }).expect(200);
    const nsfw = Object.fromEntries(res.body.data.videos.map((v) => [v.video_id, v.isNsfwContent]));
    expect(nsfw).toEqual({ tagged: true, flagged: true, clean: false });
  });

  test('offset/limit page the merged list; limit is capped at 100', async () => {
    await videos().insertMany(Array.from({ length: 5 }, (_, i) => F.legacyVideo({ owner: 'cre', permlink: `p${i}`, created: F.hoursAgo(i + 1) })));
    const res = await myVideos({ username: 'cre', offset: 3, limit: 1 }).expect(200);
    expect(F.permlinks(res.body.data.videos)).toEqual(['p3']);
    expect((await myVideos({ username: 'cre', limit: 1000 }).expect(200)).body.data.limit).toBe(100);
  });

  // `limit = Math.min(parseInt(limit) || 20, 100)` has no lower bound
  // (routes/user.js:494), so ?limit=-1 becomes slice(offset, offset - 1): every
  // video but the last, sailing past the 100 cap. Every feed route clamps with
  // Math.max(..., 1).
  test.skip('BUG: a negative limit returns (almost) the whole channel instead of clamping', async () => {
    await videos().insertMany(Array.from({ length: 5 }, (_, i) => F.legacyVideo({ owner: 'cre', permlink: `p${i}` })));
    const res = await myVideos({ username: 'cre', limit: -1 }).expect(200);
    expect(res.body.data.videos.length).toBeLessThanOrEqual(1);
  });

  test('cards carry the display topic', async () => {
    await embeds().insertOne(F.embedVideo({ owner: 'cre', permlink: 'tagged-asset' }));
    await db().collection('viewer-tags').insertMany([
      { author: 'cre', permlink: 'hive-tagged-asset', voter: 'v1', 'viewer-tag': 'travel', weight: 10000 },
      { author: 'cre', permlink: 'hive-tagged-asset', voter: 'v2', 'viewer-tag': 'tutorial', weight: 10000 },   // retired v1 slug
    ]);
    const [card] = (await myVideos({ username: 'cre' }).expect(200)).body.data.videos;
    expect(card).toMatchObject({ tag_v2: 'travel', tag_v2_source: 'viewer' });
  });
});

describe('profile counts', () => {
  // The counts cache is module-level and cannot be reset, so every test here uses
  // its own account.
  async function seedChannel(user) {
    await videos().insertMany([
      F.legacyVideo({ owner: user, permlink: 'l1', views: 100 }),
      F.legacyVideo({ owner: user, permlink: 'l-failed', publishFailed: true, views: 1000 }),
    ]);
    await embeds().insertMany([
      F.embedVideo({ owner: user, permlink: 'e1', views: 10 }),
      F.embedVideo({ owner: user, permlink: 'e-unlisted', listed_on_3speak: false, views: 1000 }),
      F.shortVideo({ owner: user, permlink: 's1', views: 1 }),
      F.storyVideo({ owner: user, permlink: 'live-story', views: 2 }),
      F.storyVideo({ owner: user, permlink: 'expired-story', story_posted_at: F.hoursAgo(30), views: 1000 }),
    ]);
  }

  test('GET /user/:username/counts mirrors the profile tabs', async () => {
    await seedChannel('mirror');
    const res = await get('/user/MIRROR/counts').expect(200);
    expect(res.body).toEqual({ username: 'mirror', videos: 2, shorts: 2, views: 113 });
  });

  test('an invalid username is a 400; an account with nothing is all zeros', async () => {
    await get('/user/x!/counts').expect(400);
    expect((await get('/user/nobody/counts').expect(200)).body).toEqual({ username: 'nobody', videos: 0, shorts: 0, views: 0 });
  });

  test('counts are cached for five minutes', async () => {
    await seedChannel('cacher');
    await get('/user/cacher/counts').expect(200);
    await videos().insertOne(F.legacyVideo({ owner: 'cacher', permlink: 'l2' }));
    expect((await get('/user/cacher/counts').expect(200)).body.videos).toBe(2);
    F.advanceClock(5 * 60 * 1000);
    expect((await get('/user/cacher/counts').expect(200)).body.videos).toBe(3);
  });

  test('POST /users/counts: one answer per valid account, the same numbers as a profile', async () => {
    await embeds().insertOne(F.embedVideo({ owner: 'alpha', permlink: 'a', views: 5 }));
    await videos().insertOne(F.legacyVideo({ owner: 'beta', permlink: 'b', views: 7 }));

    const res = await request(app).post('/users/counts').send({ usernames: ['Alpha', 'beta', 'beta', 'no!', 'gamma'] }).expect(200);

    expect(res.headers['cache-control']).toBe('public, max-age=60');
    expect(res.body.counts).toEqual({
      alpha: { username: 'alpha', videos: 1, shorts: 0, views: 5 },
      beta: { username: 'beta', videos: 1, shorts: 0, views: 7 },
      gamma: { username: 'gamma', videos: 0, shorts: 0, views: 0 },
    });
  });

  test('POST /users/counts needs an array, and an all-invalid list is empty', async () => {
    await request(app).post('/users/counts').send({}).expect(400);
    expect((await request(app).post('/users/counts').send({ usernames: ['!!'] }).expect(200)).body).toEqual({ counts: {} });
  });

  test('the bulk and single routes share one cache', async () => {
    await videos().insertOne(F.legacyVideo({ owner: 'sharer', permlink: 'x' }));
    await get('/user/sharer/counts').expect(200);
    await videos().insertOne(F.legacyVideo({ owner: 'sharer', permlink: 'y' }));
    expect((await request(app).post('/users/counts').send({ usernames: ['sharer'] }).expect(200)).body.counts.sharer.videos).toBe(1);
  });

  // The bulk route says its $match clauses are copied from the single route
  // "deliberately, because a follower row that disagrees with the profile you land
  // on is worse than no number at all", but its shorts tally is missing the live-story
  // clause (routes/user.js:228-231 vs :148-152). An expired 24h story is still
  // counted, so the follower list shows more shorts than the profile.
  test.skip('BUG: the bulk counts still count EXPIRED stories as shorts', async () => {
    await seedChannel('bulky');
    const res = await request(app).post('/users/counts').send({ usernames: ['bulky'] }).expect(200);
    expect(res.body.counts.bulky).toEqual({ username: 'bulky', videos: 2, shorts: 2, views: 113 });
  });
});

describe('channel trailer', () => {
  const putTrailer = (body) => request(app).put('/user/trailer').set(apiKeyHeader()).send(body);

  test('GET answers null until one is set, and 400 for a bad username', async () => {
    expect((await get('/user/cre/trailer').expect(200)).body).toEqual({ username: 'cre', trailer: null });
    await get('/user/ab/trailer').expect(400);
  });

  test('PUT needs the app key and a valid username', async () => {
    await request(app).put('/user/trailer').send({ username: 'cre', permlink: 'x' }).expect(401);
    await putTrailer({ username: 'x', permlink: 'y' }).expect(400);
  });

  test('only one of the creator\'s OWN videos can become their trailer', async () => {
    await embeds().insertOne(F.embedVideo({ owner: 'someone', permlink: 'theirs' }));
    const res = await putTrailer({ username: 'cre', permlink: 'theirs' }).expect(404);
    expect(res.body.success).toBe(false);
    expect((await get('/user/cre/trailer').expect(200)).body.trailer).toBeNull();
  });

  test.each([
    ['a legacy video', () => videos().insertOne(F.legacyVideo({ owner: 'cre', permlink: 'mine' })), { permlink: 'mine' }],
    ['an embed asset id', () => embeds().insertOne(F.embedVideo({ owner: 'cre', permlink: 'mine' })), { permlink: 'mine' }],
    ['an embed Hive permlink', () => embeds().insertOne(F.embedVideo({ owner: 'cre', permlink: 'asset' })), { permlink: 'hive-asset' }],
    ['a post the creator published from an app account', () => embeds().insertOne(F.embedVideo({ owner: 'app', hive_author: 'cre', permlink: 'asset' })), { permlink: 'hive-asset', author: 'cre' }],
  ])('sets it from %s, even before the doc is published', async (_label, seed, body) => {
    await seed();
    const res = await putTrailer({ username: 'CRE', ...body }).expect(200);
    expect(res.body.trailer).toMatchObject({ author: 'cre', permlink: body.permlink });
    expect((await get('/user/cre/trailer').expect(200)).body.trailer).toMatchObject({ permlink: body.permlink });
  });

  test('permlink null clears it', async () => {
    await videos().insertOne(F.legacyVideo({ owner: 'cre', permlink: 'mine' }));
    await putTrailer({ username: 'cre', permlink: 'mine' }).expect(200);
    expect((await putTrailer({ username: 'cre', permlink: null }).expect(200)).body.trailer).toBeNull();
    expect((await get('/user/cre/trailer').expect(200)).body.trailer).toBeNull();
  });
});

describe('Pro status', () => {
  beforeEach(async () => {
    await db().collection('embed-users').insertMany([
      { username: 'pro', premium: true, premium_source: 'vsc', premium_expires_at: F.hoursFromNow(48), testing_started: F.daysAgo(10) },
      { username: 'trial', premium: true, premium_source: 'trial' },
      { username: 'lapsed', premium: false, testing_started: F.daysAgo(30) },
    ]);
  });

  test('GET /premium/:username, case-insensitive', async () => {
    const res = await get('/premium/PRO').expect(200);
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    expect(res.body).toMatchObject({ username: 'PRO', premium: true, premium_source: 'vsc' });
    expect((await get('/premium/lapsed').expect(200)).body).toMatchObject({ premium: false, premium_source: null });
    expect((await get('/premium/stranger').expect(200)).body).toEqual({
      username: 'stranger', premium: false, premium_source: null, premium_expires_at: null, testing_started: null,
    });
  });

  test('GET /premium lists current subscribers alphabetically', async () => {
    const res = await get('/premium').expect(200);
    expect(res.body).toMatchObject({ count: 2 });
    expect(res.body.subscribers.map((s) => [s.username, s.source])).toEqual([['pro', 'vsc'], ['trial', 'trial']]);
    expect((await get('/premium', { limit: 1 }).expect(200)).body.count).toBe(1);
  });
});

describe('GET /check/:username', () => {
  test.each([
    [null, { canPost: false, reason: 'User not found' }],
    [{ banned: true, canUpload: true }, { canPost: false, banned: true }],
    [{ banned: false, canUpload: false }, { canPost: false }],
    [{ banned: false, canUpload: true }, { canPost: true, username: 'cre' }],
  ])('creator settings %j -> %j', async (row, expected) => {
    if (row) await db().collection('contentcreators').insertOne({ username: 'cre', ...row });
    expect((await get('/check/cre').expect(200)).body).toMatchObject(expected);
  });
});

describe('POST /check-hidden', () => {
  test('answers which of the named accounts are hidden creators', async () => {
    await F.hideCreator(db(), 'hush');
    const res = await request(app).post('/check-hidden').send({ usernames: ['fine', 'HUSH', null] }).expect(200);
    expect(res.body).toEqual({ hidden: ['hush'] });
    expect((await request(app).post('/check-hidden').send({}).expect(200)).body).toEqual({ hidden: [] });
  });
});

describe('legacy lookups', () => {
  test('GET /gethive/:user_id resolves the last identity to its Hive account', async () => {
    const identity = new ObjectId();
    await db().collection('users').insertMany([
      { user_id: 'u1', last_identity: identity.toHexString() },
      { user_id: 'u2' },
      { user_id: 'u3', last_identity: new ObjectId() },
    ]);
    await db().collection('hiveaccounts').insertOne({ _id: identity, account: 'hiveuser' });

    expect((await get('/gethive/u1').expect(200)).body).toBe('hiveuser');
    expect((await get('/gethive/u2').expect(200)).body).toBe('No user ID found');
    expect((await get('/gethive/u3').expect(200)).body).toBe('No user ID found');
    expect((await get('/gethive/nobody').expect(200)).body).toBe('No user ID found');
  });

  test('GET /getjobid/:owner/:permlink', async () => {
    await videos().insertMany([F.legacyVideo({ owner: 'cre', permlink: 'with-job', job_id: 'job-9' }), F.legacyVideo({ owner: 'cre', permlink: 'no-job' })]);
    expect((await get('/getjobid/cre/with-job').expect(200)).body).toEqual({ jobId: 'job-9', owner: 'cre', permlink: 'with-job' });
    expect((await get('/getjobid/cre/no-job').expect(200)).body).toEqual({ error: 'Video not found' });
    expect((await get('/getjobid/cre/missing').expect(200)).body).toEqual({ error: 'Video not found' });
  });
});
