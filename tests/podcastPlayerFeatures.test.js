/**
 * Podcast player features: the new feed tags (seasons, chapters, transcripts,
 * people, soundbites, video, live items), the chapter and transcript
 * normalisers, episode search, private feeds and the download proxy. A fake
 * in-memory Mongo, a fake vouch check and a fake host: no network.
 */
const { Readable } = require('stream');
const express = require('express');
const request = require('supertest');
const { ObjectId } = require('mongodb');

// ─── Fakes ────────────────────────────────────────────────────────────────────

const store = {};
const same = (a, b) => (a instanceof ObjectId || b instanceof ObjectId ? String(a) === String(b) : a === b);
function matches(doc, q) {
  return Object.entries(q || {}).every(([k, cond]) => {
    if (k === '$or') return cond.some((c) => matches(doc, c));
    if (k === '$nor') return !cond.some((c) => matches(doc, c));
    const v = doc[k];
    if (cond instanceof RegExp) return typeof v === 'string' && cond.test(v);
    if (cond && typeof cond === 'object' && !(cond instanceof ObjectId) && !(cond instanceof Date)) {
      return Object.entries(cond).every(([op, x]) => {
        if (op === '$in') return x.some((y) => (Array.isArray(v) ? v.some((w) => same(w, y)) : same(v, y)));
        if (op === '$nin') return !x.some((y) => same(v, y));
        if (op === '$ne') return !same(v, x);
        if (op === '$exists') return (v !== undefined) === x;
        if (op === '$gt') return v > x;
        if (op === '$gte') return v >= x;
        if (op === '$lt') return v < x;
        if (op === '$lte') return v <= x;
        return false;
      });
    }
    return Array.isArray(v) ? v.some((w) => same(w, cond)) : same(v, cond);
  });
}
function cursor(docs) {
  let list = [...docs];
  const c = {
    sort(spec) {
      const [[k, dir]] = Object.entries(spec);
      list.sort((a, b) => ((a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * dir));
      return c;
    },
    skip(n) { list = list.slice(n); return c; },
    limit(n) { list = list.slice(0, n); return c; },
    toArray: async () => list,
  };
  return c;
}
function mockCollection(name) {
  if (!store[name]) store[name] = [];
  const rows = () => store[name];
  return {
    find: (q) => cursor(rows().filter((d) => matches(d, q))),
    findOne: async (q) => rows().find((d) => matches(d, q)) || null,
    countDocuments: async (q) => rows().filter((d) => matches(d, q)).length,
    aggregate: () => ({ toArray: async () => [] }),
    insertOne: async (doc) => { const _id = doc._id || new ObjectId(); rows().push({ ...doc, _id }); return { insertedId: _id }; },
    updateOne: async (filter, update, opts = {}) => {
      let doc = rows().find((d) => matches(d, filter));
      let upserted = 0;
      if (!doc) {
        if (!opts.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
        doc = { ...filter, ...(update.$setOnInsert || {}) };
        rows().push(doc);
        upserted = 1;
      }
      Object.assign(doc, update.$set || {});
      for (const [k, n] of Object.entries(update.$inc || {})) doc[k] = (doc[k] || 0) + n;
      for (const k of Object.keys(update.$unset || {})) delete doc[k];
      return { matchedCount: upserted ? 0 : 1, modifiedCount: 1, upsertedCount: upserted };
    },
  };
}
jest.mock('../utils/db', () => ({ getDb: () => ({ collection: mockCollection }) }));
jest.mock('../utils/hiveAuth', () => ({
  // A "signature" of good-<user> is that user's valid vouch.
  verifyDelegateVouch: jest.fn(async ({ message, signature }) => ({ ok: signature === `good-${message.split('|')[2]}` })),
  verifyHiveAuthority: jest.fn(async () => ({ ok: false })),
}));
jest.mock('../services/podcastFeeds', () => ({
  enabled: () => true,
  ask: jest.fn(),
  collections: { FEEDS: 'podcast_feeds', EPISODES: 'podcast_episodes', SUBS: 'podcast_subs', PROGRESS: 'podcast_progress' },
}));
jest.mock('../utils/safeFetch', () => {
  const real = jest.requireActual('../utils/safeFetch');
  return { ...real, safeFetch: jest.fn(), safeStream: jest.fn() };
});

const { parseFeed, privateKey, urlKey, _test: { truncateItems } } = require('../utils/podcastParse');
const media = require('../utils/podcastMedia');
const safe = require('../utils/safeFetch');
const podcastFeeds = require('../services/podcastFeeds');
const directories = require('../utils/podcastDirectories');
const router = require('../routes/podcasts');
const { _test: L } = require('../routes/audioListen');

const app = express();
app.use('/podcasts', router);

// ─── The fixture feed ─────────────────────────────────────────────────────────

const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
  xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:psc="http://podlove.org/simple-chapters">
<channel>
  <title>Everything Show</title>
  <language>en-us</language>
  <itunes:image href="https://cdn.example.com/cover.jpg"/>
  <podcast:person role="Host" img="https://cdn.example.com/ann.jpg" href="https://ann.example.com">Ann Host</podcast:person>
  <podcast:person>Bob Cohost</podcast:person>
  <podcast:liveItem status="live" start="2026-10-30T10:00:00Z" end="2099-10-30T12:00:00Z">
    <title>Live now</title>
    <guid>live-1</guid>
    <enclosure url="https://stream.example.com/live.mp3" type="audio/mpeg" length="0"/>
    <podcast:contentLink href="https://example.com/live">Watch</podcast:contentLink>
  </podcast:liveItem>
  <podcast:liveItem status="ended" start="2026-10-01T10:00:00Z">
    <title>Over</title>
    <enclosure url="https://stream.example.com/old.mp3" type="audio/mpeg"/>
  </podcast:liveItem>
  <podcast:liveItem status="pending" start="2099-01-01T10:00:00Z">
    <title>Soon</title>
    <guid>live-2</guid>
    <podcast:alternateEnclosure type="application/x-mpegURL"><podcast:source uri="https://stream.example.com/soon.m3u8"/></podcast:alternateEnclosure>
  </podcast:liveItem>
  <item>
    <title>Full episode</title>
    <guid>ep-full</guid>
    <pubDate>Tue, 20 Oct 2026 10:00:00 GMT</pubDate>
    <enclosure url="https://cdn.example.com/full.mp3" type="audio/mpeg" length="1000"/>
    <itunes:season>2</itunes:season>
    <itunes:episode>14</itunes:episode>
    <itunes:episodeType>full</itunes:episodeType>
    <podcast:chapters url="https://cdn.example.com/full.chapters.json" type="application/json+chapters"/>
    <podcast:transcript url="https://cdn.example.com/full.vtt" type="text/vtt" language="en"/>
    <podcast:transcript url="https://cdn.example.com/full.de.srt" type="application/srt" language="de"/>
    <podcast:transcript url="https://cdn.example.com/full.json" type="application/json"/>
    <podcast:person role="guest" group="cast" img="https://cdn.example.com/carl.jpg">Carl Guest</podcast:person>
    <podcast:soundbite startTime="73.5" duration="60">The best minute</podcast:soundbite>
    <podcast:soundbite startTime="10" duration="0">Broken</podcast:soundbite>
    <podcast:alternateEnclosure type="video/mp4" length="5000" height="720">
      <podcast:source uri="ipfs://bafy"/>
      <podcast:source uri="https://cdn.example.com/full.mp4"/>
    </podcast:alternateEnclosure>
  </item>
  <item>
    <title>Trailer with inline chapters</title>
    <guid>ep-trailer</guid>
    <pubDate>Mon, 19 Oct 2026 10:00:00 GMT</pubDate>
    <enclosure url="https://cdn.example.com/trailer.mp3" type="audio/mpeg"/>
    <podcast:season name="Origins">1</podcast:season>
    <podcast:episode>1.5</podcast:episode>
    <itunes:episodeType>Trailer</itunes:episodeType>
    <podcast:person role="host">Ann Host</podcast:person>
    <psc:chapters version="1.2">
      <psc:chapter start="00:01:02.500" title="Second" href="https://example.com/2"/>
      <psc:chapter start="0" title="First" image="https://cdn.example.com/c1.jpg"/>
      <psc:chapter start="nonsense" title="Bad"/>
    </psc:chapters>
  </item>
  <item>
    <title>A video episode</title>
    <guid>ep-video</guid>
    <pubDate>Sun, 18 Oct 2026 10:00:00 GMT</pubDate>
    <enclosure url="https://cdn.example.com/bonus.mp4" type="video/mp4"/>
    <itunes:episodeType>bonus</itunes:episodeType>
  </item>
</channel>
</rss>`;

describe('parsing the new tags', () => {
  const { show, episodes } = parseFeed(FIXTURE, { all: true });
  const ep = (guid) => episodes.find((e) => e.guid === guid);

  test('channel people and live items (ended ones dropped)', () => {
    expect(show.persons).toEqual([
      { name: 'Ann Host', role: 'host', group: 'cast', img: 'https://cdn.example.com/ann.jpg', href: 'https://ann.example.com/' },
      { name: 'Bob Cohost', role: 'host', group: 'cast' },
    ]);
    expect(show.live).toHaveLength(2);
    expect(show.live[0]).toMatchObject({ title: 'Live now', status: 'live', url: 'https://stream.example.com/live.mp3', mime: 'audio/mpeg', link: 'https://example.com/live' });
    expect(show.live[0].id).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(show.live[0].end).toEqual(new Date('2099-10-30T12:00:00Z'));
    // A future start stays in the future (pubDates are clamped, live starts are not).
    expect(show.live[1]).toMatchObject({ status: 'pending', url: 'https://stream.example.com/soon.m3u8', start: new Date('2099-01-01T10:00:00Z') });
  });

  test('season, episode, type, chapters, transcripts, people, soundbites, video', () => {
    const full = ep('ep-full');
    expect(full).toMatchObject({ season: 2, episode: 14, chapters: true, chapters_url: 'https://cdn.example.com/full.chapters.json', chapters_type: 'application/json+chapters' });
    expect(full.episode_type).toBeUndefined();
    expect(full.transcripts).toEqual([
      { url: 'https://cdn.example.com/full.vtt', type: 'text/vtt', lang: 'en' },
      { url: 'https://cdn.example.com/full.de.srt', type: 'application/srt', lang: 'de' },
      // No language: the show's.
      { url: 'https://cdn.example.com/full.json', type: 'application/json', lang: 'en' },
    ]);
    expect(full.persons).toEqual([{ name: 'Carl Guest', role: 'guest', group: 'cast', img: 'https://cdn.example.com/carl.jpg' }]);
    expect(full.soundbites).toEqual([{ start: 73.5, duration: 60, title: 'The best minute' }]);
    expect(full.video).toEqual({ url: 'https://cdn.example.com/full.mp4', mime: 'video/mp4' });
  });

  test('inline chapters, decimal episode numbers, a trailer', () => {
    const t = ep('ep-trailer');
    expect(t).toMatchObject({ season: 1, episode: 1.5, episode_type: 'trailer', chapters: true });
    expect(t.chapters_url).toBeUndefined();
    expect(t.chapters_inline).toEqual([
      { start: 62.5, title: 'Second', url: 'https://example.com/2' },
      { start: 0, title: 'First', img: 'https://cdn.example.com/c1.jpg' },
    ]);
    // A person who is not the show's whole cast is kept; transcripts absent.
    expect(t.persons).toEqual([{ name: 'Ann Host', role: 'host', group: 'cast' }]);
    expect(t.transcripts).toBeUndefined();
  });

  test('a video enclosure is also the video version; nothing extra on a plain episode', () => {
    const v = ep('ep-video');
    expect(v).toMatchObject({ audio_url: 'https://cdn.example.com/bonus.mp4', episode_type: 'bonus', video: { url: 'https://cdn.example.com/bonus.mp4', mime: 'video/mp4' } });
    for (const k of ['season', 'episode', 'chapters', 'transcripts', 'persons', 'soundbites']) expect(v[k]).toBeUndefined();
  });

  test('an audio and a video enclosure: the audio plays, the video is the video', () => {
    const xml = FIXTURE.replace('<enclosure url="https://cdn.example.com/bonus.mp4" type="video/mp4"/>',
      '<enclosure url="https://cdn.example.com/bonus.mp4" type="video/mp4"/><enclosure url="https://cdn.example.com/bonus.m4a" type="audio/mp4"/>');
    const v = parseFeed(xml, { all: true }).episodes.find((e) => e.guid === 'ep-video');
    expect(v.audio_url).toBe('https://cdn.example.com/bonus.m4a');
    expect(v.video.url).toBe('https://cdn.example.com/bonus.mp4');
  });

  test('a routine (cut) read still sees live items placed after the episodes', () => {
    const items = Array.from({ length: 3 }, (_, i) => `<item><title>${i}</title></item>`).join('');
    const live = '<podcast:liveItem status="live"><title>L</title></podcast:liveItem>';
    const { xml, cut } = truncateItems(`<rss><channel>${items}${live}</channel></rss>`, 2);
    expect(cut).toBe(true);
    expect(xml).toBe(`<rss><channel><item><title>0</title></item><item><title>1</title></item>${live}</channel></rss>`);
  });

  test('a private key names the listener and hides the URL', () => {
    const k = privateKey('alice', 'https://u:p@feeds.example.com/x?token=SECRET');
    expect(k).toMatch(/^private:alice:[A-Za-z0-9_-]{32}$/);
    expect(k).not.toContain('SECRET');
    expect(k).not.toBe(privateKey('bob', 'https://feeds.example.com/x?token=SECRET'));
    expect(k).toBe(privateKey('alice', 'https://other:pw@feeds.example.com/x?token=SECRET'));
    expect(k).not.toBe(urlKey('https://feeds.example.com/x?token=SECRET'));
  });

  test('credentials in a URL become a Basic auth header', () => {
    expect(safe.splitCredentials('https://al%40ice:p%3Ass@feeds.example.com/x')).toEqual({
      url: 'https://feeds.example.com/x', auth: `Basic ${Buffer.from('al@ice:p:ss').toString('base64')}`,
    });
    expect(safe.splitCredentials('https://feeds.example.com/x')).toEqual({ url: 'https://feeds.example.com/x', auth: '' });
  });
});

// ─── Normalisers ──────────────────────────────────────────────────────────────

describe('chapters', () => {
  test('a Podcasting 2.0 chapters file: sorted, toc:false left out, bad entries dropped', () => {
    const body = JSON.stringify({
      version: '1.2.0',
      chapters: [
        { startTime: 120, title: 'Two', img: 'https://cdn.example.com/2.jpg', url: 'javascript:alert(1)' },
        { startTime: 0, endTime: 120, title: 'One &amp; only', url: 'https://example.com/1' },
        { startTime: 60, title: 'A marker', toc: false },
        { startTime: -1, title: 'Bad' },
        { title: 'No time' },
      ],
    });
    expect(media.chaptersFromBody(body)).toEqual([
      { start: 0, end: 120, title: 'One & only', url: 'https://example.com/1' },
      { start: 120, title: 'Two', img: 'https://cdn.example.com/2.jpg' },
    ]);
    expect(media.chaptersFromBody('<html>not json</html>')).toEqual([]);
  });

  test('inline chapters go through the same shape', () => {
    expect(media.normaliseChapters([{ start: 62.5, title: 'B' }, { start: 0, title: 'A' }])).toEqual([{ start: 0, title: 'A' }, { start: 62.5, title: 'B' }]);
  });
});

describe('transcripts', () => {
  test('WebVTT, with voices, settings and notes', () => {
    const vtt = `WEBVTT

NOTE a comment

1
00:00:01.000 --> 00:00:04.500 align:start
<v Ann Host>Hello <b>there</b>.</v>

00:04.500 --> 00:06.000
Second &amp; last`;
    expect(media.parseTranscript(vtt, 'text/vtt')).toEqual([
      { start: 1, end: 4.5, text: 'Hello there.', speaker: 'Ann Host' },
      { start: 4.5, end: 6, text: 'Second & last' },
    ]);
  });

  test('SRT, found by its look when the type says nothing useful', () => {
    const srt = '1\r\n00:00:01,000 --> 00:00:02,250\r\nOne\r\n\r\n2\r\n00:01:00,000 --> 00:01:03,000\r\nTwo\r\nlines\r\n';
    expect(media.transcriptKind(srt, 'text/plain')).toBe('srt');
    expect(media.parseTranscript(srt, 'application/octet-stream')).toEqual([
      { start: 1, end: 2.25, text: 'One' },
      { start: 60, end: 63, text: 'Two lines' },
    ]);
  });

  test('Podcasting 2.0 JSON: word-sized segments merge into sentences, per speaker', () => {
    const seg = (startTime, endTime, body, speaker = 'Ann') => ({ startTime, endTime, body, speaker });
    const json = JSON.stringify({
      version: '1.0.0',
      segments: [
        seg(0, 0.4, 'Welcome'), seg(0.4, 0.8, 'to'), seg(0.8, 1.2, 'the'), seg(1.2, 1.6, 'show'), seg(1.6, 1.7, ','),
        seg(1.7, 2, 'everybody'), seg(2, 2.5, 'who'), seg(2.5, 3, 'listens'), seg(3, 3.5, 'today.'),
        seg(3.6, 4, 'Thanks!', 'Bob'),
        seg(10, 11, 'After', 'Bob'), seg(11, 12, 'a pause.', 'Bob'),
      ],
    });
    expect(media.parseTranscript(json, 'application/json')).toEqual([
      { start: 0, end: 3.5, text: 'Welcome to the show, everybody who listens today.', speaker: 'Ann' },
      { start: 3.6, end: 4, text: 'Thanks!', speaker: 'Bob' },
      { start: 10, end: 12, text: 'After a pause.', speaker: 'Bob' },
    ]);
  });

  test('HTML with Podcasting 2.0 times and speakers', () => {
    const html = '<cite>Ann:</cite><time>0:00</time><p>Hi &amp; welcome.</p><cite>Bob:</cite><time>0:05</time><p>Hello.</p>';
    expect(media.parseTranscript(html, 'text/html')).toEqual([
      { start: 0, end: 5, text: 'Hi & welcome.', speaker: 'Ann' },
      { start: 5, end: 5, text: 'Hello.', speaker: 'Bob' },
    ]);
  });

  test('plain HTML or text without times: one cue per paragraph at 0', () => {
    expect(media.parseTranscript('<p>First para.</p><p>Second <i>one</i>.</p>', 'text/html')).toEqual([
      { start: 0, end: 0, text: 'First para.' }, { start: 0, end: 0, text: 'Second one.' },
    ]);
    expect(media.parseTranscript('One.\n\nTwo.\n', 'text/plain')).toEqual([{ start: 0, end: 0, text: 'One.' }, { start: 0, end: 0, text: 'Two.' }]);
  });

  test('picking a transcript: the language asked for (or its base), best format first', () => {
    const list = [
      { url: 'a', type: 'text/html', lang: 'en' },
      { url: 'b', type: 'application/json', lang: 'en-us' },
      { url: 'c', type: 'text/vtt', lang: 'en' },
      { url: 'd', type: 'application/srt', lang: 'de' },
    ];
    expect(media.pickTranscripts(list, 'en').map((t) => t.url)).toEqual(['c', 'b', 'a']);
    expect(media.pickTranscripts(list, 'de-at').map((t) => t.url)).toEqual(['d']);
    expect(media.pickTranscripts(list, '', 'de').map((t) => t.url)).toEqual(['d']);
    expect(media.pickTranscripts(list, 'fr').map((t) => t.url)).toEqual(['c', 'b', 'd', 'a']);
    expect(media.transcriptLanguages(list)).toEqual(['en', 'en-us', 'de']);
  });

  test('the cache keeps hits, ages them out and keeps to its size', () => {
    const c = media.makeCache({ maxEntries: 2 });
    c.set('a', [1], 60000);
    c.set('b', [2], 60000);
    c.get('a');
    c.set('c', [3], 60000);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toEqual([1]);
    c.set('old', [4], -1);
    expect(c.get('old')).toBeUndefined();
  });
});

// ─── The API ──────────────────────────────────────────────────────────────────

const PUB = new ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa');
const PRIV = new ObjectId('bbbbbbbbbbbbbbbbbbbbbbbb');
const pubEp = (n, title, extra = {}) => ({
  _id: `${PUB.toHexString()}:pub-episode-${String(n).padStart(4, '0')}`, feed_id: PUB, title, audio_url: `https://cdn.example.com/${n}.mp3`,
  mime: 'audio/mpeg', published_at: new Date(Date.UTC(2026, 9, n)), first_seen_at: new Date(), ...extra,
});
const PRIV_EP = `${PRIV.toHexString()}:priv-episode-001`;
const vouch = (user) => `vu=${user}&vts=${Date.now()}&vsig=good-${user}`;

