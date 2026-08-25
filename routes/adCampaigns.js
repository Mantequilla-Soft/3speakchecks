/**
 * Booking and payment. Forked from routes/promote.js, which already solved the
 * hard part: prove an on-chain transfer happened, exactly once, without trusting
 * anything the client says about it.
 *
 * AUTH MODEL, and why there is no signature here:
 *   Creating a campaign is authorised by the advertiser's `reference` — the
 *   unguessable token their approved application returned. That is enough because
 *   an unpaid campaign does nothing at all: it cannot serve, cannot spend, and is
 *   invisible to viewers. The thing that actually costs money is the on-chain
 *   transfer, and that is verified against Hive itself, not against a claim in a
 *   request body. So the security sits where the value is, and advertisers whose
 *   login cannot sign a message (HiveSigner, Butter Auth) are not shut out of
 *   spending money with us.
 *
 *   Routes:
 *     GET  /advertise/pricing                     rate card + where to pay
 *     POST /advertise/campaigns                   create a flight (approved advertisers)
 *     GET  /advertise/campaigns?reference=…       the advertiser's own campaigns
 *     POST /advertise/campaigns/:id/creative      attach an uploaded spot
 *     POST /advertise/campaigns/:id/claim         verify payment, schedule the flight
 */
const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const { getDb } = require('../utils/db');
const { promisify } = require('util');
const execFileP = promisify(require('child_process').execFile);
const { hiveRpcBatch } = require('../utils/hive');
const {
  ADVERTISERS_COLLECTION, AD_CAMPAIGNS_COLLECTION, AD_CREATIVES_COLLECTION,
  AD_PAYMENTS_COLLECTION, AD_PAYMENT_ACCOUNT, AD_PRICE_PER_SECOND_DAY_HBD,
  AD_MIN_CAMPAIGN_DAYS, AD_MAX_CAMPAIGN_DAYS, AD_SLOT_PERCENTS, AD_LENGTH_SECONDS,
  AD_PRODUCTION_FEE_HBD, ADS_STAGE,
} = require('../utils/config');
const {
  STATES, CREATIVE_STATES, CREATIVE_KINDS, DAY_MS, ensureAdIndexes, priceForDays, ratePerDayFor,
  validDayCount, windowFrom, servableReason,
} = require('../utils/adModel');
const { getSnapshot, forecastPerDay } = require('../services/adInventory');
const {
  DEFAULT_FORMAT, FORMAT_KEYS, formatOf, isBookableFormat, rateFor, rateCard,
  creativeSpecError,
} = require('../utils/adFormats');
const { findSlotConflict, slotAvailability } = require('../utils/adSlots');

/**
 * When ADS_STAGE is 'off' the whole booking surface answers 404 — not 403, not an
 * empty list. A 403 confirms the thing exists; a 404 says nothing. The operator
 * admin routes live in routes/advertise.js and are deliberately NOT gated by this,
 * so the queue stays reachable while the feature is dark.
 *
 * Applied per-route rather than with a path-less router.use(), for the same reason
 * as everywhere else here: a blanket use() silently gates whatever is registered
 * after it, which is exactly how streamStats ended up 401-ing unrelated routes.
 */
function featureVisible(req, res, next) {
  if (ADS_STAGE === 'off') return res.status(404).json({ success: false, error: 'Not found' });
  return next();
}

const CDN = process.env.AD_CDN_GATEWAY || 'https://hotipfs-3speak-1.b-cdn.net/ipfs';
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/* ─── shared helpers ──────────────────────────────────────────────────── */

// HBD per HIVE from the on-chain median feed, so a HIVE payment is valued the
// same way promote.js values one. Never trust a client-supplied rate.
async function getHbdPerHive() {
  const [res] = await hiveRpcBatch([{
    jsonrpc: '2.0', method: 'condenser_api.get_current_median_history_price', params: [], id: 1,
  }]);
  const base = parseFloat(res?.result?.base);
  const quote = parseFloat(res?.result?.quote);
  if (!base || !quote) return 0;
  return base / quote;
}

function parseAsset(s) {
  const [amount, symbol] = String(s || '').trim().split(' ');
  return { amount: parseFloat(amount) || 0, symbol: (symbol || '').toUpperCase() };
}

function oid(v) {
  try { return new ObjectId(String(v)); } catch (_) { return null; }
}

/**
 * How many files an advertiser may attach while their application is still under
 * review: a spot, a logo, and a couple of stills. Enough to show us what they want
 * to run, not enough to be anybody's free video host.
 */
const PENDING_CREATIVE_MAX = 4;

/**
 * The advertiser behind a reference whether or not they are approved YET.
 *
 * Uploading a spot is deliberately open to a pending applicant, because the
 * reviewer's first question is "what would actually run", and a paragraph
 * describing a video is a worse answer than the video. It also means an advertiser
 * hears "yes, and your spot is approved too" in one reply instead of two.
 *
 * This does not make anything servable. Booking is open to an unreviewed advertiser
 * too, but the approval gate now sits in routes/adServe.js: nothing reaches a viewer
 * until a person has approved the advertiser AND the creative is READY AND the
 * payment has cleared. What this opens is storage, which PENDING_CREATIVE_MAX bounds.
 */
async function applicantAdvertiser(reference) {
  if (!reference) return null;
  const doc = await getDb().collection(ADVERTISERS_COLLECTION)
    .findOne({ reference, status: { $in: ['pending', 'approved'] } });
  return doc || null;
}

