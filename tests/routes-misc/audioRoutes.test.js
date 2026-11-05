/**
 * routes/audio.js: the Audio page lists (filters, derived listen counts, warm-up
 * cap, playlists) and the pay-per-listen sessions (/play-start, /play-beat),
 * end to end against MongoDB with a pinned clock.
 *
 * The suite environment sets LISTEN_BEAT_KEY, so the main router runs the way
 * production does, with AES-GCM beats. A second copy without the key covers the
 * plain JSON beats.
 */
const crypto = require('crypto');
const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const { NOW, pinClock } = require('./_fixtures');

jest.mock('../../utils/warmupAudio', () => {
  const actual = jest.requireActual('../../utils/warmupAudio');
  return { ...actual, warmupAudio: jest.fn() };
});
const { warmupAudio } = require('../../utils/warmupAudio');
const curation = require('../../utils/curation');
const realDb = require('../../utils/db');

const app = buildApp(['/audio', require('../../routes/audio')]);
const db = testDb.use();

const DAY = 86400000;
const ago = (ms) => new Date(NOW.getTime() - ms);

/** One embed-audio row, published, by alice, two minutes long, unless overridden. */
const track = (permlink, extra = {}) => ({
  permlink,
  owner: 'alice',
  post_permlink: `post-${permlink}`,
  title: `Track ${permlink}`,
  description: '',
  status: 'published',
  category: 'song',
  tags: [],
  duration: 120,
  createdAt: ago(DAY),
  ...extra,
});
const addTracks = (...rows) => db().collection('embed-audio').insertMany(rows);
const permlinksOf = (res) => res.body.audio.map((a) => a.permlink);

/** AES-256-GCM over the beat, as the frontend's WebCrypto call produces it. */
function encryptBeat(payload, key = process.env.LISTEN_BEAT_KEY) {
  const k = crypto.createHash('sha256').update(key).digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(payload), 'utf8'), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
}

beforeEach(() => {
  pinClock();
  curation.invalidate();
  warmupAudio.mockResolvedValue({ owners: [], allowed: [] });
});
afterEach(() => jest.useRealTimers());

// ─── pay-per-listen sessions ─────────────────────────────────────────────────

describe('POST /audio/play-start: opening a measured listen', () => {
  test.each([
    ['no permlink', {}],
    ['a blank permlink', { permlink: '   ' }],
    ['a permlink that is not a string', { permlink: 42 }],
    ['an overlong permlink', { permlink: 'a'.repeat(257) }],
  ])('%s is a 400', async (_label, body) => {
    const res = await request(app).post('/audio/play-start').send(body).expect(400);
    expect(res.body.error).toBe('Invalid permlink');
  });

  test('an unknown track is a 404', async () => {
    await request(app).post('/audio/play-start').send({ permlink: 'nope' }).expect(404);
  });

  test('a track that is not pay-per-listen tells the client not to track it, and opens nothing', async () => {
    await addTracks(track('free'));
    const res = await request(app).post('/audio/play-start').send({ permlink: 'free', username: 'bob' }).expect(200);
    expect(res.body).toEqual({ payable: false, ppl: false });
    expect(await db().collection('audio-listen-sessions').countDocuments()).toBe(0);
  });

  test('the author listening to their own track never opens a payable session', async () => {
    await addTracks(track('mine', { ppl: true }));
    const res = await request(app).post('/audio/play-start').send({ permlink: 'mine', username: 'Alice' }).expect(200);
    expect(res.body).toEqual({ payable: false, ppl: true, reason: 'self' });
    expect(await db().collection('audio-listen-sessions').countDocuments()).toBe(0);
  });

  test.each([[0], [null], ['abc']])('a pay-per-listen track with duration %p is a 422', async (duration) => {
    await addTracks(track('nodur', { ppl: true, duration }));
    await request(app).post('/audio/play-start').send({ permlink: 'nodur', username: 'bob' }).expect(422);
  });

  test('a signed-in listener gets a token-bound, payable session that expires after a few track lengths', async () => {
    await addTracks(track('paid', { ppl: true }));
    const res = await request(app).post('/audio/play-start').send({ permlink: 'paid', username: ' Bob ' }).expect(200);
    expect(res.body).toMatchObject({ beatSeconds: 10, threshold: 0.66, payable: true, encrypted: true });
    expect(res.body.sid).toMatch(/^[0-9a-f]{32}$/);
    expect(res.body.token).toMatch(/^[0-9a-f]{64}$/);

    const s = await db().collection('audio-listen-sessions').findOne({ sid: res.body.sid });
    expect(s).toMatchObject({
      permlink: 'paid', owner: 'alice', post_permlink: 'post-paid', durationMs: 120000,
      username: 'bob', paid: true, accumulatedMs: 0, credited: false,
    });
    expect(s.expiresAt.getTime()).toBe(NOW.getTime() + 120000 * 4 + 5 * 60 * 1000);
    // No IP is kept on the session (dropped 2026-07-14).
    expect(s).not.toHaveProperty('ip');
  });

  test('a malformed username is treated as anonymous: tracked, never payable', async () => {
    await addTracks(track('paid', { ppl: true }));
    const res = await request(app).post('/audio/play-start').send({ permlink: 'paid', username: 'X!' }).expect(200);
    expect(res.body.payable).toBe(false);
    const s = await db().collection('audio-listen-sessions').findOne({ sid: res.body.sid });
    expect(s).toMatchObject({ username: null, paid: false });
  });
});

