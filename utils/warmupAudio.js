/**
 * Warm-up audio on the Audio page (owner, 2026-11-03).
 *
 * Musicians and podcasters warming up publish audio under their handle (an
 * embed-audio row whose owner is the handle, not a Hive account). Those tracks
 * show in the audio lists, but only a taste of them: at most ONE per warm-up
 * account and THREE in all, the newest. Everything else they upload stays
 * reachable by its own link (a lookup by permlink is never capped).
 *
 * Who is warming up is the hosted incubation service's answer: a handle with a
 * profile there and no Hive account yet. Audio owners are few (under a hundred),
 * so each one is asked once and remembered (ten at a time); the set and the
 * allowed tracks are rebuilt every few minutes, single-flight, in the background:
 * a list never waits on it for more than FIRST_WAIT_MS. When the service cannot
 * be reached, the last answer stands (and before there is one, nothing is capped).
 */
const { getDb } = require('./db');
const { call } = require('./incubationHosted');

const MAX_PER_ACCOUNT = 1;
const MAX_TOTAL = Math.max(0, parseInt(process.env.WARMUP_AUDIO_MAX_TOTAL, 10) || 3);
const REFRESH_MS = 5 * 60 * 1000;
// A Hive account never turns into a warm-up handle, so a "no" is kept longer.
const OWNER_NO_TTL_MS = 6 * 60 * 60 * 1000;
const OWNER_YES_TTL_MS = 5 * 60 * 1000;
const HANDLE_RE = /^[a-z0-9.-]{3,16}$/;
const LOOKUP_CONCURRENCY = 10;
const FIRST_WAIT_MS = 1500;

const ownerCache = new Map(); // owner → { warmup, at }
let state = { owners: [], allowed: [], at: 0 };
let refreshing = null;

async function isWarmupHandle(owner) {
  const hit = ownerCache.get(owner);
  if (hit && Date.now() - hit.at < (hit.warmup ? OWNER_YES_TTL_MS : OWNER_NO_TTL_MS)) return hit.warmup;
  if (!HANDLE_RE.test(owner)) {
    ownerCache.set(owner, { warmup: false, at: Date.now() });
    return false;
  }
  const { status, body } = await call('GET', `/public/profile/${encodeURIComponent(owner)}`);
  // Graduated handles keep a profile but have their Hive account now.
  const warmup = status === 200 && !!body && !body.hiveUsername;
  ownerCache.set(owner, { warmup, at: Date.now() });
  return warmup;
}

async function rebuild() {
  const audio = getDb().collection('embed-audio');
  const candidates = (await audio.distinct('owner', { status: 'published' })).map(String);
  const owners = [];
  const check = async (owner) => {
    try {
      if (await isWarmupHandle(owner)) owners.push(owner);
    } catch {
      // Unreachable for this one: keep what we knew about it.
      if (ownerCache.get(owner)?.warmup) owners.push(owner);
    }
  };
  for (let i = 0; i < candidates.length; i += LOOKUP_CONCURRENCY) {
    await Promise.all(candidates.slice(i, i + LOOKUP_CONCURRENCY).map(check));
  }
  let allowed = [];
  if (owners.length && MAX_TOTAL > 0) {
    const newest = await audio.aggregate([
      { $match: { owner: { $in: owners }, status: 'published' } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$owner', permlinks: { $push: '$permlink' }, at: { $first: '$createdAt' } } },
      { $sort: { at: -1 } },
      { $limit: MAX_TOTAL },
    ]).toArray();
    allowed = newest.flatMap((g) => g.permlinks.slice(0, MAX_PER_ACCOUNT)).map(String);
  }
  state = { owners, allowed, at: Date.now() };
  return state;
}

/** { owners, allowed }: the warm-up audio owners and the permlinks the lists may show. */
async function warmupAudio() {
  if (Date.now() - state.at < REFRESH_MS) return state;
  if (!refreshing) {
    refreshing = rebuild()
      .catch((err) => {
        console.warn('[warmupAudio] refresh failed, keeping the last answer:', err.message);
        state = { ...state, at: Date.now() - REFRESH_MS + 30 * 1000 }; // retry in 30 s
        return state;
      })
      .finally(() => { refreshing = null; });
  }
  // Later calls are served the last answer meanwhile; the very first one waits a
  // moment for the first answer and otherwise goes on uncapped.
  if (state.at) return state;
  const current = refreshing;
  return Promise.race([current, new Promise((r) => setTimeout(() => r(state), FIRST_WAIT_MS).unref?.())]);
}

/**
 * Narrows an embed-audio query (or $match) to the capped warm-up tracks plus all
 * other audio. Returns the same object for chaining. No warm-up owners = unchanged.
 */
function capWarmup(query, { owners, allowed }) {
  if (!owners.length) return query;
  const clause = { $or: [{ owner: { $nin: owners } }, { permlink: { $in: allowed } }] };
  query.$and = [...(query.$and || []), clause];
  return query;
}

module.exports = { warmupAudio, capWarmup, MAX_PER_ACCOUNT, MAX_TOTAL, _test: { rebuild, isWarmupHandle, ownerCache } };
