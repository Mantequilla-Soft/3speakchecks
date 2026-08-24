/**
 * Banner burn-in: composite an advertiser's still into the video's OWN PIXELS for
 * the seconds it runs, rather than drawing it over the player in the page.
 *
 * WHY NOT AN OVERLAY. An overlay is a DOM node. A DOM node is one cosmetic filter
 * rule away from being hidden, and unlike the spliced roll — where blocking the ad
 * means blocking the playlist and losing the video — hiding a banner costs the
 * viewer nothing. So the banner is not drawn over the frame; it becomes part of the
 * frame. There is nothing to hide: the only way to remove it is to not decode the
 * video. The click target on top of it IS still a DOM node and still blockable, but
 * blocking it only costs the advertiser a click, never the impression.
 *
 * HOW IT RIDES THE EXISTING STITCHER. The playlist already passes through /m, where
 * the roll is spliced in. A banner substitutes the handful of content segments its
 * run covers for URLs on this origin that serve burned bytes. Everything else in the
 * playlist still points straight at BunnyCDN, so the change is a few segments, not a
 * video proxy.
 *
 * BANDWIDTH, WHICH IS THE REAL CONSTRAINT HERE. adServe.js is explicit that bytes
 * must not transit this box: a 1080p viewer is ~3 Mbit/s and this machine averages
 * about 2.4 Mbit/s across every service it runs, which is why the roll 302s to the
 * CDN instead of proxying. Burned segments cannot 302 anywhere — they only exist
 * here — so they are the exception, and the exception has to be shown to be small:
 *
 *     a burned segment measures ~320KB (SMALLER than the 431KB original: the
 *     re-encode is a touch lossier), a banner run covers ~3 segments, so ~960KB
 *     per play. Network-wide sellable inventory is 434 plays/day. If EVERY play
 *     carried a banner that is ~417MB/day, an average of ~39 kbit/s — about 1.6%
 *     of what this box already pushes.
 *
 * 🚨 That headroom is the whole argument, so it has a threshold: if banner plays
 * ever exceed roughly 10k/day this stops being free and burned segments need to go
 * to the CDN (burn once, upload, 302) instead. Until then, on-box with an immutable
 * cache is the simpler correct answer, and the cache is what makes it cheap — a
 * burned segment is identical for every viewer of the same video and campaign, so
 * it is produced once and then only ever read.
 *
 * COST OF PRODUCING ONE. Measured on this box, 6s of 1280x720: 0.36s of CPU. A
 * 15-second banner is ~3 segments, so ~1.1s, once, per (video, creative, position).
 *
 * ⚠️ NOT VERIFIED IN A REAL BROWSER YET. The burn is verified — pixels land, timing
 * is preserved to the millisecond — but this box's headless Chromium has no H.264,
 * so a burned segment has never actually been decoded by hls.js here. The parameter
 * matching below is what makes that safe in principle; it still wants one real
 * playback before this is sold to anybody.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileP = promisify(execFile);

const {
  AD_BURN_CACHE_DIR, AD_BURN_CACHE_MAX_MB, AD_BURN_TIMEOUT_MS,
  AD_BANNER_WIDTH_PCT, AD_BANNER_MAX_HEIGHT_PCT, AD_BANNER_MARGIN_PCT, AD_BANNER_LABEL,
} = require('../utils/config');

/** Bumped when the composite changes shape. Old cache entries then simply miss. */
const RECIPE_VERSION = 'v1';

const CACHE_DIR = AD_BURN_CACHE_DIR || path.join(os.tmpdir(), '3speak-ad-burn');

let dirReady = false;
async function ensureDir() {
  if (dirReady) return;
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  dirReady = true;
}

/**
 * The cache key. Everything that changes the output bytes goes in, and nothing that
 * does not: two viewers of the same video, campaign and position share one file.
 * Deliberately NOT keyed on session — that would make the cache useless and the
 * bandwidth argument above false.
 */
function keyFor({ segmentUrl, imageUrl, position }) {
  return crypto.createHash('sha256')
    .update([RECIPE_VERSION, segmentUrl, imageUrl, position || 'bottom'].join('\n'))
    .digest('hex');
}

/** Single-flight: concurrent requests for one key wait on the same burn. */
const inflight = new Map();

