// Follow graph for the Hive galaxy page (3speak.tv /galaxy/:user), read from
// HafSQL (utils/hafsql.js) instead of one Hive RPC read per scanned account:
// a scan is a few queries however many accounts it reads, and every scanned
// account's whole follow list counts, not just its first 1000 names.
//
// GET /galaxy/lists?account=X  → { following, followers } (A→Z, capped)
// GET /galaxy/scan?center=X&mode=following|followers|mutuals&depth=orbit|starsystem|nebula|deepspace
//   → { center, mode, following, followers, sampled, mapRing,
//       candidates: [{ name, count, via, rep, active, followers, displayName }],
//       ringLinks: { scannedMember: [ring members it follows] } }
// `via` and `ringLinks` only name accounts in `mapRing` (the ring members the
// map draws); `count` is the full number of scanned accounts that follow.
// The frontend (src/lib/hiveGalaxy.js) adds 3Speak counts, and falls back to
// Hive RPC when this route fails.

const express = require('express');
const hafsql = require('../utils/hafsql');

const router = express.Router();

const HIVE_RE = /^[a-z][a-z0-9.-]{2,15}$/;
const MODES = ['following', 'followers', 'mutuals'];
// Kept in step with SCAN_DEPTHS in the frontend's hiveGalaxy.js.
const SCAN_DEPTHS = { orbit: 120, starsystem: 250, nebula: 1000, deepspace: 5000 };
const DEFAULT_DEPTH = 'orbit';
const MAX_LIST = 5000;
const MAX_CANDIDATES = 200;
// Ring members the map draws (MAX_RING_STARS in the frontend).
const MAP_RING = 700;
// Accounts following more than this many are mass-followers (bots, follow
// trains): their follows say nothing about taste and, at 100k+ each, would
// swamp every count. They stay on the map but are never scanned.
const MAX_FOLLOWING = 2000;
const HEAVY_MS = 60000; // read timeout for the big scan queries
// Accounts that are not people: badge accounts follow their holders, and
// dtube, kgakakillerg and bpcvoter1 are left out of every scan on purpose
// (product call).
const EXCLUDED = ['dtube', 'kgakakillerg', 'bpcvoter1'];
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 60; // a deep-space scan holds a few MB

const cache = new Map(); // key -> { at, promise }
function cached(key, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
  const promise = load().catch((err) => { cache.delete(key); throw err; });
  cache.set(key, { at: Date.now(), promise });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return promise;
}

// SQL condition: `col` is a person (see EXCLUDED); `ex` is the parameter
// holding EXCLUDED.
const people = (col, ex) => `${col} not like 'badge-%' and ${col} <> all(${ex})`;

function lists(account) {
  return cached(`lists:${account}`, async () => {
    const [following, followers] = await Promise.all([
      hafsql.query(`select following_name as n from hafsql.follows where follower_name = $1 and ${people('following_name', '$3')} order by following_name limit $2`, [account, MAX_LIST, EXCLUDED]),
      hafsql.query(`select follower_name as n from hafsql.follows where following_name = $1 and ${people('follower_name', '$3')} order by follower_name limit $2`, [account, MAX_LIST, EXCLUDED]),
    ]);
    return { following: following.map((r) => r.n), followers: followers.map((r) => r.n) };
  });
}

