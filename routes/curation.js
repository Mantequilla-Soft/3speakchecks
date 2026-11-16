/**
 * Curator page: GET /curation/:user
 *
 * What a voter did as a curator on 3Speak over the last CURATION_DAYS: the 3Speak
 * posts they voted on (their "picks"), the curation rewards those votes paid, and
 * a "found it early" badge where their vote came before the crowd.
 *
 * Votes and rewards come from the account's own Hive history (`vote` ops it cast,
 * `curation_reward` virtual ops it received), the post's votes from
 * get_active_votes, and "is this a 3Speak post" from our own collections
 * (embed-video, legacy videos, embed-audio). Posts of hidden or reward-blocked
 * creators are left out.
 *
 * Only votes CAST ON 3SPEAK count: a Hive vote carries no app, so the frontend
 * reports each vote it broadcasts (POST /curation/vote, with the voter's session
 * vouch, utils/progressVouch.js) and we keep that in CURATION_VOTES_COLLECTION.
 * A post shows only when both agree: the report (it was cast here) and the
 * chain history (it is really there, at that weight). Nothing before the
 * reports started counts, so a curator page fills from then on.
 *
 * Found it early (documented for the page): the votes cast BEFORE yours carried at
 * most CURATION_EARLY_SHARE (10%) of the post's total upvote weight (rshares), and
 * the post went on to collect at least CURATION_EARLY_MIN_VOTES (10) votes. So you
 * were there before 90% of the value arrived, on a post others then agreed with.
 * A post still paying out can still gain votes, so its badge can appear later.
 *
 * History reads are heavy (a busy curator casts thousands of votes a month), so a
 * result is kept in memory per account for CURATION_CACHE_MIN, one read in flight
 * per account, and the route is rate limited per IP.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { getDb } = require('../utils/db');
const { historySince, hiveRpcBatch } = require('../utils/hive');
const { isHiddenSync } = require('../utils/hiddenCreators');
const { proveProgressUser } = require('../utils/progressVouch');
const {
  CURATION_DAYS, CURATION_CACHE_MIN, CURATION_MAX_PICKS, CURATION_EARLY_SHARE, CURATION_EARLY_MIN_VOTES,
  AD_REWARD_FLAG_COLLECTION,
} = require('../utils/config');

const router = express.Router();

const ACCOUNT_RE = /^[a-z][a-z0-9.-]{2,15}$/;
const DAY_MS = 24 * 3600 * 1000;
const VOTE_FILTER = 1; // op 0
const CURATION_FILTER = 2 ** 52; // virtual op 52
const VOTES_BATCH = 20;
const CACHE_MAX = 500;
const PERMLINK_RE = /^[a-z0-9-]{1,255}$/;
// Votes cast on 3Speak (POST /curation/vote): { voter, author, permlink, weight, at }.
const CURATION_VOTES_COLLECTION = 'curation-site-votes';
// Kept a while past the page's window, so a reward paid a week after the vote
// still finds its vote.
const SITE_VOTE_KEEP_S = (CURATION_DAYS + 14) * 24 * 3600;

const tsMs = (raw) => Date.parse(/Z$/.test(raw) ? raw : `${raw}Z`);
const key = (author, permlink) => `${author}/${permlink}`;

// A busy curator votes fast: room for that, still a cap per IP.
const voteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: false,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests' },
});

let indexesReady = null;
function siteVotes(db) {
  const coll = db.collection(CURATION_VOTES_COLLECTION);
  if (!indexesReady) {
    indexesReady = (async () => {
      await coll.createIndex({ voter: 1, author: 1, permlink: 1 }, { unique: true });
      await coll.createIndex({ at: 1 }, { expireAfterSeconds: SITE_VOTE_KEEP_S });
    })().catch((err) => { indexesReady = null; console.error('[curation] indexes:', err && err.message); });
  }
  return coll;
}

/** The posts this account voted on while on 3Speak: Set of 'author/permlink'. */
async function siteVoteKeys(db, user) {
  const rows = await siteVotes(db).find({ voter: user }, { projection: { author: 1, permlink: 1 } }).toArray();
  return new Set(rows.map((r) => key(r.author, r.permlink)));
}

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: false,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests' },
});

