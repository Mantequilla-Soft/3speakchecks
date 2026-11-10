/**
 * Outside podcast feeds, worker half (services/podcastFeedsWorker.js): adding a
 * feed (probe), polling the due ones (tick), and show notes on demand. Messages
 * go in through a fake parentPort exactly as the main thread sends them; feeds
 * and episodes land in the real test MongoDB. safeFetch is replaced by a table of
 * canned answers (the real one refuses loopback by design); splitCredentials and
 * the parser are the real ones.
 */
jest.mock('worker_threads', () => {
  const { EventEmitter } = require('events');
  const port = new EventEmitter();
  port.postMessage = (msg) => port.emit('reply', msg);
  return { parentPort: port };
});

const mockFetch = jest.fn();
jest.mock('../../utils/safeFetch', () => ({ ...jest.requireActual('../../utils/safeFetch'), safeFetch: mockFetch }));

const { ObjectId, MongoClient } = require('mongodb');
const { parentPort } = require('worker_threads');
const { FetchError } = jest.requireActual('../../utils/safeFetch');
const { episodeId, urlKey, privateKey, PARSE_VERSION } = require('../../utils/podcastParse');
const { waitUntil } = require('../helpers/wait');
const testDb = require('../helpers/db');
const { DAY, MINUTE } = require('./_fixtures');

const db = testDb.use();
const feeds = () => db().collection('podcast_feeds');
const episodes = () => db().collection('podcast_episodes');
const subs = () => db().collection('podcast_subs');

// Listens on parentPort from here on; its Mongo client is made on the first message.
const worker = require('../../services/podcastFeedsWorker');

// The worker keeps one Mongo client for its whole life. Clients that connect
// during a test are the worker's: remember them and close them at the end.
const workerClients = new Set();
beforeAll(async () => {
  await feeds().createIndex({ url_key: 1 }, { unique: true });
});
beforeEach(() => {
  const realConnect = MongoClient.prototype.connect;
  jest.spyOn(MongoClient.prototype, 'connect').mockImplementation(function connect(...args) {
    workerClients.add(this);
    return realConnect.apply(this, args);
  });
});
afterAll(async () => {
  await Promise.all([...workerClients].map((c) => c.close()));
});

let nextId = 0;
/** Send one message the way the main thread does; resolves to the reply. */
function send(msg) {
  const id = ++nextId;
  return new Promise((resolve) => {
    const onReply = (r) => { if (r.id === id) { parentPort.off('reply', onReply); resolve(r); } };
    parentPort.on('reply', onReply);
    parentPort.emit('message', { id, ...msg });
  });
}

// ── canned feeds ─────────────────────────────────────────────────────────────
const daysAgo = (d) => new Date(Date.now() - d * DAY);
const item = (n, date, extra = '') => `
  <item>
    <title>Episode ${n}</title>
    <guid>ep-${n}</guid>
    <pubDate>${date.toUTCString()}</pubDate>
    <enclosure url="https://cdn.example.com/ep${n}.mp3" type="audio/mpeg" length="1000"/>
    <itunes:duration>10:00</itunes:duration>
    <description><![CDATA[<p>Notes for ${n}</p>]]></description>
    ${extra}
  </item>`;
const rss = (items, { title = 'Test Show', guid = 'show-guid', channel = '' } = {}) => `<?xml version="1.0"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0">
<channel>
  <title>${title}</title>
  <itunes:image href="https://cdn.example.com/cover.jpg"/>
  ${guid ? `<podcast:guid>${guid}</podcast:guid>` : ''}
  ${channel}
  ${items}
</channel>
</rss>`;

// What safeFetch answers, per URL asked for.
let served;
beforeEach(() => {
  served = new Map();
  mockFetch.mockReset().mockImplementation(async (url) => {
    const r = served.get(url);
    if (!r) throw new FetchError('network', `nothing served at ${url}`);
    if (r instanceof Error) throw r;
    return { status: 200, url, permanent: true, headers: {}, ...r, body: r.body == null ? null : Buffer.from(r.body) };
  });
});
const serve = (url, body, extra = {}) => served.set(url, { body, ...extra });

