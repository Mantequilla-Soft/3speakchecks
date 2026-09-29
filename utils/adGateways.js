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
 * Gateways that send CORS headers to SOME pages only. ipfs.3speak.tv (not our box)
 * echoes Access-Control-Allow-Origin for exactly these two and nothing else: not www,
 * not preview, not a third-party site, and not `Origin: null`. That is enough to keep
 * ads running on 3speak.tv and the embed when both Bunny zones are down, which
 * happens from time to time (403 "Domain suspended", 2026-09-08 and 2026-09-29).
 *
 * 🚨 `null` is never in any list. A browser sends `Origin: null` after a cross-origin
 * REDIRECT, so a 302 from checker.3speak.tv to one of these hosts fails CORS even for
 * a page listed here. That is why ad segments on such a host are relayed, not
 * redirected (see isRedirectSafe and services/adSegmentRelay.js).
 */
const ORIGIN_CORS_HOSTS = {
  'ipfs.3speak.tv': ['https://3speak.tv', 'https://play.3speak.tv'],
};

/**
 * Gateways seen answering 403 recently. Bunny's suspension page is a 403 for every
 * CID, so one is enough to stop sending first attempts there for a while; a 5xx is
 * NOT, because hotipfs answers 500 for cold content on a perfectly healthy day.
 * In memory, per process: a restart simply retries everything once.
 */
const GATEWAY_DOWN_MS = 5 * 60 * 1000;
const downUntil = new Map();
function markGatewayDown(url) {
  try {
    const host = new URL(url).hostname;
    if (GATEWAY_HOSTS.includes(host)) downUntil.set(host, Date.now() + GATEWAY_DOWN_MS);
  } catch (_) { /* not a url, nothing to mark */ }
}
function isGatewayDown(host) {
  const until = downUntil.get(host);
  if (!until) return false;
  if (until > Date.now()) return true;
  downUntil.delete(host);
  return false;
}
/** Healthy hosts keep their order; hosts marked down go to the back, never away. */
const healthFirst = (hosts) => [
  ...hosts.filter((h) => !isGatewayDown(h)),
  ...hosts.filter((h) => isGatewayDown(h)),
];
const hostOf = (url) => { try { return new URL(url).hostname; } catch (_) { return ''; } };
/** Same list of urls, the ones on a host marked down moved to the back. */
const urlsHealthFirst = (urls) => [
  ...urls.filter((u) => !isGatewayDown(hostOf(u))),
  ...urls.filter((u) => isGatewayDown(hostOf(u))),
];

/**
 * Keep the down-marks honest without waiting for a viewer to hit a dead zone.
 *
 * Every 2 minutes, ask each Bunny zone for a manifest: a 403 marks it down, any other
 * answer (200, 404 for an unpinned CID, even a 5xx for cold content) clears the mark,
 * because only the suspension page is a 403 for everything. So a fresh process knows
 * within seconds, and recovery is picked up within minutes rather than after the
 * 5-minute mark lapses on its own. One tiny request per zone, never on a viewer's path.
 */
const PROBE_EVERY_MS = 2 * 60 * 1000;
const PROBE_CID = process.env.AD_GATEWAY_PROBE_CID || 'QmRTYhAotD5onwzi3HEZD8bptmb7cccUiuaEZhjqJcz1Ra';
let probeTimer = null;
async function probeGateways() {
  await Promise.all(CORS_HOSTS.map(async (host) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    try {
      const r = await fetch(`https://${host}/ipfs/${PROBE_CID}/manifest.m3u8`, { signal: ac.signal });
      if (r.status === 403) downUntil.set(host, Date.now() + GATEWAY_DOWN_MS);
      else downUntil.delete(host);
    } catch (_) {
      // Unreachable is not "suspended"; leave whatever the last real answer said.
    } finally {
      clearTimeout(t);
    }
  }));
}
function startGatewayProbe() {
  if (probeTimer) return;
  probeGateways().catch(() => {});
  probeTimer = setInterval(() => probeGateways().catch(() => {}), PROBE_EVERY_MS);
  probeTimer.unref();
}

/** May a page on `origin` read this host? */
function corsAllows(host, origin) {
  if (CORS_HOSTS.includes(host)) return true;
  const allowed = ORIGIN_CORS_HOSTS[host];
  return !!(allowed && origin && allowed.includes(origin));
}

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
function preferredHost({ browser = false, origin = null } = {}) {
  // `origin` is the page asking, when we know it: a host that only answers some
  // pages is usable for those pages. Hosts seen down go last, not away.
  const usable = healthFirst(COLD_CAPABLE_HOSTS.filter((h) => !browser || corsAllows(h, origin)));
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

/**
 * Can a page on `origin` read this url directly? CORS only, see CORS_HOSTS and
 * ORIGIN_CORS_HOSTS. Without an origin only the hosts that answer everyone count.
 */
const isBrowserSafe = (url, origin = null) => corsAllows(hostOf(url), origin);

/**
 * Can a browser follow a 302 from us to this url? Stricter than isBrowserSafe: after
 * a cross-origin redirect the browser sends `Origin: null`, which only the hosts that
 * answer everyone accept.
 */
const isRedirectSafe = (url) => CORS_HOSTS.includes(hostOf(url));

/**
 * The same object, on a host we would choose ourselves. Non-gateway urls (an
 * advertiser's own image host, images.3speak.tv) are returned untouched.
 */
function browserAssetUrl(url, { origin = null } = {}) {
  try {
    const u = new URL(url);
    if (!GATEWAY_HOSTS.includes(u.hostname)) return url;
    u.hostname = preferredHost({ browser: true, origin });
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
  isRedirectSafe,
  browserAssetUrl,
  gatewaySiblings,
  sameContentScope,
  ORIGIN_CORS_HOSTS,
  markGatewayDown,
  isGatewayDown,
  urlsHealthFirst,
  startGatewayProbe,
};
