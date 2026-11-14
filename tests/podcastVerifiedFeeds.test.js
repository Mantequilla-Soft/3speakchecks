/**
 * GET /podcasts/verified: the shows a Hive user proved they publish (a verified
 * `rss` social link), for the podcast import. Real Mongo; the feed worker is a
 * stand-in, so nothing is fetched.
 */
const request = require('supertest');
const { ObjectId } = require('mongodb');
const testDb = require('./helpers/db');
const { buildApp } = require('./helpers/app');
const podcastFeeds = require('../services/podcastFeeds');
const { getLinksCollection } = require('../utils/db');
const router = require('../routes/podcasts');

const db = testDb.use();
const app = buildApp(['/podcasts', router]);
const { FEEDS, EPISODES } = podcastFeeds.collections;

const MIN = 60 * 1000;
const ago = (ms) => new Date(Date.now() - ms);

let ask;
beforeEach(() => {
  jest.spyOn(podcastFeeds, 'enabled').mockReturnValue(true);
  ask = jest.spyOn(podcastFeeds, 'ask').mockResolvedValue({ ok: false, code: 'unreachable' });
});
afterEach(() => jest.restoreAllMocks());

const link = (over = {}) => getLinksCollection().insertOne({
  hive_username: 'alice', platform: 'rss', platform_username: 'https://example.com/feed.xml',
  verified: true, verified_at: new Date(), hash: 'x', ...over,
});
const feedRow = async (over = {}) => {
  const doc = { url: 'https://example.com/feed.xml', url_key: 'example.com/feed.xml', alt_keys: [], title: 'My Show', status: 'ok', subscribers: 0, last_ok_at: new Date(), last_fetch_at: new Date(), created_at: new Date(), ...over };
  const { insertedId } = await db().collection(FEEDS).insertOne(doc);
  return insertedId;
};
const get = (user = 'alice') => request(app).get('/podcasts/verified').query({ user });

describe('GET /podcasts/verified', () => {
  test('answers the verified show with its feed row, and marks the row as in use', async () => {
    await link();
    const id = await feedRow();
    const res = await get('@Alice').expect(200);
    expect(res.body.user).toBe('alice');
    expect(res.body.feeds).toHaveLength(1);
    expect(res.body.feeds[0]).toMatchObject({ url: 'https://example.com/feed.xml', feed: { id: id.toHexString(), title: 'My Show' } });
    expect(ask).not.toHaveBeenCalled();
    expect((await db().collection(FEEDS).findOne({ _id: id })).verified_seen_at).toBeInstanceOf(Date);
  });

  test('leaves out pending links and other people\'s and other platforms\'', async () => {
    await link({ verified: false });
    await link({ hive_username: 'bob' });
    await link({ platform: 'youtube', platform_username: 'UCabc' });
    await feedRow();
    expect((await get().expect(200)).body.feeds).toEqual([]);
  });

  test('a show we have no row for is fetched now, exactly the verified URL', async () => {
    await link();
    const id = new ObjectId();
    ask.mockImplementation(async (type, payload) => {
      await db().collection(FEEDS).insertOne({ _id: id, url: payload.url, url_key: 'example.com/feed.xml', title: 'Fresh', status: 'ok', subscribers: 0, last_ok_at: new Date() });
      return { ok: true, feed_id: id.toHexString() };
    });
    const res = await get().expect(200);
    expect(ask).toHaveBeenCalledWith('probe', expect.objectContaining({ url: 'https://example.com/feed.xml' }), expect.any(Number));
    expect(res.body.feeds[0].feed).toMatchObject({ id: id.toHexString(), title: 'Fresh' });
  });

  test('a show nobody follows is re-read once it is stale; a followed one is left to the poller', async () => {
    await link();
    await feedRow({ last_fetch_at: ago(30 * MIN) });
    ask.mockImplementation(async () => ({ ok: true, feed_id: (await db().collection(FEEDS).findOne({}))._id.toHexString() }));
    await get().expect(200);
    expect(ask).toHaveBeenCalledWith('probe', expect.objectContaining({ fresh_ms: 10 * MIN }), expect.any(Number));

    ask.mockClear();
    await db().collection(FEEDS).updateOne({}, { $set: { subscribers: 3 } });
    await get().expect(200);
    expect(ask).not.toHaveBeenCalled();
  });

  test('a failed re-read still answers with the stored show', async () => {
    await link();
    const id = await feedRow({ last_fetch_at: ago(30 * MIN) });
    const res = await get().expect(200);
    expect(res.body.feeds[0].feed.id).toBe(id.toHexString());
  });

  test('a show that cannot be read says why, without a feed', async () => {
    await link();
    ask.mockResolvedValue({ ok: false, code: 'not_a_podcast' });
    const res = await get().expect(200);
    expect(res.body.feeds[0]).toMatchObject({ url: 'https://example.com/feed.xml', code: 'not_a_podcast' });
    expect(res.body.feeds[0].feed).toBeUndefined();
  });

  test('a 3Speak channel feed is not an outside show', async () => {
    await link({ platform_username: 'https://3speak.tv/rss/alice.xml' });
    const res = await get().expect(200);
    expect(res.body.feeds[0].code).toBe('internal_feed');
    expect(ask).not.toHaveBeenCalled();
  });

  test('a bad user name is refused; switched off answers 503', async () => {
    await get('a b').expect(400);
    podcastFeeds.enabled.mockReturnValue(false);
    await get().expect(503);
  });
});

describe('clean-up keeps a show in use by the import', () => {
  test('an unfollowed verified show survives gc while recently used, goes when not', async () => {
    const old = ago(3 * 24 * 60 * MIN);
    const used = await feedRow({ created_at: old, verified_seen_at: ago(60 * MIN) });
    const idle = await feedRow({ url_key: 'example.com/other', created_at: old, verified_seen_at: ago(8 * 24 * 60 * MIN) });
    const plain = await feedRow({ url_key: 'example.com/third', created_at: old });
    await db().collection(EPISODES).insertOne({ _id: `${used.toHexString()}:aaaaaaaaaaaaaaaa`, feed_id: used });
    await podcastFeeds._test.gc();
    const left = (await db().collection(FEEDS).find({}).toArray()).map((f) => f._id.toHexString());
    expect(left).toEqual([used.toHexString()]);
    expect(left).not.toContain(idle.toHexString());
    expect(left).not.toContain(plain.toHexString());
    expect(await db().collection(EPISODES).countDocuments({ feed_id: used })).toBe(1);
  });
});
