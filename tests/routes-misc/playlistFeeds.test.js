/**
 * Outside podcast shows inside 3Speak playlists (utils/playlistFeeds.js):
 * reading them from a playlist, the sync that keeps them polled
 * (services/podcastFeeds.js syncPlaylistFeeds + gc), and the two routes the
 * playlist page uses, POST /podcasts/bundle and the signed POST /podcasts/resolve.
 *
 * Real MongoDB; the feed worker and the directories are stand-ins.
 */
jest.spyOn(console, 'warn').mockImplementation(() => {});

const crypto = require('crypto');
const request = require('supertest');
const { ObjectId } = require('mongodb');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const { hiveAccount, fakeHiveChain } = require('../helpers/hive');
const { NOW, pinClock } = require('./_fixtures');

jest.mock('../../utils/podcastDirectories', () => ({
  ...jest.requireActual('../../utils/podcastDirectories'),
  resolveLink: jest.fn(async (url) => ({ url })),
  discoverFeed: jest.fn(async () => null),
}));
const directories = require('../../utils/podcastDirectories');
const podcastFeeds = require('../../services/podcastFeeds');
const { feedRefs, playlistFeedRefs, threeSpeakRef, MAX_PLAYLIST_FEEDS } = require('../../utils/playlistFeeds');

const app = buildApp(['/podcasts', require('../../routes/podcasts')]);
const db = testDb.use();

beforeAll(async () => {
  await db().collection('podcast_feeds').createIndex({ url_key: 1 }, { unique: true });
});

const threespeak = hiveAccount('threespeak');
const alice = hiveAccount('alice');
const message = (action, user, payload, ts) => ['3speak-podcasts', action, user, payload, String(ts)].join('|');
const digest = (urls) => crypto.createHash('sha256').update(urls.join('\n'), 'utf8').digest('hex');
const vouch = (user, url, ts = Date.now()) => ({ user, url, timestamp: ts, signature: threespeak.sign(message('resolve-vouch', user, digest([url]), ts)) });

const FEED_A = new ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa');
const FEED_B = new ObjectId('bbbbbbbbbbbbbbbbbbbbbbbb');
const hours = (n) => new Date(NOW.getTime() - n * 3600 * 1000);
const feedDoc = (id, extra = {}) => ({
  _id: id, url: `https://feeds.example.com/${id.toHexString()}.xml`, url_key: `feeds.example.com/${id.toHexString()}.xml`,
  alt_keys: [], title: `Show ${id.toHexString().slice(0, 1)}`, author: 'Host', status: 'ok', subscribers: 0,
  last_ok_at: hours(1), created_at: hours(24 * 60), ...extra,
});
const urlOf = (id) => `https://feeds.example.com/${id.toHexString()}.xml`;
const episode = (feed, n, publishedHoursAgo, extra = {}) => ({
  _id: `${feed.toHexString()}:${String(n).padStart(16, 'x')}`, feed_id: feed, title: `${feed.toHexString().slice(0, 1)}${n}`,
  audio_url: `https://cdn.example.com/${n}.mp3`, mime: 'audio/mpeg', published_at: hours(publishedHoursAgo), ...extra,
});
const playlistDoc = (id, feeds, extra = {}) => ({
  _id: id, owner: 'alice', name: id, access: 'public', items: [],
  json_metadata: JSON.stringify(JSON.stringify({ tags: [], feeds })), ...extra,
});

