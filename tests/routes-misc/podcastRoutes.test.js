/**
 * routes/podcasts.js against real MongoDB and real Hive signatures (fake chain).
 *
 * tests/podcasts.test.js and tests/podcastPlayerFeatures.test.js cover parsing,
 * private feeds and the media endpoints with the signature check stubbed out.
 * This file proves the signature check itself (own key, @threespeak under a
 * posting grant, our vouch, and everything that must NOT pass), then the reads,
 * the directory endpoints and the follow lifecycle.
 *
 * The feed worker, the directories' HTTP calls and outbound fetches are stand-ins.
 */
process.env.PODCASTINDEX_API_KEY = 'test-pi-key';
process.env.PODCASTINDEX_API_SECRET = 'test-pi-secret';
process.env.PODCAST_MAX_FEEDS_PER_USER = '3';

// utils/webPush.js warns once at load that no VAPID keys are set; expected here.
jest.spyOn(console, 'warn').mockImplementation(() => {});

const crypto = require('crypto');
const request = require('supertest');
const { ObjectId } = require('mongodb');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const { hiveAccount, fakeHiveChain } = require('../helpers/hive');
const { NOW, pinClock, binaryParser } = require('./_fixtures');

jest.mock('../../utils/safeFetch', () => ({
  ...jest.requireActual('../../utils/safeFetch'),
  safeFetch: jest.fn(),
  safeStream: jest.fn(),
}));
jest.mock('../../utils/podcastArt', () => ({ ...jest.requireActual('../../utils/podcastArt'), renderArt: jest.fn() }));
const { safeFetch } = require('../../utils/safeFetch');
const { artToken, renderArt } = require('../../utils/podcastArt');
const podcastFeeds = require('../../services/podcastFeeds');
const { urlKey } = require('../../utils/podcastParse');

const app = buildApp(['/podcasts', require('../../routes/podcasts')]);
const db = testDb.use();

beforeAll(async () => {
  // The worker's unique index (services/podcastFeeds.js ensureIndexes).
  await db().collection('podcast_feeds').createIndex({ url_key: 1 }, { unique: true });
});

// ─── Accounts and signatures ──────────────────────────────────────────────────

const threespeak = hiveAccount('threespeak');
const peakd = hiveAccount('peakd.app');
const granted = (name) => hiveAccount(name, { postingDelegates: ['threespeak'] });
const ACCOUNTS = {
  alice: granted('alice'),
  bob: hiveAccount('bob'),                                         // no posting grants
  carol: hiveAccount('carol', { postingDelegates: ['peakd.app'] }), // a grant to someone we never sign as
  dave: granted('dave'),
  erin: granted('erin'),
  frank: granted('frank'),
  grace: granted('grace'),
  heidi: granted('heidi'),
  ivan: granted('ivan'),
  judy: granted('judy'),
  ken: granted('ken'),
};

const message = (action, user, payload, ts) => ['3speak-podcasts', action, user, payload, String(ts)].join('|');
const digest = (urls) => crypto.createHash('sha256').update(urls.join('\n'), 'utf8').digest('hex');

/** The body fields of a request signed by `signer` (an account) for `user`. */
const signed = (signer, action, user, payload, ts = Date.now()) => ({ user, timestamp: ts, signature: signer.sign(message(action, user, payload, ts)) });
const ownSig = (user, action, payload, ts) => signed(ACCOUNTS[user], action, user, payload, ts);
const vouchSig = (user, action, payload, ts) => signed(threespeak, `${action}-vouch`, user, payload, ts);
/** The query string of a progress/session vouch for private reads. */
const readerVouch = (user, ts = Date.now()) => `vu=${encodeURIComponent(user)}&vts=${ts}&vsig=${threespeak.sign(message('progress-vouch', user, 'session', ts))}`;
const progressVouch = (user, ts = Date.now()) => ({ user, timestamp: ts, signature: threespeak.sign(message('progress-vouch', user, 'session', ts)) });

// ─── Data ─────────────────────────────────────────────────────────────────────

const FEED_A = new ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa');
const FEED_B = new ObjectId('bbbbbbbbbbbbbbbbbbbbbbbb');
const FEED_P = new ObjectId('cccccccccccccccccccccccc');
const hours = (n) => new Date(NOW.getTime() - n * 3600 * 1000);
const epId = (feed, n) => `${feed.toHexString()}:${String(n).padStart(16, 'x')}`;

const feedDoc = (id, extra = {}) => ({
  _id: id, url: `https://feeds.example.com/${id.toHexString()}.xml`, url_key: `feeds.example.com/${id.toHexString()}.xml`,
  alt_keys: [], title: `Show ${id.toHexString().slice(0, 1)}`, author: 'Host', image: 'https://cdn.example.com/cover.jpg',
  status: 'ok', subscribers: 1, last_ok_at: hours(1), ...extra,
});
const episode = (feed, n, extra = {}) => ({
  _id: epId(feed, n), feed_id: feed, title: `Episode ${n}`, audio_url: `https://cdn.example.com/${n}.mp3`, mime: 'audio/mpeg',
  published_at: hours(n * 24), first_seen_at: hours(n * 24), ...extra,
});
const follow = (user, feed, extra = {}) => ({ _id: `${user}|${feed.toHexString()}`, user, feed_id: feed, added_at: hours(24 * 30), notify: true, ...extra });

// ─── Directory stand-in (global fetch) ────────────────────────────────────────

let directoryAnswers;
let fetchCalls;
function directories(answers) {
  directoryAnswers = answers;
}
const jsonResponse = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

let ipCounter = 0;
/** A fresh client address per test: the search limiter counts per listener. */
let ip;

beforeEach(() => {
  pinClock();
  fakeHiveChain([threespeak, peakd, ...Object.values(ACCOUNTS)]);
  jest.spyOn(podcastFeeds, 'enabled').mockReturnValue(true);
  jest.spyOn(podcastFeeds, 'ask').mockResolvedValue({ ok: false, code: 'unavailable' });
  safeFetch.mockReset();
  renderArt.mockReset();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  ipCounter += 1;
  ip = `203.0.113.${ipCounter}`;
  directoryAnswers = {};
  fetchCalls = [];
  jest.spyOn(global, 'fetch').mockImplementation(async (url, init = {}) => {
    const u = String(url);
    fetchCalls.push({ url: u, headers: init.headers || {} });
    for (const [needle, answer] of Object.entries(directoryAnswers)) {
      if (u.includes(needle)) return typeof answer === 'function' ? answer(u) : jsonResponse(answer);
    }
    return jsonResponse({}, 404);
  });
});
afterEach(() => jest.useRealTimers());

const unsubscribe = (body) => request(app).post('/podcasts/unsubscribe').send(body);

// ─── The signature check ──────────────────────────────────────────────────────

