/**
 * Weekly Shorts challenge (utils/shortsChallenge.js + routes/shortsChallenges.js)
 * against the real test MongoDB: the planned weeks are seeded insert-only, Shorts
 * carrying a week's tag inside that week become entries, and only entries the team
 * checked show up and count. The admin routes need AD_ADMIN_SECRET.
 */
const request = require('supertest');
const testDb = require('./helpers/db');
const { buildApp } = require('./helpers/app');
const { pinClock } = require('./routes-misc/_fixtures');
const sc = require('../utils/shortsChallenge');
const seed = require('../data/shortsChallenges.seed.json');

const db = testDb.use();
const app = buildApp(['/', require('../routes/shortsChallenges')]);

const WED_W49 = new Date('2026-12-02T10:00:00.000Z'); // 2026-W49
const SECRET = 'test-challenge-admin';
const admin = () => ({ Authorization: `Bearer ${SECRET}` });

const short = (owner, permlink, extra = {}) => db().collection('embed-video').insertOne({
  owner, permlink, short: true, status: 'published', processed: true,
  createdAt: new Date('2026-12-01T09:00:00.000Z'),
  hive_tags: ['hive-181335', 'challenge2026w49'], hive_tags_lower: ['hive-181335', 'challenge2026w49'],
  hive_body: `caption of ${permlink}`, thumbnail_url: `https://img.example/${permlink}.jpg`,
  embed_url: `@${owner}/${permlink}`,
  ...extra,
});

// The ads admin's secret (same one): restored after each test, other files in
// this worker may rely on it
const savedSecret = process.env.AD_ADMIN_SECRET;
beforeEach(() => {
  pinClock(WED_W49);
  sc._test.resetReady();
  sc._test.lastSync.clear();
  process.env.AD_ADMIN_SECRET = SECRET;
});
afterEach(() => {
  jest.useRealTimers();
  if (savedSecret === undefined) delete process.env.AD_ADMIN_SECRET; else process.env.AD_ADMIN_SECRET = savedSecret;
});

describe('weeks', () => {
  test('weeks run Sunday to Saturday in UTC, named after the ISO week of their Monday', () => {
    expect(sc.weekIdOf(new Date('2026-11-21T23:59:59Z'))).toBe('2026-W47'); // Saturday
    expect(sc.weekIdOf(new Date('2026-11-22T00:00:00Z'))).toBe('2026-W48'); // Sunday
    expect(sc.weekIdOf(new Date('2026-11-28T23:59:59Z'))).toBe('2026-W48'); // Saturday
    expect(sc.weekIdOf(new Date('2026-11-29T00:00:00Z'))).toBe('2026-W49');
    expect(sc.weekIdOf(new Date('2027-01-01T12:00:00Z'))).toBe('2026-W53');
    expect(sc.weekIdOf(new Date('2027-01-03T00:00:00Z'))).toBe('2027-W01');
    expect(sc.weekStart('2026-W48').toISOString()).toBe('2026-11-22T00:00:00.000Z');
    expect(sc.weekEnd('2026-W48').toISOString()).toBe('2026-11-28T23:59:59.999Z');
    expect(sc.weekStart('2026-W53').toISOString()).toBe('2026-12-27T00:00:00.000Z');
    expect(sc.weekStart('2027-W53')).toBeNull();
    expect(sc.tagOf('2026-W48')).toBe('challenge2026w48');
  });

  test('the seed plans a theme for every week, with English, at least a year ahead', () => {
    expect(seed.length).toBeGreaterThanOrEqual(52);
    for (const row of seed) {
      expect(sc.isWeekId(row.week)).toBe(true);
      expect(sc.cleanTexts(row.texts).error).toBeUndefined();
    }
    expect(new Set(seed.map((r) => r.week)).size).toBe(seed.length);
  });

  test('texts: English required, lengths and language codes checked', () => {
    expect(sc.cleanTexts({ de: { title: 'a', prompt: 'b' } }).error).toMatch(/en is required/);
    expect(sc.cleanTexts({ en: { title: 'a' } }).error).toMatch(/both needed/);
    expect(sc.cleanTexts({ en: { title: 'x'.repeat(81), prompt: 'b' } }).error).toMatch(/title/);
    expect(sc.cleanTexts({ 'e n': { title: 'a', prompt: 'b' } }).error).toMatch(/language/);
    expect(sc.cleanTexts({ en: { title: ' a ', prompt: ' b ' } }).texts).toEqual({ en: { title: 'a', prompt: 'b' } });
  });
});