function seed() {
  for (const k of Object.keys(store)) delete store[k];
  store.podcast_feeds = [
    {
      _id: PUB, url: 'https://feeds.example.com/pub.xml', url_key: 'feeds.example.com/pub.xml', alt_keys: [], title: 'Public Show', status: 'ok', subscribers: 1,
      persons: [{ name: 'Ann', role: 'host', group: 'cast' }],
      live: [
        { id: 'now', title: 'On air', status: 'live', start: new Date(Date.now() - 3600e3), url: 'https://s.example.com/l.mp3', mime: 'audio/mpeg' },
        { id: 'over', title: 'Over', status: 'live', start: new Date(Date.now() - 7200e3), end: new Date(Date.now() - 60e3), url: 'https://s.example.com/o.mp3', mime: 'audio/mpeg' },
        { id: 'stale', title: 'Stale', status: 'live', start: new Date(Date.now() - 48 * 3600e3), url: 'https://s.example.com/s.mp3', mime: 'audio/mpeg' },
      ],
    },
    {
      _id: PRIV, url: 'https://alice:hunter2@premium.example.com/feed?token=SECRET', url_key: privateKey('alice', 'https://premium.example.com/feed?token=SECRET'),
      alt_keys: [], title: 'Premium Show', status: 'ok', subscribers: 1, private: true, owner: 'alice', last_followed_at: new Date(),
    },
  ];
  store.podcast_episodes = [
    pubEp(1, 'Talking about Rust (and C++)', { summary: 'memory safety' }),
    pubEp(2, 'Gardening hour', { summary: 'tomatoes and RUST on tools', season: 2, episode: 3, chapters: true, chapters_url: 'https://cdn.example.com/c.json', transcripts: [{ url: 'https://cdn.example.com/t.vtt', type: 'text/vtt', lang: 'en' }] }),
    pubEp(3, 'Cooking', { summary: 'pasta' }),
    { _id: PRIV_EP, feed_id: PRIV, private: true, title: 'Bonus for members', audio_url: 'https://premium.example.com/audio/1.mp3?token=SECRET', mime: 'audio/mpeg', published_at: new Date(Date.UTC(2026, 9, 4)), first_seen_at: new Date() },
  ];
  store.podcast_subs = [
    { _id: `alice|${PUB.toHexString()}`, user: 'alice', feed_id: PUB, added_at: new Date(0), notify: true },
    { _id: `alice|${PRIV.toHexString()}`, user: 'alice', feed_id: PRIV, added_at: new Date(0), notify: true },
  ];
}

