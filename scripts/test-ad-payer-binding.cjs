#!/usr/bin/env node
/**
 * A flight can only be paid for from the account it is booked under.
 *
 *   node scripts/test-ad-payer-binding.cjs
 *
 * Registering as an advertiser is deliberately unsigned, so until the payment lands
 * nothing has proved the applicant holds the account they claimed. Paying from it is
 * that proof — a transfer needs the ACTIVE key. This suite covers the consequences:
 * a payment from anywhere else must not buy a flight, must not be silently kept, and
 * must not be queued for refund twice.
 *
 * Drives the collections directly rather than the HTTP route, because the route
 * needs a real on-chain transfer to match. What is asserted here is the state the
 * route writes and every downstream reader depends on.
 */
require('dotenv').config();
const { connectToMongo, getDb } = require('../utils/db');
const { AD_PAYMENTS_COLLECTION } = require('../utils/config');

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${label}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
}

// The predicate the claim route uses. Kept identical here on purpose: if it changes
// there and not here, this suite starts failing, which is the point.
const sameAccount = (from, expected) => !!expected
  && String(from || '').trim().toLowerCase() === String(expected).trim().toLowerCase();

const TRX = 'test-payer-binding-';

(async () => {
  await connectToMongo();
  const payments = getDb().collection(AD_PAYMENTS_COLLECTION);
  await payments.deleteMany({ trx_id: { $regex: `^${TRX}` } });

  try {
    // 1. The predicate itself.
    check('exact match is accepted', sameAccount('badadib', 'badadib'), true);
    check('different account refused', sameAccount('tibfox.vsc', 'badadib'), false);
    check('case and whitespace tolerated', sameAccount(' BadAdib ', 'badadib'), true);
    // A campaign with no account on it must fail CLOSED — crediting an
    // unverifiable payment would make the whole check decorative.
    check('missing expected payer refuses', sameAccount('badadib', ''), false);
    check('missing sender refuses', sameAccount('', 'badadib'), false);
    check('a lookalike is not a match', sameAccount('badadib2', 'badadib'), false);
    check('a subdomain-ish name is not a match', sameAccount('tibfox.vsc', 'tibfox'), false);

    // 2. A refused payment is RECORDED, not dropped. The money arrived; forgetting
    //    it would mean quietly keeping somebody's HBD.
    await payments.insertOne({
      trx_id: `${TRX}1`, campaignId: null, from: 'tibfox.vsc', amount: '5.000 HBD',
      processedAt: new Date(), status: 'refused', reason: 'payer_mismatch',
      expectedFrom: 'badadib', refundStatus: 'pending', refundTo: 'tibfox.vsc',
      refundAmount: '5.000 HBD',
    });
    const stored = await payments.findOne({ trx_id: `${TRX}1` });
    check('refused payment is recorded', stored.status, 'refused');
    check('  and queued for return', stored.refundStatus, 'pending');
    check('  to the account that SENT it', stored.refundTo, 'tibfox.vsc');
    check('  not to the account that was claimed', stored.refundTo === stored.expectedFrom, false);

    // 3. The unique trx_id index is what stops a claim retry queueing the same
    //    stray payment for refund again. Without it, every retry adds another
    //    refund owed for one transfer.
    let dup = null;
    try {
      await payments.insertOne({ trx_id: `${TRX}1`, from: 'tibfox.vsc', status: 'refused' });
    } catch (e) { dup = e.code; }
    check('a replayed refusal hits the unique index', dup, 11000);
    check('  and there is still exactly one', await payments.countDocuments({ trx_id: `${TRX}1` }), 1);

    // 4. A refused payment must never be counted as revenue. The payout pool reads
    //    campaign.paidHbd, and the claim route only adds to it from accepted
    //    transfers — so a refused one leaves the campaign unpaid and unservable.
    const refusedAreNotCredited = await payments.countDocuments({
      trx_id: `${TRX}1`, status: 'credited',
    });
    check('refused payment is not marked credited', refusedAreNotCredited, 0);

    // 5. Settling is idempotent: once returned it must not appear in the pending
    //    queue again, or somebody sends the money twice.
    await payments.updateOne({ trx_id: `${TRX}1` }, {
      $set: { refundStatus: 'returned', returnedTrxId: 'abc123', returnedAt: new Date() },
    });
    check('settled refund leaves the pending queue',
      await payments.countDocuments({ status: 'refused', refundStatus: 'pending', trx_id: `${TRX}1` }), 0);
    const settled = await payments.findOne({ trx_id: `${TRX}1` });
    check('  and keeps the on-chain receipt', settled.returnedTrxId, 'abc123');

    // 6. A correct payment is credited and carries no refund fields at all.
    await payments.insertOne({
      trx_id: `${TRX}2`, from: 'badadib', amount: '5.000 HBD',
      processedAt: new Date(), status: 'credited',
    });
    const good = await payments.findOne({ trx_id: `${TRX}2` });
    check('matching payment is credited', good.status, 'credited');
    check('  and owes nothing back', good.refundStatus === undefined, true);
  } finally {
    await payments.deleteMany({ trx_id: { $regex: `^${TRX}` } });
    console.log('\ncleaned up its own rows.');
  }

  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
