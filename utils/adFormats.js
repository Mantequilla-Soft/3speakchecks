/**
 * The ad FORMAT registry: what kinds of ad can be bought, and what each one implies.
 *
 * There is one product per entry, and every difference between products is a field
 * here rather than an `if (format === …)` somewhere downstream. Booking, pricing,
 * validation, serving, payout and the rate card all read this table, so adding a
 * fourth format is an entry plus a rate in config.js — not a fourth code path
 * threaded through six files.
 *
 * 🚨 LEGACY CAMPAIGNS CARRY NO `format` FIELD. Every campaign booked before formats
 * existed is a video roll, and `formatOf()` is the ONLY place that decision is made.
 * Reading `campaign.format` directly anywhere else would silently reinterpret those
 * bookings as some other product — the same trap `slotPosition` vs `slotPercent`
 * already set once in adModel.js, and it is worth not falling into twice.
 *
 * WHAT THE FIELDS MEAN
 *   creativeKind    the asset a campaign of this format must supply before it can
 *                   serve. A roll needs an encoded video; a banner needs a still.
 *   surface         where it runs. 'watch' formats are decided per playback against
 *                   a creator's video; 'upload' runs in the upload flow instead, and
 *                   has no video and no creator behind it at all.
 *   creatorCredit   WHO the creator half of the revenue is owed to, and WHEN. Not a
 *                   boolean: the two surfaces owe different people on different
 *                   terms, and collapsing that into yes/no is how the wrong account
 *                   gets paid.
 *
 *                     'video_owner'          the owner of the video the ad ran on.
 *                                            Payable as soon as delivery completes —
 *                                            they supplied the inventory, the ad has
 *                                            run, nothing further is pending.
 *
 *                     'uploader_on_publish'  the viewer who WATCHED it, and only once
 *                                            the upload that ad gated is actually
 *                                            published. Nobody supplied inventory
 *                                            here; the platform is buying a finished
 *                                            upload, and pays only when it gets one.
 *                                            A watched-then-abandoned upload owes
 *                                            nothing, which is the entire point —
 *                                            it rewards the conversion, not the
 *                                            sitting through.
 *
 *                     null                   nobody; the platform keeps the fee.
 *   payoutPool      which pool a delivery's revenue and its impression land in.
 *                   Pools are settled INDEPENDENTLY: own revenue, own impression
 *                   count, own rate, own carry-forward.
 *
 *                   Pooling exists to stop a per-CAMPAIGN lottery — 50 HBD over 7
 *                   days and 50 HBD over 90 days pay twenty times differently per
 *                   play, so whichever flight the rotation happened to hand you
 *                   decided your rate. Splitting by pool does not bring that back:
 *                   every campaign inside a pool still pools together. It only stops
 *                   money crossing between audiences that have nothing to do with
 *                   each other.
 *
 *                   Which is the whole argument. An advertiser buying the upload
 *                   gate is paying to reach creators about to publish. Measured on
 *                   live numbers, pooling that with watch inventory sent the
 *                   uploader 5% of what was paid to reach them and gave the other
 *                   95% to people who had no part in delivering that audience.
 *                   Split, they get the 50% creator share the platform is built on.
 *
 *                   🚨 Roll and banner deliberately SHARE the 'watch' pool. A creator
 *                   does not choose which format runs on their video, and a banner
 *                   impression is worth about a third of a roll impression — separate
 *                   pools would pay two creators very differently for the identical
 *                   play, which is precisely the lottery above.
 *   positioned      whether the booking picks a slotPercent. The upload gate plays
 *                   at one fixed moment, so a position would be a field the
 *                   advertiser fills in that changes nothing.
 *   burnsIn         whether the creative ends up in the video's own pixels rather
 *                   than in the page. See services/adBurner.js.
 *   creativeSpec    what the asset has to BE, when the format constrains it. Lives
 *                   here so the rate card can publish it, the attach route can
 *                   enforce it and the booking page can state it, all from one
 *                   definition. Null where the format has no shape requirement.
 */
