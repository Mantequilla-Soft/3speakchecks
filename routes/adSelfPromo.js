/**
 * Self-promotion: a creator runs their OWN published video as an ad spot.
 *
 * The rest of the platform sells to projects who upload a purpose-made spot. This
 * sells to the creator already standing on the page, with the thing they already
 * made. Everything downstream is the same machinery — same campaign document, same
 * on-chain claim, same stitcher, same payout pool — so this file is an ENTRANCE,
 * not a second ad system. It differs from routes/adCampaigns.js in exactly three
 * places, and each one is a rule that exists for a reason that does not apply here:
 *
 *   1. The creative is a PUBLISHED video. /campaigns/:id/creative refuses one,
 *      because a spot that is also somebody's post would sit in feeds and earn as
 *      content. Here that is the entire point: the ad IS the post, and the creator
 *      is advertising it to be watched.
 *   2. The creative is LONGER than the slot. A normal spot must fit the break it
 *      bought. A ten-minute video obviously does not, so the booked seconds become
 *      a trim: the spot is the opening `spotSeconds` of the video, cut at the
 *      nearest segment boundary by the stitcher (see trimToSeconds in adServe).
 *   3. The advertiser record is created and approved WITHOUT a human. It carries no
 *      claim to review: the product is their own channel, the name is their own
 *      display name and the logo is their own avatar. The thing a person still
 *      approves is the CREATIVE, which is where the editorial decision actually is,
 *      and it lands in the same review queue as every other spot.
 *
 * Routes:
 *   GET  /advertise/selfpromo/options   can this video run, as what, at what price
 *   POST /advertise/selfpromo/book      create the flight + attach the creative
 *
 * Payment is NOT here: the flight is claimed through the existing
 * POST /advertise/campaigns/:id/claim with the reference this returns, so there is
 * one implementation of "prove the transfer happened, exactly once".
 */
const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');
const { hiveRpcBatch } = require('../utils/hive');
const {
  ADVERTISERS_COLLECTION, AD_CAMPAIGNS_COLLECTION, AD_CREATIVES_COLLECTION,
  AD_PAYMENT_ACCOUNT, AD_MIN_CAMPAIGN_DAYS, AD_MAX_CAMPAIGN_DAYS, AD_SLOT_PERCENTS,
  ADS_STAGE, AD_SELFPROMO_ENABLED, AD_SELFPROMO_ALLOWED_OWNERS, AD_SELFPROMO_SLOGAN,
  AD_SELFPROMO_RATE_HBD,
} = require('../utils/config');
const {
  STATES, CREATIVE_STATES, CREATIVE_KINDS, ensureAdIndexes, priceForDays, validDayCount, windowFrom,
} = require('../utils/adModel');
const {
  formatOf, rateFor, snapshotRates, creativeSpecError,
} = require('../utils/adFormats');
const { slotAvailability } = require('../utils/adSlots');
const { manifestUrlFor } = require('../utils/adGateways');
const { videoShapeFromManifest } = require('../utils/videoDuration');

/**
 * HBD per HIVE from the on-chain median feed — the same valuation the claim uses, so
 * the amount the wizard asks for is the amount that gets credited. Never a
 * client-supplied rate. A feed we cannot read returns 0, and the wizard then offers
 * HBD only rather than quoting a HIVE price we cannot stand behind.
 */