describe('who may write: the signature on unsubscribe, notify and subscribe', () => {
  const feedHex = FEED_A.toHexString();
  beforeEach(async () => {
    await db().collection('podcast_feeds').insertOne(feedDoc(FEED_A));
    await db().collection('podcast_subs').insertMany(Object.keys(ACCOUNTS).map((u) => follow(u, FEED_A)));
  });

  test('the account owner signing with their own posting key', async () => {
    const res = await unsubscribe({ feed_id: feedHex, ...ownSig('bob', 'unsubscribe', feedHex) }).expect(200);
    expect(res.body).toEqual({ success: true, removed: true });
    expect(await db().collection('podcast_subs').findOne({ _id: `bob|${feedHex}` })).toBeNull();
  });

  test('@threespeak signing for an account that granted it posting authority', async () => {
    const res = await unsubscribe({ feed_id: feedHex, ...signed(threespeak, 'unsubscribe', 'alice', feedHex) }).expect(200);
    expect(res.body.removed).toBe(true);
  });

  test("our vouch for a session we verified (no posting grant needed, warm-up '~' handles too)", async () => {
    await db().collection('podcast_subs').insertOne(follow('~newbie', FEED_A));
    expect((await unsubscribe({ feed_id: feedHex, ...vouchSig('bob', 'unsubscribe', feedHex) })).body.removed).toBe(true);
    expect((await unsubscribe({ feed_id: feedHex, ...vouchSig('~newbie', 'unsubscribe', feedHex) })).body.removed).toBe(true);
  });

  test('a missing signature is a 401 that names the message to sign', async () => {
    const res = await unsubscribe({ feed_id: feedHex, user: 'bob' }).expect(401);
    expect(res.body.expected_message).toBe(`3speak-podcasts|unsubscribe|bob|${feedHex}|<ms>`);
  });

  test.each([
    ['six minutes old', -6 * 60 * 1000],
    ['six minutes in the future', 6 * 60 * 1000],
  ])('a signature %s is refused', async (_label, offset) => {
    const res = await unsubscribe({ feed_id: feedHex, ...ownSig('bob', 'unsubscribe', feedHex, Date.now() + offset) }).expect(401);
    expect(res.body.error).toBe('timestamp out of tolerance');
  });

  test.each([
    ['another account\'s key', () => signed(ACCOUNTS.dave, 'unsubscribe', 'bob', feedHex)],
    ['@threespeak without a posting grant from the user', () => signed(threespeak, 'unsubscribe', 'bob', feedHex)],
    ['a delegate we never sign as (peakd.app), even with a grant', () => signed(peakd, 'unsubscribe', 'carol', feedHex)],
    ['the user\'s own key over a vouch message', () => signed(ACCOUNTS.bob, 'unsubscribe-vouch', 'bob', feedHex)],
    ['a vouch for another user', () => ({ ...vouchSig('dave', 'unsubscribe', feedHex), user: 'bob' })],
    ['a signature over another feed', () => ownSig('bob', 'unsubscribe', FEED_B.toHexString())],
    ['a signature for another action', () => ownSig('bob', 'notify', `${feedHex}:off`)],
    ['a signature with a different timestamp', () => ({ ...ownSig('bob', 'unsubscribe', feedHex), timestamp: Date.now() - 1000 })],
    ['garbage instead of a signature', () => ({ user: 'bob', timestamp: Date.now(), signature: 'not-a-signature' })],
  ])('refused (401): %s', async (_label, proof) => {
    const user = proof().user;
    const res = await unsubscribe({ feed_id: feedHex, ...proof() }).expect(401);
    expect(res.body.error).toBe('Invalid signature');
    expect(await db().collection('podcast_subs').findOne({ _id: `${user}|${feedHex}` })).not.toBeNull();
  });

  test("a '~' warm-up handle can only be vouched for, never sign itself", async () => {
    const res = await unsubscribe({ feed_id: feedHex, ...signed(ACCOUNTS.bob, 'unsubscribe', '~bob', feedHex) }).expect(401);
    expect(res.body.error).toBe('Invalid signature');
  });

  test('an account Hive does not know is a 401, not a crash', async () => {
    const ghost = hiveAccount('ghost');
    await unsubscribe({ feed_id: feedHex, ...signed(ghost, 'unsubscribe', 'ghost', feedHex) }).expect(401);
  });

  test.each([
    ['a malformed feed id', { feed_id: 'nope', user: 'bob' }],
    ['a malformed user', { feed_id: FEED_A.toHexString(), user: 'Bob Smith!', signature: 'x', timestamp: 1 }],
  ])('400 for %s', async (_label, body) => {
    await unsubscribe(body).expect(400);
  });

  test('a replayed unsubscribe inside the window removes nothing twice (no nonce: it is idempotent)', async () => {
    const proof = ownSig('dave', 'unsubscribe', feedHex);
    expect((await unsubscribe({ feed_id: feedHex, ...proof })).body.removed).toBe(true);
    expect((await unsubscribe({ feed_id: feedHex, ...proof })).body.removed).toBe(false);
    expect((await db().collection('podcast_feeds').findOne({ _id: FEED_A })).subscribers).toBe(0);
  });
});

// ─── Follow lifecycle ─────────────────────────────────────────────────────────

