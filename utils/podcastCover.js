/**
 * Podcast cover art
 *
 * Apple Podcasts only takes square JPEG/PNG covers of 1400-3000 px. Playlist
 * covers are whatever the creator uploaded (often a large non-square WebP) and
 * channel covers are Hive avatars (512 px at most), so feeds point at
 * /img/c/... instead: nginx caches the result (snippets/3speak-img.conf) and on
 * a miss asks the checker's /rss/cover route, which renders it here.
 */

const { spawn } = require('child_process');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const COVER_SIZE = 1400;
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15000;
const MAX_CONCURRENT = 2;

// Only fetch from image hosts we know. Playlist covers and avatars are user
// data, so an open fetcher here would let anyone make the checker request
// internal addresses. Hive's avatar redirect stays on images.hive.blog.
const ALLOWED_HOSTS = (process.env.RSS_COVER_HOSTS || 'images.3speak.tv,images.hive.blog')
    .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);

function isAllowedSource(url) {
    try {
        const u = new URL(url);
        return u.protocol === 'https:' && ALLOWED_HOSTS.includes(u.hostname.toLowerCase());
    } catch {
        return false;
    }
}

/** Fetch an allowed image, following up to 3 redirects that stay allowed. */
async function fetchSource(url) {
    let current = url;
    for (let hop = 0; hop <= 3; hop++) {
        if (!isAllowedSource(current)) throw new Error(`source not allowed: ${current}`);
        const res = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
            current = new URL(res.headers.get('location'), current).toString();
            continue;
        }
        if (!res.ok) throw new Error(`source HTTP ${res.status}`);
        const length = parseInt(res.headers.get('content-length'), 10);
        if (length > MAX_SOURCE_BYTES) throw new Error('source too large');
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_SOURCE_BYTES) throw new Error('source too large');
        return buf;
    }
    throw new Error('too many redirects');
}

let running = 0;
const waiting = [];
async function withSlot(fn) {
    if (running >= MAX_CONCURRENT) await new Promise((resolve) => waiting.push(resolve));
    running++;
    try {
        return await fn();
    } finally {
        running--;
        const next = waiting.shift();
        if (next) next();
    }
}

/** Centre-crop to a square and scale to COVER_SIZE (enlarging small avatars). */
function renderJpeg(inPath, outPath) {
    const args = [
        '-hide_banner', '-nostdin', '-y', '-loglevel', 'error',
        '-i', inPath,
        '-frames:v', '1',
        '-vf', `scale=${COVER_SIZE}:${COVER_SIZE}:force_original_aspect_ratio=increase,crop=${COVER_SIZE}:${COVER_SIZE},format=yuvj420p`,
        '-q:v', '5',
        outPath,
    ];
    return new Promise((resolve, reject) => {
        const proc = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        proc.stderr.on('data', (c) => { stderr = (stderr + c).slice(-2000); });
        const timer = setTimeout(() => proc.kill('SIGKILL'), 30000);
        proc.on('error', (err) => { clearTimeout(timer); reject(err); });
        proc.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim().split('\n').pop() || ''}`));
        });
    });
}

/**
 * Square 1400 px JPEG of the image at sourceUrl.
 * @returns {Promise<Buffer>}
 */
async function renderCover(sourceUrl) {
    return withSlot(async () => {
        const source = await fetchSource(sourceUrl);
        const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'spk-cover-'));
        try {
            const inPath = path.join(dir, 'source');
            const outPath = path.join(dir, 'cover.jpg');
            await fsp.writeFile(inPath, source);
            await renderJpeg(inPath, outPath);
            return await fsp.readFile(outPath);
        } finally {
            await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
        }
    });
}

module.exports = { renderCover, isAllowedSource, COVER_SIZE };
