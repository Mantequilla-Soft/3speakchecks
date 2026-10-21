/**
 * 🧬 Making a spot's ENCODING match the video it is spliced into.
 *
 * WHY THIS EXISTS
 * A stitched playlist puts the ad behind an EXT-X-DISCONTINUITY and both go into the
 * same MSE SourceBuffer. Both playlists declare the same CODECS string, so the player
 * has no reason to call SourceBuffer.changeType() at the join — but the streams behind
 * those identical strings are not the same shape at all. Measured on a real pairing:
 *
 *     content   H.264 High@3.2   1280x720    AAC 48000
 *     spot      H.264 High@5.0   1080x1920   AAC 44100
 *     declared  avc1.4D401F (Main@3.1), 854x480, in BOTH manifests
 *
 * The transmuxed init segments therefore carry different codec strings, Chrome refuses
 * the append and fails the whole media element with MEDIA_ERR_SRC_NOT_SUPPORTED, and
 * Firefox tolerates it and plays. That is the entire difference between the two
 * browsers, and it is why matching only the audio was not enough.
 *
 * 🚨 There is no single profile to encode ads at, because there is no single profile
 * the library is in: audio rates measured across recent uploads are a mix of 44100 and
 * 48000, and resolution and level vary per video. So the spot has to be conformed to
 * whatever it lands in front of, which is a decision per (creative, content) and
 * cannot be made once at upload.
 *
 * WHAT IT DOES
 * Probes both sides, and when they differ, re-encodes the spot to the content's exact
 * profile, level, resolution and audio rate, so the join carries no codec change at
 * all. The result is cached on disk by every parameter that went into it, so a
 * creative is encoded once per distinct shape it ever meets — the content ladder is
 * small, so that is a handful of files per creative, ever.
 *
 * It letterboxes rather than crops, which also happens to fix a portrait spot booked
 * into a landscape roll: the whole creative is shown, centred, on the content's canvas
 * instead of being stretched into it.
 *
 * Everything here fails SOFT. A probe that does not answer, or a transcode that does
 * not finish, leaves the ad exactly as it was: the spot may not render on Chrome, but
 * the viewer's video is untouched, which is the trade this whole path is built on.
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileP = promisify(execFile);

const {
  AD_BURN_CACHE_DIR, AD_BURN_TIMEOUT_MS, AD_AUDIO_NORMALISE, AD_GAIN_DB, AD_LANDSCAPE_ON_PORTRAIT,
} = require('../utils/config');

const AD_CONFORM = AD_AUDIO_NORMALISE;
const PROBE_TIMEOUT_MS = AD_BURN_TIMEOUT_MS || 30000;
// A real encode of an 8 second spot, so it gets more room than a probe does.
const CONFORM_TIMEOUT_MS = Math.max(PROBE_TIMEOUT_MS, 120000);
const { getDb } = require('../utils/db');

const CACHE_DIR = AD_BURN_CACHE_DIR || path.join(os.tmpdir(), '3speak-ad-burn');
const PROBES = 'ad_media_probe';

// Probing costs a round trip to the CDN, so the answer is kept both in this process
// and in Mongo — the second because a restart should not re-probe the whole library.
const memo = new Map();

const keyOf = (url) => crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 16);

async function ensureDir() {
  await fsp.mkdir(CACHE_DIR, { recursive: true });
}

/**
 * Everything about a stream that has to match at the join, or null if unreadable.
 *
 * ffprobe is pointed at the URL directly rather than at bytes fetched here: it reads a
 * master playlist, picks a variant and stops once it has the stream headers, which is
 * far less than downloading a segment to inspect it.
 */