describe('episode search (?q=)', () => {
  beforeEach(seed);

  test('title or summary, any case, newest first, with a total', async () => {
    const r = await request(app).get(`/podcasts/feed/${PUB.toHexString()}?q=rust`);
    expect(r.status).toBe(200);
    expect(r.body.episodes.map((e) => e.title)).toEqual(['Gardening hour', 'Talking about Rust (and C++)']);
    expect(r.body.total).toBe(2);
  });

  test('regex characters are just text', async () => {
    const r = await request(app).get(`/podcasts/feed/${PUB.toHexString()}?q=${encodeURIComponent('(and C++)')}`);
    expect(r.body.episodes.map((e) => e.title)).toEqual(['Talking about Rust (and C++)']);
    const none = await request(app).get(`/podcasts/feed/${PUB.toHexString()}?q=${encodeURIComponent('.*')}`);
    expect(none.body.episodes).toEqual([]);
  });

  test('/older pages through the matches', async () => {
    const r = await request(app).get(`/podcasts/feed/${PUB.toHexString()}/older?q=RUST&offset=1&limit=1`);
    expect(r.body.episodes.map((e) => e.title)).toEqual(['Talking about Rust (and C++)']);
    expect(r.body).toMatchObject({ total: 2, next_offset: 2 });
  });

  test('episodes carry the new fields, never the file addresses', async () => {
    const r = await request(app).get(`/podcasts/feed/${PUB.toHexString()}`);
    const ep = r.body.episodes.find((e) => e.title === 'Gardening hour');
    expect(ep).toMatchObject({ season: 2, episode: 3, chapters: true, transcripts: [{ lang: 'en', type: 'text/vtt' }] });
    expect(JSON.stringify(r.body)).not.toContain('t.vtt');
    expect(JSON.stringify(r.body)).not.toContain('c.json');
    // The show: its people and only the live items still on.
    expect(r.body.feed.persons).toEqual([{ name: 'Ann', role: 'host', group: 'cast' }]);
    expect(r.body.feed.live.map((l) => l.id)).toEqual(['now']);
  });
});