describe('public', () => {
  test('this week, next week and the weeks before, from the seeded plan', async () => {
    const res = await request(app).get('/shorts-challenges').expect(200);
    expect(res.body.week).toBe('2026-W49');
    expect(res.body.current).toMatchObject({ week: '2026-W49', tag: 'challenge2026w49', theme: 'oneSkill', entries: 0 });
    expect(res.body.current.texts.en.title).toBe('One skill in 60 seconds');
    expect(Object.keys(res.body.current.texts)).toHaveLength(21);
    expect(res.body.next.week).toBe('2026-W50');
    expect(res.body.past.map((c) => c.week)).toEqual(['2026-W48']);
  });

  test('dates always follow the week id (weeks seeded as Monday weeks are moved to Sunday)', async () => {
    await request(app).get('/shorts-challenges').expect(200);
    await db().collection('shorts_challenges').updateOne({ _id: '2026-W48' }, { $set: { starts_at: new Date('2026-11-23T00:00:00Z'), ends_at: new Date('2026-11-29T23:59:59.999Z') } });
    sc._test.resetReady();
    const res = await request(app).get('/shorts-challenges/2026-W48').expect(200);
    expect(res.body.challenge).toMatchObject({ starts_at: '2026-11-22T00:00:00.000Z', ends_at: '2026-11-28T23:59:59.999Z' });
  });

  test('the seed never overwrites a week the team changed', async () => {
    await request(app).get('/shorts-challenges').expect(200);
    await db().collection('shorts_challenges').updateOne({ _id: '2026-W49' }, { $set: { 'texts.en.title': 'Edited' } });
    sc._test.resetReady();
    const res = await request(app).get('/shorts-challenges/2026-W49').expect(200);
    expect(res.body.challenge.texts.en.title).toBe('Edited');
  });

  test('a Short with the tag becomes an entry, but shows only once the team checked it', async () => {
    await short('badadib', 'one');
    await short('badadib', 'two', { createdAt: new Date('2026-12-02T08:00:00.000Z') });
    await short('badadib', 'late', { createdAt: new Date('2026-12-07T01:00:00.000Z') }); // the week after
    await short('badadib', 'untagged', { hive_tags: ['x'], hive_tags_lower: ['x'] });
    await short('badadib', 'long', { short: false });

    let res = await request(app).get('/shorts-challenges/2026-W49/entries').expect(200);
    expect(res.body).toMatchObject({ total: 0, videos: [] });
    const entries = await db().collection('shorts_challenge_entries').find({}).sort({ permlink: 1 }).toArray();
    expect(entries.map((e) => e.permlink)).toEqual(['one', 'two']);
    expect(entries[0]).toMatchObject({ week: '2026-W49', tag: 'challenge2026w49', checked: false, reviewed_at: null });

    await db().collection('shorts_challenge_entries').updateOne({ permlink: 'two' }, { $set: { checked: true, reviewed_at: new Date() } });
    res = await request(app).get('/shorts-challenges/2026-W49/entries').expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.videos[0]).toMatchObject({ author: 'badadib', permlink: 'two', short: true, images: { thumbnail: 'https://img.example/two.jpg' } });
    const list = await request(app).get('/shorts-challenges').expect(200);
    expect(list.body.current.entries).toBe(1);
  });

  test('a checked Short that was taken down no longer shows', async () => {
    await short('badadib', 'one');
    await request(app).get('/shorts-challenges/2026-W49/entries').expect(200);
    await db().collection('shorts_challenge_entries').updateOne({ permlink: 'one' }, { $set: { checked: true } });
    await db().collection('embed-video').updateOne({ permlink: 'one' }, { $set: { status: 'deleted' } });
    const res = await request(app).get('/shorts-challenges/2026-W49/entries').expect(200);
    expect(res.body.videos).toEqual([]);
  });

  test('bad and unknown weeks', async () => {
    await request(app).get('/shorts-challenges/nonsense').expect(400);
    await request(app).get('/shorts-challenges/2031-W02').expect(404);
    await request(app).get('/shorts-challenges/2031-W02/entries').expect(404);
  });
});

