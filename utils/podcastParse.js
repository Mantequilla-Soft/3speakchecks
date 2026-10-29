/**
 * Reading an outside podcast's RSS feed into the lean shape we keep in Mongo.
 *
 * Only what the Podcasts tab, the player and the tip window use survives:
 * descriptions become capped plain text (show notes are mostly HTML, links and
 * sponsor reads), and an episode only carries an image or a value block when it
 * differs from the show's, which is the common case for neither.
 *
 * Feeds are newest-first almost everywhere, so a routine poll parses just the
 * first TRUNCATE_ITEMS items (a 10 MB back catalogue becomes a few hundred KB of
 * work). When the cut part turns out to be oldest-first, the caller re-parses
 * the whole document.
 */
const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');

const KEEP_EPISODES = 50;
const TRUNCATE_ITEMS = 60;
const MAX_ALL_ITEMS = 3000;

const ARRAY_PATHS = new Set([
  'rss.channel.item',
  'rss.channel.podcast:value',
  'rss.channel.podcast:value.podcast:valueRecipient',
  'rss.channel.item.podcast:value',
  'rss.channel.item.podcast:value.podcast:valueRecipient',
  'rss.channel.podcast:funding',
  'rss.channel.itunes:category',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
  isArray: (_name, jpath) => ARRAY_PATHS.has(jpath),
});

const MEDIA_EXT = /\.(mp3|m4a|m4b|aac|ogg|oga|opus|wav|flac|mp4|m4v|webm)(\?|$)/i;
const NODE_RE = /^0[23][0-9a-f]{64}$/i;
const LNADDRESS_RE = /^[a-z0-9._+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,}$/i;

/** The same feed however it is written: no scheme, no www., no trailing slash. */
function urlKey(raw) {
  try {
    const u = new URL(String(raw).trim());
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const port = u.port && u.port !== '80' && u.port !== '443' ? `:${u.port}` : '';
    const path = u.pathname.replace(/\/+$/, '') || '';
    return `${host}${port}${path}${u.search}`;
  } catch (_) {
    return '';
  }
}

/** Stable, short episode id: the feed's id plus a hash of the episode's guid. */
function episodeId(feedId, guid) {
  const h = crypto.createHash('sha1').update(String(guid)).digest('base64url').slice(0, 16);
  return `${feedId}:${h}`;
}

