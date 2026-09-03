#!/usr/bin/env node
/**
 * When Hive is unreachable, a period must NOT settle.
 *
 *   node scripts/test-ad-community-rpc-down.cjs
 *
 * This is the safety property behind the community lookup. Settlement is idempotent
 * and stamps `payoutId` on the impressions it pays, so it is never revisited — which
 * means a wrong split is permanent. If we cannot find out which community a video
 * belongs to, the only safe answer is to settle nothing and try again later. The
 * failure mode being prevented is `hiveRpcBatch` returning [] on total RPC failure
 * and that being read as "none of these posts are in a community", quietly paying
 * every community's share to the creator.
 *
 * Runs in its own process because it stubs the RPC module BEFORE adPayouts loads —
 * adPayouts destructures the function at require time.
 */
require('dotenv').config();

// The stub must be in place before services/adPayouts is required.
const hiveMod = require('../utils/hive');
hiveMod.hiveRpcBatch = async () => [];   // every endpoint down

const { connectToMongo, getDb } = require('../utils/db');
const { settlePeriod, periodContaining } = require('../services/adPayouts');
const {
  AD_CAMPAIGNS_COLLECTION, AD_IMPRESSIONS_COLLECTION, AD_PAYOUTS_COLLECTION,
  AD_PAYOUT_PERIODS_COLLECTION,
} = require('../utils/config');
const { STATES } = require('../utils/adModel');
const cfg = require('../utils/config');
const { parkRealRows } = require('./_realMoneyGuard.cjs');

const MARK = 'test-rpc-down';
let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${label}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
}

(async () => {
  await connectToMongo();
  const db = getDb();
  const period = periodContaining(Date.now() - 47 * 864e5);
  const cleanup = async () => {
    await db.collection(AD_CAMPAIGNS_COLLECTION).deleteMany({ name: MARK });
    await db.collection(AD_IMPRESSIONS_COLLECTION).deleteMany({ sid: { $regex: `^${MARK}` } });
    await db.collection(AD_PAYOUTS_COLLECTION).deleteMany({ periodKey: period.key });
    await db.collection(AD_PAYOUT_PERIODS_COLLECTION).deleteMany({ _id: period.key });
    await db.collection('embed-video').deleteMany({ permlink: { $regex: `^${MARK}` } });
  };
  await cleanup();

  // Settlement has no date filter on viewer rows by design, so a synthetic pool here
  // would reach real accounts. See scripts/_realMoneyGuard.cjs — this has bitten twice.
  const restoreRealRows = await parkRealRows(db, cfg);
  try {
    const mid = new Date(period.start.getTime() + 864e5);
    const campaign = await db.collection(AD_CAMPAIGNS_COLLECTION).insertOne({
      name: MARK, advertiserRef: MARK, hiveAccount: 'testadv', status: STATES.COMPLETE,
      paidHbd: 100, priceHbd: 100, startAt: period.start, endAt: period.end, createdAt: period.start,
    });
    // No stored category, but a Hive post exists — so the chain must be consulted,
    // and the chain is down.
    await db.collection('embed-video').insertOne({
      owner: 'meno', permlink: `${MARK}-gap`,
      hive_author: 'meno', hive_permlink: '3speak-1771629120958', status: 'published',
    });
    await db.collection(AD_IMPRESSIONS_COLLECTION).insertMany(
      Array.from({ length: 10 }, (_, i) => ({
        sid: `${MARK}-${i}`, campaignId: campaign.insertedId, owner: 'meno',
        permlink: `${MARK}-gap`, completed: true, payoutId: null, completedAt: mid, at: mid,
      })),
    );

    const result = await settlePeriod(db, period);
    check('settlement declined', result, null);
    check('no payouts were written',
      await db.collection(AD_PAYOUTS_COLLECTION).countDocuments({ periodKey: period.key }), 0);
    check('the period was NOT marked settled',
      await db.collection(AD_PAYOUT_PERIODS_COLLECTION).countDocuments({ _id: period.key }), 0);
    // The impressions must stay unclaimed or the retry would never find them again.
    check('impressions remain unpaid and retryable',
      await db.collection(AD_IMPRESSIONS_COLLECTION)
        .countDocuments({ sid: { $regex: `^${MARK}` }, payoutId: null }), 10);
  } finally {
    await restoreRealRows();
    await cleanup();
    console.log('\ncleaned up its own rows.');
  }

  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
