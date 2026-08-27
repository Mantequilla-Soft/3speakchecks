/**
 * Who a delivered impression owes, and when that debt becomes payable.
 *
 * Every other impression on the platform is payable the moment it completes: the ad
 * ran on someone's video, they supplied the inventory, done. The upload gate is not
 * like that. There is no inventory and no owner — the platform is buying a FINISHED
 * UPLOAD, and pays the creator who sat through the spot only once they actually
 * publish the video it gated.
 *
 * That is deliberately a conversion, not a reward for waiting. An upload started,
 * gated, and abandoned owes nothing. What we wanted was the video.
 *
 * THE STATES, and why there are three rather than a boolean:
 *
 *   pending   the spot was watched. Recorded, visible to the creator as "pending",
 *             and worth nothing yet. Every upload-gate impression starts here.
 *   settled   the gated upload was published, the hold below has elapsed, and the
 *             post is still there. Only this state is picked up by a payout run.
 *   void      it will never pay: either nothing was published before the deadline,
 *             or something was and then vanished inside the hold.
 *
 * WHY A HOLD RATHER THAN PAYING ON PUBLISH. A Hive post can be removed by its author
 * while it has no votes, so "published" is not yet a durable fact. Paying instantly
 * would buy a post that can be deleted the following minute, repeatedly, by the same
 * account. The hold costs an honest creator a short wait and costs a farmer the
 * entire strategy.
 *
 * WHY A PER-PERIOD CAP AS WELL. The hold stops publish-and-delete; it does not stop
 * someone uploading thirty real-but-worthless videos a day. The cap bounds the worst
 * case to something small and known, and is deliberately generous enough that no
 * genuine creator will ever reach it.
 *
 * ⚠️ THIS MODULE DECIDES ONLY. It holds no database calls on purpose: the same rules
 * have to be applied when an impression is written, when a publish is observed, and
 * when the sweeper re-checks the backlog, and three copies of "is this payable yet"
 * is exactly how a payout run and a creator's dashboard end up disagreeing.
 */
const {
  AD_GATE_CONVERSION_DAYS,
  AD_GATE_SETTLE_HOLD_HOURS,
  AD_GATE_MIN_VIDEO_SECONDS,
  AD_GATE_MAX_CREDITS_PER_PERIOD,
} = require('./config');
const { CREATOR_CREDIT, formatOf } = require('./adFormats');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const CREDIT_STATES = Object.freeze({
  PENDING: 'pending',
  SETTLED: 'settled',
  VOID: 'void',
});

/**
 * The credit fields to write onto a new impression.
 *
 * `owner` is the video's owner for the watch surfaces and is absent for the gate;
 * `viewer` is who was watching. Which of the two gets credited is the format's call,
 * never the caller's.
 */
function creditForImpression({ campaign, viewer, owner, gatedUploadId, now = Date.now() }) {
  const fmt = formatOf(campaign);

  if (fmt.creatorCredit === CREATOR_CREDIT.UPLOADER_ON_PUBLISH) {
    // No viewer means nobody to pay. An anonymous session cannot be credited, and
    // inventing an account to hold it would be worse than dropping the credit.
    if (!viewer) return { creditAccount: null, creditState: CREDIT_STATES.VOID, creditReason: 'no_viewer' };
    return {
      creditAccount: viewer,
      creditState: CREDIT_STATES.PENDING,
      creditReason: null,
      // The upload this spot gated. The credit converts on THIS video being
      // published, not on any later upload — otherwise one watched spot could be
      // redeemed against a video the creator was going to post anyway.
      gatedUploadId: gatedUploadId || null,
      creditDeadlineAt: new Date(now + AD_GATE_CONVERSION_DAYS * DAY_MS),
    };
  }

  if (fmt.creatorCredit === CREATOR_CREDIT.VIDEO_OWNER) {
    return owner
      ? { creditAccount: owner, creditState: CREDIT_STATES.SETTLED, creditReason: null }
      : { creditAccount: null, creditState: CREDIT_STATES.VOID, creditReason: 'no_owner' };
  }

  return { creditAccount: null, creditState: CREDIT_STATES.VOID, creditReason: 'format_pays_nobody' };
}

/**
 * A publish was observed for the upload this credit was waiting on. Returns the
 * fields to apply, or null when this impression is not waiting for one.
 *
 * Does NOT settle. It records that the clock can start; `resolvePending` decides.
 */
function onGatedUploadPublished({ impression, videoSeconds, now = Date.now() }) {
  if (!impression || impression.creditState !== CREDIT_STATES.PENDING) return null;

  // Too short to be the thing we were buying. Stated as its own void reason so a
  // creator asking "why was this not paid" gets an answer rather than silence.
  const secs = Number(videoSeconds);
  if (Number.isFinite(secs) && secs > 0 && secs < AD_GATE_MIN_VIDEO_SECONDS) {
    return { creditState: CREDIT_STATES.VOID, creditReason: 'video_too_short' };
  }
  return {
    publishedAt: new Date(now),
    settleAfterAt: new Date(now + AD_GATE_SETTLE_HOLD_HOURS * HOUR_MS),
  };
}

/**
 * What a pending credit should become right now. Pure — the caller supplies the
 * facts (did the post survive, how many have already settled this period) and this
 * says only what follows from them.
 *
 * @param stillPublished  false when the post has since been removed. `null` means we
 *                        could not check, which is NOT the same as gone: a failed RPC
 *                        must leave the credit pending, not void it. Voiding on an
 *                        unreachable node would quietly cancel real earnings during
 *                        an outage.
 */
function resolvePending({ impression, stillPublished = null, settledThisPeriod = 0, now = Date.now() }) {
  if (!impression || impression.creditState !== CREDIT_STATES.PENDING) return null;

  if (!impression.publishedAt) {
    const deadline = new Date(impression.creditDeadlineAt || 0).getTime();
    if (deadline && now >= deadline) {
      return { creditState: CREDIT_STATES.VOID, creditReason: 'not_published_in_time' };
    }
    return null;                                  // still inside its window
  }

  if (stillPublished === false) {
    return { creditState: CREDIT_STATES.VOID, creditReason: 'post_removed' };
  }
  if (stillPublished === null) return null;       // unknown → wait, never void

  const settleAt = new Date(impression.settleAfterAt || 0).getTime();
  if (!settleAt || now < settleAt) return null;   // hold has not elapsed

  if (settledThisPeriod >= AD_GATE_MAX_CREDITS_PER_PERIOD) {
    return { creditState: CREDIT_STATES.VOID, creditReason: 'period_cap_reached' };
  }
  return { creditState: CREDIT_STATES.SETTLED, creditReason: null, settledAt: new Date(now) };
}

/** Only settled credits are money. The one definition a payout run may use. */
function isPayable(impression) {
  return !!impression
    && impression.creditState === CREDIT_STATES.SETTLED
    && !!impression.creditAccount;
}

module.exports = {
  CREDIT_STATES,
  creditForImpression,
  onGatedUploadPublished,
  resolvePending,
  isPayable,
};
