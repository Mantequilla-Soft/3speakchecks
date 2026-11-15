/**
 * Verifying a podcast RSS feed (services/platforms/rss.js): the code counts in
 * the feed header, in <podcast:txt>, or in the NEWEST episode, never an older
 * one. The fetch is mocked (no network).
 */
jest.mock('../utils/safeFetch', () => {
    const actual = jest.requireActual('../utils/safeFetch');
    return { ...actual, safeFetch: jest.fn() };
});
const { safeFetch } = require('../utils/safeFetch');
const rss = require('../services/platforms/rss');
const platforms = require('../services/platforms');

const CODE = '0123456789abcdef0123456789abcdef';

const feed = ({ header = '', items = [] } = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>My Show</title>
    <description>A show about things</description>
    ${header}
    ${items.join('\n')}
  </channel>
</rss>`;

const item = (n, date, extra = '') => `
  <item>
    <title>Episode ${n}</title>
    <pubDate>${date}</pubDate>
    <description><![CDATA[<p>Notes for ${n}</p>]]></description>
    <enclosure url="https://cdn.example.com/ep${n}.mp3" type="audio/mpeg" length="1000"/>
    ${extra}
  </item>`;

const serve = (xml, { url, permanent = true } = {}) => {
    safeFetch.mockResolvedValueOnce({ status: 200, body: Buffer.from(xml), url, permanent, headers: {} });
};

beforeEach(() => safeFetch.mockReset());

describe('rss verification text', () => {
    it('finds the code in the show description', async () => {
        serve(feed({ header: `<itunes:summary>Verify: ${CODE}</itunes:summary>` }));
        const p = await rss.fetchProfile('https://example.com/feed.xml');
        expect(p.text).toContain(CODE);
    });

    it('finds the code in a Podcasting 2.0 <podcast:txt purpose="verify">', async () => {
        serve(feed({ header: `<podcast:txt purpose="verify">${CODE}</podcast:txt><podcast:txt>other</podcast:txt>` }));
        expect((await rss.fetchProfile('https://example.com/feed.xml')).text).toContain(CODE);
    });

    it('finds the code in the newest episode, by date, even in an oldest-first feed', async () => {
        serve(feed({ items: [
            item(1, 'Mon, 01 Jan 2024 10:00:00 GMT'),
            item(2, 'Wed, 01 May 2024 10:00:00 GMT', `<content:encoded><![CDATA[<p>${CODE}</p>]]></content:encoded>`),
        ] }));
        expect((await rss.fetchProfile('https://example.com/feed.xml')).text).toContain(CODE);
    });

    it('ignores the code in an OLDER episode', async () => {
        serve(feed({ items: [
            item(2, 'Wed, 01 May 2024 10:00:00 GMT'),
            item(1, 'Mon, 01 Jan 2024 10:00:00 GMT', `<itunes:summary>${CODE}</itunes:summary>`),
        ] }));
        expect((await rss.fetchProfile('https://example.com/feed.xml')).text).not.toContain(CODE);
    });

    it('falls back to the first item when no episode has a usable date', async () => {
        serve(feed({ items: [item(2, 'soon', `<itunes:subtitle>${CODE}</itunes:subtitle>`), item(1, 'never')] }));
        expect((await rss.fetchProfile('https://example.com/feed.xml')).text).toContain(CODE);
    });

    it('reads a feed with a single item', async () => {
        serve(feed({ items: [item(1, 'Mon, 01 Jan 2024 10:00:00 GMT', `<itunes:summary>${CODE}</itunes:summary>`)] }));
        expect((await rss.fetchProfile('example.com/feed.xml')).text).toContain(CODE);
    });
});

describe('rss canonical id and errors', () => {
    it('normalises the URL: scheme added, host lower-cased, trailing slash dropped, query kept', async () => {
        serve(feed(), { url: 'https://Feeds.Example.com/show/?id=7', permanent: true });
        const p = await rss.fetchProfile('Feeds.Example.com/show/?id=7');
        expect(p.canonical_username).toBe('https://feeds.example.com/show?id=7');
    });

    it('follows a permanent redirect to the feed\'s new address', async () => {
        serve(feed(), { url: 'https://new.example.com/feed', permanent: true });
        expect((await rss.fetchProfile('https://old.example.com/feed')).canonical_username).toBe('https://new.example.com/feed');
    });

    it('keeps the typed address across a temporary redirect', async () => {
        serve(feed(), { url: 'https://cdn.example.com/x/feed', permanent: false });
        expect((await rss.fetchProfile('https://example.com/feed')).canonical_username).toBe('https://example.com/feed');
    });

    it('refuses a private feed (password in the URL) without fetching it', async () => {
        await expect(rss.fetchProfile('https://me:secret@example.com/feed')).rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND' });
        expect(safeFetch).not.toHaveBeenCalled();
    });

    it('answers "not found" for a 404, a blocked address, and something that is not a feed', async () => {
        safeFetch.mockRejectedValueOnce(Object.assign(new Error('404'), { code: 'http_404' }));
        await expect(rss.fetchProfile('https://example.com/a')).rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND' });
        safeFetch.mockRejectedValueOnce(Object.assign(new Error('blocked'), { code: 'blocked_address' }));
        await expect(rss.fetchProfile('http://10.0.0.1/feed')).rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND' });
        serve('<html><body>hello</body></html>');
        await expect(rss.fetchProfile('https://example.com/page')).rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND' });
    });

    it('a network failure is a lookup failure, not "not found"', async () => {
        safeFetch.mockRejectedValueOnce(Object.assign(new Error('down'), { code: 'timeout' }));
        const err = await rss.fetchProfile('https://example.com/feed').catch((e) => e);
        expect(err.message).toBe('Platform lookup failed');
        expect(err.code).toBeUndefined();
    });

    it('an empty input is refused', async () => {
        await expect(rss.fetchProfile('  ')).rejects.toThrow('platform_username is required');
    });
});

describe('rss in the platform list', () => {
    it('is registered and can be linked by default', () => {
        expect(platforms.getPlatform('rss')).toBe(rss);
        expect(platforms.listPlatforms()).toContain('rss');
    });
});
