/**
 * Discover pool worker — runs in a WORKER THREAD (spawned by services/discover.js)
 * so building the pool never blocks the main event loop serving feed queries. It
 * has its OWN MongoDB connection, does the whole compute, writes
 * DISCOVER_POOL_COLLECTION, and exits.
 *
 * The pool is the UNION of three sources (deduped by owner/assetPermlink):
 *   (a) recent    — everything published in the last DISCOVER_WINDOW_DAYS
 *   (b) random    — DISCOVER_RANDOM_OLD_COUNT videos sampled from ALL TIME that
 *                   have at least one transcription tag. Re-sampled every run, so
 *                   a different slice of the back catalogue gets a shot each hour.
 *                   This is what makes Discover an actual discovery surface.
 *   (c) retention — anything with watch-duration rows in the last
 *                   DISCOVER_RETENTION_ACTIVE_DAYS (i.e. people are still watching it).
 *
 * For each pool entry it precomputes the user-independent part of the score:
 *
 *   base = freshness × newBoost × reshareBoost × retentionMult
 *
 * The request path (utils/discoverPool.js + routes/feeds.js) then only applies the
 * per-user part — interest multiplier, seeded jitter, hide-watched, exploration
 * interleave — which is cheap and needs no aggregation.
 *
 * See algo.md ("Discover feed").
 */
const { parentPort } = require('worker_threads');
const { MongoClient } = require('mongodb');
const {
  MONGODB_URI, DATABASE_NAME, HIDDEN_AUTHORS,
  DISCOVER_POOL_COLLECTION, DISCOVER_WINDOW_DAYS, DISCOVER_CANDIDATE_LIMIT,
  DISCOVER_RANDOM_OLD_COUNT, DISCOVER_RETENTION_ACTIVE_DAYS, DISCOVER_POOL_LIMIT,
  DISCOVER_RETENTION_WEIGHT, DISCOVER_RETENTION_MIN_MULT, DISCOVER_RETENTION_MAX_MULT,
  RETENTION_COLLECTION,
} = require('../utils/config');
const { ageHours, freshness, newBoost, reshareBoost } = require('../utils/discoverScore');
const { retentionMultiplier } = require('../utils/retentionScore');
const { normalizeTags } = require('../utils/interests');
const { pickWinner } = require('../utils/effectiveTags');

const WATCH_LOG = process.env.WATCH_LOG_COLLECTION || 'view-durations';
const DAY_MS = 24 * 60 * 60 * 1000;

// Test/system accounts never enter the pool. A per-source $nin isn't enough: the
// `random` source samples subtitles-tags and the `retention` source samples
// view-durations, neither of which knows about HIDDEN_AUTHORS — so we also gate
// at resolution time, which is the one place every candidate passes through.
const HIDDEN_SET = new Set(HIDDEN_AUTHORS.map((a) => String(a).trim().toLowerCase()));
const isHiddenAuthor = (owner) => HIDDEN_SET.has(String(owner || '').trim().toLowerCase());

/** $or lookups in chunks — a single 4000-clause $or would build a giant command. */
async function findChunked(coll, conds, projection, size = 200) {
  const out = [];
  for (let i = 0; i < conds.length; i += size) {
    const chunk = conds.slice(i, i + size);
    if (!chunk.length) continue;
    out.push(...await coll.find({ $or: chunk }, { projection }).toArray());
  }
  return out;
}

const isNsfw = (doc, tags) =>
  doc.isNsfwContent === true || tags.has('nsfw');