describe('POST /audio/play-beat: crediting a listen (encrypted beats)', () => {
  const start = async (permlink = 'paid', username = 'bob') =>
    (await request(app).post('/audio/play-start').send({ permlink, username }).expect(200)).body;
  const beat = (payload) => request(app).post('/audio/play-beat').send({ enc: encryptBeat(payload) });
  const after = (ms) => jest.setSystemTime(Date.now() + ms);
  /** Beats every `everyMs` until `count` beats are sent; returns the last response. */
  async function play(s, count, everyMs = 10000) {
    let res;
    for (let i = 0; i < count; i += 1) {
      after(everyMs);
      res = await beat({ sid: s.sid, token: s.token }).expect(200);
    }
    return res;
  }

  beforeEach(() => addTracks(track('paid', { ppl: true }), track('other', { ppl: true, owner: 'carol' })));

  test('a plain JSON beat is refused when beats must be encrypted', async () => {
    const s = await start();
    const res = await request(app).post('/audio/play-beat').send({ sid: s.sid, token: s.token }).expect(400);
    expect(res.body.error).toBe('encryption_required');
  });

  test.each([
    ['too short to be a ciphertext', Buffer.from('abc').toString('base64')],
    ['sealed with another key', encryptBeat({ sid: 'x', token: 'y' }, 'some-other-key')],
  ])('a ciphertext %s is a 400', async (_label, enc) => {
    const res = await request(app).post('/audio/play-beat').send({ enc }).expect(400);
    expect(res.body.error).toBe('bad_ciphertext');
  });

  test('a beat without sid or token is a 400', async () => {
    await beat({ sid: 'abc' }).expect(400);
  });

  test('a beat for a session that does not exist (or expired) is a 410', async () => {
    const res = await beat({ sid: 'f'.repeat(32), token: 'a'.repeat(64) }).expect(410);
    expect(res.body.error).toBe('no_session');
  });

  test("a forged token, or another session's token, is a 403", async () => {
    const mine = await start('paid');
    const theirs = await start('other');
    await beat({ sid: mine.sid, token: 'a'.repeat(64) }).expect(403);
    await beat({ sid: mine.sid, token: 'short' }).expect(403);
    const res = await beat({ sid: mine.sid, token: theirs.token }).expect(403);
    expect(res.body.error).toBe('bad_token');
  });

  test('credit is the wall-clock gap the server measures, clamped to 16 s a beat', async () => {
    const s = await start();
    after(10000);
    expect((await beat({ sid: s.sid, token: s.token }).expect(200)).body.progress).toBeCloseTo(10 / 120);
    // A tab left paused for ten minutes earns one clamped beat, not ten minutes.
    after(10 * 60 * 1000);
    expect((await beat({ sid: s.sid, token: s.token }).expect(200)).body.progress).toBeCloseTo(26 / 120);
    // A burst of beats with no time between them earns nothing.
    expect((await beat({ sid: s.sid, token: s.token }).expect(200)).body.progress).toBeCloseTo(26 / 120);
  });

  test('66% of the track heard credits one listen exactly once, with a payable log row', async () => {
    const s = await start();
    const almost = await play(s, 7);
    expect(almost.body).toEqual({ progress: 70 / 120, credited: false, done: false });

    const done = await play(s, 1);
    expect(done.body).toEqual({ progress: 80 / 120, credited: true, done: true });

    const rows = await db().collection('audio-listen-log').find().toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      username: 'bob', permlink: 'paid', owner: 'alice', post_permlink: 'post-paid',
      listenedSeconds: 80, trackDuration: 120, payable: true, ppl: true,
      listenDate: '2026-11-01',
    });
    expect(rows[0]).not.toHaveProperty('ip');

    // Later beats on the credited session change nothing.
    const again = await play(s, 3);
    expect(again.body).toEqual({ progress: 1, credited: true, done: true });
    expect(await db().collection('audio-listen-log').countDocuments()).toBe(1);
  });

  test('an anonymous session is measured but never credited', async () => {
    const s = (await request(app).post('/audio/play-start').send({ permlink: 'paid' }).expect(200)).body;
    const res = await play(s, 13);
    expect(res.body).toEqual({ progress: 1, credited: false, done: false });
    expect(await db().collection('audio-listen-log').countDocuments()).toBe(0);
  });

  test('the same listener replaying the same track within 30 minutes is one listen', async () => {
    await play(await start(), 8);
    after(60 * 1000);
    const second = await play(await start(), 8);
    expect(second.body.credited).toBe(true);
    expect(await db().collection('audio-listen-log').countDocuments()).toBe(1);

    after(31 * 60 * 1000);
    await play(await start(), 8);
    expect(await db().collection('audio-listen-log').countDocuments()).toBe(2);
  });
});