describe('private feeds', () => {
  beforeEach(seed);
  const leaks = (body) => /hunter2|SECRET|premium\.example\.com\/feed/.test(JSON.stringify(body));

  test('a single read without the vouch is a 404', async () => {
    for (const path of [`/feed/${PRIV.toHexString()}`, `/feed/${PRIV.toHexString()}/older`, `/episode/${PRIV_EP}`, `/episode/${PRIV_EP}/chapters`, `/episode/${PRIV_EP}/transcript`, `/episode/${PRIV_EP}/download`]) {
      const r = await request(app).get(`/podcasts${path}`);
      expect([path, r.status]).toEqual([path, 404]);
    }
  });

  test('a vouch of someone who does not follow it, or a bad one, is a 404 too', async () => {
    expect((await request(app).get(`/podcasts/episode/${PRIV_EP}?${vouch('bob')}`)).status).toBe(404);
    expect((await request(app).get(`/podcasts/episode/${PRIV_EP}?vu=alice&vts=${Date.now()}&vsig=forged`)).status).toBe(404);
    expect((await request(app).get(`/podcasts/episode/${PRIV_EP}?vu=alice&vts=${Date.now() - 3 * 86400e3}&vsig=good-alice`)).status).toBe(404);
  });

  test('the follower with a vouch reads it, without the feed URL', async () => {
    const r = await request(app).get(`/podcasts/feed/${PRIV.toHexString()}?${vouch('alice')}`);
    expect(r.status).toBe(200);
    expect(r.body.feed).toMatchObject({ url: '', private: true, title: 'Premium Show' });
    expect(r.body.episodes[0]).toMatchObject({ private: true, title: 'Bonus for members' });
    const one = await request(app).get(`/podcasts/episode/${PRIV_EP}?${vouch('alice')}`);
    expect(one.status).toBe(200);
    expect(one.body.feed.url).toBe('');
    expect(one.body.episode.private).toBe(true);
  });

  test('lists leave it out without the vouch, and never show its URL or key', async () => {
    const subs = await request(app).get('/podcasts/subscriptions?user=alice');
    expect(subs.body.subscriptions.map((s) => s.title)).toEqual(['Public Show']);
    const latest = await request(app).get('/podcasts/latest?user=alice');
    expect(latest.body.episodes.some((e) => e.private)).toBe(false);
    const notes = await request(app).get('/podcasts/notifications?user=alice');
    expect(notes.body.episodes.some((e) => e.private)).toBe(false);
    // Another user's vouch does not count for alice's lists.
    const other = await request(app).get(`/podcasts/subscriptions?user=alice&${vouch('bob')}`);
    expect(other.body.subscriptions).toHaveLength(1);

    const withVouch = await request(app).get(`/podcasts/subscriptions?user=alice&${vouch('alice')}`);
    const priv = withVouch.body.subscriptions.find((s) => s.private);
    expect(priv).toMatchObject({ url: '', keys: [], title: 'Premium Show' });
    expect(leaks(withVouch.body)).toBe(false);
    const latest2 = await request(app).get(`/podcasts/latest?user=alice&${vouch('alice')}`);
    expect(latest2.body.episodes.some((e) => e.private)).toBe(true);
    expect(latest2.body.feeds[PRIV.toHexString()].url).toBe('');
  });

  test('never in /discover', async () => {
    const r = await request(app).get('/podcasts/discover');
    const all = [...r.body.top, ...r.body.recent];
    expect(all.map((f) => f.title)).toEqual(expect.arrayContaining(['Public Show']));
    expect(all.some((f) => f.title === 'Premium Show')).toBe(false);
  });

  test('subscribing with a password: a private row of its own, probed with the credentials, nothing echoed', async () => {
    podcastFeeds.ask.mockImplementation(async (type, payload) => {
      const id = new ObjectId();
      store.podcast_feeds.push({ _id: id, url: payload.url, url_key: privateKey(payload.owner, payload.url), private: true, owner: payload.owner, status: 'ok', last_ok_at: new Date(), subscribers: 0 });
      return { ok: true, feed_id: id.toHexString() };
    });
    const resolveLink = jest.spyOn(directories, 'resolveLink');
    const url = 'https://carol:pa55@feeds.example.com/pub.xml';
    const r = await request(app).post('/podcasts/subscribe').send({ user: 'carol', urls: [url], signature: 'good-carol', timestamp: Date.now() });
    expect(r.body.success).toBe(true);
    expect(r.body.results[0]).toMatchObject({ ok: true, private: true, url: 'https://feeds.example.com/pub.xml' });
    expect(JSON.stringify(r.body)).not.toContain('pa55');
    // Not looked up anywhere, not joined to the public row of the same address.
    expect(resolveLink).not.toHaveBeenCalled();
    expect(podcastFeeds.ask).toHaveBeenCalledWith('probe', { url, private: true, owner: 'carol' }, expect.any(Number));
    expect(r.body.results[0].feed_id).not.toBe(PUB.toHexString());
    resolveLink.mockRestore();
  });

  test('private: [true] makes a token URL private too; a batch row is marked', async () => {
    const r = await request(app).post('/podcasts/subscribe').send({
      user: 'dave', urls: ['https://premium.example.com/feed?token=DAVE', 'https://other.example.com/rss'], private: [true, false],
      signature: 'good-dave', timestamp: Date.now(),
    });
    expect(r.body.results.map((x) => !!x.private)).toEqual([true, false]);
    const row = store.podcast_feeds.find((f) => f.url === 'https://premium.example.com/feed?token=DAVE');
    expect(row).toMatchObject({ private: true, owner: 'dave', url_key: privateKey('dave', 'https://premium.example.com/feed?token=DAVE') });
    expect(store.podcast_feeds.find((f) => f.url === 'https://other.example.com/rss').private).toBeUndefined();
  });
});