// A feed row as the worker leaves it after a good read, due now.
async function knownFeed(url, extra = {}) {
  const doc = {
    _id: new ObjectId(), url, url_key: urlKey(url), alt_keys: [], status: 'ok', subscribers: 1,
    error_count: 0, last_ok_at: daysAgo(1), last_fetch_at: daysAgo(1), last_full_at: new Date(Date.now() - MINUTE),
    parse_version: PARSE_VERSION, image: 'https://cdn.example.com/cover.jpg', title: 'Test Show',
    next_poll_at: new Date(Date.now() - MINUTE), created_at: daysAgo(30), ...extra,
  };
  await feeds().insertOne(doc);
  return doc;
}
const epIds = async (feedId) => (await episodes().find({ feed_id: feedId }).toArray()).map((e) => e._id).sort();
const URL_A = 'https://feeds.example.com/a.xml';

describe('adding a feed (probe)', () => {
  test('a new URL is fetched at once, stored with its show details and every episode', async () => {
    serve(URL_A, rss(item(2, daysAgo(2)) + item(1, daysAgo(40))), { headers: { etag: '"v1"', 'last-modified': 'Mon, 01 Jan 2026 00:00:00 GMT' } });

    const r = await send({ type: 'probe', url: URL_A });

    expect(r).toMatchObject({ ok: true, existed: false });
    const row = await feeds().findOne({ _id: new ObjectId(r.feed_id) });
    expect(row).toMatchObject({
      url: URL_A, url_key: 'feeds.example.com/a.xml', status: 'ok', title: 'Test Show', subscribers: 0,
      podcast_guid: 'show-guid', image: 'https://cdn.example.com/cover.jpg', etag: '"v1"', item_count: 2,
      parse_version: PARSE_VERSION, error_count: 0,
    });
    expect(row.last_full_at).toBeInstanceOf(Date);
    expect(row.next_poll_at.getTime()).toBeGreaterThan(Date.now() + 20 * MINUTE);
    const eps = await episodes().find({ feed_id: row._id }).sort({ published_at: -1 }).toArray();
    expect(eps.map((e) => e._id)).toEqual([episodeId(r.feed_id, 'ep-2'), episodeId(r.feed_id, 'ep-1')]);
    // The feed's own guid is kept: a 3Speak playlist's RSS feed passes the episode on under it.
    expect(eps[0]).toMatchObject({ title: 'Episode 2', duration: 600, mime: 'audio/mpeg', guid: 'ep-2' });
    // A first read never counts as "new episodes": each is dated by its own pubDate.
    expect(eps[0].first_seen_at.getTime()).toBe(eps[0].published_at.getTime());
    // The first fetch is unconditional.
    expect(mockFetch).toHaveBeenCalledWith(URL_A, { headers: {}, auth: '' });
  });

  test('a URL we already read is not fetched again', async () => {
    const f = await knownFeed(URL_A);
    const r = await send({ type: 'probe', url: 'http://www.feeds.example.com/a.xml/' });   // same key
    expect(r).toEqual({ id: expect.any(Number), ok: true, feed_id: f._id.toHexString(), existed: true });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('a known feed that never worked is fetched again', async () => {
    const f = await knownFeed(URL_A, { status: 'pending', last_ok_at: null });
    serve(URL_A, rss(item(1, daysAgo(1))));
    const r = await send({ type: 'probe', url: URL_A });
    expect(r).toMatchObject({ ok: true, feed_id: f._id.toHexString() });
    expect(await epIds(f._id)).toHaveLength(1);
  });

  test('something that is not a URL is refused without a fetch', async () => {
    await expect(send({ type: 'probe', url: 'not a url' })).resolves.toMatchObject({ ok: false, code: 'bad_url' });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(await feeds().countDocuments()).toBe(0);
  });

  test.each([
    ['a refused address', () => new FetchError('blocked_address', 'no'), 'blocked_address'],
    ['an HTTP error', () => new FetchError('http_404', '404'), 'http_404'],
  ])('%s leaves no row behind', async (_name, err, code) => {
    served.set(URL_A, err());
    await expect(send({ type: 'probe', url: URL_A })).resolves.toMatchObject({ ok: false, code });
    expect(await feeds().countDocuments()).toBe(0);
  });

  test.each([
    ['a feed with no playable episodes', rss('<item><title>Text only</title><guid>x</guid></item>'), 'no_episodes'],
    ['a page that is not a podcast', '<html><body>hello</body></html>', expect.any(String)],
  ])('%s is refused and leaves no row', async (_name, body, code) => {
    serve(URL_A, body);
    const r = await send({ type: 'probe', url: URL_A });
    expect(r).toMatchObject({ ok: false, code });
    expect(await feeds().countDocuments()).toBe(0);
    expect(await episodes().countDocuments()).toBe(0);
  });

  test('a URL that redirects to a show we have becomes that show; its subscriptions move', async () => {
    const kept = await knownFeed('https://host.example.com/real.xml', { subscribers: 1 });
    const shortUrl = 'https://short.example.com/s';
    serve(shortUrl, rss(item(1, daysAgo(1))), { url: 'https://host.example.com/real.xml' });

    const r = await send({ type: 'probe', url: shortUrl });

    expect(r).toMatchObject({ ok: true, feed_id: kept._id.toHexString(), existed: true });
    const rows = await feeds().find().toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].alt_keys).toContain('short.example.com/s');
  });

  test('a second URL of the same show (same podcast:guid) is merged into the older row', async () => {
    const kept = await knownFeed('https://one.example.com/feed', { podcast_guid: 'same-show', subscribers: 1 });
    await subs().insertOne({ _id: `ann|${kept._id.toHexString()}`, user: 'ann', feed_id: kept._id });
    serve('https://two.example.com/feed', rss(item(1, daysAgo(1)), { guid: 'same-show' }));

    const r = await send({ type: 'probe', url: 'https://two.example.com/feed' });

    expect(r).toMatchObject({ ok: true, feed_id: kept._id.toHexString(), existed: true });
    expect(await feeds().countDocuments()).toBe(1);
    expect(await subs().countDocuments({ feed_id: kept._id })).toBe(1);
  });

  test('a private feed: its own row, fetched with the password as Basic auth, never merged', async () => {
    await knownFeed('https://premium.example.com/feed', { podcast_guid: 'paid-show' });
    serve('https://premium.example.com/feed', rss(item(1, daysAgo(1)), { guid: 'paid-show' }));

    const r = await send({ type: 'probe', url: 'https://ann:hunter2@premium.example.com/feed', private: true, owner: 'ann' });

    expect(r).toMatchObject({ ok: true, existed: false });
    expect(mockFetch).toHaveBeenCalledWith('https://premium.example.com/feed', {
      headers: {}, auth: `Basic ${Buffer.from('ann:hunter2').toString('base64')}`,
    });
    const row = await feeds().findOne({ _id: new ObjectId(r.feed_id) });
    expect(row).toMatchObject({ private: true, owner: 'ann', url_key: privateKey('ann', 'https://premium.example.com/feed') });
    expect(row.url_key).not.toMatch(/hunter2|premium/);
    expect(await episodes().findOne({ feed_id: row._id })).toMatchObject({ private: true });
    expect(await feeds().countDocuments()).toBe(2);
  });
});

