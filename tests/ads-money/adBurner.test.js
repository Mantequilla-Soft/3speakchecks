/**
 * Banner burn-in (services/adBurner.js): an advertiser's banner composited into a
 * content segment's own pixels, cached on disk and produced once per
 * (segment, creative, phase, visible window, position).
 *
 * ffmpeg and ffprobe are replaced by a fake child_process that answers probes from
 * the file name and "encodes" by writing bytes to the output path; downloads are a
 * stubbed fetch. The cache lives in a throwaway temp directory. What is asserted is
 * the orchestration and the numbers handed to ffmpeg: geometry, timing, codec
 * parameters, caching, single flight, failure handling and cache eviction.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-burn-test-'));
process.env.AD_BURN_CACHE_DIR = CACHE;
process.env.AD_BURN_CACHE_MAX_MB = '1';

jest.mock('child_process', () => ({ ...jest.requireActual('child_process'), execFile: jest.fn() }));

const { execFile } = require('child_process');
const B = require('../../services/adBurner');

const SEGMENT = 'https://ipfs-3speak.b-cdn.net/ipfs/QmVideo/720p/seg-5.ts';
const IMAGE = 'https://images.example.com/banner.png';
const VIDEO = 'https://ipfs-3speak.b-cdn.net/ipfs/QmBanner/manifest.m3u8';

// What ffprobe reports, by the kind of file it is asked about.
let probes;
let outputBytes;
let ffmpegFails;
const defaultProbes = () => ({
  segment: { width: 1280, height: 720, r_frame_rate: '24/1', profile: 'High', pix_fmt: 'yuv420p', duration: '6.000', start_time: '31.800' },
  image: { width: 728, height: 90 },
  bannerSource: { width: 400, height: 100, duration: '10.000' },
});
const kindOf = (file) => {
  if (file.includes('.src.ts')) return 'segment';
  if (file.endsWith('.img')) return 'image';
  return 'bannerSource';
};
const ffmpegCalls = () => execFile.mock.calls.filter(([cmd]) => cmd === 'ffmpeg').map(([, args]) => args);
const burns = () => ffmpegCalls().filter((args) => args.includes('-filter_complex'));
const filterOf = (args) => args[args.indexOf('-filter_complex') + 1];
const argAfter = (args, flag) => args[args.indexOf(flag) + 1];

beforeEach(() => {
  for (const f of fs.readdirSync(CACHE)) fs.rmSync(path.join(CACHE, f), { force: true });
  probes = defaultProbes();
  outputBytes = 1000;
  ffmpegFails = false;
  execFile.mockReset();
  execFile.mockImplementation((cmd, args, _opts, cb) => {
    if (cmd === 'ffprobe') {
      const p = probes[kindOf(args[args.length - 1])];
      const { duration, ...stream } = p;
      return cb(null, { stdout: JSON.stringify({ streams: [{ ...stream, duration }], format: {} }) });
    }
    if (ffmpegFails) return cb(new Error('ffmpeg exploded'));
    fs.writeFileSync(args[args.length - 1], Buffer.alloc(outputBytes));
    return cb(null, { stdout: '' });
  });
  jest.spyOn(global, 'fetch').mockImplementation(async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }));
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => fs.rmSync(CACHE, { recursive: true, force: true }));

/** Wait for a condition that a fire-and-forget step (the cache sweep) will make true. */
async function until(cond) {
  for (let i = 0; i < 500 && !cond(); i += 1) await new Promise((r) => setImmediate(r));
  return cond();
}

