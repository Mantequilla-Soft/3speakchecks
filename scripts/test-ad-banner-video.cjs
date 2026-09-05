#!/usr/bin/env node
/**
 * A VIDEO banner is looped into the frame, and each segment picks it up where the
 * last one left off.
 *
 *   node scripts/test-ad-banner-video.cjs
 *
 * The burn had never been exercised with motion, and the failure it invites is
 * specific and silent: burn every segment from the banner's frame 0 and the viewer
 * sees the first second of the ad restarting on every segment boundary, which looks
 * like a stutter rather than like a bug. So this asserts the PHASE advances, by
 * extracting a frame from each burned segment and requiring them to differ.
 *
 * Builds its own inputs with ffmpeg and serves them over a throwaway HTTP server, so
 * it needs no campaign, no database and no network.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

let failed = 0;
const check = (l, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${l}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bannertest-'));
process.env.AD_BURN_CACHE_DIR = path.join(dir, 'cache');

const durationOf = async (f) => {
  const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', f]);
  return Number(JSON.parse(stdout).format.duration) || 0;
};

/** The first frame as a PNG, so two segments can be compared by their bytes.
 *
 * ⚠️ No `-ss`. The burn preserves timestamps (`-copyts`), so a burned segment's clock
 * starts at its real position in the video rather than at zero, and an input seek of
 * 0.2s can land past every frame it has. ffmpeg then exits 0 having written nothing,
 * which reads as a missing file rather than as a bad seek. The first frame is what
 * this wants anyway: it is where the banner phase is most visible. */
const frameAt = async (f, _t, out) => {
  await execFileP('ffmpeg', ['-v', 'error', '-y', '-i', f, '-frames:v', '1', '-update', '1', out]);
  return fsp.readFile(out);
};

(async () => {
  // 6 seconds of content, and a 3-second banner whose picture changes every second
  // so a phase shift is visible in a single frame.
  const content = path.join(dir, 'content.ts');
  const banner = path.join(dir, 'banner.mp4');
  await execFileP('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=6',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-f', 'mpegts', content]);
  await execFileP('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x60:rate=25:duration=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', banner]);

  const server = http.createServer((req, res) => {
    const f = req.url === '/banner.mp4' ? banner : content;
    const body = fs.readFileSync(f);
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': body.length });
    res.end(body);
  }).listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const { burnSegment } = require('../services/adBurner');
  try {
    console.log('-- a moving banner burns, and keeps the segment intact --');
    const a = await burnSegment({ segmentUrl: `${base}/content.ts`, videoUrl: `${base}/banner.mp4`, offsetSeconds: 0 });
    check('segment 0 burned', !!a, true);
    if (!a) throw new Error('nothing to compare');
    const srcDur = await durationOf(content);
    const outDur = await durationOf(a);
    // The whole point of shortest=1: without it this runs to the ffmpeg timeout,
    // with a still's settings it would truncate to a single frame.
    check('  output is the length of the CONTENT, not of the banner',
      Math.abs(outDur - srcDur) < 0.5, true);
    check('  and not truncated to a frame', outDur > 1, true);

    console.log('\n-- the banner advances with the segment, it does not restart --');
    const b = await burnSegment({ segmentUrl: `${base}/content.ts`, videoUrl: `${base}/banner.mp4`, offsetSeconds: 1.5 });
    check('a later segment burns too', !!b, true);
    const f0 = await frameAt(a, 0.2, path.join(dir, 'a.png'));
    const f1 = await frameAt(b, 0.2, path.join(dir, 'b.png'));
    check('  the same instant shows a DIFFERENT banner frame', f0.equals(f1), false);

    console.log('\n-- looping: an offset past the banner wraps rather than running dry --');
    // 4s into a 3s banner is 1s in. Same phase as offset 1, so the picture must match.
    const wrapped = await burnSegment({ segmentUrl: `${base}/content.ts`, videoUrl: `${base}/banner.mp4`, offsetSeconds: 4 });
    const atOne = await burnSegment({ segmentUrl: `${base}/content.ts`, videoUrl: `${base}/banner.mp4`, offsetSeconds: 1 });
    check('a wrapped offset still produces a segment', !!wrapped, true);
    const fw = await frameAt(wrapped, 0.2, path.join(dir, 'w.png'));
    const fo = await frameAt(atOne, 0.2, path.join(dir, 'o.png'));
    check('  4s into a 3s banner looks exactly like 1s in', fw.equals(fo), true);

    console.log('\n-- the still path still works --');
    const png = path.join(dir, 'still.png');
    await execFileP('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:size=320x60:d=1', '-frames:v', '1', png]);
    server.on('request', () => {});
    const stillServer = http.createServer((req, res) => {
      const body = fs.readFileSync(req.url === '/still.png' ? png : content);
      res.writeHead(200, { 'Content-Length': body.length });
      res.end(body);
    }).listen(0);
    const sBase = `http://127.0.0.1:${stillServer.address().port}`;
    const still = await burnSegment({ segmentUrl: `${sBase}/content.ts`, imageUrl: `${sBase}/still.png` });
    check('an image banner burns', !!still, true);
    check('  and keeps the full segment', Math.abs((await durationOf(still)) - srcDur) < 0.5, true);
    stillServer.close();

    console.log('\n-- nothing to burn is not a crash --');
    check('no image and no video returns null', await burnSegment({ segmentUrl: `${base}/content.ts` }), null);
  } finally {
    server.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }

  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