/** Probe a media file for the parameters the re-encode has to mirror. */
async function probe(file) {
  const { stdout } = await execFileP('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate,profile,level,pix_fmt',
    '-of', 'json', file,
  ], { timeout: 15000 });
  const s = (JSON.parse(stdout).streams || [])[0] || {};
  const [num, den] = String(s.r_frame_rate || '').split('/');
  const fps = Number(den) > 0 ? Number(num) / Number(den) : Number(num) || 0;
  return {
    width: Number(s.width) || 0,
    height: Number(s.height) || 0,
    fps: Number.isFinite(fps) && fps > 0 ? fps : 0,
    pixFmt: s.pix_fmt || 'yuv420p',
    profile: String(s.profile || '').toLowerCase(),
  };
}

async function download(url, dest, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    await fsp.writeFile(dest, Buffer.from(await res.arrayBuffer()));
  } finally {
    clearTimeout(t);
  }
}

/**
 * The composite.
 *
 * Geometry is computed from the probed frame rather than expressed as filter-graph
 * percentages, because the same content is encoded at several resolutions and a
 * banner that is 60% of the frame has to be 60% of THIS variant's frame. Widths are
 * forced even — libx264 rejects odd dimensions on yuv420p.
 *
 * The "Ad" label is burned in with the banner, not drawn in the page. Disclosure is
 * required by EU and US advertising rules, so it has to survive everything the
 * banner itself survives; a label in the DOM would be the one removable part of an
 * otherwise unremovable ad, which is precisely the wrong way round.
 */
