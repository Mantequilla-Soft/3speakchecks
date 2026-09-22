/**
 * feedCache: the semantics that matter when Mongo is 110-390ms away -- a cold miss
 * waits, a stale set is served immediately while it refreshes, only one refresh runs
 * at a time, and a failing loader never empties a feed.
 */
const { getCached, invalidate, stats } = require('../utils/feedCache');

const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };

beforeEach(() => invalidate());

test('a cold miss waits for the loader and returns its value', async () => {
  const v = await getCached('k', 1000, async () => ['a']);
  expect(v).toEqual(['a']);
});

test('a fresh hit does not call the loader again', async () => {
  let calls = 0;
  const load = async () => { calls += 1; return calls; };
  expect(await getCached('k', 1000, load)).toBe(1);
  expect(await getCached('k', 1000, load)).toBe(1);
  expect(await getCached('k', 1000, load)).toBe(1);
  expect(calls).toBe(1);
});

test('a stale hit is served IMMEDIATELY and refreshes behind the request', async () => {
  // This is the point of the whole module: no single unlucky request should pay a
  // 390ms round trip on everyone else's behalf.
  let calls = 0;
  const load = async () => { calls += 1; return calls; };
  expect(await getCached('k', 0, load)).toBe(1);      // ttl 0 => always stale
  expect(await getCached('k', 0, load)).toBe(1);      // still the OLD value, instantly
  await settle();
  expect(calls).toBe(2);                              // but a refresh did happen
  expect(await getCached('k', 60000, load)).toBe(2);  // and it landed
});

test('concurrent cold callers share ONE load', async () => {
  let calls = 0;
  const load = async () => { calls += 1; await tick(); return 'x'; };
  const all = await Promise.all([1, 2, 3, 4, 5].map(() => getCached('k', 1000, load)));
  expect(all).toEqual(['x', 'x', 'x', 'x', 'x']);
  expect(calls).toBe(1);
});

test('a failing loader keeps serving the previous set', async () => {
  let fail = false;
  const load = async () => { if (fail) throw new Error('mongo timeout'); return ['good']; };
  expect(await getCached('k', 0, load)).toEqual(['good']);
  fail = true;
  expect(await getCached('k', 0, load)).toEqual(['good']);   // stale, not empty
  await settle();
  expect(await getCached('k', 0, load)).toEqual(['good']);   // still not empty
});

test('a cold failure returns the supplied empty value, it does not throw', async () => {
  const load = async () => { throw new Error('mongo down'); };
  await expect(getCached('k', 1000, load, [])).resolves.toEqual([]);
});

test('a cold failure retries rather than caching the failure forever', async () => {
  let calls = 0;
  const load = async () => { calls += 1; if (calls === 1) throw new Error('down'); return ['back']; };
  expect(await getCached('k', 60000, load, [])).toEqual([]);
  expect(await getCached('k', 60000, load, [])).toEqual(['back']);
});

test('keys are independent', async () => {
  expect(await getCached('a', 1000, async () => 1)).toBe(1);
  expect(await getCached('b', 1000, async () => 2)).toBe(2);
  expect(await getCached('a', 1000, async () => 99)).toBe(1);
});

test('invalidate drops one key or everything', async () => {
  await getCached('a', 60000, async () => 1);
  await getCached('b', 60000, async () => 2);
  invalidate('a');
  expect(Object.keys(stats())).toEqual(['b']);
  invalidate();
  expect(Object.keys(stats())).toEqual([]);
});
