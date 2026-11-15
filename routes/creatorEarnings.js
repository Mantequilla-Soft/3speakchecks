/**
 * Earnings over time for creator stats: what an account earned per day, split by
 * where it came from, instead of one total.
 *
 *   GET /creator-stats/earnings?username=X&days=7|28|90|365
 *   → { series: [{ date, votes, curation, tips, ads, boosts, lightningSats }],
 *       totals: { ...same keys }, byPost: { <hive permlink>: hbd }, rates }
 *
 * Every amount is in HBD (about a US dollar), except Lightning, which stays in
 * sats as everywhere else on 3Speak (routes/supports.js never converts sats).
 *
 *   votes     author and beneficiary rewards paid out that day (HafSQL), HBD +
 *             HIVE + Hive Power, at today's HIVE price and vests rate (`rates`)
 *   curation  curation rewards paid that day (Hive Power, same conversion)
 *   tips      Hive transfers to the account whose memo is a tip: a 3speak.tv link
 *             (what the tip window adds, so every 3Speak tip is here) or the word
 *             tip / !tip; HIVE at today's price. 3Speak ad payouts are not tips.
 *   ads       3Speak ad payouts paid that day (`ad_payouts`, its HBD value; paid in
 *             kind, so part of it may have arrived as HIVE)
 *   boosts    stream boosts sent to the account's live streams (`stream-boosts`,
 *             logged in US dollars by the streaming server when the boost arrived,
 *             before any refund)
 *   lightningSats  Lightning tips (`supports`, currency SATS)
 *
 * Days are UTC. A day's Hive operations are dated from their block (3 s each),
 * counted back from HafSQL's newest block. One answer per account and range is
 * kept CREATOR_EARNINGS_CACHE_MIN minutes.
 */
const express = require('express');
const { getDb } = require('../utils/db');
const hafsql = require('../utils/hafsql');
const { hiveRpcBatch } = require('../utils/hive');
const { CREATOR_EARNINGS_CACHE_MIN } = require('../utils/config');

const router = express.Router();
const HIVE_RE = /^[a-z][a-z0-9.-]{2,15}$/;
const ALLOWED_DAYS = new Set([7, 28, 90, 365]);
const DAY = 24 * 3600 * 1000;
const SOURCES = ['votes', 'curation', 'tips', 'ads', 'boosts', 'lightningSats'];
const AD_MEMO = '3Speak ad revenue share%';
// A tip memo: the 3speak.tv link our tip window appends, or the word itself.
const TIP_MEMO_RE = /3speak\.tv\/|(^|[^a-z])!?tip(s|ped)?([^a-z]|$)/i;

const round = (n, d = 3) => Math.round((Number(n) || 0) * 10 ** d) / 10 ** d;
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

/** HBD per HIVE (median feed) and HIVE per million VESTS, from a Hive node. */
async function hiveRates() {
  const res = await hiveRpcBatch([
    { jsonrpc: '2.0', id: 1, method: 'condenser_api.get_current_median_history_price', params: [] },
    { jsonrpc: '2.0', id: 2, method: 'condenser_api.get_dynamic_global_properties', params: [] },
  ]);
  const byId = Object.fromEntries((res || []).map((r) => [r && r.id, r && r.result]));
  const price = byId[1] || {};
  const props = byId[2] || {};
  const base = parseFloat(price.base);
  const quote = parseFloat(price.quote);
  const fund = parseFloat(props.total_vesting_fund_hive);
  const shares = parseFloat(props.total_vesting_shares);
  if (!(base > 0 && quote > 0 && fund > 0 && shares > 0)) throw new Error('hive rates unavailable');
  return { hbdPerHive: base / quote, hivePerMvests: (fund / shares) * 1e6 };
}

function emptyDay(date) {
  return { date, votes: 0, curation: 0, tips: 0, ads: 0, boosts: 0, lightningSats: 0 };
}

