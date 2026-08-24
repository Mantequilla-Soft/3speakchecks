/**
 * Advertiser intake + the approval gate.
 *
 * "We don't let everyone in" is the product requirement, so nothing here creates
 * a bookable advertiser on its own: an application lands as `pending` and a human
 * has to move it. Approval is the only thing that unlocks a campaign later, which
 * keeps the gate in one place instead of scattered across the booking flow.
 *
 * Public surface
 *   GET  /advertise/inventory              audience + deliverable slots (sanitised)
 *   POST /advertise/apply                  submit an application → opaque reference
 *   GET  /advertise/application/:reference status by reference (no account enumeration)
 *   GET  /advertise/creator/prefs/:account whether an account carries ads
 *   POST /advertise/creator/prefs          creator opt-out, Hive-signature required
 *
 * Admin surface (Bearer AD_ADMIN_SECRET — deliberately NOT the frontend's key)
 *   GET  /advertise/admin/applications     the queue
 *   POST /advertise/admin/applications/:id/decide
 *   GET  /advertise/admin/inventory        full snapshot, including who was excluded
 *   POST /advertise/admin/inventory/refresh
 *
 * PRIVACY: no IP is stored. The per-IP throttle below lives in memory for ten
 * minutes and never reaches Mongo — same posture as routes/reports.js and the
 * watch tracker, and the thing the GDPR work on this codebase has been moving
 * everything toward.
 */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { ObjectId } = require('mongodb');
const { getDb } = require('../utils/db');
const { verifyHiveSignedMessage, verifyHiveAuthority } = require('../utils/hiveAuth');
const { hiveRpcBatch } = require('../utils/hive');
const { getSnapshot, runOnce } = require('../services/adInventory');
const { ObjectId: AdObjectId } = require('mongodb');
const { CREATIVE_STATES, missingAssetFor } = require('../utils/adModel');
const {
  ADVERTISERS_COLLECTION,
  AD_CREATOR_PREFS_COLLECTION,
  HIVE_AUTH_REQUIRED,
  SIGNATURE_TIMESTAMP_TOLERANCE_MS,
  AD_APPLY_MAX_PER_WINDOW,
  AD_CATEGORIES,
  AD_SIGNING_DELEGATES,
  ADS_STAGE,
  ADS_BETA_USERS,
  AD_CREATOR_POOL_PCT,
  AD_DEFAULT_COMMUNITY_PCT,
  AD_CREATIVES_COLLECTION,
  ADS_ALLOWED_OWNERS,
} = require('../utils/config');

/* ─── admin gate ──────────────────────────────────────────────────────────
 * NOT utils/middleware.validateApiKey. That checks API_SECRET_KEY, which is the
 * same value the frontend ships as VITE_CHECKER_API_KEY — every VITE_ variable is
 * inlined into the browser bundle, so that key is readable by anyone who opens
 * devtools on 3speak.tv. Gating "who is allowed to advertise" behind a public
 * string would make the approval requirement decorative.
 *
 * Same shape as routes/gdprAdmin.js instead: a dedicated secret that never leaves
 * the server, compared in constant time, and FAIL-CLOSED — an unset secret 503s
 * the admin surface rather than opening it.
 */
const AD_ADMIN_SECRET = process.env.AD_ADMIN_SECRET || '';

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ab, bb); } catch (_) { return false; }
}

