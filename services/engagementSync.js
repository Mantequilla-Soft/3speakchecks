/**
 * Engagement-affinity background sync.
 *
 * Precomputes, per viewer, WHO and WHAT they engaged with in the last
 * ENGAGE_WINDOW_DAYS, and writes it to ENGAGE_COLLECTION for the feeds to read with
 * a single `_id` lookup. See utils/engagementBoost.js for why this cannot live in
 * the request path (a 90-day Hive comment walk costs 0.2-1.1s; discover answers in
 * ~0.12s).
 *
 * It runs IN-PROCESS, not as a worker thread — like services/commentCounts.js, the
 * work is Hive network I/O rather than CPU, so it yields the event loop on every
 * await and never blocks feed serving. It also keeps it clear of the worker
 * hot-reload hazard, where editing a `services/*Worker.js` file changes live
 * production on the next spawn while the request path still holds the old code.
 *
 * ── The queue is DEMAND-SEEDED ────────────────────────────────────────────────
 * We do not crawl the user table. utils/engagementBoost.js queues a viewer the first
 * time they actually ask for a feed, and again once their row goes stale, so Hive
 * load is bounded by real traffic instead of by how many accounts exist — and we
 * never spend an RPC on someone who has not opened the site in months.
 */
const { getDb } = require('../utils/db');
const { fetchAccountComments } = require('../utils/hive');
const { fetchAutoTagsOrdered, fetchViewerWeights, pickWinner } = require('../utils/effectiveTags');
const { takeQueued, dequeue, forget, setWarmer } = require('../utils/engagementBoost');
const {
  ENGAGE_SYNC_ENABLED, ENGAGE_SYNC_INTERVAL_SEC, ENGAGE_SYNC_CONCURRENCY, ENGAGE_SYNC_PER_TICK,
  ENGAGE_WINDOW_DAYS, ENGAGE_HALFLIFE_DAYS, ENGAGE_W_COMMENT, ENGAGE_W_RESHARE, ENGAGE_W_SAVE,
  ENGAGE_AUTHOR_BLACKLIST, ENGAGE_COMMENTS_VIDEOS_ONLY, ENGAGE_COLLECTION,
  ENGAGE_MAX_COMMENT_PAGES, ENGAGE_MAX_AUTHORS, ENGAGE_MAX_TOPICS, ENABLE_MONGO_WRITES,
} = require('../utils/config');

const DAY = 24 * 60 * 60 * 1000;
const MAX_TOPIC_LOOKUPS = 400;       // bounds the $or on the tag collections

const lc = (s) => String(s || '').trim().toLowerCase().replace(/^@/, '');
const blacklist = new Set(ENGAGE_AUTHOR_BLACKLIST);

const inFlight = new Set();
let indexed = false;

/**
 * How much one engagement still counts, given how long ago it happened.
 *
 * A half-life rather than a cliff: the whole 90-day window stays meaningful (an
 * event at the far edge is worth 0.25) while last week clearly outweighs last
 * quarter. ENGAGE_HALFLIFE_DAYS=0 turns decay off and weighs every event the same.
 */
function decay(ageMs) {
  if (!(ENGAGE_HALFLIFE_DAYS > 0)) return 1;
  return Math.pow(0.5, (ageMs / DAY) / ENGAGE_HALFLIFE_DAYS);
}

/**
 * Which account a comment credits.
 *
 * The ROOT author, not `parent_author`: on a nested reply the parent is just the
 * person you answered, who may have posted nothing at all, while the root author is
 * the creator whose content the whole conversation hangs under.
 *
 * ⚠️ Except under a CONTAINER account (peak.snaps and friends), which is the root
 * author of every snap thread and, left alone, instantly becomes the single biggest
 * "creator" a viewer engages with — measured live, it took 44 of one account's 154
 * comments, more than three times the next real author. A container is not a
 * creator, so the credit falls back to the person actually replied to.
 */
function creditedAuthor(c) {
  const root = lc(c.root_author);
  if (root && !blacklist.has(root)) return root;
  const parent = lc(c.parent_author);
  return parent && !blacklist.has(parent) ? parent : null;
}

/**
 * Everything `username` engaged with in the window, as flat events.
 * @returns {Promise<{events:Array<{author,permlink,kind,at}>, counts:Object}>}
 */
