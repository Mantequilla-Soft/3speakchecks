/**
 * Slot exclusivity: one campaign per position, per overlapping flight.
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
 * So the slot is now sold exclusively, which is what the copy already promised.
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
const { AD_SLOT_HOLD_HOURS, AD_SLOT_PERCENTS, AD_CAMPAIGNS_COLLECTION } = require('./config');
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
 * The campaign already holding `slotPercent` over this window, or null.
 *
 * Evaluated in JS rather than as a Mongo query on purpose: an unpaid campaign has no
 * `startAt` to match against, so the window has to be derived per candidate. The
 * candidate set is one position's live bookings, which is small.
 */
async function findSlotConflict(db, { slotPercent, start, end, excludeId = null, now = Date.now() }) {
  if (slotPercent === null || slotPercent === undefined) return null;   // unpositioned format

  const candidates = await db.collection(AD_CAMPAIGNS_COLLECTION).find({
    slotPercent,
    status: { $in: HOLDING },
  }).limit(200).toArray();

  const want = { start, end };
  for (const c of candidates) {
    if (excludeId && String(c._id) === String(excludeId)) continue;
    const win = effectiveWindow(c, now);
    if (overlaps(win, want)) {
      return {
        campaignId: c._id,
        format: formatOf(c).key,
        provisional: win.provisional,
        // When it frees up, so the refusal can say something useful instead of "no".
        freeFrom: new Date(win.end),
      };
    }
  }
  return null;
}

/**
 * Which positions are free for a window — what the booking form should offer.
 * Returns every slot with whether it is taken and, if so, when it comes back.
 */
async function slotAvailability(db, { start, end, excludeId = null, now = Date.now() }) {
  const out = [];
  for (const percent of AD_SLOT_PERCENTS) {
    const clash = await findSlotConflict(db, { slotPercent: percent, start, end, excludeId, now });
    out.push({
      percent,
      available: !clash,
      // Deliberately NOT the campaign or the advertiser: who else is running is not
      // something one advertiser gets to learn about another.
      freeFrom: clash ? clash.freeFrom : null,
      heldProvisionally: clash ? clash.provisional : false,
    });
  }
  return out;
}

module.exports = { effectiveWindow, findSlotConflict, slotAvailability, HOLDING };
