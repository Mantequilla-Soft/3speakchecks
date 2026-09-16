/**
 * 📅 The payment scan is bounded by DATE, not by a count of 1000.
 *
 * `get_account_history` is capped at 1000 entries per call, so the old single call
 * meant "the last 1000 transfers" — a moving window. Payouts leave the same account
 * advertisers pay into, so every creator payout pushed older payments towards the
 * edge of it, and an advertiser who claimed a day late could find their transfer had
 * fallen off the end: money sent, nothing claimable, no error explaining why.
 *
 * transfersSince() pages backwards instead, until it reaches the cutoff. Live
 * accounts cannot prove that walk — @threespeak-pro has only 82 transfers in total,
 * and busy accounts have a first page spanning years, so both stop after one call.
 * So the RPC is stubbed here and the pagination driven directly.
 *
 * 🚨 Stubs global.fetch, which is what hiveRpcBatch uses, so the REAL helper runs.
 * No network, no account, nothing to clean up.
 *
 * Usage: node scripts/test-transfers-since.cjs
 */
require('dotenv').config();
const { transfersSince } = require('../utils/hive');

const HOUR = 3600 * 1000;
let pass = 0, fail = 0, calls = [];
const ok = (name, got, want) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  console.log((good ? '    ok   ' : '    FAIL ') + name + (good ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
  good ? pass++ : fail++;
};

/** An account whose transfer at index i happened `i` hours before `newestAt`. */
function stubAccount({ total, newestAt, pageSize = 1000 }) {
  calls = [];
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body)[0];
    const [, start, limit] = body.params;
    calls.push({ start, limit });
    const top = start === -1 ? total - 1 : start;
    const lo = Math.max(0, top - limit + 1);
    const entries = [];
    for (let i = lo; i <= top; i += 1) {
      const ts = new Date(newestAt - (total - 1 - i) * HOUR).toISOString().replace(/\.\d+Z$/, '');
      entries.push([i, { timestamp: ts, trx_id: `t${i}`, op: ['transfer', { to: 'x', from: 'y', amount: '1.000 HIVE', memo: `m${i}` }] }]);
    }
    return { json: async () => [{ id: 1, result: entries }] };
  };
}

(async () => {
  const NOW = Date.parse('2026-09-16T12:00:00Z');

  console.log('\n  an account with 2500 transfers, one per hour');
  stubAccount({ total: 2500, newestAt: NOW });
  let ops = await transfersSince('busy', NOW - 2400 * HOUR);
  ok('walks back past 1000 to reach the cutoff', ops.length > 1000, true);
  ok('took three pages', calls.length, 3);
  ok('first page asks for the newest', calls[0].start, -1);
  ok('each page resumes one below the last index seen', [calls[1].start, calls[2].start], [1499, 499]);

  console.log('\n  a cutoff inside the first page');
  stubAccount({ total: 2500, newestAt: NOW });
  ops = await transfersSince('busy', NOW - 10 * HOUR);
  ok('stops after one page', calls.length, 1);
  ok('and does not over-fetch', ops.length, 1000);

  console.log('\n  a short account');
  stubAccount({ total: 40, newestAt: NOW });
  ops = await transfersSince('quiet', NOW - 99999 * HOUR);
  ok('returns everything', ops.length, 40);
  ok('stops at the account start rather than looping', calls.length, 1);

  console.log('\n  the backstop');
  stubAccount({ total: 100000, newestAt: NOW });
  ops = await transfersSince('huge', 0, { maxPages: 4 });
  ok('maxPages caps an unbounded scan', calls.length, 4);

  console.log('\n  timestamps are read as UTC');
  /* Hive stamps carry no zone. Parsed as local time this cutoff lands on the wrong
   * side of the boundary anywhere east or west of UTC, and the scan stops early. */
  stubAccount({ total: 2500, newestAt: NOW });
  ops = await transfersSince('busy', NOW - 1200 * HOUR);
  const oldest = ops.map((e) => Date.parse(`${e[1].timestamp}Z`)).sort((a, b) => a - b)[0];
  ok('scan reached back past the cutoff', oldest <= NOW - 1200 * HOUR, true);

  console.log('\n  %d passed, %d failed\n', pass, fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