async function loadEarnings(username, days, now = Date.now()) {
  const since = new Date(now - days * DAY);
  const [rates, [{ head }]] = await Promise.all([
    hiveRates(),
    hafsql.query('select block_num as head from hafsql.follows order by block_num desc limit 1'),
  ]);
  const headBlock = Number(head);
  const sinceBlock = headBlock - days * 28800;
  // HAF operation ids carry their block number in the high 32 bits.
  const minId = (BigInt(Math.max(0, sinceBlock)) << 32n).toString();
  const blockDay = (block) => dayKey(now - (headBlock - Number(block)) * 3000);
  const hiveValue = ({ hbd = 0, hive = 0, vests = 0 }) => Number(hbd) + (Number(hive) + (Number(vests) / 1e6) * rates.hivePerMvests) * rates.hbdPerHive;

  const db = getDb();
  const [author, benefactor, curation, transfers, ads, boosts, sats] = await Promise.all([
    hafsql.query(`select (id >> 32)::int as block, permlink, hbd_payout::float as hbd, hive_payout::float as hive, vesting_payout::float as vests
      from hafsql.operation_author_reward_table where author = $1 and id >= $2`, [username, minId]),
    hafsql.query(`select (id >> 32)::int as block, permlink, hbd_payout::float as hbd, hive_payout::float as hive, vesting_payout::float as vests
      from hafsql.operation_comment_benefactor_reward_table where benefactor = $1 and id >= $2`, [username, minId]),
    hafsql.query(`select (id >> 32)::int as block, reward::float as amount, symbol
      from hafsql.operation_curation_reward_table where curator = $1 and id >= $2`, [username, minId]),
    hafsql.query(`select (id >> 32)::int as block, amount::float as amount, symbol, memo
      from hafsql.operation_transfer_table where to_account = $1 and id >= $2 and memo not like $3 limit 20000`, [username, minId, AD_MEMO]),
    db.collection(process.env.AD_PAYOUTS_COLLECTION || 'ad_payouts')
      .find({ account: username, status: 'paid', paidAt: { $gte: since } }, { projection: { _id: 0, hbd: 1, paidAt: 1 } }).toArray(),
    db.collection('stream-boosts')
      .find({ host: username, createdAt: { $gte: since } }, { projection: { _id: 0, amount: 1, createdAt: 1 } }).toArray(),
    db.collection('supports')
      .find({ author: username, currency: 'SATS', tippedAt: { $gte: since } }, { projection: { _id: 0, amount: 1, tippedAt: 1 } }).toArray(),
  ]);

  const series = [];
  const byDate = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const d = emptyDay(dayKey(now - i * DAY));
    series.push(d);
    byDate.set(d.date, d);
  }
  const add = (date, key, value) => { const d = byDate.get(date); if (d && value > 0) d[key] += value; };

  const byPost = {};
  for (const r of author) {
    const v = hiveValue(r);
    add(blockDay(r.block), 'votes', v);
    byPost[r.permlink] = (byPost[r.permlink] || 0) + v;
  }
  for (const r of benefactor) add(blockDay(r.block), 'votes', hiveValue(r));
  for (const r of curation) {
    const vests = r.symbol === 'VESTS' ? r.amount : 0;
    add(blockDay(r.block), 'curation', hiveValue({ vests }));
  }
  for (const r of transfers) {
    if (!TIP_MEMO_RE.test(String(r.memo || ''))) continue;
    const v = r.symbol === 'HBD' ? r.amount : r.symbol === 'HIVE' ? r.amount * rates.hbdPerHive : 0;
    add(blockDay(r.block), 'tips', v);
  }
  for (const r of ads) add(dayKey(new Date(r.paidAt).getTime()), 'ads', Number(r.hbd) || 0);
  for (const r of boosts) add(dayKey(new Date(r.createdAt).getTime()), 'boosts', Number(r.amount) || 0);
  for (const r of sats) add(dayKey(new Date(r.tippedAt).getTime()), 'lightningSats', Number(r.amount) || 0);

  const totals = emptyDay(null);
  delete totals.date;
  for (const d of series) {
    for (const k of SOURCES) {
      d[k] = k === 'lightningSats' ? Math.round(d[k]) : round(d[k]);
      totals[k] += d[k];
    }
  }
  for (const k of SOURCES) totals[k] = k === 'lightningSats' ? Math.round(totals[k]) : round(totals[k]);
  for (const k of Object.keys(byPost)) byPost[k] = round(byPost[k]);

  return {
    series,
    totals,
    byPost,
    rates: { hbdPerHive: round(rates.hbdPerHive, 4), hivePerMvests: round(rates.hivePerMvests, 3) },
  };
}

const cache = new Map(); // `${user}:${days}` -> { at, promise }

router.get('/creator-stats/earnings', async (req, res) => {
  try {
    const username = String(req.query.username || '').toLowerCase();
    if (!HIVE_RE.test(username)) return res.status(400).json({ success: false, error: 'invalid username' });
    const d = parseInt(req.query.days, 10);
    const days = ALLOWED_DAYS.has(d) ? d : 28;
    const key = `${username}:${days}`;
    let hit = cache.get(key);
    if (!hit || Date.now() - hit.at > CREATOR_EARNINGS_CACHE_MIN * 60 * 1000) {
      hit = { at: Date.now(), promise: loadEarnings(username, days) };
      cache.set(key, hit);
      hit.promise.catch(() => cache.delete(key));
      if (cache.size > 500) cache.delete(cache.keys().next().value);
    }
    res.json({ success: true, username, days, ...(await hit.promise) });
  } catch (err) {
    console.error('creator-stats/earnings error:', err && err.message);
    res.status(503).json({ success: false, error: 'earnings unavailable' });
  }
});

module.exports = router;
module.exports._test = { loadEarnings, TIP_MEMO_RE, SOURCES, reset: () => cache.clear() };
