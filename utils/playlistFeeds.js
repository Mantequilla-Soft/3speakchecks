/**
 * Outside podcast shows inside a 3Speak playlist.
 *
 * The owner adds whole shows to a playlist: their feed URLs sit in the playlist's
 * own on-chain `json_metadata` as `feeds: [{ url, title }]` (the site writes them
 * with every playlist update; the indexer passes json_metadata through untouched).
 * The shows themselves are ordinary rows in `podcast_feeds`, polled like any
 * followed show while a playlist names them (services/podcastFeeds.js
 * syncPlaylistFeeds sets `playlist_refs`), and their episodes are merged by date
 * with the playlist's 3Speak items on the page and in its RSS feed.
 *
 * Only public feeds: a URL with a password in it never belongs on chain, and is
 * dropped here even if one got there.
 */
const { decodeJsonMeta } = require('./playlistType');
const { urlKey } = require('./podcastParse');

const MAX_PLAYLIST_FEEDS = 25;
const MAX_URL_LENGTH = 2000;
const FEEDS = 'podcast_feeds';

/** A feed URL as a playlist may carry it, or '' (not http(s), credentials, too long). */
function cleanFeedUrl(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > MAX_URL_LENGTH) return '';
  let u;
  try { u = new URL(s); } catch (_) { return ''; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  if (u.username || u.password) return '';
  return s;
}

/**
 * The distinct, valid feed URLs in `list` (strings or `{ url }`), at most
 * MAX_PLAYLIST_FEEDS, each with its url_key: [{ url, key }].
 */
function feedRefs(list) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const url = cleanFeedUrl(item && typeof item === 'object' ? item.url : item);
    const key = url && urlKey(url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ url, key });
    if (out.length >= MAX_PLAYLIST_FEEDS) break;
  }
  return out;
}

/** 3Speak's own channel feeds (`3speak.tv/rss/<user>.xml`): the account, else null. */
function internalOwner(key) {
  const m = String(key || '').match(/^(?:[a-z0-9-]+\.)?3speak\.tv\/rss\/([a-z0-9.-]+)\.xml$/);
  return m ? m[1] : null;
}

/**
 * The 3Speak post an outside episode links to (`3speak.tv/watch?v=a/p` or
 * `3speak.tv/@a/p`), as 'author/permlink', else ''. A 3Speak feed added as a
 * show repeats posts the playlist may already hold.
 */
function threeSpeakRef(link) {
  let u;
  try { u = new URL(String(link || '')); } catch (_) { return ''; }
  if (!/^(www\.)?3speak\.tv$/i.test(u.hostname)) return '';
  let ref = '';
  if (u.pathname === '/watch') ref = u.searchParams.get('v') || '';
  else if (u.pathname.startsWith('/@')) {
    try { ref = decodeURIComponent(u.pathname.slice(2)); } catch (_) { return ''; }
  }
  const m = /^([a-z0-9][a-z0-9.-]{1,15})\/([a-z0-9-]+)$/i.exec(ref);
  return m ? `${m[1].toLowerCase()}/${m[2]}` : '';
}

/** The outside shows a playlist doc names: [{ url, key }]. A playlist's own feed is never one of them. */
function playlistFeedRefs(playlist) {
  if (!playlist) return [];
  const own = new RegExp(`/rss/playlist/${String(playlist._id).replace(/[^A-Za-z0-9-]/g, '')}\\.xml$`);
  return feedRefs(decodeJsonMeta(playlist.json_metadata).feeds).filter((r) => !own.test(r.key));
}

/**
 * The public `podcast_feeds` rows for `refs`, matched like a follow is (url_key
 * or one of the show's alt_keys). Resolves to a Map url_key → row; refs we have
 * no row for are simply missing from it.
 */
async function findFeedsFor(db, refs, projection = undefined) {
  const byKey = new Map();
  if (!refs.length) return byKey;
  const keys = refs.map((r) => r.key);
  const rows = await db.collection(FEEDS).find(
    { $or: [{ url_key: { $in: keys } }, { alt_keys: { $in: keys } }], private: { $ne: true } },
    projection ? { projection: { ...projection, url_key: 1, alt_keys: 1 } } : {},
  ).toArray();
  for (const row of rows) {
    for (const k of [row.url_key, ...(row.alt_keys || [])]) {
      if (keys.includes(k) && !byKey.has(k)) byKey.set(k, row);
    }
  }
  return byKey;
}

module.exports = { MAX_PLAYLIST_FEEDS, cleanFeedUrl, feedRefs, playlistFeedRefs, findFeedsFor, internalOwner, threeSpeakRef };
