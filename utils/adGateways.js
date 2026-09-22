/**
 * Which IPFS gateway, and for what.
 *
 * THE RULE: a gateway host is a delivery decision taken at the moment of use. It is
 * not a property of the content and it does not belong in a database row.
 *
 * This file exists because we stored one. adCreativeSync wrote
 * `https://<gateway>/ipfs/<cid>/manifest.m3u8` onto every creative as it encoded, and
 * the gateway it named cannot serve content that new. Every reader inherited that one
 * choice, including the single path that hands a url to a page — which gets one
 * attempt and no fallback, unlike every server-side fetch in adServe. The result was
 * a banner that drew nothing while its close button, its open-in-new icon and its
 * "Ad" label all rendered perfectly, because those are built from the placement the
 * server sends and never touch the asset.
 *
 * So rows store a CID and callers ask here for a url.
 */

/**
 * Every gateway we know. ORDER IS FALLBACK, not preference: a server-side fetch tries
 * the url it was given and then walks this list. Membership is also what makes a url
 * "ours" — gatewaySiblings() and sameContentScope() both key on it.
 */
const GATEWAY_HOSTS = [
  'ipfs-3speak.b-cdn.net',
  // Last on purpose. A fallback walk that reaches hotipfs-3speak-1 before
  // ipfs.3speak.tv spends a round trip on a 500 it was always going to get for
  // anything cold, and utils/videoDuration.js already ordered it this way.
  'ipfs.3speak.tv',
  'hotipfs-3speak-1.b-cdn.net',
];

/**
 * Of those, the ones a BROWSER can read: they answer with Access-Control-Allow-Origin.
 *
 * 🚨 This says nothing about whether the bytes arrive. Keep the two apart. They were
 * one list once, called BROWSER_SAFE_HOSTS, and hotipfs-3speak-1 was in it for the
 * correct reason (its CORS headers are perfect, including on its failures) while
 * being the one gateway that cannot deliver. That was harmless for as long as the
 * only consumer was a playlist validator sitting on top of a retry loop, and became
 * the bug above the day something started handing single urls to pages.
 */
const CORS_HOSTS = ['ipfs-3speak.b-cdn.net', 'hotipfs-3speak-1.b-cdn.net'];

/**
 * And the ones measured to serve content that is NOT already in their cache.
 *
 * hotipfs-3speak-1 is absent on evidence: 24 of 24 random published videos, four
 * attempts each, HTTP 500 every time, no warm-up (2026-08-25), and both of the first
 * advertiser's creatives again on 2026-09-22 while three older in-house ones it
 * happened to hold served fine. That last detail is why this went unnoticed for a
 * month: every internal rehearsal ran on assets it had.
 */
const COLD_CAPABLE_HOSTS = ['ipfs-3speak.b-cdn.net', 'ipfs.3speak.tv'];

/**
 * An operator escape hatch, for the next time a gateway dies at an inconvenient hour.
 * Accepts a bare hostname or a full url, and goes to the front of the preference.
 *
 * ⚠️ It overrides the measured properties above, which is the point of it and also
 * the risk: a host named here is trusted without evidence.
 */
const ENV_HOST = (() => {
  const raw = String(process.env.AD_CDN_GATEWAY || '').trim();
  if (!raw) return null;
  try {
    return new URL(raw.includes('//') ? raw : `https://${raw}`).hostname || null;
  } catch (_) {
    return null;
  }
})();

/**
 * The host to USE. Server-side callers need one that can pull cold content; page-
 * facing ones need that AND readable CORS, because they have no second attempt.
 */
function preferredHost({ browser = false } = {}) {
  const usable = COLD_CAPABLE_HOSTS.filter((h) => !browser || CORS_HOSTS.includes(h));
  const ordered = ENV_HOST ? [ENV_HOST, ...usable] : usable;
  // GATEWAY_HOSTS[0] is the backstop: a filter that removed everything would
  // otherwise return undefined and build "https://undefined/ipfs/...".
  return ordered[0] || GATEWAY_HOSTS[0];
}

/** `https://<gateway>/ipfs/<cid>/manifest.m3u8`, or null for a creative with no CID. */
function manifestUrlFor(cid, opts) {
  if (!cid) return null;
  return `https://${preferredHost(opts)}/ipfs/${cid}/manifest.m3u8`;
}

/**
 * The CID out of a stored url, for rows written before this file existed.
 *
 * Kept rather than migrated: it makes the change a pure code change, and a legacy row
 * resolves to a working host on its next read instead of on the day someone remembers
 * to run a script.
 */
function cidFromManifestUrl(url) {
  const m = /\/ipfs\/([^/?#]+)\//.exec(String(url || ''));
  return m ? m[1] : null;
}

/** Where this creative's video actually lives, right now, for this kind of caller. */
function creativeManifestUrl(creative, opts) {
  if (!creative) return null;
  const cid = creative.manifestCid || cidFromManifestUrl(creative.manifestUrl);
  return manifestUrlFor(cid, opts);
}

/**
 * Has the encoder produced something to serve?
 *
 * One name for a question asked by the review gate, the serving gate, the advertiser
 * console and the operator CLI. It used to be `!!cr.manifestUrl` in four places, so
 * moving the storage would have quietly answered "no" in whichever one got missed.
 */
function creativeIsEncoded(creative) {
  return !!(creative && (creative.manifestCid || creative.manifestUrl));
}

/** Can a browser read this url at all? CORS only. See CORS_HOSTS. */
const isBrowserSafe = (url) => {
  try { return CORS_HOSTS.includes(new URL(url).hostname); } catch (_) { return false; }
};

/**
 * The same object, on a host we would choose ourselves. Non-gateway urls (an
 * advertiser's own image host, images.3speak.tv) are returned untouched.
 */
function browserAssetUrl(url) {
  try {
    const u = new URL(url);
    if (!GATEWAY_HOSTS.includes(u.hostname)) return url;
    u.hostname = preferredHost({ browser: true });
    return u.href;
  } catch (_) {
    return url;
  }
}

/** The same object on the other gateways, in order. Empty for a non-gateway URL. */
function gatewaySiblings(url) {
  try {
    const u = new URL(url);
    if (!GATEWAY_HOSTS.includes(u.hostname)) return [];
    return GATEWAY_HOSTS.filter((h) => h !== u.hostname).map((h) => {
      const alt = new URL(u.href);
      alt.hostname = h;
      return alt.href;
    });
  } catch (_) {
    return [];
  }
}

/** Do these two URLs address the same content through interchangeable gateways? */
function sameContentScope(a, b) {
  try {
    const x = new URL(a);
    const y = new URL(b);
    if (x.origin === y.origin) return true;
    return GATEWAY_HOSTS.includes(x.hostname) && GATEWAY_HOSTS.includes(y.hostname);
  } catch (_) {
    return false;
  }
}

module.exports = {
  GATEWAY_HOSTS,
  CORS_HOSTS,
  COLD_CAPABLE_HOSTS,
  preferredHost,
  manifestUrlFor,
  cidFromManifestUrl,
  creativeManifestUrl,
  creativeIsEncoded,
  isBrowserSafe,
  browserAssetUrl,
  gatewaySiblings,
  sameContentScope,
};
