/**
 * Outside podcast feeds: parsing, the fetch guard and the signed-message shapes,
 * without touching the network or Mongo.
 */
const { parseFeed, urlKey, episodeId, duration, _test: { truncateItems } } = require('../utils/podcastParse');
const { isBlockedAddress, checkUrl } = require('../utils/safeFetch');
const { _test: routes } = require('../routes/podcasts');
const { _test: service } = require('../services/podcastFeeds');

const item = (n, date, extra = '') => `
  <item>
    <title>Episode ${n}</title>
    <guid>ep-${n}</guid>
    <pubDate>${date}</pubDate>
    <enclosure url="https://cdn.example.com/ep${n}.mp3" type="audio/mpeg" length="1000"/>
    <itunes:duration>1:02:03</itunes:duration>
    <description><![CDATA[<p>Show <b>notes</b> &amp; links</p>]]></description>
    ${extra}
  </item>`;

const feed = (items, channelExtra = '') => `<?xml version="1.0"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0">
<channel>
  <title>Test Show</title>
  <itunes:author>Host</itunes:author>
  <itunes:image href="https://cdn.example.com/cover.jpg"/>
  <podcast:guid>abc-123</podcast:guid>
  <podcast:value type="lightning" method="keysend" suggested="0.00000005000">
    <podcast:valueRecipient name="Host" type="lnaddress" address="host@getalby.com" split="90"/>
    <podcast:valueRecipient name="App" type="node" address="03ae9f91a0cb8ff43840e3c322c4c61f019d8c1c3cea15a25cfc425ac605e61a4a" split="10" customKey="818818" customValue="someone" fee="true"/>
    <podcast:valueRecipient name="Broken" type="node" address="nope" split="5"/>
  </podcast:value>
  ${channelExtra}
  ${items}
</channel>
</rss>`;

describe('parseFeed', () => {
  test('reads the show, its value block and lean episodes', () => {
    const { show, episodes, itemCount } = parseFeed(feed(item(2, 'Tue, 20 Oct 2026 10:00:00 GMT') + item(1, 'Mon, 19 Oct 2026 10:00:00 GMT')));
    expect(show.title).toBe('Test Show');
    expect(show.image).toBe('https://cdn.example.com/cover.jpg');
    expect(show.podcast_guid).toBe('abc-123');
    expect(show.value.recipients.map((r) => r.name)).toEqual(['Host', 'App']);
    expect(show.value.recipients[1]).toMatchObject({ fee: true, customKey: '818818', customValue: 'someone' });
    expect(itemCount).toBe(2);
    expect(episodes[0]).toMatchObject({ guid: 'ep-2', title: 'Episode 2', duration: 3723, bytes: 1000, mime: 'audio/mpeg', summary: 'Show notes & links' });
    // Same image and value as the show: not repeated on the episode.
    expect(episodes[0].image).toBeUndefined();
    expect(episodes[0].value).toBeUndefined();
  });

  test('a routine poll reads the newest items, a full read all of them, oldest-first feeds too', () => {
    const many = Array.from({ length: 80 }, (_, i) => item(i, new Date(Date.UTC(2020, 0, 1 + i)).toUTCString())).join('');
    const quick = parseFeed(feed(many));
    expect(quick.itemCount).toBe(80);
    expect(quick.episodes).toHaveLength(60);
    expect(quick.episodes[0].guid).toBe('ep-79');
    expect(quick.complete).toBe(false);
    const full = parseFeed(feed(many), { all: true });
    expect(full.episodes).toHaveLength(80);
    expect(full.complete).toBe(true);
  });

  test('skips items without playable media, refuses non-RSS', () => {
    const { episodes } = parseFeed(feed(`<item><title>text only</title></item>${item(1, 'Mon, 19 Oct 2026 10:00:00 GMT')}`));
    expect(episodes).toHaveLength(1);
    expect(() => parseFeed('<html><body>hi</body></html>')).toThrow(expect.objectContaining({ code: 'not_a_podcast' }));
  });

  test('truncateItems closes the document after the Nth item', () => {
    const { xml, cut } = truncateItems('<rss><channel><item>a</item><item>b</item><item>c</item></channel></rss>', 2);
    expect(cut).toBe(true);
    expect(xml).toBe('<rss><channel><item>a</item><item>b</item></channel></rss>');
  });
});