function filterGraph(frame, image) {
  const { width, height } = frame;

  // The banner BOX: bounded on both axes. Width alone is not enough — an advertiser
  // who uploads a square (a logo rather than a strip, which is exactly what the
  // first real creative on file is) would otherwise be scaled to 60% of the frame
  // WIDTH and land 60% of the frame tall, covering the video instead of sitting
  // along the bottom of it. Fitting inside a box makes every aspect ratio behave:
  // a 728x90 strip fills it, a square lands small and centred.
  const boxW = Math.max(2, Math.round((width * AD_BANNER_WIDTH_PCT) / 100));
  const boxH = Math.max(2, Math.round((height * AD_BANNER_MAX_HEIGHT_PCT) / 100));

  // Fitted here rather than with force_original_aspect_ratio, because the label has
  // to be pinned to the banner's REAL left edge and that is not knowable inside the
  // filter graph. Concrete pixels for everything, computed once, is also the version
  // a person can check against a frame grab.
  const srcW = Math.max(1, Number(image.width) || 1);
  const srcH = Math.max(1, Number(image.height) || 1);
  const scale = Math.min(boxW / srcW, boxH / srcH);
  const bw = Math.max(2, Math.round((srcW * scale) / 2) * 2);   // even: libx264 on yuv420p
  const bh = Math.max(2, Math.round((srcH * scale) / 2) * 2);

  const margin = Math.max(2, Math.round((height * AD_BANNER_MARGIN_PCT) / 100));
  const x = Math.round((width - bw) / 2);
  const y = Math.max(0, height - bh - margin);

  // Sized off the frame so it stays legible on a 480p variant without dominating a
  // 1080p one.
  const fontSize = Math.max(9, Math.round(height * 0.026));
  const pad = Math.max(2, Math.round(fontSize * 0.34));
  const label = String(AD_BANNER_LABEL || 'Ad').replace(/[\\':%]/g, '');

  return [
    `[1:v]scale=${bw}:${bh}[bn]`,
    `[0:v][bn]overlay=${x}:${y}:format=auto[ov]`,
    // Bottom-left corner of the banner itself, so the disclosure travels with the
    // ad whatever shape the creative turned out to be.
    `[ov]drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf`
      + `:text='${label}':fontcolor=white@0.92:fontsize=${fontSize}`
      + `:box=1:boxcolor=black@0.55:boxborderw=${pad}`
      + `:x=${x + pad}:y=${y + bh - fontSize - pad * 2}[v]`,
  ].join(';');
}

/**
 * Produce (or reuse) the burned version of one content segment.
 * Returns an absolute path to a .ts file, or null if it could not be made — the
 * caller then serves the ORIGINAL segment, so a burn failure costs an impression
 * and never a playback.
 */
async function burnSegment({ segmentUrl, imageUrl, position = 'bottom' }) {
  await ensureDir();
  const key = keyFor({ segmentUrl, imageUrl, position });
  const out = path.join(CACHE_DIR, `${key}.ts`);

  try {
    const st = await fsp.stat(out);
    if (st.size > 0) {
      // Touch, so the size-based sweep evicts genuinely cold entries rather than
      // whichever happened to be written first.
      const now = new Date();
      fsp.utimes(out, now, now).catch(() => {});
      return out;
    }
  } catch { /* not cached yet */ }

  if (inflight.has(key)) return inflight.get(key);

  const work = (async () => {
    const tmpSeg = path.join(CACHE_DIR, `.${key}.src.ts`);
    const tmpImg = path.join(CACHE_DIR, `.${key}.img`);
    const tmpOut = path.join(CACHE_DIR, `.${key}.out.ts`);
    try {
      await Promise.all([
        download(segmentUrl, tmpSeg, AD_BURN_TIMEOUT_MS),
        download(imageUrl, tmpImg, AD_BURN_TIMEOUT_MS),
      ]);

      const [p, img] = await Promise.all([probe(tmpSeg), probe(tmpImg)]);
      if (!p.width || !p.height) throw new Error('could not probe segment');
      if (!img.width || !img.height) throw new Error('could not probe banner image');

      // Mirror the source's parameters. A segment whose codec parameters differ from
      // its neighbours can stall hls.js at the join, and unlike the roll there is no
      // EXT-X-DISCONTINUITY here to announce a change — the run is the same length
      // as what it replaces, so the timeline never moves and the player is not told
      // anything changed. Which means nothing may.
      const args = [
        '-v', 'error', '-y', '-copyts',
        '-i', tmpSeg,
        '-i', tmpImg,
        '-filter_complex', filterGraph(p, img),
        '-map', '[v]', '-map', '0:a?',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
        '-pix_fmt', p.pixFmt,
        '-profile:v', p.profile.includes('baseline') ? 'baseline' : (p.profile.includes('high') ? 'high' : 'main'),
        // No -force_key_frames here, deliberately. x264 always emits an IDR as its
        // first frame, so a segment that starts decodable is free. Asking for it
        // explicitly is worse than redundant: with -copyts the segment's timestamps
        // start at its real position in the video (13.5s, not 0), so the obvious
        // `expr:gte(t,0)` is true for EVERY frame and silently produces an all-intra
        // segment — measured at 9MB against the 431KB original, a 20x regression
        // that plays correctly and would only ever have shown up as a bandwidth bill.
        '-c:a', 'copy',
        '-muxdelay', '0', '-muxpreload', '0',
        '-f', 'mpegts', tmpOut,
      ];
      await execFileP('ffmpeg', args, { timeout: AD_BURN_TIMEOUT_MS, maxBuffer: 1 << 20 });

      const st = await fsp.stat(tmpOut);
      if (!st.size) throw new Error('ffmpeg produced nothing');
      // Rename last: a reader either sees no file or a complete one, never a partial
      // segment mid-write.
      await fsp.rename(tmpOut, out);
      sweep().catch(() => {});
      return out;
    } catch (err) {
      console.error('[ad-burn] failed:', err && err.message);
      return null;
    } finally {
      for (const f of [tmpSeg, tmpImg, tmpOut]) fsp.unlink(f).catch(() => {});
      inflight.delete(key);
    }
  })();

  inflight.set(key, work);
  return work;
}

/**
 * Keep the cache under its cap, coldest first. Cheap and approximate on purpose:
 * this runs after a burn, not on a timer, and being a little over the cap for a
 * moment costs nothing.
 */
let sweeping = false;
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    const names = (await fsp.readdir(CACHE_DIR)).filter((n) => n.endsWith('.ts') && !n.startsWith('.'));
    const stats = [];
    let total = 0;
    for (const n of names) {
      try {
        const st = await fsp.stat(path.join(CACHE_DIR, n));
        stats.push({ n, size: st.size, atime: st.atimeMs });
        total += st.size;
      } catch { /* vanished under us */ }
    }
    const cap = AD_BURN_CACHE_MAX_MB * 1024 * 1024;
    if (total <= cap) return;
    stats.sort((a, b) => a.atime - b.atime);
    for (const s of stats) {
      if (total <= cap) break;
      await fsp.unlink(path.join(CACHE_DIR, s.n)).catch(() => {});
      total -= s.size;
    }
  } finally {
    sweeping = false;
  }
}

/** Is a burned segment already on disk? Lets the serving path avoid a stat race. */
function cachedPath({ segmentUrl, imageUrl, position = 'bottom' }) {
  const out = path.join(CACHE_DIR, `${keyFor({ segmentUrl, imageUrl, position })}.ts`);
  try { return fs.statSync(out).size > 0 ? out : null; } catch { return null; }
}

module.exports = { burnSegment, cachedPath, keyFor, CACHE_DIR };
