/**
 * services/adConform.js: re-encoding a spot to the shape of the video it is spliced
 * into, so the join carries no codec change. Shapes are probed once (memo + Mongo),
 * encodes are cached on disk and shared while in flight, and every failure is soft.
 * ffprobe and ffmpeg never run: child_process.execFile is a stand-in.
 */
const fs = require('fs');
const path = require('path');
const fx = require('./_fixtures');

jest.mock('child_process', () => require('./_fixtures').childProcessMock());
const env = fx.useAdEnv({ AD_AUDIO_NORMALISE: 'true', AD_GAIN_DB: '-2' });
const { execFile } = require('child_process');
const testDb = require('../helpers/db');
const conform = require('../../services/adConform');

const db = testDb.use();
fx.freezeTime();

const PROBES = 'ad_media_probe';
const shape720 = { profile: 'high', level: 32, width: 1280, height: 720, sampleRate: 48000 };
const portraitSpot = { profile: 'high', level: 50, width: 1080, height: 1920, sampleRate: 44100 };
const ffprobeJson = (s) => JSON.stringify({ streams: [
  { codec_type: 'video', profile: s.profile, level: s.level, width: s.width, height: s.height },
  { codec_type: 'audio', sample_rate: String(s.sampleRate) },
] });
/** ffprobe answers from a url -> shape map; ffmpeg writes the file it was asked for. */
function tools({ shapes = {}, ffmpeg = 'ok' } = {}) {
  execFile.setHandler(async (cmd, args) => {
    if (cmd === 'ffprobe') {
      const url = args[args.length - 1];
      if (shapes[url] === 'hang') return new Promise(() => {});
      if (!shapes[url]) throw new Error('Server returned 404');
      return ffprobeJson(shapes[url]);
    }
    if (cmd === 'ffmpeg') {
      if (ffmpeg === 'fail') throw new Error('Invalid data found when processing input');
      fs.writeFileSync(args[args.length - 1], ffmpeg === 'empty' ? '' : 'TS-BYTES');
      return '';
    }
    throw new Error(`unexpected ${cmd}`);
  });
}
const calls = (cmd) => execFile.calls.filter(([c]) => c === cmd);
const url = (tag) => `https://ipfs-3speak.b-cdn.net/ipfs/${tag}/manifest.m3u8`;

beforeEach(() => {
  execFile.reset();
  for (const f of fs.readdirSync(env.AD_BURN_CACHE_DIR)) fs.rmSync(path.join(env.AD_BURN_CACHE_DIR, f), { force: true });
});

describe('differs: what has to match at the join', () => {
  test.each([
    ['identical shapes', shape720, { ...shape720 }, false],
    ['a different level', shape720, { ...shape720, level: 31 }, true],
    ['a different audio rate', shape720, { ...shape720, sampleRate: 44100 }, true],
    ['a different size', shape720, { ...shape720, width: 854, height: 480 }, true],
    ['a different profile', shape720, { ...shape720, profile: 'main' }, true],
    ['one side unknown', shape720, null, false],
  ])('%s -> %p', (_label, a, b, want) => expect(conform.differs(a, b)).toBe(want));
});

describe('landscapeTarget: a landscape spot in a portrait video', () => {
  const portraitVideo = { profile: 'main', level: 30, width: 480, height: 854, sampleRate: 44100 };
  const wideSpot = { profile: 'high', level: 40, width: 1920, height: 1080, sampleRate: 48000 };

  test('is encoded landscape at the video\'s long side, inside the video\'s level', () => {
    const t = conform.landscapeTarget(portraitVideo, wideSpot);
    expect(t).toMatchObject({ profile: 'main', level: 30, sampleRate: 44100 });
    expect(t.width).toBeGreaterThan(t.height);
    expect(t.height).toBeLessThanOrEqual(854);
    expect(t.width % 2 + t.height % 2).toBe(0);
    // Level 3.0 allows 1620 macroblocks per frame.
    expect(Math.ceil(t.width / 16) * Math.ceil(t.height / 16)).toBeLessThanOrEqual(1620);
  });

  test('with an unknown level it never uses more pixels than the video has', () => {
    const t = conform.landscapeTarget({ ...portraitVideo, level: null }, wideSpot);
    expect(t.width * t.height).toBeLessThanOrEqual(480 * 854);
  });

  test.each([
    ['a landscape video', shape720, wideSpot],
    ['a portrait spot', portraitVideo, portraitSpot],
    ['unknown sizes', { ...portraitVideo, width: null }, wideSpot],
    ['no shapes', null, null],
  ])('does not apply to %s', (_label, c, s) => expect(conform.landscapeTarget(c, s)).toBeNull());

  test('gives up on a video too small to hold any landscape frame', () => {
    expect(conform.landscapeTarget({ ...portraitVideo, level: null, width: 10, height: 20 }, wideSpot)).toBeNull();
  });
});