describe('helpers', () => {
  test('urlKey ignores scheme, www and trailing slash', () => {
    expect(urlKey('https://www.Example.com/feed/')).toBe('example.com/feed');
    expect(urlKey('http://example.com/feed')).toBe('example.com/feed');
    expect(urlKey('nonsense')).toBe('');
  });
  test('episode ids are stable and short', () => {
    const id = episodeId('0123456789abcdef01234567', 'guid-1');
    expect(id).toBe(episodeId('0123456789abcdef01234567', 'guid-1'));
    expect(id).toMatch(/^[0-9a-f]{24}:[A-Za-z0-9_-]{16}$/);
  });
  test('durations', () => {
    expect(duration('3600')).toBe(3600);
    expect(duration('10:05')).toBe(605);
    expect(duration('')).toBe(0);
  });
});

describe('fetch guard', () => {
  test('refuses private, loopback and mapped addresses', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.20.1.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '64:ff9b::10.0.0.1']) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false);
  });
  test('refuses odd schemes, ports, credentials and local names', () => {
    for (const u of ['file:///etc/passwd', 'ftp://example.com/x', 'http://example.com:3131/', 'http://user:pw@example.com/', 'http://localhost/', 'http://box.internal/', 'http://127.0.0.1/']) {
      expect(() => checkUrl(u)).toThrow();
    }
    expect(() => checkUrl('https://feeds.example.com/rss')).not.toThrow();
  });
});

describe('routes and podping', () => {
  test('signed message shape', () => {
    expect(routes.podcastMessage('subscribe-vouch', 'alice', 'abc', 1)).toBe('3speak-podcasts|subscribe-vouch|alice|abc|1');
    expect(routes.urlsDigest(['a', 'b'])).toMatch(/^[0-9a-f]{64}$/);
  });
  test('3Speak channel feeds are recognised', () => {
    expect(routes.internalOwner('3speak.tv/rss/tibfox.xml')).toBe('tibfox');
    expect(routes.internalOwner('preview.3speak.tv/rss/tibfox.xml')).toBe('tibfox');
    expect(routes.internalOwner('example.com/rss/tibfox.xml')).toBeNull();
  });
  test('podping payloads of every version', () => {
    const op = (id, json) => ({ value: { id, json: JSON.stringify(json) } });
    expect(service.pingedUrls(op('pp_podcast_update', { iris: ['https://a/x.xml'] }))).toEqual(['https://a/x.xml']);
    expect(service.pingedUrls(op('podping', { urls: ['https://b/y.xml'] }))).toEqual(['https://b/y.xml']);
    expect(service.pingedUrls(op('podping', { url: 'https://c/z.xml' }))).toEqual(['https://c/z.xml']);
    expect(service.pingedUrls(op('follow', { iris: ['https://a/x.xml'] }))).toEqual([]);
  });
});

describe('cover art tokens', () => {
  const { artToken, urlFromToken } = require('../utils/podcastArt');
  test('only tokens the checker made resolve', () => {
    const url = 'https://cdn.example.com/cover.jpg';
    const token = artToken(url);
    expect(urlFromToken(token)).toBe(url);
    const [sig] = token.split('.');
    expect(urlFromToken(`${sig}.${Buffer.from('http://127.0.0.1/x').toString('base64url')}`)).toBeNull();
    expect(urlFromToken('nonsense')).toBeNull();
    expect(artToken('')).toBe('');
    expect(artToken('ftp://x/y.jpg')).toBe('');
  });
});