describe('polling (tick)', () => {
  test('only feeds that are due and followed are polled', async () => {
    const due = await knownFeed('https://a.example.com/1');
    await knownFeed('https://a.example.com/2', { next_poll_at: new Date(Date.now() + DAY) });
    await knownFeed('https://b.example.com/3', { subscribers: 0 });
    serve(due.url, rss(item(1, daysAgo(1))));

    const r = await send({ type: 'tick' });

    expect(r).toMatchObject({ ok: true, polled: 1, changed: 1, errors: 0 });
    expect(mockFetch.mock.calls.map((c) => c[0])).toEqual([due.url]);
  });

  test('at most two feeds of one host per tick; the rest wait for the next', async () => {
    for (let i = 0; i < 4; i += 1) {
      const f = await knownFeed(`https://anchor.example.com/s${i}`, { next_poll_at: new Date(Date.now() - (10 - i) * MINUTE) });
      serve(f.url, rss(item(1, daysAgo(1))));
    }
    const other = await knownFeed('https://other.example.com/x');
    serve(other.url, rss(item(1, daysAgo(1))));

    const r = await send({ type: 'tick' });

    expect(r.polled).toBe(3);
    expect(mockFetch.mock.calls.map((c) => c[0]).sort()).toEqual([
      'https://anchor.example.com/s0', 'https://anchor.example.com/s1', 'https://other.example.com/x',
    ]);
  });

  test('a routine poll is conditional, and a 304 writes nothing but the schedule', async () => {
    const f = await knownFeed(URL_A, { etag: '"v1"', last_modified: 'Sun, 01 Nov 2026 00:00:00 GMT', error: 'old', error_count: 0 });
    serve(URL_A, null, { status: 304 });

    const r = await send({ type: 'tick' });

    expect(r).toMatchObject({ polled: 1, changed: 0, errors: 0, announce: [] });
    expect(mockFetch).toHaveBeenCalledWith(URL_A, {
      headers: { 'If-None-Match': '"v1"', 'If-Modified-Since': 'Sun, 01 Nov 2026 00:00:00 GMT' }, auth: '',
    });
    const row = await feeds().findOne({ _id: f._id });
    expect(row).not.toHaveProperty('error');
    expect(row.next_poll_at.getTime()).toBeGreaterThan(Date.now());
    expect(await episodes().countDocuments()).toBe(0);
  });

  test('an unchanged body (same hash) is not parsed again; running twice changes nothing', async () => {
    const f = await knownFeed(URL_A, { last_ok_at: null, status: 'pending' });
    serve(URL_A, rss(item(2, daysAgo(2)) + item(1, daysAgo(3))));
    await send({ type: 'tick' });
    const eps1 = await episodes().find().sort({ _id: 1 }).toArray();
    await feeds().updateOne({ _id: f._id }, { $set: { next_poll_at: new Date(Date.now() - MINUTE) } });

    const r = await send({ type: 'tick' });

    expect(r).toMatchObject({ polled: 1, changed: 0 });
    expect(await episodes().find().sort({ _id: 1 }).toArray()).toEqual(eps1);
  });

  test('a new recent episode on a known show is announced, dated now', async () => {
    const f = await knownFeed(URL_A);
    const hex = f._id.toHexString();
    const seenBefore = daysAgo(10);
    await episodes().insertOne({ _id: episodeId(hex, 'ep-1'), feed_id: f._id, title: 'Episode 1', first_seen_at: seenBefore });
    serve(URL_A, rss(item(2, new Date(Date.now() - 60 * MINUTE)) + item(1, daysAgo(10))));

    const r = await send({ type: 'tick' });

    expect(r.announce).toEqual([{
      feed_id: hex, title: 'Test Show', image: 'https://cdn.example.com/cover.jpg',
      episodes: [{ id: episodeId(hex, 'ep-2'), title: 'Episode 2' }],
    }]);
    const ep = await episodes().findOne({ _id: episodeId(hex, 'ep-2') });
    expect(Date.now() - ep.first_seen_at.getTime()).toBeLessThan(MINUTE);
    // The known episode keeps its first-seen date.
    expect((await episodes().findOne({ _id: episodeId(hex, 'ep-1') })).first_seen_at).toEqual(seenBefore);
  });

  test('a newly listed old episode is stored quietly, dated by its pubDate', async () => {
    const f = await knownFeed(URL_A);
    const old = daysAgo(30);
    serve(URL_A, rss(item(9, old)));

    const r = await send({ type: 'tick' });

    expect(r.announce).toEqual([]);
    const ep = await episodes().findOne({ _id: episodeId(f._id.toHexString(), 'ep-9') });
    expect(Math.abs(ep.first_seen_at.getTime() - old.getTime())).toBeLessThan(1000);
  });

  test('more than five new episodes at once (a re-issued feed) buzz nobody', async () => {
    await knownFeed(URL_A);
    serve(URL_A, rss(Array.from({ length: 6 }, (_, i) => item(i, new Date(Date.now() - (i + 1) * MINUTE))).join('')));
    const r = await send({ type: 'tick' });
    expect(r.announce).toEqual([]);
    expect(await episodes().countDocuments()).toBe(6);
  });

  test('a full read (once a day) drops episodes the host removed; a routine read keeps them', async () => {
    const routine = await knownFeed('https://r.example.com/feed');
    const daily = await knownFeed('https://d.example.com/feed', { last_full_at: daysAgo(2) });
    for (const f of [routine, daily]) {
      await episodes().insertOne({ _id: episodeId(f._id.toHexString(), 'removed'), feed_id: f._id, title: 'gone' });
      serve(f.url, rss(item(1, daysAgo(1))));
    }

    await send({ type: 'tick' });

    expect(await epIds(routine._id)).toContain(episodeId(routine._id.toHexString(), 'removed'));
    expect(await epIds(daily._id)).toEqual([episodeId(daily._id.toHexString(), 'ep-1')]);
    expect((await feeds().findOne({ _id: daily._id })).last_full_at.getTime()).toBeGreaterThan(Date.now() - MINUTE);
  });

  test('a field an episode no longer has is removed from the stored episode', async () => {
    const f = await knownFeed(URL_A);
    serve(URL_A, rss(item(1, daysAgo(1))));
    await send({ type: 'tick' });
    const id = episodeId(f._id.toHexString(), 'ep-1');
    expect((await episodes().findOne({ _id: id })).duration).toBe(600);

    await feeds().updateOne({ _id: f._id }, { $set: { next_poll_at: new Date(Date.now() - MINUTE) } });
    serve(URL_A, rss(item(1, daysAgo(1)).replace('<itunes:duration>10:00</itunes:duration>', '')));
    await send({ type: 'tick' });

    expect(await episodes().findOne({ _id: id })).not.toHaveProperty('duration');
  });

  describe('a feed that moved', () => {
    test('all-permanent redirects move the stored URL; the old address stays as an alias', async () => {
      const f = await knownFeed(URL_A);
      serve(URL_A, rss(item(1, daysAgo(1))), { url: 'https://new.example.com/feed', permanent: true });

      await send({ type: 'tick' });

      const row = await feeds().findOne({ _id: f._id });
      expect(row).toMatchObject({ url: 'https://new.example.com/feed', url_key: 'new.example.com/feed' });
      expect(row.alt_keys).toEqual(['feeds.example.com/a.xml']);
    });

    test('a temporary redirect does not move it', async () => {
      const f = await knownFeed(URL_A);
      serve(URL_A, rss(item(1, daysAgo(1))), { url: 'https://cdn.example.com/feed', permanent: false });
      await send({ type: 'tick' });
      expect(await feeds().findOne({ _id: f._id })).toMatchObject({ url: URL_A, alt_keys: [] });
    });

    test('itunes:new-feed-url moves it, unless another row already has that address', async () => {
      const moving = await knownFeed(URL_A);
      const blocked = await knownFeed('https://b.example.com/feed', { podcast_guid: 'other' });
      await knownFeed('https://taken.example.com/feed', { next_poll_at: new Date(Date.now() + DAY) });
      serve(URL_A, rss(item(1, daysAgo(1)), { channel: '<itunes:new-feed-url>https://moved.example.com/feed</itunes:new-feed-url>' }));
      serve(blocked.url, rss(item(1, daysAgo(1)), { guid: 'other', channel: '<itunes:new-feed-url>https://taken.example.com/feed</itunes:new-feed-url>' }));

      await send({ type: 'tick' });

      expect(await feeds().findOne({ _id: moving._id })).toMatchObject({ url: 'https://moved.example.com/feed', url_key: 'moved.example.com/feed' });
      expect(await feeds().findOne({ _id: blocked._id })).toMatchObject({ url: blocked.url });
    });

    test('a private feed stays at the address its listener gave', async () => {
      const f = await knownFeed('https://premium.example.com/feed', { private: true, owner: 'ann', url_key: privateKey('ann', 'https://premium.example.com/feed') });
      serve(f.url, rss(item(1, daysAgo(1))), { url: 'https://elsewhere.example.com/feed', permanent: true });
      await send({ type: 'tick' });
      expect(await feeds().findOne({ _id: f._id })).toMatchObject({ url: f.url, url_key: f.url_key });
    });
  });

  test('a duplicate row found while polling is folded into the older one, subscriptions and all', async () => {
    const keep = await knownFeed('https://one.example.com/feed', { podcast_guid: 'same', subscribers: 1, next_poll_at: new Date(Date.now() + DAY) });
    const dup = await knownFeed('https://two.example.com/feed', { subscribers: 2, alt_keys: ['three.example.com/feed'] });
    const k = keep._id.toHexString();
    const d = dup._id.toHexString();
    const bobSince = daysAgo(9);
    await subs().insertMany([
      { _id: `bob|${k}`, user: 'bob', feed_id: keep._id, added_at: bobSince },
      { _id: `bob|${d}`, user: 'bob', feed_id: dup._id, added_at: daysAgo(5) },             // follows both
      { _id: `ann|${d}`, user: 'ann', feed_id: dup._id, added_at: daysAgo(3), notify: false },
    ]);
    await episodes().insertOne({ _id: episodeId(d, 'old'), feed_id: dup._id });
    serve(dup.url, rss(item(1, daysAgo(1)), { guid: 'same' }));

    const r = await send({ type: 'tick' });

    expect(r).toMatchObject({ polled: 1, changed: 0, errors: 0 });
    expect(await feeds().findOne({ _id: dup._id })).toBeNull();
    expect(await episodes().countDocuments({ feed_id: dup._id })).toBe(0);
    const row = await feeds().findOne({ _id: keep._id });
    expect(row.subscribers).toBe(2);                         // only ann was new
    expect(row.alt_keys.sort()).toEqual(['three.example.com/feed', 'two.example.com/feed']);
    const moved = await subs().find({}, { sort: { _id: 1 } }).toArray();
    expect(moved.map((s) => s._id)).toEqual([`ann|${k}`, `bob|${k}`]);
    expect(moved[0]).toMatchObject({ user: 'ann', notify: false });
    expect(moved[1].added_at).toEqual(bobSince);           // his older follow is kept as it was
  });

  test('a working feed survives two failed polls; the third shows it as broken, with growing back-off', async () => {
    const f = await knownFeed(URL_A);
    served.set(URL_A, new FetchError('timeout', 'slow'));
    const states = [];
    for (let i = 0; i < 3; i += 1) {
      await feeds().updateOne({ _id: f._id }, { $set: { next_poll_at: new Date(Date.now() - MINUTE) } });
      const r = await send({ type: 'tick' });
      expect(r).toMatchObject({ polled: 1, errors: 1 });
      const row = await feeds().findOne({ _id: f._id });
      states.push({ status: row.status, error: row.error, n: row.error_count, wait: row.next_poll_at.getTime() - Date.now() });
    }

    expect(states.map(({ status, error, n }) => [status, error, n])).toEqual([
      ['ok', 'timeout', 1], ['ok', 'timeout', 2], ['error', 'timeout', 3],
    ]);
    expect(states[0].wait).toBeGreaterThan(12 * MINUTE);       // 15 min, with jitter
    expect(states[2].wait).toBeGreaterThan(states[1].wait);
    expect(await episodes().countDocuments()).toBe(0);
  });

  test('a tick while one is still running is answered "skipped"', async () => {
    const f = await knownFeed(URL_A);
    let release;
    mockFetch.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ status: 304, url: f.url, permanent: true, headers: {}, body: null });
    }));

    const first = send({ type: 'tick' });
    await waitFor(() => !!release);
    const second = await send({ type: 'tick' });
    release();

    expect(second).toMatchObject({ ok: true, skipped: true });
    await expect(first).resolves.toMatchObject({ ok: true, polled: 1 });
  });
});

