/**
 * Ad inventory forecast — what the platform can honestly promise an advertiser.
 *
 * The rate card cannot be sold off raw session counts. Two corrections have to
 * happen first, and they are the whole point of this file:
 *
 *   1. JUNK IS REMOVED. Sessions shorter than AD_MIN_ENGAGED_SECONDS are not
 *      views of anything, and accounts whose *average* session is a second or
 *      two are autoplay/scroll traffic, not an audience. Measured 2026-08-20:
 *      one account carried 424 sessions in 0.5 watch-hours (4.2s each) against a
 *      genuine one at 226 sessions / 31.7 hours (8.4 min each). Counting the
 *      first kind as inventory would be selling fraud, intended or not.
 *
 *   2. INVENTORY IS COUNTED AT THE SLOT, NOT AT THE START. An ad at 30s is only
 *      delivered when the playhead actually reaches 30s. 46% of sessions end
 *      inside 15 seconds, so "sessions per day" overstates deliverable inventory
 *      by more than 2x. We count sessions whose furthest playhead position
 *      passed the slot, on videos long enough to hold the slot at all.
 *
 * Also honoured here: Pro subscribers see no ads, so their watch time is not
 * inventory and must not be sold. `view-durations` carries no viewer identity by
 * design — only an ephemeral per-session id — so this reads a `premium` BOOLEAN
 * that the player is expected to set on the session. One bit, no identity, and it
 * keeps the privacy property intact. NOTE: nothing writes that bit yet (ad serving
 * does not exist), so today the filter excludes nothing; it is here so the forecast
 * cannot silently oversell the moment serving turns on. With one Pro subscriber on
 * the platform as of 2026-08-20 the difference is noise either way.
 *
 * NOT honoured here: the serving allowlist. While ADS_ALLOWED_OWNERS restricts which
 * creators' videos actually carry a spot, this forecast deliberately describes the
 * WHOLE platform — it is the rate card for what 3Speak can offer, not a readout of
 * the current trial. Scoping it to the trial account turned every figure to nearly
 * zero, which reads as a broken page rather than a small trial. The restriction is
 * disclosed instead, via the `trial` block on GET /advertise/inventory, so nobody
 * mistakes platform capacity for what is being served today.
 *
 * Also honoured here: creator opt-out. Ads run network-wide by default, but an
 * account in AD_CREATOR_PREFS_COLLECTION with adsEnabled:false is excluded from
 * the forecast as well as from serving — otherwise we would sell inventory we
 * have promised not to use.
 *
 * Writes ONE document (_id: 'current') into AD_INVENTORY_COLLECTION. Nothing
 * here reads or writes personal data: view-durations carries no IP and no
 * viewer id, only a per-session `sid` that dies with the session.
 */
const { getDb } = require('../utils/db');
const {
  ENABLE_MONGO_WRITES,
  AD_INVENTORY_COLLECTION,
  AD_CREATOR_PREFS_COLLECTION,
  AD_INVENTORY_WINDOW_DAYS,
  AD_MIN_ENGAGED_SECONDS,
  AD_SLOT_PERCENTS,
  AD_LENGTH_SECONDS,
  AD_SUSPECT_MIN_SESSIONS,
  AD_SUSPECT_MAX_AVG_SECONDS,
} = require('../utils/config');

const WATCH_LOG = process.env.WATCH_LOG_COLLECTION || 'view-durations';
const PREMIUM_USERS = process.env.PREMIUM_USERS_COLLECTION || 'embed-users';
const DAY_MS = 24 * 60 * 60 * 1000;

// Seconds actually watched in a session, tolerating rows written before
// `contentSeconds` existed. Same coalesce the retention worker uses, so the two
// never disagree about what a junk session is.
const ENGAGED = { $ifNull: ['$contentSeconds', { $ifNull: ['$watchedSeconds', 0] }] };

// Furthest point the playhead reached. This — not watched-seconds — is what
// decides whether a slot at position t was passed: someone who skips to 2:00 and
// watches 10 seconds has passed a 30s mid-roll, and someone who watches the
// first 25 seconds twice has not.
const REACHED = { $ifNull: ['$maxPosition', { $ifNull: ['$lastPosition', ENGAGED] }] };