const {
  AD_LENGTH_SECONDS,
  AD_PRICE_PER_SECOND_DAY_HBD,
  AD_BANNER_PRICE_PER_SECOND_DAY_HBD,
  AD_BANNER_MAX_SECONDS,
  AD_UPLOAD_GATE_PRICE_PER_SECOND_DAY_HBD,
  AD_BANNER_MIN_ASPECT, AD_BANNER_MAX_ASPECT,
  AD_BANNER_MIN_WIDTH, AD_BANNER_MAX_WIDTH, AD_BANNER_MAX_HEIGHT,
  AD_BANNER_RECOMMENDED,
  AD_SHORTS_PRICE_PER_SECOND_DAY_HBD, AD_SHORTS_MAX_SECONDS,
  AD_SHORTS_MAX_ASPECT, AD_SHORTS_MIN_WIDTH, AD_SHORTS_RECOMMENDED,
} = require('./config');
const { CREATIVE_KINDS } = require('./adCreativeKinds');
const { platformRate } = require('./adSettings');

/**
 * Who the creator half of a delivery is owed to. See the header.
 *
 * UPLOADER_ON_PUBLISH is the only CONDITIONAL one: the impression is recorded when
 * the spot is watched, but it is not payable then and may never become payable. See
 * utils/adCredit.js for the lifecycle that decides.
 */
/**
 * The settlement pools. A format names the one it belongs to; a future format either
 * joins an existing pool or declares a new one, and the payout run picks it up by
 * iterating what the registry actually uses rather than a list kept somewhere else.
 */
const PAYOUT_POOLS = Object.freeze({
  WATCH: 'watch',     // ads served against somebody's video; paid to its owner
  UPLOAD: 'upload',   // the upload gate; paid to the creator who converted
  // Shorts get their own pool for the same reason the upload gate does: it is a
  // different audience bought at a different rate, and a short only ever appears in
  // the shorts feed. So the "two creators paid differently for the identical play"
  // problem that keeps roll and banner together cannot arise here — no short is ever
  // eligible for a watch-page format, and no watch-page video is ever eligible here.
  SHORTS: 'shorts',
});

const CREATOR_CREDIT = Object.freeze({
  VIDEO_OWNER: 'video_owner',
  UPLOADER_ON_PUBLISH: 'uploader_on_publish',
});