describe('show art fallback', () => {
  test('a show without a cover takes its newest episode art', () => {
    const xml = `<?xml version="1.0"?><rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>No cover</title>
      <item><title>Old</title><guid>o</guid><pubDate>Mon, 19 Oct 2026 10:00:00 GMT</pubDate><enclosure url="https://c/o.mp3" type="audio/mpeg"/><itunes:image href="https://c/old.jpg"/></item>
      <item><title>New, no art</title><guid>n</guid><pubDate>Wed, 21 Oct 2026 10:00:00 GMT</pubDate><enclosure url="https://c/n.mp3" type="audio/mpeg"/></item>
      <item><title>A</title><guid>a</guid><pubDate>Tue, 20 Oct 2026 10:00:00 GMT</pubDate><enclosure url="https://c/a.mp3" type="audio/mpeg"/><itunes:image href="https://c/a.jpg"/></item>
    </channel></rss>`;
    const { show, episodes } = parseFeed(xml, { all: true });
    // The most recent episode WITH art, not the first one in the file.
    expect(show.image).toBe('https://c/a.jpg');
    expect(episodes.find((e) => e.guid === 'a').image).toBeUndefined();
    expect(episodes.find((e) => e.guid === 'o').image).toBe('https://c/old.jpg');
  });

  test('no art anywhere: no image (the page shows its placeholder)', () => {
    const xml = `<?xml version="1.0"?><rss><channel><title>Bare</title>
      <item><title>A</title><guid>a</guid><enclosure url="https://c/a.mp3" type="audio/mpeg"/></item></channel></rss>`;
    expect(parseFeed(xml).show.image).toBe('');
  });
});

describe('show notes', () => {
  const { notesByGuid } = require('../utils/podcastParse');
  test('full notes per episode guid, content:encoded first', () => {
    const xml = `<?xml version="1.0"?><rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>S</title>
      <item><title>A</title><guid>a</guid><enclosure url="https://c/a.mp3" type="audio/mpeg"/>
        <description>short</description><content:encoded><![CDATA[<p>Long <a href="https://x">notes</a></p>]]></content:encoded></item>
      <item><title>B</title><enclosure url="https://c/b.mp3" type="audio/mpeg"/><description><![CDATA[<b>Only</b> description]]></description></item>
    </channel></rss>`;
    const notes = notesByGuid(xml);
    expect(notes.get('a')).toBe('<p>Long <a href="https://x">notes</a></p>');
    expect(notes.get('https://c/b.mp3')).toBe('<b>Only</b> description');
  });
});

describe('Podcast Index results', () => {
  const ep = (feedId, title, at, extra = {}) => ({
    feedId, feedUrl: `https://feeds.example/${feedId}.xml`, feedTitle: `Show ${feedId}`, feedAuthor: 'Host', feedImage: '',
    title, datePublished: at, ...extra,
  });

  test('a person search lists each show once, most matching episodes first, with the newest match', () => {
    const shows = routes.showsFromEpisodes([
      ep(1, 'old', 100), ep(2, 'b-old', 50), ep(2, 'b-new', 300), ep(2, 'b-mid', 200), ep(3, 'c', 400),
      { title: 'no feed url', datePublished: 999 },
    ]);
    expect(shows.map((s) => [s.url, s.matches, s.sample])).toEqual([
      ['https://feeds.example/2.xml', 3, 'b-new'],
      ['https://feeds.example/3.xml', 1, 'c'],
      ['https://feeds.example/1.xml', 1, 'old'],
    ]);
    expect(shows[0].last_episode_at).toEqual(new Date(300 * 1000));
    expect(shows[0].title).toBe('Show 2');
    expect('sample_at' in shows[0]).toBe(false);
  });

  test('a language is asked for with its regional forms', () => {
    expect(routes.langParam('en').split(',')).toEqual(expect.arrayContaining(['en', 'en-us', 'en-gb']));
    expect(routes.langParam('pt')).toBe('pt,pt-br,pt-pt');
    expect(routes.langParam('sw')).toBe('sw,sw-sw');
  });

  test('a trending show reads its newest episode time', () => {
    const f = routes.presentPiFeed({ title: 'T', url: 'https://x.example/f.xml', artwork: '', newestItemPublishTime: 1000 });
    expect(f.last_episode_at).toEqual(new Date(1000 * 1000));
  });
});
