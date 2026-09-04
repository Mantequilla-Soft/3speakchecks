/**
 * Server-side ad insertion, and the delivery measurement that comes with it.
 *
 * Mounted at `/m` — NOT under /advertise. Every URL a viewer's browser fetches
 * has to be indistinguishable from ordinary playback, and a path containing
 * "advertise" is the single easiest thing in the world for a filter list to match.
 * Nothing this router serves carries the words ad, vast, or preroll.
 *
 *   POST /m/session            decide + open a session, return a manifest URL
 *   GET  /m/:sid.m3u8          the stitched playlist (master or media)
 *   GET  /m/:sid/:n            the two measured segments (302 → CDN)
 *
 * WHY THIS DEFEATS BLOCKERS: there is no second request to recognise. The spot is
 * already inside the playlist the player asked for, its segments come from the
 * same BunnyCDN host and path shape as the video's own, and `#EXT-X-DISCONTINUITY`
 * is a standard tag hls.js handles natively. What it does NOT defeat is a viewer
 * seeking past the break — deliberately, because disabling the scrubber makes the
 * player feel broken and we would rather charge for what was actually watched.
 *
 * WHY IT IS NOT A VIDEO PROXY: exactly two segments per play come through here,
 * and both are 302s to the CDN. Everything else is absolutised to BunnyCDN so the
 * bytes never transit this box — the same constraint 3speak-gate is built around,
 * and for the same reason: a 1080p viewer is ~3 Mbit/s and this machine averages
 * about 2.4 Mbit/s across every service it runs.
 *
 * MEASUREMENT: an impression is a segment fetch we observed, never a client pixel —
 * a pixel is precisely the thing an adblocker kills. Caveat worth stating: HLS
 * players fetch ahead, so the closing beacon can be requested slightly before it is
 * played. Every server-side ad system has this property; it is a small over-count,
 * not a fabrication, and it is why payout counts completions rather than starts.
 */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getDb } = require('../utils/db');
const { adDecision, isPremiumViewer } = require('../utils/adEligibility');
const {
  AD_CAMPAIGNS_COLLECTION, AD_CREATIVES_COLLECTION, AD_IMPRESSIONS_COLLECTION, ADVERTISERS_COLLECTION,
  AD_SESSION_TTL_MINUTES, AD_FREQUENCY_CAP_MINUTES, AD_BANNER_FREQUENCY_CAP_MINUTES, AD_GATE_ALLOWED_UPLOADERS, ADS_STAGE,
  AD_COOLDOWN_MINUTES, AD_PACING_ENABLED, AD_PACING_MIN_FRACTION, AD_SESSION_RATE_PER_MIN,
  AD_SHORTS_EVERY_N, AD_SHORTS_IGNORE_REPEAT_CAP,
  AD_BANNER_WIDTH_PCT, AD_BANNER_MAX_HEIGHT_PCT, AD_BANNER_MARGIN_PCT,
} = require('../utils/config');
const { STATES, CREATIVE_STATES, servableReason, ensureAdIndexes, slotSecondsFor } = require('../utils/adModel');
const { formatOf } = require('../utils/adFormats');
const { burnSegment } = require('../services/adBurner');

const SESSIONS = process.env.AD_SESSIONS_COLLECTION || 'ad_sessions';
const FETCH_TIMEOUT_MS = parseInt(process.env.AD_FETCH_TIMEOUT_MS, 10) || 6000;
const ID_RE = /^[a-z0-9._-]+$/i;
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * Ad requests per minute from one address.
 *
 * 🚨 The IP is used and DROPPED inside the request — it is a key in a Map that holds
 * a counter and an expiry, never a document, never a log line. That is the same deal
 * watchTracking.js already makes to resolve a country, and it is what lets this exist
 * at all: there is no viewer identity here to store or to leak.
 *
 * Deliberately generous. Offices, schools and mobile carriers put hundreds of real
 * people behind one address, so this is sized to stop a script in a loop, not to
 * ration a household. Anything subtler than a loop is the settlement check's job.
 */
const rateBuckets = new Map();
function overRateLimit(ip) {
  if (!ip || !(AD_SESSION_RATE_PER_MIN > 0)) return false;
  const now = Date.now();
  // Opportunistic prune. The map only ever holds addresses seen in the last minute,
  // so it cannot grow into a memory leak or a de facto visitor log.
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) if (v.resetAt <= now) rateBuckets.delete(k);
  }
  const b = rateBuckets.get(ip);
  if (!b || b.resetAt <= now) {
    rateBuckets.set(ip, { count: 1, resetAt: now + 60000 });
    return false;
  }
  b.count += 1;
  return b.count > AD_SESSION_RATE_PER_MIN;
}

/**
 * A stable, opaque handle for one campaign, so a client can remember "I have already
 * seen this ad" without us handing out database ids it could enumerate.
 *
 * The per-campaign frequency cap has always existed server-side, but it keys on the
 * viewer or on capId — and capId is per PAGE LOAD by design, so for anyone not signed
 * in the cap never survived navigating to the next video, and one advertiser could
 * follow a viewer down a whole session. This closes that, and it stays per AD: a
 * different advertiser is still free to appear immediately.
 */
function adKeyOf(campaignId) {
  return crypto.createHash('sha1').update(String(campaignId)).digest('hex').slice(0, 12);
}

/** Keys a client says it has already been shown. Only ever ADDS to the exclusion set. */
function claimedAdKeys(body) {
  return new Set(
    (Array.isArray(body.recentAdKeys) ? body.recentAdKeys : [])
      .filter((k) => typeof k === 'string' && /^[0-9a-f]{12}$/.test(k))
      .slice(0, 40),
  );
}

/** The caller's address, for rate limiting only. Never stored, never returned. */
function callerIp(req) {
  const xri = req.headers['x-real-ip'];
  if (xri) return String(xri).trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : '';
}

/**
 * Is this viewer still inside the quiet period after their last ad?
 *
 * ⚠️ This is a COMFORT feature, not a fraud control, and it is built accordingly.
 * The existing frequency cap is per CAMPAIGN, so five videos could carry five
 * different advertisers back to back — this is the one that stops that.
 *
 * For a NAMED viewer the answer is ours: their recent sessions are on the server.
 * For an anonymous one there is nothing durable to ask — capId is per page load by
 * design, and a durable anonymous id would be the viewing profile that decision
 * exists to prevent. So the client holds a single expiry timestamp and sends it
 * back. That value cannot identify anybody: it is one number, the same for everyone
 * who saw an ad at the same moment, with no history behind it.
 *
 * A client that lies about it gets MORE ads, not fewer, which is a fraud question
 * and answered by pacing, the rate limiter and the settlement check — not here.
 */
async function inCooldown(db, { viewer, lastAdAt }) {
  if (!(AD_COOLDOWN_MINUTES > 0)) return false;
  const since = Date.now() - AD_COOLDOWN_MINUTES * 60 * 1000;

  const claimed = Number(lastAdAt);
  if (Number.isFinite(claimed) && claimed > since && claimed <= Date.now() + 60000) return true;

  if (!viewer) return false;
  // Authoritative for anyone signed in: a session that actually delivered something.
  const recent = await db.collection(SESSIONS).findOne(
    { viewer, startedAt: { $gte: new Date(since) }, $or: [{ adStartAt: { $ne: null } }, { bannerStartAt: { $ne: null } }] },
    { projection: { _id: 1 } },
  );
  return !!recent;
}

/**
 * Refuse an ad segment that is being pulled faster than its own playlist says it can
 * be watched.
 *
 * A real player asks for segment N roughly N segment-durations into the break; a
 * script asks for all of them at once. Enforcing the difference turns a forged
 * impression from instant into its full wall-clock length, which is the entire
 * economics of botting this. Costs a genuine viewer nothing.
 *
 * The clock starts at the FIRST ad segment this session fetched rather than at
 * session creation: a viewer may sit on a paused player for ten minutes before
 * reaching the break, and dating the budget from the session would hand them the
 * whole break for free.
 */
async function pacingRefusal(db, session, sid, elapsedRequired) {
  if (!AD_PACING_ENABLED) return false;
  const now = Date.now();

  // Start the clock on the FIRST ad segment of this session, whatever its index.
  // (An earlier version only started it when elapsedRequired > 0, so segment 0 —
  // always the first one fetched — never started anything and every later segment
  // looked like the first. The whole check silently passed everything.)
  const startedAt = session.adFirstFetchAt ? new Date(session.adFirstFetchAt).getTime() : null;
  if (!startedAt) {
    await db.collection(SESSIONS).updateOne(
      { sid, adFirstFetchAt: null },
      { $set: { adFirstFetchAt: new Date(now) } },
    ).catch(() => {});
    return false;
  }
  if (!(elapsedRequired > 0)) return false;

  // ⚠️ A FRACTION of the honest time, not the whole of it minus a fixed grace.
  //
  // Segment fetches are not watch time: hls.js reads ahead, so a real player asks
  // for a segment before it plays it, and how far ahead depends on the connection.
  // A fixed grace cannot express that — subtracting 12s from a 10-second banner
  // makes the check unsatisfiable, which is exactly how the first version of this
  // passed a bot pulling all three segments in one round trip.
  //
  // A proportion holds either way: a player buffering even aggressively still takes
  // a real share of the spot's length to walk through its segments, while a script
  // takes none of it. Under-counting a genuine impression costs the advertiser
  // nothing and us a little revenue accuracy, so this errs generous.
  const allowedAt = startedAt + elapsedRequired * AD_PACING_MIN_FRACTION * 1000;
  return now < allowedAt;
}