const FORMATS = Object.freeze({
  /**
   * The original product: a spot spliced into the middle of someone's video.
   */
  video_roll: Object.freeze({
    key: 'video_roll',
    label: 'Video spot',
    blurb: 'A short spot inside the video, at the point of the video you choose.',
    creativeKind: CREATIVE_KINDS.VIDEO,
    surface: 'watch',
    creatorCredit: CREATOR_CREDIT.VIDEO_OWNER,
    payoutPool: PAYOUT_POOLS.WATCH,
    positioned: true,
    burnsIn: false,
    maxSeconds: AD_LENGTH_SECONDS,
    ratePerSecondDayHbd: AD_PRICE_PER_SECOND_DAY_HBD,
  }),

  /**
   * A strip along the bottom of the frame, burned into the video's own pixels for
   * the seconds it runs. Not an overlay in the page: an overlay is one CSS rule
   * away from being hidden, and the whole point of this format is that it is not.
   */
  video_banner: Object.freeze({
    key: 'video_banner',
    label: 'Player banner',
    blurb: 'A banner across the bottom of the video, from the point you choose. It is part of the picture, not a layer over it.',
    creativeKind: CREATIVE_KINDS.IMAGE,
    /* A banner takes a still OR a video, and the video LOOPS for the seconds the
     * banner runs. Both end up in the same place: composited into the frame's own
     * pixels, so a moving banner is not an overlay any more than a still one is.
     *
     * `creativeKind` stays IMAGE as the DEFAULT the forms and copy lead with, because
     * a still is what most advertisers bring and what the size guidance below is
     * written for. `creativeKinds` is what actually decides whether an upload is
     * allowed, so anything asking "may this file serve here" must read the list, not
     * the singular. A format without the list accepts exactly its `creativeKind`. */
    creativeKinds: Object.freeze([CREATIVE_KINDS.IMAGE, CREATIVE_KINDS.VIDEO]),
    surface: 'watch',
    creatorCredit: CREATOR_CREDIT.VIDEO_OWNER,
    payoutPool: PAYOUT_POOLS.WATCH,
    positioned: true,
    burnsIn: true,
    maxSeconds: AD_BANNER_MAX_SECONDS,
    ratePerSecondDayHbd: AD_BANNER_PRICE_PER_SECOND_DAY_HBD,
    // A banner is fitted into a box roughly 7:1 on a 16:9 frame. Anything much
    // squarer lands small and centred with video showing either side, which is
    // technically fine and visibly not what the advertiser had in mind.
    creativeSpec: Object.freeze({
      minWidth: AD_BANNER_MIN_WIDTH,
      maxWidth: AD_BANNER_MAX_WIDTH,
      maxHeight: AD_BANNER_MAX_HEIGHT,
      minAspect: AD_BANNER_MIN_ASPECT,
      maxAspect: AD_BANNER_MAX_ASPECT,
      recommended: AD_BANNER_RECOMMENDED,
    }),
  }),

  /**
   * Plays before a creator may upload. No video underneath it and nobody supplying
   * inventory, which is why `positioned` is meaningless here — it is the only thing
   * on screen, at the only moment it can run.
   *
   * The creator half goes to the person who WATCHED it, and only once they publish
   * the upload it gated. That turns the gate from a toll into a deal: sit through a
   * spot, finish your upload, get paid. It pays for the finished video rather than
   * for the waiting, so an abandoned upload costs us nothing and a completed one is
   * the thing we actually wanted more of.
   */
  upload_gate: Object.freeze({
    key: 'upload_gate',
    label: 'Pre-upload spot',
    blurb: 'A spot creators watch before they can upload. Small, high-intent audience: everyone who sees it is about to publish.',
    creativeKind: CREATIVE_KINDS.VIDEO,
    surface: 'upload',
    creatorCredit: CREATOR_CREDIT.UPLOADER_ON_PUBLISH,
    payoutPool: PAYOUT_POOLS.UPLOAD,
    positioned: false,
    burnsIn: false,
    maxSeconds: AD_LENGTH_SECONDS,
    ratePerSecondDayHbd: AD_UPLOAD_GATE_PRICE_PER_SECOND_DAY_HBD,
  }),

  /**
   * A full-screen vertical spot in the shorts feed, shown BETWEEN shorts.
   *
   * 🚨 Never inside one, and `positioned: false` says so. Short.jsx has carried the
   * reasoning since ads existed: "the only slot that could fit is pre-roll, and
   * putting a 15-second ad in front of a 12-second short is the same mistake as
   * pre-rolling a video half the audience abandons inside 15 seconds". So this is
   * its own item in the feed rather than a splice into somebody's short, which also
   * means there is no stitching, no discontinuity and no burn — it simply plays.
   *
   * ⚠️ Its pacing is counted in SHORTS WATCHED, not minutes (AD_SHORTS_EVERY_N).
   * A viewer swiping the feed passes ten shorts well inside the time-based cooldown,
   * so minutes would either run an ad almost continuously or almost never.
   *
   * The creator half goes to whoever made the short the viewer just finished: they
   * are the reason the viewer was there for the slot.
   */
  shorts_roll: Object.freeze({
    key: 'shorts_roll',
    label: 'Shorts spot',
    blurb: 'A full-screen vertical spot in the Shorts feed, between one short and the next.',
    creativeKind: CREATIVE_KINDS.VIDEO,
    surface: 'shorts',
    creatorCredit: CREATOR_CREDIT.VIDEO_OWNER,
    payoutPool: PAYOUT_POOLS.SHORTS,
    positioned: false,
    burnsIn: false,
    maxSeconds: AD_SHORTS_MAX_SECONDS,
    ratePerSecondDayHbd: AD_SHORTS_PRICE_PER_SECOND_DAY_HBD,
    // Portrait or it does not belong here: a landscape spot letterboxes into black
    // bars either side of a full-screen phone player, which is technically fine and
    // visibly not what the advertiser paid for.
    creativeSpec: Object.freeze({
      shape: 'portrait',
      maxAspect: AD_SHORTS_MAX_ASPECT,
      minWidth: AD_SHORTS_MIN_WIDTH,
      recommended: AD_SHORTS_RECOMMENDED,
    }),
  }),
});

/** The format every campaign booked before formats existed is on. */
const DEFAULT_FORMAT = 'video_roll';

const FORMAT_KEYS = Object.freeze(Object.keys(FORMATS));

/**
 * Which creative kinds a format will serve.
 *
 * Most formats take exactly one, and say so with `creativeKind`. The banner takes two,
 * and says so with `creativeKinds`. Reading through this helper means a caller cannot
 * accidentally check the singular on a format that has both and reject a legitimate
 * upload, which is the failure this shape invites.
 */
function acceptedKinds(fmt) {
  if (!fmt) return [];
  return Array.isArray(fmt.creativeKinds) && fmt.creativeKinds.length
    ? fmt.creativeKinds
    : [fmt.creativeKind];
}