beforeEach(() => {
  pinClock();
  fakeHiveChain([threespeak, alice]);
  jest.spyOn(podcastFeeds, 'enabled').mockReturnValue(true);
  jest.spyOn(podcastFeeds, 'ask').mockResolvedValue({ ok: false, code: 'unavailable' });
  directories.resolveLink.mockClear();
  directories.discoverFeed.mockClear();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.useRealTimers());

// ─── Reading a playlist's shows ───────────────────────────────────────────────

describe('which shows a playlist names', () => {
  test('valid http(s) URLs only, once each, never with a password, at most the cap', () => {
    const many = Array.from({ length: MAX_PLAYLIST_FEEDS + 5 }, (_, i) => `https://f.example.com/${i}`);
    expect(feedRefs(many)).toHaveLength(MAX_PLAYLIST_FEEDS);
    expect(feedRefs([
      { url: 'https://www.feeds.example.com/a/' },
      'http://feeds.example.com/a',
      { url: 'https://user:pass@feeds.example.com/private' },
      'ftp://feeds.example.com/x',
      'not a url',
      { url: `https://e.com/${'x'.repeat(2100)}` },
      null,
    ])).toEqual([{ url: 'https://www.feeds.example.com/a/', key: 'feeds.example.com/a' }]);
  });

  test('from the playlist doc (double-encoded json_metadata), leaving out its own feed', () => {
    const p = playlistDoc('pl-1234-abcd', [{ url: urlOf(FEED_A) }, { url: 'https://3speak.tv/rss/playlist/pl-1234-abcd.xml' }]);
    expect(playlistFeedRefs(p).map((r) => r.url)).toEqual([urlOf(FEED_A)]);
    expect(playlistFeedRefs({ _id: 'x', json_metadata: 'garbage' })).toEqual([]);
    expect(playlistFeedRefs(null)).toEqual([]);
  });

  test('a 3Speak post link is recognised in both forms', () => {
    expect(threeSpeakRef('https://3speak.tv/watch?v=Bob/day-1')).toBe('bob/day-1');
    expect(threeSpeakRef('https://www.3speak.tv/@bob/day-1')).toBe('bob/day-1');
    expect(threeSpeakRef('https://example.com/@bob/day-1')).toBe('');
    expect(threeSpeakRef('')).toBe('');
  });
});

// ─── Keeping them polled ──────────────────────────────────────────────────────

describe('syncPlaylistFeeds and the gc', () => {
  const feeds = () => db().collection('podcast_feeds');

  test('counts playlists per show, adds rows for new URLs, skips 3Speak channel feeds', async () => {
    await feeds().insertOne(feedDoc(FEED_A, { alt_keys: ['old.example.com/a'], orphaned_at: hours(1) }));
    await db().collection('playlists').insertMany([
      playlistDoc('pl-1', [{ url: urlOf(FEED_A) }, { url: 'https://new.example.com/feed.xml' }]),
      // Same show by its old address: still one show, counted twice.
      playlistDoc('pl-2', [{ url: 'https://old.example.com/a' }, { url: 'https://3speak.tv/rss/bob.xml' }]),
      { _id: 'pl-3', owner: 'bob', items: [] },
    ]);
    const r = await podcastFeeds.syncPlaylistFeeds();
    expect(r).toEqual({ shows: 2, created: 1 });

    const a = await feeds().findOne({ _id: FEED_A });
    expect(a.playlist_refs).toBe(2);
    expect(a.orphaned_at).toBeUndefined();
    const fresh = await feeds().findOne({ url_key: 'new.example.com/feed.xml' });
    expect(fresh).toMatchObject({ url: 'https://new.example.com/feed.xml', status: 'pending', subscribers: 0, playlist_refs: 1 });
    expect(await feeds().countDocuments({ url_key: /3speak/ })).toBe(0);

    // Run again: nothing new.
    expect(await podcastFeeds.syncPlaylistFeeds()).toEqual({ shows: 2, created: 0 });
  });

  test('a show no playlist names any more starts the grace week (followed ones keep going)', async () => {
    await feeds().insertMany([
      feedDoc(FEED_A, { playlist_refs: 3 }),
      feedDoc(FEED_B, { playlist_refs: 1, subscribers: 2 }),
    ]);
    await podcastFeeds.syncPlaylistFeeds();
    const a = await feeds().findOne({ _id: FEED_A });
    expect(a.playlist_refs).toBe(0);
    expect(a.orphaned_at).toEqual(NOW);
    const b = await feeds().findOne({ _id: FEED_B });
    expect(b.playlist_refs).toBe(0);
    expect(b.orphaned_at).toBeUndefined();
  });

  test('the gc keeps a show a playlist names, even nobody follows it', async () => {
    await feeds().insertMany([
      feedDoc(FEED_A, { playlist_refs: 1, orphaned_at: hours(24 * 30) }),
      feedDoc(FEED_B, { orphaned_at: hours(24 * 30) }),
    ]);
    await db().collection('podcast_episodes').insertMany([episode(FEED_A, 1, 1), episode(FEED_B, 1, 1)]);
    await podcastFeeds._test.gc();
    expect((await feeds().find().toArray()).map((f) => f._id.toHexString())).toEqual([FEED_A.toHexString()]);
    expect(await db().collection('podcast_episodes').countDocuments()).toBe(1);
  });
});

// ─── POST /podcasts/bundle ────────────────────────────────────────────────────

describe('POST /podcasts/bundle', () => {
  const bundle = (body) => request(app).post('/podcasts/bundle').send(body);

  beforeEach(async () => {
    await db().collection('podcast_feeds').insertMany([
      feedDoc(FEED_A, { alt_keys: ['old.example.com/a'] }),
      feedDoc(FEED_B, { image: 'https://cdn.example.com/b.jpg' }),
      feedDoc(new ObjectId('cccccccccccccccccccccccc'), { url_key: 'secret.example.com/feed', private: true }),
    ]);
    await db().collection('podcast_episodes').insertMany([
      episode(FEED_A, 1, 1), episode(FEED_A, 2, 5), episode(FEED_A, 3, 9),
      episode(FEED_B, 1, 3), episode(FEED_B, 2, 5), episode(FEED_B, 3, 7),
    ]);
  });

  test('the shows in the playlist\'s order and their episodes newest first, paged by cursor', async () => {
    const urls = [urlOf(FEED_B), 'https://old.example.com/a', 'https://secret.example.com/feed', 'https://later.example.com/x'];
    const first = await bundle({ urls, limit: 3 }).expect(200);
    expect(first.body.feeds.map((f) => f.title)).toEqual(['Show b', 'Show a']);
    expect(first.body.feeds[0].url).toBe(urlOf(FEED_B));
    expect(first.body.episodes.map((e) => e.title)).toEqual(['a1', 'b1', 'b2']);
    expect(first.body.total).toBe(6);
    // A private row never answers a public URL; an unknown one is reported.
    expect(first.body.missing).toEqual(['https://secret.example.com/feed', 'https://later.example.com/x']);
    expect(first.body.next_cursor).toMatch(/\|/);

    // a2 has the same date as b2: the episode id breaks the tie, nothing is skipped.
    const second = await bundle({ urls, limit: 3, cursor: first.body.next_cursor }).expect(200);
    expect(second.body.episodes.map((e) => e.title)).toEqual(['a2', 'b3', 'a3']);
    expect(second.body.total).toBeUndefined();
    const third = await bundle({ urls, limit: 3, cursor: second.body.next_cursor }).expect(200);
    expect(third.body.episodes).toEqual([]);
    expect(third.body.next_cursor).toBeNull();
  });

  test('no shows: an empty answer; bad input: 400', async () => {
    const empty = await bundle({ urls: [] }).expect(200);
    expect(empty.body).toMatchObject({ feeds: [], episodes: [], missing: [], next_cursor: null });
    await bundle({ urls: 'nope' }).expect(400);
    await bundle({ urls: Array.from({ length: 60 }, (_, i) => `https://e.com/${i}`) }).expect(400);
    await bundle({ urls: [urlOf(FEED_A)], cursor: 'x|y' }).expect(400);
  });
});

// ─── POST /podcasts/resolve ───────────────────────────────────────────────────

describe('POST /podcasts/resolve', () => {
  const resolve = (body) => request(app).post('/podcasts/resolve').send(body);

  test('needs a signature for that URL', async () => {
    const res = await resolve({ user: 'alice', url: urlOf(FEED_A) }).expect(401);
    expect(res.body.expected_message).toContain('3speak-podcasts|resolve|alice|');
    const other = vouch('alice', 'https://other.example.com/feed');
    await resolve({ ...other, url: urlOf(FEED_A) }).expect(401);
  });

  test('a show we already read: answered from Mongo, nobody follows it', async () => {
    await db().collection('podcast_feeds').insertOne(feedDoc(FEED_A));
    const res = await resolve(vouch('alice', urlOf(FEED_A))).expect(200);
    expect(res.body).toMatchObject({ success: true, feed: { id: FEED_A.toHexString(), url: urlOf(FEED_A), title: 'Show a' } });
    expect(podcastFeeds.ask).not.toHaveBeenCalled();
    expect(await db().collection('podcast_subs').countDocuments()).toBe(0);
  });

  test('a new URL is fetched by the worker; a failure comes back as its code', async () => {
    podcastFeeds.ask.mockImplementationOnce(async () => {
      await db().collection('podcast_feeds').insertOne(feedDoc(FEED_B, { url: 'https://new.example.com/feed', url_key: 'new.example.com/feed' }));
      return { ok: true, feed_id: FEED_B.toHexString() };
    });
    const ok = await resolve(vouch('alice', 'https://new.example.com/feed')).expect(200);
    expect(ok.body.feed).toMatchObject({ id: FEED_B.toHexString(), url: 'https://new.example.com/feed' });
    expect(podcastFeeds.ask).toHaveBeenCalledWith('probe', { url: 'https://new.example.com/feed' }, expect.any(Number));

    podcastFeeds.ask.mockResolvedValueOnce({ ok: false, code: 'http_404' });
    const bad = await resolve(vouch('alice', 'https://gone.example.com/feed')).expect(200);
    expect(bad.body).toEqual({ success: false, code: 'http_404' });
  });

  test('a show\'s website leads to its feed', async () => {
    podcastFeeds.ask
      .mockResolvedValueOnce({ ok: false, code: 'not_a_podcast' })
      .mockImplementationOnce(async () => {
        await db().collection('podcast_feeds').insertOne(feedDoc(FEED_B, { url: 'https://site.example.com/rss', url_key: 'site.example.com/rss' }));
        return { ok: true, feed_id: FEED_B.toHexString() };
      });
    directories.discoverFeed.mockResolvedValueOnce('https://site.example.com/rss');
    const res = await resolve(vouch('alice', 'https://site.example.com/')).expect(200);
    expect(res.body.feed.url).toBe('https://site.example.com/rss');
  });

  test('refuses passwords, 3Speak channel feeds and closed platforms without fetching', async () => {
    expect((await resolve(vouch('alice', 'https://u:p@feeds.example.com/x')).expect(200)).body).toEqual({ success: false, code: 'private_feed' });
    expect((await resolve(vouch('alice', 'https://3speak.tv/rss/bob.xml')).expect(200)).body).toEqual({ success: false, code: 'internal_feed', owner: 'bob' });
    directories.resolveLink.mockResolvedValueOnce({ code: 'closed_platform', platform: 'Spotify' });
    expect((await resolve(vouch('alice', 'https://open.spotify.com/show/x')).expect(200)).body).toEqual({ success: false, code: 'closed_platform', platform: 'Spotify' });
    expect((await resolve(vouch('alice', 'http://127.0.0.1/feed')).expect(200)).body).toEqual({ success: false, code: 'blocked_address' });
    expect(podcastFeeds.ask).not.toHaveBeenCalled();
  });
});
