/**
 * Collab posts: a published post names collaborators in its json_metadata; the
 * checker reads that back from Hive (routes/collabs.js) and opens pending
 * invites; the co-creator answers with the session vouch. Only accepted collabs
 * reach the co-creator's channel (/api/my-videos), the Follow feed of their
 * followers (utils/followFeed.js) and "with x" on the cards; pending ones are in
 * the co-creator's bell feed. Vouch and following lists are stand-ins; the Hive
 * read is the fake chain; Mongo is the test database.
 */
jest.mock('../../utils/hiveAuth', () => ({
  verifyHiveAuthority: jest.fn(async () => ({ ok: false })),
  verifyDelegateVouch: jest.fn(async ({ signature }) => ({ ok: signature === 'good' })),
}));
jest.mock('../../utils/hive', () => require('../feeds/_hiveMock').create());
jest.mock('../../utils/incubationHosted', () => ({ followingOf: async () => [] }));

const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const { fakeHiveChain } = require('../helpers/hive');
const F = require('../feeds/_fixtures');
const hive = require('../../utils/hive');
const collabs = require('../../routes/collabs');

const db = testDb.use();
const app = buildApp(['/', collabs], ['/', require('../../routes/notify')], ['/', require('../../routes/user')], ['/', require('../../routes/videos')]);
const vouch = (user) => ({ user, signature: 'good', timestamp: Date.now() });

const chainPost = (meta = {}, over = {}) => ({
  author: 'badadib', permlink: 'hive-asset-1', title: 'Our video', body: 'b', created: '2026-11-01T11:00:00',
  json_metadata: JSON.stringify({ app: '3speak/embed', ...meta }),
  beneficiaries: [{ account: 'fan', weight: 4450 }, { account: 'threespeakfund', weight: 1000 }],
  ...over,
});
const register = () => request(app).post('/collabs/register').send({ author: 'badadib', permlink: 'hive-asset-1' });

beforeEach(async () => {
  F.pinClock();
  hive.__reset();
  await F.resetFeedCaches(db());
});
afterEach(() => jest.useRealTimers());

describe('collaboratorsIn', () => {
  test('valid, distinct, not the author, at most three', () => {
    expect(collabs.collaboratorsIn({ collaborators: ['@Fan', 'fan', 'badadib', 'no way', 'a1b', 'c2d', 'e3f'] }, 'badadib'))
      .toEqual(['fan', 'a1b', 'c2d']);
    expect(collabs.collaboratorsIn({}, 'badadib')).toEqual([]);
  });
});

