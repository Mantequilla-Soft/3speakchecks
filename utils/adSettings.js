/**
 * Platform rate defaults, stored in the database instead of compiled into the
 * process from env.
 *
 * WHY THIS EXISTS
 * The rate card used to be `parseFloat(process.env.…) || 1.5` read once at require
 * time. Changing a price therefore meant editing `.env` and restarting the checker
 * — a restart that drops in-flight feed requests and, worse, is the exact operation
 * that has already loaded half-finished code into production once. A price is an
 * operator decision, not a deployment, so it belongs in data.
 *
 * WHAT IS AND IS NOT IN HERE
 * Only the PLATFORM DEFAULT for each format. A rate negotiated with one advertiser
 * still lives on that advertiser's own document and still wins — see `rateFor()` in
 * utils/adFormats.js, which is the single place the two are resolved against each
 * other. This file answers only "what does a format cost for somebody with no
 * special deal".
 *
 * 🚨 The revenue SPLIT (AD_CREATOR_POOL_PCT / AD_DEFAULT_COMMUNITY_PCT) is
 * deliberately NOT here. Those two numbers are mirrored in the 3Speak API server,
 * which builds the same signed `3speak-ads|creator-prefs|…` message when it signs on
 * behalf of a HiveSigner/ButterAuth creator. Moving one side into this database and
 * leaving the other reading env would sign one split and store another. Making the
 * split runtime-settable means changing both services together, and putting a
 * network fetch inside a signing path — a different and much larger job.
 *
 * WHY THE READ IS SYNCHRONOUS
 * `rateFor()`, `rateCard()` and `priceForDays()` are pure synchronous functions, and
 * the reason they are pure is that the quote shown on the booking page and the price
 * written onto the campaign must be computed by the same code without either of them
 * touching the database. Making them async to await a settings read would give that
 * up. So the document is cached in the process, refreshed on a timer and again
 * immediately after any write, and read synchronously from that snapshot.
 *
 * The staleness this admits is bounded by REFRESH_MS and is harmless: a campaign
 * stores `pricePerSecondDayHbd` and `flightHbd` at creation and the payment claim
 * settles against those stored numbers, so a rate that changes between quote and
 * claim cannot make a booking cost something other than what was quoted.
 *
 * Every failure path falls back to the built-in default the caller passes in, never
 * to zero or null. An unreachable database must not hand somebody a free flight.
 */
const { AD_SETTINGS_COLLECTION } = require('./config');
const { getDb } = require('./db');

const RATES_ID = 'rates';
const REFRESH_MS = 60 * 1000;

/**
 * A sanity ceiling on a stored rate, in HBD per second of ad per day. Not a
 * business limit — the built-in rates are 0.25 to 1.5 — but a guard against a
 * decimal typo in an admin field quietly becoming a four-figure invoice. An
 * operator who genuinely wants more than this can raise the constant.
 */
const MAX_RATE = 1000;

/** Last known document, or null before the first successful load. */
let cache = null;
let timer = null;

/** Is this something we are willing to store and quote as a price? */
function validRate(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= MAX_RATE;
}

/**
 * The platform default rate for one format.
 *
 * `builtIn` is the compiled-in value for that format, passed by the caller rather
 * than looked up here. That is what keeps this file from having to know the format
 * registry — utils/adFormats.js owns the format→default mapping, and this file only
 * decides whether a stored override should be used instead of it. Without that, the
 * mapping would exist in two places and the two would drift.
 */
function platformRate(formatKey, builtIn) {
  const stored = cache && cache.formats && cache.formats[formatKey];
  return validRate(stored) ? Number(stored) : builtIn;
}

/** The whole cached document, for the admin surface. Never null after load(). */
function currentSettings() {
  return cache || { _id: RATES_ID, formats: {} };
}

/** Re-read the document. Keeps the previous snapshot on failure. */
async function refresh() {
  try {
    const doc = await getDb().collection(AD_SETTINGS_COLLECTION).findOne({ _id: RATES_ID });
    cache = doc || { _id: RATES_ID, formats: {} };
    return cache;
  } catch (err) {
    console.error('[ad-settings] refresh failed:', err && err.message);
    return cache;
  }
}

/**
 * Store or clear the platform default for one format.
 *
 * `value` of null/undefined/'' REMOVES the override, which is not the same as
 * storing the built-in number: a cleared format tracks the compiled default if that
 * default is ever changed, whereas a stored copy of today's value would silently
 * pin it. `$unset` is the honest representation of "no opinion".
 *
 * The cache is refreshed before returning so the very next quote reflects the write.
 * Other checker processes pick it up within REFRESH_MS.
 */
async function setRate(formatKey, value, updatedBy) {
  const key = String(formatKey || '').trim();
  if (!key) throw new Error('format key required');

  const clearing = value === null || value === undefined || value === '';
  if (!clearing && !validRate(value)) {
    throw new Error(`rate must be a number greater than 0 and at most ${MAX_RATE}`);
  }

  const update = clearing
    ? { $unset: { [`formats.${key}`]: '' }, $set: { updatedAt: new Date(), updatedBy: updatedBy || null } }
    : { $set: { [`formats.${key}`]: Number(value), updatedAt: new Date(), updatedBy: updatedBy || null } };

  await getDb().collection(AD_SETTINGS_COLLECTION).updateOne({ _id: RATES_ID }, update, { upsert: true });
  await refresh();
  return currentSettings();
}

/**
 * Load once at boot and keep refreshing.
 *
 * Called from server.js. Safe to call twice — the second call replaces nothing and
 * does not stack a second interval.
 */
async function schedule() {
  await refresh();
  if (!timer) {
    timer = setInterval(() => { refresh(); }, REFRESH_MS);
    if (timer.unref) timer.unref();
  }
  return cache;
}

module.exports = { platformRate, currentSettings, refresh, setRate, schedule, validRate, MAX_RATE, RATES_ID };