/**
 * Is this upload allowed under the pending applicant's file cap?
 *
 * Re-uploading a file already on record is always allowed: the write below is an
 * upsert keyed on embedId, so it replaces a row rather than adding one, and
 * refusing it would mean someone at the cap could not retry a failed encode.
 */
async function underPendingCap(advertiser, embedId) {
  if (advertiser.status === 'approved') return true;
  const coll = getDb().collection(AD_CREATIVES_COLLECTION);
  if (await coll.findOne({ embedId }, { projection: { _id: 1 } })) return true;
  return (await coll.countDocuments({ advertiserRef: advertiser.reference })) < PENDING_CREATIVE_MAX;
}

const CAP_REFUSAL = {
  success: false,
  error: `You can attach up to ${PENDING_CREATIVE_MAX} files while your application is being reviewed.`,
};

/** What an advertiser sees about one of their spots. */
function publicCreative(cr) {
  if (!cr) return null;
  return {
    embedId: cr.embedId,
    kind: cr.kind || CREATIVE_KINDS.VIDEO,
    imageUrl: cr.imageUrl || null,
    // So the page can show what a banner actually is when offering it, and check it
    // against the format's spec before sending anything.
    imageWidth: cr.imageWidth ?? null,
    imageHeight: cr.imageHeight ?? null,
    owner: cr.owner,
    permlink: cr.permlink || null,
    status: cr.status,
    durationSeconds: cr.durationSeconds,
    encoded: !!cr.manifestUrl,
    note: cr.reviewNote || null,
    campaignId: cr.campaignId ? String(cr.campaignId) : null,
    createdAt: cr.createdAt,
    // Playable straight away so the advertiser (and we) can watch it back before
    // it ever runs — the whole point of reviewing a spot beforehand.
    previewUrl: cr.permlink && cr.owner ? `https://3speak.tv/embed/${cr.owner}/${cr.permlink}` : null,
  };
}

/** What the advertiser is allowed to see about their own campaign. */
function publicCampaign(c, creative) {
  return {
    id: String(c._id),
    name: c.name,
    // What this flight IS, so the page knows what to ask for and what to send. The
    // absent-means-video_roll rule lives in formatOf(); this is its answer, never
    // the raw field.
    format: formatOf(c).key,
    formatLabel: formatOf(c).label,
    creativeKind: formatOf(c).creativeKind,
    creativeSpec: formatOf(c).creativeSpec || null,
    status: c.status,
    // Percent for anything booked since slots became relative; `slotPosition` is
    // what campaigns booked before that carry, in absolute seconds.
    slotPercent: c.slotPercent ?? null,
    slotPosition: c.slotPosition ?? null,
    days: c.days,
    priceHbd: c.priceHbd,
    flightHbd: c.flightHbd ?? c.priceHbd,
    // What this flight was actually priced at, not what the advertiser is on today.
    pricePerSecondDayHbd: c.pricePerSecondDayHbd ?? c.pricePerDayHbd ?? null,
    spotSeconds: c.spotSeconds ?? null,
    minVideoSeconds: c.minVideoSeconds ?? null,
    maxVideoSeconds: c.maxVideoSeconds ?? null,
    productionFeeHbd: c.productionFeeHbd || 0,
    production: c.productionRequested ? {
      requested: true,
      brief: c.productionBrief || null,
      status: c.productionStatus || 'requested',
    } : null,
    paidHbd: c.paidHbd || 0,
    startAt: c.startAt || null,
    endAt: c.endAt || null,
    markets: c.markets || [],
    memo: c.memo,
    payTo: AD_PAYMENT_ACCOUNT,
    delivered: c.deliveredImpressions || 0,
    forecast: c.forecastImpressions ?? null,
    deliveryRate: c.deliveryRate ?? null,
    refundHbd: c.refundHbd ?? null,
    refundStatus: c.refundStatus || null,
    creative: creative ? {
      status: creative.status,
      durationSeconds: creative.durationSeconds,
      embedId: creative.embedId,
      note: creative.reviewNote || null,
    } : null,
    // The single answer to "why is my campaign not running". Derived in one place
    // (adModel.servableReason) so the console can never disagree with the server.
    blockedBy: servableReason(c, creative),
  };
}

