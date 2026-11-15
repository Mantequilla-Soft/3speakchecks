/**
 * Sound pages: services/soundIndex.js reads each Short's Hive post and records
 * which sound it uses; routes/sounds.js lists a sound and the Shorts using it.
 * Real (throwaway) MongoDB, Hive answered by a stand-in.
 */
const request = require('supertest');
const testDb = require('./helpers/db');
const { buildApp } = require('./helpers/app');
const {
  isSoundId, parseSoundId, shortSoundId, soundIdForSound, externalSoundId,
} = require('../utils/soundIds');
const soundIndex = require('../services/soundIndex');
const router = require('../routes/sounds');
const dbModule = require('../utils/db');

const db = testDb.use();
const app = buildApp(['/sounds', router]);

const LIBRARY = soundIndex.libraryFrom({
  tracks: [
    { id: 'carefree', title: 'Carefree', artist: 'Kevin MacLeod', file: 'carefree.mp3', source: 'incompetech.com', license: 'CC BY 4.0', duration: 205 },
  ],
}, 'https://editor.example/music/library.json');

const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000);

// Hive posts by `author/permlink`; get_content answers from here.
let POSTS;
const rpc = async (batch) => batch.map((b) => {
  const [author, permlink] = b.params;
  const p = POSTS[`${author}/${permlink}`];
  return { id: b.id, result: p ? { author, permlink, created: '2026-11-10T10:00:00', pending_payout_value: '0.000 HBD', total_payout_value: '0.000 HBD', curator_payout_value: '0.000 HBD', ...p } : { author: '', permlink: '' } };
});
const post = (title, video = {}, extra = {}) => ({ title, json_metadata: JSON.stringify({ app: '3speak', video }), ...extra });

async function addShort(owner, permlink, hivePermlink, createdAt, extra = {}) {
  await db().collection('embed-video').insertOne({
    owner, permlink, short: true, status: 'published', embed_url: `@${owner}/${hivePermlink}`,
    hive_author: owner, hive_permlink: hivePermlink, createdAt, thumbnail_url: `https://img.example/${permlink}.webp`, duration: 12, ...extra,
  });
}

beforeEach(() => {
  POSTS = {};
  soundIndex._resetLibraryForTests(LIBRARY);
  router._clearCacheForTests();
});

describe('sound ids', () => {
  test('a post id splits back into its author and permlink', () => {
    const id = shortSoundId('badadib', 'audiogram-1-teaser-69676');
    expect(id).toBe('short_badadib_audiogram-1-teaser-69676');
    expect(parseSoundId(id)).toEqual({ kind: 'short', author: 'badadib', permlink: 'audiogram-1-teaser-69676' });
    expect(shortSoundId('Badadib', 'X')).toBe('short_badadib_x');
    expect(shortSoundId('ba', 'x')).toBeNull();
    expect(isSoundId('short_ba_x')).toBe(false);
    expect(isSoundId('lib-carefree')).toBe(true);
    expect(isSoundId('../etc')).toBe(false);
  });

  test('a sound is named by id, page url, library song, then by name', () => {
    expect(soundIdForSound({ title: 'X', id: 'short_badadib_abc' }, LIBRARY)).toBe('short_badadib_abc');
    expect(soundIdForSound({ title: 'Carefree', id: 'carefree', source: 'incompetech.com' }, LIBRARY)).toBe('lib-carefree');
    expect(soundIdForSound({ title: 'X', url: 'https://3speak.tv/sound/short_badadib_abc' }, LIBRARY)).toBe('short_badadib_abc');
    expect(soundIdForSound({ title: 'carefree ', artist: 'Kevin  MacLeod' }, LIBRARY)).toBe('lib-carefree');
    expect(soundIdForSound({ title: 'Other', artist: 'Someone' }, LIBRARY)).toBe(externalSoundId('other', 'someone'));
    expect(soundIdForSound(null, LIBRARY)).toBeNull();
  });
});