describe('targetFor: what the spot is re-encoded to', () => {
  test('a shape mismatch takes the video\'s exact shape', () => {
    expect(conform.targetFor(shape720, portraitSpot)).toBe(shape720);
  });

  test('matching (or unknown) shapes still get the gain, with the picture copied', () => {
    expect(conform.targetFor(shape720, { ...shape720 })).toEqual({ gainOnly: true });
    expect(conform.targetFor(null, null)).toEqual({ gainOnly: true });
  });

  test('at 0 dB gain a matching spot is served untouched', () => {
    const mod = fx.loadIsolated('../../services/adConform', { env: { AD_GAIN_DB: '0' } });
    expect(mod.targetFor(shape720, { ...shape720 })).toBeNull();
  });

  test('with conforming switched off nothing is re-encoded', () => {
    const mod = fx.loadIsolated('../../services/adConform', { env: { AD_AUDIO_NORMALISE: 'false' } });
    expect(mod.conformOn).toBe(false);
    expect(mod.targetFor(shape720, portraitSpot)).toBeNull();
  });

  test.each([
    ['one listed viewer', 'alice,bob', 'bob', true],
    ['someone not listed', 'alice', 'carol', false],
    ['an anonymous viewer', 'alice', null, false],
    ['everyone', 'all', 'carol', true],
  ])('the landscape encode is on for %s', (_label, setting, viewer, wide) => {
    const mod = fx.loadIsolated('../../services/adConform', { env: { AD_LANDSCAPE_ON_PORTRAIT: setting } });
    const video = { profile: 'main', level: 31, width: 720, height: 1280, sampleRate: 48000 };
    const spot = { profile: 'high', level: 40, width: 1920, height: 1080, sampleRate: 48000 };
    const t = mod.targetFor(video, spot, { viewer });
    expect(t.width > t.height).toBe(wide);
  });
});

describe('profileOf: probing a stream once', () => {
  test('probes with ffprobe, remembers the answer in memory and in Mongo', async () => {
    const u = url('probe-a');
    tools({ shapes: { [u]: shape720 } });
    await expect(conform.profileOf(u)).resolves.toEqual(shape720);
    await expect(conform.profileOf(u)).resolves.toEqual(shape720);
    expect(calls('ffprobe')).toHaveLength(1);
    expect(conform.knownShape(u)).toEqual(shape720);
    // Stored without holding up the caller.
    expect(await fx.eventually(() => db().collection(PROBES).findOne({ url: u }))).toMatchObject({ shape: shape720 });
  });

  test('a restart reads the stored answer instead of probing again', async () => {
    const u = url('probe-b');
    await db().collection(PROBES).insertOne({ _id: require('crypto').createHash('sha1').update(u).digest('hex').slice(0, 16), url: u, shape: portraitSpot });
    tools();
    await expect(conform.profileOf(u)).resolves.toEqual(portraitSpot);
    expect(calls('ffprobe')).toHaveLength(0);
  });

  test('two callers at once share one probe', async () => {
    const u = url('probe-c');
    tools({ shapes: { [u]: shape720 } });
    await Promise.all([conform.profileOf(u), conform.profileOf(u)]);
    expect(calls('ffprobe')).toHaveLength(1);
  });

  test('an unreadable url is remembered as null, so it is not probed on every playback', async () => {
    const u = url('probe-d');
    tools();
    await expect(conform.profileOf(u)).resolves.toBeNull();
    await expect(conform.profileOf(u)).resolves.toBeNull();
    expect(calls('ffprobe')).toHaveLength(1);
  });

  test('audio-only and empty answers', async () => {
    const audioOnly = url('probe-e');
    const nothing = url('probe-f');
    execFile.setHandler(async (_cmd, args) => (args[args.length - 1] === audioOnly
      ? JSON.stringify({ streams: [{ codec_type: 'audio', sample_rate: '44100' }] })
      : JSON.stringify({ streams: [] })));
    await expect(conform.profileOf(audioOnly)).resolves.toEqual({ profile: null, level: null, width: null, height: null, sampleRate: 44100 });
    await expect(conform.profileOf(nothing)).resolves.toBeNull();
    await expect(conform.profileOf('')).resolves.toBeNull();
  });

  test('warmShape probes in the background, and knownShape is undefined until it has', async () => {
    const u = url('probe-g');
    tools({ shapes: { [u]: shape720 } });
    expect(conform.knownShape(u)).toBeUndefined();
    conform.warmShape(u);
    conform.warmShape('');
    await conform.profileOf(u);
    expect(conform.knownShape(u)).toEqual(shape720);
    conform.warmShape(u);
    expect(calls('ffprobe')).toHaveLength(1);
  });

  test('shapeWithin gives up on a probe that does not answer in time', async () => {
    const u = url('probe-h');
    tools({ shapes: { [u]: 'hang' } });
    await expect(conform.shapeWithin(u, 20)).resolves.toBeUndefined();
  });
});