describe('the cache key', () => {
  const base = { segmentUrl: SEGMENT, imageUrl: IMAGE };

  test('the same inputs always give the same key, which is the cache file name', () => {
    expect(B.keyFor(base)).toBe(B.keyFor({ ...base }));
    expect(B.keyFor(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  test.each([
    ['another segment', { segmentUrl: `${SEGMENT}?v=2` }],
    ['another creative', { imageUrl: `${IMAGE}?v=2` }],
    ['another position', { position: 'top' }],
    ['a partly visible segment', { visibleSeconds: 2.5 }],
  ])('%s gives another key', (_label, change) => {
    expect(B.keyFor({ ...base, ...change })).not.toBe(B.keyFor(base));
  });

  test('a still looks the same wherever its run lands, so its offset is not part of the key', () => {
    expect(B.keyFor({ ...base, offsetSeconds: 6 })).toBe(B.keyFor(base));
  });

  test('a moving banner IS keyed on its offset, to the millisecond', () => {
    const video = { segmentUrl: SEGMENT, videoUrl: VIDEO };
    expect(B.keyFor({ ...video, offsetSeconds: 6 })).not.toBe(B.keyFor({ ...video, offsetSeconds: 12 }));
    expect(B.keyFor({ ...video, offsetSeconds: 6.0001 })).toBe(B.keyFor({ ...video, offsetSeconds: 6 }));
  });

  test('the default position is bottom', () => {
    expect(B.keyFor({ ...base, position: 'bottom' })).toBe(B.keyFor(base));
  });
});

describe('burning a still banner', () => {
  test('downloads both, mirrors the segment\'s codec and clock, and caches the result under its key', async () => {
    const out = await B.burnSegment({ segmentUrl: SEGMENT, imageUrl: IMAGE });

    expect(out).toBe(path.join(CACHE, `${B.keyFor({ segmentUrl: SEGMENT, imageUrl: IMAGE })}.ts`));
    expect(fs.statSync(out).size).toBe(1000);
    expect(fetch.mock.calls.map(([url]) => url).sort()).toEqual([IMAGE, SEGMENT].sort());
    const [args] = burns();
    expect(args.slice(0, 5)).toEqual(['-v', 'error', '-y', '-copyts', '-i']);
    expect(argAfter(args, '-pix_fmt')).toBe('yuv420p');
    expect(argAfter(args, '-profile:v')).toBe('high');
    // An ABSOLUTE end on the segment's own clock: 31.8s in, 6s long.
    expect(argAfter(args, '-to')).toBe('37.800');
    expect(argAfter(args, '-f')).toBe('mpegts');
    // Nothing temporary is left behind.
    expect(fs.readdirSync(CACHE).filter((f) => f.startsWith('.'))).toEqual([]);
  });

  test('a 728x90 strip on a 1280x720 frame: 60% wide, centred, above the bottom margin, labelled "Ad"', async () => {
    await B.burnSegment({ segmentUrl: SEGMENT, imageUrl: IMAGE });
    const graph = filterOf(burns()[0]);
    expect(graph).toContain('[1:v]scale=768:94,setpts=PTS-STARTPTS,trim=end=6.000,setpts=PTS+31.800/TB[bn]');
    expect(graph).toContain('[0:v][bn]overlay=256:583:format=auto[ov]');
    expect(graph).toContain(":text='Ad':");
    expect(graph).not.toContain('enable=');
  });

  test('a square logo is fitted into the banner box, small and centred, not 60% of the frame tall', async () => {
    probes.image = { width: 500, height: 500 };
    await B.burnSegment({ segmentUrl: SEGMENT, imageUrl: IMAGE });
    const graph = filterOf(burns()[0]);
    expect(graph).toContain('scale=108:108');
    expect(graph).toContain('overlay=586:569');
  });

  test('a segment only partly inside the booking shows the banner (and its label) for that part only', async () => {
    await B.burnSegment({ segmentUrl: SEGMENT, imageUrl: IMAGE, visibleSeconds: 2.5 });
    const graph = filterOf(burns()[0]);
    expect(graph.match(/enable='lt\(t-31\.800,2\.500\)'/g)).toHaveLength(2);
  });

  test.each([
    ['Constrained Baseline', 'baseline'],
    ['Main', 'main'],
    ['High 4:2:2', 'high'],
    ['', 'main'],
  ])('a %p source is re-encoded as %p so the join does not stall the player', async (profile, want) => {
    probes.segment.profile = profile;
    await B.burnSegment({ segmentUrl: SEGMENT, imageUrl: IMAGE });
    expect(argAfter(burns()[0], '-profile:v')).toBe(want);
  });

  test('a segment with no known length is bounded at 60 seconds rather than left open', async () => {
    probes.segment.duration = undefined;
    probes.segment.start_time = undefined;
    await B.burnSegment({ segmentUrl: SEGMENT, imageUrl: IMAGE });
    expect(argAfter(burns()[0], '-to')).toBe('60.000');
    expect(filterOf(burns()[0])).toContain('trim=end=60.000');
  });

  test('a cached burn is served again without downloading or encoding anything', async () => {
    const first = await B.burnSegment({ segmentUrl: SEGMENT, imageUrl: IMAGE });
    execFile.mockClear();
    fetch.mockClear();
    expect(await B.burnSegment({ segmentUrl: SEGMENT, imageUrl: IMAGE })).toBe(first);
    expect(execFile).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(B.cachedPath({ segmentUrl: SEGMENT, imageUrl: IMAGE })).toBe(first);
  });

  test('concurrent requests for one segment share a single burn', async () => {
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => B.burnSegment({ segmentUrl: SEGMENT, imageUrl: IMAGE })));
    expect(new Set([a, b, c]).size).toBe(1);
    expect(burns()).toHaveLength(1);
  });
});

describe('when a burn cannot be made the original segment is served instead (null)', () => {
  test.each([
    ['no banner at all', {}],
    ['nothing of this segment is inside the booking', { imageUrl: IMAGE, visibleSeconds: 0 }],
  ])('%s: nothing is downloaded or encoded', async (_label, extra) => {
    expect(await B.burnSegment({ segmentUrl: SEGMENT, ...extra })).toBeNull();
    expect(execFile).not.toHaveBeenCalled();
  });

  test.each([
    ['a download fails', () => { fetch.mockResolvedValue({ ok: false, status: 404 }); }],
    ['the segment cannot be probed', () => { probes.segment = { width: 0, height: 0 }; }],
    ['the banner cannot be probed', () => { probes.image = {}; }],
    ['ffmpeg fails', () => { ffmpegFails = true; }],
    ['ffmpeg produces an empty file', () => { outputBytes = 0; }],
  ])('%s', async (_label, arrange) => {
    arrange();
    expect(await B.burnSegment({ segmentUrl: SEGMENT, imageUrl: IMAGE })).toBeNull();
    expect(B.cachedPath({ segmentUrl: SEGMENT, imageUrl: IMAGE })).toBeNull();
    expect(console.error).toHaveBeenCalledWith('[ad-burn] failed:', expect.any(String));
    expect(await until(() => fs.readdirSync(CACHE).filter((f) => f.startsWith('.') && f.endsWith('.ts')).length === 0)).toBe(true);
  });
});

describe('burning a moving banner', () => {
  const video = (offsetSeconds, extra = {}) => B.burnSegment({ segmentUrl: SEGMENT, videoUrl: VIDEO, offsetSeconds, ...extra });
  const sourceEncodes = () => ffmpegCalls().filter((args) => args.includes('-an'));

  test('the banner video is flattened once, silent and no taller than the cap, then reused for every segment', async () => {
    await video(0);
    await video(6, { segmentUrl: `${SEGMENT}?n=2` });
    expect(sourceEncodes()).toHaveLength(1);
    const [src] = sourceEncodes();
    expect(src).toEqual(expect.arrayContaining(['-i', VIDEO, '-an', '-vf', "scale=-2:'min(240,ih)'"]));
    expect(burns()).toHaveLength(2);
  });

  test('each segment picks the banner up where the last one left it', async () => {
    await video(6);
    const args = burns()[0];
    expect(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 2)).toEqual(['-ss', '6.000']);
  });

  test('past the end of the banner there is nothing left to paint: the segment is served plain', async () => {
    expect(await video(10)).toBeNull();
    expect(burns()).toHaveLength(0);
  });

  test('a banner shorter than what is left of the booking stops when it runs out, never freezing', async () => {
    await video(7, { visibleSeconds: 6 });
    expect(filterOf(burns()[0])).toContain("enable='lt(t-31.800,3.000)'");
  });

  test('a banner video that cannot be fetched or encoded serves the segment plain', async () => {
    ffmpegFails = true;
    expect(await video(0)).toBeNull();
    expect(console.error).toHaveBeenCalledWith('[ad-burn] banner source failed:', 'ffmpeg exploded');
  });

  test('a banner source with no duration is refused', async () => {
    probes.bannerSource = { width: 400, height: 100, duration: '0' };
    expect(await video(0)).toBeNull();
    expect(console.error).toHaveBeenCalledWith('[ad-burn] banner source failed:', 'banner source has no duration');
  });
});

describe('the cache stays under its cap', () => {
  test('after a burn the coldest entries are evicted until the cache fits again', async () => {
    // Two cold 600 KB entries already fill more than the 1 MB cap.
    const cold = ['cold-1.ts', 'cold-2.ts'].map((n, i) => {
      const f = path.join(CACHE, n);
      fs.writeFileSync(f, Buffer.alloc(600 * 1024));
      const t = new Date(Date.UTC(2020, 0, 1 + i));
      fs.utimesSync(f, t, t);
      return f;
    });
    const out = await B.burnSegment({ segmentUrl: SEGMENT, imageUrl: IMAGE });
    expect(await until(() => !fs.existsSync(cold[0]))).toBe(true);
    // The coldest went first; that was enough, so the next one and the new burn stay.
    expect(fs.existsSync(cold[1])).toBe(true);
    expect(fs.existsSync(out)).toBe(true);
  });

  test('a cache under its cap is left alone', async () => {
    const keep = path.join(CACHE, 'small.ts');
    fs.writeFileSync(keep, Buffer.alloc(1024));
    const fsp = require('fs/promises');
    const stat = jest.spyOn(fsp, 'stat');
    const unlink = jest.spyOn(fsp, 'unlink');
    const out = await B.burnSegment({ segmentUrl: SEGMENT, imageUrl: IMAGE });
    // The sweep has measured the cache once it has stat'ed both entries (the new burn
    // a second time: the first was the cache check before burning) and those reads
    // have finished; whatever it decides follows in the same turn.
    const statsOf = (f) => stat.mock.calls.filter(([g]) => g === f).length;
    const measured = () => statsOf(keep) >= 1 && statsOf(out) >= 2;
    expect(await until(measured)).toBe(true);
    await Promise.allSettled(stat.mock.results.map((r) => r.value));
    await new Promise((r) => setImmediate(r));
    expect(unlink.mock.calls.map(([f]) => f)).not.toContain(keep);
    expect(fs.existsSync(keep)).toBe(true);
  });

  test('the cache directory is the configured one', () => {
    expect(B.CACHE_DIR).toBe(CACHE);
  });
});