describe('POST /audio/play-beat without LISTEN_BEAT_KEY (plain JSON beats)', () => {
  let plainApp;
  beforeAll(() => {
    const saved = process.env.LISTEN_BEAT_KEY;
    delete process.env.LISTEN_BEAT_KEY;
    jest.isolateModules(() => {
      jest.doMock('../../utils/db', () => realDb);
      plainApp = buildApp(['/audio', require('../../routes/audio')]);
    });
    process.env.LISTEN_BEAT_KEY = saved;
  });

  test('the session says beats are not encrypted, and a JSON beat is credited', async () => {
    await addTracks(track('paid', { ppl: true }));
    const s = (await request(plainApp).post('/audio/play-start').send({ permlink: 'paid', username: 'bob' }).expect(200)).body;
    expect(s.encrypted).toBe(false);
    jest.setSystemTime(Date.now() + 10000);
    const res = await request(plainApp).post('/audio/play-beat').send({ sid: s.sid, token: s.token }).expect(200);
    expect(res.body.progress).toBeCloseTo(10 / 120);
    await request(plainApp).post('/audio/play-beat').send({ sid: s.sid }).expect(400);
  });

  test('tokens are per process: a token from another server instance is refused', async () => {
    await addTracks(track('paid', { ppl: true }));
    const s = (await request(plainApp).post('/audio/play-start').send({ permlink: 'paid', username: 'bob' }).expect(200)).body;
    // Same sid and permlink, but the main router holds a different session secret.
    await request(app).post('/audio/play-beat').send({ enc: encryptBeat({ sid: s.sid, token: s.token }) }).expect(403);
  });
});

// ─── GET /audio ──────────────────────────────────────────────────────────────