describe('conformedSegment: the re-encoded copy of one spot segment', () => {
  const seg = (n) => `https://ipfs-3speak.b-cdn.net/ipfs/QmSpot/480p/${n}.ts`;
  const args = () => calls('ffmpeg')[0][1].join(' ');

  test('re-encodes to the video\'s profile, level, size and audio rate, letterboxed', async () => {
    tools();
    const out = await conform.conformedSegment(seg('full'), shape720);
    expect(fs.readFileSync(out, 'utf8')).toBe('TS-BYTES');
    expect(args()).toMatch(/scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720/);
    expect(args()).toMatch(/-profile:v high .*-level:v 3\.2/);
    expect(args()).toMatch(/-af volume=-2dB -c:a aac -ac 2 -b:a 128k -ar 48000/);
    expect(args()).toMatch(/-copyts -muxdelay 0 -muxpreload 0 -f mpegts/);
  });

  test.each([
    ['constrained baseline', 'baseline'],
    ['main', 'main'],
    ['high 10', 'high'],
    ['something odd', 'high'],
    [null, 'high'],
  ])('ffprobe profile %p is encoded as x264 profile %p', async (profile, x264) => {
    tools();
    await conform.conformedSegment(seg(`p-${profile}`), { ...shape720, profile, level: null, sampleRate: null });
    expect(args()).toMatch(new RegExp(`-profile:v ${x264} `));
    expect(args()).not.toMatch(/-level:v|-ar /);
  });

  test('gain only: the picture is copied through and only the audio is re-encoded', async () => {
    tools();
    await conform.conformedSegment(seg('gain'), { gainOnly: true });
    expect(args()).toMatch(/-c:v copy -af volume=-2dB -c:a aac -b:a 128k/);
    expect(args()).not.toMatch(/scale=/);
  });

  test('a finished encode is reused, and two requests at once share one ffmpeg', async () => {
    tools();
    const [a, b] = await Promise.all([conform.conformedSegment(seg('shared'), shape720), conform.conformedSegment(seg('shared'), shape720)]);
    expect(a).toBe(b);
    await conform.conformedSegment(seg('shared'), shape720);
    expect(calls('ffmpeg')).toHaveLength(1);
  });

  test.each([['fail'], ['empty']])('an encode that %ss returns null and leaves no temp file', async (mode) => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    tools({ ffmpeg: mode });
    await expect(conform.conformedSegment(seg(`bad-${mode}`), shape720)).resolves.toBeNull();
    expect(fs.readdirSync(env.AD_BURN_CACHE_DIR)).toEqual([]);
  });

  test.each([
    ['no segment', null, shape720],
    ['no target', seg('x'), null],
    ['a target without a size', seg('x'), { profile: 'high' }],
  ])('nothing to do for %s', async (_label, s, t) => {
    await expect(conform.conformedSegment(s, t)).resolves.toBeNull();
    expect(calls('ffmpeg')).toHaveLength(0);
  });

  test('gain only at 0 dB, or with conforming off, is nothing to do', async () => {
    const noGain = fx.loadIsolated('../../services/adConform', { env: { AD_GAIN_DB: '0' } });
    await expect(noGain.conformedSegment(seg('x'), { gainOnly: true })).resolves.toBeNull();
    const off = fx.loadIsolated('../../services/adConform', { env: { AD_AUDIO_NORMALISE: 'false' } });
    await expect(off.conformedSegment(seg('x'), shape720)).resolves.toBeNull();
  });
});
