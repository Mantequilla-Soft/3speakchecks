/**
 * routes/rss.js, the Podcasting 2.0 tags: season/episode, chapters (and the JSON
 * chapters file they link), transcripts (captions as SRT/VTT, the uploader's
 * text transcript), person, funding, soundbites from audiograms, and liveItem
 * from the live server. Every feed is parsed back as XML and checked by tag.
 *
 * Real MongoDB; Hive, the subtitle files and the live server are stand-ins.
 */
const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const { NOW, pinClock, startStub, parseXml, asList, binaryParser } = require('./_fixtures');

jest.mock('../../utils/hive', () => ({ ...jest.requireActual('../../utils/hive'), hiveRpcBatch: jest.fn() }));
jest.mock('../../utils/podcastCover', () => ({ renderCover: jest.fn() }));
jest.mock('../../routes/subtitleProxy', () => {
  const actual = jest.requireActual('../../routes/subtitleProxy');
  const fake = jest.fn();
  const router = actual;
  router.fetchSubtitleText = fake;
  return router;
});
const { hiveRpcBatch } = require('../../utils/hive');
const subtitleProxy = require('../../routes/subtitleProxy');
const { liveItemsFrom, clearLiveCache } = require('../../utils/liveItems');
const postMeta = require('../../utils/postMeta');

const rssRouter = require('../../routes/rss');
const app = buildApp(['/rss', rssRouter]);
const db = testDb.use();

const day = (n) => new Date(NOW.getTime() - n * 24 * 3600 * 1000);
const SRT = '1\n00:00:01,000 --> 00:00:03,500\nHello there\n\n2\n00:00:04,000 --> 00:00:06,000\nSecond line\n\n';

const audio = (permlink, extra = {}) => ({
  owner: 'badadib', permlink: `a-${permlink}`, post_permlink: permlink, title: `Audio ${permlink}`, description: `Notes ${permlink}`,
  createdAt: day(2), status: 'published', audio_cid: `bafyorig${permlink}`, format: 'mp3', size: 2000, duration: 1800, category: 'podcast', ...extra,
});
const embedVideo = (permlink, extra = {}) => ({
  owner: 'badadib', hive_author: 'badadib', hive_permlink: permlink, hive_title: `Video ${permlink}`, hive_body: `Body ${permlink}`,
  permlink: `embed-${permlink}`, createdAt: day(3), status: 'published', short: false, listed_on_3speak: true,
  manifest_cid: `bafyhls${permlink}`, duration: 600, thumbnail_url: `https://images.3speak.tv/${permlink}.png`, ...extra,
});

/** Hive answers: accounts and posts by "author/permlink". */
function hiveAnswers({ accounts = {}, posts = {} } = {}) {
  hiveRpcBatch.mockImplementation(async (batch) => batch.map((req) => {
    if (req.method === 'condenser_api.get_accounts') {
      const name = req.params[0][0];
      return { id: req.id, result: accounts[name] ? [accounts[name]] : [] };
    }
    if (req.method === 'condenser_api.get_content') {
      return { id: req.id, result: posts[req.params.join('/')] || null };
    }
    return { id: req.id, result: null };
  }));
}
const post = (author, permlink, { title = '', body = '', meta = {} } = {}) => ({
  author, permlink, title, body, json_metadata: JSON.stringify(meta),
});

async function feed(path, status = 200) {
  const res = await request(app).get(path).buffer(true).parse(binaryParser).expect(status);
  const xml = res.body.toString('utf8');
  return { res, xml, doc: parseXml(xml) };
}
const itemsOf = (doc) => asList(doc.rss.channel.item);
const textOf = (node) => (node && typeof node === 'object' ? node['#text'] : node);

let live;
const liveState = { streams: [], events: [], ended: [] };

beforeAll(async () => {
  live = await startStub((a) => {
    a.get('/streams', (_q, r) => r.json(liveState.streams));
    a.get('/events', (q, r) => r.json(q.query.status === 'ended' ? liveState.ended : liveState.events));
  });
  process.env.LIVE_ROOM_API_URLS = live.url;
});
afterAll(async () => {
  delete process.env.LIVE_ROOM_API_URLS;
  await live.close();
});

