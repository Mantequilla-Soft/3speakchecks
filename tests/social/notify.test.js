/**
 * Notification levels (utils/notifyLevels.js, routes/notify.js) and "went live"
 * (services/liveNotify.js): levels are saved per follower and creator with the
 * session vouch, the bell feed reads live events of followed hosts minus Off,
 * the job records streams from a stub /streams and pushes only NEW ones to
 * followers whose level and push switch allow it. The vouch check, the following
 * lists and web push are stand-ins; Mongo is the test database.
 */
// badadib streams in these tests, so only the one hidden host the job must skip.
process.env.LIVE_EXCLUDED_HOSTS = 'hidden.host';

jest.mock('../../utils/hiveAuth', () => ({
  verifyHiveAuthority: jest.fn(async () => ({ ok: false })),
  verifyDelegateVouch: jest.fn(async ({ signature }) => ({ ok: signature === 'good' })),
}));
jest.mock('../../utils/hive', () => ({ getFollowingList: jest.fn(async () => null) }));
jest.mock('../../utils/webPush', () => ({
  isConfigured: jest.fn(() => true),
  listSubscribers: jest.fn(async () => []),
  getPrefs: jest.fn(async () => ({})),
  sendToUser: jest.fn(async () => ({ sent: 1 })),
}));

const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const { stubServer, json } = require('../services/_fixtures');
const hive = require('../../utils/hive');
const push = require('../../utils/webPush');
const live = require('../../services/liveNotify');
const levels = require('../../utils/notifyLevels');
const notifyRouter = require('../../routes/notify');

const db = testDb.use();
const app = buildApp(['/', notifyRouter]);
const vouch = (user) => ({ user, signature: 'good', timestamp: Date.now() });