describe('GET /audio: which tracks are listed', () => {
  test('only published tracks; banned and NSFW stay out unless nsfw=true', async () => {
    await addTracks(
      track('ok'),
      track('draft', { status: 'draft' }),
      track('banned', { banned: true }),
      track('nsfw', { isNsfwContent: true }),
    );
    expect(permlinksOf(await request(app).get('/audio').expect(200))).toEqual(['ok']);
    expect(permlinksOf(await request(app).get('/audio?nsfw=true').expect(200)).sort()).toEqual(['nsfw', 'ok']);
  });

  test('newest first, paged, with totals; the limit is clamped to 1..100', async () => {
    await addTracks(...[1, 2, 3, 4, 5].map((i) => track(`t${i}`, { createdAt: ago(i * 1000) })));
    const page2 = await request(app).get('/audio?page=2&limit=2').expect(200);
    expect(page2.body).toMatchObject({ page: 2, limit: 2, total: 5, totalPages: 3 });
    expect(permlinksOf(page2)).toEqual(['t3', 't4']);
    expect((await request(app).get('/audio?limit=1000').expect(200)).body.limit).toBe(100);
    expect((await request(app).get('/audio?limit=0&page=-3').expect(200)).body).toMatchObject({ limit: 20, page: 1 });
  });

  test('voice_message also catches uploads with no category', async () => {
    await addTracks(
      track('voice', { category: 'voice_message' }),
      track('nocat', { category: undefined }),
      track('nullcat', { category: null }),
      track('song'),
    );
    const res = await request(app).get('/audio?category=voice_message').expect(200);
    expect(permlinksOf(res).sort()).toEqual(['nocat', 'nullcat', 'voice']);
    expect(permlinksOf(await request(app).get('/audio?category=song').expect(200))).toEqual(['song']);
  });

  test('genre matches the genre field or a tag, ignoring case, and is matched literally', async () => {
    await addTracks(
      track('field', { genre: 'Hip-Hop' }),
      track('tagged', { tags: ['hip-hop'] }),
      track('other', { genre: 'jazz' }),
      track('dots', { genre: 'a.b' }),
    );
    expect(permlinksOf(await request(app).get('/audio?genre=hip-hop').expect(200)).sort()).toEqual(['field', 'tagged']);
    // A regex metacharacter in the genre is not a wildcard.
    expect(permlinksOf(await request(app).get('/audio?genre=a.b').expect(200))).toEqual(['dots']);
    expect(permlinksOf(await request(app).get('/audio?genre=a*').expect(200))).toEqual([]);
  });

  test('tag, owner and exact permlink filters', async () => {
    await addTracks(track('a', { tags: ['live'] }), track('b', { owner: 'bob' }), track('c'));
    expect(permlinksOf(await request(app).get('/audio?tag=live').expect(200))).toEqual(['a']);
    expect(permlinksOf(await request(app).get('/audio?owner=bob').expect(200))).toEqual(['b']);
    expect(permlinksOf(await request(app).get('/audio?permlink=c').expect(200))).toEqual(['c']);
  });

  test('from= takes days ago or an ISO date', async () => {
    await addTracks(track('new', { createdAt: ago(DAY) }), track('old', { createdAt: ago(10 * DAY) }));
    expect(permlinksOf(await request(app).get('/audio?from=3').expect(200))).toEqual(['new']);
    const iso = ago(20 * DAY).toISOString();
    expect(permlinksOf(await request(app).get(`/audio?from=${iso}`).expect(200)).sort()).toEqual(['new', 'old']);
  });

  test('min_duration and max_duration bound the length in seconds', async () => {
    await addTracks(track('short', { duration: 30 }), track('mid', { duration: 300 }), track('long', { duration: 3600 }));
    expect(permlinksOf(await request(app).get('/audio?min_duration=60&max_duration=600').expect(200))).toEqual(['mid']);
    expect(permlinksOf(await request(app).get('/audio?min_duration=1000').expect(200))).toEqual(['long']);
    expect(permlinksOf(await request(app).get('/audio?min_duration=-5').expect(200))).toHaveLength(3);
  });

  test('q searches title, description and owner, ignoring case', async () => {
    await addTracks(
      track('t', { title: 'Morning Jazz' }),
      track('d', { description: 'some jazz notes' }),
      track('o', { owner: 'jazzman' }),
      track('x', { title: 'Rock' }),
    );
    expect(permlinksOf(await request(app).get('/audio?q=JAZZ').expect(200)).sort()).toEqual(['d', 'o', 't']);
  });

  // routes/audio.js:543 passes ?q= straight into $regex. An unbalanced "(" is a
  // MongoDB regex error (500), and a crafted pattern can make the search slow.
  test.skip('BUG: q is used as a raw regex, so "(" is a 500 instead of a literal search', async () => {
    await addTracks(track('paren', { title: 'Live (acoustic)' }), track('plain'));
    const res = await request(app).get('/audio?q=(acoustic').expect(200);
    expect(permlinksOf(res)).toEqual(['paren']);
  });

  test('auto_tag keeps tracks whose subtitles-tags list holds any of the tags, as whole tags', async () => {
    await addTracks(track('news'), track('tech'), track('none'), track('partial'));
    await db().collection('subtitles-tags').insertMany([
      { permlink: 'news', tags: 'politics, news' },
      { permlink: 'tech', tags: 'tech,gadgets' },
      { permlink: 'partial', tags: 'newsletter' },
    ]);
    expect(permlinksOf(await request(app).get('/audio?auto_tag=news').expect(200))).toEqual(['news']);
    expect(permlinksOf(await request(app).get('/audio?auto_tag=News&auto_tag=tech').expect(200)).sort()).toEqual(['news', 'tech']);
    // Blank tags are ignored rather than matching nothing.
    expect(permlinksOf(await request(app).get('/audio?auto_tag=%20').expect(200))).toHaveLength(4);
  });

  test("a viewer's dismissed creators drop out of browsing, not out of an owner's own page", async () => {
    await addTracks(track('a'), track('b', { owner: 'bob' }));
    await db().collection('user-hidden-creators').insertOne({ username: 'viewer', creator: 'bob' });
    expect(permlinksOf(await request(app).get('/audio?currentuser=viewer').expect(200))).toEqual(['a']);
    expect(permlinksOf(await request(app).get('/audio?currentuser=viewer&owner=bob').expect(200))).toEqual(['b']);
  });
});

