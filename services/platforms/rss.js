// Podcast RSS feed. Proves that a Hive user controls an outside podcast feed:
// the verification code has to appear in the feed's own header data (title,
// description, itunes:summary/subtitle/author, or a Podcasting 2.0
// <podcast:txt purpose="verify">) or in its NEWEST episode (title, description,
// itunes:summary/subtitle, content:encoded). Only whoever publishes the feed can
// put it there. A verified feed is what the podcast import works from.
//
// The feed is fetched through utils/safeFetch (SSRF guard, size cap, redirects
// re-checked): the URL is whatever the user typed.
//
// Canonical id: the normalised feed URL (lower-case scheme and host, no trailing
// slash, query kept: some hosts need it), after a PERMANENT redirect the URL the
// feed moved to. Feeds with a password in the URL are private and refused.

const { XMLParser } = require('fast-xml-parser');
const { safeFetch, splitCredentials } = require('../../utils/safeFetch');

const name = 'rss';
const MAX_BYTES = 32 * 1024 * 1024;

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    processEntities: true,
    htmlEntities: true,
    // One <item> or one <podcast:txt> must still read as a list.
    isArray: (tag) => tag === 'item' || tag === 'podcast:txt',
});

function notFound(message = 'Channel not found') {
    const err = new Error(message);
    err.code = 'CHANNEL_NOT_FOUND';
    return err;
}

// The URL as stored and compared: scheme and host lower-case, no trailing slash.
function canonicalUrl(raw) {
    const u = new URL(raw);
    const port = u.port ? `:${u.port}` : '';
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.protocol.toLowerCase()}//${u.hostname.toLowerCase()}${port}${path}${u.search}`;
}

// What the user typed: a URL, with or without its scheme.
function inputUrl(platformUsername) {
    let raw = String(platformUsername || '').trim();
    if (!raw) return '';
    if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
    try { return new URL(raw).toString(); } catch { return ''; }
}

// Text of a parsed node: a string, a { '#text' } object, or a list of either.
function textOf(v) {
    if (v == null) return '';
    if (Array.isArray(v)) return v.map(textOf).filter(Boolean).join('\n');
    if (typeof v === 'object') return textOf(v['#text']);
    return String(v);
}

function newestItem(items) {
    let best = null;
    let bestAt = -Infinity;
    for (const item of items) {
        const at = Date.parse(textOf(item && item.pubDate));
        if (Number.isFinite(at) && at > bestAt) { best = item; bestAt = at; }
    }
    // No usable dates: feeds list newest first by convention.
    return best || items[0] || null;
}

// The text the verification code is looked for in (exported for tests).
function verificationText(xml) {
    let doc;
    try { doc = parser.parse(xml); } catch { throw notFound('Not a podcast feed'); }
    let channel = doc && doc.rss && doc.rss.channel;
    if (Array.isArray(channel)) channel = channel[0];
    if (!channel || typeof channel !== 'object') throw notFound('Not a podcast feed');

    const header = [
        channel.title, channel.description, channel['itunes:summary'],
        channel['itunes:subtitle'], channel['itunes:author'], channel['podcast:txt'],
    ];
    const items = Array.isArray(channel.item) ? channel.item : [];
    const newest = newestItem(items);
    const episode = newest ? [
        newest.title, newest.description, newest['itunes:summary'],
        newest['itunes:subtitle'], newest['content:encoded'],
    ] : [];
    return [...header, ...episode].map(textOf).filter(Boolean).join('\n');
}

async function fetchProfile(platformUsername) {
    const raw = inputUrl(platformUsername);
    if (!raw) throw new Error('platform_username is required');
    const { url, auth } = splitCredentials(raw);
    if (auth) throw notFound('Private feeds cannot be linked');

    let res;
    try {
        res = await safeFetch(url, {
            timeoutMs: 20000,
            maxBytes: MAX_BYTES,
            headers: { Accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5' },
        });
    } catch (err) {
        // A URL the guard refuses, or one that answers 404/410, is "no such feed".
        if (/^(http_40[0-9]|http_410|blocked|bad_url|invalid_url|unsupported)/.test(String(err && err.code))) throw notFound();
        console.error(`[rss] fetch failed for ${url}: ${err && (err.code || err.message)}`);
        throw new Error('Platform lookup failed');
    }

    const xml = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body || '');
    const text = verificationText(xml);
    return {
        canonical_username: canonicalUrl(res.permanent && res.url ? res.url : url),
        text,
    };
}

module.exports = { name, fetchProfile, _test: { verificationText, canonicalUrl, inputUrl } };
