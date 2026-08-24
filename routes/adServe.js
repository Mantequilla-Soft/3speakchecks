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
const { adDecision } = require('../utils/adEligibility');
const {
  AD_CAMPAIGNS_COLLECTION, AD_CREATIVES_COLLECTION, AD_IMPRESSIONS_COLLECTION, ADVERTISERS_COLLECTION,
  AD_SESSION_TTL_MINUTES, AD_FREQUENCY_CAP_MINUTES, ADS_STAGE,
  AD_BANNER_WIDTH_PCT, AD_BANNER_MAX_HEIGHT_PCT, AD_BANNER_MARGIN_PCT,
} = require('../utils/config');
const { STATES, CREATIVE_STATES, servableReason, ensureAdIndexes, slotSecondsFor } = require('../utils/adModel');
const { formatOf } = require('../utils/adFormats');
const { burnSegment } = require('../services/adBurner');

const SESSIONS = process.env.AD_SESSIONS_COLLECTION || 'ad_sessions';
const FETCH_TIMEOUT_MS = parseInt(process.env.AD_FETCH_TIMEOUT_MS, 10) || 6000;
const ID_RE = /^[a-z0-9._-]+$/i;
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

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

async function fetchText(url) {
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
    if (!ID_RE.test(owner) || !ID_RE.test(permlink)) {
      return res.status(400).json({ error: 'Invalid owner/permlink' });
    }
    if (!/^https:\/\//i.test(contentManifestUrl)) {
      return res.status(400).json({ error: 'manifestUrl must be an https URL' });
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

    const db = getDb();
    const now = new Date();

    // How long THIS video is, for campaigns that target video length. Looked up
    // rather than taken from the request: the client could otherwise claim any
    // duration and place itself inside a window the advertiser paid to exclude.
    // `{ permlink, owner }` is a unique index, so this is a point read.
    const video = await db.collection('embed-video')
      .findOne({ permlink, owner }, { projection: { duration: 1 } });
    const videoSeconds = Number(video && video.duration) || null;

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
    let recent = new Set();
    const capKey = viewer ? { viewer } : (capId ? { capId } : null);
    if (capKey) {
      const since = new Date(Date.now() - AD_FREQUENCY_CAP_MINUTES * 60 * 1000);
      const rows = await db.collection(SESSIONS)
        .find({ ...capKey, startedAt: { $gte: since } }, { projection: { campaignId: 1 } }).toArray();
      recent = new Set(rows.map((r) => String(r.campaignId)));
    }

    const eligible = candidates.filter((c) => {
      const creative = byCampaign.get(String(c._id));
      if (servableReason(c, creative)) return false;
      if (recent.has(String(c._id))) return false;
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
      if (abs.origin !== base.origin) return res.status(400).send('out of scope');
      target = abs.href;
    }

    const content = await fetchText(target);
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
      completed: i === list.length - 1,
    });

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