describe('POST /podcasts/subscribe', () => {
  const subscribe = (user, urls, extra = {}, proof = ownSig) => request(app).post('/podcasts/subscribe')
    .send({ urls, ...extra, ...proof(user, 'subscribe', digest(urls)) });

  test('503 while podcasts are switched off', async () => {
    podcastFeeds.enabled.mockReturnValue(false);
    const res = await subscribe('dave', ['https://feeds.example.com/x.xml']).expect(503);
    expect(res.body.code).toBe('disabled');
  });

  test.each([
    ['no URLs', []],
    ['more than 200 URLs', Array.from({ length: 201 }, (_, i) => `https://f.example.com/${i}`)],
    ['a URL over 2000 characters', [`https://f.example.com/${'x'.repeat(2001)}`]],
  ])('400 for %s', async (_label, urls) => {
    await request(app).post('/podcasts/subscribe').send({ urls, user: 'dave' }).expect(400);
  });

  test('the signature covers the URL list: signing other URLs is a 401', async () => {
    const proof = ownSig('dave', 'subscribe', digest(['https://other.example.com/feed']));
    await request(app).post('/podcasts/subscribe').send({ urls: ['https://feeds.example.com/x.xml'], ...proof }).expect(401);
  });

  test('one new URL is probed right away; the follow counts and names who added it', async () => {
    const id = new ObjectId();
    podcastFeeds.ask.mockImplementation(async (type, payload) => {
      await db().collection('podcast_feeds').insertOne({ _id: id, url: payload.url, url_key: urlKey(payload.url), status: 'ok', subscribers: 0, last_ok_at: new Date() });
      return { ok: true, feed_id: id.toHexString() };
    });
    const res = await subscribe('dave', ['https://feeds.example.com/new.xml']).expect(200);
    expect(res.body).toEqual({ success: true, results: [{ url: 'https://feeds.example.com/new.xml', ok: true, feed_id: id.toHexString() }] });
    expect(podcastFeeds.ask).toHaveBeenCalledWith('probe', { url: 'https://feeds.example.com/new.xml' }, expect.any(Number));
    const feed = await db().collection('podcast_feeds').findOne({ _id: id });
    expect(feed).toMatchObject({ subscribers: 1, added_by: 'dave', last_followed_at: NOW });
    expect(await db().collection('podcast_subs').findOne({ _id: `dave|${id.toHexString()}` }))
      .toMatchObject({ user: 'dave', notify: true, added_at: NOW });
  });

  test("a show's website: the feed its page announces is followed instead", async () => {
    const id = new ObjectId();
    podcastFeeds.ask
      .mockResolvedValueOnce({ ok: false, code: 'not_a_podcast' })
      .mockImplementationOnce(async (_t, { url }) => {
        await db().collection('podcast_feeds').insertOne({ _id: id, url, url_key: urlKey(url), status: 'ok', subscribers: 0 });
        return { ok: true, feed_id: id.toHexString() };
      });
    safeFetch.mockResolvedValue({
      url: 'https://show.example.com/', headers: { 'content-type': 'text/html' },
      body: Buffer.from('<link rel="alternate" type="application/rss+xml" href="/comments/feed"><link rel="alternate" type="application/rss+xml" href="/podcast.xml">'),
    });
    const res = await subscribe('erin', ['https://show.example.com/']).expect(200);
    expect(res.body.results[0]).toMatchObject({ ok: true, resolved_url: 'https://show.example.com/podcast.xml' });
  });

  test("a website announcing a 3Speak channel feed is pointed to the 3Speak tab", async () => {
    podcastFeeds.ask.mockResolvedValue({ ok: false, code: 'parse_error' });
    safeFetch.mockResolvedValue({
      url: 'https://blog.example.com/', headers: { 'content-type': 'text/html' },
      body: Buffer.from('<link rel="alternate" type="application/rss+xml" href="https://3speak.tv/rss/alice.xml">'),
    });
    const res = await subscribe('erin', ['https://blog.example.com/']).expect(200);
    expect(res.body).toEqual({ success: false, results: [{ url: 'https://blog.example.com/', code: 'internal_feed' }] });
  });

  test('a probe that fails says why and follows nothing', async () => {
    podcastFeeds.ask.mockResolvedValue({ ok: false, code: 'http_404' });
    const res = await subscribe('erin', ['https://feeds.example.com/gone.xml']).expect(200);
    expect(res.body).toEqual({ success: false, results: [{ url: 'https://feeds.example.com/gone.xml', code: 'http_404' }] });
    expect(await db().collection('podcast_subs').countDocuments({ user: 'erin' })).toBe(0);
  });

  test('a batch (OPML) is stored as pending rows with their titles, read later by the worker', async () => {
    const urls = ['https://a.example.com/feed', 'https://b.example.com/feed'];
    const res = await subscribe('frank', urls, { titles: ['  Show   A ', ''] }).expect(200);
    expect(res.body.results.map((r) => r.ok)).toEqual([true, true]);
    expect(podcastFeeds.ask).not.toHaveBeenCalled();
    const rows = await db().collection('podcast_feeds').find({}).sort({ url: 1 }).toArray();
    expect(rows.map((r) => [r.url_key, r.status, r.title, r.subscribers])).toEqual([
      ['a.example.com/feed', 'pending', 'Show A', 1],
      ['b.example.com/feed', 'pending', undefined, 1],
    ]);
  });

  test('following again, or a feed known under another address, is "already"', async () => {
    await db().collection('podcast_feeds').insertOne(feedDoc(FEED_A, { alt_keys: ['old.example.com/feed'] }));
    await db().collection('podcast_subs').insertOne(follow('grace', FEED_A));
    const res = await subscribe('grace', ['https://old.example.com/feed/']).expect(200);
    expect(res.body.results[0]).toMatchObject({ ok: true, already: true, feed_id: FEED_A.toHexString() });
    expect((await db().collection('podcast_feeds').findOne({ _id: FEED_A })).subscribers).toBe(1);
  });

  test('3Speak channel feeds, local addresses and closed platforms are refused per URL', async () => {
    const urls = ['https://3speak.tv/rss/alice.xml', 'http://127.0.0.1/feed', 'https://open.spotify.com/show/abc', 'file:///etc/passwd'];
    const res = await subscribe('heidi', urls).expect(200);
    expect(res.body.success).toBe(false);
    expect(res.body.results).toEqual([
      { url: urls[0], code: 'internal_feed', owner: 'alice' },
      { url: urls[1], code: expect.any(String) },
      { url: urls[2], code: 'closed_platform', platform: 'Spotify' },
      { url: urls[3], code: expect.any(String) },
    ]);
    expect(await db().collection('podcast_feeds').countDocuments()).toBe(0);
  });

  test('an Apple Podcasts link follows the feed Apple lists', async () => {
    directories({ 'itunes.apple.com/lookup': { results: [{ collectionId: 42, feedUrl: 'https://feeds.example.com/apple.xml' }] } });
    const res = await subscribe('heidi', ['https://podcasts.apple.com/us/podcast/x/id42', 'https://b.example.com/two']).expect(200);
    expect(res.body.results[0]).toMatchObject({ ok: true, resolved_url: 'https://feeds.example.com/apple.xml' });
    expect(await db().collection('podcast_feeds').findOne({ url_key: 'feeds.example.com/apple.xml' })).not.toBeNull();
  });

  test('a listener can follow at most PODCAST_MAX_FEEDS_PER_USER shows', async () => {
    const urls = ['https://1.example.com/f', 'https://2.example.com/f', 'https://3.example.com/f', 'https://4.example.com/f'];
    const res = await subscribe('ivan', urls).expect(200);
    expect(res.body.results.map((r) => r.code || 'ok')).toEqual(['ok', 'ok', 'ok', 'limit']);
    expect(await db().collection('podcast_subs').countDocuments({ user: 'ivan' })).toBe(3);
  });

  test('a vouch can follow for a warm-up listener', async () => {
    const res = await subscribe('~warm', ['https://x.example.com/f', 'https://y.example.com/f'], {}, vouchSig).expect(200);
    expect(res.body.success).toBe(true);
    expect(await db().collection('podcast_subs').countDocuments({ user: '~warm' })).toBe(2);
  });

  test('more than 60 changes an hour from one account is a 429', async () => {
    await db().collection('podcast_feeds').insertOne(feedDoc(FEED_A));
    const feedHex = FEED_A.toHexString();
    for (let i = 0; i < 60; i += 1) {
      await unsubscribe({ feed_id: feedHex, ...ownSig('judy', 'unsubscribe', feedHex) }).expect(200);
    }
    await unsubscribe({ feed_id: feedHex, ...ownSig('judy', 'unsubscribe', feedHex) }).expect(429);
  });
});