describe('chapters and transcript endpoints', () => {
  beforeEach(() => { seed(); safe.safeFetch.mockReset(); });

  test('remote chapters are fetched once and cached; 404 when there are none', async () => {
    safe.safeFetch.mockResolvedValue({ body: Buffer.from(JSON.stringify({ chapters: [{ startTime: 5, title: 'B' }, { startTime: 0, title: 'A' }] })) });
    const id = store.podcast_episodes[1]._id;
    const r = await request(app).get(`/podcasts/episode/${id}/chapters`);
    expect(r.status).toBe(200);
    expect(r.body.chapters).toEqual([{ start: 0, title: 'A' }, { start: 5, title: 'B' }]);
    await request(app).get(`/podcasts/episode/${id}/chapters`);
    expect(safe.safeFetch).toHaveBeenCalledTimes(1);
    expect(safe.safeFetch.mock.calls[0][0]).toBe('https://cdn.example.com/c.json');
    const none = await request(app).get(`/podcasts/episode/${store.podcast_episodes[0]._id}/chapters`);
    expect(none.status).toBe(404);
    expect(none.body.error).toBe('no_chapters');
  });

  test('a transcript becomes cues with its languages', async () => {
    safe.safeFetch.mockResolvedValue({ body: Buffer.from('WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHi.\n') });
    const r = await request(app).get(`/podcasts/episode/${store.podcast_episodes[1]._id}/transcript?lang=en`);
    expect(r.body).toMatchObject({ lang: 'en', languages: ['en'], cues: [{ start: 0, end: 2, text: 'Hi.' }] });
    const none = await request(app).get(`/podcasts/episode/${store.podcast_episodes[0]._id}/transcript`);
    expect(none.status).toBe(404);
    expect(none.body.error).toBe('no_transcript');
  });
});

