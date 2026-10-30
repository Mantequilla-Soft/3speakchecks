/**
 * Reading an outside podcast's RSS feed into the lean shape we keep in Mongo
 * (every episode, up to MAX_ALL_ITEMS per show).
 *
 * Only what the Podcasts tab, the player and the tip window use survives:
 * descriptions become capped plain text (show notes are mostly HTML, links and
 * sponsor reads), and an episode only carries an image or a value block when it
 * differs from the show's, which is the common case for neither.
 *
 * Feeds are newest-first almost everywhere, so a routine poll (looking for new
 * episodes) parses just the first TRUNCATE_ITEMS items: a 10 MB back catalogue
 * becomes a few hundred KB of work. A full read (`all`) takes every item; when
 * the cut part turns out to be oldest-first, the whole document is read too.
 */
const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');

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
  'rss.channel.podcast:person',
  'rss.channel.podcast:liveItem',
  'rss.channel.podcast:liveItem.enclosure',
  'rss.channel.podcast:liveItem.podcast:alternateEnclosure',
  'rss.channel.podcast:liveItem.podcast:alternateEnclosure.podcast:source',
  'rss.channel.item.enclosure',
  'rss.channel.item.podcast:person',
  'rss.channel.item.podcast:transcript',
  'rss.channel.item.podcast:soundbite',
  'rss.channel.item.podcast:alternateEnclosure',
  'rss.channel.item.podcast:alternateEnclosure.podcast:source',
  'rss.channel.item.psc:chapters.psc:chapter',
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

/**
 * The url_key of a PRIVATE feed: one row per listener (their password or token is
 * theirs), so the key names the listener, and is a hash so the token in a URL
 * never sits in an index. It never matches a public feed's key.
 */