describe('POST /podcasts/unsubscribe and /notify', () => {
  const feedHex = FEED_A.toHexString();
  beforeEach(async () => {
    await db().collection('podcast_feeds').insertOne(feedDoc(FEED_A, { subscribers: 1 }));
    await db().collection('podcast_subs').insertOne(follow('ken', FEED_A));
  });

  test('the last listener leaving marks the show orphaned (collected after a grace week)', async () => {
    await unsubscribe({ feed_id: feedHex, ...ownSig('ken', 'unsubscribe', feedHex) }).expect(200);
    const feed = await db().collection('podcast_feeds').findOne({ _id: FEED_A });
    expect(feed).toMatchObject({ subscribers: 0, orphaned_at: NOW });
  });

  test('another listener staying keeps the show', async () => {
    await db().collection('podcast_feeds').updateOne({ _id: FEED_A }, { $set: { subscribers: 2 } });
    await unsubscribe({ feed_id: feedHex, ...ownSig('ken', 'unsubscribe', feedHex) }).expect(200);
    expect((await db().collection('podcast_feeds').findOne({ _id: FEED_A })).orphaned_at).toBeUndefined();
  });

  const notify = (user, on, proof = ownSig) => request(app).post('/podcasts/notify')
    .send({ feed_id: feedHex, notify: on, ...proof(user, 'notify', `${feedHex}:${on ? 'on' : 'off'}`) });

  test('the bell is switched per show, signed over the new setting', async () => {
    expect((await notify('ken', false).expect(200)).body).toEqual({ success: true, notify: false });
    expect((await db().collection('podcast_subs').findOne({ _id: `ken|${feedHex}` })).notify).toBe(false);
    // The "off" signature cannot switch it on.
    const off = ownSig('ken', 'notify', `${feedHex}:off`);
    await request(app).post('/podcasts/notify').send({ feed_id: feedHex, notify: true, ...off }).expect(401);
  });

  test('404 for a show the listener does not follow, 400 without a boolean', async () => {
    await notify('bob', true).expect(404);
    await request(app).post('/podcasts/notify').send({ feed_id: feedHex, notify: 'yes', user: 'ken' }).expect(400);
  });
});

// ─── Reads ────────────────────────────────────────────────────────────────────

describe('GET /podcasts/config', () => {
  test('what the page may offer, cached for five minutes', async () => {
    const res = await request(app).get('/podcasts/config').expect(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.body).toMatchObject({ success: true, enabled: true, search: true, charts: true, person: true, trending: true, max_feeds: 3 });
    expect(res.body.chart_countries).toContain('de');
  });
});

describe('the listener lists: subscriptions, latest, notifications', () => {
  beforeEach(async () => {
    await db().collection('podcast_feeds').insertMany([
      feedDoc(FEED_A, { title: 'Zebra Show', url_key: 'a.example.com/f', alt_keys: ['old-a.example.com/f'] }),
      // No cover of its own: takes its newest episode's art.
      feedDoc(FEED_B, { title: 'Apple Show', image: '' }),
      feedDoc(FEED_P, { title: 'Members', private: true, url: 'https://u:pw@p.example.com/f' }),
    ]);
    await db().collection('podcast_episodes').insertMany([
      episode(FEED_A, 1, { first_seen_at: hours(2) }),
      episode(FEED_A, 2),
      episode(FEED_A, 40, { first_seen_at: hours(24 * 40) }),
      episode(FEED_B, 3, { image: 'https://cdn.example.com/b-new.jpg', first_seen_at: hours(3) }),
      episode(FEED_B, 9, { image: 'https://cdn.example.com/b-old.jpg' }),
      episode(FEED_P, 1, { private: true }),
    ]);
    await db().collection('podcast_subs').insertMany([
      follow('alice', FEED_A),
      follow('alice', FEED_B, { notify: false }),
      follow('alice', FEED_P),
    ]);
  });

  test.each(['/podcasts/subscriptions', '/podcasts/latest', '/podcasts/notifications', '/podcasts/progress'])(
    '%s refuses a malformed user (400)', async (path) => {
      await request(app).get(`${path}?user=${encodeURIComponent('<bad>')}`).expect(400);
    },
  );

  test('subscriptions: sorted by title, every known address, art filled from the newest episode', async () => {
    const res = await request(app).get('/podcasts/subscriptions?user=@Alice').expect(200);
    const subs = res.body.subscriptions;
    expect(subs.map((s) => s.title)).toEqual(['Apple Show', 'Zebra Show']);
    expect(subs[0]).toMatchObject({ image: 'https://cdn.example.com/b-new.jpg', notify: false, keys: [`feeds.example.com/${FEED_B.toHexString()}.xml`] });
    expect(subs[0].art).toBe(artToken('https://cdn.example.com/b-new.jpg'));
    expect(subs[1].keys).toEqual(['a.example.com/f', 'old-a.example.com/f']);
    // The stored row is not changed by the fallback.
    expect((await db().collection('podcast_feeds').findOne({ _id: FEED_B })).image).toBe('');
  });

  test('subscriptions: the private show only with the listener\'s own vouch (real signature)', async () => {
    const withVouch = await request(app).get(`/podcasts/subscriptions?user=alice&${readerVouch('alice')}`).expect(200);
    expect(withVouch.body.subscriptions.map((s) => s.title)).toEqual(['Apple Show', 'Members', 'Zebra Show']);
    expect(JSON.stringify(withVouch.body)).not.toContain('pw@');
    // The same answer again comes from the checked-vouch memory.
    await request(app).get(`/podcasts/subscriptions?user=alice&${readerVouch('alice')}`).expect(200);

    const forged = `vu=alice&vts=${Date.now()}&vsig=${ACCOUNTS.alice.sign(message('progress-vouch', 'alice', 'session', Date.now()))}`;
    const res = await request(app).get(`/podcasts/subscriptions?user=alice&${forged}`).expect(200);
    expect(res.body.subscriptions).toHaveLength(2);
  });

  test('latest: newest episodes of everything followed, with a card per show, paged by before', async () => {
    const res = await request(app).get('/podcasts/latest?user=alice&limit=2').expect(200);
    expect(res.body.episodes.map((e) => e.title)).toEqual(['Episode 1', 'Episode 2']);
    expect(Object.keys(res.body.feeds)).toEqual([FEED_A.toHexString()]);
    const older = await request(app).get(`/podcasts/latest?user=alice&before=${encodeURIComponent(hours(48).toISOString())}`).expect(200);
    expect(older.body.episodes.map((e) => e.title)).toEqual(['Episode 3', 'Episode 9', 'Episode 40']);
    expect(older.body.feeds[FEED_B.toHexString()].image).toBe('https://cdn.example.com/b-new.jpg');
  });

  test('latest: nobody followed, nothing to show', async () => {
    expect((await request(app).get('/podcasts/latest?user=nobody').expect(200)).body).toEqual({ success: true, episodes: [], feeds: {} });
  });

  test('notifications: only what arrived in the last 14 days, after the follow, from shows with the bell on', async () => {
    await db().collection('podcast_subs').updateOne({ _id: `alice|${FEED_A.toHexString()}` }, { $set: { added_at: hours(30) } });
    const res = await request(app).get('/podcasts/notifications?user=alice').expect(200);
    // Episode 2 came before the follow, 40 is too old, FEED_B has the bell off.
    expect(res.body.episodes.map((e) => e.title)).toEqual(['Episode 1']);
    expect(res.body.episodes[0].first_seen_at).toBe(hours(2).toISOString());
    expect((await request(app).get('/podcasts/notifications?user=nobody').expect(200)).body.episodes).toEqual([]);
  });
});