async function probeShape(url) {

  const key = keyOf(url);
  try {
    const hit = await getDb().collection(PROBES).findOne({ _id: key });
    if (hit && hit.shape !== undefined) {
      memo.set(url, hit.shape);
      return hit.shape;
    }
  } catch (_) { /* the probe below is the fallback */ }

  let shape = null;
  try {
    const { stdout } = await execFileP('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,profile,level,width,height,sample_rate',
      '-of', 'json',
      url,
    ], { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1 << 20 });
    const streams = (JSON.parse(stdout).streams || []);
    const v = streams.find((x) => x.codec_type === 'video');
    const a = streams.find((x) => x.codec_type === 'audio');
    if (v || a) {
      shape = {
        profile: v && v.profile ? String(v.profile).toLowerCase() : null,
        // ffprobe reports H.264 levels as an integer: 32 is 3.2, 50 is 5.0.
        level: v && Number.isFinite(v.level) ? v.level : null,
        width: v && v.width ? v.width : null,
        height: v && v.height ? v.height : null,
        sampleRate: a && a.sample_rate ? parseInt(a.sample_rate, 10) : null,
      };
    }
  } catch (_) {
    shape = null;
  }

  memo.set(url, shape);
  // Cached even when null: a URL ffprobe cannot read should not be re-probed on every
  // playback.
  getDb().collection(PROBES)
    .updateOne({ _id: key }, { $set: { url, shape, at: new Date() } }, { upsert: true })
    .catch(() => { /* the in-process memo still holds it */ });
  return shape;
}

// Probes in flight by url, so the playlist's background probe and a segment that has
// to wait for it share one ffprobe instead of starting a second.
const probing = new Map();

async function profileOf(url) {
  if (!url) return null;
  if (memo.has(url)) return memo.get(url);
  if (probing.has(url)) return probing.get(url);
  const job = probeShape(url).finally(() => probing.delete(url));
  probing.set(url, job);
  return job;
}