/** Upvotes this account cast, newest per post: Map key → { author, permlink, percent, at }. */
function votesFrom(entries, user, sinceMs) {
  const out = new Map();
  for (const entry of entries) {
    const e = entry && entry[1];
    const op = e && e.op;
    if (!op || op[0] !== 'vote') continue;
    const v = op[1];
    if (v.voter !== user || !(Number(v.weight) > 0)) continue;
    const at = tsMs(e.timestamp);
    if (!Number.isFinite(at) || at < sinceMs) continue;
    const k = key(v.author, v.permlink);
    const prev = out.get(k);
    if (!prev || prev.at < at) out.set(k, { author: v.author, permlink: v.permlink, percent: Number(v.weight) / 100, at });
  }
  // A later unvote or downvote takes the post off the list.
  for (const entry of entries) {
    const e = entry && entry[1];
    const op = e && e.op;
    if (!op || op[0] !== 'vote' || op[1].voter !== user || Number(op[1].weight) > 0) continue;
    const k = key(op[1].author, op[1].permlink);
    const prev = out.get(k);
    if (prev && tsMs(e.timestamp) > prev.at) out.delete(k);
  }
  return out;
}

/** Curation rewards this account received: Map key → { vests, at }. */
function rewardsFrom(entries, user, sinceMs) {
  const out = new Map();
  for (const entry of entries) {
    const e = entry && entry[1];
    const op = e && e.op;
    if (!op || op[0] !== 'curation_reward') continue;
    const r = op[1];
    if (r.curator !== user) continue;
    const at = tsMs(e.timestamp);
    if (!Number.isFinite(at) || at < sinceMs) continue;
    const vests = parseFloat(String(r.reward || '').split(' ')[0]) || 0;
    const author = r.author || r.comment_author;
    const permlink = r.permlink || r.comment_permlink;
    if (!author || !permlink) continue;
    const k = key(author, permlink);
    const prev = out.get(k) || { vests: 0, at: 0 };
    out.set(k, { vests: prev.vests + vests, at: Math.max(prev.at, at) });
  }
  return out;
}

/**
 * Where this vote stood among the post's votes (get_active_votes rows):
 * { rank, votes, share (of the post's upvote rshares that was yours), before
 * (share cast before yours), early }.
 */
function standing(votes, user, opts = {}) {
  const earlyShare = opts.earlyShare ?? CURATION_EARLY_SHARE;
  const minVotes = opts.minVotes ?? CURATION_EARLY_MIN_VOTES;
  const ups = (votes || []).filter((v) => Number(v.rshares) > 0 || v.voter === user)
    .map((v) => ({ voter: v.voter, rshares: Math.max(0, Number(v.rshares) || 0), at: tsMs(v.time) }))
    .sort((a, b) => a.at - b.at);
  const mine = ups.findIndex((v) => v.voter === user);
  if (mine < 0) return null;
  const total = ups.reduce((n, v) => n + v.rshares, 0);
  const before = ups.slice(0, mine).reduce((n, v) => n + v.rshares, 0);
  const shareBefore = total > 0 ? before / total : 0;
  return {
    rank: mine + 1,
    votes: ups.length,
    share: total > 0 ? ups[mine].rshares / total : 0,
    before: shareBefore,
    early: ups.length >= minVotes && shareBefore <= earlyShare,
  };
}