function privateKey(user, raw) {
  const k = urlKey(raw);
  if (!k) return '';
  return `private:${user}:${crypto.createHash('sha256').update(k).digest('base64url').slice(0, 32)}`;
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

function enclosureOf(e) {
  if (!e || typeof e !== 'object') return null;
  const url = httpUrl(e['@_url']);
  if (!url) return null;
  const mime = String(e['@_type'] || '').toLowerCase().slice(0, 40);
  if (!(mime.startsWith('audio/') || mime.startsWith('video/') || MEDIA_EXT.test(url))) return null;
  const bytes = parseInt(e['@_length'], 10);
  return { url, mime, bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : 0 };
}

const isVideo = (m) => m.mime.startsWith('video/') || (!m.mime && /\.(mp4|m4v|webm)(\?|$)/i.test(m.url));

/**
 * The episode's playable file. With several enclosures (rare, but some shows list
 * an audio and a video file) the audio one plays and the video one is `video`.
 */
function mediaOf(item) {
  const list = (Array.isArray(item.enclosure) ? item.enclosure : [item.enclosure]).slice(0, 4).map(enclosureOf).filter(Boolean);
  if (!list.length) return null;
  const audio = list.find((m) => !isVideo(m));
  const video = list.find(isVideo);
  return { ...(audio || video), video: video ? { url: video.url, mime: video.mime || 'video/mp4' } : null };
}

/** A video version from podcast:alternateEnclosure (video/* with a web source). */
function alternateVideo(node) {
  for (const alt of (node['podcast:alternateEnclosure'] || []).slice(0, 10)) {
    const mime = String(alt['@_type'] || '').toLowerCase().slice(0, 40);
    if (!mime.startsWith('video/')) continue;
    for (const src of (alt['podcast:source'] || []).slice(0, 5)) {
      const url = httpUrl(src && src['@_uri']);
      if (url) return { url, mime };
    }
  }
  return null;
}

/** "01:02:03.500", "62:03", "3723.5" → seconds (psc:chapter start, soundbites). */
function timeOf(v) {
  const s = text(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!m) return NaN;
  return (parseInt(m[1] || '0', 10) * 3600) + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + (m[4] ? parseInt(m[4].padEnd(3, '0'), 10) / 1000 : 0);
}

const round3 = (n) => Math.round(n * 1000) / 1000;

function positiveNumber(v, max) {
  const n = parseFloat(text(v));
  return Number.isFinite(n) && n > 0 && n <= max ? n : 0;
}

const MAX_PERSONS = 8;

/** podcast:person: host, guest, editor... (role and group lowercased, the spec's defaults). */
function personsOf(node) {
  return (node['podcast:person'] || []).map((p) => {
    const name = cap(p, 120);
    if (!name) return null;
    const out = {
      name,
      role: cap(p && p['@_role'], 40).toLowerCase() || 'host',
      group: cap(p && p['@_group'], 40).toLowerCase() || 'cast',
    };
    const img = httpUrl(p && p['@_img']);
    if (img) out.img = img;
    const href = httpUrl(p && p['@_href']);
    if (href) out.href = href;
    return out;
  }).filter(Boolean).slice(0, MAX_PERSONS);
}

// Inline chapters (Podlove Simple Chapters), kept on the episode: a few dozen at most.
const MAX_INLINE_CHAPTERS = 80;
function inlineChapters(item) {
  const psc = item['psc:chapters'];
  const list = (psc && psc['psc:chapter']) || [];
  return list.slice(0, MAX_INLINE_CHAPTERS).map((c) => {
    const start = timeOf(c && c['@_start']);
    if (!Number.isFinite(start) || start < 0) return null;
    const out = { start: round3(start), title: cap(c['@_title'], 200) };
    const url = httpUrl(c['@_href']);
    if (url) out.url = url;
    const img = httpUrl(c['@_image']);
    if (img) out.img = img;
    return out;
  }).filter(Boolean);
}

const MAX_TRANSCRIPTS = 6;
/** podcast:transcript: where each language's transcript is. The URLs stay on the server. */
function transcriptsOf(item, show) {
  const fallback = show.language ? show.language.split(/[-_]/)[0] : 'und';
  const out = [];
  for (const t of item['podcast:transcript'] || []) {
    const url = httpUrl(t && t['@_url']);
    if (!url) continue;
    const lang = cap(t['@_language'], 12).toLowerCase() || fallback;
    out.push({ url, type: cap(t['@_type'], 40).toLowerCase() || 'text/plain', lang });
    if (out.length >= MAX_TRANSCRIPTS) break;
  }
  return out;
}

const MAX_SOUNDBITES = 8;
function soundbitesOf(item) {
  return (item['podcast:soundbite'] || []).map((b) => {
    const start = timeOf(b && b['@_startTime']);
    const dur = positiveNumber(b && b['@_duration'], 600);
    if (!Number.isFinite(start) || start < 0 || !dur) return null;
    const out = { start: round3(start), duration: round3(dur) };
    const title = cap(b, 200);
    if (title) out.title = title;
    return out;
  }).filter(Boolean).slice(0, MAX_SOUNDBITES);
}

/** A whole number, or a decimal like podcast:episode 1.5, within reason. */
function seasonNumber(v) {
  const n = parseFloat(text(v));
  return Number.isFinite(n) && n >= 0 && n < 100000 ? n : null;
}

const LIVE_STATUS = new Set(['pending', 'live']);
const MAX_LIVE = 3;

/**
 * podcast:liveItem, the show's upcoming and running live streams. Ended ones are
 * dropped here; the API also drops the ones whose time is clearly up, since an
 * unchanged feed is not read again.
 */
function liveItemsOf(channel) {
  const out = [];
  for (const li of channel['podcast:liveItem'] || []) {
    const status = String((li && li['@_status']) || '').toLowerCase();
    if (!LIVE_STATUS.has(status)) continue;
    const enc = (li.enclosure || []).map(enclosureOf).find(Boolean)
      || (() => {
        for (const alt of li['podcast:alternateEnclosure'] || []) {
          for (const src of alt['podcast:source'] || []) {
            const url = httpUrl(src && src['@_uri']);
            if (url) return { url, mime: String(alt['@_type'] || '').toLowerCase().slice(0, 40) };
          }
        }
        return null;
      })()
      || (() => {
        // An HLS stream as the enclosure: no audio/video type, no media extension.
        const e = (li.enclosure || [])[0];
        const url = httpUrl(e && e['@_url']);
        return url ? { url, mime: String(e['@_type'] || '').toLowerCase().slice(0, 40) } : null;
      })();
    if (!enc) continue;
    // Not date(): an upcoming stream's start is in the future on purpose.
    const startRaw = text(li['@_start']).trim();
    const start = startRaw && !Number.isNaN(new Date(startRaw).getTime()) ? new Date(startRaw) : null;
    const guid = text(li.guid) || enc.url;
    const item = {
      id: crypto.createHash('sha1').update(String(guid)).digest('base64url').slice(0, 12),
      title: cap(li.title, 300),
      status,
      start: start || null,
      url: enc.url,
      mime: enc.mime || '',
    };
    const endRaw = text(li['@_end']).trim();
    const end = endRaw ? new Date(endRaw) : null;
    if (end && !Number.isNaN(end.getTime())) item.end = end;
    const cl = li['podcast:contentLink'];
    const link = httpUrl(cl && (cl['@_href'] || text(cl)));
    if (link) item.link = link;
    out.push(item);
    if (out.length >= MAX_LIVE) break;
  }
  return out;
}

function sameJson(a, b) {
  return JSON.stringify(a || null) === JSON.stringify(b || null);
}

/**
 * Cut a document after its Nth </item> and close it again. Live items placed
 * after the episodes (most feeds put them first) are carried over, so a routine
 * poll still sees a stream going live.
 */
function truncateItems(xml, n) {
  let idx = -1;
  for (let i = 0; i < n; i += 1) {
    idx = xml.indexOf('</item>', idx + 1);
    if (idx < 0) return { xml, cut: false };
  }
  const head = xml.slice(0, idx + 7);
  let live = '';
  let from = idx + 7;
  for (let i = 0; i < MAX_LIVE * 2; i += 1) {
    const a = xml.indexOf('<podcast:liveItem', from);
    if (a < 0) break;
    const b = xml.indexOf('</podcast:liveItem>', a);
    if (b < 0) break;
    live += xml.slice(a, b + 19);
    from = b + 19;
  }
  return { xml: `${head}${live}</channel></rss>`, cut: true };
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
    persons: personsOf(channel),
    live: liveItemsOf(channel),
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

    const season = seasonNumber(item['podcast:season'] || item['itunes:season']);
    if (season != null) ep.season = season;
    const number = seasonNumber(item['podcast:episode'] || item['itunes:episode']);
    if (number != null) ep.episode = number;
    const type = text(item['itunes:episodeType']).trim().toLowerCase();
    if (type === 'trailer' || type === 'bonus') ep.episode_type = type;
    // Chapters: a JSON file (read on demand, routes/podcasts.js) or inline ones.
    const ch = item['podcast:chapters'];
    const chaptersUrl = httpUrl(ch && ch['@_url']);
    if (chaptersUrl) {
      ep.chapters_url = chaptersUrl;
      ep.chapters_type = cap(ch['@_type'], 60).toLowerCase();
    }
    const inline = inlineChapters(item);
    if (inline.length) ep.chapters_inline = inline;
    if (chaptersUrl || inline.length) ep.chapters = true;
    const transcripts = transcriptsOf(item, show);
    if (transcripts.length) ep.transcripts = transcripts;
    // Episode people only when they are not just the show's (which then apply).
    const persons = personsOf(item);
    if (persons.length && !sameJson(persons, show.persons)) ep.persons = persons;
    const soundbites = soundbitesOf(item);
    if (soundbites.length) ep.soundbites = soundbites;
    const video = media.video || alternateVideo(item);
    if (video) ep.video = video;
    out.push(ep);
  }
  return out;
}