describe('GET /audio: what each track carries', () => {
  test('plays are derived from listening, never the stored counter', async () => {
    await addTracks(track('t', { plays: 9999, archivedListens: 2, duration: 300 }));
    await db().collection('listen-durations').insertMany([
      { kind: 'audio', id: 't', contentSeconds: 45, duration: 300 },    // a play
      { kind: 'audio', id: 't', contentSeconds: 10, duration: 300 },    // too short
      { kind: 'podcast', id: 't', contentSeconds: 999, duration: 300 }, // another kind
    ]);
    await db().collection('audio-listen-log').insertMany([
      { permlink: 't', ppl: false, createdAt: ago(DAY) },              // Snapie play: counts
      { permlink: 't', ppl: true, createdAt: ago(10 * DAY) },          // before sessions: counts
      { permlink: 't', ppl: true, createdAt: ago(60 * 1000) },         // already a session
    ]);
    const [a] = (await request(app).get('/audio').expect(200)).body.audio;
    expect(a.plays).toBe(1 + 2 + 2);
  });

  test('a short track is a play from half its length', async () => {
    await addTracks(track('jingle', { duration: 20 }));
    await db().collection('listen-durations').insertMany([
      { kind: 'audio', id: 'jingle', contentSeconds: 10, duration: 20 },
      { kind: 'audio', id: 'jingle', contentSeconds: 9, duration: 20 },
    ]);
    expect((await request(app).get('/audio').expect(200)).body.audio[0].plays).toBe(1);
  });

  test('subtitle languages, album art and the public album the track is on', async () => {
    await addTracks(track('t'), track('lonely'));
    await db().collection('subtitles').insertOne({ permlink: 't', subtitles: { en: 'x', de: 'y' } });
    const item = { author: 'alice', permlink: 'post-t' };
    await db().collection('playlists').insertMany([
      { name: 'Watch Later', access: 'private', thumbnail: 'https://img/private.jpg', created_at: ago(3 * DAY), items: [item] },
      { name: 'The Album', access: 'public', thumbnail: '', created_at: ago(2 * DAY), items: [item] },
    ]);
    const res = await request(app).get('/audio?include_auto_tags=true').expect(200);
    const t = res.body.audio.find((a) => a.permlink === 't');
    expect(t.subtitle_languages.sort()).toEqual(['de', 'en']);
    // The cover comes from the earliest playlist that has one; the album line only names a public one.
    expect(t.playlist_thumbnail).toBe('https://img/private.jpg');
    expect(t.playlist_name).toBe('The Album');
    expect(t.auto_tags).toBeNull();
    const lonely = res.body.audio.find((a) => a.permlink === 'lonely');
    expect(lonely.subtitle_languages).toEqual([]);
    expect(lonely).not.toHaveProperty('playlist_name');
  });

  test('include_auto_tags joins the auto tags string', async () => {
    await addTracks(track('t'));
    await db().collection('subtitles-tags').insertOne({ permlink: 't', tags: 'calm,piano' });
    const [a] = (await request(app).get('/audio?include_auto_tags=true').expect(200)).body.audio;
    expect(a.auto_tags).toBe('calm,piano');
  });
});

describe('GET /audio: sorting', () => {
  beforeEach(() => addTracks(
    track('quiet', { duration: 600, createdAt: ago(1000) }),
    track('played', { duration: 60, createdAt: ago(2000) }),
    track('hyped', { duration: 200, createdAt: ago(3000) }),
  ));

  test('popular ranks plays plus three per distinct hype, the author\'s own reshare left out', async () => {
    await db().collection('listen-durations').insertMany(
      Array.from({ length: 4 }, () => ({ kind: 'audio', id: 'played', contentSeconds: 60, duration: 60 })),
    );
    await db().collection('reshares').insertMany([
      { username: 'bob', author: 'alice', permlink: 'post-hyped' },
      { username: 'carol', author: 'Alice', permlink: 'post-hyped' },
      { username: 'alice', author: 'alice', permlink: 'post-hyped' }, // self-reshare
    ]);
    const res = await request(app).get('/audio?sort=popular').expect(200);
    expect(permlinksOf(res)).toEqual(['hyped', 'played', 'quiet']);
    expect(res.body.audio[0]).toMatchObject({ hypes: 2, plays: 0 });
    expect(res.body.audio[0]).not.toHaveProperty('_rank');
  });

  test.each([
    ['longest', ['quiet', 'hyped', 'played']],
    ['shortest', ['played', 'hyped', 'quiet']],
    ['anything-else', ['quiet', 'played', 'hyped']],
  ])('sort=%s', async (sort, order) => {
    expect(permlinksOf(await request(app).get(`/audio?sort=${sort}`).expect(200))).toEqual(order);
  });
});