/** Which of these posts are on 3Speak, with a title, thumbnail and kind each. */
async function threeSpeakPosts(db, keys) {
  if (!keys.length) return new Map();
  const authors = [...new Set(keys.map((k) => k.author))];
  const permlinks = [...new Set(keys.map((k) => k.permlink))];
  const [embeds, legacy, audios, blocked] = await Promise.all([
    db.collection('embed-video').find(
      { $or: [{ hive_author: { $in: authors }, hive_permlink: { $in: permlinks } }, { owner: { $in: authors }, permlink: { $in: permlinks } }] },
      { projection: { owner: 1, permlink: 1, hive_author: 1, hive_permlink: 1, hive_title: 1, embed_title: 1, thumbnail_url: 1, short: 1 } },
    ).toArray(),
    db.collection('videos').find(
      { owner: { $in: authors }, permlink: { $in: permlinks } },
      { projection: { owner: 1, permlink: 1, title: 1, thumbnail: 1 } },
    ).toArray(),
    db.collection('embed-audio').find(
      { post_permlink: { $in: permlinks } },
      { projection: { owner: 1, post_author: 1, post_permlink: 1, title: 1 } },
    ).toArray(),
    db.collection(AD_REWARD_FLAG_COLLECTION).find(
      { username: { $in: authors }, adRewardDisabled: true }, { projection: { username: 1 } },
    ).toArray(),
  ]);
  const out = new Map();
  for (const a of audios) out.set(key(a.post_author || a.owner, a.post_permlink), { kind: 'audio', title: a.title || '', thumbnail: '' });
  for (const v of legacy) out.set(key(v.owner, v.permlink), { kind: 'video', title: v.title || '', thumbnail: v.thumbnail || '' });
  for (const v of embeds) {
    out.set(key(v.hive_author || v.owner, v.hive_permlink || v.permlink), {
      kind: v.short === true ? 'short' : 'video',
      title: v.hive_title || v.embed_title || '',
      thumbnail: v.thumbnail_url || `https://img.3speak.tv/${v.permlink}/thumbnail.png`,
      asset_permlink: v.permlink,
    });
  }
  const no = new Set(blocked.map((b) => b.username));
  for (const k of [...out.keys()]) {
    const author = k.split('/')[0];
    if (no.has(author) || isHiddenSync(author)) out.delete(k);
  }
  return out;
}

async function activeVotes(list) {
  const out = new Map();
  for (let i = 0; i < list.length; i += VOTES_BATCH) {
    const chunk = list.slice(i, i + VOTES_BATCH);
    const res = await hiveRpcBatch(chunk.map((p, j) => ({
      jsonrpc: '2.0', method: 'condenser_api.get_active_votes', params: [p.author, p.permlink], id: i + j,
    })));
    for (const r of res) {
      const p = list[r && r.id];
      if (p && Array.isArray(r.result)) out.set(key(p.author, p.permlink), r.result);
    }
  }
  return out;
}

async function hivePerVests() {
  const [res] = await hiveRpcBatch([{ jsonrpc: '2.0', method: 'condenser_api.get_dynamic_global_properties', params: [], id: 1 }]);
  const fund = parseFloat(String(res?.result?.total_vesting_fund_hive || '').split(' ')[0]);
  const shares = parseFloat(String(res?.result?.total_vesting_shares || '').split(' ')[0]);
  return fund > 0 && shares > 0 ? fund / shares : 0;
}

const round3 = (n) => Math.round(n * 1000) / 1000;

async function build(user, now = Date.now()) {
  const sinceMs = now - CURATION_DAYS * DAY_MS;
  const [voteEntries, rewardEntries, rate] = await Promise.all([
    historySince(user, sinceMs, VOTE_FILTER, { maxPages: 6, pageSize: 1000 }),
    historySince(user, sinceMs, CURATION_FILTER, { maxPages: 4, pageSize: 1000 }),
    hivePerVests(),
  ]);
  const votes = votesFrom(voteEntries, user, sinceMs);
  const rewards = rewardsFrom(rewardEntries, user, sinceMs);
  // Only what was voted on 3Speak (see the top of this file).
  const site = await siteVoteKeys(getDb(), user);
  for (const k of [...votes.keys()]) if (!site.has(k)) votes.delete(k);
  for (const k of [...rewards.keys()]) if (!site.has(k)) rewards.delete(k);

  const all = new Map();
  for (const [k, v] of votes) all.set(k, { author: v.author, permlink: v.permlink });
  for (const k of rewards.keys()) {
    const [author, permlink] = [k.slice(0, k.indexOf('/')), k.slice(k.indexOf('/') + 1)];
    if (!all.has(k)) all.set(k, { author, permlink });
  }
  const ours = await threeSpeakPosts(getDb(), [...all.values()]);

  const rows = [];
  for (const [k, p] of all) {
    const info = ours.get(k);
    if (!info || p.author === user) continue;
    const v = votes.get(k);
    const r = rewards.get(k);
    rows.push({
      author: p.author,
      permlink: p.permlink,
      ...info,
      votedAt: v ? new Date(v.at) : null,
      percent: v ? v.percent : null,
      curationHp: r ? round3(r.vests * rate) : 0,
      paidAt: r ? new Date(r.at) : null,
    });
  }
  rows.sort((a, b) => ((b.votedAt || b.paidAt) - (a.votedAt || a.paidAt)));

  const earnedHp = round3(rows.reduce((n, r) => n + r.curationHp, 0));
  const picks = rows.slice(0, CURATION_MAX_PICKS);
  const voted = picks.filter((p) => p.votedAt);
  const standings = await activeVotes(voted);
  for (const p of picks) {
    const s = p.votedAt ? standing(standings.get(key(p.author, p.permlink)), user) : null;
    Object.assign(p, s ? { rank: s.rank, votes: s.votes, share: round3(s.share), early: s.early } : { rank: null, votes: null, share: null, early: false });
  }

  return {
    success: true,
    user,
    days: CURATION_DAYS,
    rules: { earlyShare: CURATION_EARLY_SHARE, earlyMinVotes: CURATION_EARLY_MIN_VOTES },
    totals: {
      picks: rows.filter((r) => r.votedAt).length,
      earnedHp,
      rewardedPosts: rows.filter((r) => r.curationHp > 0).length,
      early: picks.filter((p) => p.early).length,
    },
    picks,
    at: new Date(now),
  };
}