/** The shape, waiting at most `ms` for a probe; `undefined` if none answered in time. */
async function shapeWithin(url, ms) {
  let timer = null;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), ms); });
  try {
    return await Promise.race([profileOf(url).catch(() => null), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Do these two need conforming before they can share a SourceBuffer?
 *
 * Only the things that end up in the codec string or the audio configuration. Frame
 * rate and bitrate are deliberately not here: players handle those changing mid-buffer,
 * and re-encoding for them would be work nobody can see.
 */
function differs(content, spot) {
  if (!content || !spot) return false;
  return content.profile !== spot.profile
    || content.level !== spot.level
    || content.width !== spot.width
    || content.height !== spot.height
    || content.sampleRate !== spot.sampleRate;
}

/** The cached shape only. `undefined` when nothing has probed this yet. */
function knownRate(url) {
  return memo.has(url) ? memo.get(url) : undefined;
}

/** Probe without making anyone wait for it. */
function warmRate(url) {
  if (!url || memo.has(url)) return;
  profileOf(url).catch(() => { /* it will be tried again next time */ });
}

/* H.264 level limits (Table A-1): max frame size in macroblocks, and macroblocks per
 * second. Keyed by ffprobe's integer level. */
const LEVEL_LIMITS = {
  10: { fs: 99, mbps: 1485 }, 11: { fs: 396, mbps: 3000 }, 12: { fs: 396, mbps: 6000 },
  13: { fs: 396, mbps: 11880 }, 20: { fs: 396, mbps: 11880 }, 21: { fs: 792, mbps: 19800 },
  22: { fs: 1620, mbps: 20250 }, 30: { fs: 1620, mbps: 40500 }, 31: { fs: 3600, mbps: 108000 },
  32: { fs: 5120, mbps: 216000 }, 40: { fs: 8192, mbps: 245760 }, 41: { fs: 8192, mbps: 245760 },
  42: { fs: 8704, mbps: 522240 }, 50: { fs: 22080, mbps: 589824 }, 51: { fs: 36864, mbps: 983040 },
  52: { fs: 36864, mbps: 2073600 },
};

/** Is the landscape-on-portrait encode on for this viewer? See AD_LANDSCAPE_ON_PORTRAIT. */
function landscapeAllowedFor(viewer) {
  if (!AD_LANDSCAPE_ON_PORTRAIT) return false;
  if (AD_LANDSCAPE_ON_PORTRAIT === 'all') return true;
  const v = String(viewer || '').toLowerCase();
  return !!v && AD_LANDSCAPE_ON_PORTRAIT.split(',').map((s) => s.trim()).includes(v);
}

/**
 * The shape a LANDSCAPE spot is encoded at when it goes into a PORTRAIT video, or null
 * when that does not apply.
 *
 * Letterboxing it into the video's own frame is what made it a postage stamp: the
 * player shows a portrait video pillarboxed in a 16:9 box, and the spot was then
 * letterboxed again inside that pillar (a 268x480 video gave the spot 268x151 pixels
 * of picture). Encoded landscape, it fills the box like any landscape video.
 *
 * The join still carries no codec change: profile, level and audio rate are the
 * video's, and only the resolution differs, which is what every quality switch in an
 * HLS ladder already does inside one SourceBuffer. The size is the video's long side
 * as the height (a "480p" portrait video gets a 480p landscape spot), never taller
 * than the creative, and shrunk until it fits the video's level, so the stream never
 * claims a level it exceeds.
 */
function landscapeTarget(content, spot) {
  if (!content || !spot) return null;
  const { width: cw, height: ch } = content;
  const { width: sw, height: sh } = spot;
  if (!(cw > 0 && ch > 0 && sw > 0 && sh > 0)) return null;
  if (ch <= cw || sw <= sh) return null;
  const aspect = sw / sh;
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const lim = LEVEL_LIMITS[content.level];
  const fits = (w, h) => {
    // Level unknown: no more pixels than the video itself has, which its level allowed.
    if (!lim) return w * h <= cw * ch;
    const mbW = Math.ceil(w / 16);
    const mbH = Math.ceil(h / 16);
    const maxDim = Math.sqrt(8 * lim.fs);
    // 30 fps assumed for the rate limit, which is what the creatives are made at.
    return mbW * mbH <= lim.fs && mbW <= maxDim && mbH <= maxDim && mbW * mbH * 30 <= lim.mbps;
  };
  let h = Math.min(ch, sh);
  while (h > 64 && !fits(even(h * aspect), even(h))) h -= 8;
  if (!fits(even(h * aspect), even(h))) return null;
  return { ...content, width: even(h * aspect), height: even(h) };
}

/**
 * What this spot is re-encoded to before it is served, or null to serve it untouched.
 *
 * - a portrait video and a landscape spot, for a viewer it is on for: landscapeTarget()
 * - any other shape mismatch: the video's exact shape, letterboxed, as before
 * - shapes that match, or are not probed yet: the audio only, for the gain, with the
 *   video copied through (`gainOnly`), so the spot is equally quiet on every playback
 */
function targetFor(content, spot, { viewer } = {}) {
  if (!AD_CONFORM) return null;
  const wide = landscapeAllowedFor(viewer) ? landscapeTarget(content, spot) : null;
  if (wide) return wide;
  if (differs(content, spot)) return content;
  return AD_GAIN_DB ? { gainOnly: true } : null;
}

/** ffprobe's integer level to the string x264 wants: 32 -> "3.2", 50 -> "5.0". */
function levelArg(level) {
  if (!Number.isFinite(level) || level <= 0) return null;
  return (Math.floor(level / 10) + '.' + (level % 10));
}

// Encodes in flight by cache key. The playlist warms a spot's segments in the
// background while the player may already be asking for the first of them; both must
// share one ffmpeg, or the two would write the same temp file over each other.
const inflight = new Map();

/**
 * A copy of one spot segment encoded to the content's shape, or null if that failed.
 *
 * 🚨 This is a real video encode, not a remux, and it has to be: the level lives in the
 * SPS, so nothing short of re-encoding can change it honestly. Rewriting the level byte
 * with a bitstream filter would be cheaper and would be a lie — a 1080x1920 stream
 * labelled level 3.2 exceeds what that level permits, and a decoder is entitled to
 * refuse it, which is the failure we are here to fix.
 *
 * Letterboxed, never cropped: the creative is scaled to fit inside the content's frame
 * and centred on it, so a portrait spot in a landscape video shows whole rather than
 * having its sides cut off.
 */
async function conformedSegment(segmentUrl, target) {
  if (!AD_CONFORM || !segmentUrl || !target) return null;
  const gainOnly = target.gainOnly === true;
  const { width, height, profile, level, sampleRate } = target;
  if (!gainOnly && !(width > 0 && height > 0)) return null;
  if (gainOnly && !AD_GAIN_DB) return null;
  await ensureDir();

  const lvl = levelArg(level);
  // ffprobe reports Constrained Baseline as "constrained baseline", so taking the
  // FIRST word gave "constrained" — not an x264 profile name. libx264 then refuses to
  // open the encoder ("invalid profile: constrained") and EVERY conform for such a
  // source fails. Match the meaningful token instead, as adBurner.js already does.
  // High 10 / 4:2:2 / 4:4:4 collapse to plain "high", which is honest: -pix_fmt
  // yuv420p below already takes the output down to 8-bit 4:2:0.
  const prof = !profile ? 'high'
    : profile.includes('baseline') ? 'baseline'
    : profile.includes('high') ? 'high'
    : profile.includes('main') ? 'main'
    : 'high';
  // The gain is part of the key, so changing AD_GAIN_DB re-encodes instead of serving
  // spots at the old level; at 0 the keys are the ones written before it existed.
  const gainKey = AD_GAIN_DB ? `-g${AD_GAIN_DB}` : '';
  const key = gainOnly
    ? `cg-${keyOf(segmentUrl)}${gainKey}`
    : `cf-${keyOf(segmentUrl)}-${width}x${height}-${prof}-${lvl || 'auto'}-${sampleRate || 'na'}${gainKey}`;
  const out = path.join(CACHE_DIR, `${key}.ts`);
  try {
    const st = await fsp.stat(out);
    if (st.size > 0) return out;
  } catch (_) { /* not encoded yet */ }
  if (inflight.has(key)) return inflight.get(key);

  const tmp = path.join(CACHE_DIR, `.${key}.tmp.ts`);
  const gain = AD_GAIN_DB ? ['-af', `volume=${AD_GAIN_DB}dB`] : [];
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', segmentUrl];
  if (gainOnly) {
    // Nothing about the shape needs changing, so the picture is copied through and
    // only the audio is re-encoded, at its own rate and channel count.
    args.push('-c:v', 'copy', ...gain, '-c:a', 'aac', '-b:a', '128k');
  } else {
    args.push(
      '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,`
        + `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
      '-c:v', 'libx264', '-profile:v', prof, '-pix_fmt', 'yuv420p',
      '-preset', 'veryfast', '-crf', '23',
    );
    if (lvl) args.push('-level:v', lvl);
    args.push(
      ...gain,
      '-c:a', 'aac', '-ac', '2', '-b:a', '128k',
      ...(sampleRate > 0 ? ['-ar', String(sampleRate)] : []),
    );
  }
  args.push(
    // Keep the original timestamps. The stitched playlist declares this segment's
    // length from the creative's own manifest, and re-basing the clock here would put
    // the declared and real durations even further apart than they already are.
    '-copyts', '-muxdelay', '0', '-muxpreload', '0',
    '-f', 'mpegts', tmp,
  );

  const job = (async () => {
    try {
      await execFileP('ffmpeg', args, { timeout: CONFORM_TIMEOUT_MS, maxBuffer: 1 << 20 });
      const st = await fsp.stat(tmp);
      if (!st.size) throw new Error('ffmpeg produced nothing');
      await fsp.rename(tmp, out);
      return out;
    } catch (err) {
      console.error('[ad-conform] encode failed:', err && err.message);
      await fsp.unlink(tmp).catch(() => {});
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, job);
  return job;
}

module.exports = {
  profileOf, shapeWithin, knownShape: knownRate, warmShape: warmRate, differs, targetFor, landscapeTarget,
  conformedSegment, conformOn: AD_CONFORM,
};
