/**
 * The podcast helpers the routes lean on, at the edges tests/podcasts.test.js and
 * tests/podcastPlayerFeatures.test.js leave open: playlist metadata in every
 * encoding, parser edge cases, the media cache's size budget and the directory
 * lookups (Apple, fyyd, Podcast Index, a show's own website).
 *
 * No network: the directories' fetch and the website fetch are stand-ins.
 */
const { Binary } = require('mongodb');

jest.mock('../../utils/safeFetch', () => ({ ...jest.requireActual('../../utils/safeFetch'), safeFetch: jest.fn() }));
const { safeFetch } = require('../../utils/safeFetch');
const { decodePlaylistMeta } = require('../../utils/playlistMeta');
const { parseFeed, decodeEntities } = require('../../utils/podcastParse');
const { makeCache } = require('../../utils/podcastMedia');
const directories = require('../../utils/podcastDirectories');

// ─── playlistMeta ─────────────────────────────────────────────────────────────

describe('decodePlaylistMeta: every way a client stores playlist metadata', () => {
  const meta = { album: { thumbnail: 'https://files.peakd.com/a.jpg', year: 2026 } };
  const json = JSON.stringify(meta);

  test.each([
    ['BSON Binary from the indexer', new Binary(Buffer.from(json))],
    ['a Buffer', Buffer.from(json)],
    ['raw JSON', json],
    ['base64 JSON', Buffer.from(json).toString('base64')],
    ['an object already', meta],
  ])('%s', (_label, stored) => {
    expect(decodePlaylistMeta(stored)).toEqual(meta);
  });

  test.each([
    ['nothing', undefined],
    ['an empty string', ''],
    ['a number', 42],
    ['text that is neither JSON nor base64 JSON', 'just words'],
    ['a Buffer of garbage', Buffer.from('{not json')],
  ])('%s decodes to null', (_label, stored) => {
    expect(decodePlaylistMeta(stored)).toBeNull();
  });
});

// ─── podcastParse edge cases ──────────────────────────────────────────────────

const rss = (channel) => `<?xml version="1.0"?>
<rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>${channel}</channel></rss>`;
const playable = '<item><title>E</title><guid>e</guid><enclosure url="https://cdn.example.com/e.mp3" type="audio/mpeg" length="1"/></item>';

describe('parseFeed at the edges', () => {
  test('broken XML is a parse_error, a document without a channel not_a_podcast', () => {
    expect(() => parseFeed('<rss><channel><title>x</title></channel></rss')).toThrow(expect.objectContaining({ code: 'parse_error' }));
    expect(() => parseFeed('<rss><channel></channel></rss>')).toThrow(expect.objectContaining({ code: 'not_a_podcast' }));
  });

  test('a channel with neither a title nor a playable episode is not a podcast', () => {
    expect(() => parseFeed(rss('<description>only words</description>'))).toThrow(expect.objectContaining({ code: 'not_a_podcast' }));
    // An untitled feed WITH episodes is still one.
    expect(parseFeed(rss(playable)).episodes).toHaveLength(1);
  });

  test('funding links: the first three tags, web addresses only, text trimmed', () => {
    const { show } = parseFeed(rss(`<title>F</title>
      <podcast:funding url="https://support.example.com/a">  Support   us </podcast:funding>
      <podcast:funding url="javascript:alert(1)">evil</podcast:funding>
      <podcast:funding url="https://b.example.com">B</podcast:funding>
      <podcast:funding url="https://c.example.com">C</podcast:funding>${playable}`));
    expect(show.funding).toEqual([
      { url: 'https://support.example.com/a', text: 'Support us' },
      { url: 'https://b.example.com/', text: 'B' },
    ]);
  });

  test('live items: an alternate source or a bare HLS enclosure is the stream; at most three', () => {
    const live = (n, body, attrs = 'status="live"') => `<podcast:liveItem ${attrs} start="2026-11-01T10:00:00Z"><title>L${n}</title><guid>l${n}</guid>${body}</podcast:liveItem>`;
    const { show } = parseFeed(rss(`<title>Live</title>
      ${live(1, '<podcast:alternateEnclosure type="application/x-mpegURL"><podcast:source uri="https://s.example.com/1.m3u8"/></podcast:alternateEnclosure><podcast:contentLink href="https://s.example.com/watch">Watch</podcast:contentLink>')}
      ${live(2, '<enclosure url="https://s.example.com/2/stream" type="application/x-mpegURL"/>')}
      ${live(3, '<enclosure url="ftp://nope/3"/>')}
      ${live(4, '<enclosure url="https://s.example.com/4.mp3" type="audio/mpeg"/>', 'status="ended"')}
      ${live(5, '<enclosure url="https://s.example.com/5.mp3" type="audio/mpeg"/>', 'status="pending" end="2026-11-01T12:00:00Z"')}
      ${live(6, '<enclosure url="https://s.example.com/6.mp3" type="audio/mpeg"/>')}
      ${playable}`));
    expect(show.live.map((l) => [l.title, l.url, l.mime])).toEqual([
      ['L1', 'https://s.example.com/1.m3u8', 'application/x-mpegurl'],
      ['L2', 'https://s.example.com/2/stream', 'application/x-mpegurl'],
      ['L5', 'https://s.example.com/5.mp3', 'audio/mpeg'],
    ]);
    expect(show.live[0].link).toBe('https://s.example.com/watch');
    expect(show.live[2].end).toEqual(new Date('2026-11-01T12:00:00Z'));
  });

  test('entities: named, decimal and hex decode; unknown or impossible ones stay as written', () => {
    expect(decodeEntities('&#x1F600; &#169; &AMP; [&nbsp;] &bogus; &#1114112;')).toBe('😀 © & [ ] &bogus; &#1114112;');
  });
});

