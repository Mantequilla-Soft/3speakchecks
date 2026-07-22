/**
 * "Follow these" creator suggestions for the discover / interests feeds.
 *
 * Given the caller's interests, surface creators who:
 *   - posted videos matching those interests in the last SUGGEST_WINDOW_DAYS, and
 *   - got a good amount of engagement (views + comments + reshares) on recent work,
 * excluding the caller and anyone they already follow.
 *
 * ── Two data sources, split by what each is good at ──────────────────────────────
 *   • Topic membership → `leaderboard-topics-v2` (pre-built upstream, 30d window).
 *     This answers "which creators make <topic> content recently" ROBUSTLY — it does
 *     NOT depend on a fresh video having been transcribed yet, which the winner-tag
 *     path (subtitles-tags) does, so it doesn't miss brand-new uploads.
 *   • Engagement ranking → the video docs + `video-comment-counts` + `reshares`,
 *     aggregated over each creator's recent videos. This is the views/comments/
 *     reshares the caller asked to sort by.
 *
 * The heavy per-creator engagement map is user-independent, so it's built once and
 * cached; each request then just does a cheap topic lookup + in-memory rank.
 */
const {
  SUGGEST_CREATORS_ENABLED, SUGGEST_WINDOW_DAYS, SUGGEST_CACHE_MS,
  SUGGEST_W_VIEWS, SUGGEST_W_COMMENTS, SUGGEST_W_RESHARES, LEADERBOARD_EXCLUDED_USERS,
} = require('./config');
const { expandTag } = require('./interestTags');
const { hiddenListSync } = require('./hiddenCreators');
const { mulberry32 } = require('./hive');
const { shuffle } = require('./discoverScore');

const DAY = 24 * 60 * 60 * 1000;
const lc = (s) => String(s || '').trim().toLowerCase().replace(/^@/, '');
const thumb = (permlink, fallback) => fallback || `https://img.3speak.tv/${permlink}/thumbnail.png`;

let engagementCache = { at: 0, map: new Map() };

/**
 * Map<hiveAuthor, {views, comments, reshares, videoCount, sample}> aggregated over
 * every published video younger than SUGGEST_WINDOW_DAYS. Cached (user-independent).
 * `sample` is the creator's most-viewed recent video, for the tile.
 */
async function getRecentCreatorEngagement(db, { force = false } = {}) {
  if (!force && engagementCache.map.size && Date.now() - engagementCache.at < SUGGEST_CACHE_MS) {
    return engagementCache.map;
  }
  const cutoff = new Date(Date.now() - SUGGEST_WINDOW_DAYS * DAY);
  const [embed, legacy, commentRows, reshareRows] = await Promise.all([
    db.collection('embed-video').find(
      {
        status: 'published', short: false, listed_on_3speak: true,
        createdAt: { $gte: cutoff }, hive_author: { $ne: null }, hive_permlink: { $ne: null },
        unavailable: { $ne: true }, hiddenFromFeed: { $ne: true },
      },
      { projection: { hive_author: 1, hive_permlink: 1, permlink: 1, views: 1, createdAt: 1, hive_title: 1, thumbnail_url: 1 } },
    ).toArray(),
    db.collection('videos').find(
      {
        status: 'published', publishFailed: { $ne: true }, created: { $gte: cutoff },
        unavailable: { $ne: true }, hiddenFromFeed: { $ne: true },
      },
      { projection: { owner: 1, author: 1, permlink: 1, views: 1, created: 1, title: 1, thumbnail: 1 } },
    ).toArray(),
    db.collection('video-comment-counts').find({}, { projection: { comments: 1 } }).toArray(),
    db.collection('reshares').aggregate([
      { $group: { _id: { a: '$author', p: '$permlink' }, n: { $sum: 1 } } },
    ]).toArray(),
  ]);

  const commentByKey = new Map(commentRows.map((r) => [r._id, r.comments || 0]));      // _id = author/permlink
  const reshareByKey = new Map(reshareRows.map((r) => [`${lc(r._id.a)}/${r._id.p}`, r.n]));

  const byAuthor = new Map();
  const add = (author, hivePermlink, views, title, thumbnail, created) => {
    const a = lc(author);
    if (!a || !hivePermlink) return;
    const key = `${a}/${hivePermlink}`;
    const v = Math.max(0, Number(views) || 0);
    const comments = commentByKey.get(key) || 0;
    const reshares = reshareByKey.get(key) || 0;
    let e = byAuthor.get(a);
    if (!e) { e = { author: a, views: 0, comments: 0, reshares: 0, videoCount: 0, sample: null, _sv: -1 }; byAuthor.set(a, e); }
    e.views += v; e.comments += comments; e.reshares += reshares; e.videoCount += 1;
    if (v > e._sv) { e._sv = v; e.sample = { permlink: hivePermlink, title: title || '', thumbnail, created: created || null }; }
  };

  for (const ev of embed) add(ev.hive_author, ev.hive_permlink, ev.views, ev.hive_title, thumb(ev.permlink, ev.thumbnail_url), ev.createdAt);
  for (const lv of legacy) add(lv.author || lv.owner, lv.permlink, lv.views, lv.title, thumb(lv.permlink, lv.thumbnail), lv.created);

  engagementCache = { at: Date.now(), map: byAuthor };
  return byAuthor;
}

