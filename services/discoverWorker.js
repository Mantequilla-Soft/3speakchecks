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
 *   base = freshness × newBoost × curationBoost × retentionMult
 *
 * `curationBoost` (utils/curation.js) is the manual-vote layer: reshares + playlist
 * saves (incl. Watch Later) + viewer tags, log-damped and capped. It SUBSUMES the
 * old reshareBoost — reshares are still in it at exactly their old weight, they just
 * no longer stand alone.
 *
 * The request path (utils/discoverPool.js + routes/feeds.js) then only applies the
 * per-user part — interest multiplier, follow boost, seeded jitter, hide-watched,
 * exploration interleave — which is cheap and needs no aggregation.
 *
 * See algo.md ("Discover feed").
 */
const { parentPort } = require('worker_threads');
const { MongoClient } = require('mongodb');
const {
  MONGODB_URI, DATABASE_NAME, HIDDEN_AUTHORS,
  DISCOVER_POOL_COLLECTION, DISCOVER_WINDOW_DAYS, DISCOVER_CANDIDATE_LIMIT,
  DISCOVER_RANDOM_OLD_COUNT, DISCOVER_RETENTION_ACTIVE_DAYS, DISCOVER_POOL_LIMIT,
  INTEREST_POOL_COLLECTION, INTEREST_POOL_PER_TAG, INTEREST_POOL_LIMIT,
  DISCOVER_RETENTION_WEIGHT, DISCOVER_RETENTION_MIN_MULT, DISCOVER_RETENTION_MAX_MULT,
  RETENTION_COLLECTION,
} = require('../utils/config');
const { ageHours, freshness, newBoost } = require('../utils/discoverScore');
const { retentionMultiplier } = require('../utils/retentionScore');
const { getCurationCounts, curationBoost, keyOf, EMPTY } = require('../utils/curation');
const { commentBoost } = require('../utils/commentBoost');
const { normalizeTags } = require('../utils/interests');
const { pickWinner } = require('../utils/effectiveTags');
const { INTEREST_TAGS } = require('../utils/interestTags');
const { getHiddenSet } = require('../utils/hiddenCreators');
const { seasonalKeys } = require('../utils/seasonal');

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

    // Hidden (moderation) creators — loaded fresh for this run (worker is a new
    // thread each time). Their videos never enter the precomputed pool. Same
    // owner-vs-hive_author caveat as HIDDEN_AUTHORS, so we check both below.
    const hiddenSet = await getHiddenSet(db);
    const isHiddenCreator = (name) => !!name && hiddenSet.has(String(name).toLowerCase());

    // ── 1. Collect candidate keys (owner + ASSET permlink) from the 3 sources ──
    const keys = new Map(); // "owner/asset" -> { owner, asset, src }
    const add = (owner, asset, src) => {
      if (!owner || !asset) return;
      if (isHiddenAuthor(owner)) return;   // test/system accounts, every source
      const id = `${owner}/${asset}`;
      if (!keys.has(id)) keys.set(id, { owner, asset, src });
    };

    const [recentEmbed, recentLegacy, randomTagged, retentionActive, topicSampled] = await Promise.all([
      db.collection('embed-video').find({
        status: 'published', short: false, listed_on_3speak: true,
        unavailable: { $ne: true }, hiddenFromFeed: { $ne: true },
        hive_author: { $nin: [null, ...HIDDEN_AUTHORS] },
        owner: { $nin: HIDDEN_AUTHORS },
        hive_permlink: { $ne: null },
        createdAt: { $gte: recentCutoff },
      }, { projection: { owner: 1, permlink: 1 } })
        .sort({ createdAt: -1 }).limit(DISCOVER_CANDIDATE_LIMIT).toArray(),

      db.collection('videos').find({
        status: 'published', publishFailed: { $ne: true },
        unavailable: { $ne: true }, hiddenFromFeed: { $ne: true },
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

      // (d) STRATIFIED per-topic sample — the interest pool's reason for existing.
      // Source (b) is a UNIFORM sample, so its topic mix just mirrors the
      // catalogue and niche topics stay starved (science surfaced 29 of its 785
      // videos). Sampling per topic gives every topic real depth. `subtitles-tags.tags`
      // is a single normalised topic string, so an equality match is exact.
      Promise.all(INTEREST_TAGS.map((tag) =>
        db.collection('subtitles-tags').aggregate([
          { $match: { tags: tag } },
          { $sample: { size: INTEREST_POOL_PER_TAG } },
          { $project: { author: 1, permlink: 1 } },
        ], { allowDiskUse: true }).toArray()
      )).then((per) => per.flat()),
    ]);

    recentEmbed.forEach((d) => add(d.owner, d.permlink, 'recent'));
    recentLegacy.forEach((d) => add(d.owner, d.permlink, 'recent'));
    randomTagged.forEach((d) => add(d.author, d.permlink, 'random'));
    retentionActive.forEach((d) => add(d._id.owner, d._id.permlink, 'retention'));
    // Tagged as its own src: these are for the INTEREST pool. Keeping them out of
    // the discover pool leaves the discover feed's composition exactly as it was.
    topicSampled.forEach((d) => add(d.author, d.permlink, 'topic'));

    const srcCounts = { recent: 0, random: 0, retention: 0, topic: 0 };
    for (const k of keys.values()) srcCounts[k.src] += 1;

    // ── 2. Resolve keys → real published video docs ───────────────────────────
    // embed-video is small enough to hold in memory keyed by owner/permlink.
    const embedAll = await db.collection('embed-video').find({
      status: 'published', short: false, listed_on_3speak: true,
      unavailable: { $ne: true }, hiddenFromFeed: { $ne: true },
      hive_author: { $ne: null }, hive_permlink: { $ne: null },
    }, {
      projection: {
        owner: 1, permlink: 1, hive_author: 1, hive_permlink: 1, hive_tags: 1,
        createdAt: 1, isNsfwContent: 1, banned: 1, unavailable: 1, hiddenFromFeed: 1, duration: 1,
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
      isNsfwContent: 1, banned: 1, unavailable: 1, hiddenFromFeed: 1, duration: 1, status: 1, publishFailed: 1,
    });
    const legacyByKey = new Map(
      legacyDocs
        .filter((d) => d.status === 'published' && d.publishFailed !== true)
        .map((d) => [`${d.owner}/${d.permlink}`, d])
    );

    // ── 3. Side data: transcription tags, curation counts, retention, viewer tags.
    // All of these collections are small; load them whole rather than N lookups.
    // `curation` = distinct-actor counts of reshares + playlist saves + viewer tags,
    // self-curation already excluded (utils/curation.js).
    const [subtitleDocs, curation, retentionDocs, viewerTagDocs, commentDocs] = await Promise.all([
      db.collection('subtitles-tags').find({}, { projection: { author: 1, permlink: 1, tags: 1 } }).toArray(),
      // force: this worker is a fresh thread each run — take the live counts, not a
      // TTL-cached map that happens to be empty on a cold start.
      getCurationCounts(db, { force: true }),
      // `viewers` gates the retention DEMOTION — without it a low-relQ video reads as
      // "no evidence" and is never demoted. See retentionMultiplier().
      db.collection(RETENTION_COLLECTION).find({}, { projection: { score: 1, viewers: 1 } }).toArray(),
      db.collection('viewer-tags').find({}, { projection: { author: 1, permlink: 1, 'viewer-tag': 1, weight: 1 } }).toArray(),
      // Comment counts (stamped by services/commentCounts.js, bounded to recent videos).
      db.collection('video-comment-counts').find({}, { projection: { effective: 1, comments: 1, native3Speak: 1 } }).toArray(),
    ]);
    // subtitles-tags.tags is a COMMA STRING ("tech,news") in RELEVANCE ORDER.
    const splitOrdered = (raw) => String(raw || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    const transcriptionByKey = new Map(
      subtitleDocs.map((d) => [`${d.author}/${d.permlink}`, normalizeTags(d.tags)])   // merged tag set (display)
    );
    const autoOrderedByKey = new Map(
      subtitleDocs.map((d) => [`${d.author}/${d.permlink}`, splitOrdered(d.tags)])     // ordered (winner calc)
    );
    const retByKey = new Map(retentionDocs.map((d) => [d._id, d]));
    // Comment counts keyed by HIVE author/permlink (video-comment-counts._id).
    const commentByKey = new Map(commentDocs.map((d) => [d._id, d]));
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
    const interestOps = [];
    let skipped = 0;
    for (const [id, k] of keys) {
      const ev = embedByKey.get(id);
      const lv = ev ? null : legacyByKey.get(id);
      if (!ev && !lv) { skipped += 1; continue; }          // unpublished / gone
      if ((ev || lv).banned === true) { skipped += 1; continue; }
      // Media confirmed gone (404 on every gateway) — never pool a dead video.
      if ((ev || lv).unavailable === true) { skipped += 1; continue; }
      // Author hid it from feeds — it stays on their profile, never in the pool. The
      // random/retention/topic sources come from subtitles-tags / view-durations,
      // which don't carry the flag, so this catches those (the recent source already
      // filtered it in its query above).
      if ((ev || lv).hiddenFromFeed === true) { skipped += 1; continue; }
      // An embed's hive_author can differ from its owner — check both.
      if (isHiddenAuthor(k.owner) || (ev && isHiddenAuthor(ev.hive_author))) { skipped += 1; continue; }
      // Moderation-hidden creators (contentcreators.hidden) — same both-keys check.
      if (isHiddenCreator(k.owner) || (ev && isHiddenCreator(ev.hive_author))) { skipped += 1; continue; }

      const source = ev ? 'embed' : 'legacy';
      const hivePermlink = ev ? ev.hive_permlink : lv.permlink;
      const created = ev ? ev.createdAt : lv.created;
      const rawOwnTags = ev ? ev.hive_tags : (lv.tags_v2 || lv.tags);
      const ownTags = normalizeTags(rawOwnTags);
      const trTags = transcriptionByKey.get(id) || new Set();
      const tags = [...new Set([...ownTags, ...trTags])];   // merged (display only)
      // Holiday ids this video's OWN tags identify it with — almost always []. Kept
      // off the merged `tags` on purpose: transcription tags are speech-derived, and
      // a video that merely SAYS "christmas" is not a Christmas video. `created` is
      // passed so a boilerplate holiday tag on an off-season upload doesn't count.
      // Date-free with respect to TODAY, so the stamp never goes stale; discoverPool
      // decides what's in season at read time. See utils/seasonal.js.
      const seasonal = seasonalKeys(rawOwnTags, created);

      // Winner-only topic: viewer votes (by hive key) + ordered auto tags.
      const hiveAuthor = String(ev ? ev.hive_author : lv.owner).toLowerCase();
      const viewerWeights = viewerWeightsByHive.get(`${hiveAuthor}/${hivePermlink}`) || {};
      const winnerTag = pickWinner(autoOrderedByKey.get(id) || [], viewerWeights);

      const hrs = ageHours(created, now);
      // Curation (reshares / saves / tags) is keyed by HIVE author+permlink — the
      // same key the reshares collection, the playlists service and viewer-tags use.
      const counts = curation.get(keyOf(hiveAuthor, hivePermlink)) || EMPTY;
      const ret = retByKey.get(id);
      const retMult = !ret || ret.score == null
        ? 1
        : retentionMultiplier(ret.score, { ...multOpts, viewers: ret.viewers });

      // Comment boost: lively discussion lifts a video (3Speak-frontend comments count
      // 1.5×, baked into `effective` by the sync). No record → ×1. Keyed by hive key.
      const cmt = commentByKey.get(`${hiveAuthor}/${hivePermlink}`);
      const commentEffective = cmt ? (cmt.effective || 0) : 0;

      const f = freshness(hrs);
      const nb = newBoost(hrs);
      const cb = curationBoost(counts);
      const mb = commentBoost(commentEffective);
      const base = f * nb * cb * mb * retMult;

      const doc = {
        owner: k.owner,
        author: hiveAuthor,            // HIVE author — who a viewer actually follows
        permlink: hivePermlink,        // what watch_history + the watch page use
        assetPermlink: k.asset,        // what retention / transcription use
        source,
        src: k.src,
        created: created ? new Date(created) : null,
        tags,
        seasonal,                         // [] unless holiday-tagged; gated on read
        winnerTag,                        // winner-only interest match key
        nsfw: isNsfw(ev || lv, new Set(tags)),
        reshares: counts.reshares,
        saves: counts.saves,
        viewerTags: counts.tags,
        comments: cmt ? (cmt.comments || 0) : 0,
        native3Speak: cmt ? (cmt.native3Speak || 0) : 0,
        relQ: ret && ret.score != null ? ret.score : null,
        retentionViewers: ret ? (ret.viewers ?? null) : null,
        retentionMult: Math.round(retMult * 1000) / 1000,
        freshness: Math.round(f * 1000) / 1000,
        newBoost: Math.round(nb * 1000) / 1000,
        curationBoost: Math.round(cb * 1000) / 1000,
        commentBoost: Math.round(mb * 1000) / 1000,
        base: Math.round(base * 100000) / 100000,
        runAt,
      };
      const upsert = { updateOne: { filter: { _id: id }, update: { $set: doc }, upsert: true } };

      // DISCOVER pool: the original sources only. The topic-stratified sample is
      // excluded so the discover feed's composition is unchanged by this work.
      if (k.src !== 'topic' && ops.length < DISCOVER_POOL_LIMIT) ops.push(upsert);

      // INTEREST pool: anything with a resolved winning topic - the topic sample
      // plus whatever the other sources happened to tag. Untagged videos can never
      // match an interest, so they'd be dead weight here.
      if (winnerTag && interestOps.length < INTEREST_POOL_LIMIT) interestOps.push(upsert);
    }

    const coll = db.collection(DISCOVER_POOL_COLLECTION);
    for (let i = 0; i < ops.length; i += 1000) {
      await coll.bulkWrite(ops.slice(i, i + 1000), { ordered: false });
    }
    // Drop entries not refreshed this run (rotated out of the random sample, or
    // no longer published) so the pool never grows unbounded.
    const del = await coll.deleteMany({ runAt: { $lt: runAt } });

    const icoll = db.collection(INTEREST_POOL_COLLECTION);
    for (let i = 0; i < interestOps.length; i += 1000) {
      await icoll.bulkWrite(interestOps.slice(i, i + 1000), { ordered: false });
    }
    const idel = await icoll.deleteMany({ runAt: { $lt: runAt } });

    await client.close();
    return {
      pool: ops.length,
      interestPool: interestOps.length,
      interestRemoved: idel.deletedCount || 0,
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
