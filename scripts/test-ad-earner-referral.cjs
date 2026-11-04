#!/usr/bin/env node
/**
 * The earner referral bonus (owner, 2026-11-04).
 *
 *   node scripts/test-ad-earner-referral.cjs
 *
 * Whoever referred a user (link or invite only) gets 10% of that user's own
 * creator/viewer/listener payouts for their first 90 days, PAID ON TOP by the
 * platform. What is asserted is what costs real money when wrong:
 *
 *   - The earner keeps 100%: their rows are never reduced.
 *   - Typed (pre-2026-11) referrals pay nothing; link and invite referrals pay.
 *   - Single level: community and referral rows are never a basis.
 *   - Outside the 90-day window: nothing.
 *   - Referrer must be a real, unblocked Hive account and not the earner.
 *   - Never more than the platform has left (all bonuses scaled down together).
 *   - Native assets: a HIVE-paid earner yields a HIVE bonus.
 *   - Butter Auth: only link/invite sources reach the 2% advertiser referral.
 *
 * Pure: no Mongo, no Butter Auth, no chain. Everything is stubbed, so nothing is
 * written and nothing can be broadcast.
 */
process.env.AD_EARNER_REFERRAL_PCT = '10';
process.env.AD_EARNER_REFERRAL_DAYS = '90';
process.env.BUTRAUTH_CLIENT_ID = 'test-client';
process.env.BUTRAUTH_CLIENT_SECRET = 'test-secret';

const P = require('../services/adPayouts');
const { referrersFor, referralsFor } = require('../services/adReferrals');

let failed = 0;
const check = (l, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${l}${ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`}`);
};

const DAY = 864e5;
const period = { key: 'test-period', start: new Date('2026-11-01T00:00:00Z'), end: new Date('2026-11-04T00:00:00Z') };
const daysBefore = (n) => new Date(period.start.getTime() - n * DAY);

const fakeDb = (blocked = []) => ({
  collection: () => ({ find: () => ({ toArray: async () => blocked.map((username) => ({ username })) }) }),
});
const deps = (refs, real) => ({
  referralsFor: async (accounts) => new Map(accounts.filter((a) => refs[a]).map((a) => [a, refs[a]])),
  client: { database: { getAccounts: async (names) => names.filter((n) => real.includes(n)).map((name) => ({ name })) } },
});
const row = (account, kind, hbd, legs) => ({ account, kind, hbd, amounts: legs || [{ symbol: 'HBD', amount: hbd }] });
const byAcct = (rows) => Object.fromEntries(rows.map((r) => [r.account, r]));

