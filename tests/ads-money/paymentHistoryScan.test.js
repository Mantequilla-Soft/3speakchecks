/**
 * The payment scan is bounded by DATE, not by a count (utils/hive.js transfersSince),
 * which is what both the claim and the payment watcher read advertiser payments with.
 *
 * A node returns at most 1000 history entries per call, so "the last 1000" was a
 * moving window: payouts leave the same account advertisers pay into, and a payment
 * could fall off the end before anyone claimed it. The scan pages backwards to the
 * cutoff instead. global.fetch is stubbed, so the real RPC helper runs and no
 * request leaves the process. Ports scripts/test-transfers-since.
 */
const { transfersSince } = require('../../utils/hive');

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-09-16T12:00:00Z');
let calls;

/** An account whose transfer at index i happened (total - 1 - i) hours before NOW. */
function stubAccount(total) {
  calls = [];
  jest.spyOn(global, 'fetch').mockImplementation(async (_url, opts) => {
    const [req] = JSON.parse(opts.body);
    const [, start, limit, filter] = req.params;
    calls.push({ method: req.method, start, limit, filter });
    const top = start === -1 ? total - 1 : start;
    const entries = [];
    for (let i = Math.max(0, top - limit + 1); i <= top; i += 1) {
      // Hive stamps carry no zone.
      const timestamp = new Date(NOW - (total - 1 - i) * HOUR).toISOString().replace(/\.\d+Z$/, '');
      entries.push([i, { timestamp, trx_id: `t${i}`, op: ['transfer', { from: 'adv', to: 'ads', amount: '1.000 HBD', memo: `m${i}` }] }]);
    }
    return { json: async () => [{ id: 1, result: entries }] };
  });
}

test('walks back past 1000 entries, a page at a time, until it reaches the cutoff', async () => {
  stubAccount(2500);
  const ops = await transfersSince('busy', NOW - 2400 * HOUR);
  expect(ops.length).toBeGreaterThan(1000);
  expect(calls.map((c) => c.start)).toEqual([-1, 1499, 499]);
  expect(calls.every((c) => c.method === 'condenser_api.get_account_history' && c.limit === 1000 && c.filter === 4)).toBe(true);
});

test('a cutoff inside the first page stops after one call and does not over-fetch', async () => {
  stubAccount(2500);
  expect(await transfersSince('busy', NOW - 10 * HOUR)).toHaveLength(1000);
  expect(calls).toHaveLength(1);
});

test('a short account returns everything and stops at its first operation rather than looping', async () => {
  stubAccount(40);
  expect(await transfersSince('quiet', NOW - 99999 * HOUR)).toHaveLength(40);
  expect(calls).toHaveLength(1);
});

test('maxPages is a backstop against an unbounded scan', async () => {
  stubAccount(100000);
  await transfersSince('huge', 0, { maxPages: 4 });
  expect(calls).toHaveLength(4);
});

test('the page size can be shrunk for a short catch-up scan', async () => {
  stubAccount(2500);
  await transfersSince('busy', NOW - 50 * HOUR, { pageSize: 100 });
  expect(calls.map((c) => c.limit)).toEqual([100]);
});

test('Hive timestamps are read as UTC, so the scan reaches the cutoff wherever the box is', async () => {
  stubAccount(2500);
  const ops = await transfersSince('busy', NOW - 1200 * HOUR);
  const oldest = Math.min(...ops.map((e) => Date.parse(`${e[1].timestamp}Z`)));
  expect(oldest).toBeLessThanOrEqual(NOW - 1200 * HOUR);
});

test('an unreachable node yields an empty history, never a throw', async () => {
  jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
  jest.spyOn(console, 'error').mockImplementation(() => {});
  await expect(transfersSince('busy', NOW - HOUR)).resolves.toEqual([]);
});
