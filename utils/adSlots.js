/**
 * Slot capacity: up to AD_SLOT_MAX_SHARES campaigns per position, per overlapping
 * flight — and why that number can be greater than one now when it could not be.
 *
 * The rate card has always said a booking "buys the slot across the network for the
 * whole flight". The serving side did not enforce that — two campaigns on the same
 * percent simply rotated, each taking about half the plays. Nobody saw two ads at
 * one mark, so it looked fine, but each advertiser had been QUOTED the whole slot:
 * `forecastPerDay()` reads the inventory for that percent and knows nothing about who
 * else holds it. Measured on live numbers, two campaigns on the 10% slot were each
 * promised 2322 impressions, each delivered about 1161, and `closeFinishedCampaigns`
 * then owed BOTH of them half their money back. We sold the same thing twice and
 * refunded half of each.
 *
 * The bug was never the ROTATION — serving two campaigns from one position works and
 * always did. It was the PROMISE: `forecastPerDay()` reads the inventory for a
 * percent and knows nothing about who else holds it, so every co-holder was quoted
 * the whole slot and the refund logic then honoured that quote.
 *
 * Selling it exclusively was the fix available at the time. The real fix is to quote
 * each flight its SHARE, which is what booking now does — so a position carries up to
 * AD_SLOT_MAX_SHARES advertisers, each forecast what rotation will actually give
 * them, and nobody is refunded for a shortfall we invented at booking time.
 *
 * 🚨 The two must move together. Raising AD_SLOT_MAX_SHARES without the holder-aware
 * forecast brings the double-selling straight back.
 *
 * 🚨 EXCLUSIVE ACROSS FORMATS, not per format. A roll and a banner at the same mark
 * do not overlap on screen — the break replaces the timeline, the banner is painted
 * on the content after it — but they land back to back, which reads to a viewer as
 * one long ad moment. A position is a position: if anything holds it, it is not for
 * sale. The two formats can still share a playback, just never the same mark.
 *
 * THE HOLD, and why an unpaid campaign still reserves.
 * `startAt`/`endAt` are deliberately null until payment lands — a flight paid late
 * should not have already burned half its window. That leaves a gap: between booking
 * and paying, a campaign has no window at all, so a second advertiser could book the
 * same slot and both could then pay for it. One of them would have to be refunded a
 * flight they had every reason to think they owned.
 *
 * So an unpaid campaign holds its slot provisionally, on the window it WOULD get,
 * for AD_SLOT_HOLD_HOURS. After that the hold lapses and the slot is free again —
 * otherwise an abandoned booking would take a position off the market forever.
 */
const { AD_SLOT_HOLD_HOURS, AD_SLOT_PERCENTS, AD_CAMPAIGNS_COLLECTION, ADVERTISERS_COLLECTION,
  AD_SLOT_MAX_SHARES,
} = require('./config');
const { STATES, DAY_MS } = require('./adModel');
const { formatOf } = require('./adFormats');

const HOUR_MS = 60 * 60 * 1000;

/** Statuses that still hold a slot. Anything terminal has released it. */
const HOLDING = [STATES.DRAFT, STATES.AWAITING_PAYMENT, STATES.SCHEDULED, STATES.RUNNING, STATES.PAUSED];

/**
 * The window a campaign occupies, or null when it occupies none.
 *
 * A paid campaign has a real one. An unpaid campaign gets the window it would be
 * given if it paid right now — `windowFrom()` starts the clock at the later of "now"
 * and the requested start, so the provisional window is computed the same way rather
 * than guessed at.
 */
function effectiveWindow(campaign, now = Date.now()) {
  if (!campaign) return null;
  if (!HOLDING.includes(campaign.status)) return null;

  const days = Number(campaign.days) || 0;
  if (campaign.startAt && campaign.endAt) {
    return { start: new Date(campaign.startAt).getTime(), end: new Date(campaign.endAt).getTime(), provisional: false };
  }
  if (!days) return null;

  // Unpaid: a provisional hold that lapses, so an abandoned booking cannot take a
  // position off the market for good.
  const bookedAt = new Date(campaign.createdAt || 0).getTime();
  if (!bookedAt || now > bookedAt + AD_SLOT_HOLD_HOURS * HOUR_MS) return null;

  const requested = new Date(campaign.requestedStartAt || 0).getTime() || 0;
  const start = Math.max(now, requested);
  return { start, end: start + days * DAY_MS, provisional: true };
}

