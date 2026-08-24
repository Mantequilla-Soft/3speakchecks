/**
 * 🔐 The three gates on the ad platform, checked end to end against a LIVE checker.
 *
 * Not a jest test on purpose: these hit real HTTP, real Hive RPC and the real
 * Mongo, so `npm test` must never pick them up and run them against production.
 * Same category as scripts/test-gated-feed-flag.js — run it by hand after touching
 * routes/advertise.js, utils/hiveAuth.js or the ADS_* config.
 *
 * What it protects, and why each one is easy to break:
 *
 *   1. THE ADMIN GATE is NOT validateApiKey. That checks API_SECRET_KEY, which is
 *      the same string the frontend ships as VITE_CHECKER_API_KEY — public to
 *      anyone with devtools. Approving advertisers behind a public key would be
 *      decorative, so the admin surface uses AD_ADMIN_SECRET and this asserts that
 *      the public key is refused.
 *
 *   2. THE BETA GATE is server-side. The frontend flag only hides UI; the thing
 *      that actually holds is this — both write paths carry a Hive signature, so
 *      the account is proven rather than claimed.
 *
 *   3. THE SIGNATURE CHECK accepts a delegate (@threespeak) so HiveSigner and
 *      Butter Auth creators can set their own preference. verifyHiveAuthority()
 *      answers "may this key act for X?", never "is this message about X?" — a
 *      delegate holds authority over thousands of accounts, so the route MUST
 *      build the message from the account in the request. The cross-user replay
 *      case below is what catches it if anyone ever stops doing that.
 *
 * Usage: node scripts/test-advertise.cjs [baseUrl]
 *        (default https://checker.3speak.tv)
 *
 * Needs, from the environment / .env files: AD_ADMIN_SECRET (checker) and the
 * 3Speak posting WIF (to forge delegate signatures). Neither is ever printed.
 * Writes are made only for beta accounts and are set back to the default (ads on)
 * before exit — note that leaves a preference ROW behind for that account, holding
 * the same value it would have with no row at all. Harmless, but not "no trace".
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PrivateKey, cryptoUtils } = require('@hiveio/dhive');
const { ADS_BETA_USERS, ADS_STAGE, AD_CREATOR_POOL_PCT, AD_DEFAULT_COMMUNITY_PCT } = require('../utils/config');

// The feature can be switched fully dark (ADS_STAGE=off), in which case every route
// under test answers 404 by design. Say so and skip, rather than reporting a wall of
// failures that look like breakage.
if (require('../utils/config').ADS_STAGE === 'off') {
  console.log('SKIPPED — ADS_STAGE=off, the ad surface is dark by design.');
  console.log('Set ADS_STAGE=beta in 3speakchecks/.env and restart to run these.');
  process.exit(0);
}

const BASE = (process.argv[2] || 'https://checker.3speak.tv').replace(/\/$/, '') + '/advertise';
const ADMIN = process.env.AD_ADMIN_SECRET || '';
const PUBLIC_KEY_VALUE = process.env.API_SECRET_KEY || '';

// The API server holds the posting key; read it from wherever that service lives.
const SERVER_ENV_CANDIDATES = [
  '/mnt/HC_Volume_103240961/prodops/services/preview-3speak/server/.env',
  path.join(__dirname, '..', '..', 'preview-3speak', 'server', '.env'),
];
function readPostingWif() {
  if (process.env.THREESPEAK_POSTING_WIF) return process.env.THREESPEAK_POSTING_WIF;
  for (const p of SERVER_ENV_CANDIDATES) {
    try {
      const line = fs.readFileSync(p, 'utf8').split('\n').find((l) => l.startsWith('THREESPEAK_POSTING_WIF='));
      if (line) return line.slice('THREESPEAK_POSTING_WIF='.length).trim().replace(/^["']|["']$/g, '');
    } catch (_) { /* try the next candidate */ }
  }
  return '';
}

const BETA = ADS_BETA_USERS[0] || 'meno';
const BETA_2 = ADS_BETA_USERS[1] || 'tibfox';
const OUTSIDER = 'paarvez';   // a real creator who is not a tester

let fails = 0;
const check = (label, got, want) => {
  const ok = String(got) === String(want);
  if (!ok) fails += 1;
  console.log(`${ok ? ' ok ' : 'FAIL'}  ${label.padEnd(52)} ${got} (want ${want})`);
};