/**
 * Accounts to exclude from sellable inventory: enough sessions to matter, but an
 * average session too short to be a person watching. Deliberately a diagnostic
 * that is REPORTED, not a silent filter — the excluded list goes into the
 * snapshot so a human can see who was dropped and why.
 */
async function findSuspectAccounts(db, since) {
  const rows = await db.collection(WATCH_LOG).aggregate([
    { $match: { updatedAt: { $gte: since } } },
    { $group: { _id: '$owner', sessions: { $sum: 1 }, seconds: { $sum: ENGAGED } } },
    { $match: { sessions: { $gte: AD_SUSPECT_MIN_SESSIONS } } },
    { $project: {
      sessions: 1,
      seconds: 1,
      avgSeconds: { $divide: ['$seconds', '$sessions'] },
    } },
    { $match: { avgSeconds: { $lt: AD_SUSPECT_MAX_AVG_SECONDS } } },
    { $sort: { sessions: -1 } },
  ]).toArray();

  return rows.map((r) => ({
    owner: r._id,
    sessions: r.sessions,
    avgSeconds: Math.round(r.avgSeconds * 10) / 10,
  }));
}

/** Accounts that have turned ads off. Network-wide default is ON. */
async function findOptedOutAccounts(db) {
  const rows = await db.collection(AD_CREATOR_PREFS_COLLECTION)
    .find({ adsEnabled: false }, { projection: { _id: 1 } }).toArray();
  return rows.map((r) => r._id);
}

/**
 * Deliverable inventory for one slot position, in the cleaned pool.
 *
 * `position: 0` is pre-roll and every qualifying session reaches it by
 * definition; anything else needs the playhead to have gone past it AND the
 * video to be long enough to still have content after the ad — nobody wants a
 * mid-roll that runs into the credits.
 */
function slotPipeline(percent, since, ownerFilter, duration) {
  // The break sits at `percent` of the way through, so the reach test is against
  // each video's OWN duration rather than one absolute number for the catalogue.
  // A video still has to be at least as long as the spot, or there is nothing to
  // splice the ad into.
  const reachedTarget = { $multiply: [{ $ifNull: ['$videoDuration', 0] }, percent / 100] };
  const match = {
    updatedAt: { $gte: since },
    ...ownerFilter,
    premium: { $ne: true },   // a Pro subscriber's playback carries no ad, so it is not inventory
    $expr: {
      $and: [
        { $gte: [ENGAGED, AD_MIN_ENGAGED_SECONDS] },
        { $gte: [{ $ifNull: ['$videoDuration', 0] }, AD_LENGTH_SECONDS] },
        percent > 0 ? { $gte: [REACHED, reachedTarget] } : { $literal: true },
        // Optional video-length targeting. An advertiser who bought "only videos
        // between 3 and 20 minutes" must be forecast against those videos alone,
        // or the number their refund is measured against describes inventory they
        // deliberately excluded.
        duration && duration.min > 0
          ? { $gte: [{ $ifNull: ['$videoDuration', 0] }, duration.min] } : { $literal: true },
        duration && duration.max > 0
          ? { $lte: [{ $ifNull: ['$videoDuration', 0] }, duration.max] } : { $literal: true },
      ],
    },
  };
  return [
    { $match: match },
    { $group: {
      _id: null,
      sessions: { $sum: 1 },
      videos: { $addToSet: { $concat: ['$owner', '/', '$permlink'] } },
    } },
    { $project: { sessions: 1, videos: { $size: '$videos' } } },
  ];
}