beforeEach(() => {
  pinClock();
  hiveRpcBatch.mockReset();
  hiveAnswers();
  subtitleProxy.fetchSubtitleText.mockReset();
  rssRouter._clearPostCache();
  clearLiveCache();
  liveState.streams = [];
  liveState.events = [];
  liveState.ended = [];
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.useRealTimers());

// ─── utils/postMeta.js ──────────────────────────────────────────────────────

describe('what a post says about its episode (utils/postMeta.js)', () => {
  test('chapters from the timeline metadata win over the text', () => {
    const meta = { video: { chapters: [{ start: 0, title: 'Intro' }, { start: 95.7, title: 'Setup' }] } };
    expect(postMeta.chaptersOfPost({ body: '0:00 a\n1:00 b\n2:00 c', json_metadata: meta, duration: 600 }))
      .toEqual([{ start: 0, title: 'Intro' }, { start: 95, title: 'Setup' }]);
  });

  test('chapters from a list of timestamped lines: three or more, in order, markdown links read as text', () => {
    const body = 'Show notes\n\n[0:00](https://3speak.tv/watch?v=badadib/x&t=0) Intro\n- 12:40 Questions\n1:02:03 - Wrap up\n\nThanks';
    expect(postMeta.chaptersOfPost({ body, json_metadata: {}, duration: 4000 }))
      .toEqual([{ start: 0, title: 'Intro' }, { start: 760, title: 'Questions' }, { start: 3723, title: 'Wrap up' }]);
    expect(postMeta.chaptersOfPost({ body: '0:00 one\n1:00 two', json_metadata: {} })).toEqual([]);
    // A list that does not start at 0:00 gets an untitled first chapter.
    expect(postMeta.bodyChapters('1:00 a\n2:00 b\n3:00 c', 600)[0]).toEqual({ start: 0, title: '' });
  });

  test('season and episode from the audio or video block, whole numbers only', () => {
    expect(postMeta.seasonEpisodeOf({ audio: { season: 2, episode: '5' } })).toEqual({ season: 2, episode: 5 });
    expect(postMeta.seasonEpisodeOf({ video: { episode: 12 } })).toEqual({ season: null, episode: 12 });
    expect(postMeta.seasonEpisodeOf({ audio: { season: 0, episode: 1.5 } })).toEqual({ season: null, episode: null });
    expect(postMeta.seasonEpisodeOf('not json')).toEqual({ season: null, episode: null });
  });

  test('the audiogram a Short was cut from, with its piece when recorded', () => {
    expect(postMeta.audiogramOf({ '3speak': { audiogram: { author: 'badadib', permlink: 'ep-1', start: 73.04, duration: 30 } } }))
      .toEqual({ author: 'badadib', permlink: 'ep-1', start: 73, duration: 30 });
    expect(postMeta.audiogramOf({ '3speak': { audiogram: { author: 'badadib', permlink: 'ep-1' } } }))
      .toEqual({ author: 'badadib', permlink: 'ep-1', start: null, duration: null });
    expect(postMeta.audiogramOf({ '3speak': { audiogram: { author: 'Bad Name', permlink: 'x' } } })).toBeNull();
  });

  test('the transcript block, under its heading in any of the site languages', () => {
    expect(postMeta.transcriptFromBody('Notes\n\n**Transcript**\n\nHello world.\n\nMore.')).toBe('Hello world.\n\nMore.');
    expect(postMeta.transcriptFromBody('Notes\n\n**Transkript**\n\nHallo.\n\n---\n\nfooter')).toBe('Hallo.');
    expect(postMeta.transcriptFromBody('A post that says **Transcript** inline')).toBe('');
  });
});

describe('liveItemsFrom (utils/liveItems.js)', () => {
  test('live rooms first, then upcoming soonest first, then recently ended; only the host, only public', () => {
    const items = liveItemsFrom('badadib', {
      openRooms: [
        { name: 'room-a', mode: 'standalone', host: 'badadib', live: true, createdAt: '2026-11-01T11:00:00Z', title: 'On air' },
        { name: 'room-b', mode: 'standalone', host: 'fan', live: true, createdAt: '2026-11-01T11:00:00Z' },
        { name: 'room-c', mode: 'conference', host: 'badadib', live: true, createdAt: '2026-11-01T11:00:00Z' },
        { name: 'room-d', mode: 'standalone', host: 'badadib', live: false, createdAt: '2026-11-01T11:00:00Z' },
      ],
      upcoming: [
        { id: 'e2', hostUsername: 'badadib', status: 'scheduled', scheduledAt: '2026-11-05T18:00:00Z', title: 'Later', visibility: 'public' },
        { id: 'e1', hostUsername: 'badadib', status: 'scheduled', scheduledAt: '2026-11-02T18:00:00Z', title: 'Soon', visibility: 'public' },
        { id: 'e3', hostUsername: 'badadib', status: 'scheduled', scheduledAt: '2026-11-02T18:00:00Z', title: 'Hidden', visibility: 'hive-only' },
        { id: 'e4', hostUsername: 'badadib', status: 'live', scheduledAt: '2026-11-01T11:00:00Z', roomName: 'room-a', visibility: 'public' },
      ],
      ended: [
        { id: 'e5', hostUsername: 'badadib', status: 'ended', scheduledAt: '2026-10-30T18:00:00Z', updatedAt: '2026-10-30T19:00:00Z', visibility: 'public' },
        { id: 'e6', hostUsername: 'badadib', status: 'ended', scheduledAt: '2026-09-01T18:00:00Z', updatedAt: '2026-09-01T19:00:00Z', visibility: 'public' },
      ],
    }, NOW.getTime());
    expect(items.map((i) => [i.id, i.status])).toEqual([
      ['room:room-a', 'live'], ['event:e1', 'pending'], ['event:e2', 'pending'], ['event:e5', 'ended'],
    ]);
    expect(items[3]).toMatchObject({ start: '2026-10-30T18:00:00.000Z', end: '2026-10-30T19:00:00.000Z' });
  });
});

// ─── The channel feed ───────────────────────────────────────────────────────

describe('GET /rss/:username.xml, Podcasting 2.0 tags', () => {
  async function seedChannel() {
    await db().collection('embed-audio').insertOne(audio('ep-2', { createdAt: day(2) }));
    await db().collection('embed-video').insertOne(embedVideo('talk'));
    // A Short made from an audiogram of ep-2 (its body links the episode).
    await db().collection('embed-video').insertOne(embedVideo('teaser', {
      short: true, createdAt: day(2), hive_title: '',
      hive_body: 'A taste\n\n🎧 [Full episode](https://3speak.tv/audio/badadib/ep-2)',
    }));
    await db().collection('subtitles').insertOne({ author: 'badadib', permlink: 'embed-talk', subtitles: { en: 'QmSubtitleEnglishCidAaaaaaaaaaaaaaaaaaaaaaaaaa', es: 'QmSubtitleSpanishCidAaaaaaaaaaaaaaaaaaaaaaaaaa' } });
    hiveAnswers({
      accounts: { badadib: { name: 'badadib', posting_json_metadata: JSON.stringify({ profile: { name: 'Bad Adib' } }) } },
      posts: {
        'badadib/ep-2': post('badadib', 'ep-2', {
          title: 'Episode two',
          body: 'Notes\n\n0:00 Intro\n5:00 Guest\n20:00 Questions\n\n**Transcript**\n\nWelcome to the show.',
          meta: { audio: { type: 'podcast', season: 2, episode: 5 } },
        }),
        'badadib/talk': post('badadib', 'talk', { title: 'Video talk', body: 'Body', meta: { video: { episode: 7 } } }),
        'badadib/teaser': post('badadib', 'teaser', {
          title: 'The best minute',
          meta: { '3speak': { audiogram: { author: 'badadib', permlink: 'ep-2', start: 300, duration: 45.5 } } },
        }),
      },
    });
  }

  test('channel: the creator as host with avatar and channel link, a funding link, no new guid', async () => {
    await seedChannel();
    const { doc } = await feed('/rss/badadib.xml');
    const ch = doc.rss.channel;
    expect(doc.rss['@_xmlns:podcast']).toBe('https://podcastindex.org/namespace/1.0');
    expect(ch['podcast:person']).toMatchObject({
      '#text': 'Bad Adib', '@_role': 'host',
      '@_img': 'https://images.hive.blog/u/badadib/avatar/large', '@_href': 'https://3speak.tv/user/badadib',
    });
    expect(ch['podcast:funding']).toMatchObject({ '#text': 'Support @badadib on 3Speak', '@_url': 'https://3speak.tv/user/badadib' });
    expect(ch['podcast:guid']).toBeUndefined();
    expect(ch['podcast:liveItem']).toBeUndefined();
  });

  test('items: season and episode, chapters file, transcripts, soundbite, guids as before', async () => {
    await seedChannel();
    const { doc } = await feed('/rss/badadib.xml');
    const items = itemsOf(doc);
    expect(items.map((i) => textOf(i.guid))).toEqual(['hive.blog/@badadib/ep-2', 'hive.blog/@badadib/talk']);
    const [ep, talk] = items;

    expect(ep['podcast:season']).toBe('2');
    expect(ep['podcast:episode']).toBe('5');
    expect(ep['itunes:season']).toBe('2');
    expect(ep['itunes:episode']).toBe('5');
    expect(ep['podcast:chapters']).toMatchObject({
      '@_url': 'https://checker.3speak.tv/rss/chapters/badadib/ep-2.json', '@_type': 'application/json+chapters',
    });
    expect(asList(ep['podcast:transcript'])).toEqual([
      expect.objectContaining({ '@_url': 'https://checker.3speak.tv/rss/transcript/badadib/ep-2.txt', '@_type': 'text/plain' }),
    ]);
    expect(ep['podcast:soundbite']).toMatchObject({ '#text': 'The best minute', '@_startTime': '300.0', '@_duration': '45.5' });

    expect(talk['podcast:season']).toBeUndefined();
    expect(talk['podcast:episode']).toBe('7');
    expect(talk['podcast:chapters']).toBeUndefined();
    expect(asList(talk['podcast:transcript']).map((tr) => [tr['@_type'], tr['@_language'], tr['@_rel'], tr['@_url']])).toEqual([
      ['text/vtt', 'en', 'captions', 'https://checker.3speak.tv/rss/transcript/badadib/talk/en.vtt'],
      ['application/x-subrip', 'en', 'captions', 'https://checker.3speak.tv/rss/transcript/badadib/talk/en.srt'],
      ['text/vtt', 'es', 'captions', 'https://checker.3speak.tv/rss/transcript/badadib/talk/es.vtt'],
      ['application/x-subrip', 'es', 'captions', 'https://checker.3speak.tv/rss/transcript/badadib/talk/es.srt'],
    ]);
    // The Short is not an episode of its own.
    expect(items.find((i) => textOf(i.guid).endsWith('/teaser'))).toBeUndefined();
  });

  test('a Short without a recorded start is no soundbite, nor is one linking another episode', async () => {
    await db().collection('embed-audio').insertOne(audio('ep-2'));
    await db().collection('embed-video').insertMany([
      embedVideo('t1', { short: true, createdAt: day(2), hive_body: 'https://3speak.tv/audio/badadib/ep-2' }),
      embedVideo('t2', { short: true, createdAt: day(2), hive_body: 'https://3speak.tv/audio/badadib/other' }),
    ]);
    hiveAnswers({
      posts: {
        'badadib/t1': post('badadib', 't1', { meta: { '3speak': { audiogram: { author: 'badadib', permlink: 'ep-2' } } } }),
        'badadib/t2': post('badadib', 't2', { meta: { '3speak': { audiogram: { author: 'badadib', permlink: 'other', start: 1, duration: 10 } } } }),
      },
    });
    const { doc } = await feed('/rss/badadib.xml');
    expect(itemsOf(doc)[0]['podcast:soundbite']).toBeUndefined();
  });

  test('liveItem: a live stream and an upcoming one, with status, start, guid and the watch link', async () => {
    await seedChannel();
    liveState.streams = [{ name: 'room-a', mode: 'standalone', host: 'badadib', live: true, createdAt: '2026-11-01T11:30:00Z', title: 'Live Q&A', visibility: 'public' }];
    liveState.events = [{ id: '6720aaaaaaaaaaaaaaaaaaaa', hostUsername: 'badadib', status: 'scheduled', scheduledAt: '2026-11-03T18:00:00Z', title: 'Album launch', visibility: 'public' }];
    const { doc } = await feed('/rss/badadib.xml');
    const lives = asList(doc.rss.channel['podcast:liveItem']);
    expect(lives.map((l) => [l['@_status'], l['@_start'], l.title])).toEqual([
      ['live', '2026-11-01T11:30:00.000Z', 'Live Q&A'],
      ['pending', '2026-11-03T18:00:00.000Z', 'Album launch'],
    ]);
    expect(lives[0].link).toBe('https://3speak.tv/watch/room-a');
    expect(lives[0].enclosure).toMatchObject({ '@_url': 'https://3speak.tv/watch/room-a', '@_type': 'text/html' });
    expect(lives[0]['podcast:contentLink']).toMatchObject({ '@_href': 'https://3speak.tv/watch/room-a' });
    expect(textOf(lives[0].guid)).toBe('3speak.tv/live/badadib/room:room-a');
    expect(lives[1].link).toBe('https://3speak.tv/user/badadib');
    expect(lives[0]['podcast:person']).toMatchObject({ '@_role': 'host' });
  });

  test('the live server being down only means no live items', async () => {
    await seedChannel();
    process.env.LIVE_ROOM_API_URLS = 'http://127.0.0.1:1';
    try {
      const { doc } = await feed('/rss/badadib.xml');
      expect(doc.rss.channel['podcast:liveItem']).toBeUndefined();
      expect(itemsOf(doc)).toHaveLength(2);
    } finally {
      process.env.LIVE_ROOM_API_URLS = live.url;
    }
  });
});

// ─── The files the tags link ────────────────────────────────────────────────

describe('GET /rss/chapters/:owner/:permlink.json', () => {
  test('Podcast Namespace JSON chapters, inside the episode', async () => {
    await db().collection('embed-audio').insertOne(audio('ep-2', { duration: 1000 }));
    hiveAnswers({ posts: { 'badadib/ep-2': post('badadib', 'ep-2', { title: 'Episode two', body: '0:00 Intro\n5:00 Guest\n20:00 Past the end' }) } });
    const res = await request(app).get('/rss/chapters/badadib/ep-2.json').expect(200);
    expect(res.headers['content-type']).toMatch(/^application\/json\+chapters/);
    expect(JSON.parse(res.text)).toEqual({
      version: '1.2.0',
      title: 'Episode two',
      chapters: [{ startTime: 0, title: 'Intro' }, { startTime: 300, title: 'Guest' }],
    });
  });

  test('404 without chapters, for an unknown episode and for a hidden creator; 400 for a bad name', async () => {
    await db().collection('embed-audio').insertOne(audio('ep-2'));
    hiveAnswers({ posts: { 'badadib/ep-2': post('badadib', 'ep-2', { body: 'no list here' }) } });
    await request(app).get('/rss/chapters/badadib/ep-2.json').expect(404);
    await request(app).get('/rss/chapters/badadib/nothing.json').expect(404);
    await request(app).get('/rss/chapters/Bad%20Name/x.json').expect(400);
    hiveAnswers({ posts: { 'badadib/ep-2': post('badadib', 'ep-2', { body: '0:00 a\n1:00 b\n2:00 c' }) } });
    await db().collection('contentcreators').insertOne({ username: 'badadib', hidden: true });
    await request(app).get('/rss/chapters/badadib/ep-2.json').expect(404);
  });
});

describe('GET /rss/transcript/...', () => {
  beforeEach(async () => {
    await db().collection('embed-video').insertOne(embedVideo('talk'));
    await db().collection('subtitles').insertOne({ author: 'badadib', permlink: 'embed-talk', subtitles: { en: 'QmSubtitleEnglishCidAaaaaaaaaaaaaaaaaaaaaaaaaa' } });
  });

  test('captions as SRT and as WebVTT', async () => {
    subtitleProxy.fetchSubtitleText.mockResolvedValue({ text: SRT });
    const srt = await request(app).get('/rss/transcript/badadib/talk/en.srt').expect(200);
    expect(srt.headers['content-type']).toMatch(/^application\/x-subrip/);
    expect(srt.text).toBe(SRT);
    expect(subtitleProxy.fetchSubtitleText).toHaveBeenCalledWith('QmSubtitleEnglishCidAaaaaaaaaaaaaaaaaaaaaaaaaa');
    const vtt = await request(app).get('/rss/transcript/badadib/talk/en.vtt').expect(200);
    expect(vtt.headers['content-type']).toMatch(/^text\/vtt/);
    expect(vtt.text).toBe('WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.500\nHello there\n\n2\n00:00:04.000 --> 00:00:06.000\nSecond line\n');
  });

  test('404 for a language it does not have, 502 when the file cannot be reached', async () => {
    await request(app).get('/rss/transcript/badadib/talk/de.srt').expect(404);
    subtitleProxy.fetchSubtitleText.mockResolvedValue({ status: 504 });
    await request(app).get('/rss/transcript/badadib/talk/en.srt').expect(502);
  });

  test('the transcript written into an audio post, as plain text', async () => {
    await db().collection('embed-audio').insertOne(audio('ep-2'));
    hiveAnswers({ posts: { 'badadib/ep-2': post('badadib', 'ep-2', { body: 'Notes\n\n**Transcript**\n\nWelcome to the show.\n\nBye.' }) } });
    const res = await request(app).get('/rss/transcript/badadib/ep-2.txt').expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.text).toBe('Welcome to the show.\n\nBye.\n');
    hiveAnswers({ posts: { 'badadib/ep-2': post('badadib', 'ep-2', { body: 'Notes only' }) } });
    await request(app).get('/rss/transcript/badadib/ep-2.txt').expect(404);
  });
});