async function getHbdPerHive() {
  try {
    const [res] = await hiveRpcBatch([{
      jsonrpc: '2.0', method: 'condenser_api.get_current_median_history_price', params: [], id: 1,
    }]);
    const base = parseFloat(res?.result?.base);
    const quote = parseFloat(res?.result?.quote);
    if (!base || !quote) return 0;
    return base / quote;
  } catch (_) {
    return 0;
  }
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * What this flight costs per second of spot, per day.
 *
 * The self-promo rate wins over the advertiser's stored rate card, because that card
 * is a COPY of the platform prices taken at registration and this product is not
 * sold at platform prices. Falls back to the ordinary rate for the format when the
 * self-promo rate is set to 0, which is how self-promotion gets put on normal
 * pricing later without touching a single stored record.
 *
 * Used by the quote AND the booking. A price shown one way and charged another is
 * exactly the bug one shared resolver exists to prevent.
 */
function selfPromoRate(advertiser, formatKey) {
  if (AD_SELFPROMO_RATE_HBD > 0) return AD_SELFPROMO_RATE_HBD;
  return rateFor(advertiser, formatKey);
}
const account = (v) => str(v, 32).toLowerCase().replace(/^@/, '');
const HIVE_ACCOUNT_RE = /^[a-z][a-z0-9.-]{2,15}$/;

function featureVisible(req, res, next) {
  if (ADS_STAGE === 'off') return res.status(404).json({ success: false, error: 'Not found' });
  if (!AD_SELFPROMO_ENABLED) return res.status(404).json({ success: false, error: 'Not found' });
  return next();
}

/**
 * The video, from either name it is known by.
 *
 * A watch page holds the HIVE author/permlink; the shorts page holds the ASSET id
 * and often the hive permlink too. Both are sent as `owner`/`permlink` by clients
 * that do not know which one they are holding, so both are tried rather than
 * requiring the caller to know something we can look up.
 */
async function findVideo(db, owner, permlink) {
  const coll = db.collection('embed-video');
  return (await coll.findOne({ owner, permlink }))
    || (await coll.findOne({ hive_author: owner, hive_permlink: permlink }))
    || null;
}

/**
 * Why this video cannot be run as an ad, or null when it can.
 *
 * Every branch names the thing the creator can act on. "Not eligible" with no
 * reason is the single most useless answer a screen like this can give.
 */
function ineligibleReason(video, acct) {
  if (!video) return 'We could not find that video.';
  if (video.status !== 'published') return 'That video is still processing. Try again once it is published.';
  // The uploader OR the Hive author: an embed uploaded by one account and posted by
  // another is rare but real, and either of them is honestly "their" video.
  const mine = [video.owner, video.hive_author].filter(Boolean).map((x) => String(x).toLowerCase());
  if (!mine.includes(acct)) return 'You can only promote your own video.';
  if (!video.hive_permlink) {
    return 'That video has no Hive post yet, so there is nothing for viewers to click through to.';
  }
  /* The stitcher needs a manifest to cut segments out of. An unencoded video has
   * none, and would book a flight that could never serve.
   *
   * This is the FIRST thing somebody hits from the upload success screen, where the
   * video is seconds old and encoding has not finished, so the message says what to
   * do rather than only what is wrong. */
  if (!video.manifest_cid) {
    return 'This video is still encoding. You can run it as an ad once that finishes, from the video itself or your channel.';
  }
  return null;
}

/** Which products this particular video can be sold as. */
function formatsFor(video) {
  const out = ['video_roll'];
  // A shorts spot is full-screen portrait and plays in the shorts feed, so only a
  // short can be one. A short can ALSO run as a roll inside a long video, which is
  // why this is additive rather than a switch.
  if (video.short === true) out.unshift('shorts_roll');
  return out;
}

/* ─── GET /advertise/selfpromo/options ────────────────────────────────── */
router.get('/selfpromo/options', featureVisible, async (req, res) => {
  try {
    const acct = account(req.query.account);
    const owner = account(req.query.owner);
    const permlink = str(req.query.permlink, 64);
    if (!HIVE_ACCOUNT_RE.test(acct)) {
      return res.status(400).json({ success: false, error: 'A valid Hive account is required' });
    }
    if (!owner || !permlink) {
      return res.status(400).json({ success: false, error: 'owner and permlink are required' });
    }

    const db = getDb();
    const video = await findVideo(db, owner, permlink);
    const why = ineligibleReason(video, acct);
    if (why) return res.json({ success: true, eligible: false, reason: why });

    // Their own rates if they have booked before, today's platform rates if not —
    // the same rule /advertise/apply follows, so a creator who self-promotes twice
    // is not quietly repriced between bookings.
    const advertiser = await db.collection(ADVERTISERS_COLLECTION).findOne(
      { hiveAccount: acct, selfPromo: true, status: { $ne: 'rejected' } },
      { sort: { createdAt: -1 } },
    );

    const durationSeconds = Math.round(Number(video.duration) || 0);
    const formats = formatsFor(video).map((key) => {
      const fmt = formatOf({ format: key });
      return {
        key,
        label: fmt.label,
        ratePerSecondDayHbd: selfPromoRate(advertiser, key),
        // Never longer than the video itself: you cannot show fifteen seconds of a
        // ten-second short, and a booking that quotes for time the media does not
        // have is a booking that overcharges.
        maxSeconds: durationSeconds > 0 ? Math.min(fmt.maxSeconds, durationSeconds) : fmt.maxSeconds,
        surface: fmt.surface,
      };
    });

    const hbdPerHive = await getHbdPerHive();

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      eligible: true,
      payTo: AD_PAYMENT_ACCOUNT,
      hbdPerHive: hbdPerHive || null,
      // What will be printed under their name on the ad disclosure overlay, so the
      // wizard can show it rather than hardcoding a second copy of the same string.
      slogan: AD_SELFPROMO_SLOGAN,
      minDays: AD_MIN_CAMPAIGN_DAYS,
      maxDays: AD_MAX_CAMPAIGN_DAYS,
      formats,
      video: {
        owner: video.owner,
        permlink: video.permlink,
        hiveAuthor: video.hive_author || video.owner,
        hivePermlink: video.hive_permlink,
        title: video.hive_title || video.embed_title || '',
        durationSeconds,
        isShort: video.short === true,
        thumbnailUrl: video.thumbnail_url || null,
      },
      // Where these ads can currently be SEEN. Empty means everywhere. Surfaced so
      // the wizard can say it out loud rather than letting somebody pay for a flight
      // and wonder why they never see it.
      limitedToOwners: AD_SELFPROMO_ALLOWED_OWNERS,
    });
  } catch (err) {
    console.error('[selfpromo] options failed:', err && err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * The advertiser record standing for this creator's channel, created on first use.
 *
 * Auto-approved on purpose — see the header. It is their own identity, and the
 * review that matters happens on the creative. `selfPromo` is what keeps these
 * apart from real applications everywhere else: the admin queue, the rate console
 * and the serving gate all key off it.
 */
async function ensureSelfPromoAdvertiser(db, acct, profile) {
  const coll = db.collection(ADVERTISERS_COLLECTION);
  const existing = await coll.findOne({ hiveAccount: acct, selfPromo: true, status: { $ne: 'rejected' } });
  if (existing) {
    // Their display name and avatar are the product's name and logo, and both can
    // change on Hive after we first copied them. Refreshed on every booking so the
    // disclosure overlay does not keep showing a picture they replaced a year ago.
    const set = { updatedAt: new Date() };
    if (profile.displayName && profile.displayName !== existing.projectName) set.projectName = profile.displayName;
    if (profile.avatarUrl && profile.avatarUrl !== existing.logoUrl) set.logoUrl = profile.avatarUrl;
    // Same reason the name and avatar are refreshed: a record created before the
    // self-promo rate existed still carries a platform price this account is not
    // charged, and a console showing a number nobody pays is worse than no number.
    if (AD_SELFPROMO_RATE_HBD > 0
      && (existing.rates?.video_roll !== AD_SELFPROMO_RATE_HBD
        || existing.rates?.shorts_roll !== AD_SELFPROMO_RATE_HBD)) {
      set.rates = { ...(existing.rates || {}), video_roll: AD_SELFPROMO_RATE_HBD, shorts_roll: AD_SELFPROMO_RATE_HBD };
      set.ratesSetAt = new Date();
    }
    if (Object.keys(set).length > 1) await coll.updateOne({ _id: existing._id }, { $set: set });
    return { ...existing, ...set };
  }

  // A sibling is any earlier application from the same account, self-promo or not.
  // Reusing its rate copy is the rule from /advertise/apply: one account, one price
  // list, however many products they hold.
  const sibling = await coll.findOne(
    { hiveAccount: acct, status: { $ne: 'rejected' }, rates: { $type: 'object' } },
    { sort: { ratesSetAt: -1, createdAt: -1 }, projection: { rates: 1 } },
  );

  const now = new Date();
  const doc = {
    reference: `sp-${acct}-${Math.random().toString(36).slice(2, 10)}`,
    hiveAccount: acct,
    selfPromo: true,
    projectName: profile.displayName || `@${acct}`,
    slogan: AD_SELFPROMO_SLOGAN,
    logoUrl: profile.avatarUrl || null,
    website: `https://3speak.tv/@${acct}`,
    category: 'other',
    contact: `@${acct} on Hive`,
    creativeConcept: 'Creator promoting their own 3Speak video.',
    status: 'approved',
    approvedAt: now,
    approvedBy: 'self-promo',
    /* Their stored card. Starts from the platform snapshot (or a sibling
     * application's, the rule /advertise/apply follows) and then has the self-promo
     * rate written over the formats this product is actually sold in, so the admin
     * console and `below-rate` show what is really being charged rather than a
     * platform price this account never pays. */
    rates: (() => {
      const base = sibling ? { ...sibling.rates } : snapshotRates();
      if (AD_SELFPROMO_RATE_HBD > 0) {
        base.video_roll = AD_SELFPROMO_RATE_HBD;
        base.shorts_roll = AD_SELFPROMO_RATE_HBD;
      }
      return base;
    })(),
    ratesSetAt: now,
    createdAt: now,
    updatedAt: now,
  };
  await coll.insertOne(doc);
  return doc;
}

/** Display name + avatar off the Hive profile, with the account as the fallback. */
async function channelProfile(acct) {
  try {
    const [r] = await hiveRpcBatch([{
      jsonrpc: '2.0', method: 'bridge.get_profile', params: { account: acct }, id: 1,
    }]);
    const p = r && r.result;
    return {
      displayName: str(p && p.metadata && p.metadata.profile && p.metadata.profile.name, 120) || `@${acct}`,
      avatarUrl: str(p && p.metadata && p.metadata.profile && p.metadata.profile.profile_image, 1024)
        || `https://images.hive.blog/u/${acct}/avatar`,
    };
  } catch (_) {
    // A profile we cannot read is not a reason to refuse a booking.
    return { displayName: `@${acct}`, avatarUrl: `https://images.hive.blog/u/${acct}/avatar` };
  }
}

/* ─── POST /advertise/selfpromo/book ──────────────────────────────────── */
router.post('/selfpromo/book', featureVisible, express.json({ limit: '8kb' }), async (req, res) => {
  try {
    await ensureAdIndexes();
    const b = req.body || {};
    const acct = account(b.account);
    const owner = account(b.owner);
    const permlink = str(b.permlink, 64);
    if (!HIVE_ACCOUNT_RE.test(acct)) {
      return res.status(400).json({ success: false, error: 'A valid Hive account is required' });
    }

    const db = getDb();
    const video = await findVideo(db, owner, permlink);
    const why = ineligibleReason(video, acct);
    if (why) return res.status(400).json({ success: false, error: why });

    const formatKey = str(b.format, 32);
    if (!formatsFor(video).includes(formatKey)) {
      return res.status(400).json({
        success: false,
        error: video.short === true
          ? 'A short can run as a shorts spot or a video roll.'
          : 'A full video can only run as a video roll. Shorts spots need a short.',
      });
    }
    const fmt = formatOf({ format: formatKey });

    const days = Number(b.days);
    if (!validDayCount(days)) {
      return res.status(400).json({
        success: false,
        error: `days must be a whole number between ${AD_MIN_CAMPAIGN_DAYS} and ${AD_MAX_CAMPAIGN_DAYS}`,
      });
    }

    let requestedStart = null;
    if (b.startAt) {
      requestedStart = new Date(b.startAt);
      if (Number.isNaN(requestedStart.getTime())) {
        return res.status(400).json({ success: false, error: 'startAt is not a date we can read.' });
      }
      // Same full day of slack as /campaigns, and for the same reason: the browser
      // sends a bare calendar date and somebody in UTC-12 is legitimately behind us.
      if (requestedStart.getTime() < Date.now() - 24 * 60 * 60 * 1000) {
        return res.status(400).json({ success: false, error: 'That start date has passed. Pick today or later.' });
      }
    }

    const durationSeconds = Math.round(Number(video.duration) || 0);
    const maxSeconds = durationSeconds > 0 ? Math.min(fmt.maxSeconds, durationSeconds) : fmt.maxSeconds;
    const spotSeconds = Number(b.spotSeconds);
    if (!Number.isInteger(spotSeconds) || spotSeconds < 1 || spotSeconds > maxSeconds) {
      return res.status(400).json({
        success: false,
        error: `The spot must be a whole number of seconds between 1 and ${maxSeconds}.`,
      });
    }

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

    // Portrait-only products check the media, never the playlist — the encoder
    // writes a hardcoded RESOLUTION into every master, so reading that would pass
    // every landscape video. Same rule as the normal attach path.
    if (fmt.creativeSpec) {
      const shape = await videoShapeFromManifest(manifestUrlFor(video.manifest_cid)).catch(() => null);
      const shapeError = shape ? creativeSpecError(fmt.key, shape) : null;
      if (shapeError) return res.status(400).json({ success: false, error: shapeError });
    }

    const window = windowFrom(requestedStart, days);
    /* WHERE IN THE VIDEO, decided here rather than asked.
     *
     * A roll is positioned and positions have capacity, so one has to be chosen. The
     * wizard deliberately does not ask: a creator promoting their own video has no
     * view on whether it should play at 25% or 50%, and making them pick would be a
     * question with no right answer standing between them and the thing they came to
     * do. First free position, or the booking is refused with the dates that are.
     */
    let slotPercent = null;
    if (fmt.positioned) {
      const avail = await slotAvailability(db, {
        start: window.startAt.getTime(),
        end: window.endAt.getTime(),
        format: formatKey,
      });
      const free = avail.find((s) => s.available && s.percent > 0) || avail.find((s) => s.available);
      if (!free) {
        const soonest = avail.map((s) => s.freeFrom).filter(Boolean).sort((a, c) => a - c)[0];
        return res.status(409).json({
          success: false,
          error: 'Every position is full for those dates.'
            + (soonest ? ` The first one opens up on ${new Date(soonest).toISOString().slice(0, 10)}.` : ''),
        });
      }
      slotPercent = free.percent;
      if (!AD_SLOT_PERCENTS.includes(slotPercent)) slotPercent = AD_SLOT_PERCENTS[0];
    }

    const profile = await channelProfile(acct);
    const advertiser = await ensureSelfPromoAdvertiser(db, acct, profile);
    const ratePerSecondDayHbd = selfPromoRate(advertiser, formatKey);
    const totalHbd = priceForDays(days, ratePerSecondDayHbd, spotSeconds);

    const now = new Date();
    const campaign = {
      advertiserRef: advertiser.reference,
      hiveAccount: acct,
      name: `${profile.displayName}: ${str(video.hive_title || video.embed_title, 80) || 'video'}`,
      format: formatKey,
      status: STATES.AWAITING_PAYMENT,
      days,
      spotSeconds,
      slotPercent,
      markets: [],
      minVideoSeconds,
      maxVideoSeconds,
      startAt: window.startAt,
      endAt: window.endAt,
      requestedStartAt: requestedStart,
      ratePerSecondDayHbd,
      totalHbd,
      paidHbd: 0,
      productionFeeHbd: 0,
      /* THE FLAG EVERYTHING DOWNSTREAM READS.
       *
       * Serving uses it for the beta limit (AD_SELFPROMO_ALLOWED_OWNERS), and it is
       * what tells anybody reading this collection later that the creative is a
       * published post on purpose rather than by mistake. */
      selfPromo: true,
      selfPromoVideo: {
        owner: video.owner,
        permlink: video.permlink,
        hiveAuthor: video.hive_author || video.owner,
        hivePermlink: video.hive_permlink,
      },
      creativeEmbedId: String(video._id),
      createdAt: now,
      updatedAt: now,
    };
    const ins = await db.collection(AD_CAMPAIGNS_COLLECTION).insertOne(campaign);

    /* The creative: their own encoded video, trimmed by the stitcher.
     *
     * Keyed on embedId like every other creative, so a second flight on the same
     * video reuses the row — including a review decision a person already made. The
     * status is only reset for a row nobody has ruled on yet, which is the same rule
     * the normal attach path follows.
     */
    const embedKey = String(video._id);
    const prior = await db.collection(AD_CREATIVES_COLLECTION).findOne({ embedId: embedKey });
    const settled = prior
      && (prior.status === CREATIVE_STATES.READY || prior.status === CREATIVE_STATES.REJECTED);
    await db.collection(AD_CREATIVES_COLLECTION).updateOne(
      { embedId: embedKey },
      {
        $set: {
          advertiserRef: advertiser.reference,
          owner: acct,
          kind: CREATIVE_KINDS.VIDEO,
          manifestCid: video.manifest_cid,
          durationSeconds,
          selfPromo: true,
          /* The spot is the OPENING of the video, not the whole thing.
           *
           * Without this the splicer would run every segment the creative manifest
           * lists, so booking fifteen seconds of a ten-minute video would drop ten
           * minutes of it into somebody else's playback. adServe cuts at the first
           * segment boundary at or after this many seconds. */
          trimToSeconds: spotSeconds,
          status: settled ? prior.status : CREATIVE_STATES.REVIEW,
          updatedAt: now,
        },
        $setOnInsert: { embedId: embedKey, reviewNote: null, createdAt: now },
      },
      { upsert: true },
    );

    res.json({
      success: true,
      campaignId: String(ins.insertedId),
      reference: advertiser.reference,
      // What the transfer has to say. The claim route matches on exactly this.
      memo: `ad:${String(ins.insertedId)}`,
      payTo: AD_PAYMENT_ACCOUNT,
      totalHbd,
      ratePerSecondDayHbd,
      spotSeconds,
      days,
      startAt: window.startAt,
      endAt: window.endAt,
      slotPercent,
      // Said plainly because the wizard's last screen has to set the expectation:
      // paid is not live.
      reviewRequired: true,
    });
  } catch (err) {
    console.error('[selfpromo] booking failed:', err && err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