function requireAdmin(req, res, next) {
  if (!AD_ADMIN_SECRET) {
    return res.status(503).json({ success: false, error: 'Advertiser admin disabled (no AD_ADMIN_SECRET set)' });
  }
  const hdr = req.get('authorization') || '';
  const bearer = hdr.startsWith('Bearer ') ? hdr.slice(7).trim() : '';
  const provided = bearer || req.get('x-admin-secret') || '';
  if (!provided || !timingSafeEqual(provided, AD_ADMIN_SECRET)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  return next();
}

/* ─── beta gate ───────────────────────────────────────────────────────────
 * Applied per-route rather than with a blanket router.use(). A path-less
 * router.use() gates everything registered after it, which is precisely how
 * streamStats ended up 401-ing routes that were never meant to reach it — and the
 * operator admin surface has to keep working while the feature is switched off.
 * Naming the middleware on each route makes the exceptions greppable instead of
 * implied by line order.
 */
function featureVisible(req, res, next) {
  if (ADS_STAGE === 'off') return res.status(404).json({ success: false, error: 'Not found' });
  return next();
}

// Guards the two paths that WRITE. Both carry a Hive signature, so the account is
// proven, not claimed — which is what makes this gate real rather than cosmetic.
// Runs before signature verification so a non-tester gets a straight answer rather
// than paying for an RPC round-trip first.
function betaWriterAllowed(accountName) {
  if (ADS_STAGE === 'public') return true;
  return ADS_BETA_USERS.includes(accountName);
}

const BETA_REFUSAL = {
  success: false,
  error: 'Ads on 3Speak are in closed testing and this account is not part of it yet.',
};

const HIVE_ACCOUNT_RE = /^[a-z][a-z0-9.-]{2,15}$/;

// ISO 3166-1 alpha-2. A two-letter shape check is not enough: "ZZ" passes it and
// then sits in the record as a market nobody can deliver, which the reviewer only
// discovers when quoting. The country codes on watch sessions come from the same
// standard (GeoLite2), so this is the set the two sides can actually agree on.
const ISO_COUNTRIES = new Set(('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN '
  + 'BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG '
  + 'EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE '
  + 'IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD '
  + 'ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG '
  + 'PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ '
  + 'TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW').split(' '));
const VALID_STATUS = new Set(['pending', 'approved', 'rejected']);
const CATEGORY_SET = new Set(AD_CATEGORIES);

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const account = (v) => str(v, 32).toLowerCase();
// `Date.now()` is a number, and JSON keeps it one — reading it with str() silently
// yielded '' and produced a baffling "Signature required" for a correctly signed
// request. Accept either form; the signature is over the string either way.
const stamp = (v) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : str(v, 20));

// The split as everyone downstream should see it. Nullish-checked on purpose: a
// stored 0 is a creator who chose to keep the whole pool, NOT an unset field, and
// `||` cannot tell those apart once the default is non-zero.
function splitOf(doc) {
  const stored = doc && doc.communitySharePct;
  const communityPct = (stored === undefined || stored === null)
    ? AD_DEFAULT_COMMUNITY_PCT
    : stored;
  return {
    poolPct: AD_CREATOR_POOL_PCT,
    communityPct,
    creatorPct: AD_CREATOR_POOL_PCT - communityPct,
    isDefault: stored === undefined || stored === null,
  };
}

let indexesEnsured = false;
async function ensureIndexes() {
  if (indexesEnsured) return;
  indexesEnsured = true;
  try {
    const db = getDb();
    const adv = db.collection(ADVERTISERS_COLLECTION);
    await adv.createIndex({ reference: 1 }, { unique: true });
    await adv.createIndex({ status: 1, createdAt: -1 });   // the review queue
    await adv.createIndex({ hiveAccount: 1, status: 1 });   // duplicate-application guard
    await db.collection(AD_CREATOR_PREFS_COLLECTION).createIndex({ adsEnabled: 1 });
  } catch (err) {
    indexesEnsured = false;
    console.error('[advertise] index ensure failed:', err && err.message);
  }
}

/* ─── throttle ────────────────────────────────────────────────────────── */
// In-memory, per-IP, ten-minute window. Mirrors routes/reports.js. The map is
// swept on write so a long-lived process doesn't accumulate dead keys.
// Only SUBMISSIONS count against the limit, never rejected ones: a form this long
// gets typos, and locking someone out for ten minutes because they mistyped their
// Hive account punishes the applicants we most want. Nothing here is enumerable,
// so failed attempts cost us nothing to allow.
const hits = new Map();
const WINDOW_MS = 10 * 60 * 1000;
function sweep(now) {
  for (const [k, arr] of hits) {
    const live = arr.filter((t) => now - t < WINDOW_MS);
    if (live.length) hits.set(k, live); else hits.delete(k);
  }
}
function isThrottled(ip) {
  if (!ip) return false;
  sweep(Date.now());
  return (hits.get(ip) || []).length >= AD_APPLY_MAX_PER_WINDOW;
}
function recordSubmission(ip) {
  if (!ip) return;
  const arr = hits.get(ip) || [];
  arr.push(Date.now());
  hits.set(ip, arr);
}
const clientIp = (req) => String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.ip || '')
  .split(',')[0].trim();

/* ─── signatures ──────────────────────────────────────────────────────── */
// Bound to the action and the account so a signature captured from one flow
// cannot be replayed into another.
const applyMessage = (hiveAccount, timestamp) => ['3speak-ads', 'apply', hiveAccount, String(timestamp)].join('|');

// "Show me my own applications". Same shape as the others so one verifier covers
// all three, and scoped by name so a signature made to list an account's records
// can never be replayed against a route that changes something.
const mineMessage = (hiveAccount, timestamp) => ['3speak-ads', 'mine', hiveAccount, String(timestamp)].join('|');
// The community share is IN the signed message on purpose. It decides where money
// goes, so a signature captured for one split must not authorise another — the same
// reason the on/off state is in there rather than trusted from the request body.
const prefsMessage = (hiveAccount, adsEnabled, communitySharePct, timestamp) =>
  ['3speak-ads', 'creator-prefs', hiveAccount, adsEnabled ? 'on' : 'off',
    String(communitySharePct), String(timestamp)].join('|');

