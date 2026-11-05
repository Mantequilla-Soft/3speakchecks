/**
 * routes/audioListen.js over HTTP: listening sessions for 3Speak audio and
 * outside podcast episodes, end to end against MongoDB. The beat arithmetic
 * itself is covered in tests/audioListen.test.js; this file is about what the
 * routes accept, refuse, store and keep anonymous.
 */
const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const { hiveAccount, fakeHiveChain } = require('../helpers/hive');
const { NOW, pinClock } = require('./_fixtures');

const { _test: L } = require('../../routes/audioListen');

const app = buildApp(['/audio/listen', require('../../routes/audioListen')]);
const db = testDb.use();

const threespeak = hiveAccount('threespeak');
const mallory = hiveAccount('mallory');
const EPISODE = `${'a'.repeat(24)}:${'B'.repeat(16)}`;

// Every test gets its own client address, so the per-address rate limits never
// carry over from one test to the next.
let ipCounter = 0;
let ip;
const post = (path, body) => request(app).post(`/audio/listen${path}`).set('X-Real-IP', ip).send(body);
const start = (body) => post('/start', body);
const beatAt = (session, secondsLater, position, extra = {}) => {
  jest.setSystemTime(Date.now() + secondsLater * 1000);
  return post('/beat', { sid: session.sid, token: session.token, position, ...extra });
};
/** A vouch from our API that `user` is signed in, signed by @threespeak. */
const vouch = (user, at = Date.now(), signer = threespeak) => ({
  listener: user, listenerTs: at, listenerSig: signer.sign(L.listenVouchMessage(user, at)),
});

