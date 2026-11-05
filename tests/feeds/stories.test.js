/**
 * 24h stories (routes/stories.js) against a real MongoDB, with real Hive
 * signatures against a fake chain:
 *   GET  /stories, /stories/following, /stories/streak/:user, /stories/seen
 *   POST /stories/register (mirrors the post's story flag), /stories/keep (signed)
 *
 * The router caches the active list (30s), the streaks (5 min) and the seen lists
 * (30s) in module scope. Every test therefore runs one day after the previous one,
 * which expires all three without reaching into the module.
 */
jest.mock('../../utils/hive', () => require('./_hiveMock').create());

const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const { hiveAccount, fakeHiveChain } = require('../helpers/hive');
const F = require('./_fixtures');
const hive = require('../../utils/hive');
const storiesRouter = require('../../routes/stories');

const db = testDb.use();
const app = buildApp(['/', storiesRouter]);
const get = (path, query = {}) => request(app).get(path).query(query);
const embeds = () => db().collection('embed-video');

let day = 0;
beforeEach(async () => {
  day += 1;
  F.pinClock(new Date(F.NOW.getTime() + day * F.DAY));   // 12:00 UTC, a fresh day each test
  hive.__reset();
  await F.resetFeedCaches(db());
});
afterEach(() => jest.useRealTimers());

describe('GET /stories (the row on the home page)', () => {
  test('creators with a live story, counted, newest first, with their streak', async () => {
    await embeds().insertMany([
      F.storyVideo({ owner: 'early', permlink: 'e1', story_posted_at: F.hoursAgo(5) }),
      F.storyVideo({ owner: 'late', permlink: 'l1', story_posted_at: F.hoursAgo(1) }),
      F.storyVideo({ owner: 'late', permlink: 'l2', story_posted_at: F.hoursAgo(2) }),
      F.storyVideo({ owner: 'late', permlink: 'old', story_posted_at: F.hoursAgo(26) }),   // yesterday, now expired
    ]);

    const res = await get('/stories').expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.currentUserHasStory).toBe(false);
    expect(res.body).not.toHaveProperty('currentUserStreak');
    expect(res.body.creators).toEqual([
      expect.objectContaining({ username: 'late', story_count: 2, unseen_count: 2, followed: false, streak: 2,
        latest_at: F.hoursAgo(1).toISOString(), latest_expires_at: F.hoursFromNow(23).toISOString() }),
      expect.objectContaining({ username: 'early', story_count: 1, streak: 1 }),
    ]);
  });

  test.each([
    ['unlisted', { listed_on_3speak: false }],
    ['unavailable', { unavailable: true }],
    ['unpublished', { status: 'encoding' }],
    ['NSFW-tagged', { hive_tags: ['nsfw'] }],
    ['by a moderation-hidden creator', { owner: 'hush' }],
  ])('a story that is %s is not in the row', async (_label, over) => {
    await F.hideCreator(db(), 'hush');
    await embeds().insertMany([F.storyVideo({ owner: 'okay', permlink: 'a' }), F.storyVideo({ owner: 'other', permlink: 'b', ...over })]);
    expect((await get('/stories').expect(200)).body.creators.map((c) => c.username)).toEqual(['okay']);
  });

  test('house accounts are NOT filtered: they are who may post during the trial', async () => {
    await embeds().insertOne(F.storyVideo({ owner: 'threespeak-fixer', permlink: 'team' }));
    expect((await get('/stories').expect(200)).body.creators.map((c) => c.username)).toEqual(['threespeak-fixer']);
  });

  test('for a viewer: unseen first, followed flagged, dismissed gone, own story reported but not listed', async () => {
    hive.__state.following.set('viewer', ['pal']);
    await embeds().insertMany([
      F.storyVideo({ owner: 'pal', permlink: 'p1', story_posted_at: F.hoursAgo(3) }),
      F.storyVideo({ owner: 'seenit', permlink: 's1', story_posted_at: F.hoursAgo(1) }),
      F.storyVideo({ owner: 'muted', permlink: 'm1' }),
      F.storyVideo({ owner: 'viewer', permlink: 'v1' }),
    ]);
    await db().collection('watch_history').insertOne(F.watched('viewer', 'seenit', 'snap-s1'));
    await F.dismissCreator(db(), 'viewer', 'muted');

    const res = await get('/stories', { currentuser: 'viewer' }).expect(200);

    expect(res.body).toMatchObject({ currentUserHasStory: true, currentUserStreak: 1 });
    expect(res.body.creators.map((c) => [c.username, c.unseen_count, c.followed])).toEqual([
      ['pal', 1, true],
      ['seenit', 0, false],
    ]);
  });

  test('an invalid ?currentuser= is ignored rather than trusted', async () => {
    await embeds().insertOne(F.storyVideo({ owner: 'someone', permlink: 'x' }));
    const res = await get('/stories', { currentuser: 'NOT VALID' }).expect(200);
    expect(res.body).not.toHaveProperty('currentUserStreak');
    expect(res.body.creators).toHaveLength(1);
  });

  test('a Hive failure on the following list does not break the row', async () => {
    hive.__state.failFollowing = true;
    await embeds().insertOne(F.storyVideo({ owner: 'someone', permlink: 'x' }));
    expect((await get('/stories', { currentuser: 'viewer' }).expect(200)).body.creators[0].followed).toBe(false);
  });
});

