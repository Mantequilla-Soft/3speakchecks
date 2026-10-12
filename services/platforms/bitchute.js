// BitChute channel lookup for the bio-hash verification.
//
// BitChute's own web app reads channels from a public JSON API
// (POST https://api.bitchute.com/api/beta/channel {channel_id}), which accepts
// either the channel's id or its URL slug and answers with the channel's
// description. That is where the user pastes the verification hash. Works from
// this server directly, no proxy.
//
// Canonical id = the channel_id (e.g. "1VBwRfyNcKdX", case-sensitive): a slug can
// be renamed, the id cannot, and every video's API record names its channel by id,
// which is what the importer's owner check compares.

const API = 'https://api.bitchute.com/api/beta';

// "slug", "1VBwRfyNcKdX", "bitchute.com/channel/slug/", a full channel URL.
function extractChannel(raw) {
    let s = String(raw || '').trim();
    if (!s) return '';
    const m = s.match(/bitchute\.com\/channel\/([^/?#]+)/i);
    if (m) s = m[1];
    s = s.replace(/^@/, '').split(/[/?#\s]/)[0];
    return /^[A-Za-z0-9_-]{2,64}$/.test(s) ? s : '';
}

async function fetchProfile(platformUsername) {
    const id = extractChannel(platformUsername);
    if (!id) {
        const err = new Error('Channel not found');
        err.code = 'CHANNEL_NOT_FOUND';
        throw err;
    }
    let res;
    let body = null;
    try {
        res = await fetch(`${API}/channel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ channel_id: id }),
            signal: AbortSignal.timeout(15000),
        });
        body = await res.json().catch(() => null);
    } catch (e) {
        console.error(`[bitchute] channel fetch failed for ${id}: ${e.message}`);
        throw new Error('Platform lookup failed');
    }
    if (res.status === 404 || (res.ok && !body?.channel_id)) {
        const err = new Error('Channel not found');
        err.code = 'CHANNEL_NOT_FOUND';
        throw err;
    }
    if (!res.ok) {
        console.error(`[bitchute] channel HTTP ${res.status} for ${id}`);
        throw new Error('Platform lookup failed');
    }
    return {
        canonical_username: String(body.channel_id),
        text: [body.channel_name, body.url_slug, body.profile_name, body.description].filter(Boolean).join('\n'),
    };
}

module.exports = { name: 'bitchute', fetchProfile, extractChannel };