describe('admin', () => {
  test('refused without the secret, and off while none is set', async () => {
    await request(app).get('/admin/shorts-challenges').expect(401);
    await request(app).get('/admin/shorts-challenges').set({ Authorization: 'Bearer nope' }).expect(401);
    delete process.env.AD_ADMIN_SECRET;
    await request(app).get('/admin/shorts-challenges').set(admin()).expect(503);
  });

  test('lists pending entries, checks one, turns one down; counts follow', async () => {
    await short('badadib', 'one');
    await short('ashenadib', 'two');
    let res = await request(app).get('/admin/shorts-challenges/2026-W49/entries?status=pending').set(admin()).expect(200);
    expect(res.body.entries.map((e) => e.permlink).sort()).toEqual(['one', 'two']);
    expect(res.body.entries[0]).toMatchObject({ status: 'pending', video_status: 'published', url: expect.stringMatching(/^https:\/\/3speak\.tv\/shorts\?v=/) });

    await request(app).put('/admin/shorts-challenge-entries/badadib/one').set(admin()).send({ checked: true, by: 'team' }).expect(200);
    res = await request(app).put('/admin/shorts-challenge-entries/ashenadib/two').set(admin()).send({ checked: false }).expect(200);
    expect(res.body.entry).toMatchObject({ status: 'rejected', checked: false });

    for (const [status, want] of [['pending', []], ['checked', ['one']], ['rejected', ['two']]]) {
      res = await request(app).get(`/admin/shorts-challenges/2026-W49/entries?status=${status}`).set(admin()).expect(200);
      expect(res.body.entries.map((e) => e.permlink)).toEqual(want);
    }
    res = await request(app).get('/admin/shorts-challenges').set(admin()).expect(200);
    expect(res.body.challenges.find((c) => c.week === '2026-W49').entries).toEqual({ checked: 1, rejected: 1, pending: 0, total: 2 });
    const pub = await request(app).get('/shorts-challenges/2026-W49/entries').expect(200);
    expect(pub.body.videos.map((v) => v.permlink)).toEqual(['one']);
  });

  test('setting the flag: only true or false, only for a known entry', async () => {
    await request(app).put('/admin/shorts-challenge-entries/badadib/one').set(admin()).send({ checked: 'yes' }).expect(400);
    await request(app).put('/admin/shorts-challenge-entries/badadib/none').set(admin()).send({ checked: true }).expect(404);
    await request(app).put('/admin/shorts-challenge-entries/<b>/x').set(admin()).send({ checked: true }).expect(400);
  });

  test('the team writes a week\'s prompts; English is required', async () => {
    await request(app).put('/admin/shorts-challenges/2028-W02').set(admin()).send({ texts: { de: { title: 'a', prompt: 'b' } } }).expect(400);
    const res = await request(app).put('/admin/shorts-challenges/2028-W02').set(admin())
      .send({ theme: 'winterWalk', texts: { en: { title: 'Winter walk', prompt: 'Take us on a walk.' } } }).expect(200);
    expect(res.body.challenge).toMatchObject({ week: '2028-W02', tag: 'challenge2028w02', theme: 'winterWalk', texts: { en: { title: 'Winter walk' } } });
    const pub = await request(app).get('/shorts-challenges/2028-W02').expect(200);
    expect(pub.body.challenge.starts_at).toBe('2028-01-09T00:00:00.000Z');
  });
});