async function collectEvents(db, username, since) {
  const user = lc(username);
  const events = [];
  const counts = { comments: 0, reshares: 0, saves: 0, self: 0, blacklisted: 0 };

  const [comments, reshares, playlists] = await Promise.all([
    fetchAccountComments(user, since, { maxPages: ENGAGE_MAX_COMMENT_PAGES }),
    db.collection('reshares')
      .find({ username: user, reshared_at: { $gte: new Date(since) } },
        { projection: { author: 1, permlink: 1, reshared_at: 1 } }).toArray(),
    db.collection('playlists')
      .find({ owner: user, items: { $exists: true, $ne: [] } },
        { projection: { items: 1 } }).toArray(),
  ]);

  for (const c of comments) {
    const author = creditedAuthor(c);
    if (!author) { counts.blacklisted += 1; continue; }
    // Self-engagement is dropped, and this is not a nicety. Creators are by far the
    // heaviest commenters on their own threads — one account here had 40 replies
    // under its own posts, second only to the snap container — so counting them would
    // turn every creator's discover page into their own back catalogue.
    if (author === user) { counts.self += 1; continue; }
    counts.comments += 1;
    events.push({ author, permlink: c.root_permlink, kind: 'comment', at: c.created });
  }

  for (const r of reshares) {
    const author = lc(r.author);
    if (!author || author === user || blacklist.has(author)) continue;
    counts.reshares += 1;
    events.push({ author, permlink: r.permlink, kind: 'reshare', at: new Date(r.reshared_at).getTime() });
  }

  for (const pl of playlists) {
    for (const it of pl.items || []) {
      const author = lc(it.author);
      const at = new Date(it.added_at).getTime();
      if (!author || author === user || blacklist.has(author)) continue;
      if (!Number.isFinite(at) || at < since) continue;
      counts.saves += 1;
      events.push({ author, permlink: it.permlink, kind: 'save', at });
    }
  }

  return { events, counts };
}

/**
 * Winning topic for each engaged post that is actually a 3Speak video.
 *
 * Reuses the feeds' own winner-tag machinery (utils/effectiveTags.js) so an
 * "engaged topic" is the exact same thing a candidate's `winnerTag` is — anything
 * else and the two would drift and the match would quietly stop firing.
 *
 * Posts that are not 3Speak videos simply have no row and resolve to null.
 * @returns {Promise<Map<string,string|null>>} "author/permlink" (HIVE) -> tag
 */
async function resolveTopics(db, events) {
  const hiveKeys = [];
  const seen = new Set();
  for (const e of events) {
    if (!e.permlink) continue;
    const id = `${e.author}/${e.permlink}`;
    if (seen.has(id)) continue;
    seen.add(id);
    hiveKeys.push({ author: e.author, permlink: e.permlink });
    if (hiveKeys.length >= MAX_TOPIC_LOOKUPS) break;
  }
  if (!hiveKeys.length) return new Map();

  // HIVE key -> ASSET key. Auto tags are stored against the asset (owner + asset
  // permlink) while viewer tags are stored against the Hive post, so the two halves
  // need different keys for the same video.
  const [embeds, legacy] = await Promise.all([
    db.collection('embed-video').find(
      { $or: hiveKeys.map((k) => ({ hive_author: k.author, hive_permlink: k.permlink })) },
      { projection: { owner: 1, permlink: 1, hive_author: 1, hive_permlink: 1 } },
    ).toArray(),
    db.collection('videos').find(
      { $or: hiveKeys.map((k) => ({ owner: k.author, permlink: k.permlink })) },
      { projection: { owner: 1, permlink: 1 } },
    ).toArray(),
  ]);

  const assetByHive = new Map();
  for (const v of legacy) assetByHive.set(`${lc(v.owner)}/${v.permlink}`, { author: lc(v.owner), permlink: v.permlink });
  // Embeds win on conflict: a legacy row can linger for a post the embed pipeline now owns.
  for (const e of embeds) assetByHive.set(`${lc(e.hive_author)}/${e.hive_permlink}`, { author: lc(e.owner), permlink: e.permlink });

  const known = hiveKeys.filter((k) => assetByHive.has(`${k.author}/${k.permlink}`));
  if (!known.length) return new Map();

  const [autoMap, viewerMap] = await Promise.all([
    fetchAutoTagsOrdered(db, known.map((k) => assetByHive.get(`${k.author}/${k.permlink}`))),
    fetchViewerWeights(db, known),
  ]);

  const out = new Map();
  for (const k of known) {
    const hiveId = `${k.author}/${k.permlink}`;
    const ak = assetByHive.get(hiveId);
    const winner = pickWinner(autoMap.get(`${ak.author}/${ak.permlink}`) || [], viewerMap.get(hiveId) || {});
    out.set(hiveId, winner);
  }
  return out;
}

/** Keep the heaviest N entries of a weight map, rounded, as a plain object. */
function topN(map, n) {
  return Object.fromEntries(
    [...map.entries()]
      .filter(([, w]) => w > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, w]) => [k, Math.round(w * 1000) / 1000]),
  );
}

const KIND_WEIGHT = { comment: ENGAGE_W_COMMENT, reshare: ENGAGE_W_RESHARE, save: ENGAGE_W_SAVE };