const byNewest = (a, b) => (b.published_at ? b.published_at.getTime() : 0) - (a.published_at ? a.published_at.getTime() : 0);

/**
 * @param {string} xml
 * @param {{all?: boolean}} opts  all: read every item (up to MAX_ALL_ITEMS)
 * @returns {{show, episodes, itemCount, complete}} episodes newest first; only the
 *   newest TRUNCATE_ITEMS unless `all`. `complete`: every item was read.
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
      return { ...whole, episodes: whole.episodes.slice(0, TRUNCATE_ITEMS), complete: false };
    }
  }
  const show = readChannel(channel);
  if (rawItems.length > MAX_ALL_ITEMS) rawItems = rawItems.slice(0, MAX_ALL_ITEMS);
  const episodes = readItems(rawItems, show).sort(byNewest);
  // A show without cover art of its own (ARD's feeds, for one) takes the art of
  // its most recent episode that has some; with none at all the page shows its
  // podcast placeholder. Episodes with that same art then don't repeat it.
  if (!show.image) {
    const newestArt = episodes.find((e) => e.image);
    if (newestArt) {
      show.image = newestArt.image;
      for (const e of episodes) if (e.image === show.image) delete e.image;
    }
  }
  if (!show.title && !episodes.length) {
    const e = new Error('no title and no playable episodes');
    e.code = 'not_a_podcast';
    throw e;
  }
  const itemCount = cut ? (xml.match(/<\/item>/g) || []).length : rawItems.length;
  return { show, episodes, itemCount, complete: !cut };
}

const NOTES_MAX = 60 * 1024;

/**
 * Every episode's full show notes, as the feed has them (HTML), keyed by the
 * same guid readItems() uses, so episodeId(feed, guid) finds them. Not stored:
 * the episode page asks for them (routes/podcasts.js /episode/:id/notes) and the
 * page sanitises them. Each is capped at NOTES_MAX.
 */
function notesByGuid(xml) {
  const channel = parseDoc(xml);
  const out = new Map();
  for (const item of (channel.item || []).slice(0, MAX_ALL_ITEMS)) {
    const media = mediaOf(item);
    if (!media) continue;
    const guid = text(item.guid) || media.url;
    const html = text(item['content:encoded']) || text(item.description) || text(item['itunes:summary']);
    if (html) out.set(guid, html.length > NOTES_MAX ? html.slice(0, NOTES_MAX) : html);
  }
  return out;
}

module.exports = { notesByGuid, parseFeed, urlKey, privateKey, episodeId, plain, decodeEntities, duration, timeOf, valueOf, TRUNCATE_ITEMS, MAX_ALL_ITEMS, _test: { truncateItems } };
