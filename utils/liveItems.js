/**
 * A channel's streams for <podcast:liveItem> in its podcast feed (routes/rss.js),
 * read from the live server (hangouts, the first of LIVE_ROOM_API_URLS):
 *
 *   GET /streams                 rooms open now; a standalone one that is
 *                                broadcasting is "live"
 *   GET /events?host=<user>      the host's scheduled streams ("pending", or
 *                                "live" once started)
 *   GET /events?host=&status=ended  the last few that ended ("ended")
 *
 * Unlisted rooms are not in /streams, so they never reach a feed; Hive-only and
 * private events neither. Cached per channel (RSS_LIVE_CACHE_MS) because podcast
 * apps poll feeds; the room list is shared by all channels for the same time. A
 * live server that is down or slow just means no live items, never a broken feed.
 */
const { RSS_LIVE_CACHE_MS, RSS_LIVE_ITEMS_ENABLED } = require('./config');

// Read on use (not at load), like the other live-server callers' env.
const liveApi = () => String(process.env.LIVE_ROOM_API_URLS || 'https://live.3speak.tv')
    .split(',').map((u) => u.trim().replace(/\/+$/, '')).filter(Boolean)[0] || '';
const TIMEOUT_MS = 3000;
const MAX_CACHED = 2000;
const ENDED_KEEP_MS = 7 * 24 * 3600 * 1000;
const MAX_ITEMS = 5;

const byHost = new Map();          // host -> { exp, value }
let rooms = { exp: 0, value: null };

async function getJson(path) {
    const res = await fetch(`${liveApi()}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`live server ${path} answered ${res.status}`);
    return res.json();
}

async function openRooms() {
    if (rooms.value && rooms.exp > Date.now()) return rooms.value;
    let value = [];
    try {
        const list = await getJson('/streams');
        value = Array.isArray(list) ? list : [];
    } catch (err) {
        console.warn('[RSS] live rooms not read:', err.message);
    }
    rooms = { exp: Date.now() + RSS_LIVE_CACHE_MS, value };
    return value;
}

async function events(host, status) {
    try {
        const list = await getJson(`/events?host=${encodeURIComponent(host)}&limit=10${status ? `&status=${status}` : ''}`);
        return Array.isArray(list) ? list : [];
    } catch (err) {
        console.warn(`[RSS] live events of @${host} not read:`, err.message);
        return [];
    }
}

const iso = (v) => {
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const publicEvent = (e) => !e.visibility || e.visibility === 'public';

/**
 * Pure: the live items from what the server answered, newest-relevant first:
 * live ones, then upcoming (soonest first), then recently ended. At most five.
 * [{ id, status: 'live'|'pending'|'ended', start, end, title, description, room, thumb }]
 */
function liveItemsFrom(host, { openRooms: open = [], upcoming = [], ended = [] } = {}, now = Date.now()) {
    const h = String(host).toLowerCase();
    const out = [];
    const seenRooms = new Set();

    for (const r of open) {
        if (!r || r.mode !== 'standalone' || String(r.host || '').toLowerCase() !== h || r.live !== true) continue;
        if (r.visibility && r.visibility !== 'public') continue;
        const start = iso(r.createdAt);
        if (!start || !r.name) continue;
        seenRooms.add(r.name);
        out.push({
            id: `room:${r.name}`, status: 'live', start, end: null, room: r.name,
            title: String(r.title || r.name), description: String(r.description || ''), thumb: r.thumbnail || null,
        });
    }
    for (const e of upcoming) {
        if (!e || !e.id || !publicEvent(e) || String(e.hostUsername || '').toLowerCase() !== h) continue;
        if (e.roomName && seenRooms.has(e.roomName)) continue;   // already listed as live
        const start = iso(e.scheduledAt);
        if (!start) continue;
        const status = e.status === 'live' ? 'live' : e.status === 'scheduled' ? 'pending' : null;
        if (!status) continue;
        out.push({
            id: `event:${e.id}`, status, start, end: null, room: e.roomName || null,
            title: String(e.title || ''), description: String(e.description || ''), thumb: e.coverImage || null,
        });
    }
    for (const e of ended) {
        if (!e || !e.id || !publicEvent(e) || e.status !== 'ended' || String(e.hostUsername || '').toLowerCase() !== h) continue;
        const start = iso(e.scheduledAt);
        const end = iso(e.updatedAt);
        if (!start || !end || now - Date.parse(end) > ENDED_KEEP_MS) continue;
        out.push({
            id: `event:${e.id}`, status: 'ended', start, end, room: e.roomName || null,
            title: String(e.title || ''), description: String(e.description || ''), thumb: e.coverImage || null,
        });
    }
    const rank = { live: 0, pending: 1, ended: 2 };
    return out
        .sort((a, b) => (rank[a.status] - rank[b.status])
            || (a.status === 'ended' ? Date.parse(b.start) - Date.parse(a.start) : Date.parse(a.start) - Date.parse(b.start)))
        .slice(0, MAX_ITEMS);
}

/** The channel's live items (see liveItemsFrom), cached. [] when switched off or unreachable. */
async function liveItemsFor(host) {
    if (!RSS_LIVE_ITEMS_ENABLED || !liveApi() || !host) return [];
    const key = String(host).toLowerCase();
    const hit = byHost.get(key);
    if (hit && hit.exp > Date.now()) return hit.value;
    const [open, upcoming, ended] = await Promise.all([openRooms(), events(key), events(key, 'ended')]);
    const value = liveItemsFrom(key, { openRooms: open, upcoming, ended });
    byHost.set(key, { exp: Date.now() + RSS_LIVE_CACHE_MS, value });
    while (byHost.size > MAX_CACHED) byHost.delete(byHost.keys().next().value);
    return value;
}

/** Tests only. */
function clearLiveCache() {
    byHost.clear();
    rooms = { exp: 0, value: null };
}

module.exports = { liveItemsFor, liveItemsFrom, clearLiveCache };