/* ─── GET /advertise/pricing ──────────────────────────────────────────── */
router.get('/pricing', featureVisible, async (req, res) => {
  try {
    const hbdPerHive = await getHbdPerHive().catch(() => 0);

    // With a reference, quote THAT advertiser's rate. Without one this is the public
    // rate card, which is what an anonymous reader of /advertise sees.
    //
    // A negotiated rate is not public, so a request carrying a reference must never
    // be cached: the default response is `public, max-age=300`, and serving one
    // advertiser's rate to the next visitor from a shared cache is exactly the bug
    // that would create.
    const reference = str(req.query.reference, 64);
    const advertiser = reference ? await applicantAdvertiser(reference) : null;
    // Kept for the roll, because that is what every existing caller reads. The
    // `formats` array below is the real rate card now — there is no single price any
    // more, and a client that only understands one product still gets the right
    // number for the product it understands.
    const pricePerSecondDayHbd = rateFor(advertiser, DEFAULT_FORMAT);
    res.set('Cache-Control', reference ? 'no-store' : 'public, max-age=300');

    res.json({
      success: true,
      payTo: AD_PAYMENT_ACCOUNT,
      // HBD per second of spot, per day of flight. The page multiplies by the
      // booked length rather than being handed a single headline number, because
      // there is no single price any more — a 5s spot and a 15s spot differ.
      pricePerSecondDayHbd,
      // Every bookable product, each with its own rate, its own maximum length and
      // its own asset requirement. Derived from the registry so a format added later
      // appears here without this route being touched.
      formats: rateCard(advertiser),
      // Any whole number of seconds up to the cap. A fixed list of lengths made
      // people round up to the next option and pay for seconds they did not want.
      minSpotSeconds: 1,
      // So the page can say "your rate" rather than quietly showing a different
      // number from the one in the rate card above it.
      rateIsCustom: pricePerSecondDayHbd !== AD_PRICE_PER_SECOND_DAY_HBD,
      minDays: AD_MIN_CAMPAIGN_DAYS,
      maxDays: AD_MAX_CAMPAIGN_DAYS,
      slotPercents: AD_SLOT_PERCENTS,
      maxCreativeSeconds: AD_LENGTH_SECONDS,
      productionFeeHbd: AD_PRODUCTION_FEE_HBD,
      hbdPerHive,
      // Flat tenancy, stated plainly so nobody arrives expecting a CPM.
      model: 'flat',
      note: `A booking buys the slot across the network for the whole flight. Priced per day, not per impression.`,
    });
  } catch (err) {
    console.error('[ad-campaigns] pricing failed:', err && err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});


/**
 * Intrinsic size of a banner image, or null.
 *
 * Recorded once when the creative is attached so the serving side can send the
 * EXACT rectangle the banner will occupy rather than the box it is fitted into. The
 * difference is not cosmetic: a 1344x240 strip fitted into a 768x108 box lands
 * 604x108, leaving 82px of dead space either side. A click target covering the box
 * would send a viewer to an advertiser's site from a part of the frame with no ad in
 * it, which is the kind of thing that makes people distrust a player.
 *
 * Best-effort. A probe that fails stores nothing and the serving side falls back to
 * the box — a slightly generous click target is worth much less than a failed
 * upload, so this must never block attaching a creative.
 */
async function probeImageSize(url) {
  try {
    const { stdout } = await execFileP('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'json', url,
    ], { timeout: 15000, maxBuffer: 1 << 20 });
    const st = (JSON.parse(stdout).streams || [])[0] || {};
    const w = Number(st.width) || 0;
    const h = Number(st.height) || 0;
    return w > 0 && h > 0 ? { width: w, height: h } : null;
  } catch {
    return null;
  }
}

/* ─── GET /advertise/slots?days=&startAt= ─────────────────────────────── */
// What is actually for sale, for a given window. The form needs this BEFORE it lets
// someone pick a position: offering all five and then refusing one at submit is a
// worse experience than only ever offering what can be bought.
router.get('/slots', featureVisible, async (req, res) => {
  try {
    const days = Number(req.query.days);
    if (!validDayCount(days)) {
      return res.status(400).json({
        success: false,
        error: `days must be a whole number between ${AD_MIN_CAMPAIGN_DAYS} and ${AD_MAX_CAMPAIGN_DAYS}`,
      });
    }
    const want = windowFrom(req.query.startAt ? new Date(String(req.query.startAt)) : null, days);
    // Availability moves as holds lapse and flights end, so this must never be
    // cached — a stale "free" is a booking that fails at submit.
    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      startAt: want.startAt,
      endAt: want.endAt,
      slots: await slotAvailability(getDb(), {
        start: want.startAt.getTime(),
        end: want.endAt.getTime(),
        // Availability is per SURFACE. Without this a banner at 25% made the roll at
        // 25% look sold, and half the rate card vanished for no reason.
        format: str(req.query.format, 32) || DEFAULT_FORMAT,
      }),
    });
  } catch (err) {
    console.error('[ad-campaigns] slots failed:', err && err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/* ─── POST /advertise/campaigns ───────────────────────────────────────── */
router.post('/campaigns', featureVisible, express.json({ limit: '32kb' }), async (req, res) => {
  try {
    await ensureAdIndexes();
    const b = req.body || {};
    const advertiser = await applicantAdvertiser(str(b.reference, 64));
    if (!advertiser) {
      return res.status(403).json({ success: false, error: 'No product for that reference' });
    }

    // The product being bought. Everything below is validated against this format's
    // own rules rather than a single global set, which is what lets a banner be 20s
    // and unpositioned while a roll stays 15s and positioned.
    const formatKey = str(b.format, 32) || DEFAULT_FORMAT;
    if (!isBookableFormat(formatKey)) {
      return res.status(400).json({
        success: false,
        error: `format must be one of: ${FORMAT_KEYS.join(', ')}`,
      });
    }
    const fmt = formatOf({ format: formatKey });

    const name = str(b.name, 120) || `${advertiser.projectName} campaign`;
    const days = Number(b.days);
    if (!validDayCount(days)) {
      return res.status(400).json({
        success: false,
        error: `days must be a whole number between ${AD_MIN_CAMPAIGN_DAYS} and ${AD_MAX_CAMPAIGN_DAYS}`,
      });
    }

    // When they want it to start. Optional — blank means "as soon as it is approved
    // and paid", which is what windowFrom() does on its own.
    //
    // A start in the PAST is refused rather than accepted: windowFrom() clamps it to
    // now, so booking one used to succeed and then quietly run on different dates
    // than the ones on the form. The slack is a full day because the browser sends a
    // bare calendar date, which Date parses as UTC midnight — an advertiser in
    // UTC-12 picking their own tomorrow is legitimately up to 14 hours "behind" us,
    // and refusing them would be refusing a date they cannot avoid picking. Anything
    // older than that is a date nobody in any timezone still calls tomorrow.
    let requestedStart = null;
    if (b.startAt) {
      requestedStart = new Date(b.startAt);
      if (Number.isNaN(requestedStart.getTime())) {
        return res.status(400).json({ success: false, error: 'startAt is not a date we can read.' });
      }
      if (requestedStart.getTime() < Date.now() - DAY_MS) {
        return res.status(400).json({
          success: false,
          error: 'The earliest start is tomorrow — a flight has to be approved and paid before it can run.',
        });
      }
    }
    // Where it runs inside the video — for the formats where that is a thing to buy.
    // The upload gate plays at the one moment it can play, so asking for a position
    // would be a field the advertiser fills in that changes nothing. Stored as null
    // there rather than 0: 0 is a real, meaningful value (pre-roll).
    let slotPercent = null;
    if (fmt.positioned) {
      slotPercent = Number(b.slotPercent);
      if (!AD_SLOT_PERCENTS.includes(slotPercent)) {
        return res.status(400).json({
          success: false,
          error: `slotPercent must be one of: ${AD_SLOT_PERCENTS.join(', ')} (percent of the video)`,
        });
      }
    }
    const markets = Array.isArray(b.markets)
      ? b.markets.map((m) => str(m, 2).toUpperCase()).filter((m) => /^[A-Z]{2}$/.test(m)).slice(0, 20)
      : [];

    // "Make the spot for us" — a one-time fee on top of the flight, folded into the
    // same total so the advertiser sends ONE transfer. The brief is required when
    // asked for: a production request with no description is a support ticket
    // nobody can action.
    const productionRequested = b.production === true || b.production?.requested === true;
    const productionBrief = str(b.production?.brief ?? b.productionBrief, 4000);
    if (productionRequested && productionBrief.length < 20) {
      return res.status(400).json({
        success: false,
        error: 'Tell us what the spot should say (at least 20 characters) so we can make it.',
      });
    }
    const productionFeeHbd = productionRequested ? AD_PRODUCTION_FEE_HBD : 0;

    // Read from the advertiser, then WRITTEN ONTO THE CAMPAIGN below. An admin can
    // change someone's rate at any time, and a flight already booked must keep the
    // number it was quoted at — recomputing from the advertiser later would silently
    // reprice a booking that has already been paid for.
    // The length of slot being bought. Chosen here rather than read off a creative
    // because a flight is routinely booked before any spot is attached, and a price
    // that cannot be computed until later is a price nobody can be quoted.
    // For a banner this is how long it stays on screen rather than how long a spot
    // runs, which is why the cap is the FORMAT's and not the platform's.
    const spotSeconds = Number(b.spotSeconds);
    if (!Number.isInteger(spotSeconds) || spotSeconds < 1 || spotSeconds > fmt.maxSeconds) {
      return res.status(400).json({
        success: false,
        error: `spotSeconds must be a whole number of seconds between 1 and ${fmt.maxSeconds} for a ${fmt.label.toLowerCase()}`,
      });
    }

    // Video-length targeting. Both optional and both open-ended: 0 or absent means
    // "no limit on that end", so an advertiser can say "at least three minutes"
    // without also having to invent a maximum.
    const numOrNull = (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
    };
    const minVideoSeconds = numOrNull(b.minVideoSeconds);
    const maxVideoSeconds = numOrNull(b.maxVideoSeconds);
    if (minVideoSeconds && maxVideoSeconds && minVideoSeconds > maxVideoSeconds) {
      return res.status(400).json({
        success: false,
        error: 'The shortest video cannot be longer than the longest one.',
      });
    }

    // Per format: a banner and a roll are different products at different rates, and
    // the number written onto the campaign is the one the advertiser was quoted.
    // 🚨 One campaign per position, per overlapping flight — ACROSS FORMATS. The rate
    // card has always sold the slot ("a booking buys the slot across the network for
    // the whole flight"); until now the serving side just rotated two holders and
    // quoted both of them the whole thing, which ended in an automatic 50% refund to
    // each. Checked here, at the only point where a new claim on a slot is made.
    if (fmt.positioned) {
      const want = windowFrom(requestedStart, days);
      const clash = await findSlotConflict(getDb(), {
        slotPercent,
        start: want.startAt.getTime(),
        end: want.endAt.getTime(),
      });
      if (clash) {
        return res.status(409).json({
          success: false,
          error: `The ${slotPercent}% position is already booked for those dates.`
            + ` It is free from ${clash.freeFrom.toISOString().slice(0, 10)}.`,
          // So the form can offer what IS free rather than making them guess. Never
          // says WHO holds it — that is not one advertiser's business about another.
          slotPercent,
          freeFrom: clash.freeFrom,
          alternatives: (await slotAvailability(getDb(), {
            start: want.startAt.getTime(), end: want.endAt.getTime(),
          })).filter((x) => x.available).map((x) => x.percent),
        });
      }
    }

    const pricePerSecondDayHbd = rateFor(advertiser, formatKey);
    const flightHbd = priceForDays(days, pricePerSecondDayHbd, spotSeconds);
    const priceHbd = Math.round((flightHbd + productionFeeHbd) * 1000) / 1000;

    // What the inventory says this slot should deliver over the flight. Recorded at
    // BOOKING time on purpose: it is the number the advertiser was shown, so it is
    // the number a refund for under-delivery has to be measured against. Reading it
    // at settlement instead would let a later change in traffic quietly rewrite what
    // we had promised.
    let forecastImpressions = null;
    try {
      if (fmt.surface !== 'watch') {
        // The inventory forecast counts video plays. The upload gate is not served
        // against plays at all, so a play-based number would be a confident answer to
        // a different question — better to record none than to quote a wrong one.
        forecastImpressions = null;
      } else if (minVideoSeconds || maxVideoSeconds) {
        // Narrowed by video length, so the network-wide rate card no longer
        // describes this booking. Measure the inventory that was actually bought.
        const perDay = await forecastPerDay({ percent: slotPercent, minVideoSeconds, maxVideoSeconds });
        if (Number.isFinite(perDay)) forecastImpressions = Math.round(perDay * days);
      } else {
        const snap = await getSnapshot();
        const slot = snap?.slots?.find((x) => x.percent === slotPercent);
        if (slot && Number.isFinite(slot.perDay)) forecastImpressions = Math.round(slot.perDay * days);
      }
    } catch (_) { /* no forecast on record — closeFinishedCampaigns flags it for a human */ }

    const doc = {
      advertiserRef: advertiser.reference,
      hiveAccount: advertiser.hiveAccount,
      projectName: advertiser.projectName,
      name,
      // Written explicitly on every new campaign. Absent means video_roll — see
      // utils/adFormats.js — but only campaigns booked BEFORE formats existed should
      // ever be relying on that default.
      format: formatKey,
      status: STATES.AWAITING_PAYMENT,
      slotPercent,
      days,
      markets,
      priceHbd,
      flightHbd,
      spotSeconds,
      minVideoSeconds,
      maxVideoSeconds,
      pricePerSecondDayHbd,
      productionFeeHbd,
      productionRequested,
      productionBrief: productionRequested ? productionBrief : null,
      productionStatus: productionRequested ? 'requested' : null,
      paidHbd: 0,
      requestedStartAt: requestedStart,
      startAt: null,          // set when the money lands, not when the form is filled
      endAt: null,
      deliveredImpressions: 0,
      forecastImpressions,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const { insertedId } = await getDb().collection(AD_CAMPAIGNS_COLLECTION).insertOne(doc);

    // The memo is the whole payment protocol: it is what ties an anonymous
    // on-chain transfer back to this campaign, so it goes in the response rather
    // than being something the advertiser has to construct correctly.
    const memo = `ad:${insertedId}`;
    await getDb().collection(AD_CAMPAIGNS_COLLECTION).updateOne({ _id: insertedId }, { $set: { memo } });

    res.status(201).json({
      success: true,
      campaign: publicCampaign({ ...doc, _id: insertedId, memo }, null),
      payment: {
        to: AD_PAYMENT_ACCOUNT,
        amount: `${priceHbd.toFixed(3)} HBD`,
        memo,
        note: 'Send the transfer with exactly this memo, then call claim. HIVE is accepted and valued at the on-chain median price.',
      },
    });
  } catch (err) {
    console.error('[ad-campaigns] create failed:', err && err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/* ─── GET /advertise/campaigns?reference=… ────────────────────────────── */
router.get('/campaigns', featureVisible, async (req, res) => {
  try {
    const advertiser = await applicantAdvertiser(str(req.query.reference, 64));
    if (!advertiser) {
      return res.status(403).json({ success: false, error: 'No product for that reference' });
    }
    const db = getDb();
    const camps = await db.collection(AD_CAMPAIGNS_COLLECTION)
      .find({ advertiserRef: advertiser.reference }).sort({ createdAt: -1 }).limit(100).toArray();
    const creatives = await db.collection(AD_CREATIVES_COLLECTION)
      .find({ campaignId: { $in: camps.map((c) => c._id) } }).toArray();
    const byCampaign = new Map(creatives.map((cr) => [String(cr.campaignId), cr]));

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      campaigns: camps.map((c) => publicCampaign(c, byCampaign.get(String(c._id)) || null)),
    });
  } catch (err) {
    console.error('[ad-campaigns] list failed:', err && err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/* ─── POST /advertise/campaigns/:id/creative ──────────────────────────── */
// Attaches an already-uploaded spot. The upload itself goes through the normal
// embed pipeline (TUS → IPFS → encoder), so the ad gets the SAME HLS ladder as
// content — a creative encoded any other way would stall the splice on a codec or
// resolution change. What this endpoint does is claim one of those uploads as an
// ad and put it in front of a human.
router.post('/campaigns/:id/creative', featureVisible, express.json({ limit: '16kb' }), async (req, res) => {
  try {
    await ensureAdIndexes();
    const b = req.body || {};
    const advertiser = await applicantAdvertiser(str(b.reference, 64));
    if (!advertiser) return res.status(403).json({ success: false, error: 'No product for that reference' });

    const id = oid(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: 'Invalid campaign id' });

    const db = getDb();
    const campaign = await db.collection(AD_CAMPAIGNS_COLLECTION)
      .findOne({ _id: id, advertiserRef: advertiser.reference });
    if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });

    const fmt = formatOf(campaign);

    // A banner is made of a still, so attaching one is attaching an IMAGE — there is
    // no upload and no encode in that path at all. Refuse the mismatch here with an
    // answer, rather than accepting it and letting servableReason quietly report
    // `creative_is_a_video` days later when the flight fails to run.
    if (fmt.creativeKind === CREATIVE_KINDS.IMAGE) {
      const imageUrl = str(b.imageUrl, 1024);
      if (!imageUrl) {
        return res.status(400).json({
          success: false,
          error: `A ${fmt.label.toLowerCase()} is an image. Send imageUrl, not embedId.`,
        });
      }
      if (!/^https:\/\//i.test(imageUrl)) {
        return res.status(400).json({ success: false, error: 'imageUrl must be an https URL' });
      }
      const key = `img:${imageUrl}`;
      const size = await probeImageSize(imageUrl);

      // Checked HERE, where the format is known. The same image uploaded on its own
      // might be a logo or a still, and those have no shape requirement — it only
      // has to be banner-shaped once it is going to BE a banner.
      const shapeError = creativeSpecError(fmt.key, size || {});
      if (shapeError) return res.status(400).json({ success: false, error: shapeError });

      const prior = await db.collection(AD_CREATIVES_COLLECTION).findOne({ embedId: key });
      // Same rule as the video path: a decision already made by a human survives
      // being attached to a flight.
      const settled = prior
        && (prior.status === CREATIVE_STATES.READY || prior.status === CREATIVE_STATES.REJECTED);
      await db.collection(AD_CREATIVES_COLLECTION).updateOne(
        { embedId: key },
        {
          $set: {
            campaignId: id,
            advertiserRef: advertiser.reference,
            kind: CREATIVE_KINDS.IMAGE,
            imageUrl,
            owner: advertiser.hiveAccount,
            // What the serving side needs to say exactly where the banner will sit.
            imageWidth: size ? size.width : null,
            imageHeight: size ? size.height : null,
            // A still has no duration of its own. How long it is ON SCREEN is what
            // the flight booked, and that lives on the campaign.
            durationSeconds: 0,
            manifestUrl: null,
            status: settled ? prior.status : CREATIVE_STATES.REVIEW,
            updatedAt: new Date(),
          },
          $setOnInsert: { embedId: key, reviewNote: null, createdAt: new Date() },
        },
        { upsert: true },
      );
      const saved = await db.collection(AD_CREATIVES_COLLECTION).findOne({ embedId: key });
      return res.json({ success: true, creative: publicCreative(saved) });
    }

    const embedId = str(b.embedId, 64);
    if (!embedId) return res.status(400).json({ success: false, error: 'embedId is required' });
    const embedOid = oid(embedId);
    const embed = await db.collection('embed-video').findOne(
      embedOid ? { $or: [{ _id: embedOid }, { permlink: embedId }] } : { permlink: embedId },
    );
    if (!embed) return res.status(404).json({ success: false, error: 'That upload was not found' });

    // An ad creative must NOT be a published post. A spot that also lives on Hive
    // as someone's video would show up in feeds and collect rewards as content,
    // which is not what an advertiser bought or what a viewer expects.
    if (embed.hive_author || embed.hive_permlink) {
      return res.status(400).json({
        success: false,
        error: 'That upload was published to Hive. An ad creative must be an unpublished upload.',
      });
    }

    // The slot this flight actually BOUGHT, which can be shorter than the platform
    // maximum — you cannot pay for five seconds and then run fifteen. Flights booked
    // before slot lengths existed fall back to the global cap.
    const bookedSeconds = Number(campaign.spotSeconds) > 0
      ? Number(campaign.spotSeconds)
      : fmt.maxSeconds;
    const durationSeconds = Math.round(Number(embed.duration) || 0);
    if (durationSeconds > 0 && durationSeconds > bookedSeconds) {
      return res.status(400).json({
        success: false,
        error: `The spot is ${durationSeconds}s and this flight booked a ${bookedSeconds}s slot.`
          + (bookedSeconds < fmt.maxSeconds
            ? ` Book a longer slot (up to ${fmt.maxSeconds}s) or trim the spot.`
            : ''),
      });
    }

    const encoded = !!embed.manifest_cid;
    const manifestUrl = encoded ? `${CDN}/${embed.manifest_cid}/manifest.m3u8` : null;
    const creativeKey = String(embed._id);

    // A creative is identified by its embedId, never by the campaign it happens to
    // be attached to. Since a spot can be uploaded and reviewed BEFORE any flight
    // exists, the row is usually already there with `campaignId: null` — and an
    // upsert filtered on `{ campaignId: id }` matches nothing, tries to insert, and
    // dies on the unique index on embedId. That is a 500 on the attach button.
    const existing = await db.collection(AD_CREATIVES_COLLECTION).findOne({ embedId: creativeKey });

    // A spot that has already been through review keeps that decision. Recomputing
    // the status here would silently un-approve an approved spot the moment its
    // owner attached it to a flight, which is the opposite of what attaching means.
    // Anything not yet decided follows the usual road: encoding first, then a human,
    // never straight to READY.
    const decided = existing
      && (existing.status === CREATIVE_STATES.READY || existing.status === CREATIVE_STATES.REJECTED);
    const status = decided
      ? existing.status
      : (encoded ? CREATIVE_STATES.REVIEW : CREATIVE_STATES.PENDING);

    await db.collection(AD_CREATIVES_COLLECTION).updateOne(
      { embedId: creativeKey },
      {
        $set: {
          campaignId: id,
          advertiserRef: advertiser.reference,
          kind: CREATIVE_KINDS.VIDEO,
          owner: embed.owner || null,
          permlink: embed.permlink,
          durationSeconds,
          manifestUrl,
          status,
          updatedAt: new Date(),
        },
        $setOnInsert: { embedId: creativeKey, reviewNote: null, createdAt: new Date() },
      },
      { upsert: true },
    );

    // One spot per flight. Serving maps creatives by campaignId, so a second row
    // pointing at the same campaign would leave which one runs down to document
    // order. Release the previous spot rather than leaving two attached — it stays
    // in the advertiser's library, just no longer on this flight.
    await db.collection(AD_CREATIVES_COLLECTION).updateMany(
      { campaignId: id, embedId: { $ne: creativeKey } },
      { $set: { campaignId: null, updatedAt: new Date() } },
    );

    const creative = await db.collection(AD_CREATIVES_COLLECTION).findOne({ embedId: creativeKey });
    const fresh = await db.collection(AD_CAMPAIGNS_COLLECTION).findOne({ _id: id });
    res.json({ success: true, campaign: publicCampaign(fresh, creative) });
  } catch (err) {
    console.error('[ad-campaigns] creative failed:', err && err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/* ─── creatives, independent of any campaign ──────────────────────────── */
// A spot can be uploaded and reviewed BEFORE a flight is booked, and before the
// advertiser is even approved — which is the order things actually happen in: an
// advertiser wants to know we will run their creative before they send money for
// it, and we want to see the creative before we say yes to them. The upload itself
// goes through the normal embed pipeline with `frontend_app: '3speak-ads'`, which
// leaves it unlisted and with no Hive post, so a spot never appears in feeds or
// collects post rewards.
router.post('/creatives', featureVisible, express.json({ limit: '16kb' }), async (req, res) => {
  try {
    await ensureAdIndexes();
    const b = req.body || {};
    const advertiser = await applicantAdvertiser(str(b.reference, 64));
    if (!advertiser) return res.status(403).json({ success: false, error: 'No advertiser application for that reference' });

    const db = getDb();

    // An IMAGE asset: stored, reviewable, never servable on its own. The stitcher
    // splices HLS segments and a still is not something HLS can express, so an image
    // is a thing to build a spot AROUND — a logo, a still, a frame — not a spot.
    // Accepting it and failing later at splice time would be the dishonest version.
    const imageUrl = str(b.imageUrl, 1024);
    if (imageUrl) {
      if (!/^https:\/\//i.test(imageUrl)) {
        return res.status(400).json({ success: false, error: 'imageUrl must be an https URL' });
      }
      const key = `img:${imageUrl}`;
      if (!(await underPendingCap(advertiser, key))) return res.status(429).json(CAP_REFUSAL);
      const imgSize = await probeImageSize(imageUrl);
      await db.collection(AD_CREATIVES_COLLECTION).updateOne(
        { embedId: key },
        {
          $set: {
            advertiserRef: advertiser.reference,
            kind: CREATIVE_KINDS.IMAGE,
            imageUrl,
            imageWidth: imgSize ? imgSize.width : null,
            imageHeight: imgSize ? imgSize.height : null,
            owner: advertiser.hiveAccount,
            durationSeconds: 0,
            manifestUrl: null,
            status: CREATIVE_STATES.REVIEW,
            updatedAt: new Date(),
          },
          $setOnInsert: { embedId: key, campaignId: null, reviewNote: null, createdAt: new Date() },
        },
        { upsert: true },
      );
      const saved = await db.collection(AD_CREATIVES_COLLECTION).findOne({ embedId: key });
      return res.status(201).json({ success: true, creative: publicCreative(saved) });
    }

    const embedId = str(b.embedId, 64);
    if (!embedId) return res.status(400).json({ success: false, error: 'embedId or imageUrl is required' });

    const embedOid = oid(embedId);
    const embed = await db.collection('embed-video').findOne(
      embedOid ? { $or: [{ _id: embedOid }, { permlink: embedId }] } : { permlink: embedId },
    );
    if (!embed) return res.status(404).json({ success: false, error: 'That upload was not found' });
    if (embed.hive_author || embed.hive_permlink) {
      return res.status(400).json({
        success: false,
        error: 'That upload was published to Hive. An ad creative must be an unpublished upload.',
      });
    }

    const durationSeconds = Math.round(Number(embed.duration) || 0);
    if (durationSeconds > 0 && durationSeconds > AD_LENGTH_SECONDS) {
      return res.status(400).json({ success: false, error: `The spot is ${durationSeconds}s. The slot is ${AD_LENGTH_SECONDS}s.` });
    }

    const encoded = !!embed.manifest_cid;
    if (!(await underPendingCap(advertiser, String(embed._id)))) return res.status(429).json(CAP_REFUSAL);
    await db.collection(AD_CREATIVES_COLLECTION).updateOne(
      { embedId: String(embed._id) },
      {
        $set: {
          advertiserRef: advertiser.reference,
          kind: CREATIVE_KINDS.VIDEO,
          owner: embed.owner || null,
          permlink: embed.permlink,
          durationSeconds,
          manifestUrl: encoded ? `${CDN}/${embed.manifest_cid}/manifest.m3u8` : null,
          // Never straight to READY. We are about to put this in front of other
          // people's audiences, so a human looks at it first.
          status: encoded ? CREATIVE_STATES.REVIEW : CREATIVE_STATES.PENDING,
          updatedAt: new Date(),
        },
        $setOnInsert: { embedId: String(embed._id), campaignId: null, reviewNote: null, createdAt: new Date() },
      },
      { upsert: true },
    );

    const creative = await db.collection(AD_CREATIVES_COLLECTION).findOne({ embedId: String(embed._id) });
    res.status(201).json({ success: true, creative: publicCreative(creative) });
  } catch (err) {
    console.error('[ad-campaigns] creative upload failed:', err && err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.get('/creatives', featureVisible, async (req, res) => {
  try {
    const advertiser = await applicantAdvertiser(str(req.query.reference, 64));
    if (!advertiser) return res.status(403).json({ success: false, error: 'No advertiser application for that reference' });
    const rows = await getDb().collection(AD_CREATIVES_COLLECTION)
      .find({ advertiserRef: advertiser.reference }).sort({ createdAt: -1 }).limit(50).toArray();
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, creatives: rows.map(publicCreative) });
  } catch (err) {
    console.error('[ad-campaigns] creatives list failed:', err && err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/* ─── POST /advertise/campaigns/:id/claim ─────────────────────────────── */
// Verifies the on-chain payment and schedules the flight. Straight fork of
// promote.js's claim: read the payment account's recent transfers, match the memo,
// RESERVE each txid via the unique index before crediting anything, and value the
// result only from what the chain says.
router.post('/campaigns/:id/claim', featureVisible, express.json({ limit: '8kb' }), async (req, res) => {
  try {
    await ensureAdIndexes();
    const id = oid(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: 'Invalid campaign id' });

    const db = getDb();
    const campaign = await db.collection(AD_CAMPAIGNS_COLLECTION).findOne({ _id: id });
    if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });
    if (campaign.status === STATES.CANCELLED) {
      return res.status(409).json({ success: false, error: 'That campaign was cancelled' });
    }

    // operation filter (low) for `transfer` (op id 2) = 1<<2 = 4.
    const [hist] = await hiveRpcBatch([{
      jsonrpc: '2.0', method: 'condenser_api.get_account_history',
      params: [AD_PAYMENT_ACCOUNT, -1, 1000, 4, 0], id: 1,
    }]);
    const ops = Array.isArray(hist?.result) ? hist.result : [];

    const memoWanted = String(campaign.memo || `ad:${id}`).toLowerCase();
    const matches = [];
    for (const entry of ops) {
      const op = entry?.[1]?.op;
      const trxId = entry?.[1]?.trx_id;
      if (!op || op[0] !== 'transfer' || !trxId) continue;
      const t = op[1];
      if (t.to !== AD_PAYMENT_ACCOUNT) continue;
      if (String(t.memo || '').trim().toLowerCase() !== memoWanted) continue;
      matches.push({ trxId, from: t.from, amount: t.amount });
    }
    if (!matches.length) {
      return res.status(404).json({
        success: false,
        error: 'No matching transfer found yet',
        expect: { to: AD_PAYMENT_ACCOUNT, memo: campaign.memo, amount: `${campaign.priceHbd.toFixed(3)} HBD` },
      });
    }

    // Reserve before crediting: a duplicate key here means another request already
    // counted this payment, so it is skipped rather than credited twice.
    const payments = db.collection(AD_PAYMENTS_COLLECTION);
    const reserved = [];
    for (const m of matches) {
      try {
        await payments.insertOne({
          trx_id: m.trxId, campaignId: id, from: m.from, amount: m.amount, processedAt: new Date(),
        });
        reserved.push(m);
      } catch (e) {
        if (e?.code !== 11000) throw e;
      }
    }
    if (!reserved.length) {
      const current = await db.collection(AD_CAMPAIGNS_COLLECTION).findOne({ _id: id });
      const creative = await db.collection(AD_CREATIVES_COLLECTION).findOne({ campaignId: id });
      return res.json({ success: true, message: 'Already credited', campaign: publicCampaign(current, creative) });
    }

    const hbdPerHive = await getHbdPerHive();
    let credited = 0;
    for (const m of reserved) {
      const { amount, symbol } = parseAsset(m.amount);
      if (symbol === 'HBD') credited += amount;
      else if (symbol === 'HIVE') credited += amount * hbdPerHive;
    }

    const paidHbd = Math.round(((campaign.paidHbd || 0) + credited) * 1000) / 1000;
    const fullyPaid = paidHbd + 1e-6 >= campaign.priceHbd;
    const window = fullyPaid ? windowFrom(campaign.requestedStartAt, campaign.days) : {};

    const update = { paidHbd, updatedAt: new Date() };
    if (fullyPaid) {
      // The flight clock starts now (or at the requested start), never at booking —
      // a campaign paid a week late should get its full run, not what is left of it.
      update.startAt = window.startAt;
      update.endAt = window.endAt;
      update.status = STATES.SCHEDULED;
    }

    try {
      await db.collection(AD_CAMPAIGNS_COLLECTION).updateOne({ _id: id }, { $set: update });
    } catch (creditErr) {
      // Never lose a real payment to a transient write failure — release the
      // reservation so a retry can apply it.
      await payments.deleteMany({ trx_id: { $in: reserved.map((m) => m.trxId) } }).catch(() => {});
      throw creditErr;
    }

    const fresh = await db.collection(AD_CAMPAIGNS_COLLECTION).findOne({ _id: id });
    const creative = await db.collection(AD_CREATIVES_COLLECTION).findOne({ campaignId: id });
    console.log(`[ad-campaigns] ${id} credited ${credited.toFixed(3)} HBD (total ${paidHbd}/${campaign.priceHbd})`);
    res.json({
      success: true,
      message: fullyPaid ? 'Payment received, flight scheduled' : 'Partial payment received',
      creditedHbd: credited,
      campaign: publicCampaign(fresh, creative),
    });
  } catch (err) {
    console.error('[ad-campaigns] claim failed:', err && err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
