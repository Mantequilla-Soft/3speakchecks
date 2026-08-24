/**
 * Shared shape for the ad platform's booking side: collections, indexes, states,
 * and the two derivations (price, campaign window) that must not be computed
 * differently in two places.
 *
 * A campaign moves: draft → awaiting_payment → scheduled → running → complete.
 * `cancelled` and `rejected` are terminal. Nothing serves except `running`, and a
 * campaign only becomes `running` once it has BOTH a paid balance and an encoded
 * creative — the two things that can independently be missing, so both are checked
 * in one place rather than assumed by whoever calls next.
 */
const {
  AD_CAMPAIGNS_COLLECTION, AD_CREATIVES_COLLECTION, AD_PAYMENTS_COLLECTION,
  AD_IMPRESSIONS_COLLECTION, AD_PAYOUTS_COLLECTION,
  AD_PRICE_PER_SECOND_DAY_HBD, AD_MIN_CAMPAIGN_DAYS, AD_MAX_CAMPAIGN_DAYS, AD_LENGTH_SECONDS,
} = require('./config');
const { getDb } = require('./db');
const { formatOf } = require('./adFormats');

const DAY_MS = 24 * 60 * 60 * 1000;

const STATES = Object.freeze({
  DRAFT: 'draft',
  AWAITING_PAYMENT: 'awaiting_payment',
  SCHEDULED: 'scheduled',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETE: 'complete',
  CANCELLED: 'cancelled',
});

/**
 * What kind of asset a creative is. Defined in utils/adCreativeKinds.js and
 * re-exported here, where it has always lived as far as callers are concerned.
 *
 * It no longer means what it used to. An image was once "an asset, never servable",
 * because the only product was a spot spliced into HLS and a still is not something
 * HLS can express. Now the banner format is made of exactly that, so what a creative
 * must BE is a property of the campaign's format — see utils/adFormats.js — and this
 * says only what a file is.
 */
const { CREATIVE_KINDS } = require('./adCreativeKinds');

const CREATIVE_STATES = Object.freeze({
  PENDING: 'pending',      // uploaded, still encoding
  READY: 'ready',          // encoded, playable, approved
  REVIEW: 'review',        // encoded, waiting for a human to look at it
  REJECTED: 'rejected',
});

let indexesEnsured = false;
async function ensureAdIndexes() {
  if (indexesEnsured) return;
  indexesEnsured = true;
  try {
    const db = getDb();
    const camps = db.collection(AD_CAMPAIGNS_COLLECTION);
    await camps.createIndex({ advertiserRef: 1, createdAt: -1 });
    await camps.createIndex({ hiveAccount: 1, status: 1 });
    // The serving query: everything eligible right now, cheapest possible.
    await camps.createIndex({ status: 1, startAt: 1, endAt: 1 });

    // Exactly-once payment crediting. The unique index IS the concurrency control —
    // a replayed claim inserting the same txid fails with a duplicate key instead
    // of racing a read-then-write into a double credit. Same trick promote.js uses.
    await db.collection(AD_PAYMENTS_COLLECTION).createIndex({ trx_id: 1 }, { unique: true });
    await db.collection(AD_PAYMENTS_COLLECTION).createIndex({ campaignId: 1 });

    await db.collection(AD_CREATIVES_COLLECTION).createIndex({ campaignId: 1 });
    await db.collection(AD_CREATIVES_COLLECTION).createIndex({ embedId: 1 }, { unique: true, sparse: true });

    const imps = db.collection(AD_IMPRESSIONS_COLLECTION);
    // One impression per CAMPAIGN per issued session — the same anti-double-count
    // property the payment index gives us, applied to delivery.
    //
    // It was unique on `sid` alone until formats arrived. A playback can now carry a
    // roll AND a banner from two different campaigns, and under the old index the
    // second one silently lost its impression to a duplicate-key error: the ad ran
    // and nobody was billed or paid for it. The pair is the real identity of a
    // delivery, and every "count it once" guard downstream still holds, because a
    // replayed segment fetch is still the same (sid, campaignId).
    try {
      const old = await imps.indexes();
      if (old.some((ix) => ix.name === 'sid_1' && ix.unique)) await imps.dropIndex('sid_1');
    } catch (_) { /* not there, or already replaced */ }
    await imps.createIndex({ sid: 1, campaignId: 1 }, { unique: true });
    await imps.createIndex({ sid: 1 });
    await imps.createIndex({ campaignId: 1, at: -1 });
    await imps.createIndex({ owner: 1, permlink: 1, at: -1 });   // per-creator payout
    await imps.createIndex({ payoutId: 1 });

    await db.collection(AD_PAYOUTS_COLLECTION).createIndex({ periodKey: 1, account: 1 }, { unique: true });
    await db.collection(AD_PAYOUTS_COLLECTION).createIndex({ status: 1 });
  } catch (err) {
    indexesEnsured = false;
    console.error('[ad-model] index ensure failed:', err && err.message);
  }
}

/**
 * The daily rate this advertiser is on.
 *
 * `pricePerDayHbd` is set per advertiser from the admin console, so a rate can be
 * negotiated without moving the platform default for everyone. Anything missing,
 * unparseable or not above zero falls back to the platform rate rather than
 * producing a free flight — a typo in an admin field must not become a booking
 * worth nothing.
 */
function ratePerDayFor(advertiser) {
  // `pricePerSecondDayHbd` is the field the admin console sets. The older
  // `pricePerDayHbd` is still read so nothing that was already stored under it is
  // silently ignored — but it meant HBD per day flat, not per second per day, so
  // anything found there is a value from before the change and should be reset.
  const rate = Number(
    advertiser && (advertiser.pricePerSecondDayHbd ?? advertiser.pricePerDayHbd),
  );
  return Number.isFinite(rate) && rate > 0 ? rate : AD_PRICE_PER_SECOND_DAY_HBD;
}