async function run() {
  const client = new MongoClient(MONGODB_URI, {
    maxPoolSize: 4, minPoolSize: 0, waitQueueTimeoutMS: 20000,
  });
  const startedAt = Date.now();
  try {
    await client.connect();
    const db = client.db(DATABASE_NAME);
    const now = Date.now();
    const runAt = new Date();

    const recentCutoff = new Date(now - DISCOVER_WINDOW_DAYS * DAY_MS);
    const activeCutoff = new Date(now - DISCOVER_RETENTION_ACTIVE_DAYS * DAY_MS);

    // ── 1. Collect candidate keys (owner + ASSET permlink) from the 3 sources ──
    const keys = new Map(); // "owner/asset" -> { owner, asset, src }
    const add = (owner, asset, src) => {
      if (!owner || !asset) return;
      if (isHiddenAuthor(owner)) return;   // test/system accounts, every source
      const id = `${owner}/${asset}`;
      if (!keys.has(id)) keys.set(id, { owner, asset, src });
    };

    const [recentEmbed, recentLegacy, randomTagged, retentionActive] = await Promise.all([
      db.collection('embed-video').find({
        status: 'published', short: false, listed_on_3speak: true,
        hive_author: { $nin: [null, ...HIDDEN_AUTHORS] },
        owner: { $nin: HIDDEN_AUTHORS },
        hive_permlink: { $ne: null },
        createdAt: { $gte: recentCutoff },
      }, { projection: { owner: 1, permlink: 1 } })
        .sort({ createdAt: -1 }).limit(DISCOVER_CANDIDATE_LIMIT).toArray(),

      db.collection('videos').find({
        status: 'published', publishFailed: { $ne: true },
        owner: { $nin: HIDDEN_AUTHORS },
        created: { $gte: recentCutoff },
      }, { projection: { owner: 1, permlink: 1 } })
        .sort({ created: -1 }).limit(DISCOVER_CANDIDATE_LIMIT).toArray(),

      // (b) random slice of the back catalogue — anything ever transcribed.
      // Re-sampled every run: this is the "bump old videos" engine.
      db.collection('subtitles-tags').aggregate([
        { $match: { tags: { $exists: true, $nin: [null, ''] } } },
        { $sample: { size: DISCOVER_RANDOM_OLD_COUNT } },
        { $project: { author: 1, permlink: 1 } },
      ], { allowDiskUse: true }).toArray(),

      // (c) still being watched — view-durations rows touched recently.
      db.collection(WATCH_LOG).aggregate([
        { $match: { updatedAt: { $gte: activeCutoff } } },
        { $group: { _id: { owner: '$owner', permlink: '$permlink' } } },
        { $limit: DISCOVER_POOL_LIMIT },
      ], { allowDiskUse: true }).toArray(),
    ]);

    recentEmbed.forEach((d) => add(d.owner, d.permlink, 'recent'));
    recentLegacy.forEach((d) => add(d.owner, d.permlink, 'recent'));
    randomTagged.forEach((d) => add(d.author, d.permlink, 'random'));
    retentionActive.forEach((d) => add(d._id.owner, d._id.permlink, 'retention'));

    const srcCounts = { recent: 0, random: 0, retention: 0 };
    for (const k of keys.values()) srcCounts[k.src] += 1;

    // ── 2. Resolve keys → real published video docs ───────────────────────────
    // embed-video is small enough to hold in memory keyed by owner/permlink.
    const embedAll = await db.collection('embed-video').find({
      status: 'published', short: false, listed_on_3speak: true,
      hive_author: { $ne: null }, hive_permlink: { $ne: null },
    }, {
      projection: {
        owner: 1, permlink: 1, hive_author: 1, hive_permlink: 1, hive_tags: 1,
        createdAt: 1, isNsfwContent: 1, banned: 1, duration: 1,
      },
    }).toArray();
    const embedByKey = new Map(embedAll.map((d) => [`${d.owner}/${d.permlink}`, d]));

    // Anything not resolvable as an embed → look it up in legacy `videos`.
    const legacyConds = [];
    for (const [id, k] of keys) {
      if (!embedByKey.has(id)) legacyConds.push({ owner: k.owner, permlink: k.asset });
    }
    const legacyDocs = await findChunked(db.collection('videos'), legacyConds, {
      owner: 1, permlink: 1, created: 1, tags: 1, tags_v2: 1,
      isNsfwContent: 1, banned: 1, duration: 1, status: 1, publishFailed: 1,
    });
    const legacyByKey = new Map(
      legacyDocs
        .filter((d) => d.status === 'published' && d.publishFailed !== true)
        .map((d) => [`${d.owner}/${d.permlink}`, d])
    );

    // ── 3. Side data: transcription tags, reshare counts, retention, viewer tags.
    // All four collections are small; load them whole rather than N lookups.
    const [subtitleDocs, reshareDocs, retentionDocs, viewerTagDocs] = await Promise.all([
      db.collection('subtitles-tags').find({}, { projection: { author: 1, permlink: 1, tags: 1 } }).toArray(),
      db.collection('reshares').find({}, { projection: { author: 1, permlink: 1 } }).toArray(),
      db.collection(RETENTION_COLLECTION).find({}, { projection: { score: 1 } }).toArray(),
      db.collection('viewer-tags').find({}, { projection: { author: 1, permlink: 1, 'viewer-tag': 1, weight: 1 } }).toArray(),
    ]);
    // subtitles-tags.tags is a COMMA STRING ("tech,news") in RELEVANCE ORDER.
    const splitOrdered = (raw) => String(raw || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    const transcriptionByKey = new Map(
      subtitleDocs.map((d) => [`${d.author}/${d.permlink}`, normalizeTags(d.tags)])   // merged tag set (display)
    );
    const autoOrderedByKey = new Map(
      subtitleDocs.map((d) => [`${d.author}/${d.permlink}`, splitOrdered(d.tags)])     // ordered (winner calc)
    );
    const reshareCount = new Map();
    for (const r of reshareDocs) {
      const id = `${r.author}/${r.permlink}`;      // reshares are keyed by HIVE permlink
      reshareCount.set(id, (reshareCount.get(id) || 0) + 1);
    }
    const relQByKey = new Map(retentionDocs.map((d) => [d._id, d.score]));
    // Viewer votes keyed by HIVE author/permlink -> { tag: summed weight }.
    const viewerWeightsByHive = new Map();
    for (const d of viewerTagDocs) {
      const id = `${String(d.author).toLowerCase()}/${d.permlink}`;
      const obj = viewerWeightsByHive.get(id) || {};
      obj[d['viewer-tag']] = (obj[d['viewer-tag']] || 0) + Math.max(Math.abs(Number(d.weight) || 1), 1);
      viewerWeightsByHive.set(id, obj);
    }

    // ── 4. Build the pool docs, precomputing the user-independent score ───────
    const multOpts = {
      weight: DISCOVER_RETENTION_WEIGHT,
      min: DISCOVER_RETENTION_MIN_MULT,
      max: DISCOVER_RETENTION_MAX_MULT,
    };
    const ops = [];
    let skipped = 0;
    for (const [id, k] of keys) {
      const ev = embedByKey.get(id);
      const lv = ev ? null : legacyByKey.get(id);
      if (!ev && !lv) { skipped += 1; continue; }          // unpublished / gone
      if ((ev || lv).banned === true) { skipped += 1; continue; }
      // An embed's hive_author can differ from its owner — check both.
      if (isHiddenAuthor(k.owner) || (ev && isHiddenAuthor(ev.hive_author))) { skipped += 1; continue; }

      const source = ev ? 'embed' : 'legacy';
      const hivePermlink = ev ? ev.hive_permlink : lv.permlink;
      const created = ev ? ev.createdAt : lv.created;
      const ownTags = normalizeTags(ev ? ev.hive_tags : (lv.tags_v2 || lv.tags));
      const trTags = transcriptionByKey.get(id) || new Set();
      const tags = [...new Set([...ownTags, ...trTags])];   // merged (display only)

      // Winner-only topic: viewer votes (by hive key) + ordered auto tags.
      const hiveAuthor = String(ev ? ev.hive_author : lv.owner).toLowerCase();
      const viewerWeights = viewerWeightsByHive.get(`${hiveAuthor}/${hivePermlink}`) || {};
      const winnerTag = pickWinner(autoOrderedByKey.get(id) || [], viewerWeights);

      const hrs = ageHours(created, now);
      const reshares = reshareCount.get(`${ev ? ev.hive_author : lv.owner}/${hivePermlink}`) || 0;
      const relQ = relQByKey.get(id);
      const retMult = relQ == null ? 1 : retentionMultiplier(relQ, multOpts);

      const f = freshness(hrs);
      const nb = newBoost(hrs);
      const rb = reshareBoost(reshares);
      const base = f * nb * rb * retMult;

      ops.push({
        updateOne: {
          filter: { _id: id },
          update: {
            $set: {
              owner: k.owner,
              permlink: hivePermlink,        // what watch_history + the watch page use
              assetPermlink: k.asset,        // what retention / transcription use
              source,
              src: k.src,
              created: created ? new Date(created) : null,
              tags,
              winnerTag,                        // winner-only interest match key
              nsfw: isNsfw(ev || lv, new Set(tags)),
              reshares,
              relQ: relQ == null ? null : relQ,
              retentionMult: Math.round(retMult * 1000) / 1000,
              freshness: Math.round(f * 1000) / 1000,
              newBoost: Math.round(nb * 1000) / 1000,
              reshareBoost: Math.round(rb * 1000) / 1000,
              base: Math.round(base * 100000) / 100000,
              runAt,
            },
          },
          upsert: true,
        },
      });
      if (ops.length >= DISCOVER_POOL_LIMIT) break;
    }

    const coll = db.collection(DISCOVER_POOL_COLLECTION);
    for (let i = 0; i < ops.length; i += 1000) {
      await coll.bulkWrite(ops.slice(i, i + 1000), { ordered: false });
    }
    // Drop entries not refreshed this run (rotated out of the random sample, or
    // no longer published) so the pool never grows unbounded.
    const del = await coll.deleteMany({ runAt: { $lt: runAt } });

    await client.close();
    return {
      pool: ops.length,
      sources: srcCounts,
      skipped,
      removed: del.deletedCount || 0,
      ms: Date.now() - startedAt,
    };
  } catch (err) {
    try { await client.close(); } catch { /* noop */ }
    throw err;
  }
}

run()
  .then((s) => { if (parentPort) parentPort.postMessage({ ok: true, ...s }); process.exit(0); })
  .catch((err) => { if (parentPort) parentPort.postMessage({ ok: false, error: String((err && err.message) || err) }); process.exit(1); });