const overlaps = (a, b) => !!a && !!b && a.start < b.end && b.start < a.end;

/**
 * How many campaigns already hold `slotPercent` over this window, and when the next
 * share frees up.
 *
 * Evaluated in JS rather than as a Mongo query on purpose: an unpaid campaign has no
 * `startAt` to match against, so the window has to be derived per candidate. The
 * candidate set is one position's live bookings, which is small.
 *
 * Returns a COUNT, never who. Who else is running at a position is not something one
 * advertiser gets to learn about another — the count is only here because the quote
 * has to be divided by it.
 */
async function slotHolders(db, {
  slotPercent, start, end, excludeId = null, now = Date.now(), format = null,
}) {
  if (slotPercent === null || slotPercent === undefined) return { holders: 0, freeFrom: null };

  const candidates = await db.collection(AD_CAMPAIGNS_COLLECTION).find({
    slotPercent,
    status: { $in: HOLDING },
  }).limit(200).toArray();

  // A provisional hold only counts if the advertiser behind it has been APPROVED.
  // Anyone can now fill in the whole form and be reviewed afterwards, so without
  // this a stranger could reserve the entire rate card by booking five slots they
  // will never pay for. A hold is earned by approval, not by submitting a form.
  const provisionalRefs = [...new Set(candidates
    .filter((c) => effectiveWindow(c, now).provisional)
    .map((c) => c.advertiserRef)
    .filter(Boolean))];
  const approvedRefs = provisionalRefs.length
    ? new Set((await db.collection(ADVERTISERS_COLLECTION)
      .find({ reference: { $in: provisionalRefs }, status: 'approved' }, { projection: { reference: 1 } })
      .toArray()).map((a) => a.reference))
    : new Set();

  const want = { start, end };
  let holders = 0;
  let freeFrom = null;
  for (const c of candidates) {
    if (excludeId && String(c._id) === String(excludeId)) continue;
    // Formats are different surfaces that never compete for the same moment: a
    // banner at 25% does not consume the roll at 25%. Comparing them was blocking
    // half the rate card for no reason.
    if (format && formatOf(c).key !== format) continue;
    const win = effectiveWindow(c, now);
    if (win.provisional && !approvedRefs.has(c.advertiserRef)) continue;
    if (!overlaps(win, want)) continue;
    holders += 1;
    // The EARLIEST end is when a share comes back, which is the useful answer for a
    // full position — not the latest.
    if (freeFrom === null || win.end < freeFrom) freeFrom = win.end;
  }
  return { holders, freeFrom: freeFrom === null ? null : new Date(freeFrom) };
}

/**
 * Is this position FULL over the window? Null when there is still a share going.
 *
 * Kept as the booking-time guard it always was; what changed is the threshold —
 * AD_SLOT_MAX_SHARES instead of the first holder.
 */
async function findSlotConflict(db, opts) {
  const { holders, freeFrom } = await slotHolders(db, opts);
  if (holders < AD_SLOT_MAX_SHARES) return null;
  return { holders, maxShares: AD_SLOT_MAX_SHARES, freeFrom };
}

/**
 * Which positions can still be booked for a window — what the booking form offers.
 * Reports how many shares are gone so the form can say what a flight would be
 * joining, and so the quote can be divided by it.
 */
async function slotAvailability(db, { start, end, excludeId = null, now = Date.now(), format = null }) {
  const out = [];
  for (const percent of AD_SLOT_PERCENTS) {
    const { holders, freeFrom } = await slotHolders(db, { slotPercent: percent, start, end, excludeId, now, format });
    const full = holders >= AD_SLOT_MAX_SHARES;
    out.push({
      percent,
      available: !full,
      sharesTaken: holders,
      sharesTotal: AD_SLOT_MAX_SHARES,
      sharesLeft: Math.max(0, AD_SLOT_MAX_SHARES - holders),
      // Deliberately NOT the campaign or the advertiser: who else is running is not
      // something one advertiser gets to learn about another.
      freeFrom: full ? freeFrom : null,
      heldProvisionally: false,
    });
  }
  return out;
}

module.exports = { effectiveWindow, slotHolders, findSlotConflict, slotAvailability, HOLDING };
