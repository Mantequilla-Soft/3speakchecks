/**
 * Premiere reminders as notifications (services/premiereNotify.js): a started
 * premiere a viewer asked to be reminded of shows in their bell feed, and the job
 * pushes it to them once. Real test MongoDB; the vouch check, the following list
 * and web push are stand-ins.
 */
jest.mock('../utils/hiveAuth', () => ({
  verifyHiveAuthority: jest.fn(async () => ({ ok: false })),
  verifyDelegateVouch: jest.fn(async ({ signature }) => ({ ok: signature === 'good' })),
}));
jest.mock('../utils/hive', () => ({ getFollowingList: jest.fn(async () => []) }));
jest.mock('../utils/webPush', () => ({
  isConfigured: jest.fn(() => true),
  listSubscribers: jest.fn(async () => []),
  getPrefs: jest.fn(async () => ({})),
  sendToUser: jest.fn(async () => ({ sent: 1 })),
}));
const request = require('supertest');
const testDb = require('./helpers/db');
const { buildApp } = require('./helpers/app');
const { pinClock, NOW } = require('./routes-misc/_fixtures');
const push = require('../utils/webPush');
const premieres = require('../services/premieres');
const premiereNotify = require('../services/premiereNotify');

const db = testDb.use();
// Mounting the premieres router registers its bell source.
const app = buildApp(['/premieres', require('../routes/premieres')], ['/', require('../routes/notify')]);

const MIN = 60 * 1000;
const at = (ms) => new Date(NOW.getTime() + ms);
const vouch = (user) => ({ user, signature: 'good', timestamp: Date.now() });

const seed = (permlink, startIn) => db().collection('scheduled-posts').insertOne({
  owner: 'badadib', permlink, status: 'posted', scheduledOn: at(startIn), title: `Premiere ${permlink}`,
  thumbnail: 'https://img.example/t.jpg', embedPermlink: `asset-${permlink}`, premiere: true, createdAt: NOW, updatedAt: NOW,
});
const remind = (user, permlink) => request(app).post(`/premieres/badadib/${permlink}/remind`).send({ ...vouch(user), on: true });

beforeEach(() => { pinClock(); premieres.clearCache(); push.sendToUser.mockClear(); });
afterEach(() => jest.useRealTimers());

test('a started premiere the viewer asked about is in their bell; one still to come is not', async () => {
  await seed('now', -2 * MIN);
  await seed('later', 60 * MIN);
  await db().collection('embed-video').insertMany([
    { owner: 'badadib', permlink: 'asset-now', duration: 600, status: 'published' },
    { owner: 'badadib', permlink: 'asset-later', duration: 600, status: 'published' },
  ]);
  // Reminders are only taken before the start, so the started one is stored directly.
  await db().collection('premiere_reminders').insertOne({ user: 'fan', owner: 'badadib', permlink: 'now', at: at(-10 * MIN), expireAt: at(24 * 60 * MIN) });
  await remind('fan', 'later').expect((r) => expect(r.status).toBeLessThan(300));

  const res = await request(app).post('/notify/feed').send(vouch('fan')).expect(200);
  expect(res.body.notifications).toEqual([expect.objectContaining({
    id: 'premiere:badadib/now', type: 'premiere', actor: 'badadib', title: 'Premiere now',
    url: '/watch?v=badadib/now', at: at(-2 * MIN).toISOString(), live: true,
  })]);
  const other = await request(app).post('/notify/feed').send(vouch('someone')).expect(200);
  expect(other.body.notifications).toEqual([]);
});

test('the job pushes a started premiere once to each viewer who asked', async () => {
  await seed('now', -2 * MIN);
  await db().collection('premiere_reminders').insertMany([
    { user: 'fan', owner: 'badadib', permlink: 'now', at: at(-10 * MIN), expireAt: at(24 * 60 * MIN) },
    { user: 'other', owner: 'badadib', permlink: 'now', at: at(-10 * MIN), expireAt: at(24 * 60 * MIN) },
  ]);
  const first = await premiereNotify.runOnce({ now: NOW.getTime() });
  expect(first).toEqual({ due: 2, sent: 2 });
  expect(push.sendToUser).toHaveBeenCalledWith('fan', expect.objectContaining({
    title: "@badadib's premiere has started", body: 'Premiere now', url: '/watch?v=badadib/now',
  }));
  const again = await premiereNotify.runOnce({ now: NOW.getTime() });
  expect(again).toEqual({ due: 0, sent: 0 });
  expect(push.sendToUser).toHaveBeenCalledTimes(2);
});