describe('register and respond', () => {
  test('a post naming a collaborator opens a pending invite with its beneficiary weight', async () => {
    fakeHiveChain([], { get_content: () => chainPost({ collaborators: ['fan'] }) });
    const res = await register().expect(200);
    expect(res.body.collaborators).toEqual(['fan']);
    expect(await db().collection('collabs').findOne({ _id: 'badadib/hive-asset-1|fan' }))
      .toMatchObject({ status: 'pending', author: 'badadib', collaborator: 'fan', weight: 4450, title: 'Our video' });
  });

  test('not a 3Speak post, unknown post, bad input', async () => {
    fakeHiveChain([], { get_content: () => chainPost({ app: 'peakd/1', collaborators: ['fan'] }) });
    await register().expect(400);
    fakeHiveChain([], { get_content: () => ({ author: '', permlink: '' }) });
    jest.useRealTimers();
    await register().expect(404);
    await request(app).post('/collabs/register').send({ author: 'x', permlink: 'p' }).expect(400);
  }, 15000);

  test('accept with a vouch; re-registering keeps the answer; leaving is a decline', async () => {
    fakeHiveChain([], { get_content: () => chainPost({ collaborators: ['fan'] }) });
    await register().expect(200);
    await request(app).post('/collabs/respond').send({ user: 'fan', signature: 'bad', timestamp: Date.now(), author: 'badadib', permlink: 'hive-asset-1', accept: true }).expect(401);
    await request(app).post('/collabs/respond').send({ ...vouch('other'), author: 'badadib', permlink: 'hive-asset-1', accept: true }).expect(404);
    await request(app).post('/collabs/respond').send({ ...vouch('fan'), author: 'badadib', permlink: 'hive-asset-1', accept: true }).expect(200);
    await register().expect(200);
    let mine = await request(app).post('/collabs/mine').send(vouch('fan')).expect(200);
    expect(mine.body.invites).toEqual([expect.objectContaining({ author: 'badadib', status: 'accepted' })]);
    expect((await request(app).get('/collabs/post/badadib/hive-asset-1')).body.collaborators).toEqual([{ account: 'fan', weight: 4450 }]);

    await request(app).post('/collabs/respond').send({ ...vouch('fan'), author: 'badadib', permlink: 'hive-asset-1', accept: false }).expect(200);
    mine = await request(app).post('/collabs/mine').send(vouch('fan')).expect(200);
    expect(mine.body.invites).toEqual([]);
    expect((await request(app).get('/collabs/post/badadib/hive-asset-1')).body.collaborators).toEqual([]);
  });

  test('a pending invite is in the co-creator\'s bell feed, unless the inviter is Off', async () => {
    fakeHiveChain([], { get_content: () => chainPost({ collaborators: ['fan'] }) });
    await register().expect(200);
    let res = await request(app).post('/notify/feed').send(vouch('fan')).expect(200);
    expect(res.body.notifications).toEqual([expect.objectContaining({
      type: 'collab_invite', actor: 'badadib', author: 'badadib', permlink: 'hive-asset-1', title: 'Our video',
    })]);
    await request(app).post('/notify/level').send({ ...vouch('fan'), creator: 'badadib', level: 'off' }).expect(200);
    res = await request(app).post('/notify/feed').send(vouch('fan')).expect(200);
    expect(res.body.notifications).toEqual([]);
  });
});

describe('accepted collabs in the feeds', () => {
  beforeEach(async () => {
    await db().collection('embed-video').insertMany([
      F.embedVideo({ owner: 'badadib', permlink: 'asset-1', createdAt: F.hoursAgo(2) }),
      F.embedVideo({ owner: 'badadib', permlink: 'asset-2', createdAt: F.hoursAgo(3) }),
      F.embedVideo({ owner: 'fan', permlink: 'asset-own', createdAt: F.hoursAgo(4) }),
    ]);
    await db().collection('collabs').insertMany([
      { _id: 'badadib/hive-asset-1|fan', author: 'badadib', permlink: 'hive-asset-1', collaborator: 'fan', status: 'accepted', created_at: F.hoursAgo(2) },
      { _id: 'badadib/hive-asset-2|fan', author: 'badadib', permlink: 'hive-asset-2', collaborator: 'fan', status: 'pending', created_at: F.hoursAgo(3) },
    ]);
  });

  test('the co-creator\'s channel lists the accepted collab, with both names', async () => {
    const res = await request(app).get('/api/my-videos').query({ username: 'fan', status: 'published' }).expect(200);
    const vids = res.body.data.videos;
    expect(vids.map((v) => v.permlink)).toEqual(['hive-asset-1', 'hive-asset-own']);
    expect(vids[0]).toMatchObject({ author: 'badadib', collaborators: ['fan'] });
    expect(vids[1].collaborators).toBeUndefined();
  });

  test('the author\'s own channel shows the collaborator on the card', async () => {
    const res = await request(app).get('/api/my-videos').query({ username: 'badadib', status: 'published' }).expect(200);
    expect(res.body.data.videos.find((v) => v.permlink === 'hive-asset-1').collaborators).toEqual(['fan']);
  });

  test('followers of the co-creator get the accepted collab in their Follow feed', async () => {
    hive.__state.following.set('viewer', ['fan']);
    const res = await request(app).get('/feed/viewer').expect(200);
    expect(res.body.videos.map((v) => v.permlink).sort()).toEqual(['hive-asset-1', 'hive-asset-own']);
    expect(res.body.videos.find((v) => v.permlink === 'hive-asset-1').collaborators).toEqual(['fan']);
  });
});
