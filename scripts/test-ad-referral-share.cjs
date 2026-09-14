#!/usr/bin/env node
/**
 * A referred advertiser pays their referrer out of the PLATFORM's share.
 *
 *   node scripts/test-ad-referral-share.cjs
 *
 * The split becomes 50 creator / 10 viewer / 2 referrer / 38 platform. The
 * things worth asserting are the ones that cost real money when wrong:
 *
 *   - The creator pool does not move. A referrer is paid out of what we keep;
 *     if creators fund it, every creator is quietly underpaid whenever an
 *     advertiser happens to have been referred.
 *   - An account that is BOTH a creator and a referrer in one period gets ONE
 *     row holding BOTH amounts. `ad_payouts` is uniquely indexed on
 *     (periodKey, account), so writing the referral separately would overwrite
 *     the creator row and silently drop one of the two.
 *   - Payouts stay in kind. A HIVE-funded campaign pays its referrer in HIVE;
 *     "2% of 7 HBD worth of HIVE" is not "0.14 HIVE" at any rate but 1:1, and
 *     the whole point of native pools is never to consult a rate.
 *   - A referrer who is not a real Hive account is NOT paid. `referredBy` is a
 *     name somebody typed into a form; broadcasting to it unverified sends
 *     money to a typo, or to whoever squatted the plausible misspelling.
 *
 * Butter Auth is stubbed, so this never calls out and never depends on who is
 * really referred. Creates and removes its own rows, and parks real ones.
 */
require('dotenv').config();
const { connectToMongo, getDb } = require('../utils/db');
const P = require('../services/adPayouts');
const cfg = require('../utils/config');
const { parkRealRows } = require('./_realMoneyGuard.cjs');

let failed = 0;
const check = (l, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${l}${ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`}`);
};

const MARK = 'referral-test';

// Stub Butter Auth and the chain. `deps` is threaded through settlePeriod for
// exactly this: a test must never reach the real broker or broadcast anything.
const stubDeps = (referrerMap, realAccounts) => ({
  referrersFor: async (accounts) => new Map(
    accounts.filter((a) => referrerMap[a]).map((a) => [a, referrerMap[a]]),
  ),
  client: {
    database: {
      getAccounts: async (names) => names
        .filter((n) => realAccounts.includes(n))
        .map((n) => ({ name: n })),
    },
  },
});

(async () => {
  await connectToMongo();
  const db = getDb();
  const camps = db.collection(cfg.AD_CAMPAIGNS_COLLECTION);
  const imps = db.collection(cfg.AD_IMPRESSIONS_COLLECTION);
  const pays = db.collection(cfg.AD_PAYOUTS_COLLECTION);
  const periods = db.collection(cfg.AD_PAYOUT_PERIODS_COLLECTION);

  const clean = async (per) => {
    await camps.deleteMany({ name: MARK });
    await imps.deleteMany({ sid: { $regex: `^${MARK}` } });
    await pays.deleteMany({ periodKey: per.key });
    await periods.deleteMany({ _id: per.key });
  };

  const restore = await parkRealRows(db, cfg);

  const run = async (label, { paidAssets, creator, referrerMap, realAccounts }) => {
    const per = P.periodContaining(Date.now() - 60 * 864e5);
    await clean(per);
    const mid = new Date(per.start.getTime() + (per.end.getTime() - per.start.getTime()) / 2);
    const c = await camps.insertOne({
      name: MARK, advertiserRef: MARK, hiveAccount: 'adv', status: 'complete',
      paidHbd: 100, priceHbd: 100, paidAssets,
      startAt: per.start, endAt: per.end, createdAt: per.start,
    });
    await imps.insertMany([0, 1, 2, 3].map((i) => ({
      sid: `${MARK}-${i}`, campaignId: c.insertedId, owner: creator, permlink: `p${i}`,
      completed: true, payoutId: null, completedAt: mid, at: mid,
    })));
    await P.settlePeriod(db, per, stubDeps(referrerMap, realAccounts));
    const rows = await pays.find({ periodKey: per.key }).toArray();
    const period = await periods.findOne({ _id: per.key });
    console.log(`\n-- ${label} --`);
    return { rows, period, per, clean: () => clean(per) };
  };

  try {
    // 100 HBD campaign. creator 50, viewer 10, referrer 2, platform 38.
    {
      const { rows, period, clean: done } = await run('referred advertiser, plain case', {
        paidAssets: { HBD: 100 }, creator: 'creatorx',
        referrerMap: { adv: 'refbob' }, realAccounts: ['refbob'],
      });
      const creator = rows.find((r) => r.account === 'creatorx');
      const ref = rows.find((r) => r.account === 'refbob');
      check('creator still gets the full 50', creator.hbd, 50);
      check('referrer gets 2', ref && ref.hbd, 2);
      check('  and is marked as such', ref.kind, 'referral');
      check('  paid in the asset the advertiser sent', ref.amounts, [{ symbol: 'HBD', amount: 2 }]);
      check('viewer pool untouched at 10', period.viewerPoolHbd, 10);
      check('period records the referral pool', period.referralPoolHbd, 2);
      await done();
    }

    // The row-clobber case: the creator IS the referrer.
    {
      const { rows, clean: done } = await run('creator and referrer are the same account', {
        paidAssets: { HBD: 100 }, creator: 'refbob',
        referrerMap: { adv: 'refbob' }, realAccounts: ['refbob'],
      });
      const mine = rows.filter((r) => r.account === 'refbob');
      check('exactly one row, not two', mine.length, 1);
      check('  holding creator + referral together', mine[0].hbd, 52);
      check('  legs merged, not replaced', mine[0].amounts, [{ symbol: 'HBD', amount: 52 }]);
      check('  kind names both reasons', mine[0].kind, 'creator+referral');
      await done();
    }

    // In kind: a HIVE-funded campaign pays its referrer in HIVE.
    {
      const { rows, clean: done } = await run('funded entirely in HIVE', {
        paidAssets: { HIVE: 400 }, creator: 'creatorx',
        referrerMap: { adv: 'refbob' }, realAccounts: ['refbob'],
      });
      const ref = rows.find((r) => r.account === 'refbob');
      check('referrer paid in HIVE, not HBD', ref.amounts, [{ symbol: 'HIVE', amount: 8 }]);
      check('  HBD-equivalent still recorded', ref.hbd, 2);
      await done();
    }

    // The guard that stops a typo becoming a transfer.
    {
      const { rows, period, clean: done } = await run('referrer is not a real Hive account', {
        paidAssets: { HBD: 100 }, creator: 'creatorx',
        referrerMap: { adv: 'ghostwhodoesnotexist' }, realAccounts: [],
      });
      check('nobody is paid the referral', rows.some((r) => r.account === 'ghostwhodoesnotexist'), false);
      check('creator is unaffected', rows.find((r) => r.account === 'creatorx').hbd, 50);
      check('and it is recorded as skipped', period.referralSkipped[0].why, 'no_such_account');
      await done();
    }

    // An unreferred advertiser changes nothing at all.
    {
      const { rows, period, clean: done } = await run('advertiser was never referred', {
        paidAssets: { HBD: 100 }, creator: 'creatorx',
        referrerMap: {}, realAccounts: [],
      });
      check('only the creator is paid', rows.map((r) => r.account), ['creatorx']);
      check('no referral pool', period.referralPoolHbd, 0);
      await done();
    }
  } finally {
    await restore();
  }

  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
