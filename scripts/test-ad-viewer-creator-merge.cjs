#!/usr/bin/env node
/**
 * An account paid as a viewer AND as a creator (or referrer) in one period gets
 * BOTH amounts, in one row.
 *
 *   node scripts/test-ad-viewer-creator-merge.cjs
 *
 * 🚨 The bug this pins: `ad_payouts` is unique on (periodKey, account), and
 * payViewers() used to write its rows with a `$set` upsert of its own, AFTER
 * settlePeriod had written the creator rows. Anyone who both made videos and
 * watched them lost the creator row to the viewer row before payPending sent
 * it. Found 2026-10-06: 48 creators, @tibfox's whole creator share among them.
 * The no-impressions branch had the mirror image: the referral write replaced
 * the viewer row of a referrer who also watched.
 *
 * Butter Auth and the chain are stubbed. Creates and removes its own rows, and
 * parks real ones so no live account can be swept into a synthetic pool.
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

const MARK = 'vmtest';
const r3 = (n) => Math.round(n * 1000) / 1000;

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
  const watch = db.collection(cfg.AD_VIEWER_WATCH_COLLECTION);
  const pays = db.collection(cfg.AD_PAYOUTS_COLLECTION);
  const periods = db.collection(cfg.AD_PAYOUT_PERIODS_COLLECTION);

  // 100 HBD in the period: creators 50, viewers AD_VIEWER_POOL_PCT, referrer 2.
  const VIEWER_POOL = r3(100 * (cfg.AD_VIEWER_POOL_PCT / 100));

  const clean = async (per) => {
    await camps.deleteMany({ name: MARK });
    await imps.deleteMany({ sid: { $regex: `^${MARK}` } });
    await watch.deleteMany({ viewer: { $regex: `^${MARK}-` } });
    await pays.deleteMany({ periodKey: per.key });
    await periods.deleteMany({ _id: per.key });
  };

  // Real rows this run must not add to. A before/after count, not "none at all":
  // real accounts have genuine paid rows already.
  const realRows = () => pays.countDocuments({ account: { $not: new RegExp(`^${MARK}-`) } });
  const realBefore = await realRows();
  const restore = await parkRealRows(db, cfg);

  const run = async (label, { creator, impressions, viewers, referrerMap = {}, realAccounts = [] }) => {
    const per = P.periodContaining(Date.now() - 60 * 864e5);
    await clean(per);
    const mid = new Date(per.start.getTime() + (per.end.getTime() - per.start.getTime()) / 2);
    const c = await camps.insertOne({
      name: MARK, advertiserRef: MARK, hiveAccount: `${MARK}-adv`, status: 'complete',
      paidHbd: 100, priceHbd: 100, paidAssets: { HBD: 100 },
      startAt: per.start, endAt: per.end, createdAt: per.start,
    });
    if (impressions) {
      await imps.insertMany([...Array(impressions).keys()].map((i) => ({
        sid: `${MARK}-${i}`, campaignId: c.insertedId, owner: creator, permlink: `p${i}`,
        completed: true, payoutId: null, completedAt: mid, at: mid,
      })));
    }
    await watch.insertMany(viewers.map(([viewer, secs], i) => ({
      viewer, owner: `${MARK}-someoneelse`, permlink: `w${i}`, watchedPct: 90,
      contentSeconds: secs, at: mid, payoutId: null,
    })));
    await P.settlePeriod(db, per, stubDeps(referrerMap, realAccounts));
    const rows = await pays.find({ periodKey: per.key }).toArray();
    console.log(`\n-- ${label} --`);
    return { rows, clean: () => clean(per) };
  };

  try {
    // The tibfox case: creator of the impressions AND the only viewer.
    {
      const me = `${MARK}-tib`;
      const { rows, clean: done } = await run('creator who also watched', {
        creator: me, impressions: 4, viewers: [[me, 600]],
      });
      const mine = rows.filter((r) => r.account === me);
      check('exactly one row', mine.length, 1);
      check('  holding creator 50 + the whole viewer pool', mine[0] && mine[0].hbd, r3(50 + VIEWER_POOL));
      check('  legs merged, not replaced', mine[0] && mine[0].amounts, [{ symbol: 'HBD', amount: r3(50 + VIEWER_POOL) }]);
      check('  kind names both reasons', mine[0] && mine[0].kind, 'creator+viewer');
      await done();
    }

    // A creator and a separate viewer: nothing merges that should not.
    {
      const cr = `${MARK}-cr`; const vw = `${MARK}-vw`;
      const { rows, clean: done } = await run('creator and viewer are different accounts', {
        creator: cr, impressions: 4, viewers: [[vw, 600]],
      });
      const by = Object.fromEntries(rows.map((r) => [r.account, [r.hbd, r.kind]]));
      check('creator paid 50 as creator', by[cr], [50, 'creator']);
      check('viewer paid the pool as viewer', by[vw], [VIEWER_POOL, 'viewer']);
      await done();
    }

    // Two viewers splitting the pool, one of them also the creator.
    {
      const me = `${MARK}-tib`; const other = `${MARK}-vw`;
      const { rows, clean: done } = await run('creator-viewer shares the viewer pool', {
        creator: me, impressions: 2, viewers: [[me, 300], [other, 900]],
      });
      const by = Object.fromEntries(rows.map((r) => [r.account, r.hbd]));
      check('creator-viewer gets 50 + a quarter of the pool', by[me], r3(50 + VIEWER_POOL / 4));
      check('other viewer gets three quarters', by[other], r3(VIEWER_POOL * 3 / 4));
      await done();
    }

    // No impressions at all: the referral write used to replace the viewer row.
    {
      const me = `${MARK}-ref`;
      const { rows, clean: done } = await run('no impressions, referrer who also watched', {
        creator: null, impressions: 0, viewers: [[me, 600]],
        referrerMap: { [`${MARK}-adv`]: me }, realAccounts: [me],
      });
      const mine = rows.filter((r) => r.account === me);
      check('exactly one row', mine.length, 1);
      check('  holding referral 2 + the viewer pool', mine[0] && mine[0].hbd, r3(2 + VIEWER_POOL));
      check('  kind names both reasons', mine[0] && mine[0].kind, 'referral+viewer');
      await done();
    }

    // payViewers on its own still writes its rows (the standalone contract).
    {
      const per = P.periodContaining(Date.now() - 60 * 864e5);
      await clean(per);
      const vw = `${MARK}-solo`;
      await watch.insertOne({ viewer: vw, owner: `${MARK}-x`, permlink: 'p', watchedPct: 90, contentSeconds: 100, at: new Date(), payoutId: null });
      const res = await P.payViewers(db, per, 5);
      const row = await pays.findOne({ periodKey: per.key, account: vw });
      console.log('\n-- payViewers standalone --');
      check('writes its own row when not deferred', row && [row.hbd, row.kind], [5, 'viewer']);
      check('  and returns it', res.rows.map((r) => r.account), [vw]);
      await clean(per);
    }

    check('no real account was paid by this test', await realRows(), realBefore);
  } finally {
    await restore();
  }

  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
