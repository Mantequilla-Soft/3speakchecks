const { YOUTUBE_API_KEY } = require('../../utils/config');

const API = 'https://www.googleapis.com/youtube/v3';
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YT_URL_RE = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:youtube\.com|youtube-nocookie\.com|youtu\.be)(?:[/?#]|$)/i;

const notFound = () => {
    const err = new Error('Channel not found');
    err.code = 'CHANNEL_NOT_FOUND';
    return err;
};

const segment = (s) => {
    try { return decodeURIComponent(s); } catch { return s; }
};

// What the user typed, as one of:
//   { kind: 'id', value }        UC... channel id
//   { kind: 'handle', value }    @handle (without the @)
//   { kind: 'username', value }  legacy /user/<name>
//   { kind: 'custom', value }    legacy /c/<name> or youtube.com/<name>
//   { kind: 'video', value }     a video id, its channel is the one meant
// People paste whatever is in the address bar, so full channel, handle, legacy
// and video links are all accepted (with or without https://, www., m.,
// trailing tabs like /videos, or ?si= tracking). null = nothing usable.
function parseInput(raw) {
    const s = String(raw || '').trim().replace(/^[<"']+|[>"']+$/g, '');
    if (!s) return null;

    if (YT_URL_RE.test(s)) {
        let url;
        try { url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
        const parts = url.pathname.split('/').filter(Boolean).map(segment);
        if (/(^|\.)youtu\.be$/i.test(url.hostname)) {
            return parts[0] && VIDEO_ID_RE.test(parts[0]) ? { kind: 'video', value: parts[0] } : null;
        }
        const [first, second] = parts;
        if (!first) return null;
        if (first.startsWith('@') && first.length > 1) return { kind: 'handle', value: first.slice(1) };
        if (first === 'channel') return second && CHANNEL_ID_RE.test(second) ? { kind: 'id', value: second } : null;
        if (first === 'user') return second ? { kind: 'username', value: second } : null;
        if (first === 'c') return second ? { kind: 'custom', value: second } : null;
        if (first === 'watch') {
            const v = url.searchParams.get('v');
            return v && VIDEO_ID_RE.test(v) ? { kind: 'video', value: v } : null;
        }
        if (['shorts', 'live', 'embed', 'v'].includes(first)) {
            return second && VIDEO_ID_RE.test(second) ? { kind: 'video', value: second } : null;
        }
        // youtube.com/<name> (old vanity URLs). Site pages like /feed or
        // /results are not channels.
        if (parts.length === 1 && !['feed', 'results', 'playlist', 'account', 'premium', 'about'].includes(first)) {
            return { kind: 'custom', value: first };
        }
        return null;
    }

    if (CHANNEL_ID_RE.test(s)) return { kind: 'id', value: s };
    // "@name", "name", or "@name/videos" copied from the end of a link.
    const handle = s.replace(/^@/, '').split(/[/?#\s]/)[0];
    return handle ? { kind: 'handle', value: handle } : null;
}

async function apiGet(path, params) {
    const url = new URL(`${API}/${path}`);
    url.searchParams.set('part', 'snippet');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('key', YOUTUBE_API_KEY);
    const res = await fetch(url);
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        // Log details server-side; surface only a generic message to callers
        // so quota/auth issues aren't leaked.
        console.error(`[youtube] API error ${res.status}: ${body.slice(0, 500)}`);
        throw new Error('Platform lookup failed');
    }
    const data = await res.json();
    return (data.items && data.items[0]) || null;
}

// The channels.list lookups to try, in order, for a parsed input.
async function lookupsFor(input) {
    switch (input.kind) {
        case 'id': return [{ id: input.value }];
        case 'handle': return [{ forHandle: input.value }];
        // Most legacy names became the handle when handles were introduced.
        case 'username': return [{ forUsername: input.value }, { forHandle: input.value }];
        case 'custom': return [{ forHandle: input.value }, { forUsername: input.value }];
        case 'video': {
            const video = await apiGet('videos', { id: input.value });
            const channelId = video && video.snippet && video.snippet.channelId;
            return channelId ? [{ id: channelId }] : [];
        }
        default: return [];
    }
}

// Resolve a YouTube identifier (handle, channel ID, or any channel/video link)
// to:
//   - canonical_username: the immutable UC... channel ID (used as DB storage key)
//   - text: title + description joined with a newline (the searchable surface)
//
// Throws:
//   - err.code === 'CHANNEL_NOT_FOUND' if nothing usable was given or the API
//     returned no items
//   - generic Error on quota/network/auth issues (includes the API status)
async function fetchProfile(platformUsername) {
    if (!YOUTUBE_API_KEY) {
        throw new Error('YOUTUBE_API_KEY is not configured');
    }
    if (!String(platformUsername || '').trim()) throw new Error('platform_username is required');

    const input = parseInput(platformUsername);
    if (!input) throw notFound();

    let item = null;
    for (const params of await lookupsFor(input)) {
        item = await apiGet('channels', params);
        if (item) break;
    }
    if (!item) throw notFound();
    const snippet = item.snippet || {};
    return {
        canonical_username: item.id,
        text: [snippet.title, snippet.description].filter(Boolean).join('\n'),
    };
}

module.exports = { name: 'youtube', fetchProfile, parseInput };