function text(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === 'object' && '#text' in v) return text(v['#text']);
  return '';
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return Number.isFinite(code) ? String.fromCodePoint(code) : m; } catch (_) { return m; }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** HTML show notes → one capped line of plain text. */
function plain(v, max) {
  let s = text(v);
  if (!s) return '';
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/li>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s).replace(/\s+/g, ' ').trim();
  if (s.length > max) s = `${s.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
  return s;
}

function cap(v, max) {
  const s = decodeEntities(text(v)).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

function httpUrl(v) {
  const s = text(v).trim();
  if (!/^https?:\/\//i.test(s) || s.length > 2000) return '';
  try { return new URL(s).toString(); } catch (_) { return ''; }
}

/** itunes:duration: "1:02:03", "62:03" or plain seconds. */
function duration(v) {
  const s = text(v).trim();
  if (!s) return 0;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s));
  const parts = s.split(':').map((p) => parseInt(p, 10));
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function date(v) {
  const s = text(v).trim();
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  // A pubDate in the future is a scheduling slip or a typo; don't let it sit on
  // top of every list for months.
  return d.getTime() > Date.now() + 24 * 3600 * 1000 ? new Date() : d;
}

function imageOf(node) {
  const it = node && node['itunes:image'];
  const href = it && (it['@_href'] || text(it));
  return httpUrl(href) || httpUrl(node && node.image && (node.image.url || node.image['@_href'])) || '';
}

/**
 * The Podcasting 2.0 value block (where sats tips go), Lightning only.
 * https://podcasting2.org/docs/podcast-namespace/tags/value
 */
function valueOf(node) {
  const blocks = (node && node['podcast:value']) || [];
  const v = blocks.find((b) => String(b['@_type'] || '').toLowerCase() === 'lightning');
  if (!v) return null;
  const recipients = (v['podcast:valueRecipient'] || []).slice(0, 25).map((r) => {
    const type = String(r['@_type'] || '').toLowerCase();
    const address = String(r['@_address'] || '').trim();
    const split = Math.max(0, Math.min(100000, parseInt(r['@_split'], 10) || 0));
    const out = { name: cap(r['@_name'], 80), type, address, split };
    if (r['@_customKey']) out.customKey = cap(r['@_customKey'], 20);
    if (r['@_customValue']) out.customValue = cap(r['@_customValue'], 200);
    if (String(r['@_fee'] || '').toLowerCase() === 'true') out.fee = true;
    return out;
  }).filter((r) => r.split > 0
    && ((r.type === 'node' && NODE_RE.test(r.address)) || (r.type === 'lnaddress' && LNADDRESS_RE.test(r.address))));
  if (!recipients.length) return null;
  const out = { method: String(v['@_method'] || 'keysend').toLowerCase().slice(0, 20), recipients };
  const suggested = parseFloat(v['@_suggested']);
  if (Number.isFinite(suggested) && suggested > 0) out.suggested = suggested;
  return out;
}

function fundingOf(channel) {
  return (channel['podcast:funding'] || []).slice(0, 3)
    .map((f) => ({ url: httpUrl(f['@_url']), text: cap(f, 120) }))
    .filter((f) => f.url);
}

function mediaOf(item) {
  const enc = item.enclosure;
  const e = Array.isArray(enc) ? enc[0] : enc;
  if (!e) return null;
  const url = httpUrl(e['@_url']);
  if (!url) return null;
  const mime = String(e['@_type'] || '').toLowerCase().slice(0, 40);
  if (!(mime.startsWith('audio/') || mime.startsWith('video/') || MEDIA_EXT.test(url))) return null;
  const bytes = parseInt(e['@_length'], 10);
  return { url, mime, bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : 0 };
}

function sameJson(a, b) {
  return JSON.stringify(a || null) === JSON.stringify(b || null);
}

/** Cut a document after its Nth </item> and close it again. */
function truncateItems(xml, n) {
  let idx = -1;
  for (let i = 0; i < n; i += 1) {
    idx = xml.indexOf('</item>', idx + 1);
    if (idx < 0) return { xml, cut: false };
  }
  return { xml: `${xml.slice(0, idx + 7)}</channel></rss>`, cut: true };
}

function parseDoc(xml) {
  let doc;
  try { doc = parser.parse(xml); } catch (err) {
    const e = new Error(`not valid XML: ${err.message}`.slice(0, 200));
    e.code = 'parse_error';
    throw e;
  }
  const channel = doc && doc.rss && doc.rss.channel;
  if (!channel || typeof channel !== 'object') {
    const e = new Error('not an RSS feed');
    e.code = 'not_a_podcast';
    throw e;
  }
  return channel;
}

function readChannel(channel) {
  const owner = channel['itunes:owner'];
  return {
    title: cap(channel.title, 200),
    author: cap(channel['itunes:author'] || (owner && owner['itunes:name']), 120),
    image: imageOf(channel),
    link: httpUrl(channel.link),
    description: plain(channel['itunes:summary'] || channel.description, 600),
    language: cap(channel.language, 12).toLowerCase(),
    categories: (channel['itunes:category'] || []).map((c) => cap(c['@_text'], 40)).filter(Boolean).slice(0, 3),
    explicit: /^(yes|true|explicit)$/i.test(text(channel['itunes:explicit'])),
    podcast_guid: cap(channel['podcast:guid'], 64),
    new_feed_url: httpUrl(channel['itunes:new-feed-url']),
    medium: cap(channel['podcast:medium'], 20).toLowerCase(),
    funding: fundingOf(channel),
    value: valueOf(channel),
  };
}

function readItems(rawItems, show) {
  const out = [];
  for (const item of rawItems) {
    const media = mediaOf(item);
    if (!media) continue;
    const guid = text(item.guid) || media.url;
    const ep = {
      guid,
      title: cap(item.title, 300) || cap(item['itunes:title'], 300),
      audio_url: media.url,
      mime: media.mime,
      published_at: date(item.pubDate),
    };
    if (media.bytes) ep.bytes = media.bytes;
    const dur = duration(item['itunes:duration']);
    if (dur) ep.duration = dur;
    const summary = plain(item['itunes:summary'] || item.description || item['content:encoded'], 400);
    if (summary) ep.summary = summary;
    const image = imageOf(item);
    if (image && image !== show.image) ep.image = image;
    const link = httpUrl(item.link);
    if (link) ep.link = link;
    const value = valueOf(item);
    if (value && !sameJson(value, show.value)) ep.value = value;
    out.push(ep);
  }
  return out;
}

const byNewest = (a, b) => (b.published_at ? b.published_at.getTime() : 0) - (a.published_at ? a.published_at.getTime() : 0);

/**
 * @param {string} xml
 * @param {{all?: boolean}} opts  all: read every item (up to MAX_ALL_ITEMS), for "load older"
 * @returns {{show, episodes, itemCount}} episodes newest first; KEEP_EPISODES of them unless `all`
 */
function parseFeed(xml, { all = false } = {}) {
  let channel;
  let cut = false;
  if (!all) {
    const t = truncateItems(xml, TRUNCATE_ITEMS);
    cut = t.cut;
    channel = parseDoc(t.xml);
  } else {
    channel = parseDoc(xml);
  }
  let rawItems = channel.item || [];
  if (cut) {
    // Oldest-first feed: the cut kept the OLDEST items. Read it whole instead.
    const first = date(rawItems[0] && rawItems[0].pubDate);
    const last = date(rawItems[rawItems.length - 1] && rawItems[rawItems.length - 1].pubDate);
    if (first && last && first < last) {
      const whole = parseFeed(xml, { all: true });
      return { ...whole, episodes: whole.episodes.slice(0, KEEP_EPISODES) };
    }
  }
  const show = readChannel(channel);
  if (rawItems.length > MAX_ALL_ITEMS) rawItems = rawItems.slice(0, MAX_ALL_ITEMS);
  const episodes = readItems(rawItems, show).sort(byNewest);
  if (!show.title && !episodes.length) {
    const e = new Error('no title and no playable episodes');
    e.code = 'not_a_podcast';
    throw e;
  }
  const itemCount = cut ? (xml.match(/<\/item>/g) || []).length : rawItems.length;
  return { show, episodes: all ? episodes : episodes.slice(0, KEEP_EPISODES), itemCount };
}

module.exports = { parseFeed, urlKey, episodeId, plain, duration, valueOf, KEEP_EPISODES, _test: { truncateItems } };
