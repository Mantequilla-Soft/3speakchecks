/**
 * Short-lived cache of GET /search result lists.
 *
 * ── Why ──────────────────────────────────────────────────────────────────────
 * MongoDB `$text` has to score EVERY document that contains a term before it can
 * sort by textScore and apply the limit. For a common word that is the bulk of a
 * collection: "music" matches ~103k legacy `videos` docs, each fetched twice (once
 * by TEXT_OR, once to apply the non-text filters), ~1.9s server-side and ~2.5s for
 * the route on every request, while a rare word is a fraction of that. No index changes
 * that (a collection has one text index, its prefix keys must be equality matches,
 * and the expensive part is the scoring itself), so a repeated search is served
 * from here instead of being recomputed.
 *
 * ── Shape ────────────────────────────────────────────────────────────────────
 * - The cached value is the merged, scored, deduplicated list BEFORE paging and
 *   highlighting, keyed on everything that changes it (see routes/search.js). Every
 *   page of the same search reads one entry.
 * - Bounded: at most SEARCH_CACHE_MAX entries, least recently used evicted first.
 *   The key is built from the request, so it must never grow without limit.
 * - Single flight: concurrent identical searches share one load.
 * - A failed load is never cached.
 * - Entries live SEARCH_CACHE_MS (default 60s, 0 switches the cache off). That is
 *   also how long a newly hidden creator or new upload can take to change a list
 *   that is already cached, the same order as the feed caches.
 */
const TTL_MS = (() => {
    const v = parseInt(process.env.SEARCH_CACHE_MS, 10);
    return Number.isFinite(v) && v >= 0 ? v : 60 * 1000;
})();
const MAX_ENTRIES = Math.max(1, parseInt(process.env.SEARCH_CACHE_MAX, 10) || 50);

const entries = new Map();    // key -> { value, at }   (Map order = LRU order)
const inflight = new Map();   // key -> Promise

function fresh(key) {
    const hit = entries.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at >= TTL_MS) {
        entries.delete(key);
        return undefined;
    }
    // Re-insert so the Map's insertion order tracks recency.
    entries.delete(key);
    entries.set(key, hit);
    return hit.value;
}

function store(key, value) {
    entries.delete(key);
    entries.set(key, { value, at: Date.now() });
    while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
}

/**
 * The cached value for `key`, or the result of `loader()` (stored for TTL_MS).
 * Callers must treat the returned value as read-only: it is shared.
 */
async function getOrLoad(key, loader) {
    if (TTL_MS === 0) return loader();
    const cached = fresh(key);
    if (cached !== undefined) return cached;
    if (inflight.has(key)) return inflight.get(key);

    const p = Promise.resolve()
        .then(loader)
        .then((value) => { store(key, value); return value; })
        .finally(() => { inflight.delete(key); });
    inflight.set(key, p);
    return p;
}

function invalidate() {
    entries.clear();
    inflight.clear();
}

function stats() {
    return { entries: entries.size, inflight: inflight.size, ttlMs: TTL_MS, max: MAX_ENTRIES };
}

module.exports = { getOrLoad, invalidate, stats };