/**
 * PURE ranking step (testable): score candidates by their engagement, drop the
 * caller + followed + zero-signal creators, sort, take the top `limit`.
 * @param {Array<{author:string, topics:string[]}>} candidates
 * @param {Map} engagement  from getRecentCreatorEngagement
 */
function rankCandidates(candidates, engagement, opts = {}) {
  const wv = opts.wViews ?? SUGGEST_W_VIEWS;
  const wc = opts.wComments ?? SUGGEST_W_COMMENTS;
  const wr = opts.wReshares ?? SUGGEST_W_RESHARES;
  const limit = Math.max(1, opts.limit || 12);
  const exclude = lc(opts.excludeUser);
  const followSet = opts.followSet || null;

  const scored = [];
  for (const cand of candidates) {
    const author = lc(cand.author);
    if (!author || author === exclude) continue;
    if (followSet && followSet.has(author)) continue;          // already following → not a suggestion
    const e = engagement.get(author);
    if (!e || e.videoCount === 0) continue;                    // no recent measurable work
    const score = wv * Math.log1p(e.views) + wc * Math.log1p(e.comments) + wr * Math.log1p(e.reshares);
    if (!(score > 0)) continue;
    scored.push({
      author,
      score: Math.round(score * 1000) / 1000,
      views: e.views, comments: e.comments, reshares: e.reshares, videoCount: e.videoCount,
      matchedTopics: cand.topics || [],
      sample: e.sample,
    });
  }
  scored.sort((a, b) => (b.score - a.score) || (b.views - a.views) || a.author.localeCompare(b.author));
  return scored.slice(0, limit);
}

/**
 * The endpoint's workhorse. Returns up to `limit` suggested creators, profile-enriched.
 */
async function getSuggestedCreators(db, { interests, followSet, excludeUser, limit = 12, pool = 0, seed = null } = {}) {
  if (!SUGGEST_CREATORS_ENABLED || !interests || !interests.length) return [];

  // Interest → topic set (a category like "tech-science" rolls up to its children).
  const topics = new Set();
  for (const i of interests) for (const t of expandTag(lc(i))) topics.add(t);
  if (!topics.size) return [];

  // Candidate creators active in those topics in the 30d board (not hidden).
  const rows = await db.collection('leaderboard-topics-v2').aggregate([
    { $match: { window: '30d', topic: { $in: [...topics] }, video_uploads: { $gt: 0 }, user: { $nin: [...hiddenListSync(), ...LEADERBOARD_EXCLUDED_USERS] } } },
    { $group: { _id: '$user', topics: { $addToSet: '$topic' } } },
  ]).toArray();
  if (!rows.length) return [];

  const engagement = await getRecentCreatorEngagement(db);
  // Rank up to `pool` (≥ limit); then, with a seed, take a seeded-random `limit` out of
  // that pool so discover (seed + pool=20) shows a different slice than interests
  // (deterministic top). Re-sorted by score so the row still reads best-first.
  const poolSize = Math.max(limit, Number(pool) || 0);
  const ranked = rankCandidates(
    rows.map((r) => ({ author: r._id, topics: r.topics })),
    engagement,
    { followSet, excludeUser, limit: poolSize },
  );
  if (!ranked.length) return [];

  let top;
  if (seed != null && ranked.length > limit) {
    const rng = mulberry32((Number(seed) >>> 0) || 1);
    top = shuffle(ranked, rng).slice(0, limit).sort((a, b) => b.score - a.score);
  } else {
    top = ranked.slice(0, limit);
  }

  // Enrich the top slice with display name + avatar for the tile (one bounded query).
  const profs = await db.collection('hiveprofiles')
    .find({ username: { $in: top.map((t) => t.author) } }, { projection: { username: 1, display_name: 1, profile_image: 1 } })
    .toArray();
  const profByUser = new Map(profs.map((p) => [lc(p.username), p]));
  for (const t of top) {
    const p = profByUser.get(t.author);
    t.display_name = (p && p.display_name) || t.author;
    t.avatar = (p && p.profile_image) || `https://images.hive.blog/u/${t.author}/avatar`;
  }
  return top;
}

/** Test/ops hook — drop the cached engagement map. */
function invalidate() { engagementCache = { at: 0, map: new Map() }; }

module.exports = { getSuggestedCreators, getRecentCreatorEngagement, rankCandidates, invalidate };