describe('GET /audio: the warm-up cap', () => {
  beforeEach(async () => {
    await addTracks(track('w1', { owner: 'warmy' }), track('w2', { owner: 'warmy' }), track('hive'));
    warmupAudio.mockResolvedValue({ owners: ['warmy'], allowed: ['w1'] });
  });

  test('only the allowed warm-up track is listed, flagged so the page leaves out votes and tips', async () => {
    const res = await request(app).get('/audio').expect(200);
    expect(permlinksOf(res).sort()).toEqual(['hive', 'w1']);
    expect(res.body.audio.find((a) => a.permlink === 'w1').warmup).toBe(true);
    expect(res.body.audio.find((a) => a.permlink === 'hive')).not.toHaveProperty('warmup');
  });

  test('a lookup by permlink (a shared link) is never capped', async () => {
    expect(permlinksOf(await request(app).get('/audio?permlink=w2').expect(200))).toEqual(['w2']);
  });

  // routes/audio.js:500 and :567: express 4 parses ?permlink[$exists]=true into an
  // operator object, which both lands in the query and switches the cap off.
  test.skip('BUG: an operator object in ?permlink= lists every warm-up track (cap bypass)', async () => {
    const res = await request(app).get('/audio?permlink[$exists]=true').expect(200);
    expect(permlinksOf(res)).not.toContain('w2');
  });
});

// ─── the other lists ─────────────────────────────────────────────────────────

describe('GET /audio/grouped', () => {
  test('one group per category that has tracks, plus recent, newest first', async () => {
    await addTracks(
      track('p1', { category: 'podcast', createdAt: ago(1000) }),
      track('p2', { category: 'podcast', createdAt: ago(2000) }),
      track('v1', { category: undefined, createdAt: ago(3000) }),
      track('s1', { category: 'song', createdAt: ago(4000) }),
    );
    const { groups } = (await request(app).get('/audio/grouped?limit=1').expect(200)).body;
    expect(Object.keys(groups).sort()).toEqual(['podcast', 'recent', 'song', 'voice_message']);
    expect(groups.podcast.map((a) => a.permlink)).toEqual(['p1']);
    expect(groups.voice_message.map((a) => a.permlink)).toEqual(['v1']);
    expect(groups.recent.map((a) => a.permlink)).toEqual(['p1']);
    expect(groups).not.toHaveProperty('popular');
  });

  test('popular: only played or hyped tracks of the last 60 days, a brand-new track boosted', async () => {
    // The recency boost is computed in MongoDB against $$NOW, the database's own
    // clock, so this test runs on real time rather than the pinned one.
    jest.useRealTimers();
    const realAgo = (ms) => new Date(Date.now() - ms);
    await addTracks(
      track('fresh', { createdAt: realAgo(DAY) }),
      track('older', { createdAt: realAgo(30 * DAY) }),
      track('ancient', { createdAt: realAgo(90 * DAY) }),
      track('silent', { createdAt: realAgo(DAY) }),
    );
    const plays = (id, n) => Array.from({ length: n }, () => ({ kind: 'audio', id, contentSeconds: 120, duration: 120 }));
    await db().collection('listen-durations').insertMany([...plays('fresh', 1), ...plays('older', 3), ...plays('ancient', 50)]);
    const { groups } = (await request(app).get('/audio/grouped').expect(200)).body;
    // fresh: 1 play x (1 + 3 x 6/7) is about 3.6, which beats older: 3 plays x 1.
    expect(groups.popular.map((a) => a.permlink)).toEqual(['fresh', 'older']);
    expect(groups.popular[0]).not.toHaveProperty('_score');
  });

  test('from= and duration bounds narrow every group', async () => {
    await addTracks(
      track('new', { createdAt: ago(DAY), duration: 100 }),
      track('old', { createdAt: ago(10 * DAY), duration: 100 }),
      track('long', { createdAt: ago(DAY), duration: 5000 }),
    );
    const { groups } = (await request(app).get('/audio/grouped?from=3&max_duration=1000&min_duration=10').expect(200)).body;
    expect(groups.recent.map((a) => a.permlink)).toEqual(['new']);
  });
});

