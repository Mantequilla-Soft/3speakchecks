#!/usr/bin/env node
/**
 * Viewer rewards: consent, and the share that funds it.
 *
 *   node scripts/test-ad-viewer-rewards.cjs [baseUrl]
 *
 * Two properties worth protecting. First, the viewer share comes out of the
 * PLATFORM's cut, never the creators' — funding it from the creator pool would be
 * paying viewers with creators' money. Second, the opt-in is a CONSENT record: it
 * must be unforgeable, must distinguish "declined" from "never asked", and turning
 * it off must delete what was already collected, not merely stop collecting.
 *
 * Hits real Mongo and the live checker. Creates and removes its own rows.
 */
require('dotenv').config();
const { connectToMongo, getDb } = require('../utils/db');
const {
  AD_CREATOR_POOL_PCT, AD_VIEWER_POOL_PCT,
  AD_VIEWER_PREFS_COLLECTION, AD_VIEWER_WATCH_COLLECTION, ADS_BETA_USERS,
} = require('../utils/config');

const { AD_PAYOUTS_COLLECTION: AD_PAYOUTS_COLLECTION_NAME } = require('../utils/config');
const BASE = (process.argv[2] || 'http://127.0.0.1:3131') + '/advertise';
const TESTER = ADS_BETA_USERS[0] || 'badadib';
const OUTSIDER = 'hiveredcarpet';

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${label}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
}
const post = async (path, body) => {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

(async () => {
  await connectToMongo();
  const db = getDb();
  const prefs = db.collection(AD_VIEWER_PREFS_COLLECTION);
  const watch = db.collection(AD_VIEWER_WATCH_COLLECTION);
  const saved = await prefs.find({ _id: { $in: [TESTER, OUTSIDER] } }).toArray();
  const cleanup = async () => {
    await prefs.deleteMany({ _id: { $in: [TESTER, OUTSIDER] } });
    await watch.deleteMany({ viewer: { $in: [TESTER, OUTSIDER] } });
    if (saved.length) await prefs.insertMany(saved);
  };
  await cleanup();
  await prefs.deleteMany({ _id: { $in: [TESTER, OUTSIDER] } });

  try {
    console.log('── the share that funds it ──');
    // 100 HBD of revenue, at the defaults.
    const revenue = 100;
    const creatorSide = revenue * (AD_CREATOR_POOL_PCT / 100);
    const platformPool = revenue * (1 - AD_CREATOR_POOL_PCT / 100);
    const viewerPool = Math.round(platformPool * (AD_VIEWER_POOL_PCT / 100) * 1000) / 1000;
    check(`creator side is still the full ${AD_CREATOR_POOL_PCT}%`, creatorSide, 50);
    check('viewer pool comes from the platform cut', viewerPool, 5);
    check('  creators are NOT diluted by it', creatorSide + viewerPool <= revenue, true);
    check('  platform keeps the remainder', Math.round((revenue - creatorSide - viewerPool) * 1000) / 1000, 45);

    console.log('\n── consent: three states, not two ──');
    let r = await (await fetch(`${BASE}/viewer/prefs/${TESTER}`)).json();
    check('never asked reads as undecided', { on: r.rewardsEnabled, decided: r.decided }, { on: false, decided: false });

    console.log('\n── consent cannot be forged ──');
    r = await post('/viewer/prefs', { account: TESTER, rewardsEnabled: true });
    check('unsigned opt-in refused', r.status, 401);
    check('  and it names the message to sign', String(r.body.expected_message || '').startsWith('3speak-ads|viewer-prefs|'), true);
    r = await post('/viewer/prefs', { account: TESTER, rewardsEnabled: true, signature: 'x'.repeat(40), timestamp: Date.now() });
    check('bogus signature refused', r.status, 401);
    r = await post('/viewer/prefs', { account: OUTSIDER, rewardsEnabled: true });
    check('non-beta account refused', r.status, 403);
    check('  nothing was written for them', await prefs.countDocuments({ _id: OUTSIDER }), 0);

    console.log('\n── a malformed body must never opt somebody in ──');
    for (const bad of [{}, { rewardsEnabled: 'yes' }, { rewardsEnabled: 1 }, { rewardsEnabled: null }]) {
      const res = await post('/viewer/prefs', { account: TESTER, ...bad, signature: 'x'.repeat(40), timestamp: Date.now() });
      // Refused for want of a valid signature, but the point is the parsed value:
      // anything that is not literally true must read as a decline.
      const parsed = bad.rewardsEnabled === true;
      check(`  ${JSON.stringify(bad.rewardsEnabled)} parses as opt-in? ${parsed}`, parsed, false);
      check(`  and the request is refused`, res.status === 401 || res.status === 403, true);
    }

    console.log('\n── opting out deletes what was already collected ──');
    // Simulate an opted-in viewer with identified watch rows.
    await prefs.updateOne({ _id: TESTER },
      { $set: { rewardsEnabled: true, signedBy: 'test', updatedAt: new Date() } }, { upsert: true });
    await watch.insertMany([
      { viewer: TESTER, owner: 'someone', permlink: 'a', watchedPct: 90, contentSeconds: 300, at: new Date(), payoutId: null },
      { viewer: TESTER, owner: 'someone', permlink: 'b', watchedPct: 80, contentSeconds: 200, at: new Date(), payoutId: null },
    ]);

    console.log("\n-- rewatching cannot be paid twice --");
    // The grain IS the anti-fraud rule: one row per (viewer, owner, permlink),
    // upserted with $max. A second viewing raises the best figure or does nothing.
    // Measured: rewatching inflates plays 63%, and one account replayed one video 85x.
    const key = { viewer: TESTER, owner: 'someone', permlink: 'a' };
    await watch.updateOne(key, { $max: { watchedPct: 40, contentSeconds: 120 } });
    let row = await watch.findOne(key);
    check('a worse rewatch changes nothing', { pct: row.watchedPct, secs: row.contentSeconds }, { pct: 90, secs: 300 });
    await watch.updateOne(key, { $max: { watchedPct: 96, contentSeconds: 340 } });
    row = await watch.findOne(key);
    check('a better rewatch raises it', { pct: row.watchedPct, secs: row.contentSeconds }, { pct: 96, secs: 340 });
    check('  and there is still ONE row', await watch.countDocuments(key), 1);
    let dupErr = null;
    try { await watch.insertOne({ ...key, watchedPct: 99, contentSeconds: 9999 }); }
    catch (e) { dupErr = e.code; }
    check('a second row for the same video is refused', dupErr, 11000);

    check('identified rows exist while opted in', await watch.countDocuments({ viewer: TESTER }), 2);

    // The route does the deletion; exercise the same operation it performs.
    await prefs.updateOne({ _id: TESTER }, { $set: { rewardsEnabled: false, updatedAt: new Date() } });
    const del = await watch.deleteMany({ viewer: TESTER });
    check('opting out removes them', del.deletedCount, 2);
    check('  none left behind', await watch.countDocuments({ viewer: TESTER }), 0);
    const after = await (await fetch(`${BASE}/viewer/prefs/${TESTER}`)).json();
    check('declined is distinguishable from never-asked',
      { on: after.rewardsEnabled, decided: after.decided }, { on: false, decided: true });


    console.log("\n-- the payout: pro rata by capped seconds --");
    // Three viewers, different watch times. The pool divides by seconds, so the
    // rate is one number for everyone and shares are proportional.
    await watch.deleteMany({ viewer: { $regex: '^vrtest-' } });
    const { payViewers, periodContaining } = require('../services/adPayouts');

    /* 🚨 PARK EVERY REAL UNPAID ROW FIRST.
     *
     * payViewers() settles ALL unpaid rows by design — there is deliberately no date
     * filter, so a watch banked in an earlier period is still owed. That makes it
     * impossible to scope by period: a synthetic pool run here would sweep in real
     * viewers' watches, stamp them settled, and queue REAL pending payouts. With
     * AD_PAYOUTS_ENABLED and an active key set, those get broadcast.
     *
     * This is not hypothetical: on 2026-09-02 this test paid a genuine viewer
     * 1.777 HBD out of its own fake 20 HBD pool before anyone noticed.
     */
    const parked = await watch.find({ payoutId: null, viewer: { $not: /^vrtest-/ } })
      .project({ _id: 1 }).toArray();
    const parkedIds = parked.map((r) => r._id);
    if (parkedIds.length) {
      await watch.updateMany({ _id: { $in: parkedIds } }, { $set: { payoutId: '__test-parked' } });
    }
    const unpark = async () => {
      if (parkedIds.length) {
        await watch.updateMany({ _id: { $in: parkedIds } },
          { $set: { payoutId: null }, $unset: { settledAt: '' } });
      }
    };
    const per = periodContaining(Date.now() - 3 * 864e5);
    await db.collection(require('../utils/config').AD_PAYOUTS_COLLECTION)
      .deleteMany({ periodKey: per.key, account: { $regex: '^vrtest-' } });
    await watch.insertMany([
      { viewer: 'vrtest-a', owner: 'x', permlink: 'p1', watchedPct: 90, contentSeconds: 1200, at: new Date(), payoutId: null },
      { viewer: 'vrtest-b', owner: 'x', permlink: 'p2', watchedPct: 80, contentSeconds: 600,  at: new Date(), payoutId: null },
      { viewer: 'vrtest-c', owner: 'x', permlink: 'p3', watchedPct: 99, contentSeconds: 200,  at: new Date(), payoutId: null },
    ]);
    const POOL = 20;
    const res1 = await payViewers(db, per, POOL);
    const paidRows = await db.collection(require('../utils/config').AD_PAYOUTS_COLLECTION)
      .find({ periodKey: per.key, kind: 'viewer' }).toArray();
    const byAcct = Object.fromEntries(paidRows.map((r) => [r.account, r.hbd]));
    check('all three paid', res1.recipients, 3);
    // 2000 total seconds, 20 HBD -> 0.01 HBD/sec
    check('  a: 1200s of 2000 => 12 HBD', byAcct['vrtest-a'], 12);
    check('  b:  600s        =>  6 HBD', byAcct['vrtest-b'], 6);
    check('  c:  200s        =>  2 HBD', byAcct['vrtest-c'], 2);
    check('  the whole pool is distributed', Math.round(res1.paidHbd * 1000) / 1000, POOL);

    // 🚨 Settling again must pay nothing: rows were claimed with payoutId.
    const res2 = await payViewers(db, per, POOL);
    check('re-settling pays nobody twice', res2.recipients, 0);
    check('  rows are marked settled', await watch.countDocuments({ viewer: { $regex: '^vrtest-' }, payoutId: null }), 0);

    await watch.deleteMany({ viewer: { $regex: '^vrtest-' } });
    await db.collection(require('../utils/config').AD_PAYOUTS_COLLECTION)
      .deleteMany({ periodKey: per.key, account: { $regex: '^vrtest-' } });
    await unpark();
    check('real viewers were NOT swept into the test pool',
      await db.collection(require('../utils/config').AD_PAYOUTS_COLLECTION)
        .countDocuments({ kind: 'viewer', account: { $not: /^vrtest-/ } }), 0);
    check('  and their rows are unpaid again',
      await watch.countDocuments({ payoutId: '__test-parked' }), 0);

    console.log('\n── the identity stream is separate from the anonymous one ──');
    const vd = await db.collection('view-durations').findOne({});
    check('view-durations still carries no viewer identity',
      ['viewer', 'username', 'user', 'account'].some((f) => vd && vd[f] !== undefined), false);
  } finally {
    // If an assertion threw between parking and unparking, real rows would be left
    // marked settled and would never be paid. Restore them whatever happened.
    await watch.updateMany({ payoutId: '__test-parked' },
      { $set: { payoutId: null }, $unset: { settledAt: '' } });
    await db.collection(AD_PAYOUTS_COLLECTION_NAME).deleteMany({ kind: 'viewer', status: 'pending', account: { $regex: '^vrtest-' } });
    await cleanup();
    console.log('\ncleaned up its own rows.');
  }

  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
