/**
 * utils/searchCache.js: the bounded, single-flight cache behind GET /search.
 */
function load(env = {}) {
  let mod;
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  jest.isolateModules(() => { mod = require('../utils/searchCache'); });
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return mod;
}

beforeEach(() => jest.useFakeTimers({ now: new Date('2026-11-06T12:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }));
afterEach(() => jest.useRealTimers());

test('a value is loaded once and served until the TTL runs out', async () => {
  const cache = load({ SEARCH_CACHE_MS: '1000' });
  const loader = jest.fn(async () => ['r']);

  expect(await cache.getOrLoad('k', loader)).toEqual(['r']);
  expect(await cache.getOrLoad('k', loader)).toEqual(['r']);
  expect(loader).toHaveBeenCalledTimes(1);

  jest.setSystemTime(new Date('2026-11-06T12:00:01Z'));
  await cache.getOrLoad('k', loader);
  expect(loader).toHaveBeenCalledTimes(2);
});

test('identical searches that arrive together share one load', async () => {
  const cache = load();
  let release;
  const loader = jest.fn(() => new Promise((resolve) => { release = resolve; }));

  const both = Promise.all([cache.getOrLoad('k', loader), cache.getOrLoad('k', loader)]);
  await Promise.resolve();
  release(['shared']);

  expect(await both).toEqual([['shared'], ['shared']]);
  expect(loader).toHaveBeenCalledTimes(1);
});

test('a failed load is not cached', async () => {
  const cache = load();
  await expect(cache.getOrLoad('k', async () => { throw new Error('mongo down'); })).rejects.toThrow('mongo down');
  expect(cache.stats()).toMatchObject({ entries: 0, inflight: 0 });
  expect(await cache.getOrLoad('k', async () => ['ok'])).toEqual(['ok']);
});

test('at most SEARCH_CACHE_MAX entries; the least recently used goes first', async () => {
  const cache = load({ SEARCH_CACHE_MAX: '2' });
  const loader = jest.fn(async () => []);
  await cache.getOrLoad('a', loader);
  await cache.getOrLoad('b', loader);
  await cache.getOrLoad('a', loader);   // a is now the most recent
  await cache.getOrLoad('c', loader);   // evicts b
  expect(cache.stats().entries).toBe(2);
  loader.mockClear();

  await cache.getOrLoad('a', loader);
  expect(loader).not.toHaveBeenCalled();
  await cache.getOrLoad('b', loader);
  expect(loader).toHaveBeenCalledTimes(1);
});

test('SEARCH_CACHE_MS=0 switches it off', async () => {
  const cache = load({ SEARCH_CACHE_MS: '0' });
  const loader = jest.fn(async () => []);
  await cache.getOrLoad('k', loader);
  await cache.getOrLoad('k', loader);
  expect(loader).toHaveBeenCalledTimes(2);
  expect(cache.stats()).toMatchObject({ entries: 0, ttlMs: 0 });
});

test('invalidate() empties it', async () => {
  const cache = load();
  const loader = jest.fn(async () => []);
  await cache.getOrLoad('k', loader);
  cache.invalidate();
  await cache.getOrLoad('k', loader);
  expect(loader).toHaveBeenCalledTimes(2);
});
