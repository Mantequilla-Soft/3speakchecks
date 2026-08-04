/**
 * Shared feed ranking/filtering so every discovery feed behaves the same:
 *   1. interest boost  — multiply score for videos whose tags match ?interests=
 *   2. retention       — multiply score by the cached retention factor (algo.md)
 *   3. sort by score
 *   4. hide-seen       — drop videos the ?currentuser= has already watched
 *
 * All steps are no-ops when their input is absent (no interests / no currentuser /
 * no retention record), so callers stay backwards compatible. The "new videos"
 * feeds deliberately don't use this (they must stay purely chronological).
 */
const {
  INTEREST_MULTIPLIER, parseInterests,
} = require('./interests');
const { applyRetention } = require('./retentionRank');
const { getPremiumSet, applyPremiumBoost } = require('./premiumBoost');
const { normUser, getUserFilters, applyUserFilters } = require('./userFilters');
const { getWinners } = require('./effectiveTags');

// Asset key for interest/transcription + retention lookups: embed candidates carry
// the asset id in `_embedPermlink`, legacy videos use `permlink`.
function defaultSubKey(v) {
  return { author: v.owner, permlink: v._source === 'embed' ? (v._embedPermlink || v.permlink) : v.permlink };
}
// HIVE key for viewer-tag votes (they're keyed by the post's hive author+permlink):
// embed candidates carry hive author in `author`, legacy use owner; permlink is hive.
function defaultHiveKey(v) {
  return { author: v.author || v.owner, permlink: v.permlink };
}
// watch_history key: "user:owner:hivePermlink" — v.permlink is the Hive permlink here.
function defaultWatchKey(v) { return `${v.owner}:${v.permlink}`; }

// Interest boost, WINNER-ONLY: each video collapses to a single winning topic
// (highest combined weight of viewer votes + auto tags), and we boost only when
// that one winner is in the caller's interests. `multiplier` lets a feed weight
// interests differently (discover leans on them harder than trending does).
async function applyInterestBoost(db, req, videos, subKey = defaultSubKey, scoreField = 'trending_score', multiplier = INTEREST_MULTIPLIER, hiveKey = defaultHiveKey) {
  const interestSet = parseInterests(req);
  if (!interestSet.size || !videos.length) return;
  const winners = await getWinners(db, videos, subKey, hiveKey);
  for (const v of videos) {
    const winner = winners.get(v);
    if (winner) v.winner_tag = winner;
    if (winner && interestSet.has(winner)) {
      v[scoreField] = (Number(v[scoreField]) || 0) * multiplier;
      v.interest_match = true;
    }
  }
}

/**
 * Should watched videos be dropped? Hide-watched is a *preference*, so it's opt-out
 * via ?hidewatched=0. It defaults to TRUE when absent, because the deployed prod
 * frontend only ever sends ?currentuser= when its "Hide watched" setting is on —
 * so omitting the param must keep behaving exactly as it did before.
 */
function wantsHideWatched(req) {
  const raw = req.query.hidewatched;
  if (raw == null) return true;
  const s = String(raw).trim().toLowerCase();
  return !(s === '0' || s === 'false' || s === 'no');
}

/**
 * Everything we drop from a feed once we know who is asking:
 *   1. videos the user marked "not interested"      (always)
 *   2. every video by a creator the user dismissed  (always)
 *   3. videos the user already watched              (only when hide-watched is on)
 *
 * (1) and (2) are explicit dismissals, not a toggleable preference — a user who
 * turns hide-watched OFF must still never see content they told us to hide.
 */
async function filterForUser(db, req, videos, wkey = defaultWatchKey, ukey = defaultUserKey) {
  const currentuser = normUser(req.query.currentuser);
  if (!currentuser || !videos.length) return videos;

  const filters = await getUserFilters(db, currentuser);
  let out = applyUserFilters(videos, filters, ukey);

  if (!wantsHideWatched(req) || !out.length) return out;

  const ids = out.map((v) => `${currentuser}:${wkey(v)}`);
  const watched = await db.collection('watch_history')
    .find({ _id: { $in: ids } }, { projection: { _id: 1 } }).toArray();
  const seen = new Set(watched.map((w) => w._id));
  return out.filter((v) => !seen.has(`${currentuser}:${wkey(v)}`));
}

// Suppression key: owner + HIVE permlink (what the card/watch page address).
function defaultUserKey(v) {
  return { owner: v.owner || v.author, permlink: v.permlink };
}

/** Back-compat alias — filterForUser now also applies explicit dismissals. */
const filterWatched = filterForUser;

/** Algo-off / simple feed: ?chrono=1 → skip ranking, sort newest-first. */
function wantsChrono(req) {
  const v = String(req.query.chrono || '').trim().toLowerCase();
  return v === '1' || v === 'true';
}
const createdOf = (v) => new Date(v.created || v.created_at || v.createdAt || 0).getTime() || 0;

/**
 * Full pipeline: interest boost → retention → sort desc → hide dismissed/seen.
 * With ?chrono=1 the ranking is skipped entirely and videos are sorted
 * newest-first (still with dismissals/hide-watched applied).
 * @returns {Promise<Array>} the ranked, filtered videos.
 */
async function rankFeed(db, req, videos, opts = {}) {
  const scoreField = opts.scoreField || 'trending_score';
  const subKey = opts.subKey || defaultSubKey;
  const wkey = opts.wkey || defaultWatchKey;
  if (wantsChrono(req)) {
    videos.sort((a, b) => createdOf(b) - createdOf(a));
    return filterForUser(db, req, videos, wkey, opts.ukey || defaultUserKey);
  }
  await applyInterestBoost(db, req, videos, subKey, scoreField);
  applyPremiumBoost(videos, getPremiumSet(db), { scoreField });
  await applyRetention(db, videos, { scoreField, keyFn: opts.retentionKeyFn });
  videos.sort((a, b) => (Number(b[scoreField]) || 0) - (Number(a[scoreField]) || 0));
  return filterForUser(db, req, videos, wkey, opts.ukey || defaultUserKey);
}

module.exports = {
  rankFeed, applyInterestBoost, filterForUser, filterWatched, wantsHideWatched, wantsChrono,
  defaultSubKey, defaultWatchKey, defaultUserKey, defaultHiveKey,
};