// Seeded shuffle, the same one the frontend used for its RPC scan, so a
// galaxy keeps its sample (and so its shape) whichever path built it.
function shuffled(list, seedText) {
  let s = 0;
  for (const ch of seedText) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function scan(center, mode, depth) {
  return cached(`scan:${center}:${mode}:${depth}`, async () => {
    const { following, followers } = await lists(center);
    const followerSet = new Set(followers);
    const ring = mode === 'followers' ? followers
      : mode === 'mutuals' ? following.filter((n) => followerSet.has(n))
        : following;
    const empty = { center, mode, following, followers, sampled: [], mapRing: ring.slice(0, MAP_RING), candidates: [], ringLinks: {} };
    if (!ring.length) return empty;

    // Only people who follow a sane number of accounts are scanned.
    const counts = await hafsql.query('select name, followings::int as f from hafsql.accounts where name = any($1)', [ring]);
    const tooMany = new Set(counts.filter((r) => r.f > MAX_FOLLOWING).map((r) => r.name));
    const sampled = shuffled(ring.filter((n) => !tooMany.has(n)), `${center}:${mode}`).slice(0, SCAN_DEPTHS[depth]);
    if (!sampled.length) return empty;

    // The map's ring: the members the scan's accounts follow most (they carry
    // the circles), scanned ones first on a tie, then ring order.
    const inDeg = new Map((await hafsql.query(
      `select following_name as n, count(*)::int as c from hafsql.follows
        where follower_name = any($1) and following_name = any($2) group by following_name`,
      [sampled, ring], { timeoutMs: HEAVY_MS },
    )).map((r) => [r.n, r.c]));
    const scannedSet = new Set(sampled);
    const order = new Map(ring.map((n, i) => [n, i]));
    const mapRing = [...ring]
      .sort((a, b) => (inDeg.get(b) || 0) - (inDeg.get(a) || 0)
        || scannedSet.has(b) - scannedSet.has(a)
        || order.get(a) - order.get(b))
      .slice(0, MAP_RING);
    const mapScanned = mapRing.filter((n) => scannedSet.has(n));

    // Candidates: what the sample follows that the centre doesn't, strongest
    // first, with who on the map leads there. Ring links: which ring members
    // on the map each scanned one on the map follows.
    const [candidates, links] = await Promise.all([
      hafsql.query(
        `select following_name as name, count(*)::int as count,
                coalesce(array_agg(follower_name order by follower_name) filter (where follower_name = any($6)), '{}') as via
           from hafsql.follows
          where follower_name = any($1) and following_name <> $2 and not (following_name = any($3))
            and ${people('following_name', '$5')}
          group by following_name
          order by count(*) desc, following_name
          limit $4`,
        [sampled, center, following, MAX_CANDIDATES, EXCLUDED, mapScanned],
        { timeoutMs: HEAVY_MS },
      ),
      hafsql.query(
        `select follower_name as a, following_name as b from hafsql.follows
          where follower_name = any($1) and following_name = any($2) and follower_name <> following_name`,
        [mapScanned, mapRing],
      ),
    ]);
    const ringLinks = {};
    links.forEach(({ a, b }) => { (ringLinks[a] ||= []).push(b); });

    // Profiles for the filters, from HafSQL too: no Hive node rate limits.
    const prof = new Map((await hafsql.query(
      `select name, reputation::float as rep, followers::int as followers,
              greatest(last_post, last_vote_time) as active,
              coalesce(posting_metadata->'profile'->>'name', json_metadata->'profile'->>'name', '') as display_name
         from hafsql.accounts where name = any($1)`,
      [candidates.map((c) => c.name)],
    )).map((r) => [r.name, r]));
    const out = candidates.filter((c) => prof.has(c.name)).map((c) => {
      const p = prof.get(c.name);
      return {
        ...c,
        rep: p.rep,
        followers: p.followers,
        active: p.active ? new Date(p.active).getTime() : null,
        displayName: String(p.display_name || '').slice(0, 80),
      };
    });
    return { center, mode, following, followers, sampled, mapRing, candidates: out, ringLinks };
  });
}

router.get('/galaxy/lists', async (req, res) => {
  const account = String(req.query.account || '').toLowerCase();
  if (!HIVE_RE.test(account)) return res.status(400).json({ success: false, error: 'invalid account' });
  try {
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ success: true, account, ...(await lists(account)) });
  } catch (err) {
    console.error('galaxy/lists error:', err.message);
    res.status(502).json({ success: false, error: 'follow data unavailable' });
  }
});

router.get('/galaxy/scan', async (req, res) => {
  const center = String(req.query.center || '').toLowerCase();
  const mode = MODES.includes(req.query.mode) ? req.query.mode : 'following';
  const depth = Object.hasOwn(SCAN_DEPTHS, req.query.depth) ? req.query.depth : DEFAULT_DEPTH;
  if (!HIVE_RE.test(center)) return res.status(400).json({ success: false, error: 'invalid account' });
  try {
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ success: true, ...(await scan(center, mode, depth)) });
  } catch (err) {
    console.error('galaxy/scan error:', err.message);
    res.status(502).json({ success: false, error: 'follow data unavailable' });
  }
});

module.exports = router;