// ─── Playlist feeds ─────────────────────────────────────────────────────────

describe('GET /rss/playlist/:id.xml, numbering and people', () => {
  const ID = 'pl-series-0001';
  const series = (extra = {}) => ({
    _id: ID, owner: 'badadib', name: 'Garden diary', access: 'public', type: 'video',
    json_metadata: JSON.stringify({ type: 'video', series: true }),
    items: [
      { author: 'badadib', permlink: 'part-2', position: 1, added_at: day(4) },
      { author: 'badadib', permlink: 'part-1', position: 0, added_at: day(5) },
      { author: 'fan', permlink: 'guest-part', position: 2, added_at: day(3) },
    ],
    ...extra,
  });

  async function seed(playlist) {
    await db().collection('playlists').insertOne(playlist);
    await db().collection('embed-video').insertMany([
      embedVideo('part-1', { createdAt: day(5) }),
      embedVideo('part-2', { createdAt: day(4) }),
      embedVideo('guest-part', { owner: 'fan', hive_author: 'fan', createdAt: day(3) }),
    ]);
  }

  test('a series numbers its parts in its own order; a post naming its number keeps it', async () => {
    await seed(series());
    hiveAnswers({ posts: { 'badadib/part-2': post('badadib', 'part-2', { meta: { video: { episode: 20 } } }) } });
    const { doc } = await feed(`/rss/playlist/${ID}.xml`);
    const byGuid = Object.fromEntries(itemsOf(doc).map((i) => [textOf(i.guid), i]));
    expect(byGuid['hive.blog/@badadib/part-1']['podcast:episode']).toBe('1');
    expect(byGuid['hive.blog/@badadib/part-2']['podcast:episode']).toBe('20');
    expect(byGuid['hive.blog/@fan/guest-part']['podcast:episode']).toBe('3');
    // Someone else's part names them as its host; the channel names the owner.
    expect(byGuid['hive.blog/@fan/guest-part']['podcast:person']).toMatchObject({ '#text': 'fan', '@_role': 'host', '@_href': 'https://3speak.tv/user/fan' });
    expect(byGuid['hive.blog/@badadib/part-1']['podcast:person']).toBeUndefined();
    expect(doc.rss.channel['podcast:person']).toMatchObject({ '@_href': 'https://3speak.tv/user/badadib' });
    expect(doc.rss.channel['podcast:funding']).toMatchObject({ '@_url': 'https://3speak.tv/user/badadib' });
    expect(doc.rss.channel['podcast:guid']).toBeDefined();
  });

  test('a playlist in no particular order gets no numbers', async () => {
    await seed(series({ json_metadata: JSON.stringify({ type: 'video' }) }));
    const { doc } = await feed(`/rss/playlist/${ID}.xml`);
    expect(itemsOf(doc).every((i) => i['podcast:episode'] === undefined)).toBe(true);
  });
});
