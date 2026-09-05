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
  AD_BANNER_WIDTH_PCT, AD_BANNER_MAX_HEIGHT_PCT, AD_BANNER_MAX_HEIGHT_PX,
  AD_BANNER_MARGIN_PCT, AD_BANNER_LABEL,
} = require('../utils/config');

/* Bumped when the composite changes shape. Old cache entries then simply miss.
 *
 * 🚨 BUMP IT, and remember that a cached burn is served BEFORE any of the decisions
 * below are reached. Removing the loop without bumping this left the previous burns in
 * place and they kept being handed out, so the fix looked like it had not worked at
 * all. The cache lives at AD_BURN_CACHE_DIR (/var/cache/3speak-ad-burn), not in /tmp.
 */
const RECIPE_VERSION = 'v5';

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
function keyFor({ segmentUrl, imageUrl, videoUrl, offsetSeconds, visibleSeconds, position }) {
  /* 🚨 `offsetSeconds` is part of the key for a VIDEO banner and must be.
   *
   * A still looks the same wherever in its run it lands, so one burn serves every
   * segment. A moving banner does not: segment 2 has to show the banner two segments
   * further in, or every segment restarts it and the viewer sees the first second of
   * the ad on repeat. The phase is therefore an input to the bytes, so it is an input
   * to the key. Quantised to the segment grid it comes from, so it stays a small
   * finite set per (video, creative) rather than a new file per request. */
  const phase = videoUrl ? String(Math.round((Number(offsetSeconds) || 0) * 1000)) : '';
  // How much of this segment carries the banner is also an input to the bytes: the
  // final segment of a run shows it for part of its length and the rest plain.
  const visible = Number.isFinite(visibleSeconds) ? String(Math.round(visibleSeconds * 1000)) : 'all';
  return crypto.createHash('sha256')
    .update([RECIPE_VERSION, segmentUrl, imageUrl || videoUrl || '', phase, visible, position || 'bottom'].join('\n'))
    .digest('hex');
}

/** Single-flight: concurrent requests for one key wait on the same burn. */
const inflight = new Map();