// ─── podcastMedia cache ───────────────────────────────────────────────────────

describe('the media cache budget', () => {
  test('one value larger than a quarter of the budget is never kept', () => {
    const cache = makeCache({ maxBytes: 400 });
    cache.set('big', 'x'.repeat(200), 60000);
    expect(cache.get('big')).toBeUndefined();
    cache.set('small', 'y', 60000);
    expect(cache.get('small')).toBe('y');
  });

  test('the byte budget evicts the oldest entries', () => {
    const cache = makeCache({ maxBytes: 100 });
    for (const k of ['a', 'b', 'c', 'd', 'e']) cache.set(k, 'z'.repeat(20), 60000);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('e')).toBe('z'.repeat(20));
    expect(cache.size).toBeLessThan(5);
  });
});

// ─── Directories ──────────────────────────────────────────────────────────────

const jsonResponse = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

describe('resolveLink: links from directories and apps', () => {
  let fetchSpy;
  beforeEach(() => { fetchSpy = jest.spyOn(global, 'fetch'); });

  test.each([
    ['an Apple link without an id', 'https://podcasts.apple.com/us/podcast/no-id'],
    ['an Overcast link without an Apple id', 'https://overcast.fm/+abc123'],
    ['a pod.link without an id', 'https://pod.link/show-name'],
    ['a Podcast Index link (no keys configured here)', 'https://podcastindex.org/podcast/920666'],
    ['a fyyd link without a podcast', 'https://fyyd.de/episode/1'],
    ['a Google Podcasts link without a feed', 'https://podcasts.google.com/search/x'],
    ['a Google Podcasts link carrying something that is not a web address', `https://podcasts.google.com/feed/${Buffer.from('javascript:alert(1)').toString('base64url')}`],
  ])('%s is directory_not_found, and asks nobody', async (_label, link) => {
    expect(await directories.resolveLink(link)).toEqual({ code: 'directory_not_found' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('an Apple id Apple does not know, and a fyyd slug fyyd does not know', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ results: [] }));
    expect(await directories.resolveLink('https://itunes.apple.com/podcast/id77')).toEqual({ code: 'directory_not_found' });
    fetchSpy.mockResolvedValueOnce(jsonResponse({ data: {} }));
    expect(await directories.resolveLink('https://fyyd.de/podcast/unknown/0')).toEqual({ code: 'directory_not_found' });
  });

  test('a directory answering an error is directory_down', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({}, 500));
    expect(await directories.resolveLink('https://pod.link/123')).toEqual({ code: 'directory_down' });
  });

  test.each([
    ['Amazon Music', 'https://music.amazon.de/podcasts/abc', 'Amazon'],
    ['Audible', 'https://www.audible.com/pd/x', 'Amazon'],
    ['Deezer', 'https://www.deezer.com/show/1', 'Deezer'],
    ['a youtu.be link', 'https://youtu.be/abc', 'YouTube'],
  ])('%s is a closed platform', async (_label, link, platform) => {
    expect(await directories.resolveLink(link)).toEqual({ code: 'closed_platform', platform });
  });

  test('something that is not a URL comes back as it was', async () => {
    expect(await directories.resolveLink('not a url')).toEqual({ url: 'not a url' });
  });
});