async function computeSnapshot() {
  const db = getDb();
  const windowDays = AD_INVENTORY_WINDOW_DAYS;
  const since = new Date(Date.now() - windowDays * DAY_MS);
  const since7 = new Date(Date.now() - 7 * DAY_MS);

  const [suspects, optedOut, premiumSubscribers] = await Promise.all([
    findSuspectAccounts(db, since),
    findOptedOutAccounts(db),
    // Not used in the arithmetic — surfaced so the size of the ad-free audience is
    // visible next to the numbers it will eventually subtract from.
    db.collection(PREMIUM_USERS).countDocuments({ premium: true }).catch(() => null),
  ]);
  // One exclusion list for both reasons — a suspect account that has also opted
  // out should not be counted twice when we report how much was removed.
  const excludedOwners = Array.from(new Set([...suspects.map((s) => s.owner), ...optedOut]));
  const ownerFilter = { owner: { $nin: excludedOwners } };

  // Headline totals (raw and cleaned) plus the audience profile, in one pass.
  const [facet] = await db.collection(WATCH_LOG).aggregate([
    { $match: { updatedAt: { $gte: since } } },
    { $facet: {
      raw: [
        { $group: {
          _id: null,
          sessions: { $sum: 1 },
          seconds: { $sum: ENGAGED },
          videos: { $addToSet: { $concat: ['$owner', '/', '$permlink'] } },
        } },
        { $project: { sessions: 1, seconds: 1, videos: { $size: '$videos' } } },
      ],
      clean: [
        { $match: { ...ownerFilter, premium: { $ne: true }, $expr: { $gte: [ENGAGED, AD_MIN_ENGAGED_SECONDS] } } },
        { $group: {
          _id: null,
          sessions: { $sum: 1 },
          seconds: { $sum: ENGAGED },
          videos: { $addToSet: { $concat: ['$owner', '/', '$permlink'] } },
        } },
        { $project: { sessions: 1, seconds: 1, videos: { $size: '$videos' } } },
      ],
      recent7: [
        { $match: {
          updatedAt: { $gte: since7 },
          ...ownerFilter,
          premium: { $ne: true },
          $expr: { $gte: [ENGAGED, AD_MIN_ENGAGED_SECONDS] },
        } },
        { $count: 'sessions' },
      ],
      countries: [
        { $match: { ...ownerFilter, premium: { $ne: true }, $expr: { $gte: [ENGAGED, AD_MIN_ENGAGED_SECONDS] } } },
        { $group: { _id: '$country', sessions: { $sum: 1 } } },
        { $sort: { sessions: -1 } },
        { $limit: 15 },
      ],
    } },
  ], { allowDiskUse: true }).toArray();

  const raw = (facet.raw || [])[0] || { sessions: 0, seconds: 0, videos: 0 };
  const clean = (facet.clean || [])[0] || { sessions: 0, seconds: 0, videos: 0 };
  const recent7 = ((facet.recent7 || [])[0] || {}).sessions || 0;
  const countryRows = facet.countries || [];

  const slots = [];
  for (const percent of AD_SLOT_PERCENTS) {
    const [row] = await db.collection(WATCH_LOG)
      .aggregate(slotPipeline(percent, since, ownerFilter), { allowDiskUse: true }).toArray();
    const sessions = (row && row.sessions) || 0;
    slots.push({
      percent,
      kind: percent === 0 ? 'pre-roll' : 'mid-roll',
      sessions,
      videos: (row && row.videos) || 0,
      perDay: Math.round((sessions / windowDays) * 10) / 10,
      perMonth: Math.round((sessions / windowDays) * 30),
      // Share of the CLEAN pool that actually reaches this slot. The drop from
      // 100% at pre-roll is the honest cost of placing the ad later, and the
      // reason we do it anyway is that an ad in front of a 6-second session is
      // not an impression, it is a bounce.
      reachPct: clean.sessions ? Math.round((sessions / clean.sessions) * 1000) / 10 : 0,
    });
  }

  const countries = countryRows.map((c) => ({
    code: c._id || 'unknown',
    sessions: c.sessions,
    sharePct: clean.sessions ? Math.round((c.sessions / clean.sessions) * 1000) / 10 : 0,
  }));

  return {
    _id: 'current',
    runAt: new Date(),
    windowDays,
    // What the rules were when this ran, so a stale snapshot is self-describing.
    rules: {
      minEngagedSeconds: AD_MIN_ENGAGED_SECONDS,
      adLengthSeconds: AD_LENGTH_SECONDS,
      suspectMinSessions: AD_SUSPECT_MIN_SESSIONS,
      suspectMaxAvgSeconds: AD_SUSPECT_MAX_AVG_SECONDS,
    },
    raw: {
      sessions: raw.sessions,
      videos: raw.videos,
      watchHours: Math.round((raw.seconds / 3600) * 10) / 10,
    },
    sellable: {
      sessions: clean.sessions,
      videos: clean.videos,
      watchHours: Math.round((clean.seconds / 3600) * 10) / 10,
      sessionsPerDay: Math.round((recent7 / 7) * 10) / 10,   // trailing 7d — the number a forecast should use
      removedSessions: raw.sessions - clean.sessions,
      removedPct: raw.sessions ? Math.round(((raw.sessions - clean.sessions) / raw.sessions) * 1000) / 10 : 0,
    },
    excluded: {
      suspectAccounts: suspects,
      optedOutAccounts: optedOut,
      premiumSubscribers,
      premiumSessionsTracked: false,   // flips when the player starts flagging sessions
    },
    slots,
    countries,
  };
}