describe('download proxy', () => {
  beforeEach(() => { seed(); safe.safeStream.mockReset(); });
  const upstream = (status, headers, body = 'abc') => {
    const stream = Readable.from([Buffer.from(body)]);
    return { status, headers, url: 'https://cdn.example.com/2.mp3', stream, abort: jest.fn(() => stream.destroy()) };
  };

  test('streams the episode own file with its type and length, CORS-readable, Range passed on', async () => {
    safe.safeStream.mockResolvedValue(upstream(206, { 'content-type': 'audio/mpeg', 'content-length': '3', 'content-range': 'bytes 0-2/3000', 'accept-ranges': 'bytes' }));
    const r = await request(app).get(`/podcasts/episode/${store.podcast_episodes[1]._id}/download`).set('Range', 'bytes=0-2');
    expect(r.status).toBe(206);
    expect(r.headers['content-type']).toBe('audio/mpeg');
    expect(r.headers['content-length']).toBe('3');
    expect(r.headers['content-range']).toBe('bytes 0-2/3000');
    expect(r.headers['access-control-expose-headers']).toContain('Content-Range');
    expect(r.headers['content-disposition']).toBe('attachment; filename="Gardening hour.mp3"');
    expect(r.body.toString()).toBe('abc');
    expect(safe.safeStream).toHaveBeenCalledWith('https://cdn.example.com/2.mp3', expect.objectContaining({ headers: { Range: 'bytes=0-2' }, auth: '' }));
  });

  test('a host that says text/html is served as bytes, not as a page', async () => {
    safe.safeStream.mockResolvedValue(upstream(200, { 'content-type': 'text/html' }));
    const r = await request(app).get(`/podcasts/episode/${store.podcast_episodes[0]._id}/download`).buffer(true);
    expect(r.headers['content-type']).toBe('audio/mpeg');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });

  test('413 when bigger than the cap, 502 when the host fails, 416 passed on', async () => {
    safe.safeStream.mockResolvedValue(upstream(200, { 'content-type': 'audio/mpeg', 'content-length': String(500 * 1024 * 1024) }));
    expect((await request(app).get(`/podcasts/episode/${store.podcast_episodes[0]._id}/download`)).status).toBe(413);
    safe.safeStream.mockRejectedValue(Object.assign(new Error('x'), { code: 'http_503' }));
    const bad = await request(app).get(`/podcasts/episode/${store.podcast_episodes[0]._id}/download`);
    expect(bad.status).toBe(502);
    expect(bad.body.code).toBe('http_503');
    safe.safeStream.mockRejectedValue(Object.assign(new Error('x'), { code: 'http_416' }));
    expect((await request(app).get(`/podcasts/episode/${store.podcast_episodes[0]._id}/download`).set('Range', 'bytes=99999999-')).status).toBe(416);
  });

  test('a private episode: only for its follower, with the feed password for the feed host only', async () => {
    safe.safeStream.mockResolvedValue(upstream(200, { 'content-type': 'audio/mpeg', 'content-length': '3' }));
    const r = await request(app).get(`/podcasts/episode/${PRIV_EP}/download?${vouch('alice')}`);
    expect(r.status).toBe(200);
    expect(safe.safeStream).toHaveBeenCalledWith('https://premium.example.com/audio/1.mp3?token=SECRET', expect.objectContaining({
      auth: `Basic ${Buffer.from('alice:hunter2').toString('base64')}`,
    }));
  });

  test('a range from the middle continues a download (own, wider limit)', () => {
    const { continuesDownload } = router._test;
    expect(continuesDownload({ headers: {} })).toBe(false);
    expect(continuesDownload({ headers: { range: 'bytes=0-' } })).toBe(false);
    expect(continuesDownload({ headers: { range: 'bytes=5000-' } })).toBe(true);
  });
});