const status = async (p, init) => (await fetch(BASE + p, init)).status;
const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function main() {
  const wif = readPostingWif();
  if (!ADMIN) { console.error('AD_ADMIN_SECRET is not set — cannot check the admin gate.'); process.exit(1); }
  if (!wif) { console.error('No THREESPEAK_POSTING_WIF found — cannot check the delegate path.'); process.exit(1); }

  const key = PrivateKey.fromString(wif);
  const sign = (m) => key.sign(cryptoUtils.sha256(Buffer.from(m, 'utf8'))).toString();
  const prefsMessage = (u, on, share, ts) =>
    ['3speak-ads', 'creator-prefs', u, on ? 'on' : 'off', String(share), String(ts)].join('|');
  const setPrefs = (account, on, share = 0, signAs = account, ts = Date.now(), sendShare = share) =>
    status('/creator/prefs', json({
      account, adsEnabled: on, communitySharePct: sendShare, timestamp: ts,
      signature: sign(prefsMessage(signAs, on, share, ts)),
    }));
  const application = (hiveAccount) => json({
    hiveAccount, projectName: 'Integration check', contact: '@test', category: 'tooling',
    creativeConcept: 'Automated check of the advertiser intake gates.',
  });

  console.log(`checker: ${BASE}\nstage:   ${ADS_STAGE}\nbeta:    ${ADS_BETA_USERS.join(', ')}\n`);

  console.log('── 1. the admin gate rejects the PUBLIC frontend key ──');
  check('no key refused', await status('/admin/applications'), 401);
  if (PUBLIC_KEY_VALUE) {
    check('VITE_CHECKER_API_KEY refused', await status('/admin/applications', { headers: { authorization: `Bearer ${PUBLIC_KEY_VALUE}` } }), 401);
  }
  check('AD_ADMIN_SECRET accepted', await status('/admin/applications', { headers: { authorization: `Bearer ${ADMIN}` } }), 200);

  console.log('\n── 2. the beta gate refuses writes from outside the list ──');
  check('outsider cannot apply', await status('/apply', application(OUTSIDER)), 403);
  check('outsider cannot set an ad preference', await setPrefs(OUTSIDER, false), 403);
  check('a tester can set one', await setPrefs(BETA, false), 200);

  console.log('\n── the revenue split is inside the signature ──');
  check(`share above the ${AD_CREATOR_POOL_PCT}% pool refused`,
    await setPrefs(BETA, true, AD_CREATOR_POOL_PCT + 1), 400);
  check('fractional share refused', await setPrefs(BETA, true, 12.5), 400);
  check('a valid share is accepted', await setPrefs(BETA, true, 20), 200);
  // Sign for 20 but send 40 — the classic "change the money after signing" attempt.
  check('share altered after signing refused', await setPrefs(BETA, true, 20, BETA, Date.now(), 40), 401);
  const read = await (await fetch(`${BASE}/creator/prefs/${BETA}`)).json();
  check('stored split is the signed one', read.split && read.split.communityPct, 20);
  check('creator keeps the remainder', read.split && read.split.creatorPct, AD_CREATOR_POOL_PCT - 20);

  // A creator who chose ZERO must keep zero. With a non-zero platform default this
  // is the case a `||` fallback silently overwrites, so it is worth asserting.
  check('an explicit 0 is accepted', await setPrefs(BETA, true, 0), 200);
  const zero = await (await fetch(`${BASE}/creator/prefs/${BETA}`)).json();
  check('an explicit 0 stays 0', zero.split && zero.split.communityPct, 0);
  check('  and is not read as unset', zero.split && zero.split.isDefault, false);
  const never = await (await fetch(`${BASE}/creator/prefs/${OUTSIDER}`)).json();
  check(`a creator who never set one gets ${AD_DEFAULT_COMMUNITY_PCT}%`,
    never.split && never.split.communityPct, AD_DEFAULT_COMMUNITY_PCT);
  check('  and is flagged as the default', never.split && never.split.isDefault, true);

  console.log('\n── 3. a delegate signature is bound to ONE account ──');
  const ts = Date.now();
  check('signature made for another account refused', await setPrefs(BETA_2, false, 0, BETA, ts), 401);
  check('on/off flipped after signing refused',
    await status('/creator/prefs', json({ account: BETA, adsEnabled: true, communitySharePct: 0, timestamp: ts, signature: sign(prefsMessage(BETA, false, 0, ts)) })), 401);
  const stale = Date.now() - 60 * 60 * 1000;
  check('stale timestamp refused', await setPrefs(BETA, false, 0, BETA, stale), 401);
  check('unsigned refused', await status('/creator/prefs', json({ account: BETA, adsEnabled: false })), 401);

  console.log('\n── cleanup ──');
  check('tester preference restored', await setPrefs(BETA, true, 0), 200);

  console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nall checks passed');
  process.exit(fails ? 1 : 0);
}

main().catch((err) => { console.error(err && err.message); process.exit(1); });
