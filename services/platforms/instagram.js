// Instagram profile lookup for the bio-hash verification.
//
// Instagram refuses scripted requests to its API, even with a valid logged-in
// session: it checks the TLS / HTTP2 fingerprint against the claimed browser
// (tested 2026-10-04: 429 from Hetzner v4/v6 and from German residential IPs).
// So this asks the local instagram-browser service (127.0.0.1:4031, unit
// instagram-browser, services/instagram-browser/server.cjs), which opens the
// profile in a real headless Firefox with a dedicated throwaway account's
// session and reads what the page loads. Owner's call 2026-10-04, POC; the
// proper route is Meta's "Instagram API with Instagram Login".
//
// Canonical id = the lower-cased username: that is what profile URLs and the
// importer's owner check (the post's author) compare.

const BROWSER_URL = (process.env.INSTAGRAM_BROWSER_URL || 'http://127.0.0.1:4031').replace(/\/+$/, '');

// "@name", "name", "instagram.com/name", a profile URL.
function extractUsername(raw) {
    let s = String(raw || '').trim();
    if (!s) return '';
    const m = s.match(/instagram\.com\/([^/?#]+)/i);
    if (m) s = m[1];
    s = s.replace(/^@/, '').split(/[/?#\s]/)[0];
    if (['p', 'reel', 'reels', 'tv', 'stories', 'explore', 'share'].includes(s.toLowerCase())) return '';
    return /^[A-Za-z0-9_.]{1,30}$/.test(s) ? s.toLowerCase() : '';
}

async function fetchProfile(platformUsername) {
    const username = extractUsername(platformUsername);
    if (!username) {
        const err = new Error('Channel not found');
        err.code = 'CHANNEL_NOT_FOUND';
        throw err;
    }

    let res;
    let body = null;
    try {
        // The service queues and spaces out page loads, so allow for a wait.
        res = await fetch(`${BROWSER_URL}/profile/${encodeURIComponent(username)}`, { signal: AbortSignal.timeout(120000) });
        body = await res.json().catch(() => null);
    } catch (e) {
        console.error(`[instagram] browser service unreachable for @${username}: ${e.message}`);
        throw new Error('Platform lookup failed');
    }
    if (res.status === 404) {
        const err = new Error('Channel not found');
        err.code = 'CHANNEL_NOT_FOUND';
        throw err;
    }
    if (!res.ok || !body?.username) {
        console.error(`[instagram] browser service HTTP ${res.status} for @${username}: ${body?.code || ''} ${body?.error || ''}`);
        throw new Error('Platform lookup failed');
    }
    return {
        canonical_username: String(body.username).toLowerCase(),
        // headerText = the profile header as shown on the page (includes the bio),
        // in case the page's data did not carry the biography field.
        text: [body.username, body.fullName, body.biography, body.headerText].filter(Boolean).join('\n'),
    };
}

module.exports = { name: 'instagram', fetchProfile, extractUsername };
