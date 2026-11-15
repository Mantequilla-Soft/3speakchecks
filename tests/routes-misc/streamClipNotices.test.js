/**
 * Stream clips ready (H13): the hangouts server calls POST /stream-stats/clips-ready
 * (behind STREAM_STATS_SECRET) when a stream's clips are cut; the host and each
 * clipper get one bell row per stream (services/streamClipNotices.js) and one push.
 */
jest.mock('../../utils/webPush', () => ({ sendToUser: jest.fn(async () => ({ sent: 1, gone: 0 })) }));
const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const push = require('../../utils/webPush');
const { streamClipSource, noticesFrom, pushPayload, COLL } = require('../../services/streamClipNotices');
const notify = require('../../routes/notify');

const SECRET = process.env.STREAM_STATS_SECRET;
const db = testDb.use();
const app = buildApp(['/', require('../../routes/streamStats')]);
const rows = () => db().collection(COLL);
const post = (body, headers = { Authorization: `Bearer ${SECRET}` }) => request(app).post('/stream-stats/clips-ready').set(headers).send(body);

beforeEach(() => push.sendToUser.mockClear());

describe('POST /stream-stats/clips-ready', () => {
  test('needs the shared secret', async () => {
    await post({ room: 'badadib-r1', host: 'badadib', total: 2 }, {}).expect(401);
    expect(await rows().countDocuments()).toBe(0);
  });

  test('the host hears about every clip, each clipper about theirs; pushed once per person and stream', async () => {
    const body = { room: 'badadib-r1', host: 'BadAdib', title: 'Friday stream', total: 6, clippers: [{ user: 'fan', count: 3 }, { user: 'badadib', count: 1 }, { user: 'Bad Name', count: 1 }, { user: 'zero', count: 0 }] };
    const res = await post(body).expect(200);
    expect(res.body).toEqual({ ok: true, notices: 2, pushed: 2 });
    const all = await rows().find({}).sort({ user: 1 }).toArray();
    expect(all.map((r) => [r.user, r.role, r.count, r.host, r.title])).toEqual([
      ['badadib', 'host', 6, 'badadib', 'Friday stream'],
      ['fan', 'clipper', 3, 'badadib', 'Friday stream'],
    ]);
    expect(push.sendToUser).toHaveBeenCalledWith('fan', expect.objectContaining({ url: '/clips', title: "Your clips of @badadib's stream are ready" }));
    // Called again (DVR teardown and the VOD cut both report): counts update, no second push.
    await post({ ...body, total: 7 }).expect(200);
    expect(push.sendToUser).toHaveBeenCalledTimes(2);
    expect((await rows().findOne({ user: 'badadib' })).count).toBe(7);
  });

  test('refuses a body without room, host or clips', async () => {
    await post({ room: 'bad room', host: 'badadib', total: 1 }).expect(400);
    await post({ room: 'r', host: 'badadib', total: 0 }).expect(400);
    await post({}).expect(400);
  });
});

describe('the bell', () => {
  test('streamClipSource lists the person\'s unexpired rows, linking /clips, and is a notify source', async () => {
    await post({ room: 'badadib-r2', host: 'badadib', total: 1, clippers: [{ user: 'fan', count: 1 }] }).expect(200);
    const [n] = await streamClipSource({ user: 'fan' });
    expect(n).toMatchObject({ id: 'clips:badadib-r2', type: 'stream_clips', actor: 'badadib', url: '/clips', count: 1, role: 'clipper', room: 'badadib-r2' });
    expect(await streamClipSource({ user: 'fan', now: Date.now() + 49 * 3600 * 1000 })).toEqual([]);
    expect(notify.SOURCES).toContain(streamClipSource);
  });

  test('push wording for one and many', () => {
    expect(pushPayload({ role: 'host', count: 1 }, { host: 'badadib', title: '', room: 'r' })).toMatchObject({ title: 'A clip of your stream is ready', body: 'Post them as Shorts on 3Speak.', tag: 'clips:r' });
    expect(pushPayload({ role: 'host', count: 3 }, { host: 'badadib', title: 'T', room: 'r' }).title).toBe('3 clips of your stream are ready');
    expect(pushPayload({ role: 'clipper', count: 1 }, { host: 'badadib', title: 'T', room: 'r' }).title).toBe("Your clip of @badadib's stream is ready");
    expect(noticesFrom(null)).toBeNull();
  });
});
