/**
 * The hosted incubation service (incubation.butrauth.com), from the checker.
 *
 * Warm-up content used to live in this database, written by 3Speak's own copy
 * of the incubation service, and routes/incubation.js read it straight out of
 * Mongo. It now lives in Butter Auth's hosted service, one space per app, and
 * the checker reads it through that service's public API instead. The routes
 * keep their shapes, so the frontend does not change.
 *
 * Called over loopback, not through Cloudflare: the service runs on this box,
 * and a loopback caller is exempt from its per-app rate limit, which every
 * visitor's feed would otherwise share.
 *
 * Only public reads go through here. They name the app with X-Client-Id and
 * carry no secret.
 */
const BASE = (process.env.INCUBATION_HOSTED_URL || 'http://127.0.0.1:3042').replace(/\/+$/, '');
// 3Speak's space. preview.3speak.tv's app is aliased into it on the service
// (HOSTED_SPACE_ALIASES), so both sites read and write the same content, as
// they did when it was one database.
const CLIENT_ID = process.env.INCUBATION_CLIENT_ID || '3speak-tv-41b6ae';
const TIMEOUT_MS = 8000;

/**
 * One request. Resolves to { status, body } for anything the service answered,
 * including refusals, so a route can pass them through unchanged. Throws only
 * when there was no answer at all.
 */
async function call(method, path, body) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
            'X-Client-Id': CLIENT_ID,
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    return { status: res.status, body: data };
}

/** Build a query string from the defined values only. */
function qs(params) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
    }
    const s = p.toString();
    return s ? `?${s}` : '';
}

/**
 * Who a handle follows, off chain. Empty for anyone the service does not know,
 * and on any failure: a follow feed falls back rather than erroring.
 */
async function followingOf(handle) {
    if (typeof handle !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(handle)) return [];
    try {
        const r = await call('GET', `/public/user/${encodeURIComponent(handle)}/following?limit=1000`);
        if (r.status !== 200 || !Array.isArray(r.body?.items)) return [];
        return r.body.items.map(i => i.name).filter(Boolean);
    } catch {
        return [];
    }
}

module.exports = { call, qs, followingOf, CLIENT_ID, BASE };
