/**
 * Shared building blocks for the feed tests (tests/feeds).
 *
 * - A pinned clock that fakes Date only, so the MongoDB driver and supertest keep
 *   their real timers. Every date a test writes is relative to that clock, which is
 *   also what the routes compare against (no route here uses Mongo's $$NOW).
 * - Builders for the documents the feeds read: legacy `videos`, `embed-video`
 *   (long-form, shorts, stories) and discover / interest pool entries. Each builder
 *   returns a doc that every feed would show; a test then overrides the one field
 *   whose effect it is proving.
 * - resetFeedCaches(): the in-process caches the feed modules keep between
 *   requests, dropped so every test starts cold.
 */

/** The moment the feed tests treat as "now" unless a test says otherwise. */
const NOW = new Date('2026-11-01T12:00:00.000Z');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Pin Date (and only Date). Undo with jest.useRealTimers(). */
function pinClock(at = NOW) {
  jest.useFakeTimers({
    now: new Date(at),
    doNotFake: [
      'nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
      'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance',
    ],
  });
  return new Date(at);
}

/** Move the pinned clock forward. */
function advanceClock(ms) {
  jest.setSystemTime(new Date(Date.now() + ms));
}

const hoursAgo = (h) => new Date(Date.now() - h * HOUR);
const daysAgo = (d) => new Date(Date.now() - d * DAY);
const hoursFromNow = (h) => new Date(Date.now() + h * HOUR);

/** Let background promises (cache warmers, refreshes) settle. No timers involved. */
async function flushPromises(rounds = 5) {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setImmediate(r));
}

/**
 * Wait until `predicate()` (sync or async) is truthy: for background work that
 * makes a MongoDB round trip (a cache refresh behind a stale read), which a few
 * event-loop turns do not cover. Polls on real timers (the pinned clock fakes Date
 * only) and fails loudly after `timeoutMs` instead of hanging.
 */
