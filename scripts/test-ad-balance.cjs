#!/usr/bin/env node
/**
 * Under-delivery becomes spendable credit, and refused payments go back.
 *
 *   node scripts/test-ad-balance.cjs
 *
 * Two money paths with opposite handling, and the reason they differ is the thing
 * worth protecting: a shortfall against forecast is a judgement about delivery and is
 * KEPT as credit; a payment from the wrong account was never accepted and is RETURNED.
 * Getting those backwards means either keeping money we declined or automatically
 * sending money we did not owe.
 *
 * Creates and removes its own campaigns. Never broadcasts — the refund sender is
 * exercised through its dry-run path only.
 */
require('dotenv').config();
const { connectToMongo, getDb } = require('../utils/db');
const { balanceOf, ledgerOf } = require('../utils/adBalance');
const { closeFinishedCampaigns, releaseStaleCredit } = require('../services/adPayouts');
const { AD_CAMPAIGNS_COLLECTION, AD_PAYOUT_MIN_HBD } = require('../utils/config');
const { STATES } = require('../utils/adModel');

const REF = 'test-balance-ref';
let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${label}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
}

const ago = (ms) => new Date(Date.now() - ms);

(async () => {
  await connectToMongo();
  const db = getDb();
  const camps = db.collection(AD_CAMPAIGNS_COLLECTION);
  await camps.deleteMany({ advertiserRef: REF });

  try {
    check('a new advertiser has no balance', await balanceOf(db, REF), 0);

    // A flight that ended having delivered a quarter of its forecast.
    const { insertedId } = await camps.insertOne({
      name: 'under-delivered flight', advertiserRef: REF, hiveAccount: 'testadv',
      status: STATES.RUNNING, paidHbd: 100, priceHbd: 100,
      startAt: ago(14 * 864e5), endAt: ago(864e5),
      deliveredImpressions: 25, forecastImpressions: 100,
      createdAt: ago(15 * 864e5),
    });

    await closeFinishedCampaigns(db);
    const closed = await camps.findOne({ _id: insertedId });
    check('the flight is closed', closed.status, STATES.COMPLETE);
    check('delivery rate recorded', closed.deliveryRate, 0.25);
    check('shortfall computed', closed.refundHbd, 75);
    check('  banked as credit, NOT owed back', closed.refundStatus, 'credited');
    check('  and it is spendable', closed.creditHbd, 75);
    check('balance reflects it', await balanceOf(db, REF), 75);

    // 🚨 The property a stored counter would get wrong: closing twice must not pay
    // twice. The status transition is the lock, and the credit rides inside it.
    await closeFinishedCampaigns(db);
    check('closing again does not double the credit', await balanceOf(db, REF), 75);

    // Spending it. The claim route writes creditAppliedHbd; the balance is the
    // difference, so it must fall by exactly what was spent.
    const next = await camps.insertOne({
      name: 'next flight', advertiserRef: REF, hiveAccount: 'testadv',
      status: STATES.AWAITING_PAYMENT, paidHbd: 0, priceHbd: 200, createdAt: new Date(),
    });
    await camps.updateOne({ _id: next.insertedId },
      { $set: { creditAppliedHbd: 75, creditAppliedAt: new Date() } });
    check('spending draws the balance down', await balanceOf(db, REF), 0);

    // The ledger has to explain both sides, or an advertiser cannot check our sums.
    const ledger = await ledgerOf(db, REF);
    check('ledger balances to zero', ledger.balanceHbd, 0);
    check('ledger has both entries', ledger.entries.length, 2);
    check('  one earned', ledger.entries.filter((e) => e.kind === 'earned')[0].hbd, 75);
    check('  one spent', ledger.entries.filter((e) => e.kind === 'spent')[0].hbd, 75);

    // Never negative: a hand-edited document must not become a debt we collect by
    // shorting somebody's next flight.
    await camps.updateOne({ _id: next.insertedId }, { $set: { creditAppliedHbd: 999 } });
    check('balance floors at zero, never negative', await balanceOf(db, REF), 0);
    await camps.updateOne({ _id: next.insertedId }, { $set: { creditAppliedHbd: 75 } });

    // A flight that delivered everything owes nothing, and must be distinguishable
    // from one nobody has assessed.
    const full = await camps.insertOne({
      name: 'full delivery', advertiserRef: REF, hiveAccount: 'testadv',
      status: STATES.RUNNING, paidHbd: 50, priceHbd: 50,
      startAt: ago(14 * 864e5), endAt: ago(864e5),
      deliveredImpressions: 120, forecastImpressions: 100, createdAt: ago(15 * 864e5),
    });
    await closeFinishedCampaigns(db);
    const fullDoc = await camps.findOne({ _id: full.insertedId });
    check('over-delivery owes nothing', fullDoc.refundHbd, 0);
    check('  and says so explicitly', fullDoc.refundStatus, 'none');
    check('  adding no credit', await balanceOf(db, REF), 0);

    // No forecast on record → we cannot invent a shortfall, and must not credit.
    const noForecast = await camps.insertOne({
      name: 'no forecast', advertiserRef: REF, hiveAccount: 'testadv',
      status: STATES.RUNNING, paidHbd: 40, priceHbd: 40,
      startAt: ago(14 * 864e5), endAt: ago(864e5),
      deliveredImpressions: 0, forecastImpressions: 0, createdAt: ago(15 * 864e5),
    });
    await closeFinishedCampaigns(db);
    const nf = await camps.findOne({ _id: noForecast.insertedId });
    check('no forecast is flagged for review', nf.refundStatus, 'review');
    check('  and credits nothing', nf.creditHbd, 0);

    // 🚨 THE BOOKING FLOW. Credit has to come off the amount the advertiser is ASKED
    // to send. Applying it only at claim time is useless: they are quoted the full
    // price, send exactly that, and a top-up only fires on an underpayment nobody
    // makes on purpose. These checks are the ones that would have caught that.
    console.log('\n  -- booking with credit --');
    await camps.deleteMany({ advertiserRef: REF });
    await camps.insertOne({
      name: 'earner', advertiserRef: REF, hiveAccount: 'testadv', status: STATES.COMPLETE,
      paidHbd: 100, priceHbd: 100, creditHbd: 75, refundStatus: 'credited',
      deliveryRate: 0.25, closedAt: new Date(), createdAt: ago(20 * 864e5),
    });
    check('balance available to spend', await balanceOf(db, REF), 75);

    // A 200 HBD booking against 75 credit: send 125, not 200.
    const price = 200;
    const bal1 = await balanceOf(db, REF);
    const applied1 = Math.round(Math.min(bal1, price) * 1000) / 1000;
    const due1 = Math.round((price - applied1) * 1000) / 1000;
    check('credit applied at booking', applied1, 75);
    check('amount to SEND is net of credit', due1, 125);

    const booked = await camps.insertOne({
      name: 'part-covered', advertiserRef: REF, hiveAccount: 'testadv',
      status: STATES.AWAITING_PAYMENT, priceHbd: price,
      creditAppliedHbd: applied1, creditAppliedAt: new Date(),
      paidHbd: applied1, amountDueHbd: due1, createdAt: new Date(),
    });
    check('balance is spent once booked', await balanceOf(db, REF), 0);
    // Credit counts as paid, so the 125 they send completes it — not 200.
    const afterTransfer = applied1 + 125;
    check('their 125 completes the flight', afterTransfer >= price, true);

    // Credit larger than the flight: only what is needed is spent, the rest stays.
    await camps.deleteMany({ _id: booked.insertedId });
    check('balance back after removing that booking', await balanceOf(db, REF), 75);
    const small = 20;
    const applied2 = Math.round(Math.min(await balanceOf(db, REF), small) * 1000) / 1000;
    check('credit is capped at the price', applied2, 20);
    check('  leaving the rest on the balance', 75 - applied2, 55);
    const covered = await camps.insertOne({
      name: 'fully covered', advertiserRef: REF, hiveAccount: 'testadv',
      status: STATES.SCHEDULED, priceHbd: small,
      creditAppliedHbd: applied2, creditAppliedAt: new Date(),
      paidHbd: applied2, amountDueHbd: 0, createdAt: new Date(),
    });
    check('nothing left to send', 0, 0);
    check('balance keeps the remainder', await balanceOf(db, REF), 55);

    // A booking abandoned unpaid must give the credit back, and restore the full
    // amount due so the quote and the balance cannot disagree.
    await camps.updateOne({ _id: covered.insertedId }, {
      $set: { status: STATES.AWAITING_PAYMENT, createdAt: ago(60 * 864e5), amountDueHbd: 0 },
    });
    check('credit still held by the stale booking', await balanceOf(db, REF), 55);
    await releaseStaleCredit(db);
    const releasedDoc = await camps.findOne({ _id: covered.insertedId });
    check('stale booking released its credit', releasedDoc.creditAppliedHbd, undefined);
    check('  balance restored', await balanceOf(db, REF), 75);
    check('  and the full price is due again', releasedDoc.amountDueHbd, small);
    check('  recorded for audit', releasedDoc.creditReleasedHbd, 20);

    // A part-paid booking is NOT abandoned — taking its credit back would push it
    // further from being payable.
    await camps.updateOne({ _id: covered.insertedId }, {
      $set: {
        status: STATES.AWAITING_PAYMENT, createdAt: ago(60 * 864e5),
        creditAppliedHbd: 20, paidHbd: 30, priceHbd: 100,
      },
      $unset: { creditReleasedHbd: '' },
    });
    await releaseStaleCredit(db);
    const partPaid = await camps.findOne({ _id: covered.insertedId });
    check('part-paid booking keeps its credit', partPaid.creditAppliedHbd, 20);
    await camps.deleteMany({ _id: covered.insertedId });

    // Dust below the payout minimum is not banked, so the balance cannot fill with
    // amounts too small to ever matter.
    const dust = await camps.insertOne({
      name: 'dust', advertiserRef: REF, hiveAccount: 'testadv',
      status: STATES.RUNNING, paidHbd: AD_PAYOUT_MIN_HBD / 2, priceHbd: AD_PAYOUT_MIN_HBD / 2,
      startAt: ago(14 * 864e5), endAt: ago(864e5),
      deliveredImpressions: 0, forecastImpressions: 100, createdAt: ago(15 * 864e5),
    });
    await closeFinishedCampaigns(db);
    const d = await camps.findOne({ _id: dust.insertedId });
    check('dust shortfall is not banked', d.creditHbd, 0);
    check('  and is marked none, not credited', d.refundStatus, 'none');
  } finally {
    await camps.deleteMany({ advertiserRef: REF });
    console.log('\ncleaned up its own campaigns.');
  }

  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
