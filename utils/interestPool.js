/**
 * Request-path access to the precomputed INTEREST pool (built alongside the
 * discover pool by services/discoverWorker.js).
 *
 * Why a second pool instead of filtering the discover one:
 * the discover pool is a ~2.7k UNIFORM sample of a ~104k tagged catalogue, so its
 * topic mix just mirrors the catalogue. Filtering it down to a single topic
 * starved the interests feed — `science` surfaced 29 of its 785 videos, i.e. a
 * single page, and no amount of paging produced more.
 *
 * This pool is STRATIFIED: the worker samples up to INTEREST_POOL_PER_TAG videos
 * for EACH topic, so every topic — niche ones included — has real depth. Entries
 * without a resolved winning topic are never written here: they can't match an
 * interest, so they'd be dead weight.
 *
 * Same shape as the discover pool, so discoverPool.hydrate() renders these too.
 */
const { INTEREST_POOL_COLLECTION, DISCOVER_POOL_CACHE_MS } = require('./config');
const { feedAgeMatch } = require('./feedAge');
const { unavailableMatch } = require('./unavailable');
const { hiddenFromFeedMatch } = require('./hiddenFromFeed');
const { filterHiddenDocs } = require('./hiddenCreators');

let cache = { at: 0, docs: [] };

/** Cached read of the whole interest pool. Returns [] if the worker hasn't run. */
async function getInterestPool(db, { force = false } = {}) {
  let docs = cache.docs;
  if (force || !cache.docs.length || Date.now() - cache.at >= DISCOVER_POOL_CACHE_MS) {
    try {
      docs = await db.collection(INTEREST_POOL_COLLECTION)
        .find({ ...feedAgeMatch('created'), ...unavailableMatch(), ...hiddenFromFeedMatch() }, {
          projection: {
            owner: 1, author: 1, permlink: 1, assetPermlink: 1, source: 1, src: 1,
            created: 1, tags: 1, winnerTag: 1, nsfw: 1, relQ: 1,
            reshares: 1, saves: 1, viewerTags: 1, curationBoost: 1,
            comments: 1, native3Speak: 1, commentBoost: 1,
            retentionMult: 1, retentionViewers: 1, freshness: 1, newBoost: 1, recencyBoost: 1, base: 1,
          },
        }).toArray();
      cache = { at: Date.now(), docs };
    } catch {
      docs = cache.docs; // never let a pool read break the feed
    }
  }
  // Exclude moderation-hidden creators on read (see discoverPool.getPool).
  return filterHiddenDocs(db, docs);
}

/** Test/ops hook — drop the in-process cache (e.g. right after a worker run). */
function invalidate() { cache = { at: 0, docs: [] }; }

module.exports = { getInterestPool, invalidate };
