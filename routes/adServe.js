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
  AD_CAMPAIGNS_COLLECTION, AD_CREATIVES_COLLECTION, AD_IMPRESSIONS_COLLECTION,
  AD_SESSION_TTL_MINUTES, AD_FREQUENCY_CAP_MINUTES, ADS_STAGE,
} = require('../utils/config');
const { STATES, CREATIVE_STATES, servableReason, ensureAdIndexes } = require('../utils/adModel');

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
function splice(contentText, contentBaseUrl, adSegments, position, sid, publicBase) {
  const lines = contentText.split(/\r?\n/);
  const abs = (u) => { try { return new URL(u, contentBaseUrl).href; } catch { return u; } };

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
      return true;
    });
    if (!eligible.length) return res.json({ ad: null, reason: 'no_eligible_campaign' });

    // Least-delivered first. With flat tenancy every booked campaign is owed the
    // same run, so evening out delivery is the fair split of scarce inventory —
    // an auction would be the wrong instinct here, there is nothing to bid on.
    eligible.sort((a, b2) => (a.deliveredImpressions || 0) - (b2.deliveredImpressions || 0));
    const campaign = eligible[0];
    const creative = byCampaign.get(String(campaign._id));

    const sid = crypto.randomBytes(16).toString('hex');
    await db.collection(SESSIONS).insertOne({
      sid,
      campaignId: campaign._id,
      creativeId: creative._id,
      adManifestUrl: creative.manifestUrl,
      // Stored unwrapped: the scope check on nested playlists is only meaningful
      // against the manifest's real origin.
      contentManifestUrl: unwrapProxiedManifest(contentManifestUrl),
      slotPosition: campaign.slotPosition,
      owner,
      permlink,
      viewer,
      capId,
      country,
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + AD_SESSION_TTL_MINUTES * 60 * 1000),
    });

    res.set('Cache-Control', 'no-store');
    res.json({
      ad: {
        manifestUrl: `${publicBaseOf(req)}/m/${sid}.m3u8`,
        position: campaign.slotPosition,
        durationSeconds: creative.durationSeconds,
        // The player shows a Sponsored label over this range. Disclosure is
        // required by EU and US advertising rules, and a label in the player
        // chrome is not something a filter list removes without breaking playback.
        label: 'Sponsored',
        advertiser: campaign.projectName || null,
      },
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

    const adSegments = await loadAdSegments(session.adManifestUrl);
    const spliced = splice(content.text, content.url, adSegments, session.slotPosition, sid, publicBase);
    // Record where the cut actually fell so the player can ask for it. Written on
    // every variant fetch, which is harmless — they all splice at the same boundary.
    await getDb().collection(SESSIONS).updateOne({ sid }, {
      $set: { adStartAt: spliced.adStartAt, adDurationSeconds: spliced.adDurationSeconds },
    }).catch(() => { /* the manifest still serves without it */ });
    return res.send(spliced.text);
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
    });
  } catch (err) {
    res.status(500).json({ error: 'unavailable' });
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

    const segments = await loadAdSegments(session.adManifestUrl);
    const seg = n === 'a' ? segments[0] : segments[segments.length - 1];

    // Record BEFORE redirecting: the bytes are about to be served either way, and
    // a redirect that fails to record is an ad we gave away.
    const started = n === 'a' || n === 'ab';
    const completed = n === 'b' || n === 'ab';
    const impressions = db.collection(AD_IMPRESSIONS_COLLECTION);
    const facts = {
      campaignId: session.campaignId,
      owner: session.owner,
      permlink: session.permlink,
      country: session.country || null,
    };
    try {
      if (!completed) {
        await impressions.updateOne(
          { sid },
          { $set: facts, $setOnInsert: { at: new Date(), started: true, payoutId: null } },
          { upsert: true },
        );
      } else {
        // Count the completion ONCE. Players re-request segments (a seek back into
        // the break, a retry after a network blip), and the campaign counter is
        // what delivery reporting and payout are computed from — an increment per
        // fetch would bill an advertiser for one play several times over.
        //
        // The `completed: { $ne: true }` filter is the transition guard: it matches
        // only an impression that has not already been closed. On a replay it
        // matches nothing and the upsert attempts an insert, which the unique index
        // on `sid` rejects — that duplicate-key error IS the "already counted"
        // signal, so it is caught rather than logged as a failure.
        let firstCompletion = false;
        try {
          const r = await impressions.updateOne(
            { sid, completed: { $ne: true } },
            {
              $set: { ...facts, completed: true, completedAt: new Date() },
              $setOnInsert: { at: new Date(), started: true, payoutId: null },
            },
            { upsert: true },
          );
          firstCompletion = r.upsertedCount === 1 || r.modifiedCount === 1;
        } catch (e) {
          if (e?.code !== 11000) throw e;   // already completed → not a failure
        }

        if (firstCompletion) {
          await db.collection(AD_CAMPAIGNS_COLLECTION).updateOne(
            { _id: session.campaignId },
            { $inc: { deliveredImpressions: 1 }, $set: { status: STATES.RUNNING, updatedAt: new Date() } },
          );
        }
      }
    } catch (e) {
      console.error('[ad-serve] impression write failed:', e && e.message);
    }

    res.set('Cache-Control', 'no-store');
    return res.redirect(302, seg.url);
  } catch (err) {
    console.error('[ad-serve] segment failed:', err && err.message);
    return res.status(502).send('unavailable');
  }
});

module.exports = router;