describe('one show and one episode', () => {
  beforeEach(async () => {
    await db().collection('podcast_feeds').insertOne(feedDoc(FEED_A, {
      subscribers: 7, description: 'About things', language: 'en', categories: ['Tech'], explicit: false, error: '',
      persons: [], live: [{ id: 'up', title: 'Soon', status: 'pending', start: new Date(NOW.getTime() + 3600e3), url: 'https://s.example.com/l.mp3', link: 'https://s.example.com' }],
    }));
    await db().collection('podcast_episodes').insertMany([1, 2, 3, 4, 5].map((n) => episode(FEED_A, n, n === 1 ? {
      bytes: 100, duration: 60, summary: 'first', image: 'https://cdn.example.com/e1.jpg', season: 1, episode: 1,
      transcripts: [{ url: 'https://cdn.example.com/t.vtt', type: 'text/vtt', lang: 'en' }],
    } : {})));
  });

  test.each([
    ['/podcasts/feed/not-an-id'],
    ['/podcasts/feed/not-an-id/older'],
    ['/podcasts/episode/not-an-id'],
    ['/podcasts/episode/not-an-id/notes'],
    ['/podcasts/episode/not-an-id/chapters'],
  ])('%s is a 400', async (path) => {
    await request(app).get(path).expect(400);
  });

  test('an unknown show or episode is a 404', async () => {
    await request(app).get(`/podcasts/feed/${FEED_B.toHexString()}`).expect(404);
    await request(app).get(`/podcasts/episode/${epId(FEED_B, 1)}`).expect(404);
  });

  test('a show: its card, its newest episodes and whether older ones exist', async () => {
    const res = await request(app).get(`/podcasts/feed/${FEED_A.toHexString()}?limit=2`).expect(200);
    expect(res.body.feed).toMatchObject({ id: FEED_A.toHexString(), subscribers: 7, description: 'About things', categories: ['Tech'], explicit: false });
    expect(res.body.feed.error).toBeUndefined();
    expect(res.body.feed.persons).toBeUndefined();
    expect(res.body.feed.live).toEqual([expect.objectContaining({ id: 'up', status: 'pending', link: 'https://s.example.com' })]);
    expect(res.body.episodes.map((e) => e.title)).toEqual(['Episode 1', 'Episode 2']);
    expect(res.body).toMatchObject({ total: 5, older_available: true });
    expect(res.body.episodes[0]).toMatchObject({ bytes: 100, duration: 60, season: 1, episode: 1, transcripts: [{ lang: 'en', type: 'text/vtt' }] });
    expect(res.body.episodes[0].art).toBe(artToken('https://cdn.example.com/e1.jpg'));
  });

  test('a date range picks the episodes published in it', async () => {
    const since = hours(4 * 24 + 1).toISOString();
    const until = hours(2 * 24 - 1).toISOString();
    const res = await request(app).get(`/podcasts/feed/${FEED_A.toHexString()}?since=${since}&until=${until}&limit=nonsense`).expect(200);
    expect(res.body.episodes.map((e) => e.title)).toEqual(['Episode 2', 'Episode 3', 'Episode 4']);
    expect(res.body.older_available).toBe(false);
  });

  test('older: the next page, and where the one after starts', async () => {
    const res = await request(app).get(`/podcasts/feed/${FEED_A.toHexString()}/older?offset=3&limit=10`).expect(200);
    expect(res.body).toMatchObject({ total: 5, next_offset: 5 });
    expect(res.body.episodes.map((e) => e.title)).toEqual(['Episode 4', 'Episode 5']);
  });

  test('one episode with its show card', async () => {
    const res = await request(app).get(`/podcasts/episode/${epId(FEED_A, 2)}`).expect(200);
    expect(res.body.episode).toMatchObject({ id: epId(FEED_A, 2), feed_id: FEED_A.toHexString(), title: 'Episode 2' });
    expect(res.body.feed).toMatchObject({ title: 'Show a', url: feedDoc(FEED_A).url });
  });

  test('show notes come from the worker: 503 when off, 404 / 502 as it says, cached when found', async () => {
    const path = `/podcasts/episode/${epId(FEED_A, 1)}/notes`;
    podcastFeeds.enabled.mockReturnValue(false);
    await request(app).get(path).set('X-Real-IP', ip).expect(503);
    podcastFeeds.enabled.mockReturnValue(true);

    podcastFeeds.ask.mockResolvedValueOnce({ ok: false, code: 'not_found' });
    await request(app).get(path).set('X-Real-IP', ip).expect(404);
    podcastFeeds.ask.mockResolvedValueOnce({ ok: false, code: 'timeout' });
    expect((await request(app).get(path).set('X-Real-IP', ip).expect(502)).body.code).toBe('timeout');

    podcastFeeds.ask.mockResolvedValueOnce({ ok: true, html: '<p>Full notes</p>' });
    const res = await request(app).get(path).set('X-Real-IP', ip).expect(200);
    expect(res.body.html).toBe('<p>Full notes</p>');
    expect(res.headers['cache-control']).toBe('public, max-age=900');
    expect(podcastFeeds.ask).toHaveBeenLastCalledWith('notes', { feed_id: FEED_A.toHexString(), episode_id: epId(FEED_A, 1) }, 40000);
  });

  test("a transcript without a language asked for: the show's language wins, a broken file falls to the next", async () => {
    await db().collection('podcast_feeds').updateOne({ _id: FEED_A }, { $set: { language: 'de' } });
    await db().collection('podcast_episodes').updateOne({ _id: epId(FEED_A, 3) }, { $set: { transcripts: [
      { url: 'https://cdn.example.com/en.vtt', type: 'text/vtt', lang: 'en' },
      { url: 'https://cdn.example.com/de.vtt', type: 'text/vtt', lang: 'de' },
      { url: 'https://cdn.example.com/de.srt', type: 'application/x-subrip', lang: 'de' },
    ] } });
    safeFetch.mockImplementation(async (url) => {
      if (url.endsWith('de.vtt')) throw new Error('http_500');
      return { body: Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHallo.\n') };
    });
    const res = await request(app).get(`/podcasts/episode/${epId(FEED_A, 3)}/transcript`).set('X-Real-IP', ip).expect(200);
    expect(res.body.lang).toBe('de');
    expect(res.body.cues[0]).toMatchObject({ text: 'Hallo.' });
    expect(res.body.languages).toEqual(expect.arrayContaining(['en', 'de']));
    expect(safeFetch.mock.calls.map((c) => c[0])).toEqual(['https://cdn.example.com/de.vtt', 'https://cdn.example.com/de.srt']);
  });

  test('no usable transcript is a 404', async () => {
    safeFetch.mockRejectedValue(new Error('down'));
    await db().collection('podcast_episodes').updateOne({ _id: epId(FEED_A, 4) }, { $set: { transcripts: [{ url: 'https://cdn.example.com/x.vtt', type: 'text/vtt', lang: 'en' }] } });
    const res = await request(app).get(`/podcasts/episode/${epId(FEED_A, 4)}/transcript?lang=en`).set('X-Real-IP', ip).expect(404);
    expect(res.body.error).toBe('no_transcript');
  });

  test('inline chapters are served without any fetch', async () => {
    await db().collection('podcast_episodes').updateOne({ _id: epId(FEED_A, 5) }, { $set: { chapters_inline: [{ start: 30, title: 'Two' }, { start: 0, title: 'One' }] } });
    const res = await request(app).get(`/podcasts/episode/${epId(FEED_A, 5)}/chapters`).set('X-Real-IP', ip).expect(200);
    expect(res.body.chapters.map((c) => c.title)).toEqual(['One', 'Two']);
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    expect(safeFetch).not.toHaveBeenCalled();
  });
});

describe('a private show read with a real session vouch', () => {
  beforeEach(async () => {
    await db().collection('podcast_feeds').insertOne(feedDoc(FEED_P, { private: true, url: 'https://u:pw@p.example.com/f' }));
    await db().collection('podcast_episodes').insertOne(episode(FEED_P, 1, { private: true }));
    await db().collection('podcast_subs').insertOne(follow('alice', FEED_P));
  });

  test('the follower reads it; another follower-less vouch, an expired or forged one does not', async () => {
    const path = `/podcasts/feed/${FEED_P.toHexString()}`;
    const ok = await request(app).get(`${path}?${readerVouch('alice')}`).expect(200);
    expect(ok.body.feed).toMatchObject({ url: '', private: true });
    await request(app).get(`${path}?${readerVouch('bob')}`).expect(404);
    await request(app).get(`${path}?${readerVouch('alice', Date.now() - 25 * 3600 * 1000)}`).expect(404);
    const forged = `vu=alice&vts=${Date.now()}&vsig=${ACCOUNTS.alice.sign(message('progress-vouch', 'alice', 'session', Date.now()))}`;
    await request(app).get(`${path}?${forged}`).expect(404);
  });

  test('private show notes are cached privately', async () => {
    podcastFeeds.ask.mockResolvedValue({ ok: true, html: 'secret notes' });
    const res = await request(app).get(`/podcasts/episode/${epId(FEED_P, 1)}/notes?${readerVouch('alice')}`).set('X-Real-IP', ip).expect(200);
    expect(res.headers['cache-control']).toBe('private, max-age=900');
  });
});

// ─── Directories ──────────────────────────────────────────────────────────────

const apple = (id, title, feedUrl) => ({ collectionId: id, collectionName: title, artistName: 'Host', feedUrl, artworkUrl600: `https://img.example.com/${id}.jpg`, trackCount: 10 });

describe('search, people, trending and charts', () => {
  const get = (path) => request(app).get(path).set('X-Real-IP', ip);

  test('search: under two characters asks nobody', async () => {
    expect((await get('/podcasts/search?q=a').expect(200)).body).toEqual({ success: true, results: [] });
    expect(fetchCalls).toHaveLength(0);
  });

  test('search: every directory asked at once, merged, signed for Podcast Index, cached', async () => {
    directories({
      'api.podcastindex.org/api/1.0/search/byterm': { feeds: [{ title: 'Rust Talk', author: 'Ann', url: 'https://rust.example.com/feed', artwork: '' }, { title: 'Dead', url: 'https://dead.example.com/f', dead: 1 }] },
      'itunes.apple.com/search': { results: [apple(1, 'Rust Talk', 'http://rust.example.com/feed/'), { collectionId: 2, collectionName: 'No feed' }] },
      'api.fyyd.de/0.2/search/podcast': { data: [{ title: 'Rost', author: 'Bea', xmlURL: 'https://rost.example.de/feed' }] },
    });
    const res = await get('/podcasts/search?q=rust&country=de').expect(200);
    expect(res.body.results.map((r) => [r.title, r.sources])).toEqual([
      ['Rust Talk', ['podcastindex', 'apple']],
      ['Rost', ['fyyd']],
    ]);
    expect(fetchCalls.find((c) => c.url.includes('itunes.apple.com/search')).url).toContain('country=de');
    const pi = fetchCalls.find((c) => c.url.includes('podcastindex'));
    const date = pi.headers['X-Auth-Date'];
    expect(pi.headers['X-Auth-Key']).toBe('test-pi-key');
    expect(pi.headers.Authorization).toBe(crypto.createHash('sha1').update(`test-pi-keytest-pi-secret${date}`).digest('hex'));

    const before = fetchCalls.length;
    await get('/podcasts/search?q=RUST&country=de').expect(200);
    expect(fetchCalls).toHaveLength(before);
  });

  test('search: 502 only when every directory failed; one down is fine', async () => {
    directories({ 'itunes.apple.com/search': { results: [apple(3, 'Solo', 'https://solo.example.com/f')] } });
    expect((await get('/podcasts/search?q=solo-only').expect(200)).body.results.map((r) => r.title)).toEqual(['Solo']);
    directories({});
    await get('/podcasts/search?q=nothing-anywhere').expect(502);
  });

  test('person: the shows a host appears in, one per show', async () => {
    directories({ 'search/byperson': { items: [
      { feedId: 1, feedUrl: 'https://a.example.com/f', feedTitle: 'A', title: 'Guest spot', datePublished: 100 },
      { feedId: 1, feedUrl: 'https://a.example.com/f', feedTitle: 'A', title: 'Second spot', datePublished: 200 },
    ] } });
    expect((await get('/podcasts/person?q=x').expect(200)).body.results).toEqual([]);
    const res = await get('/podcasts/person?q=Adam%20Curry').expect(200);
    expect(res.body.results).toEqual([expect.objectContaining({ title: 'A', matches: 2, sample: 'Second spot' })]);
    expect(fetchCalls[0].url).toContain('search/byperson?q=Adam%20Curry');
  });

  test('person: 502 when Podcast Index fails', async () => {
    directories({ 'search/byperson': () => jsonResponse({}, 500) });
    await get('/podcasts/person?q=nobody-knows').expect(502);
  });

  test('trending: language with its regional forms, a known category by name, dead feeds dropped', async () => {
    directories({ 'podcasts/trending': { feeds: [
      { title: 'Live one', url: 'https://t.example.com/f', newestItemPublishTime: 1000 },
      { title: 'Dead one', url: 'https://d.example.com/f', dead: true },
      { title: 'No url' },
    ] } });
    const res = await get('/podcasts/trending?lang=DE&cat=technology').expect(200);
    expect(res.body.results.map((r) => r.title)).toEqual(['Live one']);
    expect(res.body.categories).toContain('True Crime');
    const asked = new URL(fetchCalls[0].url);
    expect(asked.searchParams.get('lang')).toBe('de,de-de,de-at,de-ch');
    expect(asked.searchParams.get('cat')).toBe('Technology');
  });

  test('trending: a malformed language is a 400; an unknown category is ignored', async () => {
    await get('/podcasts/trending?lang=english!').expect(400);
    directories({ 'podcasts/trending': { feeds: [] } });
    await get('/podcasts/trending?cat=Nonsense').expect(200);
    expect(new URL(fetchCalls[0].url).searchParams.get('cat')).toBeNull();
    directories({ 'podcasts/trending': () => jsonResponse({}, 503) });
    await get('/podcasts/trending?lang=fr').expect(502);
  });

  test("charts: Apple's top shows with their feeds and ranks; shows without a public feed left out", async () => {
    directories({
      'itunes.apple.com/gb/rss/toppodcasts/limit=50/genre=1489/json': { feed: { entry: [
        { id: { attributes: { 'im:id': '11' } } }, { id: { attributes: { 'im:id': '22' } } }, { id: { attributes: { 'im:id': 'x' } } },
      ] } },
      'itunes.apple.com/lookup': { results: [apple(22, 'Second', 'https://two.example.com/f'), { collectionId: 11, collectionName: 'Exclusive' }] },
    });
    const res = await get('/podcasts/charts?country=GB&cat=news').expect(200);
    expect(res.body.results.map((r) => [r.title, r.rank, r.apple_id])).toEqual([['Second', 2, 22]]);
    expect(fetchCalls[1].url).toContain('id=11,22');
  });

  test('charts: unknown country 400, a failing Apple 502, an empty chart is empty', async () => {
    await get('/podcasts/charts?country=zz').expect(400);
    directories({ 'toppodcasts': () => jsonResponse({}, 500) });
    await get('/podcasts/charts?country=fr').expect(502);
    directories({ 'toppodcasts': { feed: { entry: { id: { attributes: {} } } } } });
    expect((await get('/podcasts/charts?country=it').expect(200)).body.results).toEqual([]);
  });

  test('more than 30 searches a minute from one listener is a 429', async () => {
    for (let i = 0; i < 30; i += 1) await get('/podcasts/search?q=a').expect(200);
    const res = await get('/podcasts/search?q=a').expect(429);
    expect(res.body.error).toBe('Too many requests');
  });
});

describe('a Podcast Index link and podcastindex switched off', () => {
  test('without Podcast Index keys person and trending say search is not configured', async () => {
    let off;
    jest.isolateModules(() => {
      const saved = [process.env.PODCASTINDEX_API_KEY, process.env.PODCASTINDEX_API_SECRET];
      delete process.env.PODCASTINDEX_API_KEY;
      delete process.env.PODCASTINDEX_API_SECRET;
      off = buildApp(['/podcasts', require('../../routes/podcasts')]);
      [process.env.PODCASTINDEX_API_KEY, process.env.PODCASTINDEX_API_SECRET] = saved;
    });
    for (const path of ['/podcasts/person?q=someone', '/podcasts/trending']) {
      const res = await request(off).get(path).set('X-Real-IP', ip).expect(503);
      expect(res.body.code).toBe('search_disabled');
    }
    expect((await request(off).get('/podcasts/config').expect(200)).body).toMatchObject({ person: false, trending: false });
  });
});

describe('GET /podcasts/discover', () => {
  test('the most followed and the recently followed public shows, cached for a minute', async () => {
    pinClock(new Date(NOW.getTime() + 10 * 60 * 1000)); // past any earlier cached answer
    await db().collection('podcast_feeds').insertMany([
      feedDoc(FEED_A, { subscribers: 5, last_followed_at: hours(5) }),
      feedDoc(FEED_B, { subscribers: 9 }),
      feedDoc(FEED_P, { subscribers: 50, private: true, last_followed_at: hours(1) }),
      feedDoc(new ObjectId(), { subscribers: 0, title: 'Nobody' }),
      feedDoc(new ObjectId(), { subscribers: 3, status: 'error', title: 'Broken' }),
    ]);
    const res = await request(app).get('/podcasts/discover').expect(200);
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    expect(res.body.top.map((f) => [f.title, f.subscribers])).toEqual([['Show b', 9], ['Show a', 5]]);
    expect(res.body.recent.map((f) => f.title)).toEqual(['Show a']);

    await db().collection('podcast_feeds').deleteMany({});
    expect((await request(app).get('/podcasts/discover').expect(200)).body.top).toHaveLength(2);
  });
});

describe('GET /podcasts/art/:token/:px.jpg', () => {
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const token = artToken('https://cdn.example.com/cover.jpg');

  test('renders only tokens the checker made, in the sizes it offers', async () => {
    await request(app).get('/podcasts/art/forged.token/128.jpg').expect(404);
    await request(app).get(`/podcasts/art/${token}/100.jpg`).expect(404);
    expect(renderArt).not.toHaveBeenCalled();
  });

  test('a rendered cover is immutable for a week', async () => {
    renderArt.mockResolvedValue(JPEG);
    const res = await request(app).get(`/podcasts/art/${token}/256.jpg`).buffer(true).parse(binaryParser).expect(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['cache-control']).toBe('public, max-age=604800, immutable');
    expect(res.body.equals(JPEG)).toBe(true);
    expect(renderArt).toHaveBeenCalledWith('https://cdn.example.com/cover.jpg', 256);
  });

  test('a cover that cannot be had is a briefly cached 404', async () => {
    renderArt.mockRejectedValue(new Error('not an image'));
    const res = await request(app).get(`/podcasts/art/${token}/64.jpg`).expect(404);
    expect(res.headers['cache-control']).toBe('public, max-age=600');
  });
});

// ─── Listening progress with the real vouch ───────────────────────────────────

describe('listening progress', () => {
  const EP = epId(FEED_A, 1);
  const TRACK = 'd'.repeat(24);
  const save = (user, items, proof = progressVouch(user)) => request(app).post('/podcasts/progress').send({ ...proof, items });

  test.each([
    ['no signature', { user: 'alice' }],
    ['the user\'s own key instead of our vouch', { user: 'alice', timestamp: NOW.getTime(), signature: ACCOUNTS.alice.sign(message('progress-vouch', 'alice', 'session', NOW.getTime())) }],
    ['a vouch over 24 hours old', progressVouch('alice', NOW.getTime() - 25 * 3600 * 1000)],
    ['a vouch for another user', { ...progressVouch('bob'), user: 'alice' }],
    ['a malformed user', { ...progressVouch('alice'), user: 'Not Valid' }],
  ])('saving is refused (401) with %s', async (_label, proof) => {
    await save('alice', [{ id: EP, pos: 1, dur: 2 }], proof).expect(401);
    for (const path of ['/podcasts/progress/recent', '/podcasts/progress/hide']) {
      await request(app).post(path).send({ ...proof, id: EP }).expect(401);
    }
    expect(await db().collection('podcast_progress').countDocuments()).toBe(0);
  });

  test('positions are clamped, "done" is the last 5% or 30 s and never goes back', async () => {
    await save('alice', [{ id: EP, pos: 99999, dur: 600 }, { id: TRACK, pos: -5, dur: 'x' }]).expect(200);
    const read = async () => (await request(app).get(`/podcasts/progress?user=alice&ids=${EP},${TRACK},junk`).expect(200)).body.progress;
    expect(await read()).toEqual({ [EP]: { pos: 600, dur: 600, done: true }, [TRACK]: { pos: 0, dur: 0, done: false } });

    await save('alice', [{ id: EP, pos: 10, dur: 600 }]).expect(200);
    expect((await read())[EP]).toEqual({ pos: 10, dur: 600, done: true });
    const row = await db().collection('podcast_progress').findOne({ _id: `alice|${EP}` });
    expect(row).toMatchObject({ user: 'alice', ep: EP, feed_id: FEED_A, at: NOW });
  });

  test('a read by show returns every saved episode of it; no ids is an empty answer', async () => {
    await save('alice', [{ id: EP, pos: 10, dur: 600 }, { id: epId(FEED_B, 1), pos: 5, dur: 100 }]).expect(200);
    const res = await request(app).get(`/podcasts/progress?user=alice&feed=${FEED_A.toHexString()}`).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Object.keys(res.body.progress)).toEqual([EP]);
    expect((await request(app).get('/podcasts/progress?user=alice').expect(200)).body.progress).toEqual({});
    await request(app).get('/podcasts/progress?user=alice&feed=zzz').expect(400);
  });

  test('an empty or malformed item list is a 400', async () => {
    await save('alice', []).expect(400);
    await save('alice', [{ id: '../../etc', pos: 1 }]).expect(400);
  });

  test('hide and undo, with the real vouch; an unknown id is "not found"', async () => {
    await save('alice', [{ id: EP, pos: 100, dur: 600 }]).expect(200);
    const hide = (body) => request(app).post('/podcasts/progress/hide').send({ ...progressVouch('alice'), ...body });
    expect((await hide({ id: EP }).expect(200)).body).toEqual({ success: true, found: true });
    expect((await db().collection('podcast_progress').findOne({ _id: `alice|${EP}` })).hidden).toBe(true);
    await hide({ id: EP, hidden: false }).expect(200);
    expect((await db().collection('podcast_progress').findOne({ _id: `alice|${EP}` })).hidden).toBeUndefined();
    expect((await hide({ id: TRACK }).expect(200)).body.found).toBe(false);
    await hide({ id: 'bad' }).expect(400);
  });

  test('continue listening, against real MongoDB: unfinished, newest first, gone tracks left out', async () => {
    await db().collection('podcast_feeds').insertOne(feedDoc(FEED_A));
    await db().collection('podcast_episodes').insertOne(episode(FEED_A, 1));
    const track = new ObjectId();
    await db().collection('embed-audio').insertOne({ _id: track, owner: 'badadib', title: 'A track', status: 'published' });
    await db().collection('podcast_progress').insertMany([
      { _id: `alice|${EP}`, user: 'alice', ep: EP, pos: 100, dur: 600, at: hours(2) },
      { _id: `alice|${track.toHexString()}`, user: 'alice', ep: track.toHexString(), pos: 50, dur: 200, at: hours(1) },
      { _id: `alice|${'e'.repeat(24)}`, user: 'alice', ep: 'e'.repeat(24), pos: 50, dur: 200, at: hours(0.5) },
    ]);
    const res = await request(app).post('/podcasts/progress/recent').send(progressVouch('alice')).expect(200);
    expect(res.body.items.map((i) => [i.kind, i.id])).toEqual([['track', track.toHexString()], ['episode', EP]]);
    expect(res.body.items[1].feed.title).toBe('Show a');
  });
});