// ─── Listen credit ────────────────────────────────────────────────────────────

describe('listen credit at higher speeds', () => {
  const T0 = Date.parse('2026-10-30T12:00:00Z');
  const session = () => ({
    duration: 3600, bucketCount: 100, lastPosition: 0, maxPosition: 0, coveredBuckets: [],
    accumulatedMs: 0, contentMs: 0, hiddenContentMs: 0, rateSum: 0, rateBeats: 0, lastBeatAt: new Date(T0),
  });

  test('3x with skipped silences (4x audio in the time) still counts, credited as wall time', () => {
    const b = L.applyBeat(session(), { now: T0 + 10000, position: 40, rate: 3 });
    expect(b.counted).toBe(true);
    expect(b.stats.listenedSeconds).toBe(10);
    expect(b.stats.contentSeconds).toBe(40);
  });

  test('4x counts, with room for a beat that arrives a little early', () => {
    expect(L.applyBeat(session(), { now: T0 + 9500, position: 40, rate: 4 }).counted).toBe(true);
  });

  test('beyond 4x (with its slack) is a seek', () => {
    expect(L.applyBeat(session(), { now: T0 + 10000, position: 50, rate: 4 }).counted).toBe(false);
  });

  test('the reported rate sets the bar: at 1x, 40 s in 10 s is a seek', () => {
    expect(L.applyBeat(session(), { now: T0 + 10000, position: 40, rate: 1 }).counted).toBe(false);
    expect(L.applyBeat(session(), { now: T0 + 10000, position: 25 }).counted).toBe(true);
  });

  test('the 12 s floor stays for quick beats', () => {
    expect(L.applyBeat(session(), { now: T0 + 1000, position: 12, rate: 1 }).counted).toBe(true);
    expect(L.MAX_CONTIGUOUS_RATE).toBe(4);
  });
});