/**
 * Price for a flight, in HBD. One definition — quote and claim must agree.
 *
 * `ratePerDay` is the advertiser's own rate when they have one. It is passed in
 * rather than looked up here so this stays a pure function of its arguments, which
 * is what lets the quote shown on the page and the price written on the campaign be
 * computed from the same code without either of them touching the database.
 */
function priceForDays(days, ratePerSecondDay, spotSeconds) {
  const rate = Number(ratePerSecondDay);
  const perSecondDay = Number.isFinite(rate) && rate > 0 ? rate : AD_PRICE_PER_SECOND_DAY_HBD;
  // A missing or nonsensical length falls back to the full slot rather than to
  // zero: a bad number must never hand somebody a free flight.
  const seconds = Number(spotSeconds);
  const secs = Number.isFinite(seconds) && seconds > 0 ? seconds : AD_LENGTH_SECONDS;
  return Math.round(days * perSecondDay * secs * 1000) / 1000;
}

function validDayCount(days) {
  return Number.isInteger(days) && days >= AD_MIN_CAMPAIGN_DAYS && days <= AD_MAX_CAMPAIGN_DAYS;
}

/**
 * When a paid campaign actually runs. Deliberately NOT set at booking time: a
 * campaign that is paid late should not have already burned half its flight, so
 * the clock starts when the money lands (or at the requested start, whichever is
 * later) rather than when the form was filled in.
 */
function windowFrom(startAt, days) {
  const begins = Math.max(Date.now(), new Date(startAt || 0).getTime() || 0);
  return { startAt: new Date(begins), endAt: new Date(begins + days * DAY_MS) };
}

/**
 * Where a break actually lands, in seconds, for a video of `totalSeconds`.
 *
 * Slots are booked as a percentage of the video. `slotPercent` is the field that
 * says so, and it is deliberately NOT the old `slotPosition`: that one holds
 * absolute seconds, and reusing it would have silently reinterpreted every campaign
 * booked before the change — a flight sold as "30 seconds in" would have jumped to
 * 30% of the way through. Campaigns carrying only `slotPosition` are read as the
 * seconds they were sold as, for as long as any of them are still running.
 */
function slotSecondsFor(slot, totalSeconds) {
  const pct = Number(slot && slot.slotPercent);
  if (Number.isFinite(pct) && pct >= 0) {
    const total = Number(totalSeconds);
    if (!Number.isFinite(total) || total <= 0) return 0;
    return Math.max(0, Math.round((total * pct) / 100));
  }
  return Math.max(0, Number(slot && slot.slotPosition) || 0);
}

/**
 * The asset a creative must carry before it can be approved or served, by KIND.
 *
 * Deliberately keyed on the creative's own kind rather than on a campaign's format:
 * a spot can be uploaded and reviewed BEFORE any flight exists, so at review time
 * there is often no campaign to ask. A reviewer is approving an asset, not a
 * placement.
 *
 * Shared so the review gate and the serving gate cannot drift. They did: the gate
 * refused anything without `manifestUrl`, which an image never has, so a banner
 * creative could be uploaded, queued, and then never approved — "that spot has not
 * finished encoding yet" about a still that was never going to encode.
 */
function missingAssetFor(creative) {
  if (!creative) return 'no_creative';
  if (creative.kind === CREATIVE_KINDS.IMAGE) {
    return creative.imageUrl ? null : 'creative_has_no_image';
  }
  return creative.manifestUrl ? null : 'creative_not_encoded';
}

/**
 * Is this campaign servable right now? Returns a reason when not, because "why is
 * my campaign not running" is the question an advertiser asks, and deriving the
 * answer twice in two places is how the console ends up disagreeing with reality.
 */
function servableReason(campaign, creative, now = Date.now()) {
  if (!campaign) return 'no_campaign';
  if (campaign.status === STATES.PAUSED) return 'paused';
  if (campaign.status === STATES.CANCELLED) return 'cancelled';
  if (campaign.status === STATES.COMPLETE) return 'complete';
  if (campaign.status === STATES.DRAFT) return 'not_submitted';
  if (!campaign.paidHbd || campaign.paidHbd <= 0) return 'unpaid';
  if (!creative) return 'no_creative';

  // The creative has to be the kind this campaign's format is made of. A still
  // cannot be spliced into an HLS break, and a video is not what gets composited
  // into a frame as a banner — so this is one check against the format's own
  // requirement rather than a standing rule that images never serve.
  const fmt = formatOf(campaign);
  // Default a missing `kind` to video, exactly as publicCreative() does. Without
  // it the two disagree: the advertiser's console calls a legacy row a video while
  // serving refuses it as the wrong kind, and nothing on either screen says why.
  const creativeKind = creative.kind || CREATIVE_KINDS.VIDEO;
  if (creativeKind !== fmt.creativeKind) {
    return creativeKind === CREATIVE_KINDS.IMAGE ? 'creative_is_an_image' : 'creative_is_a_video';
  }
  if (creative.status !== CREATIVE_STATES.READY) return `creative_${creative.status}`;
  // A video spot is only servable once encoded; a still is servable as uploaded.
  const missing = missingAssetFor(creative);
  if (missing) return missing;
  if (campaign.startAt && now < new Date(campaign.startAt).getTime()) return 'not_started';
  if (campaign.endAt && now >= new Date(campaign.endAt).getTime()) return 'ended';
  return null;
}

module.exports = {
  STATES, CREATIVE_STATES, CREATIVE_KINDS, DAY_MS,
  ensureAdIndexes, priceForDays, ratePerDayFor, validDayCount, windowFrom, servableReason,
  missingAssetFor,
  slotSecondsFor,
};
