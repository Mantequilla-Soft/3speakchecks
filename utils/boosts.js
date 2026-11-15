/**
 * Boosts: tips sent from a post's Boost button (new-3speak-tv src/lib/boosts.js),
 * shown on that post's boost wall (routes/boosts.js).
 *
 * A boost is an ordinary tip whose memo (Hive transfer) or comment (Lightning)
 * carries the post's 3speak.tv link and the tag `#boost`:
 *     "Great episode! https://3speak.tv/audio/badadib/song #boost"
 * Streamed sats (a few sats a minute while someone listens, sent by a Lightning
 * wallet in the browser) carry `#stream` instead and are added up per listener,
 * post and day rather than kept one row per minute (services/lightningSupports.js).
 */

const TAG_RE = /(^|\s)#(boost|stream)\b/i;
// Same link forms as services/lightningSupports.js LINK_RE.
const LINK_RE = /https?:\/\/(?:www\.)?3speak\.tv\/(?:audio\/|watch\?v=|shorts\?v=|@)([a-z0-9.-]{3,16})\/([a-z0-9-]{1,255})\S*/gi;

/** 'boost', 'stream' or null. */
function boostKind(memo) {
  const m = TAG_RE.exec(String(memo || ''));
  return m ? m[2].toLowerCase() : null;
}

/** The sender's own words: the memo without the post link and the tags. */
function wallMessage(memo) {
  return String(memo || '')
    .replace(LINK_RE, ' ')
    .replace(/(^|\s)#[a-z0-9_]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim() || null;
}

/** The [author, permlink] pairs a memo links to. */
function linkedPosts(memo) {
  const out = [];
  for (const m of String(memo || '').matchAll(LINK_RE)) out.push([m[1].toLowerCase(), m[2].toLowerCase()]);
  return out;
}

/** The one row a day of streamed sats from one listener to one post adds up in. */
function streamKey({ author, permlink, tipper, at }) {
  const day = new Date(at).toISOString().slice(0, 10);
  return `stream:${day}:${author}/${permlink}:${tipper || 'anon'}`;
}

module.exports = { boostKind, wallMessage, linkedPosts, streamKey };