describe('show notes', () => {
  test('an episode\'s full notes, then the same show from the cache', async () => {
    const f = await knownFeed(URL_A);
    const hex = f._id.toHexString();
    serve(URL_A, rss(item(1, daysAgo(1), '<content:encoded><![CDATA[<p>Full <b>notes</b></p>]]></content:encoded>') + item(2, daysAgo(2))));

    const one = await send({ type: 'notes', feed_id: hex, episode_id: episodeId(hex, 'ep-1') });
    const two = await send({ type: 'notes', feed_id: hex, episode_id: episodeId(hex, 'ep-2') });
    const none = await send({ type: 'notes', feed_id: hex, episode_id: 'nope' });

    expect(one).toMatchObject({ ok: true, html: '<p>Full <b>notes</b></p>' });
    expect(two).toMatchObject({ ok: true, html: '<p>Notes for 2</p>' });
    expect(none).toMatchObject({ ok: true, html: '' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][1]).toMatchObject({ timeoutMs: 25000, maxBytes: 32 * 1024 * 1024 });
  });

  test('only a few shows are cached: the oldest is read again', async () => {
    const list = [];
    for (let i = 0; i < 5; i += 1) {
      const f = await knownFeed(`https://n${i}.example.com/feed`);
      serve(f.url, rss(item(1, daysAgo(1))));
      list.push(f._id.toHexString());
    }
    for (const hex of list) await send({ type: 'notes', feed_id: hex, episode_id: 'x' });
    mockFetch.mockClear();

    await send({ type: 'notes', feed_id: list[4], episode_id: 'x' });   // still cached
    await send({ type: 'notes', feed_id: list[0], episode_id: 'x' });   // pushed out

    expect(mockFetch.mock.calls.map((c) => c[0])).toEqual(['https://n0.example.com/feed']);
  });

  test('an unknown show is not_found; a fetch error comes back as its code', async () => {
    const missing = await send({ type: 'notes', feed_id: new ObjectId().toHexString(), episode_id: 'x' });
    expect(missing).toMatchObject({ ok: false, code: 'not_found' });

    const f = await knownFeed(URL_A);
    served.set(URL_A, new FetchError('http_500', 'server answered 500'));
    const broken = await send({ type: 'notes', feed_id: f._id.toHexString(), episode_id: 'x' });
    expect(broken).toMatchObject({ ok: false, code: 'http_500', error: 'server answered 500' });
  });
});

