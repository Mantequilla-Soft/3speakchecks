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
const { hiveRpcBatch } = require('../utils/hive');
const {
  ADVERTISERS_COLLECTION, AD_CAMPAIGNS_COLLECTION, AD_CREATIVES_COLLECTION,
  AD_PAYMENTS_COLLECTION, AD_PAYMENT_ACCOUNT, AD_PRICE_PER_DAY_HBD,
  AD_MIN_CAMPAIGN_DAYS, AD_MAX_CAMPAIGN_DAYS, AD_SLOT_POSITIONS, AD_LENGTH_SECONDS,
  AD_PRODUCTION_FEE_HBD, ADS_STAGE,
} = require('../utils/config');
const {
  STATES, CREATIVE_STATES, CREATIVE_KINDS, ensureAdIndexes, priceForDays, validDayCount,
  windowFrom, servableReason,
} = require('../utils/adModel');
const { getSnapshot } = require('../services/adInventory');

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

/** The advertiser behind a reference, or null. Approved only — the gate is here. */
async function approvedAdvertiser(reference) {
  if (!reference) return null;
  const doc = await getDb().collection(ADVERTISERS_COLLECTION)
    .findOne({ reference, status: 'approved' });
  return doc || null;
}

/** What an advertiser sees about one of their spots. */
function publicCreative(cr) {
  if (!cr) return null;
  return {
    embedId: cr.embedId,
    kind: cr.kind || CREATIVE_KINDS.VIDEO,
    imageUrl: cr.imageUrl || null,
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
    status: c.status,
    slotPosition: c.slotPosition,
    days: c.days,
    priceHbd: c.priceHbd,
    flightHbd: c.flightHbd ?? c.priceHbd,
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
    res.set('Cache-Control', 'public, max-age=300');
    res.json({
      success: true,
      payTo: AD_PAYMENT_ACCOUNT,
      pricePerDayHbd: AD_PRICE_PER_DAY_HBD,
      minDays: AD_MIN_CAMPAIGN_DAYS,
      maxDays: AD_MAX_CAMPAIGN_DAYS,
      slotPositions: AD_SLOT_POSITIONS,
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

/* ─── POST /advertise/campaigns ───────────────────────────────────────── */
router.post('/campaigns', featureVisible, express.json({ limit: '32kb' }), async (req, res) => {
  try {
    await ensureAdIndexes();
    const b = req.body || {};
    const advertiser = await approvedAdvertiser(str(b.reference, 64));
    if (!advertiser) {
      return res.status(403).json({ success: false, error: 'No approved advertiser for that reference' });
    }

    const name = str(b.name, 120) || `${advertiser.projectName} campaign`;
    const days = Number(b.days);
    if (!validDayCount(days)) {
      return res.status(400).json({
        success: false,
        error: `days must be a whole number between ${AD_MIN_CAMPAIGN_DAYS} and ${AD_MAX_CAMPAIGN_DAYS}`,
      });
    }
    const slotPosition = Number(b.slotPosition);
    if (!AD_SLOT_POSITIONS.includes(slotPosition)) {
      return res.status(400).json({ success: false, error: `slotPosition must be one of: ${AD_SLOT_POSITIONS.join(', ')}` });
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

    const flightHbd = priceForDays(days);
    const priceHbd = Math.round((flightHbd + productionFeeHbd) * 1000) / 1000;

    // What the inventory says this slot should deliver over the flight. Recorded at
    // BOOKING time on purpose: it is the number the advertiser was shown, so it is
    // the number a refund for under-delivery has to be measured against. Reading it
    // at settlement instead would let a later change in traffic quietly rewrite what
    // we had promised.
    let forecastImpressions = null;
    try {
      const snap = await getSnapshot();
      const slot = snap?.slots?.find((x) => x.position === slotPosition);
      if (slot && Number.isFinite(slot.perDay)) forecastImpressions = Math.round(slot.perDay * days);
    } catch (_) { /* no forecast on record — closeFinishedCampaigns flags it for a human */ }

    const doc = {
      advertiserRef: advertiser.reference,
      hiveAccount: advertiser.hiveAccount,
      projectName: advertiser.projectName,
      name,
      status: STATES.AWAITING_PAYMENT,
      slotPosition,
      days,
      markets,
      priceHbd,
      flightHbd,
      productionFeeHbd,
      productionRequested,
      productionBrief: productionRequested ? productionBrief : null,
      productionStatus: productionRequested ? 'requested' : null,
      paidHbd: 0,
      requestedStartAt: b.startAt ? new Date(b.startAt) : null,
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
    const advertiser = await approvedAdvertiser(str(req.query.reference, 64));
    if (!advertiser) {
      return res.status(403).json({ success: false, error: 'No approved advertiser for that reference' });
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
    const advertiser = await approvedAdvertiser(str(b.reference, 64));
    if (!advertiser) return res.status(403).json({ success: false, error: 'No approved advertiser for that reference' });

    const id = oid(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: 'Invalid campaign id' });

    const db = getDb();
    const campaign = await db.collection(AD_CAMPAIGNS_COLLECTION)
      .findOne({ _id: id, advertiserRef: advertiser.reference });
    if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });

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

    const durationSeconds = Math.round(Number(embed.duration) || 0);
    if (durationSeconds > 0 && durationSeconds > AD_LENGTH_SECONDS) {
      return res.status(400).json({
        success: false,
        error: `The spot is ${durationSeconds}s. The slot is ${AD_LENGTH_SECONDS}s.`,
      });
    }

    const encoded = !!embed.manifest_cid;
    const manifestUrl = encoded ? `${CDN}/${embed.manifest_cid}/manifest.m3u8` : null;

    const creative = {
      campaignId: id,
      advertiserRef: advertiser.reference,
      embedId: String(embed._id),
      owner: embed.owner || null,
      durationSeconds,
      manifestUrl,
      // Encoding first, then a human. Never straight to READY: we are about to put
      // this in front of other people's audiences.
      status: encoded ? CREATIVE_STATES.REVIEW : CREATIVE_STATES.PENDING,
      reviewNote: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await db.collection(AD_CREATIVES_COLLECTION).updateOne(
      { campaignId: id },
      { $set: creative },
      { upsert: true },
    );

    const fresh = await db.collection(AD_CAMPAIGNS_COLLECTION).findOne({ _id: id });
    res.json({ success: true, campaign: publicCampaign(fresh, creative) });
  } catch (err) {
    console.error('[ad-campaigns] creative failed:', err && err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/* ─── creatives, independent of any campaign ──────────────────────────── */
// A spot can be uploaded and reviewed BEFORE a flight is booked — which is the
// order things actually happen in: an advertiser wants to know we will run their
// creative before they send money for it. The upload itself goes through the normal
// embed pipeline with `frontend_app: '3speak-ads'`, which leaves it unlisted and
// with no Hive post, so a spot never appears in feeds or collects post rewards.
router.post('/creatives', featureVisible, express.json({ limit: '16kb' }), async (req, res) => {
  try {
    await ensureAdIndexes();
    const b = req.body || {};
    const advertiser = await approvedAdvertiser(str(b.reference, 64));
    if (!advertiser) return res.status(403).json({ success: false, error: 'No approved advertiser for that reference' });

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
      await db.collection(AD_CREATIVES_COLLECTION).updateOne(
        { embedId: key },
        {
          $set: {
            advertiserRef: advertiser.reference,
            kind: CREATIVE_KINDS.IMAGE,
            imageUrl,
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
    const advertiser = await approvedAdvertiser(str(req.query.reference, 64));
    if (!advertiser) return res.status(403).json({ success: false, error: 'No approved advertiser for that reference' });
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
