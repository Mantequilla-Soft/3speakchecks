/**
 * Cover art for outside podcasts (External on /audio), as small square JPEGs.
 *
 * Podcast art lives on every host imaginable and is often 3000 px / 1 MB, and
 * Hive's image proxy (which the frontend uses for other outside images) refuses
 * plenty of it. So the checker renders it itself: fetched through safeFetch
 * (the same guard as the feeds), squared and shrunk by ffmpeg like the RSS
 * covers (utils/podcastCover.js), kept in a small in-memory cache and sent with
 * a week of browser caching.
 *
 * Only images the checker itself handed out can be rendered: every image URL in
 * a /podcasts answer becomes a token, `<hmac>.<base64url url>`, and the route
 * refuses anything else. Otherwise this would be an open image proxy.
 */
const crypto = require('crypto');
const { spawn } = require('child_process');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { safeFetch } = require('./safeFetch');

const SIZES = new Set([64, 128, 256, 512]);
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_CONCURRENT = 2;
const CACHE_MAX = 400;
const FAIL_TTL_MS = 10 * 60 * 1000;

const SECRET = process.env.PODCAST_ART_SECRET
  || crypto.createHash('sha256').update(`podcast-art|${process.env.MONGODB_URI || ''}`).digest();

const sign = (url) => crypto.createHmac('sha256', SECRET).update(url).digest('base64url').slice(0, 16);

/** The token for an image URL, or '' for no image. */
function artToken(url) {
  if (!url || !/^https?:\/\//i.test(url) || url.length > 1500) return '';
  return `${sign(url)}.${Buffer.from(url, 'utf8').toString('base64url')}`;
}

/** The image URL behind a token, or null when the token is not ours. */
function urlFromToken(token) {
  const m = /^([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{8,2100})$/.exec(String(token || ''));
  if (!m) return null;
  const url = Buffer.from(m[2], 'base64url').toString('utf8');
  const a = Buffer.from(sign(url));
  const b = Buffer.from(m[1]);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? url : null;
}

const cache = new Map();   // `${px}|${url}` → Buffer
const failed = new Map();  // url → time it failed

let running = 0;
const waiting = [];
async function withSlot(fn) {
  if (running >= MAX_CONCURRENT) await new Promise((resolve) => waiting.push(resolve));
  running += 1;
  try { return await fn(); } finally {
    running -= 1;
    const next = waiting.shift();
    if (next) next();
  }
}

function ffmpeg(inPath, outPath, px) {
  const args = [
    '-hide_banner', '-nostdin', '-y', '-loglevel', 'error',
    '-i', inPath, '-frames:v', '1',
    '-vf', `scale=${px}:${px}:force_original_aspect_ratio=increase,crop=${px}:${px},format=yuvj420p`,
    '-q:v', '4', outPath,
  ];
  return new Promise((resolve, reject) => {
    const proc = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (c) => { stderr = (stderr + c).slice(-500); });
    const timer = setTimeout(() => proc.kill('SIGKILL'), 20000);
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg ${code}: ${stderr.trim().split('\n').pop() || ''}`));
    });
  });
}

/** Square `px` JPEG of the image at `url`. Throws when it can't be had. */
async function renderArt(url, px) {
  if (!SIZES.has(px)) throw new Error('bad size');
  const key = `${px}|${url}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const f = failed.get(url);
  if (f && Date.now() - f < FAIL_TTL_MS) throw new Error('failed recently');
  try {
    const jpeg = await withSlot(async () => {
      const res = await safeFetch(url, { timeoutMs: 15000, maxBytes: MAX_SOURCE_BYTES, headers: { Accept: 'image/*' } });
      const type = String(res.headers['content-type'] || '').toLowerCase();
      if (type && !type.startsWith('image/') && !type.startsWith('application/octet-stream')) throw new Error(`not an image (${type})`);
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'spk-art-'));
      try {
        const inPath = path.join(dir, 'in');
        const outPath = path.join(dir, 'out.jpg');
        await fsp.writeFile(inPath, res.body);
        await ffmpeg(inPath, outPath, px);
        return await fsp.readFile(outPath);
      } finally {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    });
    cache.set(key, jpeg);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return jpeg;
  } catch (err) {
    failed.set(url, Date.now());
    if (failed.size > 2000) failed.delete(failed.keys().next().value);
    throw err;
  }
}

module.exports = { artToken, urlFromToken, renderArt, SIZES };
