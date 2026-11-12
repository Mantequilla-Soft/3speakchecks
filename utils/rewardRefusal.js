/**
 * Content that must carry NO ads because nobody may earn from it.
 *
 * Two independent reasons, both read by utils/adEligibility.js for every surface
 * (watch, live, shorts, audio):
 *
 *   • The CREATOR is reward-blocked: `contentcreators.adRewardDisabled: true`, set
 *     by an admin. The payout has always withheld their share (services/adPayouts.js
 *     rewardBlockedSet); since 2026-11-12 their content does not carry ads at all
 *     (owner: "if a creator is set to ad-rewards blocked ... we should not show any
 *     ads for that content"). The payout still withholds, as a second line for
 *     impressions recorded before the flag was set.
 *     ⚠️ AD_EXCLUDED_ACCOUNTS (the platform's own accounts, badadib) is NOT this
 *     flag: those are never paid but are exactly where ads are tested.
 *
 *   • The POST declines rewards: its Hive `max_accepted_payout` is zero. The creator
 *     said they do not want to earn from it, so we do not sell ads on it either.
 *     The record is the chain, not our database (embed uploads store the choice
 *     nowhere else), so the post is read with get_content, behind a cache:
 *       - declined: kept for good. Hive only lets max_accepted_payout go DOWN, and
 *         only before the first vote, so a declined post can never accept again;
 *       - accepting: re-read after ACCEPT_TTL_MS (it can still be lowered early on);
 *       - chain unreachable: answers "not declined" for UNKNOWN_TTL_MS. Failing open
 *         on purpose: a Hive outage must not switch ads off platform-wide, and a
 *         declined post that gets an ad in that window earns its creator nothing
 *         extra they did not already refuse on chain.
 *     Concurrent misses for one video share a single read.
 *
 * Which post: the ad session knows the ASSET (`owner/permlink` as the player asks).
 *   - video: the embed-video row's hive_author/hive_permlink. A row without them has
 *     no post yet, so nothing was declined. No row at all = a legacy video or a live
 *     room, whose owner/permlink ARE the Hive post (a room is announced under its
 *     own name), so the chain is asked directly and answers "no such post" if none.
 *   - audio: the embed-audio row's post_permlink (some rows store "author/permlink").
 */
const { getDb } = require('./db');
const { hiveRpcBatch } = require('./hive');
const { AD_REWARD_FLAG_COLLECTION } = require('./config');

const ACCEPT_TTL_MS = parseInt(process.env.AD_DECLINE_ACCEPT_TTL_MS, 10) || 10 * 60 * 1000;
const UNKNOWN_TTL_MS = parseInt(process.env.AD_DECLINE_UNKNOWN_TTL_MS, 10) || 60 * 1000;
const MAX_ENTRIES = 50000;

const norm = (u) => String(u || '').trim().toLowerCase().replace(/^@/, '');

/** Is this creator's ad reward blocked by an admin? Only a literal true counts. */
async function creatorRewardBlocked(owner) {
  const o = norm(owner);
  if (!o) return false;
  const row = await getDb().collection(AD_REWARD_FLAG_COLLECTION)
    .findOne({ username: o, adRewardDisabled: true }, { projection: { _id: 1 } });
  return !!row;
}

/** "0.000 HBD" -> true. Anything unreadable is NOT a decline. */
function declinedPayout(maxAccepted) {
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s/.exec(String(maxAccepted || '') + ' ');
  return !!m && Number(m[1]) === 0;
}

/** The Hive post behind an asset: `{ author, permlink }`, or null when there is none. */
async function postOf(kind, owner, permlink) {
  const db = getDb();
  if (kind === 'audio') {
    const row = await db.collection('embed-audio').findOne(
      { owner, permlink }, { projection: { post_permlink: 1 } },
    );
    const pp = row && typeof row.post_permlink === 'string' ? row.post_permlink.trim() : '';
    if (!pp) return null;
    const slash = pp.indexOf('/');
    return { author: owner, permlink: slash >= 0 ? pp.slice(slash + 1) : pp };
  }
  const row = await db.collection('embed-video').findOne(
    { owner, permlink }, { projection: { hive_author: 1, hive_permlink: 1 } },
  );
  if (row) {
    return row.hive_author && row.hive_permlink
      ? { author: norm(row.hive_author), permlink: String(row.hive_permlink) }
      : null;
  }
  return { author: owner, permlink };
}

const cache = new Map();     // key -> { declined, until }
const inflight = new Map();  // key -> Promise<boolean>

function remember(key, declined, ttl) {
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { declined, until: ttl === Infinity ? Infinity : Date.now() + ttl });
  return declined;
}

async function readDecline(key, kind, owner, permlink) {
  const post = await postOf(kind, owner, permlink);
  if (!post) return remember(key, false, ACCEPT_TTL_MS);
  const [res] = await hiveRpcBatch([{
    jsonrpc: '2.0', id: 1, method: 'condenser_api.get_content', params: [post.author, post.permlink],
  }]);
  // No answer at all = the chain could not be read (see the header: fail open, briefly).
  if (!res || res.error) return remember(key, false, UNKNOWN_TTL_MS);
  const p = res.result;
  if (!p || !p.author) return remember(key, false, ACCEPT_TTL_MS);
  return declinedPayout(p.max_accepted_payout)
    ? remember(key, true, Infinity)
    : remember(key, false, ACCEPT_TTL_MS);
}

/** Does the Hive post behind this video ('video') or track ('audio') decline rewards? */
async function contentDeclinesRewards({ kind = 'video', owner, permlink }) {
  const o = norm(owner);
  const p = String(permlink || '').trim();
  if (!o || !p) return false;
  const key = `${kind === 'audio' ? 'audio' : 'video'}:${o}/${p}`;
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.declined;
  if (inflight.has(key)) return inflight.get(key);
  const pending = readDecline(key, kind, o, p).finally(() => inflight.delete(key));
  inflight.set(key, pending);
  return pending;
}

module.exports = { creatorRewardBlocked, contentDeclinesRewards, declinedPayout };
