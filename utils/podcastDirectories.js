/**
 * The podcast directories behind the Podcasts tab's search, charts and links.
 *
 * - Podcast Index: search, people, trending. Needs PODCASTINDEX_API_KEY/_SECRET.
 * - Apple Podcasts: the iTunes Search API, the per-country top charts and the
 *   lookup that turns an Apple Podcasts link into its feed. No key.
 * - fyyd.de: an independent directory, strong on German shows. No key.
 *
 * Every result is a show WITH its RSS address, in one shape (`show()`), so it can
 * be followed like any feed. A search asks all of them at once and merges the
 * answers: one entry per feed, the ones several directories agree on first.
 */
const crypto = require('crypto');
const { artToken } = require('./podcastArt');
const { urlKey } = require('./podcastParse');
const { safeFetch } = require('./safeFetch');

const PI_KEY = process.env.PODCASTINDEX_API_KEY || '';
const PI_SECRET = process.env.PODCASTINDEX_API_SECRET || '';
const UA = '3SpeakPodcastBot/1.0 (+https://3speak.tv)';
const TIMEOUT_MS = 8000;

const piEnabled = () => !!(PI_KEY && PI_SECRET);

async function getJson(url, headers = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`${new URL(url).hostname} ${r.status}`);
  return r.json();
}

/** A GET on the Podcast Index API, signed the way it asks (key + secret + time). */
function piGet(path) {
  const date = String(Math.floor(Date.now() / 1000));
  const auth = crypto.createHash('sha1').update(PI_KEY + PI_SECRET + date).digest('hex');
  return getJson(`https://api.podcastindex.org/api/1.0/${path}`, { 'X-Auth-Key': PI_KEY, 'X-Auth-Date': date, Authorization: auth });
}

