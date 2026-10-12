// TikTok has no free profile API. The public profile page (what any logged-out
// browser gets) embeds the user in a JSON blob,
// <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">, under
// __DEFAULT_SCOPE__["webapp.user-detail"].userInfo.user, which carries
// uniqueId (the @handle), nickname and signature (the bio). That is where the
// user pastes the verification hash.
//
// Canonical id = the lower-cased @handle. TikTok's numeric id would survive a
// handle rename, but every profile URL and every video's yt-dlp `uploader`
// field speaks in handles, so the import owner check compares handles.

const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

// "@handle", "handle", "tiktok.com/@handle", a full profile or video URL.
function extractHandle(raw) {
    let s = String(raw || '').trim();
    if (!s) return '';
    const m = s.match(/tiktok\.com\/@([^/?#]+)/i);
    if (m) s = m[1];
    s = s.replace(/^@/, '').split(/[/?#\s]/)[0];
    return /^[A-Za-z0-9_.]{2,24}$/.test(s) ? s.toLowerCase() : '';
}

async function fetchProfile(platformUsername) {
    const handle = extractHandle(platformUsername);
    if (!handle) {
        const err = new Error('Channel not found');
        err.code = 'CHANNEL_NOT_FOUND';
        throw err;
    }

    let html;
    try {
        const res = await fetch(`https://www.tiktok.com/@${encodeURIComponent(handle)}`, {
            headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
            console.error(`[tiktok] profile HTTP ${res.status} for @${handle}`);
            throw new Error('Platform lookup failed');
        }
        html = await res.text();
    } catch (e) {
        if (e.message === 'Platform lookup failed') throw e;
        console.error(`[tiktok] profile fetch failed for @${handle}: ${e.message}`);
        throw new Error('Platform lookup failed');
    }

    const m = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) {
        // A captcha/interstitial page instead of the profile.
        console.error(`[tiktok] no rehydration blob for @${handle} (len ${html.length})`);
        throw new Error('Platform lookup failed');
    }
    let user;
    try {
        const data = JSON.parse(m[1]);
        user = data?.__DEFAULT_SCOPE__?.['webapp.user-detail']?.userInfo?.user;
    } catch {
        throw new Error('Platform lookup failed');
    }
    if (!user || !user.uniqueId) {
        const err = new Error('Channel not found');
        err.code = 'CHANNEL_NOT_FOUND';
        throw err;
    }

    return {
        canonical_username: String(user.uniqueId).toLowerCase(),
        text: [user.uniqueId, user.nickname, user.signature].filter(Boolean).join('\n'),
    };
}

module.exports = { name: 'tiktok', fetchProfile, extractHandle };