// Everything under /m goes dark together. A live session must stop serving too —
// sessions outlive the switch by their TTL, and a manifest that keeps splicing after
// the feature is turned off is exactly the surprise this switch exists to prevent.
function servingVisible(req, res, next) {
  if (ADS_STAGE === 'off') return res.status(404).send('Not found');
  return next();
}

let indexed = false;
async function ensureSessionIndexes() {
  if (indexed) return;
  indexed = true;
  try {
    const db = getDb();
    await db.collection(SESSIONS).createIndex({ sid: 1 }, { unique: true });
    await db.collection(SESSIONS).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await db.collection(SESSIONS).createIndex({ viewer: 1, campaignId: 1, startedAt: -1 });
    await db.collection(SESSIONS).createIndex({ capId: 1, startedAt: -1 });   // anonymous cap
    await ensureAdIndexes();
  } catch (err) {
    indexed = false;
    console.error('[ad-serve] index ensure failed:', err && err.message);
  }
}

/**
 * The IPFS gateways that serve the same content and may stand in for each other.
 *
 * 🚨 BunnyCDN 500s on COLD-CACHE content — an object it has not been asked for
 * recently. That is not an error the stitcher can absorb: fetchText throws, the
 * manifest route falls open with a 302 to the un-stitched video, and the playback
 * carries no ad. Worse, it is invisible from the outside — the video plays fine, so
 * nothing looks broken, while the campaign never records an impression and sits at
 * `scheduled` forever. The same cold-cache 500s made a 2,000-row duration backfill
 * look like the whole archive had gone missing (see utils/videoDuration.js).
 *
 * Order is not preference, it is fallback: the player hands us whichever URL it is
 * using, we try that first, and only reach for a sibling gateway if it fails.
 */
const GATEWAY_HOSTS = [
  // The one the PLAYER itself resolves to (play.3speak.tv/hls races gateways and this
  // is what wins), and the only one measured to serve cold content: hotipfs-3speak-1
  // answers 500 for anything not already in its cache and never recovers on retry —
  // 24 of 24 random published videos, four attempts each.
  'ipfs-3speak.b-cdn.net',
  'hotipfs-3speak-1.b-cdn.net',
  'ipfs.3speak.tv',
];

/**
 * Of those, the ones a BROWSER can actually read.
 *
 * 🚨 ipfs.3speak.tv answers 200 with the bytes but sends no `Access-Control-Allow-
 * Origin`, so every segment fetch from a page is blocked at the browser. It is fine
 * for anything server-side (the duration backfill reads it happily — no CORS applies
 * between two servers) and useless in a playlist we hand to hls.js.
 *
 * That distinction cost a whole debugging session: falling back to it made the
 * stitcher succeed — correct playlist, correct splice, correct burn, all verifiable
 * with curl — while the viewer's player was blocked on every ordinary segment,
 * errored, and quietly fell back to the un-stitched source. The video played, so
 * nothing looked broken, and no server log said otherwise. The gateway is not ours
 * to fix (it resolves off-box), so the rule is enforced here instead: never sign a
 * playlist pointing somewhere a browser cannot follow.
 */
const BROWSER_SAFE_HOSTS = ['ipfs-3speak.b-cdn.net', 'hotipfs-3speak-1.b-cdn.net'];
const isBrowserSafe = (url) => {
  try { return BROWSER_SAFE_HOSTS.includes(new URL(url).hostname); } catch (_) { return false; }
};

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

async function fetchOnce(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { redirect: 'follow', signal: ac.signal });
    if (!r.ok) throw new Error(`status ${r.status}`);
    const text = await r.text();
    if (!/#EXTM3U/.test(text)) throw new Error('not a manifest');
    return { url: r.url || url, text };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url) {
  let firstErr = null;
  for (const candidate of [url, ...gatewaySiblings(url)]) {
    try {
      return await fetchOnce(candidate);
    } catch (err) {
      if (!firstErr) firstErr = err;
    }
  }
  throw firstErr || new Error('unreachable');
}

const isMaster = (text) => /#EXT-X-STREAM-INF/i.test(text);

/**
 * Unwrap a gateway-proxy manifest URL to the manifest it actually points at.
 *
 * preview-player hands us `/hls?u=<encoded CDN manifest>` — a proxy that races IPFS
 * gateways and then absolutises every child to whichever one won. That is fine for
 * the player and fatal for us: the master's origin is the proxy, its variants are on
 * the CDN, and the scope check below correctly refuses to follow a manifest that
 * points off its own origin. The result was a 400 on every variant and a silent
 * fallback to the un-stitched video.
 *
 * Unwrapping here rather than asking callers to send the raw URL keeps it working
 * for whatever the player sends, now and later.
 */
function unwrapProxiedManifest(url) {
  try {
    const u = new URL(url);
    const inner = u.searchParams.get('u');
    if (!inner) return url;
    const target = new URL(inner);
    return target.protocol === 'https:' ? target.href : url;
  } catch (_) {
    return url;
  }
}

/**
 * The ad's segment list, already absolutised. Takes the HIGHEST-bandwidth variant
 * on purpose: the spot is a few seconds long, the viewer's player has no chance to
 * adapt within it, and a blurry ad is worth less than the bandwidth it saves.
 */
async function loadAdSegments(adManifestUrl) {
  const master = await fetchText(adManifestUrl);
  let mediaUrl = master.url;
  if (isMaster(master.text)) {
    const lines = master.text.split(/\r?\n/);
    let best = null;
    for (let i = 0; i < lines.length; i += 1) {
      if (!/^#EXT-X-STREAM-INF/i.test(lines[i])) continue;
      const bw = parseInt((lines[i].match(/BANDWIDTH=(\d+)/i) || [])[1], 10) || 0;
      const uri = (lines[i + 1] || '').trim();
      if (uri && !uri.startsWith('#') && (!best || bw > best.bw)) best = { bw, uri };
    }
    if (!best) throw new Error('no variant in creative manifest');
    mediaUrl = new URL(best.uri, master.url).href;
  }

  const media = await fetchText(mediaUrl);
  const out = [];
  const lines = media.text.split(/\r?\n/);
  let pendingExtinf = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^#EXTINF/i.test(line)) { pendingExtinf = line; continue; }
    if (!line || line.startsWith('#')) continue;
    if (!pendingExtinf) continue;
    out.push({ extinf: pendingExtinf, url: new URL(line, media.url).href });
    pendingExtinf = null;
  }
  if (!out.length) throw new Error('creative has no segments');
  return out;
}

/**
 * Splice the spot into a media playlist at `position` seconds.
 *
 * Inserted at a real segment boundary, never mid-segment: HLS cannot express a cut
 * inside a segment, and the two DISCONTINUITY tags are what tell the player the
 * timeline and encoding parameters change across the join.
 *
 * The first and last ad segments are swapped for URLs on this origin, which 302 to
 * the identical CDN object. That is the delivery measurement — two observed fetches
 * rather than a beacon the viewer's blocker would strip.
 *
 * Returns where the break actually landed, which is NOT the booked position: the cut
 * has to fall on a segment boundary, so it lands at the first boundary at or after
 * it. The player needs the real number to map its own timeline back to content time —
 * without that, every second of ad would be recorded as watch time against the video,
 * and the retention data the ad forecast is built from would be poisoned by the ads
 * it sells.
 */
/**
 * @param slot {{ slotPercent?: number, slotPosition?: number }} where the break was
 *   booked. A percentage is resolved against THIS playlist's own total duration,
 *   summed from its EXTINF tags — the manifest in hand is the only trustworthy
 *   statement of how long the video is, and it is the same playlist the break is
 *   about to be cut into. A stored duration can disagree with the media.
 */