// ─── A database failure ───────────────────────────────────────────────────────

describe('a database failure is a JSON 500, never a crash or a leak', () => {
  const { Collection } = require('mongodb');
  const feedHex = FEED_A.toHexString();
  const EP = epId(FEED_A, 1);
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const boom = () => { throw new Error('connection reset by peer 10.0.0.5'); };
    for (const m of ['find', 'aggregate']) jest.spyOn(Collection.prototype, m).mockImplementation(boom);
    for (const m of ['findOne', 'bulkWrite', 'updateOne', 'deleteOne', 'countDocuments']) {
      jest.spyOn(Collection.prototype, m).mockRejectedValue(new Error('connection reset by peer 10.0.0.5'));
    }
  });

  test.each([
    ['GET', '/podcasts/subscriptions?user=alice', null],
    ['GET', '/podcasts/latest?user=alice', null],
    ['GET', '/podcasts/notifications?user=alice', null],
    ['GET', `/podcasts/feed/${feedHex}`, null],
    ['GET', `/podcasts/feed/${feedHex}/older`, null],
    ['GET', `/podcasts/episode/${EP}`, null],
    ['GET', `/podcasts/episode/${EP}/chapters`, null],
    ['GET', `/podcasts/progress?user=alice&ids=${EP}`, null],
    ['POST', '/podcasts/progress', () => ({ ...progressVouch('alice'), items: [{ id: EP, pos: 1, dur: 10 }] })],
    ['POST', '/podcasts/progress/recent', () => progressVouch('alice')],
    ['POST', '/podcasts/progress/hide', () => ({ ...progressVouch('alice'), id: EP })],
    ['POST', '/podcasts/unsubscribe', () => ({ feed_id: feedHex, ...ownSig('bob', 'unsubscribe', feedHex) })],
    ['POST', '/podcasts/notify', () => ({ feed_id: feedHex, notify: true, ...ownSig('bob', 'notify', `${feedHex}:on`) })],
  ])('%s %s', async (method, path, body) => {
    const req = method === 'GET' ? request(app).get(path) : request(app).post(path).send(body());
    const res = await req.set('X-Real-IP', ip).expect(500);
    expect(res.body.success).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('10.0.0.5');
  });

  test('GET /podcasts/discover', async () => {
    pinClock(new Date(NOW.getTime() + 24 * 3600 * 1000)); // past the cached answer
    expect((await request(app).get('/podcasts/discover').expect(500)).body.error).toBe('could not load podcasts');
  });
});
