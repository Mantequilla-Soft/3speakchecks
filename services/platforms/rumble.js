// Rumble channel lookup for the bio-hash verification.
//
// The channel's About page (rumble.com/c/<name>/about, or /user/<name>/about)
// shows its description in <div class="channel-about--description">; that is
// where the user pastes the verification hash. Rumble sits behind Cloudflare,
// which refuses datacenter IPs and challenges some home IPs ("Just a moment..."),
// so the page is read through a residential proxy, moving to another exit IP
// when one is challenged. RUMBLE_FETCH_PROXY (checker .env) is a proxy URL that
// may carry {port:A-B} (a random port = another sticky exit IP, DataImpulse) or
// {session} placeholders, like the importer's YTDLP_PROXY.
//
// Canonical id = "c/<name>" or "user/<name>", lower-cased: that is how Rumble
// names a channel in every video's "by" link, which is what the importer's owner
// check compares.

const https = require('https');
const crypto = require('crypto');
const { HttpsProxyAgent } = require('https-proxy-agent');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const MAX_ATTEMPTS = 6;

function proxyUrl() {
    const tpl = process.env.RUMBLE_FETCH_PROXY || '';
    if (!tpl) return '';
    return tpl
        .replace(/\{session\}/g, crypto.randomBytes(6).toString('hex'))
        .replace(/\{port:(\d+)-(\d+)\}/g, (_, a, b) => String(Number(a) + crypto.randomInt(Number(b) - Number(a) + 1)));
}
const scrub = (m) => String(m).replace(/\/\/[^\s/@]+@/g, '//***@');

// "c/Name", "user/Name", "Name" (= c/Name), "@Name", a channel or about URL.
function extractChannel(raw) {
    let s = String(raw || '').trim();
    if (!s) return '';
    const m = s.match(/rumble\.com\/(c|user)\/([^/?#]+)/i);
    if (m) return `${m[1].toLowerCase()}/${m[2].toLowerCase()}`;
    s = s.replace(/^@/, '');
    const k = s.match(/^(c|user)\/([^/?#\s]+)/i);
    if (k) s = `${k[1].toLowerCase()}/${k[2]}`;
    else s = `c/${s.split(/[/?#\s]/)[0]}`;
    return /^(c|user)\/[A-Za-z0-9_.-]{1,80}$/.test(s) ? s.toLowerCase() : '';
}

function getPage(url, agent) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            agent,
            headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html,application/xhtml+xml' },
            timeout: 25000,
        }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { body += c; if (body.length > 3e6) req.destroy(new Error('too large')); });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
    });
}

const decode = (s) => String(s)
    .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&apos;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ').trim();

async function fetchProfile(platformUsername) {
    const id = extractChannel(platformUsername);
    if (!id) {
        const err = new Error('Channel not found');
        err.code = 'CHANNEL_NOT_FOUND';
        throw err;
    }
    const url = `https://rumble.com/${id}/about`;
    const attempts = process.env.RUMBLE_FETCH_PROXY ? MAX_ATTEMPTS : 1;
    for (let i = 1; i <= attempts; i++) {
        const px = proxyUrl();
        let r;
        try {
            // eslint-disable-next-line no-await-in-loop
            r = await getPage(url, px ? new HttpsProxyAgent(px) : undefined);
        } catch (e) {
            console.warn(`[rumble] attempt ${i} for ${id} failed: ${scrub(e.message)}`);
            continue;
        }
        if (r.status === 404) {
            const err = new Error('Channel not found');
            err.code = 'CHANNEL_NOT_FOUND';
            throw err;
        }
        if (r.status !== 200) {
            // 403 "Just a moment..." = Cloudflare challenged this exit IP: next one.
            console.warn(`[rumble] attempt ${i} for ${id}: HTTP ${r.status}`);
            continue;
        }
        const desc = r.body.match(/class="channel-about--description"[^>]*>([\s\S]*?)<\/div>/);
        const title = r.body.match(/<title>([^<]*)/);
        return {
            canonical_username: id,
            text: [title ? decode(title[1]) : '', desc ? decode(desc[1]) : ''].filter(Boolean).join('\n'),
        };
    }
    throw new Error('Platform lookup failed');
}

module.exports = { name: 'rumble', fetchProfile, extractChannel };
