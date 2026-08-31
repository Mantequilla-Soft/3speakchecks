#!/usr/bin/env node
/**
 * The community gets its share, including when the local category is missing.
 *
 *   node scripts/test-ad-community-split.cjs
 *
 * The bug this guards: `embed-video.category` is absent on a small share of videos
 * that ARE in a community on chain. Read as "not in a community", the creator was
 * paid 100% and the community nothing — silently, in a settlement that is idempotent
 * and so never revisited. Measured at 99 of 5,453 eligible videos, 20/20 sampled
 * confirmed as real gaps.
 *
 * Hits real Mongo and the real Hive RPC. Creates and removes its own rows.
 */
require('dotenv').config();
const { connectToMongo, getDb } = require('../utils/db');
const { settlePeriod, periodContaining } = require('../services/adPayouts');
const {
  AD_CAMPAIGNS_COLLECTION, AD_IMPRESSIONS_COLLECTION, AD_PAYOUTS_COLLECTION,
  AD_PAYOUT_PERIODS_COLLECTION, AD_CREATOR_PREFS_COLLECTION,
  AD_CREATOR_POOL_PCT, AD_DEFAULT_COMMUNITY_PCT,
} = require('../utils/config');
const { STATES } = require('../utils/adModel');

const MARK = 'test-community-split';
let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${label}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
}

// Two real Hive posts in two different communities, from the measured gap set.
// GAP has no stored category at all; STALE has one that is deliberately wrong.
const GAP = { author: 'meno', permlink: '3speak-1771629120958', community: 'hive-178315' };
const STALE = { author: 'badadib', permlink: '3speak-1771504136355', community: 'hive-181335' };
const CREATOR = 'meno';   // owns both of the above, so the split maths stays simple

// A LEGACY video: no embed-video row at all, so its owner/permlink ARE the Hive
// coordinates. 30.6% of watched inventory is this shape, and 39 of 40 sampled are in
// a community on chain — every one of which resolved to null before the chain lookup,
// because a legacy row's stored category is a plain tag ("general") and never matches.
const LEGACY = { author: 'hiveredcarpet', permlink: 'ozmstwre', community: 'hive-172958' };

(async () => {
  await connectToMongo();
  const db = getDb();
  const camps = db.collection(AD_CAMPAIGNS_COLLECTION);
  const imps = db.collection(AD_IMPRESSIONS_COLLECTION);
  const payouts = db.collection(AD_PAYOUTS_COLLECTION);
  const periods = db.collection(AD_PAYOUT_PERIODS_COLLECTION);
  const ev = db.collection('embed-video');

  const period = periodContaining(Date.now() - 40 * 864e5);
  const cleanup = async () => {
    await camps.deleteMany({ name: MARK });
    await imps.deleteMany({ sid: { $regex: `^${MARK}` } });
    await payouts.deleteMany({ periodKey: period.key });
    await periods.deleteMany({ _id: period.key });
    await ev.deleteMany({ permlink: { $regex: `^${MARK}` } });
    await db.collection(AD_CREATOR_PREFS_COLLECTION).deleteMany({ _id: `${MARK}-creator` });
  };
  await cleanup();

  try {
    const mid = new Date(period.start.getTime() + 864e5);
    const campaign = await camps.insertOne({
      name: MARK, advertiserRef: MARK, hiveAccount: 'testadv', status: STATES.COMPLETE,
      paidHbd: 100, priceHbd: 100,
      startAt: period.start, endAt: period.end, createdAt: period.start,
    });

    // Two videos, 50 impressions each.
    //   -gap    no stored category at all — the shape that used to lose the community
    //   -stale  a stored category that is WRONG, to prove the chain overrides it
    await ev.insertOne({
      owner: CREATOR, permlink: `${MARK}-gap`,
      hive_author: GAP.author, hive_permlink: GAP.permlink, status: 'published',
    });
    await ev.insertOne({
      owner: CREATOR, permlink: `${MARK}-stale`, category: 'hive-999999',
      hive_author: STALE.author, hive_permlink: STALE.permlink, status: 'published',
    });

    const rows = [];
    for (let i = 0; i < 50; i += 1) {
      rows.push({
        sid: `${MARK}-a-${i}`, campaignId: campaign.insertedId, owner: CREATOR,
        permlink: `${MARK}-gap`, completed: true, payoutId: null, completedAt: mid, at: mid,
      });
      rows.push({
        sid: `${MARK}-b-${i}`, campaignId: campaign.insertedId, owner: CREATOR,
        permlink: `${MARK}-stale`, completed: true, payoutId: null, completedAt: mid, at: mid,
      });
      // No embed-video row is created for this one on purpose — that absence IS the
      // legacy case.
      rows.push({
        sid: `${MARK}-c-${i}`, campaignId: campaign.insertedId, owner: LEGACY.author,
        permlink: LEGACY.permlink, completed: true, payoutId: null, completedAt: mid, at: mid,
      });
    }
    await imps.insertMany(rows);

    const result = await settlePeriod(db, period);
    check('the period settled', !!result, true);

    const paid = await payouts.find({ periodKey: period.key }).toArray();
    const byAccount = Object.fromEntries(paid.map((p) => [p.account, p]));
    const accounts = Object.keys(byAccount).sort();
    console.log('   recipients:', accounts.join(', '));

    // 🚨 The fix: a video with NO stored category still pays its community,
    // resolved from the chain.
    check('the MISSING-category community was paid', !!byAccount[GAP.community], true);
    // 🚨 And the chain OVERRIDES a stale stored value rather than trusting our copy.
    check('the stale stored community was NOT paid', !!byAccount['hive-999999'], false);
    check('  the chain community was paid instead', !!byAccount[STALE.community], true);

    // 🚨 A LEGACY video — no embed-video row anywhere — still pays its community.
    // This is the 30.6% of inventory that used to pay nothing at all.
    check('the LEGACY video\'s community was paid', !!byAccount[LEGACY.community], true);

    // The split itself: with the default share, the creator side and the community
    // side each take half of the creator-side pool. Summed by KIND rather than by
    // account, because three videos across two creators all contribute.
    const pool = 100 * (AD_CREATOR_POOL_PCT / 100);
    const sumKind = (k) => paid.filter((p) => p.kind === k).reduce((a, p) => a + p.hbd, 0);
    const communityTotal = sumKind('community');
    const creatorTotal = sumKind('creator');
    check('creators were paid', creatorTotal > 0, true);
    const expectedCommunity = Math.round(pool * (AD_DEFAULT_COMMUNITY_PCT / AD_CREATOR_POOL_PCT) * 1000) / 1000;
    check('communities got the default share of the pool',
      Math.abs(communityTotal - expectedCommunity) < 0.02, true);
    check('creators got the remainder',
      Math.abs(creatorTotal - (pool - expectedCommunity)) < 0.02, true);
    console.log(`   pool ${pool} HBD -> creators ${creatorTotal.toFixed(3)}, communities ${communityTotal.toFixed(3)}`);

    // Kinds are recorded so a transfer memo can say what it is for.
    check('community rows are marked as such', byAccount[GAP.community]?.kind, 'community');
    check('creator row is marked as such', byAccount[CREATOR]?.kind, 'creator');
  } finally {
    await cleanup();
    console.log('\ncleaned up its own rows.');
  }

  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
