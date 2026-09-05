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
const crypto = require('crypto');
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
  /* ⚠️ `-output_ts_offset` is not decoration. A real HLS segment carries the
   * timestamps of its position in the video, and the burn preserves them, so a
   * segment that starts at zero is the ONE case that hides a whole class of bug: the
   * banner is overlaid by timestamp, and a banner clock starting at 0 against a
   * segment clock starting at 31s makes every banner frame look overdue. Overlay then
   * races through the entire banner in the first seconds and freezes on its last
   * frame. Tested against a zero-based segment that looks perfect. */
  await execFileP('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=6',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-output_ts_offset', '31.8', '-f', 'mpegts', content]);
  await execFileP('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x60:rate=25:duration=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    // moov at the FRONT. The throwaway server below answers no Range requests, so
    // ffmpeg cannot seek back for an index written at the end of the file.
    '-movflags', '+faststart', banner]);
  /* A banner LONGER than the segment it is painted onto, which is the shape every real
   * booking has and the only one that exposes a timestamp misalignment: overlay pairs
   * by timestamp, so a banner whose clock starts behind the segment's is consumed all
   * at once and the tail of the segment holds its final frame. A banner shorter than
   * the segment finishes early anyway and hides it. */
  const longBanner = path.join(dir, 'banner-long.mp4');
  await execFileP('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x60:rate=25:duration=12',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', longBanner]);

  const server = http.createServer((req, res) => {
    const f = req.url === '/banner.mp4' ? banner
      : (req.url === '/banner-long.mp4' ? longBanner : content);
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

    console.log('\n-- played once: a banner shorter than the segment does not truncate it --');
    /* The banner here is 3s and the content 6s, which is the shape that breaks if the
     * overlay is told to end with its shortest input: the output would stop when the
     * banner ran out and the viewer would lose half their video. */
    const short = await burnSegment({ segmentUrl: `${base}/content.ts`, videoUrl: `${base}/banner.mp4`, offsetSeconds: 0 });
    check('a banner shorter than the segment still burns', !!short, true);
    check('  and the viewer keeps the WHOLE segment',
      Math.abs((await durationOf(short)) - srcDur) < 0.5, true);

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

    console.log('\n-- the banner stops when the booking does, not when the segment does --');
    // 6s of content carrying a banner booked for only 2 of them: the first frame must
    // have it and a frame after 2s must not, or a 20s booking runs for 24.
    const cut = await burnSegment({
      segmentUrl: `${base}/content.ts`, videoUrl: `${base}/banner.mp4`,
      offsetSeconds: 0, visibleSeconds: 2,
    });
    check('a partly-covered segment burns', !!cut, true);
    /* Compared against a SECOND burn rather than against the source.
     *
     * The burn re-encodes, so a frame carrying no banner is still not byte-identical
     * to the same frame of the original file, and comparing the two proves nothing.
     * Two burns of the same segment at different banner PHASES go through an identical
     * encoder path, so any difference between them is the banner and nothing else:
     * early frames must differ (different phase) and late ones must match (no banner
     * in either, because the booked window has closed). */
    const cutB = await burnSegment({
      segmentUrl: `${base}/content.ts`, videoUrl: `${base}/banner.mp4`,
      offsetSeconds: 1.5, visibleSeconds: 2,
    });
    /* Measured with PSNR, not by comparing bytes.
     *
     * Two burns differ slightly EVERYWHERE, even where the picture is the same: the
     * banner earlier in the segment changes what the encoder does with the rest of the
     * GOP, so identical-looking frames decode to slightly different pixels. A byte
     * comparison therefore says "different" for every frame and proves nothing. PSNR
     * separates the two cases cleanly: a visible banner lands around 29 dB, encoder
     * noise alone around 48. */
    const psnr = async (range) => {
      const { stderr } = await execFileP('ffmpeg', ['-hide_banner', '-i', cut, '-i', cutB,
        '-lavfi', `[0:v]trim=${range},setpts=PTS-STARTPTS[a];[1:v]trim=${range},setpts=PTS-STARTPTS[b];[a][b]psnr`,
        '-f', 'null', '-'], { maxBuffer: 1 << 22 });
      const m = String(stderr).match(/average:([0-9.]+|inf)/);
      return m ? (m[1] === 'inf' ? 99 : Number(m[1])) : null;
    };
    const early = await psnr('end_frame=40');
    const late = await psnr('start_frame=120');
    console.log(`        early ${early && early.toFixed(1)} dB, late ${late && late.toFixed(1)} dB`);
    check('  the banner IS there at the start, and differs by phase', early < 40, true);
    check('  and is GONE once the booked seconds are up', late > 40, true);
    check('a window of zero burns nothing at all',
      await burnSegment({ segmentUrl: `${base}/content.ts`, videoUrl: `${base}/banner.mp4`, visibleSeconds: 0 }), null);

    console.log('\n-- the banner PLAYS for the whole time it is on screen --');
    /* The regression that shipped: everything above passed while the banner raced
     * through its whole length in the first seconds of the segment and then held its
     * last frame. Sampling only the opening frames cannot see it, so this walks the
     * banner region across the segment and requires every sample to differ. */
    /* Where the strip actually lands, derived the same way adBurner does it rather
     * than eyeballed: box is 60% x 15% of the frame, the 320x60 banner fits inside it,
     * and it sits centred above a 6% margin. A crop guessed a little off samples a
     * static corner of testsrc and passes no matter what the banner does. */
    const bannerRegion = 'crop=288:54:176:284';   // 640x360 frame, see adBurner geometry
    const regionAt = async (f, n, out) => {
      await execFileP('ffmpeg', ['-v', 'error', '-y', '-i', f,
        '-vf', `select=gte(n\\,${n}),${bannerRegion}`, '-frames:v', '1', '-update', '1', out]);
      // ⚠️ Hash the WHOLE file. The first bytes of a PNG are the signature and the
      // IHDR, identical for every image of the same size, so a prefix comparison finds
      // four "identical" frames however different the pictures are.
      return crypto.createHash('md5').update(await fsp.readFile(out)).digest('hex');
    };
    const moving = await burnSegment({
      segmentUrl: `${base}/content.ts`, videoUrl: `${base}/banner-long.mp4`, offsetSeconds: 0,
    });
    const samples = [];
    for (const n of [0, 40, 80, 120, 145]) samples.push(await regionAt(moving, n, path.join(dir, `m${n}.png`)));
    check('the banner region changes at every sample across the segment',
      new Set(samples).size, samples.length);

    /* 🚨 THE ONE THAT CATCHES A TIMESTAMP MISALIGNMENT.
     *
     * Motion alone is not enough: a banner played at the wrong rate still moves at
     * every sample. What proves the seek is doing anything is that two burns starting
     * at DIFFERENT points in the banner look different.
     *
     * When the banner's clock is not moved onto the segment's, overlay pairs frames by
     * timestamp, finds every banner frame overdue, and consumes them from the top
     * regardless of where -ss started. Both burns then open on the same banner frame,
     * and this measured a flat 99 dB between them: pixel-identical. With the clocks
     * aligned they land around 33 dB, which is two different pictures.
     */
    const nextSeg = await burnSegment({
      segmentUrl: `${base}/content.ts`, videoUrl: `${base}/banner-long.mp4`, offsetSeconds: 6,
    });
    const cropPsnr = async (fileA, nA, fileB, nB) => {
      const { stderr } = await execFileP('ffmpeg', ['-hide_banner', '-i', fileA, '-i', fileB,
        // `trim`, not `select`: a select expression contains a comma, which the
        // filtergraph parser reads as the end of the filter, and the escaping needed
        // does not survive a JS template literal intact.
        '-lavfi', `[0:v]trim=start_frame=${nA},${bannerRegion},setpts=N/TB[a];`
          + `[1:v]trim=start_frame=${nB},${bannerRegion},setpts=N/TB[b];[a][b]psnr`,
        '-frames:v', '1', '-f', 'null', '-'], { maxBuffer: 1 << 22 });
      const m = String(stderr).match(/average:([0-9.]+|inf)/);
      return m ? (m[1] === 'inf' ? 99 : Number(m[1])) : null;
    };
    const seekWorks = await cropPsnr(moving, 0, nextSeg, 0);
    console.log(`        two burns 6s apart in the banner: ${seekWorks && seekWorks.toFixed(1)} dB apart`);
    check('starting 6s into the banner shows a DIFFERENT picture', seekWorks < 45, true);

    console.log('\n-- a banner shorter than its booking STOPS, it does not restart --');
    /* 🚨 The regression this exists for. Removing -stream_loop is not enough: the seek
     * was taken modulo the banner's length, so a segment past the end wrapped back to
     * the beginning and played it again. That is a loop with the flag removed.
     *
     * The banner here is 3s. A segment seeking 4s in has nothing left, so it must not
     * be burned at all, and the viewer sees plain video rather than the ad a second
     * time. */
    const past = await burnSegment({
      segmentUrl: `${base}/content.ts`, videoUrl: `${base}/banner.mp4`, offsetSeconds: 4,
    });
    check('a segment past the end of the banner is NOT burned', past, null);
    const atEnd = await burnSegment({
      segmentUrl: `${base}/content.ts`, videoUrl: `${base}/banner.mp4`, offsetSeconds: 2.5,
    });
    check('  one that still has footage left IS burned', !!atEnd, true);
    check('  and it keeps the whole segment', Math.abs((await durationOf(atEnd)) - srcDur) < 0.5, true);

    console.log('\n-- the banner is silent --');
    const { stdout: aud } = await execFileP('ffprobe', ['-v', 'error', '-select_streams', 'a',
      '-show_entries', 'stream=codec_type', '-of', 'json', cut]);
    // The content here has no audio either, so this asserts the banner did not ADD one.
    check('no audio stream comes from the banner', (JSON.parse(aud).streams || []).length, 0);

    console.log('\n-- nothing to burn is not a crash --');
    check('no image and no video returns null', await burnSegment({ segmentUrl: `${base}/content.ts` }), null);
  } finally {
    server.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }

  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