let follows;
beforeEach(() => {
  follows = new Map();
  hive.getFollowingList.mockReset().mockImplementation(async (u) => follows.get(u) || null);
  push.isConfigured.mockReturnValue(true);
  push.listSubscribers.mockReset().mockImplementation(async () => [...follows.keys()]);
  push.getPrefs.mockReset().mockResolvedValue({});
  push.sendToUser.mockReset().mockResolvedValue({ sent: 1 });
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

describe('levels', () => {
  test('levelAllows: highlights keeps videos, audio and live, drops shorts and stories; off drops all', () => {
    expect(['videos', 'audio', 'live', 'shorts', 'stories'].map((k) => levels.levelAllows('highlights', k)))
      .toEqual([true, true, true, false, false]);
    expect(levels.levelAllows('off', 'live')).toBe(false);
    expect(levels.levelAllows('all', 'shorts')).toBe(true);
  });

  test('saved with a vouch, read back, and "all" removes the row', async () => {
    await request(app).post('/notify/level').send({ ...vouch('fan'), creator: '@Badadib', level: 'off' }).expect(200);
    let res = await request(app).post('/notify/levels').send(vouch('fan')).expect(200);
    expect(res.body.levels).toEqual({ badadib: 'off' });

    await request(app).post('/notify/level').send({ ...vouch('fan'), creator: 'badadib', level: 'all' }).expect(200);
    res = await request(app).post('/notify/levels').send(vouch('fan')).expect(200);
    expect(res.body.levels).toEqual({});
    expect(await db().collection('notify_levels').countDocuments()).toBe(0);
  });

  test('refuses a bad vouch, a bad level and the caller themself', async () => {
    await request(app).post('/notify/level').send({ user: 'fan', signature: 'bad', timestamp: Date.now(), creator: 'badadib', level: 'off' }).expect(401);
    await request(app).post('/notify/level').send({ ...vouch('fan'), creator: 'badadib', level: 'loud' }).expect(400);
    await request(app).post('/notify/level').send({ ...vouch('fan'), creator: 'fan', level: 'off' }).expect(400);
    await request(app).post('/notify/levels').send({ user: 'fan' }).expect(401);
  });
});

describe('the live job', () => {
  let stub;
  let streams;
  beforeAll(async () => {
    stub = await stubServer((req, res) => json(res, 200, streams));
  });
  afterAll(() => stub.close());
  const run = () => live.runOnce({ bases: [stub.url] });
  const stream = (host, name, extra = {}) => ({
    name, host, title: `${host} live`, mode: 'standalone', live: true, visibility: 'public', createdAt: '2026-11-15T10:00:00.000Z', ...extra,
  });

  test('the first pass only records, later passes push new streams to followers', async () => {
    follows.set('fan', ['badadib']);
    streams = [stream('badadib', 'room-1')];
    expect(await run()).toMatchObject({ live: 1, seeded: true, sent: 0 });
    expect(push.sendToUser).not.toHaveBeenCalled();

    // Still live: no second push. A new stream: pushed.
    expect(await run()).toMatchObject({ fresh: 0, sent: 0 });
    streams = [stream('badadib', 'room-1'), stream('badadib', 'room-2', { title: 'Q and A' })];
    expect(await run()).toMatchObject({ fresh: 1, sent: 1 });
    expect(push.sendToUser).toHaveBeenCalledWith('fan', {
      title: '@badadib is live', body: 'Q and A', url: '/watch/room-2', tag: 'live:badadib/room-2',
    });
  });

  test('skips conference rooms, not-live, unlisted, odd and hidden hosts', async () => {
    streams = [
      stream('badadib', 'a', { mode: 'conference' }),
      stream('badadib', 'b', { live: false }),
      stream('badadib', 'c', { visibility: 'unlisted' }),
      stream('Bad Host', 'd'),
      stream('Hidden.Host', 'f'),
      stream('badadib', 'e'),
    ];
    expect(await run()).toMatchObject({ live: 1 });
  });

  test('no push for Off, for the live switch off, or for non-followers', async () => {
    streams = [];
    await run(); // seed
    follows.set('fan', ['badadib']);
    follows.set('muted', ['badadib']);
    follows.set('nolive', ['badadib']);
    follows.set('stranger', ['someone']);
    await levels.setLevel('muted', 'badadib', 'off');
    await levels.setLevel('fan', 'badadib', 'highlights');
    push.getPrefs.mockImplementation(async (u) => (u === 'nolive' ? { live: false } : {}));
    streams = [stream('badadib', 'go')];
    await run();
    expect(push.sendToUser.mock.calls.map((c) => c[0])).toEqual(['fan']);
  });

  test('a server that fails is skipped', async () => {
    expect(await live.fetchLiveStreams(['http://127.0.0.1:9'])).toEqual([]);
  });
});

describe('POST /notify/feed', () => {
  const insertEvent = (host, room, startedMinAgo, liveMinAgo) => db().collection('live_events').insertOne({
    _id: `${host}/${room}/t`, host, room, title: `${room} title`, thumbnail: null,
    started_at: new Date(Date.now() - startedMinAgo * 60000), last_live_at: new Date(Date.now() - liveMinAgo * 60000),
  });

  test('lists live events of followed hosts, newest first, minus Off and old ones', async () => {
    follows.set('fan', ['badadib', 'quiet', 'muted']);
    await insertEvent('badadib', 'now', 5, 0);
    await insertEvent('quiet', 'earlier', 120, 90);
    await insertEvent('muted', 'hidden', 3, 0);
    await insertEvent('badadib', 'old', 60 * 30, 60 * 29);
    await insertEvent('stranger', 'other', 1, 0);
    await levels.setLevel('fan', 'muted', 'off');

    const res = await request(app).post('/notify/feed').send(vouch('fan')).expect(200);
    expect(res.body.notifications).toEqual([
      expect.objectContaining({ id: 'live:badadib/now/t', type: 'live', actor: 'badadib', title: 'now title', url: '/watch/now', live: true }),
      expect.objectContaining({ id: 'live:quiet/earlier/t', actor: 'quiet', live: false }),
    ]);
  });

  test('extra sources are merged in date order', async () => {
    follows.set('fan', ['badadib']);
    await insertEvent('badadib', 'now', 5, 0);
    const extra = async ({ user }) => [{ id: `x:${user}`, type: 'test', actor: 'badadib', title: 't', url: '/', thumbnail: null, at: new Date().toISOString() }];
    notifyRouter.addSource(extra);
    try {
      const res = await request(app).post('/notify/feed').send(vouch('fan')).expect(200);
      expect(res.body.notifications.map((n) => n.type)).toEqual(['test', 'live']);
    } finally {
      notifyRouter.SOURCES.splice(notifyRouter.SOURCES.indexOf(extra), 1);
    }
  });

  test('a follow list that fails reads as following nobody', async () => {
    hive.getFollowingList.mockRejectedValue(new Error('down'));
    const res = await request(app).post('/notify/feed').send(vouch('fan')).expect(200);
    expect(res.body.notifications).toEqual([]);
  });
});