async function runOnce() {
  if (!ENABLE_MONGO_WRITES) {
    console.log('[ad-inventory] skipped — ENABLE_MONGO_WRITES=false');
    return null;
  }
  const startedAt = Date.now();
  try {
    const snapshot = await computeSnapshot();
    await getDb().collection(AD_INVENTORY_COLLECTION)
      .replaceOne({ _id: 'current' }, snapshot, { upsert: true });
    const mid = snapshot.slots.find((s) => s.position > 0);
    console.log(
      `[ad-inventory] ${snapshot.sellable.sessions} sellable sessions `
      + `(${snapshot.sellable.removedPct}% removed as junk/opt-out), `
      + `${snapshot.sellable.sessionsPerDay}/day, `
      + `${mid ? `${mid.perDay}/day at ${mid.position}s` : 'no mid-roll slot'} `
      + `in ${Date.now() - startedAt}ms`,
    );
    return snapshot;
  } catch (err) {
    console.error('[ad-inventory] run failed:', err && err.message);
    return null;
  }
}

/** Read the cached snapshot. Null when the job has never run. */
async function getSnapshot() {
  return getDb().collection(AD_INVENTORY_COLLECTION).findOne({ _id: 'current' });
}

/**
 * Sessions per day that a SPECIFIC booking would have reached over the last window.
 *
 * The stored snapshot answers this for the network as a whole, which stops being
 * the right answer the moment a campaign narrows itself — a flight restricted to
 * long videos reaches far fewer sessions than the rate card advertises. Since this
 * number is what an under-delivery refund is measured against, it has to describe
 * the inventory that was actually bought.
 *
 * Runs one aggregation at booking time. Returns null if it cannot be computed, and
 * the caller falls back to the snapshot rather than inventing a figure.
 */
async function forecastPerDay({ percent, minVideoSeconds, maxVideoSeconds }) {
  try {
    const db = getDb();
    const windowDays = AD_INVENTORY_WINDOW_DAYS;
    const since = new Date(Date.now() - windowDays * DAY_MS);
    // Same exclusion list the snapshot uses, so a targeted forecast and the rate
    // card are computed on the same pool and can be compared. Deliberately NOT the
    // serving allowlist, for the reason set out at the top of this file.
    const [suspects, optedOut] = await Promise.all([
      findSuspectAccounts(db, since),
      findOptedOutAccounts(db),
    ]);
    const excludedOwners = Array.from(new Set([...suspects.map((x) => x.owner), ...optedOut]));
    const ownerFilter = { owner: { $nin: excludedOwners } };
    const [row] = await db.collection(WATCH_LOG).aggregate(
      slotPipeline(percent, since, ownerFilter, { min: minVideoSeconds, max: maxVideoSeconds }),
      { allowDiskUse: true },
    ).toArray();
    const sessions = (row && row.sessions) || 0;
    return Math.round((sessions / windowDays) * 10) / 10;
  } catch (err) {
    console.error('[adInventory] targeted forecast failed:', err && err.message);
    return null;
  }
}

module.exports = { runOnce, getSnapshot, computeSnapshot, forecastPerDay };