describe('GET /stories/following (the notification list)', () => {
  test('needs a valid viewer', async () => {
    await get('/stories/following').expect(400);
    await get('/stories/following', { currentuser: 'x' }).expect(400);
  });

  test('live stories of followed accounts, each with seen, never cached by intermediaries', async () => {
    hive.__state.following.set('viewer', ['pal', 'buddy']);
    await embeds().insertMany([
      F.storyVideo({ owner: 'pal', permlink: 'p1', story_posted_at: F.hoursAgo(1) }),
      F.storyVideo({ owner: 'buddy', permlink: 'b1', story_posted_at: F.hoursAgo(2), thumbnail_url: null }),
      F.storyVideo({ owner: 'stranger', permlink: 'x1' }),
    ]);
    await db().collection('watch_history').insertOne(F.watched('viewer', 'buddy', 'snap-b1'));

    const res = await get('/stories/following', { currentuser: 'viewer' }).expect(200);

    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.stories).toEqual([
      { owner: 'pal', permlink: 'p1', hive_permlink: 'snap-p1', thumbnail_url: 'https://img.example/p1.png',
        posted_at: F.hoursAgo(1).toISOString(), expires_at: F.hoursFromNow(23).toISOString(), seen: false },
      expect.objectContaining({ owner: 'buddy', thumbnail_url: null, seen: true }),
    ]);
  });

  test('the Hive permlink falls back to the embed_url, then to the asset id', async () => {
    hive.__state.following.set('viewer', ['pal']);
    await embeds().insertMany([
      { ...F.storyVideo({ owner: 'pal', permlink: 'from-url', embed_url: '@pal/the-post' }), hive_permlink: null },
      { ...F.storyVideo({ owner: 'pal', permlink: 'bare', embed_url: null }), hive_permlink: null },
    ]);
    const res = await get('/stories/following', { currentuser: 'viewer' }).expect(200);
    expect(res.body.stories.map((s) => s.hive_permlink).sort()).toEqual(['bare', 'the-post']);
  });
});

describe('GET /stories/streak/:user', () => {
  const postedDaysAgo = (owner, days, over = {}) => F.storyVideo({
    owner, permlink: `${owner}-${days}`, story_posted_at: new Date(Date.now() - days * F.DAY), ...over,
  });

  test('needs a valid account', async () => {
    await get('/stories/streak/x').expect(400);
  });

  test.each([
    ['today and the two days before', [0, 1, 2], { streak: 3, postedToday: true }],
    ['yesterday and before, nothing yet today (alive until midnight UTC)', [1, 2], { streak: 2, postedToday: false }],
    ['a gap breaks the run', [0, 2, 3], { streak: 1, postedToday: true }],
    ['last story two days ago: no streak', [2, 3], { streak: 0, postedToday: false }],
    ['no stories at all', [], { streak: 0, postedToday: false }],
  ])('%s', async (_label, days, expected) => {
    if (days.length) await embeds().insertMany(days.map((d) => postedDaysAgo('streaker', d)));
    expect((await get('/stories/streak/streaker').expect(200)).body).toEqual({ success: true, ...expected });
  });

  test('a story kept as a short still counts toward the streak', async () => {
    await embeds().insertMany([
      postedDaysAgo('keeper', 0, { story: false, story_expires_at: undefined, story_kept_at: new Date() }),
      postedDaysAgo('keeper', 1),
    ]);
    expect((await get('/stories/streak/keeper').expect(200)).body.streak).toBe(2);
  });
});