/** Build and store one viewer's affinity row. */
async function syncUser(db, username) {
  const user = lc(username);
  const startedAt = Date.now();
  const since = startedAt - ENGAGE_WINDOW_DAYS * DAY;

  const { events, counts } = await collectEvents(db, user, since);

  const topicOf = events.length ? await resolveTopics(db, events) : new Map();

  const authors = new Map();
  const topics = new Map();
  let topicEvents = 0;               // events we could resolve a topic for (the evidence gate)
  for (const e of events) {
    const w = (KIND_WEIGHT[e.kind] || 1) * decay(Math.max(0, startedAt - e.at));
    if (!(w > 0)) continue;
    const topic = topicOf.get(`${e.author}/${e.permlink}`) || null;

    // Opt-in strictness: count a comment only if it was left on a 3Speak video (i.e.
    // the post resolved to one of ours). Off by default — replying to a creator's
    // text post is still a signal you want more of them.
    if (ENGAGE_COMMENTS_VIDEOS_ONLY && e.kind === 'comment' && !topicOf.has(`${e.author}/${e.permlink}`)) continue;

    authors.set(e.author, (authors.get(e.author) || 0) + w);
    if (topic) { topics.set(topic, (topics.get(topic) || 0) + w); topicEvents += 1; }
  }

  // Topics are stored as a SHARE of the viewer's total topical engagement, not a raw
  // weight. A share is self-bounding in [0,1], so a heavy commenter cannot saturate
  // the topic term the way a raw count would, and "40% of what I engage with is tech"
  // means the same thing for someone with 10 events and someone with 300.
  const totalTopic = [...topics.values()].reduce((a, b) => a + b, 0);
  const shares = new Map();
  if (totalTopic > 0) for (const [t, w] of topics) shares.set(t, w / totalTopic);

  const doc = {
    authors: topN(authors, ENGAGE_MAX_AUTHORS),
    topics: topN(shares, ENGAGE_MAX_TOPICS),
    topic_events: topicEvents,
    events: { comments: counts.comments, reshares: counts.reshares, saves: counts.saves },
    skipped: { self: counts.self, blacklisted: counts.blacklisted },
    window_days: ENGAGE_WINDOW_DAYS,
    updated_at: new Date(startedAt),
    duration_ms: Date.now() - startedAt,
  };

  if (ENABLE_MONGO_WRITES) {
    await db.collection(ENGAGE_COLLECTION).updateOne({ _id: user }, { $set: doc }, { upsert: true });
  }
  return { user, ...doc };
}

async function ensureIndexes(db) {
  if (indexed) return;
  indexed = true;
  if (!ENABLE_MONGO_WRITES) return;
  try {
    await db.collection(ENGAGE_COLLECTION).createIndex({ updated_at: 1 }, { name: 'engagement_updated_at' });
    // resolveTopics() looks embeds up by their HIVE key, and `embed-video` had no
    // index on that pair — only on {owner, hive_permlink} and {owner, permlink},
    // which a hive_author lookup cannot use. Measured before adding it: a 200-clause
    // $or was a full COLLSCAN of all 12,370 docs at ~800ms, per user, per sync.
    await db.collection('embed-video').createIndex(
      { hive_author: 1, hive_permlink: 1 }, { name: 'hive_author_hive_permlink' },
    );
  } catch (e) {
    console.warn('[engagement] index failed:', e && e.message);
  }
}

/**
 * Sync one viewer now, unless we are already at the concurrency cap or already
 * syncing them. Fire-and-forget: it is a background refresh, and the caller (a feed
 * request) must never wait on it or learn whether it worked.
 */
function warm(username) {
  const user = lc(username);
  if (!ENGAGE_SYNC_ENABLED || !user) return;
  if (inFlight.has(user) || inFlight.size >= ENGAGE_SYNC_CONCURRENCY) return;   // stays queued
  inFlight.add(user);
  dequeue(user);                       // taken — don't let the next tick walk Hive again
  Promise.resolve()
    .then(async () => {
      const db = getDb();
      await ensureIndexes(db);
      await syncUser(db, user);
      // The request path cached a MISS for this viewer. Drop it, or they browse for
      // the next ENGAGE_CACHE_TTL_MS with the boost silently off.
      forget(user);
    })
    .catch((e) => console.warn('[engagement] sync failed for', user, '-', e && e.message))
    .finally(() => { inFlight.delete(user); });
}

/** Drain the demand-seeded queue on an interval, respecting the concurrency cap. */
function scheduleEngagementSync() {
  if (!ENGAGE_SYNC_ENABLED) {
    console.log('[engagement] sync disabled (ENGAGE_SYNC_ENABLED=false)');
    return;
  }
  setWarmer(warm);
  const tick = () => {
    const budget = Math.min(ENGAGE_SYNC_PER_TICK, Math.max(0, ENGAGE_SYNC_CONCURRENCY - inFlight.size));
    if (budget <= 0) return;
    for (const u of takeQueued(budget)) warm(u);
  };
  setInterval(tick, Math.max(10, ENGAGE_SYNC_INTERVAL_SEC) * 1000);
  console.log(`[engagement] sync ready — demand-seeded, ${ENGAGE_SYNC_INTERVAL_SEC}s tick, ${ENGAGE_SYNC_CONCURRENCY} concurrent, ${ENGAGE_WINDOW_DAYS}d window`);
}

module.exports = { syncUser, scheduleEngagementSync, collectEvents, resolveTopics, decay, creditedAuthor };