beforeEach(async () => {
  ipCounter += 1;
  ip = `10.0.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
  pinClock();
  fakeHiveChain([threespeak, mallory]);
  await db().collection('embed-audio').insertMany([
    { permlink: 'song1', owner: 'alice', post_permlink: 'my-song', duration: 100, status: 'published' },
    { permlink: 'gone1', owner: 'alice', duration: 100, status: 'deleted' },
    { permlink: 'nodur', owner: 'alice', status: 'published' },
    { permlink: 'mp3only', owner: 'alice', mp3_duration: 80, status: 'published' },
  ]);
  await db().collection('podcast_episodes').insertOne({ _id: EPISODE, feed_id: 'f'.repeat(24), duration: 1800 });
});
afterEach(() => jest.useRealTimers());

describe('POST /audio/listen/start: what is accepted', () => {
  test.each([
    ['no kind', { id: 'song1' }],
    ['an unknown kind', { kind: 'video', id: 'song1' }],
    ['an audio id with spaces', { kind: 'audio', id: 'not ok' }],
    ['an audio id over 64 characters', { kind: 'audio', id: 'a'.repeat(65) }],
    ['a podcast id that is not <feed>:<hash>', { kind: 'podcast', id: 'song1' }],
    ['an id that is not a string', { kind: 'audio', id: 42 }],
  ])('%s is a 400', async (_label, body) => {
    expect((await start(body).expect(400)).body.error).toBe('Invalid kind/id');
  });

  test.each([
    ['an unknown track', { kind: 'audio', id: 'nothing' }],
    ['a deleted track', { kind: 'audio', id: 'gone1' }],
    ['an unknown episode', { kind: 'podcast', id: `${'b'.repeat(24)}:${'C'.repeat(16)}` }],
  ])('%s is a 404', async (_label, body) => {
    await start(body).expect(404);
  });

  test('with no duration from the player or the database nothing is tracked', async () => {
    const res = await start({ kind: 'audio', id: 'nodur' }).expect(200);
    expect(res.body).toEqual({ tracked: false, reason: 'no_duration' });
    expect(await db().collection('listen-sessions').countDocuments()).toBe(0);
  });
});

describe('POST /audio/listen/start: what a session holds', () => {
  test('a token-bound session and a heatmap axis, with no name and no IP stored', async () => {
    const res = await start({ kind: 'audio', id: 'song1', position: 20, source: '3Speak' }).expect(200);
    expect(res.body).toEqual({ sid: expect.stringMatching(/^[0-9a-f]{32}$/), token: expect.stringMatching(/^[0-9a-f]{64}$/), beatSeconds: 10 });
    const s = await db().collection('listen-sessions').findOne({ sid: res.body.sid });
    expect(s).toMatchObject({
      kind: 'audio', id: 'song1', owner: 'alice', feed_id: null, duration: 100, bucketCount: 100,
      source: '3speak', listener: null, incListener: null, private: false,
      startPosition: 20, lastPosition: 20, maxPosition: 20,
    });
    expect(s.expiresAt.getTime()).toBe(NOW.getTime() + 100 * 4000 + 5 * 60 * 1000);
    expect(JSON.stringify(s)).not.toContain(ip);
    const hm = await db().collection('listen-heatmaps').findOne({ kind: 'audio', id: 'song1' });
    expect(hm).toMatchObject({ duration: 100, bucketCount: 100, sessions: 1, owner: 'alice' });
    expect(hm.buckets).toEqual(new Array(100).fill(0));
  });

  test("the first session fixes the heatmap axis; a later player's duration does not move it", async () => {
    await start({ kind: 'audio', id: 'song1', duration: 98 }).expect(200);
    const second = await start({ kind: 'audio', id: 'song1', duration: 300 }).expect(200);
    const s = await db().collection('listen-sessions').findOne({ sid: second.body.sid });
    expect(s.duration).toBe(98);
    expect((await db().collection('listen-heatmaps').findOne({ id: 'song1' })).sessions).toBe(2);
  });

  test('a stored mp3 duration is used when the track has no duration field', async () => {
    const res = await start({ kind: 'audio', id: 'mp3only' }).expect(200);
    expect((await db().collection('listen-sessions').findOne({ sid: res.body.sid })).duration).toBe(80);
  });

  test('the country comes from the address, except in private mode', async () => {
    ip = '8.8.8.8';
    const open = await start({ kind: 'audio', id: 'song1' }).expect(200);
    const hidden = await start({ kind: 'audio', id: 'song1', private: 'true' }).expect(200);
    const sessions = db().collection('listen-sessions');
    expect((await sessions.findOne({ sid: open.body.sid })).country).toBe('US');
    expect(await sessions.findOne({ sid: hidden.body.sid })).toMatchObject({ country: null, private: true });
  });

  test('an outside episode is a podcast listen on its feed', async () => {
    const res = await start({ kind: 'podcast', id: EPISODE }).expect(200);
    const s = await db().collection('listen-sessions').findOne({ sid: res.body.sid });
    expect(s).toMatchObject({ kind: 'podcast', id: EPISODE, owner: null, feed_id: 'f'.repeat(24), duration: 1800 });
  });

  test("an episode that is really a 3Speak post counts as the creator's track", async () => {
    const res = await start({ kind: 'podcast', id: EPISODE, owner: 'Alice', postPermlink: 'my-song' }).expect(200);
    const s = await db().collection('listen-sessions').findOne({ sid: res.body.sid });
    expect(s).toMatchObject({ kind: 'audio', id: 'song1', owner: 'alice' });
  });

  test('a link to a post with no audio behind it stays a podcast listen', async () => {
    const res = await start({ kind: 'podcast', id: EPISODE, owner: 'bob', postPermlink: 'my-song' }).expect(200);
    expect((await db().collection('listen-sessions').findOne({ sid: res.body.sid })).kind).toBe('podcast');
  });
});

describe('who the listener is', () => {
  const listenerOf = async (body) => {
    const res = await start({ kind: 'audio', id: 'song1', ...body }).expect(200);
    return (await db().collection('listen-sessions').findOne({ sid: res.body.sid })).listener;
  };

  test('named only when @threespeak vouches for them on 3speak.tv', async () => {
    expect(await listenerOf({ source: '3speak', ...vouch('bob') })).toBe('bob');
  });

  test.each([
    ['the vouch is signed by someone else', () => ({ source: '3speak', ...vouch('bob', Date.now(), mallory) })],
    ['the vouch is over a day old', () => ({ source: '3speak', ...vouch('bob', Date.now() - 25 * 3600 * 1000) })],
    ['the vouch is for another name', () => ({ source: '3speak', ...vouch('bob'), listener: 'carol' })],
    ['the listen is in an embed', () => ({ source: 'embed', ...vouch('bob') })],
    ['the signature is garbage', () => ({ source: '3speak', listener: 'bob', listenerTs: Date.now(), listenerSig: 'zz' })],
  ])('anonymous when %s', async (_label, body) => {
    expect(await listenerOf(body())).toBeNull();
  });

  test('a warm-up handle is kept apart, and only on 3speak.tv', async () => {
    const site = await start({ kind: 'audio', id: 'song1', source: '3speak', incubationListener: 'WarmUser' }).expect(200);
    const embed = await start({ kind: 'audio', id: 'song1', source: 'embed', incubationListener: 'warmuser' }).expect(200);
    const sessions = db().collection('listen-sessions');
    expect(await sessions.findOne({ sid: site.body.sid })).toMatchObject({ incListener: 'warmuser', listener: null });
    expect((await sessions.findOne({ sid: embed.body.sid })).incListener).toBeNull();
  });
});

describe('POST /audio/listen/beat', () => {
  const open = async (body = {}) => (await start({ kind: 'audio', id: 'song1', ...body }).expect(200)).body;

  test('a beat without sid or token is a 400, an unknown session a 410, a wrong token a 403', async () => {
    await post('/beat', { sid: 'abc' }).expect(400);
    await post('/beat', { sid: 'f'.repeat(32), token: 'a'.repeat(64) }).expect(410);
    const s = await open();
    expect((await post('/beat', { sid: s.sid, token: 'a'.repeat(64) }).expect(403)).body.error).toBe('bad_token');
    expect((await post('/beat', { sid: s.sid, token: 'short' }).expect(403)).body.error).toBe('bad_token');
  });

  test("a token is bound to its item: another track's token does not fit", async () => {
    await db().collection('embed-audio').insertOne({ permlink: 'song2', owner: 'bob', duration: 100, status: 'published' });
    const mine = await open();
    const theirs = (await start({ kind: 'audio', id: 'song2' }).expect(200)).body;
    await post('/beat', { sid: mine.sid, token: theirs.token }).expect(403);
  });

  test('contiguous playback is logged anonymously and heats the heatmap', async () => {
    ip = '8.8.8.8';
    const s = await open({ source: '3speak', ...vouch('bob') });
    const res = await beatAt(s, 10, 10, { rate: 1 }).expect(200);
    expect(res.body).toEqual({ listenedSeconds: 10, contentSeconds: 10, listenedPct: 11, duration: 100, position: 10 });

    const row = await db().collection('listen-durations').findOne({ sid: s.sid });
    expect(row).toMatchObject({
      kind: 'audio', id: 'song1', owner: 'alice', source: '3speak', country: 'US', private: false,
      listenedSeconds: 10, contentSeconds: 10, listenedPct: 11, duration: 100, avgRate: 1, startPosition: 0,
    });
    // listen-durations never holds who listened or from where.
    expect(row).not.toHaveProperty('listener');
    expect(row).not.toHaveProperty('ip');
    expect(JSON.stringify(row)).not.toContain('bob');

    const hm = await db().collection('listen-heatmaps').findOne({ id: 'song1' });
    expect(hm.buckets.slice(0, 12)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0]);
  });

  test('a seek forward credits nothing and heats nothing', async () => {
    const s = await open();
    const res = await beatAt(s, 10, 90).expect(200);
    expect(res.body).toMatchObject({ listenedSeconds: 0, contentSeconds: 0, position: 90 });
    expect((await db().collection('listen-heatmaps').findOne({ id: 'song1' })).buckets.every((b) => b === 0)).toBe(true);
  });

  test('a hidden tab still counts and is noted', async () => {
    const s = await open();
    await beatAt(s, 10, 10, { hidden: 'true' }).expect(200);
    expect((await db().collection('listen-durations').findOne({ sid: s.sid })).hiddenSeconds).toBe(10);
  });

  test('two beats racing on one session are credited once', async () => {
    const s = await open();
    jest.setSystemTime(Date.now() + 10000);
    const both = await Promise.all([
      post('/beat', { sid: s.sid, token: s.token, position: 10 }),
      post('/beat', { sid: s.sid, token: s.token, position: 10 }),
    ]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect((await db().collection('listen-durations').findOne({ sid: s.sid })).listenedSeconds).toBe(10);
  });
});

describe('listener rewards and the warm-up goal, written from beats', () => {
  const listen = async (session, seconds) => {
    for (let t = 10; t <= seconds; t += 10) await beatAt(session, 10, t).expect(200);
  };
  const ledger = () => db().collection('ad_listener_listen').find().toArray();

  test('a vouched listener who agreed earns a ledger row once half the track is heard', async () => {
    await db().collection('ad_viewer_prefs').insertOne({ _id: 'bob', listenEnabled: true });
    const s = (await start({ kind: 'audio', id: 'song1', source: '3speak', ...vouch('bob') }).expect(200)).body;
    await listen(s, 40);
    expect(await ledger()).toHaveLength(0);
    await beatAt(s, 10, 50).expect(200);
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ listener: 'bob', kind: 'audio', id: 'song1', owner: 'alice', seconds: 50, listenedPct: 51, day: '2026-11-01', payoutId: null });
  });

  test.each([
    ['who did not agree to listening', { prefs: { _id: 'bob', listenEnabled: false }, user: 'bob' }],
    ['with no preferences at all', { prefs: null, user: 'bob' }],
    ['on their own track', { prefs: { _id: 'alice', listenEnabled: true }, user: 'alice' }],
  ])('nothing for a listener %s', async (_label, { prefs, user }) => {
    if (prefs) await db().collection('ad_viewer_prefs').insertOne(prefs);
    const s = (await start({ kind: 'audio', id: 'song1', source: '3speak', ...vouch(user) }).expect(200)).body;
    await listen(s, 80);
    expect(await ledger()).toHaveLength(0);
  });

  test('a private listen earns nothing and adds nothing to the warm-up goal', async () => {
    await db().collection('ad_viewer_prefs').insertOne({ _id: 'bob', listenEnabled: true });
    const s = (await start({ kind: 'audio', id: 'song1', source: '3speak', private: true, incubationListener: 'warmuser', ...vouch('bob') }).expect(200)).body;
    await listen(s, 80);
    expect(await ledger()).toHaveLength(0);
    expect(await db().collection('incubation_listen').countDocuments()).toBe(0);
  });

  test("a warm-up handle's listening builds their goal in wall-clock seconds, only ever raised", async () => {
    const s = (await start({ kind: 'audio', id: 'song1', source: '3speak', incubationListener: 'warmuser' }).expect(200)).body;
    await listen(s, 30);
    const row = await db().collection('incubation_listen').findOne({ handle: 'warmuser' });
    expect(row).toMatchObject({ kind: 'audio', id: 'song1', owner: 'alice', listenedSeconds: 30 });
    // A second, shorter session on the same track does not lower or add to it.
    const again = (await start({ kind: 'audio', id: 'song1', source: '3speak', incubationListener: 'warmuser' }).expect(200)).body;
    await listen(again, 10);
    const rows = await db().collection('incubation_listen').find({ handle: 'warmuser' }).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].listenedSeconds).toBe(30);
  });
});

describe('GET /audio/listen/heatmap', () => {
  const get = (q) => request(app).get(`/audio/listen/heatmap${q}`).set('X-Real-IP', ip);

  test.each([['?kind=audio&id=bad%20id'], ['?kind=video&id=x'], ['?kind=podcast&id=nope'], ['']])('%s is a 400', async (q) => {
    await get(q).expect(400);
  });

  test('an item nobody listened to is untracked', async () => {
    expect((await get('?kind=audio&id=song1').expect(200)).body).toEqual({ tracked: false });
  });

  test('the curve, normalized to its peak, cacheable for five minutes', async () => {
    await db().collection('listen-heatmaps').insertOne({ kind: 'audio', id: 'song1', duration: 100, bucketCount: 4, sessions: 3, buckets: [0, 2, 4, 1] });
    const res = await get('?kind=audio&id=song1').expect(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.body).toEqual({ tracked: true, duration: 100, bucketCount: 4, sessions: 3, max: 4, buckets: [0, 2, 4, 1], normalized: [0, 0.5, 1, 0.25] });
  });

  test('an all-zero curve normalizes to zeros, not NaN', async () => {
    await db().collection('listen-heatmaps').insertOne({ kind: 'podcast', id: EPISODE, duration: 10, bucketCount: 2, buckets: [0, 0] });
    const res = await get(`?kind=podcast&id=${encodeURIComponent(EPISODE)}`).expect(200);
    expect(res.body).toMatchObject({ sessions: 0, max: 0, normalized: [0, 0] });
  });
});

describe('rate limits', () => {
  test('one address can open 60 sessions a minute; the 61st is a 429', async () => {
    for (let i = 0; i < 60; i += 1) await start({ kind: 'audio', id: 'nothing' }).expect(404);
    const res = await start({ kind: 'audio', id: 'nothing' }).expect(429);
    expect(res.body).toEqual({ error: 'Too many requests' });
    // Another address is not affected.
    await request(app).post('/audio/listen/start').set('X-Real-IP', '10.200.0.1').send({ kind: 'audio', id: 'nothing' }).expect(404);
  });
});