describe('discoverFeed: the feed a show website announces', () => {
  beforeEach(() => safeFetch.mockReset());
  const page = (html, extra = {}) => ({ url: 'https://show.example.com/about/', headers: { 'content-type': 'text/html; charset=utf-8' }, body: Buffer.from(html), ...extra });

  test('the first rss or atom alternate that is not a comments feed, resolved against the page', async () => {
    safeFetch.mockResolvedValue(page(`
      <link rel="stylesheet" href="/s.css">
      <link rel="alternate" type="application/rss+xml" href="https://show.example.com/comments/feed/">
      <link type='application/atom+xml' rel='alternate' href='../feed.atom'>
      <link rel="alternate" type="application/rss+xml" href="/podcast.xml">`));
    expect(await directories.discoverFeed('https://show.example.com/about/')).toBe('https://show.example.com/feed.atom');
    expect(safeFetch).toHaveBeenCalledWith('https://show.example.com/about/', expect.objectContaining({ maxBytes: 3 * 1024 * 1024 }));
  });

  test.each([
    ['the page cannot be fetched', () => safeFetch.mockRejectedValue(new Error('blocked_address'))],
    ['the answer is not HTML', () => safeFetch.mockResolvedValue(page('<rss/>', { headers: { 'content-type': 'application/rss+xml' } }))],
    ['nothing is announced', () => safeFetch.mockResolvedValue(page('<link rel="alternate" type="text/html" href="/x">'))],
    ['an announced link without an address', () => safeFetch.mockResolvedValue(page('<link rel="alternate" type="application/rss+xml">'))],
    ['an address that is not a URL', () => safeFetch.mockResolvedValue(page('<link rel="alternate" type="application/rss+xml" href="http://[bad">'))],
  ])('null when %s', async (_label, arrange) => {
    arrange();
    expect(await directories.discoverFeed('https://show.example.com/')).toBeNull();
  });
});

describe('search and charts without Podcast Index keys', () => {
  let fetchSpy;
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  test('searchAll asks Apple and fyyd only, and survives one of them failing', async () => {
    expect(directories.piEnabled()).toBe(false);
    fetchSpy.mockImplementation(async (url) => (String(url).includes('fyyd')
      ? jsonResponse({}, 500)
      : jsonResponse({ results: [{ collectionId: 9, collectionName: 'Only Apple', artistName: 'A', feedUrl: 'https://a.example.com/f', releaseDate: '2026-10-01T00:00:00Z' }] })));
    const results = await directories.searchAll('anything');
    expect(results).toEqual([expect.objectContaining({ title: 'Only Apple', sources: ['apple'], apple_id: 9, last_episode_at: new Date('2026-10-01T00:00:00Z') })]);
    expect(fetchSpy.mock.calls.some(([u]) => String(u).includes('podcastindex'))).toBe(false);
    expect(console.warn).toHaveBeenCalledWith('[podcasts] directory search:', expect.stringContaining('api.fyyd.de 500'));
  });

  test('searchAll fails only when every directory did', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({}, 503));
    await expect(directories.searchAll('anything')).rejects.toThrow('every directory failed');
  });

  test('a chart of a single entry (not an array), and a chart with no entries at all', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ feed: { entry: { id: { attributes: { 'im:id': '5' } } } } }))
      .mockResolvedValueOnce(jsonResponse({ results: [{ collectionId: 5, collectionName: 'Five', feedUrl: 'https://five.example.com/f' }] }));
    expect((await directories.appleChart('us')).map((s) => [s.title, s.rank])).toEqual([['Five', 1]]);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://itunes.apple.com/us/rss/toppodcasts/limit=50/json');

    fetchSpy.mockResolvedValueOnce(jsonResponse({ feed: {} }));
    expect(await directories.appleChart('us', 'Comedy')).toEqual([]);
    expect(fetchSpy.mock.calls[2][0]).toContain('/genre=1303/');
  });

  test('mergeShows keeps to its maximum', () => {
    const many = Array.from({ length: 40 }, (_, i) => directories.show({ title: `S${i}`, author: 'A', url: `https://s${i}.example.com/f`, source: 'apple' }));
    expect(directories.mergeShows([many])).toHaveLength(30);
    expect(directories.mergeShows([many], 5).map((s) => s.title)).toEqual(['S0', 'S1', 'S2', 'S3', 'S4']);
  });
});