/** Does this format accept a creative of that kind? */
function formatAccepts(fmt, kind) {
  return acceptedKinds(fmt).includes(kind);
}

/**
 * The format record for a campaign — the single place a missing `format` is read as
 * the legacy default. Always returns a record, never undefined, so no caller has to
 * guard: an unrecognised value (a format retired after campaigns were booked on it)
 * also lands on the default rather than throwing mid-serve.
 */
function formatOf(campaign) {
  const key = String((campaign && campaign.format) || '').trim();
  return FORMATS[key] || FORMATS[DEFAULT_FORMAT];
}

/** The pool a campaign settles into. Same legacy-default guarantee as formatOf(). */
function payoutPoolOf(campaign) {
  return formatOf(campaign).payoutPool;
}

/** Every pool actually in use, derived from the registry rather than kept in step by hand. */
function activePools() {
  return [...new Set(FORMAT_KEYS.map((k) => FORMATS[k].payoutPool))];
}

/** Is this a format that can be booked right now? Used to validate incoming bookings. */
function isBookableFormat(key) {
  return Object.prototype.hasOwnProperty.call(FORMATS, String(key || '').trim());
}

/**
 * The rate for one format, for one advertiser, in HBD per second of ad per day.
 *
 * A negotiated rate is stored per advertiser. It used to be a single number because
 * there was a single product; now it can be either that bare number (which applies
 * to the video roll it was agreed for, and ONLY that one) or a per-format map. A
 * bare legacy number must not silently become the banner rate too — that would hand
 * an advertiser a discount on a product nobody negotiated.
 *
 * With no negotiated rate the answer is the PLATFORM DEFAULT, which is operator-
 * settable in the database (utils/adSettings.js) and falls back to the format's
 * compiled-in `ratePerSecondDayHbd` when nothing is stored. The precedence is
 * therefore: advertiser's per-format rate → advertiser's legacy roll rate →
 * database default → compiled default. Each step is a narrower agreement than the
 * one after it, which is the order they have to be tried in.
 */
function rateFor(advertiser, formatKey) {
  const fmt = FORMATS[String(formatKey || '').trim()] || FORMATS[DEFAULT_FORMAT];
  const custom = advertiser && advertiser.rates && advertiser.rates[fmt.key];
  const n = Number(custom);
  if (Number.isFinite(n) && n > 0) return n;

  // The pre-formats field, which was only ever agreed for the video roll.
  if (fmt.key === DEFAULT_FORMAT) {
    const legacy = Number(
      advertiser && (advertiser.pricePerSecondDayHbd ?? advertiser.pricePerDayHbd),
    );
    if (Number.isFinite(legacy) && legacy > 0) return legacy;
  }
  return platformRate(fmt.key, fmt.ratePerSecondDayHbd);
}

/**
 * The platform default for a format, with no advertiser in the picture: what this
 * product costs somebody who has not negotiated. Exported because "is this rate a
 * special deal?" and "what is the standard price?" are asked outside this file, and
 * both have to be answered against the database default rather than the compiled
 * one or a stored default would read as a discount for everybody.
 */
function defaultRateFor(formatKey) {
  const fmt = FORMATS[String(formatKey || '').trim()] || FORMATS[DEFAULT_FORMAT];
  return platformRate(fmt.key, fmt.ratePerSecondDayHbd);
}

/**
 * Today's platform rates for every bookable format, as a plain `{format: hbd}` map
 * ready to store on an advertiser.
 *
 * WHY AN ADVERTISER GETS A COPY AT REGISTRATION
 * Without one, an advertiser owns no rate at all and `rateFor()` resolves the
 * platform default afresh on every booking — so raising the default silently
 * reprices everybody who ever signed up. Taking a copy at registration is what makes
 * "the rate you signed up on is the rate you keep" true, and it is what lets the
 * platform default be raised for NEW advertisers without touching existing ones.
 *
 * Every format is captured, not just the one they came for. An advertiser who books
 * a roll in month one and a banner in month six signed up under one price list, and
 * handing them today's banner rate because they had not happened to buy one yet
 * would be a rate rise nobody agreed to.
 *
 * ⚠️ This is a SNAPSHOT, not a reference. It does not expire on its own — raising an
 * existing advertiser's rate is a deliberate act through the admin surface. That is
 * the intended behaviour, but it does mean an advertiser left alone keeps their
 * signup rate indefinitely.
 */