describe('the index', () => {
  test('every Short gets one sound: its song, the remixed post, or its own audio', async () => {
    await addShort('badadib', 'a1', 'orig-1', hoursAgo(100));
    await addShort('badadib', 'a2', 'with-song', hoursAgo(90));
    await addShort('fan', 'a3', 'uses-orig', hoursAgo(80));
    await addShort('fan', 'a4', 'remix-orig', hoursAgo(70));
    POSTS = {
      'badadib/orig-1': post('My beat'),
      'badadib/with-song': post('Song short', { sound: { title: 'Carefree', artist: 'Kevin MacLeod', source: 'incompetech.com' } }, { pending_payout_value: '1.500 HBD' }),
      'fan/uses-orig': post('Dance', { sound: { title: 'My beat', artist: '@badadib', account: 'badadib', source: '3speak', id: 'short_badadib_orig-1', url: 'https://3speak.tv/sound/short_badadib_orig-1' } }),
      'fan/remix-orig': post('Reaction', { originalAuthor: 'badadib', originalPermlink: 'orig-1' }),
    };
    const r = await soundIndex.runSoundIndex({ db: db(), rpc, library: LIBRARY });
    expect(r).toMatchObject({ backfill: 4, indexed: 4, missing: 0 });

    const uses = await db().collection('sound_uses').find().sort({ createdAt: 1 }).toArray();
    expect(uses.map((u) => [u._id, u.sound, u.via])).toEqual([
      ['badadib/orig-1', 'short_badadib_orig-1', 'original'],
      ['badadib/with-song', 'lib-carefree', 'sound'],
      ['fan/uses-orig', 'short_badadib_orig-1', 'sound'],
      ['fan/remix-orig', 'short_badadib_orig-1', 'remix'],
    ]);
    expect(uses[1].reward).toBe(1.5);
    const sound = await db().collection('sounds').findOne({ _id: 'short_badadib_orig-1' });
    expect(sound).toMatchObject({ kind: 'short', title: 'My beat', artist: '@badadib', account: 'badadib', original: { author: 'badadib', permlink: 'orig-1' } });
    const lib = await db().collection('sounds').findOne({ _id: 'lib-carefree' });
    expect(lib).toMatchObject({ kind: 'library', title: 'Carefree', file: 'carefree.mp3' });

    const state = await db().collection('sound_index_state').findOne({ _id: 'shorts' });
    expect(new Date(state.cursor).getTime()).toBe(uses[3].createdAt.getTime());
  });

  test('the backfill goes on from its cursor, and a post found later is picked up while recent', async () => {
    await addShort('badadib', 'b1', 'p1', hoursAgo(10));
    await addShort('badadib', 'b2', 'p2', hoursAgo(9));
    await addShort('badadib', 'b3', 'p3', hoursAgo(8));
    POSTS = { 'badadib/p1': post('One'), 'badadib/p3': post('Three') };
    const first = await soundIndex.runSoundIndex({ db: db(), rpc, library: LIBRARY, batch: 2 });
    expect(first).toMatchObject({ backfill: 2, rechecked: 0, missing: 1 });
    POSTS['badadib/p2'] = post('Two');
    const second = await soundIndex.runSoundIndex({ db: db(), rpc, library: LIBRARY, batch: 2 });
    // p3 from the cursor, then the two before it again as recent ones
    expect(second).toMatchObject({ backfill: 1, rechecked: 2, missing: 0 });
    expect(await db().collection('sound_uses').countDocuments()).toBe(3);
  });

  test('nothing is written with Mongo writes switched off', async () => {
    await addShort('badadib', 'w1', 'w-1', hoursAgo(5));
    POSTS = { 'badadib/w-1': post('W') };
    expect(await soundIndex.runSoundIndex({ db: db(), rpc, library: LIBRARY, writes: false })).toEqual({ skipped: 'writes off' });
    expect(await db().collection('sound_uses').countDocuments()).toBe(0);
  });

  test('the job runs soon after boot, then on its interval, and logs what it did', async () => {
    let first;
    const t = jest.spyOn(global, 'setTimeout').mockImplementation((fn) => { first = fn; return 0; });
    const iv = jest.spyOn(global, 'setInterval').mockImplementation(() => 0);
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    soundIndex.scheduleSoundIndex();
    t.mockRestore();
    iv.mockRestore();
    expect(typeof first).toBe('function');
    await addShort('badadib', 'j1', 'j-1', hoursAgo(3));
    // Hive is not reachable from the tests: the Short is missing, which is logged.
    await first();
    expect(log.mock.calls.some(([m]) => /\[soundIndex\]/.test(String(m)))).toBe(true);
  });

  test('the music library names songs and gives their file', async () => {
    soundIndex._resetLibraryForTests(null);
    const fetchImpl = jest.fn(async () => ({ ok: true, json: async () => ({ tracks: [{ id: 'carefree', title: 'Carefree', artist: 'Kevin MacLeod', file: 'care free.mp3' }] }) }));
    const lib = await soundIndex.loadLibrary({ fetchImpl, url: 'https://editor.example/music/library.json' });
    expect(soundIndex.libraryFileUrl(lib, 'carefree')).toBe('https://editor.example/music/care%20free.mp3');
    // Cached: no second fetch
    await soundIndex.loadLibrary({ fetchImpl, url: 'https://editor.example/music/library.json' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    soundIndex._resetLibraryForTests(null);
    const down = await soundIndex.loadLibrary({ fetchImpl: async () => { throw new Error('down'); }, url: 'https://editor.example/x.json' });
    expect(down.byId.size).toBe(0);
  });
});

describe('GET /sounds', () => {
  async function seed() {
    await addShort('badadib', 'o1', 'orig-1', hoursAgo(100));
    await addShort('fan', 'u1', 'use-1', hoursAgo(50));
    await addShort('fan', 'u2', 'use-2', hoursAgo(40));
    await addShort('fan', 'u3', 'use-3', hoursAgo(30), { listed_on_3speak: false });
    await addShort('fan', 'u4', 'song-1', hoursAgo(20));
    await addShort('fan', 'old', 'old-use', hoursAgo(24 * 30));
    const uses = { sound: { title: 'My beat', artist: '@badadib', account: 'badadib', source: '3speak', id: 'short_badadib_orig-1' } };
    POSTS = {
      'badadib/orig-1': post('My beat'),
      'fan/use-1': post('Use one', uses),
      'fan/use-2': post('Use two', uses, { total_payout_value: '3.000 HBD' }),
      'fan/use-3': post('Unlisted use', uses),
      'fan/song-1': post('Song', { sound: { title: 'Carefree', artist: 'Kevin MacLeod' } }),
      'fan/old-use': post('Old use', uses),
    };
    await soundIndex.runSoundIndex({ db: db(), rpc, library: LIBRARY });
  }

  test('a Short sound lists its original and the shown Shorts using it, newest or top', async () => {
    await seed();
    const res = await request(app).get('/sounds/short_badadib_orig-1').expect(200);
    expect(res.body.sound).toMatchObject({ id: 'short_badadib_orig-1', kind: 'short', title: 'My beat', artist: '@badadib', account: 'badadib' });
    expect(res.body.original).toMatchObject({ author: 'badadib', permlink: 'orig-1', owner: 'badadib', embed_permlink: 'o1' });
    // The unlisted one is counted in the index but not shown
    expect(res.body.uses).toBe(4);
    expect(res.body.shorts.map((s) => s.permlink)).toEqual(['use-2', 'use-1', 'old-use']);
    const top = await request(app).get('/sounds/short_badadib_orig-1?sort=top').expect(200);
    expect(top.body.shorts[0].permlink).toBe('use-2');
  });

  test('a library song plays from the library', async () => {
    await seed();
    const res = await request(app).get('/sounds/lib-carefree').expect(200);
    expect(res.body.sound).toMatchObject({ kind: 'library', title: 'Carefree', audio_url: 'https://editor.example/music/carefree.mp3' });
    expect(res.body.original).toBeNull();
    expect(res.body.shorts.map((s) => s.permlink)).toEqual(['song-1']);
  });

  test('a library song nobody used yet still has a page; unknown and hidden ones do not', async () => {
    await request(app).get('/sounds/lib-carefree').expect(200);
    await request(app).get('/sounds/lib-nothing').expect(404);
    await request(app).get('/sounds/ext-0123456789').expect(404);
    await request(app).get('/sounds/not a sound').expect(400);
    await seed();
    await db().collection('embed-video').updateOne({ permlink: 'o1' }, { $set: { hiddenFromFeed: true } });
    router._clearCacheForTests();
    await request(app).get('/sounds/short_badadib_orig-1').expect(404);
  });

  test('trending counts recent uses, not the originals', async () => {
    await seed();
    const res = await request(app).get('/sounds/trending').expect(200);
    expect(res.body.sounds.map((s) => [s.id, s.uses])).toEqual([
      ['short_badadib_orig-1', 3],
      ['lib-carefree', 1],
    ]);
    expect(res.body.sounds[0].original).toMatchObject({ author: 'badadib', permlink: 'orig-1' });
  });

  test('trending is empty without uses, and errors answer 500', async () => {
    const res = await request(app).get('/sounds/trending?limit=5').expect(200);
    expect(res.body).toEqual({ success: true, days: 7, sounds: [] });
    const spy = jest.spyOn(dbModule, 'getDb').mockReturnValue({ collection: () => { throw new Error('down'); } });
    router._clearCacheForTests();
    await request(app).get('/sounds/trending').expect(500);
    await request(app).get('/sounds/lib-carefree').expect(500);
    spy.mockRestore();
  });
});