const clip = (v, n) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);
const toDate = (v) => {
  if (!v) return null;
  const d = typeof v === 'number' ? new Date(v * 1000) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** One show, whatever directory it came from. */
function show({ title, author, url, image, episodes, last, value, source, extra = {} }) {
  const img = String(image || '');
  return {
    title: clip(title, 200),
    author: clip(author, 120),
    url: String(url || '').trim(),
    image: img,
    art: artToken(img),
    episodes: Number(episodes) || 0,
    last_episode_at: toDate(last),
    value: !!value,
    sources: [source],
    ...extra,
  };
}

const piShow = (f) => show({
  title: f.title, author: f.author || f.ownerName, url: f.url, image: f.artwork || f.image,
  episodes: f.episodeCount, last: f.newestItemPubdate || f.newestItemPublishTime, value: f.value, source: 'podcastindex',
});
const appleShow = (r) => show({
  title: r.collectionName || r.trackName, author: r.artistName, url: r.feedUrl, image: r.artworkUrl600 || r.artworkUrl100,
  episodes: r.trackCount, last: r.releaseDate, source: 'apple', extra: { apple_id: r.collectionId },
});
const fyydShow = (p) => show({
  title: p.title, author: p.author, url: p.xmlURL, image: p.imgURL || p.layoutImageURL,
  episodes: p.episode_count, last: p.lastpub, source: 'fyyd',
});
const followable = (s) => /^https?:\/\//i.test(s.url) && s.title;

// ─── Search ───────────────────────────────────────────────────────────────────

async function searchPodcastIndex(term) {
  const data = await piGet(`search/byterm?q=${encodeURIComponent(term)}&max=25`);
  return (data.feeds || []).filter((f) => f.url && !f.dead).map(piShow);
}

async function searchApple(term, country = 'us') {
  const data = await getJson(`https://itunes.apple.com/search?media=podcast&entity=podcast&limit=25&country=${country}&term=${encodeURIComponent(term)}`);
  return (data.results || []).filter((r) => r.feedUrl).map(appleShow);
}

async function searchFyyd(term) {
  const data = await getJson(`https://api.fyyd.de/0.2/search/podcast?title=${encodeURIComponent(term)}&count=20`);
  return (data.data || []).filter((p) => p.xmlURL).map(fyydShow);
}

const titleKey = (s) => `${s.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')}|${s.author.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')}`;

/**
 * One list from several directories' answers. A feed counts once (by its URL,
 * or by title + author when two directories hold different URLs for it); the
 * entry keeps the first directory's data and fills gaps from the others. Order:
 * shows more directories found first, then by their best rank.
 */
function mergeShows(lists, max = 30) {
  const byKey = new Map();
  const entries = [];
  for (const list of lists) {
    list.filter(followable).forEach((s, rank) => {
      const keys = [urlKey(s.url), titleKey(s)].filter(Boolean);
      let entry = keys.map((k) => byKey.get(k)).find(Boolean);
      if (!entry) {
        entry = { ...s, sources: [], score: 0, best: Infinity };
        entries.push(entry);
      }
      for (const k of keys) byKey.set(k, entry);
      for (const src of s.sources) if (!entry.sources.includes(src)) entry.sources.push(src);
      entry.score += 1;
      entry.best = Math.min(entry.best, rank);
      for (const f of ['author', 'image', 'art', 'last_episode_at', 'apple_id']) if (!entry[f] && s[f]) entry[f] = s[f];
      entry.episodes = Math.max(entry.episodes || 0, s.episodes || 0);
      entry.value = entry.value || s.value;
    });
  }
  return entries
    .sort((a, b) => b.score - a.score || a.best - b.best)
    .slice(0, max)
    .map(({ score, best, ...s }) => s);
}

/** Every directory at once; fails only when all of them did. */
async function searchAll(term, { country = 'us' } = {}) {
  const asks = [searchApple(term, country), searchFyyd(term)];
  if (piEnabled()) asks.unshift(searchPodcastIndex(term));
  const settled = await Promise.allSettled(asks);
  const ok = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  for (const r of settled) if (r.status === 'rejected') console.warn('[podcasts] directory search:', r.reason && r.reason.message);
  if (!ok.length) throw new Error('every directory failed');
  return mergeShows(ok);
}

// ─── Apple charts ─────────────────────────────────────────────────────────────

// Apple's podcast genre ids for the top-level categories (the names the
// frontend and Podcast Index use).
const APPLE_GENRES = {
  Arts: 1301, Business: 1321, Comedy: 1303, Education: 1304, Fiction: 1483, Government: 1511, Health: 1512,
  History: 1487, Kids: 1305, Leisure: 1502, Music: 1310, News: 1489, Religion: 1314, Science: 1533,
  Society: 1324, Sports: 1545, Technology: 1318, 'True Crime': 1488, TV: 1309,
};

// Apple Podcasts storefronts the charts offer (ISO country codes).
const CHART_COUNTRIES = [
  'us', 'gb', 'ca', 'au', 'ie', 'nz', 'in', 'za', 'ng', 'ke', 'de', 'at', 'ch', 'fr', 'be', 'nl', 'lu', 'es', 'pt',
  'it', 'pl', 'cz', 'se', 'no', 'dk', 'fi', 'ua', 'tr', 'gr', 'ro', 'hu', 'il', 'ae', 'sa', 'eg', 'mx', 'br', 'ar',
  'co', 'cl', 'pe', 'jp', 'kr', 'tw', 'hk', 'sg', 'ph', 'id', 'my', 'th', 'vn',
];

/**
 * Apple Podcasts' top shows in one country (and genre), each with its feed. The
 * chart names shows by Apple id only; one lookup call fetches their feeds. Shows
 * Apple keeps to itself (no public feed) are left out.
 */
async function appleChart(country, category = '', limit = 50) {
  const genre = APPLE_GENRES[category];
  const chart = await getJson(`https://itunes.apple.com/${country}/rss/toppodcasts/limit=${limit}${genre ? `/genre=${genre}` : ''}/json`);
  let entries = chart.feed && chart.feed.entry ? chart.feed.entry : [];
  if (!Array.isArray(entries)) entries = [entries];
  const ids = entries.map((e) => e && e.id && e.id.attributes && e.id.attributes['im:id']).filter((id) => /^\d+$/.test(id || ''));
  if (!ids.length) return [];
  const found = await getJson(`https://itunes.apple.com/lookup?entity=podcast&country=${country}&id=${ids.join(',')}`);
  const byId = new Map((found.results || []).filter((r) => r.feedUrl).map((r) => [String(r.collectionId), r]));
  return ids
    .map((id, i) => (byId.has(id) ? { ...appleShow(byId.get(id)), rank: i + 1 } : null))
    .filter(Boolean);
}

// ─── Links people paste ───────────────────────────────────────────────────────

// Apps that keep their shows' feeds to themselves: nothing to follow there.
const CLOSED_PLATFORMS = [
  [/(^|\.)spotify\.com$|(^|\.)spotify\.link$/, 'Spotify'],
  [/(^|\.)youtube\.com$|(^|\.)youtu\.be$/, 'YouTube'],
  [/(^|\.)music\.amazon\.[a-z.]+$|(^|\.)audible\.[a-z.]+$/, 'Amazon'],
  [/(^|\.)deezer\.com$/, 'Deezer'],
];

const fail = (code, extra = {}) => ({ code, ...extra });

async function appleFeed(id) {
  const data = await getJson(`https://itunes.apple.com/lookup?entity=podcast&id=${id}`);
  const r = (data.results || []).find((x) => String(x.collectionId) === String(id)) || (data.results || [])[0];
  if (!r) return fail('directory_not_found');
  return r.feedUrl ? { url: r.feedUrl, via: 'apple' } : fail('apple_only');
}

/**
 * The feed behind a link from a podcast directory or app, or the URL itself when
 * it is none of those. { url, via } or { code }. Never throws for a URL that is
 * simply not a directory link.
 */
async function resolveLink(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return { url: raw }; }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const path = u.pathname;
  try {
    for (const [re, platform] of CLOSED_PLATFORMS) if (re.test(host)) return fail('closed_platform', { platform });

    // podcasts.apple.com/<cc>/podcast/<slug>/id123, itunes.apple.com/...id123
    if (/(^|\.)(podcasts|itunes)\.apple\.com$/.test(host)) {
      const m = path.match(/\/id(\d+)/);
      return m ? await appleFeed(m[1]) : fail('directory_not_found');
    }
    // overcast.fm/itunes123/<slug> and pod.link/123 both name the Apple id.
    if (host === 'overcast.fm') {
      const m = path.match(/^\/itunes(\d+)/);
      return m ? await appleFeed(m[1]) : fail('directory_not_found');
    }
    if (host === 'pod.link') {
      const m = path.match(/^\/(\d+)/);
      return m ? await appleFeed(m[1]) : fail('directory_not_found');
    }
    // podcastindex.org/podcast/123
    if (host === 'podcastindex.org') {
      const m = path.match(/^\/podcast\/(\d+)/);
      if (!m || !piEnabled()) return fail('directory_not_found');
      const data = await piGet(`podcasts/byfeedid?id=${m[1]}`);
      return data.feed && data.feed.url ? { url: data.feed.url, via: 'podcastindex' } : fail('directory_not_found');
    }
    // fyyd.de/podcast/<slug>/0
    if (host === 'fyyd.de') {
      const m = path.match(/^\/podcast\/([^/]+)/);
      if (!m) return fail('directory_not_found');
      const data = await getJson(`https://api.fyyd.de/0.2/podcast?podcast_slug=${encodeURIComponent(m[1])}`);
      return data.data && data.data.xmlURL ? { url: data.data.xmlURL, via: 'fyyd' } : fail('directory_not_found');
    }
    // Google Podcasts (closed in 2024) carried the feed URL in its own links.
    if (host === 'podcasts.google.com') {
      const m = path.match(/^\/feed\/([A-Za-z0-9_-]+)/);
      if (!m) return fail('directory_not_found');
      const url = Buffer.from(m[1], 'base64url').toString('utf8');
      return /^https?:\/\//.test(url) ? { url, via: 'google' } : fail('directory_not_found');
    }
  } catch (err) {
    console.warn('[podcasts] resolve link:', err.message);
    return fail('directory_down');
  }
  return { url: u.toString() };
}

/**
 * A show's website instead of its feed: the feed its page announces with
 * <link rel="alternate" type="application/rss+xml">, or null.
 */
async function discoverFeed(pageUrl) {
  let res;
  try {
    res = await safeFetch(pageUrl, { timeoutMs: 10000, maxBytes: 3 * 1024 * 1024, headers: { Accept: 'text/html' } });
  } catch {
    return null;
  }
  const type = String(res.headers['content-type'] || '');
  if (!/html/i.test(type)) return null;
  const html = res.body.toString('utf8');
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    if (!/\brel\s*=\s*["']?alternate\b/i.test(tag)) continue;
    if (!/\btype\s*=\s*["']?application\/(rss|atom)\+xml/i.test(tag)) continue;
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!href) continue;
    // Comment feeds are announced the same way and are not the show.
    if (/comments?\/feed|\/comments\b/i.test(href[1])) continue;
    try { return new URL(href[1], res.url).toString(); } catch { /* not a URL */ }
  }
  return null;
}

module.exports = {
  piEnabled, piGet, piShow, show,
  searchAll, mergeShows, appleChart, resolveLink, discoverFeed,
  APPLE_GENRES, CHART_COUNTRIES,
};