function snapshotRates() {
  const out = {};
  FORMAT_KEYS.forEach((key) => { out[key] = defaultRateFor(key); });
  return out;
}

/** The rate card: every bookable format with this advertiser's rate applied. */
function rateCard(advertiser) {
  return FORMAT_KEYS.map((key) => {
    const f = FORMATS[key];
    const rate = rateFor(advertiser, key);
    const standard = defaultRateFor(key);
    return {
      key: f.key,
      label: f.label,
      blurb: f.blurb,
      creativeKind: f.creativeKind,
      // Everything this format will actually take. The page offers a file picker
      // from this, so a banner can accept a video without the page hardcoding which
      // format that is.
      creativeKinds: acceptedKinds(f),
      // A banner is composited into the frame, which is why it loops rather than
      // playing once, and why its "length" means seconds on screen.
      burnsIn: !!f.burnsIn,
      surface: f.surface,
      positioned: f.positioned,
      maxSeconds: f.maxSeconds,
      creativeSpec: f.creativeSpec || null,
      ratePerSecondDayHbd: rate,
      rateIsCustom: rate !== standard,
      creatorCredit: f.creatorCredit,
      payoutPool: f.payoutPool,
    };
  });
}

/**
 * Does this asset satisfy the format's shape requirement? Returns a sentence to show
 * the advertiser, or null when it is fine.
 *
 * Phrased as the thing to do rather than the thing that is wrong: "make it wider" is
 * actionable, "invalid aspect ratio" is not.
 */
function creativeSpecError(formatKey, { width, height }) {
  const spec = (FORMATS[String(formatKey || '').trim()] || {}).creativeSpec;
  if (!spec) return null;
  const w = Number(width);
  const h = Number(height);
  // Unknown dimensions are not a failure. The probe is best-effort and a creative
  // whose size we could not read still fits inside the box at serve time — refusing
  // it would turn a missing measurement into a blocked advertiser.
  if (!(w > 0) || !(h > 0)) return null;

  // Portrait formats (the shorts spot) fail for different reasons and deserve their
  // own wording — telling someone their vertical video "needs to be at least 3:1"
  // is advice for a product they are not buying.
  if (spec.shape === 'portrait') {
    if (w < spec.minWidth) {
      return `That video is ${w}px wide. A shorts spot plays full screen on a phone, so `
        + `it needs to be at least ${spec.minWidth}px across. ${spec.recommended} works well.`;
    }
    if (w / h > spec.maxAspect) {
      return `That video is ${w}x${h}, which is ${w > h ? 'landscape' : 'close to square'}. `
        + `The shorts feed is full-screen portrait, so a wider spot plays small with black `
        + `bars either side. Shoot or crop it upright — ${spec.recommended} works well.`;
    }
    return null;
  }

  if (w < spec.minWidth) {
    return `That image is ${w}px wide. A banner needs to be at least ${spec.minWidth}px `
      + `or it will look soft on a full-size player. ${spec.recommended} works well.`;
  }
  // Shape BEFORE size. A 1080x1080 square trips the height cap too, but "the most a
  // banner can be is 4000x1000" is a baffling thing to be told about a square — the
  // reason it cannot be a banner is that it is not a strip, and that is what to say.
  const aspect = w / h;
  if (aspect < spec.minAspect) {
    return `That image is ${aspect.toFixed(1)}:1. A banner is a strip across the bottom `
      + `of the video, so it needs to be at least ${spec.minAspect}:1 — otherwise it is `
      + `drawn small and centred with the video showing either side. ${spec.recommended} works well.`;
  }
  if (aspect > spec.maxAspect) {
    return `That image is ${aspect.toFixed(1)}:1, which is too long and thin to read at `
      + `player size. Keep it under ${spec.maxAspect}:1 — ${spec.recommended} works well.`;
  }
  if (w > spec.maxWidth || h > spec.maxHeight) {
    return `That image is ${w}x${h}. The most a banner can be is `
      + `${spec.maxWidth}x${spec.maxHeight} — ${spec.recommended} works well.`;
  }
  return null;
}

module.exports = {
  FORMATS, FORMAT_KEYS, DEFAULT_FORMAT, CREATOR_CREDIT, PAYOUT_POOLS,
  formatOf, payoutPoolOf, activePools, isBookableFormat, rateFor, defaultRateFor, snapshotRates,
  rateCard, creativeSpecError, acceptedKinds, formatAccepts,
};