describe('GET /audio/categories, /tags, /auto-tags', () => {
  beforeEach(() => addTracks(
    track('a', { category: 'song', tags: ['rock', 'live'] }),
    track('b', { category: 'song', tags: ['rock'] }),
    track('c', { category: undefined, tags: [] }),
    track('d', { category: 'podcast', status: 'draft', tags: ['hidden'] }),
  ));

  test('categories with counts, an unset category reported as uncategorized', async () => {
    const res = await request(app).get('/audio/categories').expect(200);
    expect(res.body.categories).toEqual([{ name: 'song', count: 2 }, { name: 'uncategorized', count: 1 }]);
  });

  test('top tags of published tracks, most used first, limited', async () => {
    expect((await request(app).get('/audio/tags').expect(200)).body.tags).toEqual([
      { name: 'rock', count: 2 }, { name: 'live', count: 1 },
    ]);
    expect((await request(app).get('/audio/tags?limit=1').expect(200)).body.tags).toHaveLength(1);
  });

  test('auto tags are counted from the comma lists of published tracks only', async () => {
    await db().collection('subtitles-tags').insertMany([
      { permlink: 'a', tags: 'calm, piano' },
      { permlink: 'b', tags: 'piano' },
      { permlink: 'd', tags: 'secret' },
    ]);
    const res = await request(app).get('/audio/auto-tags').expect(200);
    expect(res.body).toEqual({ tags: [{ name: 'piano', count: 2 }, { name: 'calm', count: 1 }], total_tagged: 2 });
  });
});

describe('GET /audio/creators', () => {
  test('creators by total derived plays, with track counts and avatar', async () => {
    await addTracks(
      track('a1'), track('a2'),
      track('b1', { owner: 'bob' }),
      track('n1', { owner: 'nsfwguy', isNsfwContent: true }),
    );
    await db().collection('listen-durations').insertMany(
      Array.from({ length: 3 }, () => ({ kind: 'audio', id: 'b1', contentSeconds: 120, duration: 120 })),
    );
    const res = await request(app).get('/audio/creators').expect(200);
    expect(res.body.creators.map((c) => [c.owner, c.tracks, c.totalPlays])).toEqual([['bob', 1, 3], ['alice', 2, 0]]);
    expect(res.body.creators[0].avatar).toBe('https://images.hive.blog/u/bob/avatar/small');
  });

  test('the same filters as the list, and warm-up creators flagged', async () => {
    await addTracks(
      track('p', { category: 'podcast', genre: 'Talk', duration: 1000, createdAt: ago(DAY) }),
      track('w1', { owner: 'warmy', category: 'podcast', genre: 'talk', duration: 1000, createdAt: ago(DAY) }),
      track('old', { owner: 'carol', category: 'podcast', genre: 'talk', duration: 1000, createdAt: ago(30 * DAY) }),
      track('s', { owner: 'dave', category: 'song' }),
    );
    await db().collection('subtitles-tags').insertMany([
      { permlink: 'p', tags: 'talk' }, { permlink: 'w1', tags: 'talk' }, { permlink: 'old', tags: 'talk' },
    ]);
    warmupAudio.mockResolvedValue({ owners: ['warmy'], allowed: ['w1'] });
    const res = await request(app)
      .get('/audio/creators?category=podcast&genre=TALK&from=7&min_duration=500&max_duration=2000&auto_tag=talk')
      .expect(200);
    const byOwner = Object.fromEntries(res.body.creators.map((c) => [c.owner, c]));
    expect(Object.keys(byOwner).sort()).toEqual(['alice', 'warmy']);
    expect(byOwner.warmy.warmup).toBe(true);
    expect(byOwner.alice).not.toHaveProperty('warmup');
    const iso = await request(app).get(`/audio/creators?from=${ago(60 * DAY).toISOString()}&category=podcast`).expect(200);
    expect(iso.body.creators.map((c) => c.owner).sort()).toEqual(['alice', 'carol', 'warmy']);
  });
});

