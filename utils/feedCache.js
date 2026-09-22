/**
 * A tiny TTL cache for feed routes that read SMALL collections.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Mongo is not in this datacentre. Measured from the checker box, the round trip
 * to the replica-set primary swings between **110ms and 389ms**, with packet-loss
 * episodes on the secondary. Server-side the queries are trivial: /playlists-feed's
 * plan executes in 2ms and returns ONE document out of 59 public playlists. Its
 * response time tracked the ping almost exactly, 0.115s at 110ms and 0.39s at
 * 389ms, because a route's cost here is (round trips) × RTT and nothing else.
 *
 * So for a collection small enough to hold in memory, the fix is not a better query
 * or another index. It is not making the round trip at all.
 *
 * ── The shape ────────────────────────────────────────────────────────────────
 * Cache the WHOLE small result set once, then do the per-request work (filtering by
 * viewer, narrowing the window, pagination) in memory. Deliberately NOT a per-request
 * cache keyed by query string: `?currentuser=` is unauthenticated, so a key built
 * from it grows without bound, and paging would miss the cache on every page. One
 * entry serves every caller and every page.
 *
 * ── Stale beats slow, and stale beats broken ─────────────────────────────────
 * On expiry the stale set is served and refreshed in the BACKGROUND, so no single
 * unlucky request pays the round trip for everyone else. A loader that throws leaves
 * the previous set in place rather than emptying the feed. Only a cold miss (nothing
 * cached yet) awaits the loader, and that cannot be avoided.
 */
const entries = new Map();   // name -> { value, at, loading }

/**
 * @param {string} name        cache key, one per call site
 * @param {number} ttlMs       how long a set stays fresh
 * @param {() => Promise<any>} loader  builds the set; must be cheap to call
 * @param {any} empty          what to return on a cold failure
 */
async function getCached(name, ttlMs, loader, empty = null) {
  const hit = entries.get(name);
  // `at > 0` means a load has actually SUCCEEDED for this key. An entry can exist
  // with at === 0 while the very first load is still in flight, and that entry holds
  // the `empty` placeholder -- serving it would hand a concurrent caller an empty
  // feed instead of the data it is about to have. So "do we have something to serve"
  // is not "is there an entry", it is "has one ever loaded".
  const loaded = !!hit && hit.at > 0;
  if (loaded && Date.now() - hit.at < ttlMs) return hit.value;

  const refresh = () => {
    const e = entries.get(name) || {};
    if (e.loading) return e.loading;                 // one in-flight load per key
    const p = Promise.resolve()
      .then(loader)
      .then((value) => { entries.set(name, { value, at: Date.now(), loading: null }); return value; })
      .catch((err) => {
        console.warn(`[feedCache] ${name} refresh failed:`, err && err.message);
        const prev = entries.get(name);
        // Keep serving the old set, and leave `at` alone so it stays due for another
        // attempt. A cold failure keeps at === 0, so the next caller retries rather
        // than inheriting the failure for a whole TTL.
        entries.set(name, { value: prev ? prev.value : empty, at: prev ? prev.at : 0, loading: null });
        return prev ? prev.value : empty;
      });
    entries.set(name, { value: e.value !== undefined ? e.value : empty, at: e.at || 0, loading: p });
    return p;
  };

  const inflight = refresh();
  if (loaded) return hit.value;                      // stale-while-revalidate
  return inflight;                                   // nothing to serve yet: wait
}

/** Test/ops hook. Drops one key, or everything. */
function invalidate(name) {
  if (name) entries.delete(name); else entries.clear();
}

/** Ops/debug: what's cached and how old it is. */
function stats() {
  const out = {};
  for (const [k, v] of entries) out[k] = { ageMs: Date.now() - v.at, loading: !!v.loading };
  return out;
}

module.exports = { getCached, invalidate, stats };