(async () => {
  console.log('earner bonus:');
  {
    const earner = [
      row('newbie', 'creator', 1.0),
      row('newbie', 'viewer', 0.5),
      row('newbie', 'listener-audio', 0.3),
      row('newbie', 'listener-podcast', 0.2),
    ];
    const before = JSON.stringify(earner);
    const b = await P.planEarnerReferralBonus(fakeDb(), earner, period, 100,
      deps({ newbie: { referrer: 'alice', source: 'link', referredAt: daysBefore(10) } }, ['alice']));
    check('link referral pays 10% of creator+viewer+listener', b.rows.map((r) => [r.account, r.hbd, r.kind]), [['alice', 0.2, 'earner-referral']]);
    check('paid in HBD legs', b.rows[0].amounts, [{ symbol: 'HBD', amount: 0.2 }]);
    check('earner rows untouched (earner keeps 100%)', JSON.stringify(earner), before);
    check('poolHbd', b.poolHbd, 0.2);
  }
  {
    const earner = [row('a1', 'creator', 1), row('a2', 'creator', 1), row('a3', 'creator', 1)];
    const b = await P.planEarnerReferralBonus(fakeDb(), earner, period, 100, deps({
      a1: { referrer: 'chatgpt', source: 'typed', referredAt: daysBefore(5) },
      a2: { referrer: 'bob', source: 'invite', referredAt: daysBefore(5) },
      a3: { referrer: 'carl', source: null, referredAt: daysBefore(5) },
    }, ['chatgpt', 'bob', 'carl']));
    check('typed and unknown sources pay nothing, invite pays', b.rows.map((r) => r.account), ['bob']);
    check('skips record why', b.skipped.map((s) => s.why).sort(), ['source_typed', 'source_unknown']);
  }
  {
    const earner = [row('n1', 'community', 5), row('n1', 'referral', 5), row('n1', 'earner-referral', 5), row('n1', 'encoder', 5)];
    const b = await P.planEarnerReferralBonus(fakeDb(), earner, period, 100,
      deps({ n1: { referrer: 'alice', source: 'link', referredAt: daysBefore(1) } }, ['alice']));
    check('single level: community/referral/bonus/encoder rows are no basis', b.rows, []);
  }
  {
    const earner = [row('old', 'creator', 1), row('edge', 'creator', 1), row('fresh', 'creator', 1)];
    const b = await P.planEarnerReferralBonus(fakeDb(), earner, period, 100, deps({
      old: { referrer: 'alice', source: 'link', referredAt: daysBefore(100) },
      edge: { referrer: 'bob', source: 'link', referredAt: daysBefore(90) },
      fresh: { referrer: 'carl', source: 'link', referredAt: daysBefore(89) },
    }, ['alice', 'bob', 'carl']));
    check('90-day window: period starting on/after day 90 pays nothing', b.rows.map((r) => r.account), ['carl']);
  }
  {
    const earner = [row('e1', 'creator', 1), row('e2', 'creator', 1), row('e3', 'creator', 1), row('e4', 'creator', 1)];
    const b = await P.planEarnerReferralBonus(fakeDb(['blockedguy']), earner, period, 100, deps({
      e1: { referrer: 'ghost', source: 'link', referredAt: daysBefore(1) },
      e2: { referrer: 'blockedguy', source: 'link', referredAt: daysBefore(1) },
      e3: { referrer: 'e3', source: 'link', referredAt: daysBefore(1) },
      e4: { referrer: 'e4ref', source: 'link', referredAt: null },
    }, ['blockedguy', 'e3', 'e4ref']));
    check('no such account / blocked / self / no date: nothing paid', b.rows, []);
    check('skip reasons', b.skipped.map((s) => s.why).sort(), ['no_date', 'no_such_account', 'reward_blocked', 'self']);
  }
  {
    const earner = [row('m1', 'creator', 10), row('m2', 'viewer', 10)];
    const b = await P.planEarnerReferralBonus(fakeDb(), earner, period, 1, deps({
      m1: { referrer: 'alice', source: 'link', referredAt: daysBefore(1) },
      m2: { referrer: 'bob', source: 'link', referredAt: daysBefore(1) },
    }, ['alice', 'bob']));
    check('capped at platform room: 2 HBD wanted, 1 HBD room', b.poolHbd <= 1, true);
    check('scaled evenly', b.rows.map((r) => [r.account, r.hbd]).sort(), [['alice', 0.5], ['bob', 0.5]]);
    check('scale factor recorded', b.scaled, 0.5);
  }
  {
    const b = await P.planEarnerReferralBonus(fakeDb(), [row('z', 'creator', 1)], period, 0,
      deps({ z: { referrer: 'alice', source: 'link', referredAt: daysBefore(1) } }, ['alice']));
    check('no platform room (no shown ads): nothing', b.rows, []);
  }
  {
    const earner = [row('h', 'creator', 2, [{ symbol: 'HIVE', amount: 6 }, { symbol: 'HBD', amount: 0.5 }])];
    const b = await P.planEarnerReferralBonus(fakeDb(), earner, period, 100,
      deps({ h: { referrer: 'alice', source: 'link', referredAt: daysBefore(1) } }, ['alice']));
    check('native assets scaled 1:1, no rate', byAcct(b.rows).alice.amounts, [{ symbol: 'HIVE', amount: 0.6 }, { symbol: 'HBD', amount: 0.05 }]);
  }
  {
    // One referrer, two referred earners: one merged row.
    const earner = [row('r1', 'creator', 1), row('r2', 'listener-podcast', 1)];
    const b = await P.planEarnerReferralBonus(fakeDb(), earner, period, 100, deps({
      r1: { referrer: 'alice', source: 'link', referredAt: daysBefore(1) },
      r2: { referrer: 'alice', source: 'invite', referredAt: daysBefore(1) },
    }, ['alice']));
    check('one referrer, two earners: one row', b.rows.map((r) => [r.account, r.hbd]), [['alice', 0.2]]);
  }

  console.log('memo:');
  check('bonus-only row', P.payoutMemo({ kind: 'earner-referral', periodKey: 'p' }), '3Speak referral bonus - p');
  check('merged row', P.payoutMemo({ kind: 'creator+earner-referral', periodKey: 'p' }), '3Speak ad revenue share (creator+referral bonus) - p');
  check('other rows unchanged', P.payoutMemo({ kind: 'creator', periodKey: 'p' }), '3Speak ad revenue share (creator) - p');

  console.log('Butter Auth lookup (fetch stubbed):');
  const realFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ results: [
      { username: 'adv1', referredBy: 'alice', referredAt: '2026-10-20T00:00:00Z', source: 'link' },
      { username: 'adv2', referredBy: 'bob', referredAt: '2026-10-20T00:00:00Z', source: 'invite' },
      { username: 'adv3', referredBy: 'chatgpt', referredAt: '2026-10-20T00:00:00Z', source: 'typed' },
      { username: 'adv4', referredBy: 'dan', referredAt: '2026-10-20T00:00:00Z' },
      { username: 'adv5', referredBy: null, referredAt: null, source: null },
    ] }),
  });
  const paid = await referrersFor(['adv1', 'adv2', 'adv3', 'adv4', 'adv5']);
  check('2% advertiser referral: link + invite only', [...paid.entries()], [['adv1', 'alice'], ['adv2', 'bob']]);
  const all = await referralsFor(['adv1', 'adv3']);
  check('referralsFor keeps source and date', [all.get('adv3').source, all.get('adv1').referredAt instanceof Date], ['typed', true]);
  global.fetch = realFetch;

  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