function badTimestamp(ts) {
  const n = parseInt(ts, 10);
  if (!Number.isFinite(n)) return 'invalid timestamp';
  if (Math.abs(Date.now() - n) > SIGNATURE_TIMESTAMP_TOLERANCE_MS) return 'timestamp out of tolerance';
  return null;
}

/** Does this Hive account exist? Fail-open: an RPC outage must not block intake. */
async function hiveAccountExists(name) {
  try {
    const [res] = await hiveRpcBatch([{
      jsonrpc: '2.0', id: 1, method: 'condenser_api.get_accounts', params: [[name]],
    }]);
    const list = res && res.result;
    if (!Array.isArray(list)) return null;      // unknown — don't hold it against them
    return list.length > 0;
  } catch (_) {
    return null;
  }
}

/* ─── GET /advertise/inventory ────────────────────────────────────────── */
// What a prospective advertiser is allowed to see: the cleaned audience and the
// deliverable slots. Deliberately NOT the excluded-account list — naming the
// accounts we treat as junk traffic is an internal matter, not a rate card.
router.get('/inventory', featureVisible, async (req, res) => {
  try {
    const snap = await getSnapshot();
    if (!snap) {
      return res.status(503).json({
        success: false,
        error: 'Inventory forecast has not run yet',
      });
    }
    res.set('Cache-Control', 'public, max-age=900');
    res.json({
      success: true,
      runAt: snap.runAt,
      windowDays: snap.windowDays,
      audience: {
        sessionsPerDay: snap.sellable.sessionsPerDay,
        sessionsPerWindow: snap.sellable.sessions,
        videos: snap.sellable.videos,
        watchHours: snap.sellable.watchHours,
        countries: snap.countries,
      },
      slots: snap.slots.map((s) => ({
        percent: s.percent,
        kind: s.kind,
        perDay: s.perDay,
        perMonth: s.perMonth,
        reachPct: s.reachPct,
        videos: s.videos,
      })),
      // Why the figures are what they are. Without this a restricted trial looks
      // exactly like a broken page: near-zero everywhere and no reason given. An
      // advertiser reading small numbers deserves to know whether the audience is
      // small or the trial is.
      trial: ADS_ALLOWED_OWNERS.length ? {
        active: true,
        owners: ADS_ALLOWED_OWNERS,
        // The figures describe the whole platform; serving is what is restricted.
        // Saying so explicitly matters — an advertiser must not read platform
        // capacity as what their spot would reach during the trial.
        note: `These figures cover the whole of 3Speak. Ads are still in a closed trial and currently run only on ${ADS_ALLOWED_OWNERS.map((o) => `@${o}`).join(', ')}'s videos, so a booking made today would reach far less than the numbers below.`,
      } : { active: false, owners: [], note: null },
      // Stated openly on purpose. An advertiser who can see how much traffic we
      // threw away trusts the number that is left; one who only sees the headline
      // has no reason to.
      quality: {
        removedSessions: snap.sellable.removedSessions,
        removedPct: snap.sellable.removedPct,
        minEngagedSeconds: snap.rules.minEngagedSeconds,
        note: 'Sessions below the engagement floor, traffic from accounts whose average session is too short to be a viewer, and videos whose creator opted out are all excluded before this count.',
      },
    });
  } catch (err) {
    console.error('[advertise] inventory failed:', err && err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/* ─── POST /advertise/apply ───────────────────────────────────────────── */
router.post('/apply', featureVisible, express.json({ limit: '64kb' }), async (req, res) => {
  try {
    await ensureIndexes();
    const ip = clientIp(req);
    if (isThrottled(ip)) {
      return res.status(429).json({ success: false, error: 'Too many applications, please try again later' });
    }

    const b = req.body || {};
    const hiveAccount = account(b.hiveAccount);
    const projectName = str(b.projectName, 120);
    const contact = str(b.contact, 200);
    const category = str(b.category, 40).toLowerCase();
    const creativeConcept = str(b.creativeConcept, 4000);
    const website = str(b.website, 300);
    const budgetHbd = Number.isFinite(Number(b.budgetHbd)) ? Math.max(0, Number(b.budgetHbd)) : null;
    const marketsRaw = Array.isArray(b.markets)
      ? b.markets.map((m) => str(m, 2).toUpperCase()).filter(Boolean).slice(0, 20)
      : [];
    const markets = marketsRaw.filter((m) => ISO_COUNTRIES.has(m));
    const badMarkets = marketsRaw.filter((m) => !ISO_COUNTRIES.has(m));

    // "Have us make the video for you", asked at application time rather than only
    // at booking. Most people applying do not have a spot yet, and finding that out
    // after we have already reviewed and approved them wastes the reviewer's pass.
    // It commits nobody to anything: the fee is still quoted and charged on the
    // campaign, this is the brief and the intent.
    const productionRequested = !!(b.production && b.production.requested);
    const productionBrief = str(b.production && b.production.brief, 4000);

    if (!HIVE_ACCOUNT_RE.test(hiveAccount)) {
      return res.status(400).json({ success: false, error: 'A valid Hive account is required' });
    }
    // As soon as we know WHICH account, before nit-picking the rest of the form —
    // being told your pitch is too short and only then that you were never eligible
    // is a small cruelty.
    if (!betaWriterAllowed(hiveAccount)) return res.status(403).json(BETA_REFUSAL);
    if (!projectName) return res.status(400).json({ success: false, error: 'projectName is required' });
    if (!contact) return res.status(400).json({ success: false, error: 'contact is required' });
    if (!CATEGORY_SET.has(category)) {
      return res.status(400).json({ success: false, error: 'category must be one of: ' + AD_CATEGORIES.join(', ') });
    }
    if (creativeConcept.length < 20) {
      return res.status(400).json({ success: false, error: 'Tell us what you want to advertise (at least 20 characters)' });
    }
    if (website && !/^https?:\/\//i.test(website)) {
      return res.status(400).json({ success: false, error: 'website must start with http:// or https://' });
    }
    if (badMarkets.length) {
      return res.status(400).json({
        success: false,
        error: `Not a country code: ${badMarkets.join(', ')}. Use ISO two-letter codes, e.g. BD, US, VE.`,
      });
    }
    if (productionRequested && productionBrief.length < 20) {
      return res.status(400).json({
        success: false,
        error: 'Tell us what the spot should say (at least 20 characters). We cannot make a spot from a blank brief.',
      });
    }

    const db = getDb();
    const coll = db.collection(ADVERTISERS_COLLECTION);

    // One application UNDER REVIEW at a time, not one per account ever.
    //
    // An approved advertiser may apply again, because an application is not an
    // account: it is one product with its own creative concept, its own spots, its
    // own flights and its own negotiated rate. Somebody approved to run an exchange
    // ad has not been approved to run whatever they launch next, and that second
    // thing deserves the same look from a person as the first one got. Their
    // existing approval is untouched and still books flights for the thing it was
    // granted for.
    //
    // A pending one still blocks: two applications from the same account sitting in
    // the queue at once is a reviewer reading the same person twice, and it is also
    // the only natural rate limit on how many an approved advertiser can open.
    const pendingAlready = await coll.findOne(
      { hiveAccount, status: 'pending' },
      { projection: { status: 1, reference: 1 } },
    );
    if (pendingAlready) {
      return res.status(409).json({
        success: false,
        error: 'You already have an application under review. We will come back to you on that one first.',
        reference: pendingAlready.reference,
        status: pendingAlready.status,
      });
    }

    // A signature is optional — some 3Speak login methods cannot sign a message —
    // but a signed application proves account ownership and the reviewer sees that.
    let hiveVerified = false;
    const signature = str(b.signature, 200);
    const timestamp = stamp(b.timestamp);
    if (signature && timestamp && HIVE_AUTH_REQUIRED) {
      const tsErr = badTimestamp(timestamp);
      if (tsErr) return res.status(401).json({ success: false, error: tsErr });
      try {
        hiveVerified = await verifyHiveSignedMessage({
          message: applyMessage(hiveAccount, timestamp), signature, username: hiveAccount,
        });
      } catch (_) {
        hiveVerified = false;   // malformed signature is not a server fault; carry on unverified
      }
      if (!hiveVerified) return res.status(401).json({ success: false, error: 'Invalid signature' });
    }

    const accountExists = await hiveAccountExists(hiveAccount);
    if (accountExists === false) {
      return res.status(400).json({ success: false, error: 'That Hive account does not exist' });
    }

    // Opaque, unguessable, and the only thing needed to check status later — so
    // no endpoint has to take an account name and confirm whether it applied.
    const reference = crypto.randomBytes(9).toString('base64url');

    const doc = {
      reference,
      hiveAccount,
      hiveVerified,
      accountExists: accountExists === null ? null : true,
      projectName,
      website: website || null,
      contact,
      category,
      budgetHbd,
      markets,
      creativeConcept,
      production: productionRequested
        ? { requested: true, brief: productionBrief, requestedAt: new Date() }
        : null,
      status: 'pending',
      applicantNote: null,     // shown to the applicant
      reviewerNote: null,      // internal only, never returned publicly
      reviewedBy: null,
      reviewedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await coll.insertOne(doc);
    recordSubmission(ip);   // charged only now — a rejected form is free

    res.status(201).json({
      success: true,
      reference,
      status: 'pending',
      message: 'Application received. Every advertiser is reviewed by hand — keep this reference to check back.',
    });
  } catch (err) {
    console.error('[advertise] apply failed:', err && err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/* ─── GET /advertise/application/:reference ───────────────────────────── */
router.get('/application/:reference', featureVisible, async (req, res) => {
  try {
    const reference = str(req.params.reference, 64);
    if (!reference) return res.status(400).json({ success: false, error: 'reference is required' });

    const doc = await getDb().collection(ADVERTISERS_COLLECTION).findOne(
      { reference },
      { projection: { status: 1, applicantNote: 1, projectName: 1, hiveAccount: 1, createdAt: 1, reviewedAt: 1, production: 1, logoUrl: 1, slogan: 1 } },
    );
    if (!doc) return res.status(404).json({ success: false, error: 'Unknown reference' });

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      status: doc.status,
      projectName: doc.projectName,
      hiveAccount: doc.hiveAccount,
      note: doc.applicantNote || null,
      submittedAt: doc.createdAt,
      reviewedAt: doc.reviewedAt || null,
      // So someone coming back with only their reference sees what they asked for,
      // rather than wondering whether the request was recorded at all.
      production: doc.production && doc.production.requested
        ? { requested: true, brief: doc.production.brief || null }
        : null,
      logoUrl: doc.logoUrl || null,
      slogan: doc.slogan || null,
    });
  } catch (err) {
    console.error('[advertise] application lookup failed:', err && err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/* ─── POST /advertise/mine ────────────────────────────────────────────── */
/**
 * Every application belonging to one Hive account, so a returning advertiser does
 * not have to keep a reference around to find their own work.
 *
 * POST, not GET, and signed. The `reference` is deliberately unguessable precisely
 * so that no endpoint takes an account name and confirms whether it applied — this
 * route would undo that if it answered on a name alone, because what sits behind a
 * reference is contact details, a stated budget, the applicant's brief, our private
 * note to them and a payment memo. So it costs a signature, and the signature goes
 * in a body rather than a query string where access logs would keep it.
 *
 * Accepted proof is the same pair the opt-out control accepts: the account's own
 * posting key, or a posting-authority delegate we sign with (@threespeak). The
 * delegate path is what makes this work at all for HiveSigner and Butter Auth
 * sessions, which hold no key in the browser.
 *
 * It returns the references themselves, which is the point: the caller can then use
 * the ordinary per-reference endpoints, and can remember them so the next visit
 * costs no signature at all.
 */
router.post('/mine', featureVisible, express.json({ limit: '8kb' }), async (req, res) => {
  try {
    const b = req.body || {};
    const name = account(b.account);
    if (!HIVE_ACCOUNT_RE.test(name)) {
      return res.status(400).json({ success: false, error: 'Invalid account' });
    }

    if (HIVE_AUTH_REQUIRED) {
      const signature = str(b.signature, 200);
      const timestamp = stamp(b.timestamp);
      if (!signature || !timestamp) {
        return res.status(401).json({
          success: false,
          error: 'Signature required',
          expected_message: mineMessage(name, '<ms>'),
        });
      }
      const tsErr = badTimestamp(timestamp);
      if (tsErr) return res.status(401).json({ success: false, error: tsErr });
      let verdict = { ok: false };
      try {
        verdict = await verifyHiveAuthority({
          message: mineMessage(name, timestamp),
          signature,
          username: name,
          allowedDelegates: AD_SIGNING_DELEGATES,
        });
      } catch (err) {
        if (err && err.code === 'HIVE_ACCOUNT_NOT_FOUND') {
          return res.status(404).json({ success: false, error: 'Hive account not found' });
        }
        verdict = { ok: false };
      }
      if (!verdict.ok) return res.status(401).json({ success: false, error: 'Invalid signature' });
    }

    // Same projection as the single-reference lookup, plus the reference itself.
    // reviewerNote is absent here for the same reason it is absent there: it is the
    // one field on this document that is ours and not theirs.
    const rows = await getDb().collection(ADVERTISERS_COLLECTION)
      .find({ hiveAccount: name }, {
        projection: {
          reference: 1, status: 1, applicantNote: 1, projectName: 1,
          hiveAccount: 1, createdAt: 1, reviewedAt: 1, production: 1,
          logoUrl: 1, slogan: 1,
        },
      })
      .sort({ createdAt: -1 })
      .limit(25)
      .toArray();

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      account: name,
      applications: rows.map((doc) => ({
        reference: doc.reference,
        status: doc.status,
        projectName: doc.projectName,
        hiveAccount: doc.hiveAccount,
        note: doc.applicantNote || null,
        submittedAt: doc.createdAt,
        reviewedAt: doc.reviewedAt || null,
        production: doc.production && doc.production.requested
          ? { requested: true, brief: doc.production.brief || null }
          : null,
        logoUrl: doc.logoUrl || null,
        slogan: doc.slogan || null,
      })),
    });
  } catch (err) {
    console.error('[advertise] mine lookup failed:', err && err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/* ─── POST /advertise/branding ────────────────────────────────────────── */
/**
 * The logo and slogan shown in the disclosure overlay while the ad plays.
 *
 * They live on the PRODUCT rather than on each ad video, because they identify who
 * the ad is from and that does not change between one clip and the next. It also
 * means updating a logo fixes it everywhere at once instead of per creative.
 *
 * Open to a pending applicant for the same reason uploading is: the reviewer should
 * see the whole thing, overlay included, before deciding.
 */
const SLOGAN_MAX = 50;

router.post('/branding', featureVisible, express.json({ limit: '8kb' }), async (req, res) => {
  try {
    const b = req.body || {};
    const reference = str(b.reference, 64);
    if (!reference) return res.status(400).json({ success: false, error: 'reference is required' });

    const coll = getDb().collection(ADVERTISERS_COLLECTION);
    const advertiser = await coll.findOne(
      { reference, status: { $in: ['pending', 'approved'] } },
      { projection: { reference: 1 } },
    );
    if (!advertiser) {
      return res.status(403).json({ success: false, error: 'No product for that reference' });
    }

    const set = { updatedAt: new Date() };

    // `undefined` means "leave it alone"; an empty string means "remove it". Without
    // that distinction saving a slogan would wipe a logo the caller never mentioned.
    if (b.logoUrl !== undefined) {
      const logoUrl = str(b.logoUrl, 1024);
      if (logoUrl && !/^https:\/\//i.test(logoUrl)) {
        return res.status(400).json({ success: false, error: 'logoUrl must be an https URL' });
      }
      set.logoUrl = logoUrl || null;
    }
    if (b.slogan !== undefined) {
      const slogan = str(b.slogan, SLOGAN_MAX);
      if (String(b.slogan || '').trim().length > SLOGAN_MAX) {
        return res.status(400).json({
          success: false,
          error: `The slogan can be at most ${SLOGAN_MAX} characters.`,
        });
      }
      set.slogan = slogan || null;
    }

    await coll.updateOne({ reference }, { $set: set });
    const doc = await coll.findOne({ reference }, { projection: { logoUrl: 1, slogan: 1 } });
    res.json({ success: true, logoUrl: doc.logoUrl || null, slogan: doc.slogan || null });
  } catch (err) {
    console.error('[advertise] branding save failed:', err && err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/* ─── creator opt-out ─────────────────────────────────────────────────── */
// Ads run network-wide by default, so this endpoint is the creator's side of
// that bargain and has to work before a single ad serves.
router.get('/creator/prefs/:account', featureVisible, async (req, res) => {
  try {
    const name = account(req.params.account);
    if (!HIVE_ACCOUNT_RE.test(name)) {
      return res.status(400).json({ success: false, error: 'Invalid account' });
    }
    const doc = await getDb().collection(AD_CREATOR_PREFS_COLLECTION).findOne({ _id: name });
    res.json({
      success: true,
      account: name,
      adsEnabled: doc ? doc.adsEnabled !== false : true,   // default ON
      split: splitOf(doc),
      updatedAt: (doc && doc.updatedAt) || null,
    });
  } catch (err) {
    console.error('[advertise] creator prefs read failed:', err && err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.post('/creator/prefs', featureVisible, express.json({ limit: '8kb' }), async (req, res) => {
  try {
    await ensureIndexes();
    const b = req.body || {};
    const name = account(b.account);
    const adsEnabled = b.adsEnabled !== false;
    if (!HIVE_ACCOUNT_RE.test(name)) {
      return res.status(400).json({ success: false, error: 'Invalid account' });
    }

    // How much of the creator pool goes to the community the video was posted in.
    // Absent means the platform default; an explicit 0 means zero. The distinction
    // matters — `|| DEFAULT` would silently overwrite a creator who chose to keep
    // the whole pool, which is exactly the decision we must not make for them.
    const shareRaw = b.communitySharePct;
    const communitySharePct = shareRaw === undefined || shareRaw === null || shareRaw === ''
      ? AD_DEFAULT_COMMUNITY_PCT
      : Number(shareRaw);
    if (!Number.isInteger(communitySharePct) || communitySharePct < 0 || communitySharePct > AD_CREATOR_POOL_PCT) {
      return res.status(400).json({
        success: false,
        error: `communitySharePct must be a whole number between 0 and ${AD_CREATOR_POOL_PCT}`,
      });
    }

    if (!betaWriterAllowed(name)) return res.status(403).json(BETA_REFUSAL);

    // Unlike the application form, this one MUST be signed — it changes what runs
    // on someone else's videos, so proof of authority is not optional.
    //
    // Accepted: the account's own posting key, OR a posting-authority delegate we
    // sign with (@threespeak). The delegate path is what makes this control usable
    // at all for HiveSigner and Butter Auth sessions, which hold no key in the
    // browser — see utils/hiveAuth.js. Refusing them would leave the users least
    // able to sign as the only ones who cannot turn ads off on their own videos.
    let signedBy = name;
    if (HIVE_AUTH_REQUIRED) {
      const signature = str(b.signature, 200);
      const timestamp = stamp(b.timestamp);
      if (!signature || !timestamp) {
        return res.status(401).json({
          success: false,
          error: 'Signature required',
          expected_message: prefsMessage(name, adsEnabled, communitySharePct, '<ms>'),
        });
      }
      const tsErr = badTimestamp(timestamp);
      if (tsErr) return res.status(401).json({ success: false, error: tsErr });
      let verdict = { ok: false, signer: null };
      try {
        verdict = await verifyHiveAuthority({
          message: prefsMessage(name, adsEnabled, communitySharePct, timestamp),
          signature,
          username: name,
          allowedDelegates: AD_SIGNING_DELEGATES,
        });
      } catch (err) {
        if (err && err.code === 'HIVE_ACCOUNT_NOT_FOUND') {
          return res.status(404).json({ success: false, error: 'Hive account not found' });
        }
        verdict = { ok: false, signer: null };
      }
      if (!verdict.ok) return res.status(401).json({ success: false, error: 'Invalid signature' });
      signedBy = verdict.signer;
    }

    await getDb().collection(AD_CREATOR_PREFS_COLLECTION).updateOne(
      { _id: name },
      {
        // `signedBy` is kept because "@threespeak set this on their behalf" and
        // "the account holder set this themselves" are different facts, and the
        // day someone disputes an ad running on their video is the day we need it.
        $set: { adsEnabled, communitySharePct, signedBy, updatedAt: new Date() },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
    res.json({
      success: true,
      account: name,
      adsEnabled,
      signedBy,
      // Returned as the full split rather than one number, so nothing downstream
      // has to remember which side of the pool the stored figure refers to.
      split: splitOf({ communitySharePct }),
    });
  } catch (err) {
    console.error('[advertise] creator prefs write failed:', err && err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/* ─── admin ───────────────────────────────────────────────────────────── */
router.get('/admin/applications', requireAdmin, async (req, res) => {
  try {
    const status = str(req.query.status, 16).toLowerCase();
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const query = VALID_STATUS.has(status) ? { status } : {};
    const docs = await getDb().collection(ADVERTISERS_COLLECTION)
      .find(query).sort({ createdAt: -1 }).limit(limit).toArray();
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, count: docs.length, applications: docs });
  } catch (err) {
    console.error('[advertise] admin list failed:', err && err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.post('/admin/applications/:id/decide', requireAdmin, express.json({ limit: '16kb' }), async (req, res) => {
  try {
    const b = req.body || {};
    const decision = str(b.decision, 16).toLowerCase();
    if (decision !== 'approved' && decision !== 'rejected') {
      return res.status(400).json({ success: false, error: "decision must be 'approved' or 'rejected'" });
    }
    let _id;
    try { _id = new ObjectId(String(req.params.id)); }
    catch (_) { return res.status(400).json({ success: false, error: 'Invalid application id' }); }

    const result = await getDb().collection(ADVERTISERS_COLLECTION).findOneAndUpdate(
      { _id },
      { $set: {
        status: decision,
        applicantNote: str(b.applicantNote, 1000) || null,
        reviewerNote: str(b.reviewerNote, 4000) || null,
        reviewedBy: str(b.reviewedBy, 64) || null,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      } },
      { returnDocument: 'after' },
    );
    const doc = result && (result.value || result);
    if (!doc || !doc._id) return res.status(404).json({ success: false, error: 'Application not found' });

    res.json({ success: true, application: doc });
  } catch (err) {
    console.error('[advertise] decide failed:', err && err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/* ─── creative review ─────────────────────────────────────────────────── */
// The step that was missing: without it a spot sits at `review` forever, which
// means servableReason() returns `creative_review` and NO ad can ever run. Every
// other part of the loop was reachable; this one was a dead end.
router.get('/admin/creatives', requireAdmin, async (req, res) => {
  try {
    const status = str(req.query.status, 16).toLowerCase();
    const query = Object.values(CREATIVE_STATES).includes(status)
      ? { status }
      : { status: CREATIVE_STATES.REVIEW };   // the queue that needs a person
    const rows = await getDb().collection(AD_CREATIVES_COLLECTION)
      .find(query).sort({ createdAt: -1 }).limit(100).toArray();
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, count: rows.length, creatives: rows });
  } catch (err) {
    console.error('[advertise] creative queue failed:', err && err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.post('/admin/creatives/:id/decide', requireAdmin, express.json({ limit: '16kb' }), async (req, res) => {
  try {
    const b = req.body || {};
    const decision = str(b.decision, 16).toLowerCase();
    if (decision !== 'approved' && decision !== 'rejected') {
      return res.status(400).json({ success: false, error: "decision must be 'approved' or 'rejected'" });
    }
    let _id;
    try { _id = new AdObjectId(String(req.params.id)); }
    catch (_) { return res.status(400).json({ success: false, error: 'Invalid creative id' }); }

    const coll = getDb().collection(AD_CREATIVES_COLLECTION);
    const creative = await coll.findOne({ _id });
    if (!creative) return res.status(404).json({ success: false, error: 'Creative not found' });

    // Approving a creative with nothing to show would put a campaign into a state
    // that looks servable and then fails at delivery — refuse it here, where the
    // operator can still be told why.
    //
    // What "nothing to show" means depends on the KIND. This used to demand a
    // manifestUrl of everything, which a still never has, so a banner creative could
    // be uploaded and queued and then never approved — the reviewer was told a
    // still had "not finished encoding", which it was never going to do. The rule
    // now comes from missingAssetFor(), the same one the serving gate uses, so the
    // two cannot drift apart again.
    if (decision === 'approved') {
      const missing = missingAssetFor(creative);
      if (missing) {
        return res.status(409).json({
          success: false,
          error: missing === 'creative_has_no_image'
            ? 'That banner has no image on record — nothing to show.'
            : 'That spot has not finished encoding yet — there is nothing to play.',
        });
      }
    }

    // Spots can now be uploaded while an application is still under review, so the
    // queue contains creatives from advertisers we have not said yes to. Approving
    // one of those would leave a READY spot belonging to somebody who may end up
    // rejected. Nothing would serve it — a campaign still needs an approved
    // advertiser and a paid flight — but "approved" would be a lie on the record,
    // and the applicant's page would show it.
    if (decision === 'approved' && creative.advertiserRef) {
      const advertiser = await getDb().collection(ADVERTISERS_COLLECTION)
        .findOne({ reference: creative.advertiserRef }, { projection: { status: 1 } });
      if (!advertiser || advertiser.status !== 'approved') {
        return res.status(409).json({
          success: false,
          error: `The advertiser behind that spot is ${advertiser ? advertiser.status : 'unknown'}. Approve the application first.`,
        });
      }
    }

    await coll.updateOne({ _id }, {
      $set: {
        status: decision === 'approved' ? CREATIVE_STATES.READY : CREATIVE_STATES.REJECTED,
        reviewNote: str(b.note, 1000) || null,
        reviewedBy: str(b.reviewedBy, 64) || null,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      },
    });
    res.json({ success: true, creative: await coll.findOne({ _id }) });
  } catch (err) {
    console.error('[advertise] creative decide failed:', err && err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Full snapshot, excluded accounts and all — the view a human needs to sanity-check
// the rate card before it goes out.
router.get('/admin/inventory', requireAdmin, async (req, res) => {
  try {
    const snap = await getSnapshot();
    if (!snap) return res.status(503).json({ success: false, error: 'Inventory forecast has not run yet' });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, snapshot: snap });
  } catch (err) {
    console.error('[advertise] admin inventory failed:', err && err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.post('/admin/inventory/refresh', requireAdmin, async (req, res) => {
  try {
    const snap = await runOnce();
    if (!snap) return res.status(500).json({ success: false, error: 'Refresh failed or writes are disabled' });
    res.json({ success: true, snapshot: snap });
  } catch (err) {
    console.error('[advertise] inventory refresh failed:', err && err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