describe('GET /stories/seen (who watched my story)', () => {
  test('needs a valid author and permlink, and a story', async () => {
    await get('/stories/seen', { author: 'x', permlink: 'p' }).expect(400);
    await get('/stories/seen', { author: 'maker', permlink: 'BAD PERMLINK' }).expect(400);
    await get('/stories/seen', { author: 'maker', permlink: 'nope' }).expect(404);
  });

  test('viewers newest first, once each across both permlinks, never the author', async () => {
    await embeds().insertOne(F.storyVideo({ owner: 'maker', permlink: 'asset' }));
    await db().collection('watch_history').insertMany([
      F.watched('v1', 'maker', 'snap-asset', { last_watched_at: F.hoursAgo(3) }),
      F.watched('v2', 'maker', 'asset', { last_watched_at: F.hoursAgo(1) }),
      F.watched('v1', 'maker', 'asset', { last_watched_at: F.hoursAgo(2) }),   // v1 again, by asset id
      F.watched('maker', 'maker', 'asset', { last_watched_at: F.hoursAgo(0.5) }),
      F.watched('v3', 'maker', 'other-video'),
    ]);

    const res = await get('/stories/seen', { author: 'Maker', permlink: 'snap-asset' }).expect(200);

    expect(res.body).toEqual({
      success: true,
      count: 2,
      viewers: [
        { username: 'v2', at: F.hoursAgo(1).toISOString() },
        { username: 'v1', at: F.hoursAgo(2).toISOString() },
      ],
    });
  });

  test('is cached for 30 seconds', async () => {
    await embeds().insertOne(F.storyVideo({ owner: 'maker', permlink: 'asset' }));
    await get('/stories/seen', { author: 'maker', permlink: 'asset' }).expect(200);
    await db().collection('watch_history').insertOne(F.watched('late', 'maker', 'asset'));
    expect((await get('/stories/seen', { author: 'maker', permlink: 'asset' }).expect(200)).body.count).toBe(0);
    F.advanceClock(30 * 1000);
    expect((await get('/stories/seen', { author: 'maker', permlink: 'asset' }).expect(200)).body.count).toBe(1);
  });
});

describe('POST /stories/keep (signed by the author)', () => {
  const { keepMessage } = storiesRouter._test;
  const maker = hiveAccount('maker');
  const threespeak = hiveAccount('threespeak');
  const signedKeep = (signer, over = {}) => {
    const timestamp = Date.now();
    return { author: 'maker', permlink: 'snap-asset', timestamp, signature: signer.sign(keepMessage('maker', 'snap-asset', timestamp)), ...over };
  };
  const keep = (body) => request(app).post('/stories/keep').send(body);

  beforeEach(() => {
    fakeHiveChain([hiveAccount('maker', { postingDelegates: ['threespeak'] }), threespeak]);
  });

  test('rejects bad input before looking at signatures', async () => {
    await keep({ author: 'm', permlink: 'p' }).expect(400);
  });

  test('without a signature it says what to sign', async () => {
    const res = await keep({ author: 'maker', permlink: 'snap-asset' }).expect(401);
    expect(res.body).toEqual({ success: false, error: 'Signature required', expected_message: '3speak-stories|keep|maker|snap-asset|<ms>' });
  });

  test('a stale timestamp is refused', async () => {
    const body = signedKeep(maker);
    const stale = Date.now() - 10 * 60 * 1000;
    await keep({ ...body, timestamp: stale, signature: maker.sign(keepMessage('maker', 'snap-asset', stale)) }).expect(401);
  });

  test('a signature by somebody else is refused', async () => {
    const res = await keep(signedKeep(hiveAccount('intruder'))).expect(401);
    expect(res.body.error).toBe('Invalid signature');
  });

  test('an author unknown to Hive is a 404', async () => {
    fakeHiveChain([]);
    await keep(signedKeep(maker)).expect(404);
  });

  test('only a live story can be kept', async () => {
    await keep(signedKeep(maker)).expect(404);
    await embeds().insertOne(F.storyVideo({ owner: 'maker', permlink: 'asset', story_posted_at: F.hoursAgo(25) }));
    expect((await keep(signedKeep(maker)).expect(409)).body.error).toBe('not a live story');
  });

  test('keeping turns the story into an ordinary short, at once and for good', async () => {
    await embeds().insertOne(F.storyVideo({ owner: 'maker', permlink: 'asset' }));
    expect((await get('/stories').expect(200)).body.creators).toHaveLength(1);

    const res = await keep(signedKeep(maker)).expect(200);

    expect(res.body).toEqual({ success: true, kept: { owner: 'maker', permlink: 'asset', hive_permlink: 'snap-asset' } });
    const doc = await embeds().findOne({ permlink: 'asset' });
    expect(doc).toMatchObject({ story: false, story_kept_at: expect.any(Date), story_posted_at: expect.any(Date) });
    expect(doc).not.toHaveProperty('story_expires_at');
    expect((await get('/stories').expect(200)).body.creators).toEqual([]);   // the row cache was dropped
  });

  test('@threespeak, holding the author\'s posting authority, may sign for them', async () => {
    await embeds().insertOne(F.storyVideo({ owner: 'maker', permlink: 'asset' }));
    await keep(signedKeep(threespeak)).expect(200);
  });
});