/** Probe a media file for the parameters the re-encode has to mirror. */
async function probe(file) {
  const { stdout } = await execFileP('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate,profile,level,pix_fmt,duration,start_time',
    '-show_entries', 'format=duration',
    '-of', 'json', file,
  ], { timeout: 15000 });
  const parsed = JSON.parse(stdout);
  const s = (parsed.streams || [])[0] || {};
  // Stream duration first, container second: a stream-copied MPEG-TS often carries
  // one and not the other, and a banner with no known length cannot be looped.
  const dur = Number(s.duration) || Number((parsed.format || {}).duration) || 0;
  const [num, den] = String(s.r_frame_rate || '').split('/');
  const fps = Number(den) > 0 ? Number(num) / Number(den) : Number(num) || 0;
  return {
    width: Number(s.width) || 0,
    height: Number(s.height) || 0,
    fps: Number.isFinite(fps) && fps > 0 ? fps : 0,
    pixFmt: s.pix_fmt || 'yuv420p',
    profile: String(s.profile || '').toLowerCase(),
    duration: Number.isFinite(dur) && dur > 0 ? dur : 0,
    // Where this segment sits on the video's own clock. The burn preserves timestamps,
    // so a filter expression in `t` is measured from here, not from zero.
    startTime: Number(s.start_time) || 0,
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
 * A local, loopable copy of a banner VIDEO, produced once and reused.
 *
 * The creative is an HLS manifest, because a video creative goes through the normal
 * encoder. ffmpeg can read a manifest directly, but not usefully here: `-stream_loop`
 * over the HLS demuxer is unreliable, and every segment burn would re-fetch the whole
 * playlist. So the banner is flattened once into a single local file and every burn
 * loops THAT.
 *
 * Audio is dropped on the way in. A banner shares the frame with a video the viewer
 * chose to watch, and taking over their sound is not something an advertiser gets to
 * buy at this price. Nothing downstream maps it either, so this only saves work.
 *
 * Returns null on failure, and the caller then serves the segment unburned: a banner
 * that cannot be fetched must never cost somebody their playback.
 */
async function ensureBannerSource(videoUrl) {
  await ensureDir();
  const key = crypto.createHash('sha256').update(`${RECIPE_VERSION}\nsrc\n${videoUrl}`).digest('hex');
  const out = path.join(CACHE_DIR, `src-${key}.mp4`);

  try {
    const st = await fsp.stat(out);
    if (st.size > 0) {
      const now = new Date();
      fsp.utimes(out, now, now).catch(() => {});
      const p = await probe(out);
      if (p.duration > 0) return { file: out, duration: p.duration };
    }
  } catch { /* not cached yet */ }

  const inflightKey = `src:${key}`;
  if (inflight.has(inflightKey)) return inflight.get(inflightKey);

  const work = (async () => {
    const tmp = path.join(CACHE_DIR, `.src-${key}.mp4`);
    try {
      await execFileP('ffmpeg', [
        '-v', 'error', '-y',
        '-i', videoUrl,
        '-an',                          // silent, deliberately: see above
        /* Scaled down to the banner height on the way in, never up.
         *
         * A banner is fitted into a box when it is composited, so an oversized upload
         * would be scaled down there anyway and this changes nothing about how it
         * looks. What it changes is the work: every segment burn overlays this file,
         * and scaling a 4K strip down to a few hundred pixels once beats doing it on
         * every burn. `-2` keeps the aspect ratio and forces an even width, which
         * libx264 requires on yuv420p; `min` is what stops a small banner being
         * blown up into a blurry one. */
        '-vf', `scale=-2:'min(${AD_BANNER_MAX_HEIGHT_PX},ih)'`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-pix_fmt', 'yuv420p',
        // faststart is pointless for a local file, but movflags is where a
        // non-seekable input would otherwise produce an unseekable output, and the
        // loop below seeks into this on every burn.
        '-movflags', '+faststart',
        tmp,
      ], { timeout: AD_BURN_TIMEOUT_MS, maxBuffer: 1 << 20 });

      const st = await fsp.stat(tmp);
      if (!st.size) throw new Error('ffmpeg produced no banner source');
      const p = await probe(tmp);
      if (!(p.duration > 0)) throw new Error('banner source has no duration');
      await fsp.rename(tmp, out);
      sweep().catch(() => {});
      return { file: out, duration: p.duration };
    } catch (err) {
      console.error('[ad-burn] banner source failed:', err && err.message);
      await fsp.unlink(tmp).catch(() => {});
      return null;
    } finally {
      inflight.delete(inflightKey);
    }
  })();

  inflight.set(inflightKey, work);
  return work;
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
function filterGraph(frame, image, visibleSeconds = null) {
  const { width, height } = frame;

  // The banner BOX: bounded on both axes. Width alone is not enough — an advertiser
  // who uploads a square (a logo rather than a strip, which is exactly what the
  // first real creative on file is) would otherwise be scaled to 60% of the frame
  // WIDTH and land 60% of the frame tall, covering the video instead of sitting
  // along the bottom of it. Fitting inside a box makes every aspect ratio behave:
  // a 728x90 strip fills it, a square lands small and centred.
  const boxW = Math.max(2, Math.round((width * AD_BANNER_WIDTH_PCT) / 100));
  /* Bounded as a share of the frame AND in absolute pixels.
   *
   * The percentage alone scales with the variant, which is what keeps a banner
   * legible on a 480p rendition. But it also means a tall creative on a 1080p frame
   * is allowed to be genuinely large: 20% of 1080 is 216px of banner, and a squarer
   * upload takes all of it. AD_BANNER_MAX_HEIGHT_PX is the ceiling that stops a
   * banner growing with the screen past the point of being a banner.
   *
   * The smaller of the two wins, so small frames stay governed by the percentage and
   * big ones by the pixel cap. Aspect is preserved either way: this is the BOX, and
   * the scale below fits the creative inside it without distorting it. */
  const boxH = Math.max(2, Math.min(
    Math.round((height * AD_BANNER_MAX_HEIGHT_PCT) / 100),
    AD_BANNER_MAX_HEIGHT_PX,
  ));

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
    /* 🚨 The banner's clock has to be moved onto the segment's clock.
     *
     * overlay pairs frames by TIMESTAMP, and the burn keeps the segment's own
     * timestamps (`-copyts`), so a segment 31.8s into a video carries frames stamped
     * 31.8 and up while the banner's start at 0. Every banner frame then looks
     * overdue: overlay consumes the whole 10-second banner inside the first few
     * seconds of the segment and holds the last frame for the rest, which on screen
     * is a banner that flickers past and then freezes.
     *
     * `setpts=PTS-STARTPTS+start/TB` normalises the banner to zero and then moves it
     * to where this segment begins, so one banner second maps to one segment second.
     * The `-ss` above chooses WHERE in the banner to start; this decides WHEN it
     * plays. Both are needed and they are not the same thing. */
    `[1:v]scale=${bw}:${bh},setpts=PTS-STARTPTS+${frame.startTime.toFixed(3)}/TB[bn]`,
    /* No `shortest`, for either kind.
     *
     * It was needed while the banner looped: an endless input gives the overlay no
     * reason to finish and ffmpeg would encode until the timeout. The banner is finite
     * now and usually SHORTER than the segment it decorates, so `shortest=1` would end
     * the output when the banner ran out and truncate the viewer's video. The overlay's
     * own default holds the last frame instead, and that frame never shows because
     * `enable` has switched it off by then. */
    /* `enable` is what makes a booking mean what it says.
     *
     * A burn paints whole segments, so a 20-second banner whose run covers four
     * 6-second segments was on screen for 24. Tolerable for a still, obvious for a
     * looping video: the viewer watches it start a third time and stop halfway.
     *
     * ⚠️ Measured against the segment's OWN start time, not zero. The burn keeps
     * timestamps (`-copyts`), so `t` here is the position in the whole video: a naive
     * `lt(t,20)` is false for every frame of a segment that begins at 30s, and the
     * banner would never appear at all. */
    `[0:v][bn]overlay=${x}:${y}:format=auto`
      + `${visibleSeconds != null ? `:enable='lt(t-${frame.startTime.toFixed(3)},${visibleSeconds.toFixed(3)})'` : ''}[ov]`,
    // Bottom-left corner of the banner itself, so the disclosure travels with the
    // ad whatever shape the creative turned out to be.
    `[ov]drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf`
      + `:text='${label}':fontcolor=white@0.92:fontsize=${fontSize}`
      + `:box=1:boxcolor=black@0.55:boxborderw=${pad}`
      + `:x=${x + pad}:y=${y + bh - fontSize - pad * 2}`
      // The disclosure travels with the ad. Left running past the banner it labels, it
      // would sit on plain video announcing an ad that is no longer there.
      + `${visibleSeconds != null ? `:enable='lt(t-${frame.startTime.toFixed(3)},${visibleSeconds.toFixed(3)})'` : ''}[v]`,
  ].join(';');
}

/**
 * Produce (or reuse) the burned version of one content segment.
 * Returns an absolute path to a .ts file, or null if it could not be made — the
 * caller then serves the ORIGINAL segment, so a burn failure costs an impression
 * and never a playback.
 */
async function burnSegment({
  segmentUrl, imageUrl, videoUrl, offsetSeconds = 0, visibleSeconds = null, position = 'bottom',
}) {
  await ensureDir();
  if (!imageUrl && !videoUrl) return null;
  // Nothing of this segment is inside the booked window. The caller serves the
  // original, which is cheaper than burning an unchanged picture.
  if (visibleSeconds != null && !(visibleSeconds > 0)) return null;
  const key = keyFor({ segmentUrl, imageUrl, videoUrl, offsetSeconds, visibleSeconds, position });
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
      /* A moving banner is flattened once and reused; a still is downloaded per burn
       * as it always was. Both end up as "a local file to overlay", so everything
       * below this point is the same either way apart from the two input flags. */
      let bannerFile = null;
      let bannerDuration = 0;
      if (videoUrl) {
        const src = await ensureBannerSource(videoUrl);
        if (!src) throw new Error('banner video unavailable');
        bannerFile = src.file;
        bannerDuration = src.duration;
        await download(segmentUrl, tmpSeg, AD_BURN_TIMEOUT_MS);
      } else {
        await Promise.all([
          download(segmentUrl, tmpSeg, AD_BURN_TIMEOUT_MS),
          download(imageUrl, tmpImg, AD_BURN_TIMEOUT_MS),
        ]);
        bannerFile = tmpImg;
      }

      const [p, img] = await Promise.all([probe(tmpSeg), probe(bannerFile)]);
      if (!p.width || !p.height) throw new Error('could not probe segment');
      if (!img.width || !img.height) throw new Error('could not probe the banner');

      /* Where in the banner this segment picks it up. NOT taken modulo anything.
       *
       * 🚨 A modulo here IS a loop, whatever the ffmpeg flags say. It was left behind
       * as a "guard" when -stream_loop went, and it quietly kept doing the same job: a
       * 10-second banner under a 20-second booking seeks to 0.0, then 6.1, then 2.1 and
       * 8.2, so the third segment restarts the video. That is exactly the loop removing
       * the flag was supposed to have removed.
       *
       * Past the end of the banner there is nothing left to paint, and the segment is
       * served untouched. */
      const phase = Number(offsetSeconds) || 0;
      /* PLAYED ONCE, never looped.
       *
       * Looping was the obvious way to fill a booking with a short clip and a worse
       * deal than it looks: the seam lands wherever the loop happens to fall, and a
       * clip a fraction under the booked length restarts and stops immediately. The
       * length is the advertiser's to get right, enforced when the creative is
       * attached, and this just seeks to the right point and plays.
       *
       * `-ss` is still per segment: each one picks the banner up where the last left
       * it, which is what stops it restarting at every segment boundary. */
      /* How much banner is LEFT from here, and the window is the smaller of that and
       * what is still booked.
       *
       * A creative that covers its booking never reaches this: the footage remaining
       * always outlasts the booking remaining. It matters for the ones attached before
       * that became a requirement, where the alternative is the overlay holding a
       * frozen last frame for the rest of the window. Stopping is the honest version
       * of running out. */
      const remaining = (videoUrl && bannerDuration > 0) ? bannerDuration - phase : Infinity;
      if (!(remaining > 0)) return null;
      const window = Math.min(visibleSeconds != null ? visibleSeconds : Infinity, remaining);
      const paintFor = Number.isFinite(window) ? window : null;

      const bannerInput = videoUrl
        ? ['-ss', phase.toFixed(3), '-i', bannerFile]
        : ['-i', bannerFile];

      // Mirror the source's parameters. A segment whose codec parameters differ from
      // its neighbours can stall hls.js at the join, and unlike the roll there is no
      // EXT-X-DISCONTINUITY here to announce a change — the run is the same length
      // as what it replaces, so the timeline never moves and the player is not told
      // anything changed. Which means nothing may.
      const args = [
        '-v', 'error', '-y', '-copyts',
        '-i', tmpSeg,
        ...bannerInput,
        '-filter_complex', filterGraph(p, img, paintFor),
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
