/**
 * Premieres: a scheduled post listed as a premiere (opt-in `premiere: true`) gets a
 * public countdown, "Notify me" reminders and a live chat for the video's length
 * plus a grace, kept afterwards as timecoded messages. routes/premieres.js over
 * services/premieres.js, against the real test MongoDB; the vouch check is a stand-in.
 */
jest.mock('../utils/hiveAuth', () => ({
  verifyHiveAuthority: jest.fn(async () => ({ ok: false })),
  verifyDelegateVouch: jest.fn(async ({ signature }) => ({ ok: signature === 'good' })),
}));
const request = require('supertest');
const testDb = require('./helpers/db');
const { buildApp } = require('./helpers/app');
const { pinClock, NOW } = require('./routes-misc/_fixtures');
const premieres = require('../services/premieres');
const { PREMIERE_GRACE_MIN } = require('../utils/config');

const db = testDb.use();
const app = buildApp(['/premieres', require('../routes/premieres')]);

const MIN = 60 * 1000;
const at = (ms) => new Date(NOW.getTime() + ms);
const vouch = (user) => ({ user, signature: 'good', timestamp: Date.now() });

const seed = (permlink, extra = {}) => db().collection('scheduled-posts').insertOne({
  owner: 'badadib', permlink, status: 'scheduled', scheduledOn: at(60 * MIN), title: `Premiere ${permlink}`,
  body: 'the whole post body', thumbnail: 'https://img.example/t.jpg', embedPermlink: `asset-${permlink}`,
  premiere: true, jsonMetadata: { secret: 1 }, createdAt: NOW, updatedAt: NOW, ...extra,
});
const video = (permlink, duration) => db().collection('embed-video').insertOne({
  owner: 'badadib', permlink: `asset-${permlink}`, duration, status: 'published',
});

beforeEach(() => pinClock());
afterEach(() => jest.useRealTimers());