async function waitFor(predicate, timeoutMs = 3000) {
  const realNow = () => performance.now();
  const start = realNow();
  for (;;) {
    if (await predicate()) return;
    if (realNow() - start > timeoutMs) throw new Error('waitFor: condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ── document builders ───────────────────────────────────────────────────────

/** A legacy `videos` doc that every legacy feed would show. */
function legacyVideo(over = {}) {
  const owner = over.owner || 'alice';
  const permlink = over.permlink || 'legacy-video';
  return {
    owner,
    permlink,
    title: `Legacy ${permlink}`,
    status: 'published',
    created: hoursAgo(1),
    tags_v2: [],
    views: 0,
    ...over,
  };
}

/** A long-form `embed-video` doc, linked to its Hive post, that every feed would show. */
function embedVideo(over = {}) {
  const owner = over.owner || 'alice';
  const permlink = over.permlink || 'asset-1';
  return {
    owner,
    permlink,                               // the asset id
    hive_author: owner,
    hive_permlink: `hive-${permlink}`,      // the Hive post
    hive_title: `Title ${permlink}`,
    hive_tags: [],
    status: 'published',
    short: false,
    listed_on_3speak: true,
    createdAt: hoursAgo(1),
    views: 0,
    duration: 60,
    thumbnail_url: `https://img.example/${permlink}.png`,
    manifest_cid: `cid-${permlink}`,
    ...over,
  };
}

/** A published, processed short. Shorts address their Hive post through embed_url. */
function shortVideo(over = {}) {
  const owner = over.owner || 'alice';
  const permlink = over.permlink || 'short-1';
  return {
    owner,
    permlink,
    embed_url: `@${owner}/snap-${permlink}`,
    embed_title: `Short ${permlink}`,
    thumbnail_url: `https://img.example/${permlink}.png`,
    status: 'published',
    short: true,
    processed: true,
    createdAt: hoursAgo(1),
    views: 0,
    frontend_app: '3speak',
    ...over,
  };
}

/** A live 24h story: a short with the story window set (routes/stories.js). */
function storyVideo(over = {}) {
  const postedAt = over.story_posted_at || hoursAgo(1);
  return shortVideo({
    story: true,
    story_posted_at: postedAt,
    story_expires_at: new Date(new Date(postedAt).getTime() + DAY),
    hive_permlink: `snap-${over.permlink || 'short-1'}`,
    ...over,
  });
}

/**
 * A discover / interest pool entry (what services/discoverWorker.js writes) for an
 * embed video. Pair it with embedVideo() of the same owner + assetPermlink so
 * hydrate() can render it.
 */
function poolEntry(over = {}) {
  const owner = over.owner || 'alice';
  const assetPermlink = over.assetPermlink || 'asset-1';
  return {
    owner,
    author: owner,
    permlink: `hive-${assetPermlink}`,
    assetPermlink,
    source: 'embed',
    src: 'recent',
    created: hoursAgo(2),
    tags: [],
    winnerTag: null,
    nsfw: false,
    base: 1,
    ...over,
  };
}

/** A pool entry for a legacy video (pair with legacyVideo() of the same key). */
function legacyPoolEntry(over = {}) {
  const owner = over.owner || 'alice';
  const permlink = over.permlink || 'legacy-video';
  return poolEntry({ owner, author: owner, permlink, assetPermlink: permlink, source: 'legacy', ...over });
}

/**
 * Insert an embed video together with its pool entry, so the pair renders through
 * the discover / interests / related routes. Returns both.
 */
async function seedPooled(db, { pool = 'discover-pool', video = {}, entry = {} } = {}) {
  const v = embedVideo(video);
  const e = poolEntry({ owner: v.owner, author: v.hive_author, assetPermlink: v.permlink, permlink: v.hive_permlink, created: v.createdAt, ...entry });
  await db.collection('embed-video').insertOne(v);
  await db.collection(pool).insertOne(e);
  return { video: v, entry: e };
}

/** A watch_history row, keyed the way the feeds look it up. */
function watched(viewer, owner, permlink, over = {}) {
  return {
    _id: `${viewer}:${owner}:${permlink}`,
    username: viewer,
    author: owner,
    permlink,
    last_watched_at: hoursAgo(1),
    ...over,
  };
}

// ── caches ──────────────────────────────────────────────────────────────────

/**
 * Drop every in-process cache the feed modules keep, and reload the moderation
 * hidden-creator set from the (just emptied) database. Call in a beforeEach that
 * runs after the database helper has cleared the collections.
 */
async function resetFeedCaches(db) {
  require('../../utils/feedCache').invalidate();
  require('../../utils/discoverPool').invalidate();
  require('../../utils/interestPool').invalidate();
  require('../../utils/curation').invalidate();
  require('../../utils/premiumBoost').invalidate();
  require('../../utils/followBoost').invalidate();
  require('../../utils/suggestedCreators').invalidate();
  require('../../utils/commentBoost').invalidate();
  require('../../utils/cache').sortedShortsCache.clear();
  if (db) await require('../../utils/hiddenCreators').refresh(db);
}

/** Hide a creator platform-wide (contentcreators.hidden) and reload the cached set. */
async function hideCreator(db, username) {
  await db.collection('contentcreators').updateOne(
    { username }, { $set: { username, hidden: true } }, { upsert: true },
  );
  await require('../../utils/hiddenCreators').refresh(db);
}

/** "Not interested" in one video, and "don't show this creator", as a viewer. */
const dismissVideo = (db, viewer, owner, permlink) =>
  db.collection('user-hidden-videos').insertOne({ username: viewer, owner, permlink });
const dismissCreator = (db, viewer, creator) =>
  db.collection('user-hidden-creators').insertOne({ username: viewer, creator });

/**
 * Swallow console.error for a test that drives an error path on purpose, and hand
 * back the spy so the test can check the route really logged it. The suite runs
 * with restoreMocks, so the next test logs normally again.
 */
const quietErrors = () => jest.spyOn(console, 'error').mockImplementation(() => {});
const quietWarnings = () => jest.spyOn(console, 'warn').mockImplementation(() => {});

/** permlinks of a response list, for order assertions. */
const permlinks = (list) => (list || []).map((v) => v.permlink);

module.exports = {
  NOW, HOUR, DAY,
  pinClock, advanceClock, hoursAgo, daysAgo, hoursFromNow, flushPromises, waitFor,
  legacyVideo, embedVideo, shortVideo, storyVideo, poolEntry, legacyPoolEntry, seedPooled, watched,
  resetFeedCaches, hideCreator, dismissVideo, dismissCreator, permlinks, quietErrors, quietWarnings,
};
