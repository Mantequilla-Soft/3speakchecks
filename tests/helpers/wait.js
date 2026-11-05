/**
 * Wait for work the code under test starts but does not await (an index build, a
 * background write). Bounded by wall time, never by a number of event-loop turns:
 * with the whole suite running in parallel, a turn count that is plenty on an idle
 * machine runs out on a busy one. performance.now is used because many tests fake
 * Date.
 *
 *   await waitUntil(async () => (await col.countDocuments()) === 0);
 */
const { performance } = require('perf_hooks');

async function waitUntil(check, { timeoutMs = 10000, everyMs = 5, message = 'condition never became true' } = {}) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (performance.now() > deadline) throw new Error(`${message} (waited ${timeoutMs} ms)`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

module.exports = { waitUntil };