describe('one premiere', () => {
  test('a premiere is public: title, thumbnail, start, length, never the body or the asset', async () => {
    await seed('p1');
    await video('p1', 600);
    const res = await request(app).get('/premieres/badadib/p1').expect(200);
    expect(res.body.premiere).toEqual({
      owner: 'badadib',
      permlink: 'p1',
      title: 'Premiere p1',
      thumbnail: 'https://img.example/t.jpg',
      startAt: at(60 * MIN).toISOString(),
      duration: 600,
      chatUntil: at(60 * MIN + 600 * 1000 + PREMIERE_GRACE_MIN * MIN).toISOString(),
      state: 'upcoming',
      reminders: 0,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/asset-p1|whole post body|secret/);
    expect(res.body.now).toBe(NOW.toISOString());
  });

  test('a scheduled post that is not listed as a premiere, a cancelled one, or none at all is a 404', async () => {
    await seed('plain', { premiere: false });
    await seed('gone', { status: 'cancelled' });
    await request(app).get('/premieres/badadib/plain').expect(404);
    await request(app).get('/premieres/badadib/gone').expect(404);
    await request(app).get('/premieres/badadib/nothing').expect(404);
    await request(app).get('/premieres/Bad Name/x').expect(400);
  });

  test('upcoming, then live from the start for the length plus the grace, then ended', async () => {
    await seed('p2', { status: 'posted' });
    await video('p2', 300);
    const state = async () => (await request(app).get('/premieres/badadib/p2')).body.premiere.state;
    expect(await state()).toBe('upcoming');
    jest.setSystemTime(at(60 * MIN));
    expect(await state()).toBe('live');
    jest.setSystemTime(at(60 * MIN + 300 * 1000 + PREMIERE_GRACE_MIN * MIN - 1));
    expect(await state()).toBe('live');
    jest.setSystemTime(at(60 * MIN + 300 * 1000 + PREMIERE_GRACE_MIN * MIN));
    expect(await state()).toBe('ended');
  });

  test('the thumbnail falls back to the video\'s own, and a later linked post still finds its length', async () => {
    await seed('p3', { thumbnail: null, embedPermlink: null, status: 'posted' });
    await db().collection('embed-video').insertOne({
      owner: 'badadib', permlink: 'other-id', hive_permlink: 'p3', duration: 42, thumbnail_url: 'https://img.example/own.jpg',
    });
    const { premiere } = (await request(app).get('/premieres/badadib/p3')).body;
    expect(premiere).toMatchObject({ duration: 42, thumbnail: 'https://img.example/own.jpg' });
  });
});

describe('lists', () => {
  test('upcoming and live premieres only, soonest first, one creator\'s with owner', async () => {
    await seed('later', { scheduledOn: at(5 * 60 * MIN) });
    await seed('soon', { scheduledOn: at(10 * MIN) });
    await seed('now', { scheduledOn: at(-2 * MIN), status: 'posted' });
    await video('now', 600);
    await seed('over', { scheduledOn: at(-3 * 60 * MIN), status: 'posted' });
    await video('over', 60);
    await seed('notone', { premiere: false, scheduledOn: at(20 * MIN) });
    await seed('other', { owner: 'fan', scheduledOn: at(30 * MIN) });

    const all = (await request(app).get('/premieres/upcoming').expect(200)).body.premieres;
    expect(all.map((p) => `${p.owner}/${p.permlink}:${p.state}`)).toEqual([
      'badadib/now:live', 'badadib/soon:upcoming', 'fan/other:upcoming', 'badadib/later:upcoming',
    ]);
    const mine = (await request(app).get('/premieres/upcoming?owner=fan&limit=5').expect(200)).body.premieres;
    expect(mine.map((p) => p.permlink)).toEqual(['other']);
    await request(app).get('/premieres/upcoming?owner=Not Valid').expect(400);
  });
});

describe('Notify me', () => {
  test('needs a vouch; on, counted, listed; off again', async () => {
    await seed('r1');
    await request(app).post('/premieres/badadib/r1/remind').send({ user: 'fan', signature: 'bad', timestamp: Date.now() }).expect(401);

    const on = await request(app).post('/premieres/badadib/r1/remind').send({ ...vouch('fan'), on: true }).expect(200);
    expect(on.body).toEqual({ success: true, reminded: true, reminders: 1 });
    // Twice is still one.
    await request(app).post('/premieres/badadib/r1/remind').send(vouch('fan')).expect(200);
    expect((await request(app).get('/premieres/badadib/r1')).body.premiere.reminders).toBe(1);

    const list = await request(app).post('/premieres/reminders').send(vouch('fan')).expect(200);
    expect(list.body.reminders.map((p) => p.permlink)).toEqual(['r1']);
    expect(list.body.due).toEqual([]);

    const off = await request(app).post('/premieres/badadib/r1/remind').send({ ...vouch('fan'), on: false }).expect(200);
    expect(off.body).toMatchObject({ reminded: false, reminders: 0 });
    await request(app).post('/premieres/reminders').send({ user: 'fan' }).expect(401);
  });

  test('a started premiere takes no new reminder, and a reminded one shows as due once it starts', async () => {
    await seed('r2', { scheduledOn: at(5 * MIN) });
    await video('r2', 600);
    await request(app).post('/premieres/badadib/r2/remind').send(vouch('fan')).expect(200);
    jest.setSystemTime(at(6 * MIN));
    await request(app).post('/premieres/badadib/r2/remind').send(vouch('fan2')).expect(409);
    const list = await request(app).post('/premieres/reminders').send(vouch('fan')).expect(200);
    expect(list.body.due.map((p) => p.permlink)).toEqual(['r2']);
    await request(app).post('/premieres/badadib/none/remind').send(vouch('fan')).expect(404);
  });

  test('dueReminders hands each started premiere\'s reminders out once', async () => {
    await seed('d1', { scheduledOn: at(5 * MIN) });
    await seed('d2', { scheduledOn: at(60 * MIN) });
    await premieres.setReminder('fan', 'badadib', 'd1', true);
    await premieres.setReminder('fan', 'badadib', 'd2', true);
    expect(await premieres.dueReminders({ now: NOW.getTime() })).toEqual([]);
    const due = await premieres.dueReminders({ now: at(6 * MIN).getTime() });
    expect(due).toEqual([expect.objectContaining({
      user: 'fan', owner: 'badadib', permlink: 'd1', title: 'Premiere d1', startAt: at(5 * MIN).toISOString(),
    })]);
    expect(await premieres.markReminded(due.map((d) => d.id).concat('nope'))).toBe(1);
    expect(await premieres.dueReminders({ now: at(6 * MIN).getTime() })).toEqual([]);
    expect(await premieres.markReminded([])).toBe(0);
  });
});

describe('the chat', () => {
  const say = (user, text, permlink = 'c1') => request(app).post(`/premieres/badadib/${permlink}/chat`).send({ ...vouch(user), text });

  test('closed before the start, open while live with the server\'s offset, closed after', async () => {
    await seed('c1', { scheduledOn: at(10 * MIN), status: 'posted' });
    await video('c1', 120);
    expect((await say('fan', 'hello')).status).toBe(409);

    jest.setSystemTime(at(10 * MIN + 30 * 1000));
    const res = await say('fan', '  first\n\u0007line   here  ').expect(201);
    expect(res.body.message).toMatchObject({ user: 'fan', text: 'first line here', offset: 30 });

    // Past the video's end, inside the grace: the offset stops at the length.
    jest.setSystemTime(at(10 * MIN + 200 * 1000));
    expect((await say('fan', 'that was it')).body.message.offset).toBe(120);

    const read = await request(app).get('/premieres/badadib/c1/chat').expect(200);
    expect(read.body).toMatchObject({ open: true, state: 'live' });
    expect(read.body.messages.map((m) => [m.text, m.offset])).toEqual([['first line here', 30], ['that was it', 120]]);

    const after = Date.parse(read.body.messages[0].at);
    const since = await request(app).get(`/premieres/badadib/c1/chat?after=${after}`).expect(200);
    expect(since.body.messages.map((m) => m.text)).toEqual(['that was it']);

    jest.setSystemTime(at(10 * MIN + 120 * 1000 + PREMIERE_GRACE_MIN * MIN));
    expect((await say('fan2', 'late')).status).toBe(409);
    const replay = await request(app).get('/premieres/badadib/c1/chat').expect(200);
    expect(replay.body).toMatchObject({ open: false, state: 'ended' });
    expect(replay.body.messages).toHaveLength(2);
  });

  test('needs a vouch and some text; is capped; is braked per viewer', async () => {
    await seed('c1', { scheduledOn: at(-MIN), status: 'posted' });
    await request(app).post('/premieres/badadib/c1/chat').send({ user: 'fan3', signature: 'bad', timestamp: Date.now(), text: 'x' }).expect(401);
    expect((await say('fan3', '   ')).status).toBe(400);
    expect((await say('fan3', { not: 'text' })).status).toBe(400);
    const long = await say('fan3', 'é'.repeat(500)).expect(201);
    expect(Array.from(long.body.message.text)).toHaveLength(200);
    // Straight after: too soon.
    expect((await say('fan3', 'again')).status).toBe(429);
    jest.setSystemTime(Date.now() + 2000);
    await say('fan3', 'again').expect(201);
    // At most a dozen a minute.
    let last = 201;
    for (let i = 0; i < 12 && last === 201; i += 1) {
      jest.setSystemTime(Date.now() + 2000);
      last = (await say('fan3', `m${i}`)).status;
    }
    expect(last).toBe(429);
    expect((await say('fan4', 'x', 'nope')).status).toBe(404);
  });

  test('a message comes down by its author or the creator, nobody else, and polls report it', async () => {
    await seed('c1', { scheduledOn: at(-MIN), status: 'posted' });
    const a = (await say('fan5', 'one').expect(201)).body.message;
    jest.setSystemTime(Date.now() + 2000);
    const b = (await say('fan6', 'two').expect(201)).body.message;
    const remove = (user, id) => request(app).post('/premieres/badadib/c1/chat/remove').send({ ...vouch(user), id });

    await remove('fan6', a.id).expect(404);
    await remove('fan5', a.id).expect(200);
    jest.setSystemTime(Date.now() + 1000);
    await remove('badadib', b.id).expect(200);
    await remove('badadib', 'not-an-id').expect(404);
    await request(app).post('/premieres/badadib/c1/chat/remove').send({ id: a.id }).expect(401);

    const all = await request(app).get('/premieres/badadib/c1/chat').expect(200);
    expect(all.body.messages).toEqual([]);
    const since = await request(app).get(`/premieres/badadib/c1/chat?after=${Date.parse(a.at)}`).expect(200);
    expect(since.body.removed.sort()).toEqual([a.id, b.id].sort());
  });
});

describe('scheduled posts carry the opt-in', () => {
  test('windowOf with no known length uses the default length', () => {
    const w = premieres.windowOf(NOW, 0, NOW.getTime());
    expect(w.state).toBe('live');
    expect(w.chatUntil - w.start).toBeGreaterThan(PREMIERE_GRACE_MIN * MIN);
  });
});