describe('messages', () => {
  test('an unknown message type is answered, not ignored', async () => {
    await expect(send({ type: 'reboot' })).resolves.toMatchObject({ ok: false, code: 'unknown_message' });
  });

  test('a malformed feed id is an error reply, not a crash', async () => {
    const r = await send({ type: 'notes', feed_id: 'zzz', episode_id: 'x' });
    expect(r.ok).toBe(false);
    expect(r.code).toEqual(expect.any(String));
  });
});

describe('pure helpers', () => {
  const { pollInterval, backoff, showSet, parsedByCurrent } = worker._test;

  test('the poll interval is 30 minutes by default', () => {
    expect(pollInterval()).toBe(30 * MINUTE);
  });

  test.each([[1, 15], [2, 30], [3, 60], [7, 960], [8, 1440], [20, 1440]])('back-off after %i errors is %i minutes (capped at a day)', (n, min) => {
    expect(backoff(n)).toBe(min * MINUTE);
  });

  test('show fields: empty values are unset, the rest set', () => {
    expect(showSet({ title: 'T', author: '', image: null, categories: [], explicit: false, language: 'en' })).toEqual({
      set: { title: 'T', language: 'en' },
      unset: expect.objectContaining({ author: '', image: '', categories: '', explicit: '', podcast_guid: '' }),
    });
  });

  test('a feed stored by an older parser is read again', () => {
    expect(parsedByCurrent({ parse_version: PARSE_VERSION })).toBe(true);
    expect(parsedByCurrent({ parse_version: PARSE_VERSION - 1 })).toBe(false);
    expect(parsedByCurrent({})).toBe(false);
  });
});

const waitFor = (check) => waitUntil(check);