describe('GET /audio/playlists', () => {
  const item = (author, permlink, position) => ({ author, permlink, position });
  const playlist = (extra) => ({ access: 'public', owner: 'alice', name: 'P', items: [], ...extra });

  test('albums by the artist and playlists by listeners, each with a playable, ordered track list', async () => {
    await addTracks(
      track('a1', { thumbnail_url: 'https://img/a1.jpg' }),
      track('a2'),
      track('b1', { owner: 'bob' }),
    );
    await db().collection('playlists').insertMany([
      playlist({ name: 'Album', items: [item('alice', 'post-a2', 2), item('alice', 'post-a1', 1)], updated_at: ago(DAY) }),
      playlist({ name: 'Mix', owner: 'carol', items: [item('alice', 'post-a1', 0), item('bob', 'post-b1', 1)], updated_at: ago(2 * DAY) }),
      playlist({ name: 'Videos only', items: [item('alice', 'some-video', 0)] }),
      playlist({ name: 'Secret', access: 'private', items: [item('alice', 'post-a1', 0)] }),
    ]);
    const res = await request(app).get('/audio/playlists').expect(200);
    expect(res.body.by_artist.map((p) => p.name)).toEqual(['Album']);
    expect(res.body.by_listeners.map((p) => p.name)).toEqual(['Mix']);
    const album = res.body.by_artist[0];
    expect(album.tracks.map((t) => t.permlink)).toEqual(['a1', 'a2']);
    expect(album).toMatchObject({ trackCount: 2, totalItems: 2, artists: ['alice'], thumbnail: 'https://img/a1.jpg', album: null });
    expect(res.body.by_listeners[0].artists).toEqual(['alice', 'bob']);
  });

  test('cover priority: own image, then album metadata (any encoding), then track art, then the avatar', async () => {
    await addTracks(track('a1'));
    const one = [item('alice', 'post-a1', 0)];
    const meta = { album: { thumbnail: 'https://img/meta.jpg', label: 'Indie' } };
    await db().collection('playlists').insertMany([
      playlist({ name: 'own', thumbnail: 'https://img/own.jpg', items: one, updated_at: ago(1000) }),
      playlist({ name: 'json', metadata: JSON.stringify(meta), items: one, updated_at: ago(2000) }),
      playlist({ name: 'b64', metadata: Buffer.from(JSON.stringify(meta)).toString('base64'), items: one, updated_at: ago(3000) }),
      playlist({ name: 'broken', metadata: 'not json at all', items: one, updated_at: ago(4000) }),
    ]);
    const res = await request(app).get('/audio/playlists').expect(200);
    const cover = Object.fromEntries(res.body.by_artist.map((p) => [p.name, p.thumbnail]));
    expect(cover).toEqual({
      own: 'https://img/own.jpg',
      json: 'https://img/meta.jpg',
      b64: 'https://img/meta.jpg',
      broken: 'https://images.hive.blog/u/alice/avatar',
    });
    expect(res.body.by_artist.find((p) => p.name === 'json').album).toEqual(meta.album);
  });

  test('owner= narrows to one creator, a malformed owner is an empty answer', async () => {
    await addTracks(track('a1'), track('c1', { owner: 'carol' }));
    await db().collection('playlists').insertMany([
      playlist({ name: 'A', items: [item('alice', 'post-a1', 0)] }),
      playlist({ name: 'C', owner: 'carol', items: [item('carol', 'post-c1', 0)] }),
    ]);
    expect((await request(app).get('/audio/playlists?owner=Carol').expect(200)).body.by_artist.map((p) => p.name)).toEqual(['C']);
    expect((await request(app).get('/audio/playlists?owner=$bad').expect(200)).body).toEqual({ by_artist: [], by_listeners: [] });
  });

  test('category, genre and q filter the tracks; a playlist with no matching track drops out', async () => {
    await addTracks(track('a1', { category: 'song', genre: 'Jazz', title: 'Blue' }), track('a2', { category: 'podcast', title: 'Talk' }));
    await db().collection('playlists').insertMany([
      playlist({ name: 'Songs', items: [item('alice', 'post-a1', 0)] }),
      playlist({ name: 'Pods', items: [item('alice', 'post-a2', 0)] }),
    ]);
    const names = async (q) => (await request(app).get(`/audio/playlists?${q}`).expect(200)).body.by_artist.map((p) => p.name);
    expect(await names('category=song&genre=jazz')).toEqual(['Songs']);
    expect(await names('q=talk')).toEqual(['Pods']);
  });

  test("a viewer's dismissed creators are left out", async () => {
    await addTracks(track('a1'), track('c1', { owner: 'carol' }));
    await db().collection('playlists').insertMany([
      playlist({ name: 'A', items: [item('alice', 'post-a1', 0)] }),
      playlist({ name: 'C', owner: 'carol', items: [item('carol', 'post-c1', 0)] }),
    ]);
    await db().collection('user-hidden-creators').insertOne({ username: 'viewer', creator: 'carol' });
    const res = await request(app).get('/audio/playlists?currentuser=viewer').expect(200);
    expect(res.body.by_artist.map((p) => p.name)).toEqual(['A']);
  });

  test('no public playlists is an empty answer', async () => {
    expect((await request(app).get('/audio/playlists').expect(200)).body).toEqual({ by_artist: [], by_listeners: [] });
  });
});

describe('GET /audio/:permlink/subtitles', () => {
  test('found and not found', async () => {
    await db().collection('subtitles').insertOne({ permlink: 't', subtitles: { en: 'cid' } });
    const hit = await request(app).get('/audio/t/subtitles').expect(200);
    expect(hit.body).toMatchObject({ found: true, subtitles: { permlink: 't', subtitles: { en: 'cid' } } });
    expect((await request(app).get('/audio/none/subtitles').expect(200)).body).toEqual({ found: false, subtitles: null });
  });
});
