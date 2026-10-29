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

  test('keeps only the newest 50, and copes with an oldest-first feed', () => {
    const many = Array.from({ length: 80 }, (_, i) => item(i, new Date(Date.UTC(2020, 0, 1 + i)).toUTCString())).join('');
    const { episodes, itemCount } = parseFeed(feed(many));
    expect(itemCount).toBe(80);
    expect(episodes).toHaveLength(50);
    expect(episodes[0].guid).toBe('ep-79');
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