function splice(contentText, contentBaseUrl, adSegments, slot, sid, publicBase) {
  const lines = contentText.split(/\r?\n/);
  const abs = (u) => { try { return new URL(u, contentBaseUrl).href; } catch { return u; } };

  const totalSeconds = lines.reduce((sum, l) => {
    const m = l.match(/^#EXTINF:\s*([\d.]+)/i);
    return sum + (m ? parseFloat(m[1]) || 0 : 0);
  }, 0);
  const position = slotSecondsFor(slot, totalSeconds);

  const adBlock = [];
  adBlock.push('#EXT-X-DISCONTINUITY');
  adSegments.forEach((seg, i) => {
    adBlock.push(seg.extinf);
    const first = i === 0;
    const last = i === adSegments.length - 1;
    // Single-segment spots would otherwise only ever report a start.
    adBlock.push(first || last
      ? `${publicBase}/m/${sid}/${first ? 'a' : 'b'}${first && last ? 'b' : ''}`
      : seg.url);
  });
  adBlock.push('#EXT-X-DISCONTINUITY');

  const out = [];
  let elapsed = 0;
  let inserted = false;
  let insertedAt = 0;
  let pendingExtinf = null;

  for (const raw of lines) {
    const line = raw.trim();

    // Pre-roll: before the first segment, after the headers.
    if (!inserted && position <= 0 && /^#EXTINF/i.test(line)) {
      out.push(...adBlock);
      inserted = true;
      insertedAt = 0;
    }
    if (/^#EXTINF/i.test(line)) {
      // A mid-roll lands at the boundary the playhead reaches at `position`.
      if (!inserted && elapsed >= position) {
        out.push(...adBlock);
        inserted = true;
        insertedAt = elapsed;
      }
      pendingExtinf = parseFloat((line.match(/#EXTINF:\s*([\d.]+)/i) || [])[1]) || 0;
      out.push(raw);
      continue;
    }
    if (line && !line.startsWith('#')) {
      out.push(abs(line));                 // segment → absolute CDN URL
      if (pendingExtinf != null) { elapsed += pendingExtinf; pendingExtinf = null; }
      continue;
    }
    if (line.startsWith('#')) {
      out.push(raw.replace(/URI="([^"]+)"/i, (full, u) => (/^https?:\/\//i.test(u) ? full : `URI="${abs(u)}"`)));
      continue;
    }
    out.push(raw);
  }

  // A video shorter than the slot it was booked against: run the spot at the end
  // rather than dropping it silently, so delivery still happens and the advertiser
  // is not quietly short-changed by a catalogue that skews short.
  if (!inserted) { out.push(...adBlock); insertedAt = elapsed; }

  const adDurationSeconds = adSegments.reduce((sum, seg) => {
    const m = seg.extinf.match(/#EXTINF:\s*([\d.]+)/i);
    return sum + (m ? parseFloat(m[1]) : 0);
  }, 0);
  return { text: out.join('\n'), adStartAt: insertedAt, adDurationSeconds };
}

/**
 * Absolutise a media playlist against its own base, without splicing anything.
 *
 * `splice()` already does this on its way past, but a playback that carries only a
 * banner never reaches splice() — and a playlist handed back with relative segment
 * paths would resolve them against THIS origin, which is not where the video is.
 */
function absolutise(text, baseUrl) {
  const abs = (u) => { try { return new URL(u, baseUrl).href; } catch { return u; } };
  return text.split(/\r?\n/).map((raw) => {
    const line = raw.trim();
    if (!line) return raw;
    if (!line.startsWith('#')) return abs(line);
    return raw.replace(/URI="([^"]+)"/i, (full, u) => (/^https?:\/\//i.test(u) ? full : `URI="${abs(u)}"`));
  }).join('\n');
}

/**
 * Point the segments a banner covers at this origin, so burned bytes can be served
 * for them. Nothing else about the playlist changes: same count, same EXTINF, same
 * order — only some URLs differ.
 *
 * 🚨 MUST run BEFORE the roll is spliced in. A banner's position is a percentage of
 * the CONTENT, and once a roll is inserted the playlist's own elapsed time includes
 * ad time — the same banner would then land seconds earlier than it was sold. Doing
 * it first also means splice()'s boundary maths is untouched, because substituting a
 * URL changes no duration.
 *
 * Returns the covered segments' ORIGINAL urls, which is what the burn reads. They are
 * stored on the session rather than encoded into the URL on purpose: a URL that named
 * its own source would let anyone hand this box an arbitrary address to fetch and
 * re-encode, which is a server-side request forgery and a CPU exhaustion in one.
 */
function applyBanner(text, session, sid, publicBase, variantKey) {
  const bookedAt = slotSecondsFor(session.banner, totalOf(text));
  const bookedSeconds = Number(session.banner.seconds) || 0;

  // Which segments the banner is painted onto. Two rules, and both matter:
  //
  //   START on the first boundary AT OR AFTER the booked position, exactly as
  //   splice() places a break. Painting from the boundary BEFORE it would show the
  //   banner earlier than the placement that was sold.
  //
  //   COVER THE FEWEST SEGMENTS that reach the booked length. The old rule covered
  //   every segment the window merely touched, which is fine on a long video with
  //   short segments and awful otherwise: on a 28s video with 8.3s segments, a
  //   3-second banner straddling a boundary took TWO of the four segments — 59% of
  //   the video — where one segment (30%) more than covers the 3 seconds sold.
  //
  // A whole segment is still the floor: the burn cannot paint half of one. So a
  // short banner on a long-segment video always over-delivers somewhat, and the
  // creator's video carries it for that long. That is the cost of being in the
  // picture rather than over it.
  const durations = [];
  text.split(/\r?\n/).forEach((l) => {
    const m = l.match(/^#EXTINF:\s*([\d.]+)/i);
    if (m) durations.push(parseFloat(m[1]) || 0);
  });
  let acc = 0;
  const starts = durations.map((d) => { const s = acc; acc += d; return s; });
  let firstIdx = starts.findIndex((st) => st >= bookedAt - 1e-6);
  // Booked past the last boundary (a late slot on a short video): use the last
  // segment rather than dropping the placement.
  if (firstIdx < 0) firstIdx = Math.max(0, durations.length - 1);
  let lastIdx = firstIdx;
  let span = durations[firstIdx] || 0;
  while (span < bookedSeconds - 1e-6 && lastIdx + 1 < durations.length) {
    lastIdx += 1;
    span += durations[lastIdx];
  }

  const covered = [];
  // Where the banner is ACTUALLY on screen. A burn paints whole segments — there is
  // no way to change half of one — so a 3-second banner inside a 6-second segment is
  // visible for the whole six. The booked figure is what was PAID for; this is what
  // a viewer sees, and it is the one the click target has to follow. Reporting the
  // booked window left the banner visible for seconds after its target had gone,
  // so a viewer clicking the ad in front of them hit plain video.
  let realStart = null;
  let realEnd = null;

  let elapsed = 0;
  let pending = null;
  let segIndex = -1;
  const out = text.split(/\r?\n/).map((raw) => {
    const line = raw.trim();
    const m = line.match(/^#EXTINF:\s*([\d.]+)/i);
    if (m) { pending = parseFloat(m[1]) || 0; return raw; }
    if (!line || line.startsWith('#')) return raw;

    segIndex += 1;
    const segStart = elapsed;
    const segEnd = elapsed + (pending || 0);
    if (pending != null) { elapsed = segEnd; pending = null; }

    // Any segment the banner window touches. A banner is not cut at a boundary the
    // way a break is: it is painted onto whichever frames it overlaps, so a window
    // that clips two segments covers both of them.
    if (segIndex >= firstIdx && segIndex <= lastIdx) {
      const i = covered.length;
      covered.push(line);
      if (realStart === null) realStart = segStart;
      realEnd = segEnd;
      return `${publicBase}/m/${sid}/s/${variantKey}/${i}`;
    }
    return raw;
  }).join('\n');

  return {
    text: out,
    covered,
    // Segment-aligned, exactly as splice() reports where the break really landed
    // rather than where it was booked.
    startAt: realStart === null ? bookedAt : realStart,
    durationSeconds: realStart === null ? 0 : realEnd - realStart,
  };
}

/** Total duration a media playlist declares, summed from its own EXTINF tags. */
function totalOf(text) {
  return text.split(/\r?\n/).reduce((sum, l) => {
    const m = l.match(/^#EXTINF:\s*([\d.]+)/i);
    return sum + (m ? parseFloat(m[1]) || 0 : 0);
  }, 0);
}

/**
 * Where a banner will sit in the frame: the BOX it is fitted into, plus the shape of
 * the creative that goes in it.
 *
 * The fit itself is deliberately NOT done here. `widthPct` is a percentage of the
 * frame's width and `maxHeightPct` of its height, so the box's true aspect depends on
 * the frame's — and the frame's is not known at session time, least of all across
 * variants. The player knows it exactly (videoWidth/videoHeight), so the player fits.
 *
 * That the fit matters at all is because the player puts a click target here: a
 * 1344x240 strip in a 768x108 box lands 604x108, and a target covering the whole box
 * would open an advertiser's site from 82px of frame either side with no ad in it.
 *
 * Must mirror filterGraph() in services/adBurner.js, which does the same fit in
 * pixels against a frame it can measure.
 */
function bannerPlacement(creative) {
  const iw = Number(creative && creative.imageWidth);
  const ih = Number(creative && creative.imageHeight);
  return {
    widthPct: AD_BANNER_WIDTH_PCT,
    maxHeightPct: AD_BANNER_MAX_HEIGHT_PCT,
    bottomPct: AD_BANNER_MARGIN_PCT,
    // The creative's own shape. Null when it was never probed — the player then
    // falls back to the box, which is correct but generous.
    aspect: (iw > 0 && ih > 0) ? Math.round((iw / ih) * 10000) / 10000 : null,
  };
}

function publicBaseOf(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

/* ─── POST /m/session ─────────────────────────────────────────────────── */
router.post('/session', express.json({ limit: '8kb' }), async (req, res) => {
  try {
    if (ADS_STAGE === 'off') return res.status(404).json({ error: 'Not found' });
    // Before any database work: a script in a loop should cost us a Map lookup, not
    // a candidate query. Answers 'no ad' rather than an error — a rate-limited
    // viewer must still get their video.
    if (overRateLimit(callerIp(req))) return res.json({ ad: null, reason: 'rate_limited' });
    await ensureSessionIndexes();

    const b = req.body || {};
    const owner = str(b.owner, 32).toLowerCase();
    const permlink = str(b.permlink, 64);
    const viewer = str(b.viewer, 32).toLowerCase() || null;
    // Frequency capping for viewers we cannot name. The client generates this per
    // PAGE LOAD and holds it in memory only — never localStorage, never a cookie —
    // so it dies with the tab and no cross-visit profile can form. That is the same
    // property preview-player's watch tracking is built around, and it is worth
    // keeping: a durable anonymous id would be a viewing profile in all but name.
    const capId = /^[a-f0-9]{16,64}$/.test(str(b.capId, 64)) ? str(b.capId, 64) : null;
    const country = str(b.country, 2).toUpperCase() || null;
    const contentManifestUrl = str(b.manifestUrl, 2048);
    // Which surface is asking. 'watch' is the default and the only one that stitches;
    // 'shorts' is answered by its own branch below and never reaches the splicer.
    const rawSurface = str(b.surface, 16);
    const surface = rawSurface === 'shorts' ? 'shorts' : (rawSurface === 'upload' ? 'upload' : 'watch');
    /* The pre-upload gate has no video behind it. It runs before anything is posted, so
     * there is no owner and no permlink to validate, and demanding them would reject
     * every honest request from the surface. */
    if (surface !== 'upload' && (!ID_RE.test(owner) || !ID_RE.test(permlink))) {
      return res.status(400).json({ error: 'Invalid owner/permlink' });
    }
    // A shorts spot is its own item in the feed, and the pre-upload gate runs before
    // any video exists at all, so neither has a content manifest to splice into and
    // neither is asked for one.
    if (surface === 'watch' && !/^https:\/\//i.test(contentManifestUrl)) {
      return res.status(400).json({ error: 'manifestUrl must be an https URL' });
    }
    /* ── THE PRE-UPLOAD GATE ───────────────────────────────────────────────────
     *
     * A spot a creator watches before they may post. Like shorts, nothing is stitched:
     * the spot IS the item, so this returns before the splicer.
     *
     * 🚨 IT STANDS BETWEEN SOMEBODY AND THEIR OWN UPLOAD. Every other surface interrupts
     * consumption; this one interrupts work. So it fails OPEN in every direction: no
     * campaign, no creative, an unreadable premium state, a database that will not
     * answer — all of them return `ad: null` and the upload proceeds. The client is
     * built to match: no ad means post immediately.
     *
     * No `owner` is recorded on the impression, and that is deliberate rather than an
     * omission. There is no creator here — nobody's video is carrying this — so there is
     * no creator share to pay, and settlePeriod already skips an ownerless impression
     * while still counting it toward the rate. Crediting the UPLOADER instead would pay
     * people to start uploads they never finish.
     */
    if (surface === 'upload') {
      const uploader = viewer;
      if (!uploader) return res.json({ ad: null, reason: 'no_uploader' });
      if (!AD_GATE_ALLOWED_UPLOADERS.includes(uploader)) {
        return res.json({ ad: null, reason: 'uploader_not_in_trial' });
      }
      // Pro subscribers are never gated. Read through the same helper the watch surface
      // uses so "premium" means one thing across the system, and an unreadable answer
      // withholds the ad rather than risking one in front of a subscriber.
      const premium = await isPremiumViewer(uploader);
      if (premium === null) return res.json({ ad: null, reason: 'unknown_premium_state' });
      if (premium) return res.json({ ad: null, reason: 'premium_viewer', premium: true });

      const dbG = getDb();
      const nowG = new Date();
      const candsG = await dbG.collection(AD_CAMPAIGNS_COLLECTION).find({
        format: 'upload_gate',
        status: { $in: [STATES.SCHEDULED, STATES.RUNNING] },
        startAt: { $lte: nowG },
        endAt: { $gt: nowG },
      }).limit(50).toArray();
      if (!candsG.length) return res.json({ ad: null, reason: 'no_campaign' });

      const crsG = await dbG.collection(AD_CREATIVES_COLLECTION)
        .find({ campaignId: { $in: candsG.map((x) => x._id) }, status: CREATIVE_STATES.READY }).toArray();
      const byCG = new Map(crsG.map((cr) => [String(cr.campaignId), cr]));

      // Same approval gate as everywhere else, and it fails closed for the same reason:
      // anyone can fill in the form and be reviewed afterwards.
      const refsG = [...new Set(candsG.map((x) => x.advertiserRef).filter(Boolean))];
      const okG = new Set((await dbG.collection(ADVERTISERS_COLLECTION)
        .find({ reference: { $in: refsG }, status: 'approved' }, { projection: { reference: 1 } })
        .toArray()).map((a) => a.reference));

      const sinceG = new Date(Date.now() - AD_FREQUENCY_CAP_MINUTES * 60 * 1000);
      const seenG = new Set((await dbG.collection(SESSIONS)
        .find({ viewer: uploader, startedAt: { $gte: sinceG } }, { projection: { campaignId: 1 } })
        .toArray()).map((r) => String(r.campaignId)));

      const fitG = candsG.filter((x) => x.advertiserRef && okG.has(x.advertiserRef)
        && byCG.has(String(x._id)) && !seenG.has(String(x._id)));
      if (!fitG.length) return res.json({ ad: null, reason: 'no_eligible_campaign' });

      // Least-delivered first, the same fair split of scarce inventory as the watch side.
      fitG.sort((a, b2) => (a.deliveredImpressions || 0) - (b2.deliveredImpressions || 0));
      const pickG = fitG[0];
      const pickCrG = byCG.get(String(pickG._id));

      const brandG = await dbG.collection(ADVERTISERS_COLLECTION).findOne({ reference: pickG.advertiserRef });
      const siteG = brandG && /^https?:\/\//i.test(String(brandG.website || '')) ? String(brandG.website) : null;

      const sidG = crypto.randomBytes(16).toString('hex');
      const baseG = publicBaseOf(req);
      await dbG.collection(SESSIONS).insertOne({
        sid: sidG,
        surface: 'upload',
        campaignId: pickG._id,
        creativeId: pickCrG._id,
        adManifestUrl: pickCrG.manifestUrl,
        contentManifestUrl: null,
        adFirstFetchAt: null,
        slotPercent: null,
        slotPosition: null,
        banner: null,
        // No creator behind this surface — see the note above.
        owner: null,
        permlink: null,
        viewer: uploader,
        capId,
        country,
        clickUrl: siteG,
        adDurationSeconds: Number(pickCrG.durationSeconds) || Number(pickG.spotSeconds) || null,
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + AD_SESSION_TTL_MINUTES * 60 * 1000),
      });

      return res.json({
        ad: null,
        uploadAd: {
          manifestUrl: `${baseG}/m/${sidG}/short.m3u8`,
          durationSeconds: Number(pickCrG.durationSeconds) || Number(pickG.spotSeconds) || null,
          label: 'Sponsored',
          adKey: adKeyOf(pickG._id),
          advertiser: brandG ? brandG.projectName : null,
          brand: brandG ? {
            account: brandG.hiveAccount || null,
            productName: brandG.projectName || null,
            logoUrl: brandG.logoUrl || null,
            slogan: brandG.slogan || null,
            clickUrl: siteG ? `${baseG}/m/${sidG}/c` : null,
          } : null,
        },
        reason: null,
      });
    }


    // Premium viewers and opted-out creators, decided in one place.
    const decision = await adDecision({ viewer, owner });
    if (!decision.ads) {
      // `premium` is echoed so the player can flag the watch session accordingly.
      // The inventory forecast excludes premium sessions, and it can only do that
      // if something marks them — this is the cheapest place to learn it, since the
      // answer has just been computed anyway.
      return res.json({ ad: null, reason: decision.reason, premium: decision.reason === 'premium_viewer' });
    }

    // The quiet period after this viewer's last ad, whichever advertiser it was for.
    if (await inCooldown(getDb(), { viewer, lastAdAt: b.lastAdAt })) {
      return res.json({ ad: null, reason: 'cooldown', cooldownMinutes: AD_COOLDOWN_MINUTES });
    }

    // ── THE SHORTS SURFACE ────────────────────────────────────────────────────
    // A full-screen vertical spot BETWEEN shorts, not inside one. Nothing is
    // stitched, nothing is burned: the ad is its own item in the feed and simply
    // plays, which is why this returns before any of the splicing below.
    //
    // ⚠️ Its pacing is counted in SHORTS WATCHED, not minutes, and it deliberately
    // does NOT consult the time-based cooldown. Someone swiping the feed clears ten
    // shorts well inside ten minutes, so a minutes rule would either silence the
    // surface entirely or fire constantly depending on how fast they swipe. The two
    // surfaces keep their own cadence and do not block each other.
    if (surface === 'shorts') {
      const watched = Math.max(0, parseInt(b.shortsWatched, 10) || 0);
      if (watched < AD_SHORTS_EVERY_N) {
        return res.json({ ad: null, reason: 'shorts_cadence', everyN: AD_SHORTS_EVERY_N, shortsWatched: watched });
      }

      const db2 = getDb();
      const now2 = new Date();
      const cands = await db2.collection(AD_CAMPAIGNS_COLLECTION).find({
        format: 'shorts_roll',
        status: { $in: [STATES.SCHEDULED, STATES.RUNNING] },
        startAt: { $lte: now2 },
        endAt: { $gt: now2 },
      }).limit(50).toArray();
      if (!cands.length) return res.json({ ad: null, reason: 'no_campaign', everyN: AD_SHORTS_EVERY_N });

      const crs = await db2.collection(AD_CREATIVES_COLLECTION)
        .find({ campaignId: { $in: cands.map((c) => c._id) }, status: CREATIVE_STATES.READY }).toArray();
      const byC = new Map(crs.map((cr) => [String(cr.campaignId), cr]));

      // Same approval gate as the watch surface, and it fails closed for the same
      // reason: anyone can fill in the whole form now and be reviewed afterwards.
      const refs2 = [...new Set(cands.map((c) => c.advertiserRef).filter(Boolean))];
      const ok2 = new Set((await db2.collection(ADVERTISERS_COLLECTION)
        .find({ reference: { $in: refs2 }, status: 'approved' }, { projection: { reference: 1 } })
        .toArray()).map((a) => a.reference));

      // AD_SHORTS_IGNORE_REPEAT_CAP drops both exclusions together, on purpose: they
      // are two halves of one rule (the server's record for a named viewer, the
      // client's report for everyone else), and honouring one while ignoring the
      // other would cap signed-in viewers only — which is the confusing half-state
      // rather than the switch anybody wanted.
      let recent2 = new Set();
      const capKey2 = viewer ? { viewer } : (capId ? { capId } : null);
      if (capKey2 && !AD_SHORTS_IGNORE_REPEAT_CAP) {
        const since2 = new Date(Date.now() - AD_FREQUENCY_CAP_MINUTES * 60 * 1000);
        const rows2 = await db2.collection(SESSIONS)
          .find({ ...capKey2, startedAt: { $gte: since2 } }, { projection: { campaignId: 1 } }).toArray();
        recent2 = new Set(rows2.map((r) => String(r.campaignId)));
      }
      const claimedKeys2 = AD_SHORTS_IGNORE_REPEAT_CAP ? new Set() : claimedAdKeys(b);

      const fit = cands.filter((c) => {
        if (!c.advertiserRef || !ok2.has(c.advertiserRef)) return false;
        const cr = byC.get(String(c._id));
        if (servableReason(c, cr)) return false;
        if (recent2.has(String(c._id)) || claimedKeys2.has(adKeyOf(c._id))) return false;
        if (c.markets && c.markets.length && country && !c.markets.includes(country)) return false;
        return true;
      }).sort((x, y) => (x.deliveredImpressions || 0) - (y.deliveredImpressions || 0));
      if (!fit.length) return res.json({ ad: null, reason: 'no_eligible_campaign', everyN: AD_SHORTS_EVERY_N });

      const pickC = fit[0];
      const pickCr = byC.get(String(pickC._id));
      const brandDoc2 = await db2.collection(ADVERTISERS_COLLECTION).findOne(
        { reference: pickC.advertiserRef },
        { projection: { hiveAccount: 1, projectName: 1, logoUrl: 1, slogan: 1, website: 1 } },
      );
      const site2 = brandDoc2 && /^https?:\/\//i.test(String(brandDoc2.website || '')) ? String(brandDoc2.website) : null;

      const sid2 = crypto.randomBytes(16).toString('hex');
      const base2 = publicBaseOf(req);
      await db2.collection(SESSIONS).insertOne({
        sid: sid2,
        surface: 'shorts',
        campaignId: pickC._id,
        creativeId: pickCr._id,
        adManifestUrl: pickCr.manifestUrl,
        // No content to stitch into — the spot IS the item. Kept null rather than
        // omitted so every reader downstream sees the shape it already handles.
        contentManifestUrl: null,
        adFirstFetchAt: null,
        slotPercent: null,
        slotPosition: null,
        banner: null,
        // WHOSE short the viewer just finished. They are the reason the viewer was
        // there for the slot, so they are who the creator half is owed to.
        owner,
        permlink,
        viewer,
        capId,
        country,
        clickUrl: site2,
        adDurationSeconds: Number(pickCr.durationSeconds) || Number(pickC.spotSeconds) || null,
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + AD_SESSION_TTL_MINUTES * 60 * 1000),
      });

      return res.json({
        ad: null,
        shortsAd: {
          manifestUrl: `${base2}/m/${sid2}/short.m3u8`,
          durationSeconds: Number(pickCr.durationSeconds) || Number(pickC.spotSeconds) || null,
          label: 'Sponsored',
          adKey: adKeyOf(pickC._id),
          advertiser: brandDoc2 ? brandDoc2.projectName : null,
          brand: brandDoc2 ? {
            account: brandDoc2.hiveAccount || null,
            productName: brandDoc2.projectName || null,
            logoUrl: brandDoc2.logoUrl || null,
            slogan: brandDoc2.slogan || null,
            clickUrl: site2 ? `${base2}/m/${sid2}/c` : null,
          } : null,
        },
        everyN: AD_SHORTS_EVERY_N,
        reason: null,
      });
    }

    const db = getDb();
    const now = new Date();

    // How long THIS video is, for campaigns that target video length. Looked up
    // rather than taken from the request: the client could otherwise claim any
    // duration and place itself inside a window the advertiser paid to exclude.
    // `{ permlink, owner }` is a unique index, so this is a point read.
    const video = await db.collection('embed-video')
      .findOne({ permlink, owner }, { projection: { duration: 1, short: 1 } });
    const videoSeconds = Number(video && video.duration) || null;

    // 🚨 NO WATCH-SURFACE ADS ON A SHORT, whatever its length.
    //
    // Short.jsx has said so since ads existed: the only slot that fits inside a short
    // is a pre-roll, and putting a 15-second spot in front of a 12-second short
    // delivers an impression to someone who never wanted the content. That is the
    // whole reason `shorts_roll` exists as its own format, played BETWEEN shorts.
    //
    // The shorts FEED honoured it by simply never asking. But a short opened through
    // the embed player or a watch page asks like anything else, and nothing here
    // checked — so a roll spliced straight into it. Length is not the test and never
    // was: these are 61-68s shorts, comfortably past any duration threshold, and one
    // row in the wild is flagged short at seven hours. The FLAG is the answer.
    if (video && video.short === true) {
      return res.json({ ad: null, reason: 'short_video' });
    }

    const candidates = await db.collection(AD_CAMPAIGNS_COLLECTION).find({
      status: { $in: [STATES.SCHEDULED, STATES.RUNNING] },
      startAt: { $lte: now },
      endAt: { $gt: now },
    }).limit(50).toArray();
    if (!candidates.length) return res.json({ ad: null, reason: 'no_campaign' });

    const creatives = await db.collection(AD_CREATIVES_COLLECTION)
      .find({ campaignId: { $in: candidates.map((c) => c._id) }, status: CREATIVE_STATES.READY }).toArray();
    const byCampaign = new Map(creatives.map((cr) => [String(cr.campaignId), cr]));

    // Frequency cap: the same viewer must not be shown the same spot again inside
    // the window. Without it a binge session carries one advertiser a dozen times
    // and burns the audience they paid for.
    // Two windows, one query. A banner is cheaper to sit through than a roll — it
    // shares the picture for a few seconds and never takes the viewer's time — so the
    // window that stops a roll burning an audience is longer than a banner needs.
    let recent = new Set();
    let recentBanner = new Set();
    const capKey = viewer ? { viewer } : (capId ? { capId } : null);
    if (capKey) {
      const since = new Date(Date.now() - AD_FREQUENCY_CAP_MINUTES * 60 * 1000);
      const bannerSince = Date.now() - AD_BANNER_FREQUENCY_CAP_MINUTES * 60 * 1000;
      const rows = await db.collection(SESSIONS)
        .find({ ...capKey, startedAt: { $gte: since } }, { projection: { campaignId: 1, startedAt: 1 } }).toArray();
      for (const r of rows) {
        const id = String(r.campaignId);
        recent.add(id);
        // The banner window is the SHORTER of the two, so its set is a subset of the
        // rows already fetched. Reading it back out of them costs nothing.
        if (new Date(r.startedAt).getTime() >= bannerSince) recentBanner.add(id);
      }
    }

    // A forged list can only cost a client ads, never earn it any, so it is trusted
    // exactly as far as it can do harm — which is not at all.
    const claimedKeys = claimedAdKeys(b);

    // 🚨 THE APPROVAL GATE. It used to sit at booking time — a campaign could only be
    // created by an already-approved advertiser, so serving never had to ask. Now that
    // anyone can fill the whole form in one go and be reviewed afterwards, the gate has
    // to be HERE instead: an unapproved advertiser who booked and paid would otherwise
    // start serving the moment their payment cleared, with no human having looked at
    // them. One batched lookup over the candidates, before anything is chosen.
    const candidateRefs = [...new Set(candidates.map((c) => c.advertiserRef).filter(Boolean))];
    const approvedRefs = new Set(
      (await db.collection(ADVERTISERS_COLLECTION)
        .find({ reference: { $in: candidateRefs }, status: 'approved' }, { projection: { reference: 1 } })
        .toArray()).map((a) => a.reference),
    );

    const eligible = candidates.filter((c) => {
      // Fail CLOSED: a campaign whose advertiser we cannot confirm as approved does
      // not serve. Missing advertiserRef included — there is no such thing as an
      // ownerless booking that is safe to run.
      if (!c.advertiserRef || !approvedRefs.has(c.advertiserRef)) return false;
      const creative = byCampaign.get(String(c._id));
      if (servableReason(c, creative)) return false;
      // Each format against its own window.
      const cap = formatOf(c).key === 'video_banner' ? recentBanner : recent;
      if (cap.has(String(c._id)) || claimedKeys.has(adKeyOf(c._id))) return false;
      if (c.markets && c.markets.length && country && !c.markets.includes(country)) return false;

      // Video-length targeting. A campaign that asked for a window does NOT serve
      // on a video whose length we could not establish: paying for a placement you
      // explicitly excluded is worse than missing an impression, and an unknown
      // duration is not evidence of a match. Campaigns with no window are
      // unaffected either way.
      if (c.minVideoSeconds || c.maxVideoSeconds) {
        if (!videoSeconds) return false;
        if (c.minVideoSeconds && videoSeconds < c.minVideoSeconds) return false;
        if (c.maxVideoSeconds && videoSeconds > c.maxVideoSeconds) return false;
      }
      return true;
    });
    if (!eligible.length) return res.json({ ad: null, reason: 'no_eligible_campaign' });

    // Least-delivered first. With flat tenancy every booked campaign is owed the
    // same run, so evening out delivery is the fair split of scarce inventory —
    // an auction would be the wrong instinct here, there is nothing to bid on.
    eligible.sort((a, b2) => (a.deliveredImpressions || 0) - (b2.deliveredImpressions || 0));

    // One placement per FORMAT, not one per playback. A roll and a banner are
    // different surfaces that do not compete for the same moment, so a playback can
    // carry both — from different advertisers — without the viewer ever seeing two
    // ads at once. They are picked independently so a banner is never displaced by a
    // roll that happened to sort first.
    const pickFor = (key) => eligible.find((c) => formatOf(c).key === key) || null;
    const campaign = pickFor('video_roll');
    const bannerCampaign = pickFor('video_banner');
    if (!campaign && !bannerCampaign) return res.json({ ad: null, reason: 'no_eligible_campaign' });

    const creative = campaign ? byCampaign.get(String(campaign._id)) : null;
    const bannerCreative = bannerCampaign ? byCampaign.get(String(bannerCampaign._id)) : null;

    // Who each ad is from, for the disclosure. Read from the product rather than
    // copied onto the campaign at booking, so updating a logo fixes every booking at
    // once. `reference` is a unique index, so these are point reads, and only for
    // placements that were actually chosen.
    const refs = [campaign?.advertiserRef, bannerCampaign?.advertiserRef].filter(Boolean);
    const brands = new Map(
      (await db.collection(ADVERTISERS_COLLECTION).find(
        { reference: { $in: refs } },
        { projection: { reference: 1, hiveAccount: 1, projectName: 1, logoUrl: 1, slogan: 1, website: 1 } },
      ).toArray()).map((d) => [d.reference, d]),
    );
    const brandDoc = campaign ? brands.get(campaign.advertiserRef) : null;
    const bannerBrand = bannerCampaign ? brands.get(bannerCampaign.advertiserRef) : null;
    const websiteOf = (d) => (d && /^https?:\/\//i.test(String(d.website || '')) ? String(d.website) : null);

    const publicBase = publicBaseOf(req);
    const sid = crypto.randomBytes(16).toString('hex');
    await db.collection(SESSIONS).insertOne({
      sid,
      // When this session first pulled an ad segment. Starts the pacing budget; see
      // pacingRefusal(). Null until the viewer actually reaches the break.
      adFirstFetchAt: null,
      // The ROLL placement. Null when this playback carries only a banner — every
      // reader downstream already has to cope with a session whose splice produced
      // nothing, so an absent roll is not a new shape.
      campaignId: campaign ? campaign._id : null,
      creativeId: creative ? creative._id : null,
      adManifestUrl: creative ? creative.manifestUrl : null,
      // Stored unwrapped: the scope check on nested playlists is only meaningful
      // against the manifest's real origin.
      contentManifestUrl: unwrapProxiedManifest(contentManifestUrl),
      // Both carried verbatim: percent for anything booked since slots became
      // relative, seconds for older flights. slotSecondsFor() picks.
      slotPercent: campaign ? (campaign.slotPercent ?? null) : null,
      slotPosition: campaign ? (campaign.slotPosition ?? null) : null,

      // The BANNER placement. Everything the burn and its measurement need, resolved
      // now: the creative can be edited or a campaign paused mid-playback, and a
      // session that changed shape underneath a playing manifest would produce a
      // different picture for the same seek.
      banner: bannerCampaign && bannerCreative ? {
        campaignId: bannerCampaign._id,
        creativeId: bannerCreative._id,
        imageUrl: bannerCreative.imageUrl,
        slotPercent: bannerCampaign.slotPercent ?? null,
        slotPosition: bannerCampaign.slotPosition ?? null,
        seconds: Number(bannerCampaign.spotSeconds) || 0,
        clickUrl: websiteOf(bannerBrand),
      } : null,

      owner,
      permlink,
      viewer,
      capId,
      country,
      // Where a click goes. Kept server-side rather than handed to the page: it
      // makes the click countable, and it means the destination is decided by the
      // approved advertiser record rather than by whatever the client was told.
      clickUrl: websiteOf(brandDoc),
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + AD_SESSION_TTL_MINUTES * 60 * 1000),
    });

    const brandOf = (doc, camp, path) => ({
      account: (doc && doc.hiveAccount) || null,
      productName: (doc && doc.projectName) || (camp && camp.projectName) || null,
      logoUrl: (doc && doc.logoUrl) || null,
      slogan: (doc && doc.slogan) || null,
      // An opaque URL on our own origin, not the advertiser's. The real destination
      // lives on the session; this is what makes the click countable, and it keeps
      // the pattern consistent with every other URL here — nothing a filter list
      // can match.
      clickUrl: websiteOf(doc) ? `${publicBase}/m/${sid}/${path}` : null,
    });

    res.set('Cache-Control', 'no-store');
    res.json({
      // The manifest is returned whenever ANY placement was made, because a banner
      // lives inside the playlist exactly as a roll does — the player loads one
      // source either way and never learns which placements it carries.
      ad: campaign ? {
        manifestUrl: `${publicBase}/m/${sid}.m3u8`,
        // Informational only — the player takes the real cut point from /m/:sid/i
        // once the splice has happened, because that is the number the manifest
        // actually landed on.
        positionPercent: campaign.slotPercent ?? null,
        position: campaign.slotPosition ?? null,
        durationSeconds: creative.durationSeconds,
        // The player shows a Sponsored label over this range. Disclosure is
        // required by EU and US advertising rules, and a label in the player
        // chrome is not something a filter list removes without breaking playback.
        label: 'Sponsored',
        // Opaque, stable per campaign. The client remembers it so the per-AD cap
        // survives navigating to the next video, which capId cannot do.
        adKey: adKeyOf(campaign._id),
        advertiser: campaign.projectName || null,
        // Everything the overlay draws. Sent as one object so the player renders
        // whatever is present and simply leaves out what is not: a product with no
        // logo or slogan still gets a correct, complete disclosure.
        brand: brandOf(brandDoc, campaign, 'c'),
      } : null,

      // A banner needs no overlay and no label from the player: both are already in
      // the picture. What the player gets is the manifest to load (when there is no
      // roll to carry it), where the banner runs so a click target can sit over it,
      // and where a click goes.
      banner: bannerCampaign && bannerCreative ? {
        manifestUrl: `${publicBase}/m/${sid}.m3u8`,
        adKey: adKeyOf(bannerCampaign._id),
        positionPercent: bannerCampaign.slotPercent ?? null,
        durationSeconds: Number(bannerCampaign.spotSeconds) || 0,
        advertiser: bannerCampaign.projectName || null,
        brand: brandOf(bannerBrand, bannerCampaign, 'bc'),
        // WHERE IT WAS BURNED, as percentages of the video frame.
        //
        // Sent rather than left for the player to know, because the player cannot
        // know: the banner is in the pixels, and the only thing that can say where
        // it put them is the thing that put them there. A client-side copy of these
        // numbers would drift from services/adBurner.js the first time either
        // changed, and the click target would quietly stop covering the ad.
        //
        // A box, not a point: the creative is FITTED inside it, so a wide strip
        // fills it and a square lands smaller and centred. The player's target
        // covers the box, which is never larger than the banner's own footprint
        // plus a little dead space either side of a narrow creative.
        placement: bannerPlacement(bannerCreative),
      } : null,

      reason: null,
      // What the client should hold on to so the next video knows to stay quiet. A
      // bare expiry — no id, nothing to correlate, nothing that outlives itself.
      cooldownMinutes: AD_COOLDOWN_MINUTES,
      cooldownUntil: AD_COOLDOWN_MINUTES > 0 ? Date.now() + AD_COOLDOWN_MINUTES * 60 * 1000 : null,
    });
  } catch (err) {
    console.error('[ad-serve] session failed:', err && err.message);
    res.status(500).json({ error: 'Could not open a session' });
  }
});

/* ─── GET /m/:sid.m3u8 ────────────────────────────────────────────────── */
router.get('/:sid.m3u8', servingVisible, async (req, res) => {
  try {
    const sid = str(req.params.sid, 64);
    if (!/^[0-9a-f]{32}$/.test(sid)) return res.status(400).send('bad session');

    const session = await getDb().collection(SESSIONS).findOne({ sid });
    if (!session) return res.status(404).send('session expired');

    // `p` carries the nested playlist we are currently rendering. It must stay
    // inside the content's own origin — a manifest that points elsewhere is either
    // misencoded or hostile, and either way we will not sign it.
    const requested = str(req.query.p, 2048);
    let target = session.contentManifestUrl;
    if (requested) {
      const base = new URL(session.contentManifestUrl);
      const abs = new URL(requested, base);
      // Same origin, or a sibling gateway we fell back to when the player's own
      // gateway 500'd. Anything else is a manifest pointing off its own content and
      // we will not sign it.
      if (!sameContentScope(abs.href, base.href)) return res.status(400).send('out of scope');
      target = abs.href;
    }

    const content = await fetchText(target);
    // We may have read this through a fallback gateway. That is fine for reading and
    // fatal for serving: every URL below is absolutised against content.url and handed
    // to a browser, so if the gateway that answered will not send CORS headers there is
    // no playlist we can build that the viewer can play. Bail to the fail-open path
    // rather than emit one that is guaranteed to error.
    if (!isBrowserSafe(content.url)) {
      throw new Error(`gateway ${new URL(content.url).hostname} sends no CORS headers`);
    }
    const publicBase = publicBaseOf(req);
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Cache-Control', 'no-store');   // per-session; never shared or edge-cached

    if (isMaster(content.text)) {
      // Variants come back through here, because each one needs its own splice.
      const rewritten = content.text.split(/\r?\n/).map((raw) => {
        const line = raw.trim();
        if (!line || line.startsWith('#')) {
          return raw.replace(/URI="([^"]+)"/i, (full, u) => {
            const abs = new URL(u, content.url).href;
            return `URI="${publicBase}/m/${sid}.m3u8?p=${encodeURIComponent(abs)}"`;
          });
        }
        const abs = new URL(line, content.url).href;
        return `${publicBase}/m/${sid}.m3u8?p=${encodeURIComponent(abs)}`;
      }).join('\n');
      return res.send(rewritten);
    }

    let text = absolutise(content.text, content.url);
    const mark = {};

    // BANNER FIRST — see applyBanner. Its window is content-relative, and splicing a
    // roll in ahead of it would move it.
    if (session.banner && session.banner.imageUrl) {
      const variantKey = crypto.createHash('sha1').update(content.url).digest('hex').slice(0, 12);
      const b = applyBanner(text, session, sid, publicBase, variantKey);
      if (b.covered.length) {
        text = b.text;
        // The originals this variant's burns read from. Keyed by variant so a player
        // switching resolution mid-playback gets the right source for each.
        mark[`bannerSegs.${variantKey}`] = b.covered;
        mark.bannerStartAt = b.startAt;
        mark.bannerDurationSeconds = b.durationSeconds;
      }
    }

    // A banner-only playback has no roll to splice: the playlist is already correct.
    if (session.adManifestUrl) {
      const adSegments = await loadAdSegments(session.adManifestUrl);
      const spliced = splice(text, content.url, adSegments, session, sid, publicBase);
      text = spliced.text;
      // Record where the cut actually fell so the player can ask for it. Written on
      // every variant fetch, which is harmless — they all splice at the same boundary.
      mark.adStartAt = spliced.adStartAt;
      mark.adDurationSeconds = spliced.adDurationSeconds;
    }

    if (Object.keys(mark).length) {
      await getDb().collection(SESSIONS).updateOne({ sid }, { $set: mark })
        .catch(() => { /* the manifest still serves without it */ });
    }
    return res.send(text);
  } catch (err) {
    console.error('[ad-serve] manifest failed:', err && err.message);
    // FAIL OPEN, always. A broken splice must never cost the viewer their video —
    // losing one impression is nothing next to a black player.
    try {
      const sid = str(req.params.sid, 64);
      const session = await getDb().collection(SESSIONS).findOne({ sid });
      if (session) return res.redirect(302, session.contentManifestUrl);
    } catch (_) { /* fall through */ }
    return res.status(502).send('manifest unavailable');
  }
});

/* ─── GET /m/:sid/i — where the break landed ──────────────────────────── */
// Answers the one question the player cannot work out for itself: the cut falls on
// a segment boundary, not on the booked second, so only the stitcher knows the real
// offset. The player needs it to subtract ad time from the watch position — and to
// know when to show the Sponsored label.
router.get('/:sid/i', servingVisible, async (req, res) => {
  try {
    const sid = str(req.params.sid, 64);
    if (!/^[0-9a-f]{32}$/.test(sid)) return res.status(400).json({ error: 'bad session' });
    const session = await getDb().collection(SESSIONS).findOne({ sid });
    if (!session) return res.status(404).json({ error: 'expired' });
    res.set('Cache-Control', 'no-store');
    res.json({
      // null until a variant has been fetched — the player retries rather than
      // guessing, because a wrong offset silently corrupts watch data.
      adStartAt: typeof session.adStartAt === 'number' ? session.adStartAt : null,
      adDurationSeconds: session.adDurationSeconds || null,
      // Where the banner runs, so a click target can be positioned over it. Same
      // contract as the break: null until a variant has been rendered, because only
      // the stitcher knows which segments it actually landed on.
      bannerStartAt: typeof session.bannerStartAt === 'number' ? session.bannerStartAt : null,
      // The BURNED span, not the booked one — see applyBanner. Null until a variant
      // has been rendered, because only the stitcher knows which segments it landed
      // on, and a target placed on the booked window disappears while the banner is
      // still on screen.
      bannerDurationSeconds: typeof session.bannerDurationSeconds === 'number'
        ? session.bannerDurationSeconds
        : null,
    });
  } catch (err) {
    res.status(500).json({ error: 'unavailable' });
  }
});

/* ─── GET /m/:sid/c — the click-through ───────────────────────────────── */
// Counts the click, then sends the viewer on. Done as a redirect rather than a bare
// link so a click is measurable at all — an advertiser paying for a spot will ask how
// many people followed it, and "we don't know" is not an answer. The destination
// comes from the approved advertiser record, never from the request.
router.get('/:sid/c', servingVisible, async (req, res) => {
  try {
    const sid = str(req.params.sid, 64);
    if (!/^[0-9a-f]{32}$/.test(sid)) return res.status(400).send('bad session');
    const db = getDb();
    const session = await db.collection(SESSIONS).findOne({ sid });
    if (!session || !session.clickUrl) return res.status(404).send('not found');

    // Counted once per session, same transition guard the completion uses: a viewer
    // who clicks, comes back and clicks again is one interested person, not two.
    try {
      // 🚨 Scoped by campaignId, not by sid alone. A playback can now carry a roll
      // AND a banner, so `{ sid, clicked: { $ne: true } }` could match the BANNER's
      // impression and attribute this click to the wrong advertiser.
      const r = await db.collection(AD_IMPRESSIONS_COLLECTION).updateOne(
        { sid, campaignId: session.campaignId, clicked: { $ne: true } },
        {
          $set: {
            campaignId: session.campaignId,
            owner: session.owner,
            permlink: session.permlink,
            clicked: true,
            clickedAt: new Date(),
          },
          $setOnInsert: { at: new Date(), started: true, payoutId: null },
        },
        { upsert: true },
      );
      if (r.upsertedCount === 1 || r.modifiedCount === 1) {
        await db.collection(AD_CAMPAIGNS_COLLECTION).updateOne(
          { _id: session.campaignId }, { $inc: { clicks: 1 } },
        );
      }
    } catch (e) {
      if (e?.code !== 11000) console.error('[ad-serve] click write failed:', e && e.message);
    }

    res.set('Cache-Control', 'no-store');
    return res.redirect(302, session.clickUrl);
  } catch (err) {
    console.error('[ad-serve] click failed:', err && err.message);
    return res.status(502).send('unavailable');
  }
});

/**
 * Record a delivery. Extracted because a roll and a banner measure identically and
 * must keep doing so — the counter behind billing, delivery reporting and payout
 * cannot mean two different things depending on which surface produced it.
 *
 * Keyed on (sid, campaignId), not sid: one playback can now carry two campaigns.
 */
async function recordDelivery({ db, sid, campaignId, facts, completed }) {
  if (!campaignId) return;
  const impressions = db.collection(AD_IMPRESSIONS_COLLECTION);
  const key = { sid, campaignId };
  try {
    if (!completed) {
      await impressions.updateOne(
        key,
        { $set: facts, $setOnInsert: { at: new Date(), started: true, payoutId: null } },
        { upsert: true },
      );
      return;
    }
    // Count the completion ONCE. Players re-request segments (a seek back into the
    // break, a retry after a network blip), and the campaign counter is what
    // delivery reporting and payout are computed from — an increment per fetch would
    // bill an advertiser for one play several times over.
    //
    // The `completed: { $ne: true }` filter is the transition guard: it matches only
    // an impression that has not already been closed. On a replay it matches nothing
    // and the upsert attempts an insert, which the unique index rejects — that
    // duplicate-key error IS the "already counted" signal, so it is caught rather
    // than logged as a failure.
    let first = false;
    try {
      const r = await impressions.updateOne(
        { ...key, completed: { $ne: true } },
        {
          $set: { ...facts, completed: true, completedAt: new Date() },
          $setOnInsert: { at: new Date(), started: true, payoutId: null },
        },
        { upsert: true },
      );
      first = r.upsertedCount === 1 || r.modifiedCount === 1;
    } catch (e) {
      if (e?.code !== 11000) throw e;   // already completed → not a failure
    }
    if (first) {
      await db.collection(AD_CAMPAIGNS_COLLECTION).updateOne(
        { _id: campaignId },
        { $inc: { deliveredImpressions: 1 }, $set: { status: STATES.RUNNING, updatedAt: new Date() } },
      );
    }
  } catch (e) {
    console.error('[ad-serve] impression write failed:', e && e.message);
  }
}

/* ─── GET /m/:sid/s/:vk/:i — a segment with the banner burned into it ──── */
/**
 * The banner's delivery path. These are the ONLY bytes under /m that do not 302 to
 * the CDN, because a burned segment exists nowhere else — see services/adBurner.js
 * for why that is affordable and when it stops being.
 *
 * Measured like a roll: the first covered segment starts the impression, the last
 * completes it. A viewer who never reaches the banner never fetches these, so an
 * unwatched banner is correctly never counted.
 *
 * FAILS OPEN. If the burn fails for any reason the ORIGINAL segment is served
 * instead — the viewer keeps their video and we lose an impression, which is the
 * right way round.
 */
router.get('/:sid/s/:vk/:i', servingVisible, async (req, res) => {
  let original = null;
  try {
    const sid = str(req.params.sid, 64);
    const vk = str(req.params.vk, 16);
    const i = parseInt(req.params.i, 10);
    if (!/^[0-9a-f]{32}$/.test(sid) || !/^[0-9a-f]{6,16}$/.test(vk) || !Number.isInteger(i) || i < 0) {
      return res.status(400).send('bad request');
    }

    const db = getDb();
    const session = await db.collection(SESSIONS).findOne({ sid });
    if (!session || !session.banner) return res.status(404).send('expired');

    const list = (session.bannerSegs || {})[vk];
    if (!Array.isArray(list) || i >= list.length) return res.status(404).send('not found');
    original = list[i];

    /* Pacing decides whether this COUNTS. It must never decide whether the banner
     * appears.
     *
     * 🚨 `original` here is the plain CONTENT segment, not an ad segment. On the roll
     * path redirecting to it on a refusal does what the rule says — the bytes go out,
     * they just are not counted — because there the bytes ARE the ad. Here they are the
     * viewer's video with no banner on it, so refusing removed the advertiser's banner
     * from the picture entirely.
     *
     * And an HLS player refuses almost every one of them: the segments are fetched by
     * the buffer, not by playback, so a player reading four of them inside two seconds
     * fails the 3s, 6s and 9s marks and keeps only segment 0. A 20-second banner was
     * showing for one segment, about six seconds, while the click target sat over the
     * full 24 it was told about.
     *
     * So: burn and serve regardless, and let pacing gate the impression alone. An
     * advertiser under-charged for a banner somebody genuinely saw is a far better
     * failure than one who paid for twenty seconds and got six. */
    const perSeg = (Number(session.bannerDurationSeconds) || 0) / Math.max(1, list.length);
    const counts = !(await pacingRefusal(db, session, sid, i * perSeg));

    if (counts) {
      await recordDelivery({
        db,
        sid,
        campaignId: session.banner.campaignId,
        facts: {
          campaignId: session.banner.campaignId,
          owner: session.owner,
          permlink: session.permlink,
          country: session.country || null,
        },
        /* A banner is delivered the moment it is ON SCREEN, so ANY burned segment
         * completes it. recordDelivery's transition guard makes that once per session
         * however many segments follow.
         *
         * It used to complete on the LAST segment, borrowing the rule from a roll, where
         * reaching the end means somebody sat through the whole spot. A banner is not sat
         * through — it shares the picture with the video the viewer already chose. And the
         * last segment is precisely the one pacing refuses most often, because a player
         * fetches the whole banner in a burst from its buffer: measured, four sessions
         * showed this banner and one was counted, and the one that counted only managed it
         * ten minutes later when a re-request happened to arrive late enough. */
        completed: true,
      });
    }

    const burned = await burnSegment({
      segmentUrl: original,
      imageUrl: session.banner.imageUrl,
    });
    if (!burned) return res.redirect(302, original);

    res.set('Content-Type', 'video/mp2t');
    // The bytes for this (segment, creative) never change, and a viewer seeking back
    // over the banner should not make us serve them twice.
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    return res.sendFile(burned);
  } catch (err) {
    console.error('[ad-serve] burned segment failed:', err && err.message);
    if (original) return res.redirect(302, original);
    return res.status(502).send('unavailable');
  }
});

/* ─── GET /m/:sid/bc — the banner's click-through ─────────────────────── */
// Separate from /c because a playback can carry two advertisers and a click has to
// be attributed to the right one. Same contract otherwise: counted once, destination
// read from the approved advertiser record.
router.get('/:sid/bc', servingVisible, async (req, res) => {
  try {
    const sid = str(req.params.sid, 64);
    if (!/^[0-9a-f]{32}$/.test(sid)) return res.status(400).send('bad session');
    const db = getDb();
    const session = await db.collection(SESSIONS).findOne({ sid });
    if (!session || !session.banner || !session.banner.clickUrl) return res.status(404).send('not found');
    // Counted once per campaign per session, exactly as the spot's click is: a
    // viewer who clicks, comes back and clicks again is one interested person, not
    // two. Upserted for the same reason too — a click that arrives without an
    // impression on record (a failed segment write, an odd retry order) is still a
    // click, and losing it would under-report the one number an advertiser checks.
    try {
      const r = await db.collection(AD_IMPRESSIONS_COLLECTION).updateOne(
        { sid, campaignId: session.banner.campaignId, clicked: { $ne: true } },
        {
          $set: {
            campaignId: session.banner.campaignId,
            owner: session.owner,
            permlink: session.permlink,
            clicked: true,
            clickedAt: new Date(),
          },
          $setOnInsert: { at: new Date(), started: true, payoutId: null },
        },
        { upsert: true },
      );
      if (r.upsertedCount === 1 || r.modifiedCount === 1) {
        await db.collection(AD_CAMPAIGNS_COLLECTION)
          .updateOne({ _id: session.banner.campaignId }, { $inc: { clicks: 1 } });
      }
    } catch (e) {
      if (e?.code !== 11000) console.error('[ad-serve] banner click write failed:', e && e.message);
    }
    res.set('Cache-Control', 'no-store');
    return res.redirect(302, session.banner.clickUrl);
  } catch (err) {
    console.error('[ad-serve] banner click failed:', err && err.message);
    return res.status(502).send('unavailable');
  }
});

/* ─── GET /m/:sid/short.m3u8 — the shorts spot's own playlist ─────────── */
/**
 * A shorts spot is not spliced into anything: it IS the item. So this is simply the
 * creative's own playlist, re-pointed so the first and last segments come back
 * through /m/:sid/a and /m/:sid/b.
 *
 * That is the same two-segment measurement the roll uses, and for the same reason —
 * everything in between 302s straight to the CDN, so the spot is measured without a
 * single byte of it transiting this box. See the bandwidth note in adBurner.js for
 * why that constraint is not negotiable.
 *
 * 🚨 Declared BEFORE /:sid/:n, which would otherwise match 'short.m3u8' as an :n.
 */
router.get('/:sid/short.m3u8', servingVisible, async (req, res) => {
  try {
    const sid = str(req.params.sid, 64);
    if (!/^[0-9a-f]{32}$/.test(sid)) return res.status(400).send('bad session');

    const session = await getDb().collection(SESSIONS).findOne({ sid });
    if (!session || session.surface !== 'shorts') return res.status(404).send('expired');
    if (!session.adManifestUrl) return res.status(404).send('no spot on this session');

    const segments = await loadAdSegments(session.adManifestUrl);
    if (!segments.length) return res.status(502).send('unavailable');

    const publicBase = publicBaseOf(req);
    // loadAdSegments hands back the raw `#EXTINF:` LINE, not a number — it is reused
    // verbatim so the spot's timing is byte-for-byte the encoder's own. (Reading a
    // `duration` field off it instead produced #EXTINF:0.000000 on every segment,
    // which is a playlist a player reads as a zero-length ad.)
    const secsOf = (x) => parseFloat((String(x.extinf).match(/#EXTINF:\s*([\d.]+)/) || [])[1]) || 0;
    const target = Math.ceil(Math.max(...segments.map(secsOf), 1));
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${target}`,
      '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-MEDIA-SEQUENCE:0'];
    segments.forEach((seg, i) => {
      // A one-segment spot is both the opening and the closing measurement, which is
      // what 'ab' means to /:sid/:n — without it a short spot would start an
      // impression that nothing could ever complete.
      const key = segments.length === 1
        ? 'ab'
        : (i === 0 ? 'a' : (i === segments.length - 1 ? 'b' : null));
      lines.push(seg.extinf);
      lines.push(key ? `${publicBase}/m/${sid}/${key}` : seg.url);
    });
    lines.push('#EXT-X-ENDLIST');

    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Cache-Control', 'no-store');   // per-session; never shared or edge-cached
    return res.send(lines.join('\n'));
  } catch (err) {
    console.error('[ad-serve] shorts manifest failed:', err && err.message);
    // No fail-open here, and none is wanted: there is no content underneath a shorts
    // spot to fall back to. The feed simply moves on to the next short.
    return res.status(502).send('unavailable');
  }
});

/* ─── GET /m/:sid/:n — the two measured segments ──────────────────────── */
router.get('/:sid/:n', servingVisible, async (req, res) => {
  try {
    const sid = str(req.params.sid, 64);
    const n = str(req.params.n, 4);
    if (!/^[0-9a-f]{32}$/.test(sid) || !/^(a|b|ab)$/.test(n)) return res.status(400).send('bad request');

    const db = getDb();
    const session = await db.collection(SESSIONS).findOne({ sid });
    if (!session) return res.status(404).send('expired');

    if (!session.adManifestUrl) return res.status(404).send('no spot on this session');
    const segments = await loadAdSegments(session.adManifestUrl);
    const seg = n === 'a' ? segments[0] : segments[segments.length - 1];

    // Pacing: the closing segment cannot be reached before the spot has had time to
    // play. Same deal as the banner — the bytes go out regardless, they just do not
    // count, so a script cannot bank a completed impression in one round trip.
    const needs = (n === 'a') ? 0 : (Number(session.adDurationSeconds) || 0);
    if (await pacingRefusal(db, session, sid, needs)) {
      res.set('Cache-Control', 'no-store');
      return res.redirect(302, seg.url);
    }

    // Record BEFORE redirecting: the bytes are about to be served either way, and
    // a redirect that fails to record is an ad we gave away.
    await recordDelivery({
      db,
      sid,
      campaignId: session.campaignId,
      facts: {
        campaignId: session.campaignId,
        owner: session.owner,
        permlink: session.permlink,
        country: session.country || null,
      },
      completed: n === 'b' || n === 'ab',
    });

    res.set('Cache-Control', 'no-store');
    return res.redirect(302, seg.url);
  } catch (err) {
    console.error('[ad-serve] segment failed:', err && err.message);
    return res.status(502).send('unavailable');
  }
});

module.exports = router;