describe('POST /stories/register (mirrors the post\'s own story flag)', () => {
  const register = (body) => request(app).post('/stories/register').send(body);
  /** The Hive post the uploader just broadcast for meno's short `clip`. */
  const post = (over = {}, metaOver = {}) => ({
    author: 'meno',
    permlink: 'my-story',
    created: '2026-11-01T10:00:00',
    body: 'Watch https://play.3speak.tv/watch?v=meno/clip',
    json_metadata: JSON.stringify({ '3speak': { story: true }, video: { info: { author: 'meno', permlink: 'clip' } }, tags: ['life', 42], ...metaOver }),
    ...over,
  });
  const answer = (p) => hive.__state.rpc.push([{ result: p }]);

  test.each([
    [{ author: 'x', permlink: 'p' }, 400],
    [{ author: 'meno', permlink: 'Bad Permlink' }, 400],
    [{ author: 'stranger', permlink: 'p' }, 403],   // the closed trial: badadib, meno, tibfox
  ])('%j -> %i', async (body, status) => {
    await register(body).expect(status);
  });

  test.each([
    ['the post is not readable yet', null, 404, 'post not found yet'],
    ['the post is somebody else\'s', post({ author: 'tibfox' }), 400, 'post author mismatch'],
    ['the post is not flagged as a story', post({}, { '3speak': {} }), 400, 'post is not marked as a story'],
    ['the post publishes another author\'s video', post({}, { video: { info: { author: 'tibfox', permlink: 'clip' } } }), 400, 'post does not publish one of your videos'],
    ['the post names no asset', post({}, { video: { info: { author: 'meno' } } }), 400, 'post does not publish one of your videos'],
  ])('refused when %s', async (_label, p, status, error) => {
    answer(p ? { ...p, json_metadata: p.json_metadata } : {});
    expect((await register({ author: 'meno', permlink: 'my-story' }).expect(status)).body.error).toBe(error);
  });

  test.each([
    ['the video is not in the index yet', null, 404],
    ['the video is not a short', { short: false }, 400],
    ['the author kept it as a short already', { story_kept_at: new Date() }, 409],
  ])('refused when %s', async (_label, docOver, status) => {
    if (docOver) await embeds().insertOne(F.shortVideo({ owner: 'meno', permlink: 'clip', ...docOver }));
    answer(post());
    await register({ author: 'meno', permlink: 'my-story' }).expect(status);
  });

  test('flags the short as a story for 24h from the post time, and it joins the row at once', async () => {
    await embeds().insertOne({ ...F.shortVideo({ owner: 'meno', permlink: 'clip', createdAt: F.hoursAgo(2) }), hive_tags: [] });
    await get('/stories').expect(200);                       // warm the row cache
    answer(post({ created: new Date(Date.now() - F.HOUR).toISOString().slice(0, 19) }));

    const res = await register({ author: 'Meno', permlink: 'my-story' }).expect(200);

    const postedAt = new Date(Date.now() - F.HOUR);
    expect(res.body.story).toEqual({ owner: 'meno', permlink: 'clip', hive_permlink: 'my-story', expires_at: new Date(postedAt.getTime() + F.DAY).toISOString() });
    const doc = await embeds().findOne({ permlink: 'clip' });
    expect(doc).toMatchObject({
      story: true, story_posted_at: postedAt, hive_author: 'meno', hive_permlink: 'my-story',
      embed_url: '@meno/my-story', hive_body: 'Watch https://play.3speak.tv/watch?v=meno/clip', hive_tags: ['life'],
    });
    expect((await get('/stories').expect(200)).body.creators.map((c) => c.username)).toEqual(['meno']);
  });

  test('re-registering is harmless and keeps an existing caption', async () => {
    await embeds().insertOne(F.shortVideo({ owner: 'meno', permlink: 'clip', hive_body: 'my caption', hive_tags: ['mine'] }));
    answer(post());
    answer(post());
    await register({ author: 'meno', permlink: 'my-story' }).expect(200);
    await register({ author: 'meno', permlink: 'my-story' }).expect(200);
    expect(await embeds().findOne({ permlink: 'clip' })).toMatchObject({ hive_body: 'my caption', hive_tags: ['mine'], story: true });
  });

  test('STORY_TTL_MS is the 24h default', () => {
    expect(storiesRouter.STORY_TTL_MS).toBe(F.DAY);
  });
});
