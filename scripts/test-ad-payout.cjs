#!/usr/bin/env node
/**
 * 💰 Two creators with identical delivery must be paid identically.
 *
 * This exists because the first payout design failed that. It divided each
 * campaign's fee by that campaign's own impressions, so the rate a creator got
 * depended on which campaign the rotation happened to give them:
 *
 *     50 HBD /  7-day flight, 100 plays → 0.2500 HBD per play
 *     50 HBD / 90-day flight, 2000 plays → 0.0125 HBD per play
 *
 * Ten plays earned 2.5 HBD or 0.125 HBD for the same work. The scenario below is
 * exactly that: one advertiser's spot runs on creator X's video, another's on
 * creator Y's, and both creators must end up with the same amount.
 *
 * Usage: node scripts/test-ad-payout.cjs
 * Creates and removes all of its own data. Never sends a transfer (dry run).
 */
require('dotenv').config();
const { ObjectId } = require('mongodb');
const db = require('../utils/db');
const cfg = require('../utils/config');
const { settlePeriod, periodContaining, accrualFor } = require('../services/adPayouts');

const TAG = 'PAYOUT-TEST';
let fails = 0;
const check = (l, g, w) => { const ok = String(g) === String(w); if (!ok) fails++; console.log(`${ok?' ok ':'FAIL'}  ${l.padEnd(52)} ${g}${ok?'':`  want ${w}`}`); };
const near = (l, g, w, tol = 0.002) => { const ok = Math.abs(g - w) <= tol; if (!ok) fails++; console.log(`${ok?' ok ':'FAIL'}  ${l.padEnd(52)} ${g}${ok?'':`  want ~${w}`}`); };

(async () => {
  await db.connectToMongo();
  const d = db.getDb();
  const camps = d.collection(cfg.AD_CAMPAIGNS_COLLECTION);
  const imps = d.collection(cfg.AD_IMPRESSIONS_COLLECTION);
  const outs = d.collection(cfg.AD_PAYOUTS_COLLECTION);
  const periods = d.collection(cfg.AD_PAYOUT_PERIODS_COLLECTION);

  // Work in the period BEFORE the current one, so it is closed and settleable.
  const current = periodContaining(Date.now());
  const period = periodContaining(current.start.getTime() - 1);
  const mid = new Date(period.start.getTime() + period.end.getTime() >> 1);
  const at = new Date((period.start.getTime() + period.end.getTime()) / 2);

  const idA = new ObjectId();
  const idB = new ObjectId();
  try {
    // Both advertisers pay 50 HBD. A runs a short flight, B a long one — the exact
    // asymmetry that broke the old model.
    await camps.insertMany([
      { _id: idA, name: `${TAG} A`, status: 'running', paidHbd: 50, priceHbd: 50, days: 7,
        startAt: period.start, endAt: new Date(period.start.getTime() + 7 * 864e5),
        slotPercent: 25, deliveredImpressions: 10, createdAt: new Date() },
      { _id: idB, name: `${TAG} B`, status: 'running', paidHbd: 50, priceHbd: 50, days: 90,
        startAt: period.start, endAt: new Date(period.start.getTime() + 90 * 864e5),
        slotPercent: 25, deliveredImpressions: 10, createdAt: new Date() },
    ]);

    // X carries 10 plays of A's spot; Y carries 10 plays of B's. Identical work.
    const rows = [];
    for (let i = 0; i < 10; i++) {
      rows.push({ sid: `${TAG}-x-${i}`, campaignId: idA, owner: 'payout-test-x', permlink: 'vid-x', completed: true, completedAt: at, at, payoutId: null });
      rows.push({ sid: `${TAG}-y-${i}`, campaignId: idB, owner: 'payout-test-y', permlink: 'vid-y', completed: true, completedAt: at, at, payoutId: null });
    }
    await imps.insertMany(rows);

    console.log(`period under test: ${period.key} (${cfg.AD_PAYOUT_PERIOD_DAYS} days)\n`);
    console.log('── accrual is pro rata by time, not by delivery ──');
    const a = accrualFor(await camps.findOne({ _id: idA }), period.start, period.end);
    const b = accrualFor(await camps.findOne({ _id: idB }), period.start, period.end);
    near('short flight accrues its whole fee in the period', a, 50);
    near('long flight accrues only its slice', b, 50 * (cfg.AD_PAYOUT_PERIOD_DAYS / 90));
    console.log(`      A=${a.toFixed(3)} HBD, B=${b.toFixed(3)} HBD over this period`);

    console.log('\n── settle ──');
    const result = await settlePeriod(d, period);
    check('period settled', !!result, true);
    check('20 impressions counted', (await periods.findOne({ _id: period.key })).impressions, 20);

    console.log('\n── the thing that was broken ──');
    const paid = await outs.find({ periodKey: period.key }).toArray();
    const byAccount = Object.fromEntries(paid.map((p) => [p.account, p.hbd]));
    console.log('      ', paid.map((p) => `@${p.account} ${p.hbd} HBD (${p.kind})`).join(', '));
    const x = byAccount['payout-test-x'] || 0;
    const y = byAccount['payout-test-y'] || 0;
    near('creator X and creator Y are paid the SAME', x, y);
    check('  neither was paid nothing', x > 0 && y > 0, true);

    const per = await periods.findOne({ _id: period.key });
    const expectedPool = (a + b) * (cfg.AD_CREATOR_POOL_PCT / 100);
    near('pool is every campaign accrual, not just one', per.poolHbd, expectedPool);
    near('one rate for the whole period', per.ratePerImpression, expectedPool / 20, 0.0001);
    // Neither creator set a share, so the default sends half their pool to their
    // community — but these test videos are in none, so it all lands on the creator.
    near('pool is fully allocated', x + y + (per.carriedOut || 0), expectedPool);

    console.log('\n── idempotence ──');
    const again = await settlePeriod(d, period);
    check('a settled period is not settled twice', again, 'null');
    const after = await outs.find({ periodKey: period.key }).toArray();
    near('amounts unchanged on re-run', after.reduce((s, p) => s + p.hbd, 0), paid.reduce((s, p) => s + p.hbd, 0));

    console.log('\n── nothing was sent ──');
    check('all payouts still pending', after.every((p) => p.status === 'pending'), true);
  } finally {
    await camps.deleteMany({ _id: { $in: [idA, idB] } });
    await imps.deleteMany({ sid: { $regex: `^${TAG}-` } });
    await outs.deleteMany({ account: { $regex: '^payout-test-' } });
    await periods.deleteMany({ _id: period.key });
    console.log('\ncleaned up');
  }
  console.log(fails ? `\n${fails} FAILED` : '\nall checks passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
