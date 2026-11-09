/**
 * Is this room a live stream by this host, right now? Asked of the streaming server
 * (hangouts `GET /rooms/:name`), never taken from the page.
 *
 * Why it exists: an ad on a live stream pays its HOST as a streamer, and the host
 * and room come from the request. Without this check anybody could ask for ads on
 * a room that does not exist, naming themselves as host, from another network (the
 * own_video rule only catches the host's own addresses), and collect the streamer
 * share of real advertisers' money. The player service makes the same check before
 * it counts stream-viewer rewards (snapievideoplayer watchTracking.js liveRoom); the
 * two must agree on what "live" means:
 *
 *   mode 'standalone'   a stream, not a conference room
 *   host                the account the request names, case-insensitively
 *   broadcasting true   the host hit Start (studio) or the ingress is up (OBS)
 *   liveAt              set on the first go-live, kept across a pause
 *
 * FAILS CLOSED: a server that errors, times out or answers anything else means no
 * ad. The stream itself runs on that server, so if it cannot answer there is
 * nothing to show an ad over anyway.
 *
 * Several servers (LIVE_ROOM_API_URLS, comma separated) are asked in order; a 404
 * means "not on this one". Answers are cached for a minute per host/room, because
 * every viewer of a stream asks for ads; errors only for ten seconds.
 */
const LIVE_ROOM_APIS = String(process.env.LIVE_ROOM_API_URLS || 'https://live.3speak.tv')
  .split(',').map((u) => u.trim().replace(/\/+$/, '')).filter(Boolean);
const TTL_MS = 60 * 1000;
const ERROR_TTL_MS = 10 * 1000;
const TIMEOUT_MS = 3000;
const MAX_CACHED = 5000;
const cache = new Map();

/** `{ liveAt }` when `room` is a stream hosted by `host` that is live now, else null. */
async function liveRoom(host, room) {
  const h = String(host || '').trim().toLowerCase();
  const r = String(room || '').trim();
  if (!h || !r) return null;
  const key = `${h}/${r}`;
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;

  let value = null;
  let failed = false;
  for (const base of LIVE_ROOM_APIS) {
    try {
      const res = await fetch(`${base}/rooms/${encodeURIComponent(r)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.status === 404) continue;
      if (!res.ok) { failed = true; continue; }
      const m = await res.json();
      if (m && m.mode === 'standalone' && String(m.host || '').toLowerCase() === h
        && m.broadcasting === true && typeof m.liveAt === 'string' && m.liveAt) {
        value = { liveAt: m.liveAt };
      }
      failed = false;
      break;
    } catch {
      failed = true;
    }
  }

  if (cache.size >= MAX_CACHED) {
    const now = Date.now();
    for (const [k, v] of cache) if (v.exp <= now) cache.delete(k);
    if (cache.size >= MAX_CACHED) cache.clear();
  }
  cache.set(key, { value, exp: Date.now() + (failed ? ERROR_TTL_MS : TTL_MS) });
  return value;
}

module.exports = { liveRoom, _cache: cache, LIVE_ROOM_APIS };