const cache = new Map(); // user → { at, data } | { promise }
function cached(user) {
  const hit = cache.get(user);
  if (hit && hit.data && Date.now() - hit.at < CURATION_CACHE_MIN * 60 * 1000) return hit.data;
  if (hit && hit.promise) return hit.promise;
  const promise = build(user).then((data) => {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(user, { at: Date.now(), data });
    return data;
  }, (err) => { cache.delete(user); throw err; });
  cache.set(user, { promise });
  return promise;
}

// GET /curation/:user → { totals, picks: [{ author, permlink, kind, title, thumbnail,
//   votedAt, percent, curationHp, paidAt, rank, votes, share, early }], rules, days }
router.get('/curation/:user', limiter, async (req, res) => {
  const user = String(req.params.user || '').trim().toLowerCase().replace(/^@/, '');
  if (!ACCOUNT_RE.test(user)) return res.status(400).json({ success: false, error: 'Invalid account' });
  if (isHiddenSync(user)) {
    return res.json({ success: true, user, days: CURATION_DAYS, totals: { picks: 0, earnedHp: 0, rewardedPosts: 0, early: 0 }, picks: [] });
  }
  try {
    const data = await cached(user);
    res.set('Cache-Control', 'public, max-age=60');
    res.json(data);
  } catch (err) {
    console.error('[curation] failed:', err && err.message);
    res.status(502).json({ success: false, error: 'Hive history unavailable' });
  }
});

// POST /curation/vote { user, signature, timestamp, author, permlink, weight }:
// the frontend reports a vote it just broadcast for `user` (the session vouch
// proves who is asking). An upvote is kept, an unvote or downvote (weight <= 0)
// removes the post. The page re-reads on its next visit.
router.post('/curation/vote', voteLimiter, async (req, res) => {
  const voter = await proveProgressUser(req.body || {});
  if (!voter) return res.status(401).json({ success: false, error: 'Not signed in' });
  const author = String(req.body.author || '').trim().toLowerCase();
  const permlink = String(req.body.permlink || '').trim().toLowerCase();
  const weight = Number(req.body.weight);
  if (!ACCOUNT_RE.test(author) || !PERMLINK_RE.test(permlink) || !Number.isInteger(weight) || Math.abs(weight) > 10000) {
    return res.status(400).json({ success: false, error: 'Invalid vote' });
  }
  try {
    const coll = siteVotes(getDb());
    const q = { voter, author, permlink };
    if (weight > 0) await coll.updateOne(q, { $set: { weight, at: new Date() } }, { upsert: true });
    else await coll.deleteOne(q);
    cache.delete(voter);
    res.json({ success: true });
  } catch (err) {
    console.error('[curation] vote record failed:', err && err.message);
    res.status(500).json({ success: false, error: 'Could not record the vote' });
  }
});

module.exports = router;
module.exports._test = { votesFrom, rewardsFrom, standing, threeSpeakPosts, build, cache, siteVoteKeys, CURATION_VOTES_COLLECTION };
