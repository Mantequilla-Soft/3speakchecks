/**
 * utils/adAudioSpot.js: an advertiser's own audio clip. The first bytes must look
 * like a sound file before ffmpeg ever sees them; then a length check, a levelling
 * encode, and a file named by the hash of the result. One file at a time, with a
 * short queue. ffmpeg and ffprobe are fake (see fakeMediaTools).
 */
const fs = require('fs');
const path = require('path');
const fx = require('./_fixtures');

const tools = fx.fakeMediaTools();
const env = fx.useAdEnv({ ...tools.env });
const { processUpload, sniff } = require('../../utils/adAudioSpot');

beforeEach(() => tools.set());

const pad = (head) => Buffer.concat([Buffer.isBuffer(head) ? head : Buffer.from(head, 'latin1'), Buffer.alloc(32)]);
const MP3 = pad('ID3\u0004\u0000');
const probe = (over) => JSON.stringify({ streams: [{ codec_type: 'audio', channels: 6 }], format: { duration: '9.5' }, ...over });
const leftovers = () => fs.readdirSync(env.AD_TTS_DIR).filter((f) => f.startsWith('.up-'));

describe('sniff: is this a sound file we take', () => {
  test.each([
    ['MP3 with an ID3 tag', MP3, 'mp3'],
    ['an ADTS AAC stream', pad(Buffer.from([0xff, 0xf1, 0x50])), 'aac'],
    ['a bare MPEG frame', pad(Buffer.from([0xff, 0xfb, 0x90])), 'mp3'],
    ['WAV', pad(Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVE', 'latin1')), 'wav'],
    ['Ogg', pad('OggS'), 'ogg'],
    ['FLAC', pad('fLaC'), 'flac'],
    ['MP4 / M4A', pad(Buffer.from('\u0000\u0000\u0000\u0018ftypM4A ', 'latin1')), 'mp4'],
    ['WebM', pad(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])), 'webm'],
    ['an HLS playlist ffmpeg would follow', pad('#EXTM3U\n#EXT-X'), null],
    ['a concat script', pad('ffconcat version 1.0'), null],
    ['too short to tell', Buffer.from('ID3'), null],
    ['nothing', null, null],
  ])('%s -> %p', (_label, buf, want) => expect(sniff(buf)).toBe(want));
});

describe('processUpload', () => {
  test('levels the first audio stream to at most stereo and names the file by its hash', async () => {
    tools.set({ PROBE_JSON: probe(), PROBE_DURATION: '9.48' });
    const out = await processUpload(MP3, { maxSeconds: 30 });
    expect(out.file).toBe(`${out.sha1}.mp3`);
    expect(out.durationSeconds).toBe(9.48);
    expect(fs.existsSync(path.join(env.AD_TTS_DIR, out.file))).toBe(true);
    const ffmpeg = tools.calls().find((c) => c.startsWith('ffmpeg'));
    expect(ffmpeg).toMatch(/-map 0:a:0 -vn -sn -dn -map_metadata -1/);
    expect(ffmpeg).toMatch(/loudnorm=I=-16:TP=-1\.5:LRA=11,volume=-2dB,aresample=44100/);
    expect(ffmpeg).toMatch(/-ac 2 -c:a libmp3lame -b:a 128k/);
    expect(leftovers()).toEqual([]);
  });

  test('the same clip uploaded twice is one file', async () => {
    const a = await processUpload(MP3, { maxSeconds: 30 });
    const b = await processUpload(MP3, { maxSeconds: 30 });
    expect(b.file).toBe(a.file);
  });

  test('a mono clip stays mono', async () => {
    tools.set({ PROBE_JSON: probe({ streams: [{ codec_type: 'audio', channels: 1 }] }) });
    await processUpload(MP3, { maxSeconds: 30 });
    expect(tools.calls().find((c) => c.startsWith('ffmpeg'))).toMatch(/-ac 1 /);
  });

  test('something that is not sound is refused before any tool runs', async () => {
    await expect(processUpload(pad('#EXTM3U'), { maxSeconds: 30 })).rejects.toMatchObject({ code: 'audio_not_supported' });
    expect(tools.calls()).toEqual([]);
  });

  test.each([
    ['ffprobe cannot read it', { FFPROBE_FAIL: '1' }, { code: 'audio_not_supported' }],
    ['there is no audio stream', { PROBE_JSON: probe({ streams: [{ codec_type: 'video' }] }) }, { code: 'audio_no_stream' }],
    ['it is under a second', { PROBE_JSON: probe({ format: { duration: '0.4' } }) }, { code: 'audio_too_short' }],
    ['it is over the format limit', { PROBE_JSON: probe({ format: { duration: '31.2' } }) }, { code: 'audio_too_long', seconds: 32, max: 30 }],
    ['the encode fails', { FFMPEG_FAIL: '1' }, { code: 'audio_failed' }],
    ['the encode produces nothing playable', { PROBE_DURATION: '0' }, { code: 'audio_failed' }],
  ])('refused when %s, and no temp file is left behind', async (_label, state, want) => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    tools.set(state);
    await expect(processUpload(MP3, { maxSeconds: 30 })).rejects.toMatchObject(want);
    expect(leftovers()).toEqual([]);
  });

  test('half a second over the limit is tolerated (container rounding)', async () => {
    tools.set({ PROBE_JSON: probe({ format: { duration: '30.4' } }) });
    await expect(processUpload(MP3, { maxSeconds: 30 })).resolves.toHaveProperty('file');
  });

  test('three files are processed in turn; a fourth while they wait is told to come back', async () => {
    const jobs = [1, 2, 3, 4].map(() => processUpload(MP3, { maxSeconds: 30 }));
    const results = await Promise.allSettled(jobs);
    expect(results.slice(0, 3).every((r) => r.status === 'fulfilled')).toBe(true);
    expect(results[3]).toMatchObject({ status: 'rejected', reason: { code: 'audio_busy' } });
    // The queue drains: the next upload is accepted again.
    await expect(processUpload(MP3, { maxSeconds: 30 })).resolves.toHaveProperty('file');
  });
});
