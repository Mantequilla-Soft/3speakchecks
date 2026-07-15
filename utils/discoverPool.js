/**
 * Request-path access to the precomputed discover pool (built hourly by
 * services/discoverWorker.js).
 *
 * The pool is a few thousand small docs, so we hold it in-process and refresh on
 * a TTL rather than re-reading it on every request. Everything the ranking needs
 * — base score, merged tags, nsfw flag — is already on the doc, so a request
 * costs one watch_history lookup and one hydration query for the page slice.
 */
const { DISCOVER_POOL_COLLECTION, DISCOVER_POOL_CACHE_MS } = require('./config');
const { feedAgeMatch } = require('./feedAge');
const { unavailableMatch } = require('./unavailable');
const { filterHiddenDocs } = require('./hiddenCreators');

let cache = { at: 0, docs: [] };

/** Cached read of the whole pool. Returns [] if the worker hasn't run yet. */
async function getPool(db, { force = false } = {}) {
  let docs = cache.docs;
  if (force || !cache.docs.length || Date.now() - cache.at >= DISCOVER_POOL_CACHE_MS) {
    try {
      // Drop pool entries past the global age cutoff (very old legacy videos often
      // no longer resolve). Filtered on read, so changing FEED_MAX_AGE_YEARS takes
      // effect on the next pool refresh without rebuilding the pool.
      docs = await db.collection(DISCOVER_POOL_COLLECTION)
        .find({ ...feedAgeMatch('created'), ...unavailableMatch() }, {
          projection: {
            owner: 1, author: 1, permlink: 1, assetPermlink: 1, source: 1, src: 1,
            created: 1, tags: 1, winnerTag: 1, nsfw: 1, relQ: 1,
            reshares: 1, saves: 1, viewerTags: 1, curationBoost: 1,
            retentionMult: 1, retentionViewers: 1, freshness: 1, newBoost: 1, base: 1,
          },
        }).toArray();
      cache = { at: Date.now(), docs };
    } catch {
      docs = cache.docs; // never let a pool read break the feed
    }
  }
  // Exclude moderation-hidden creators on read: the pool only rebuilds hourly, but a
  // newly-hidden creator should vanish within the hidden-set TTL (~5 min). No-op (same
  // array) when nothing is hidden.
  return filterHiddenDocs(db, docs);
}

/**
 * Turn pool entries (identity only) into full video objects for rendering.
 * Only ever called with one page's worth (<= limit), so these are small queries.
 */
async function hydrate(db, entries) {
  if (!entries.length) return [];

  const embedKeys = entries.filter((e) => e.source === 'embed')
    .map((e) => ({ owner: e.owner, permlink: e.assetPermlink }));
  const legacyKeys = entries.filter((e) => e.source === 'legacy')
    .map((e) => ({ owner: e.owner, permlink: e.permlink }));

  const [embedDocs, legacyDocs] = await Promise.all([
    embedKeys.length ? db.collection('embed-video').find({ $or: embedKeys }).toArray() : [],
    legacyKeys.length ? db.collection('videos').find({ $or: legacyKeys }).toArray() : [],
  ]);
  const embedByKey = new Map(embedDocs.map((d) => [`${d.owner}/${d.permlink}`, d]));
  const legacyByKey = new Map(legacyDocs.map((d) => [`${d.owner}/${d.permlink}`, d]));

  const out = [];
  for (const e of entries) {
    if (e.source === 'embed') {
      const ev = embedByKey.get(`${e.owner}/${e.assetPermlink}`);
      if (!ev) continue; // vanished since the pool was built
      out.push({
        owner: ev.owner,
        author: ev.hive_author,
        permlink: ev.hive_permlink,
        title: ev.hive_title || '',
        body: ev.hive_body || '',
        status: 'published',
        created: ev.createdAt,
        created_at: ev.createdAt,
        duration: ev.duration || 0,
        tags: ev.hive_tags || [],
        images: {
          thumbnail: ev.thumbnail_url || `https://img.3speak.tv/${ev.permlink}/thumbnail.png`,
          poster: ev.thumbnail_url || `https://img.3speak.tv/${ev.permlink}/poster.jpg`,
        },
        spkvideo: {
          duration: ev.duration || 0,
          video_v2: ev.permlink,
          play_url: ev.manifest_cid ? `https://ipfs.3speak.tv/ipfs/${ev.manifest_cid}` : null,
        },
        stats: { total_hive_reward: 0, num_votes: 0, num_comments: 0 },
        views: ev.views || 0,   // DISPLAY only — never scored
        _pool: e,
      });
    } else {
      const lv = legacyByKey.get(`${e.owner}/${e.permlink}`);
      if (!lv) continue;
      out.push({ ...lv, _pool: e });
    }
  }
  return out;
}

/** Test/ops hook — drop the in-process cache (e.g. right after a worker run). */
function invalidate() { cache = { at: 0, docs: [] }; }

module.exports = { getPool, hydrate, invalidate };
