/**
 * utils/adTts.js: ticker messages spoken as audio spots. What is said (disclosure
 * first, links never read out), how a render is cached by the hash of its text, how
 * failures are counted and given up on, the sweep, and the advertiser's pre-listen.
 *
 * Piper, ffmpeg and ffprobe are small shell scripts (see fakeMediaTools), so nothing
 * real is rendered and every call can be inspected.
 */
const fs = require('fs');
const path = require('path');
const fx = require('./_fixtures');

const tools = fx.fakeMediaTools();
const env = fx.useAdEnv({ ...tools.env, AD_TTS_CHIME: 'true', AD_TTS_BED: 'pad' });
const testDb = require('../helpers/db');
const tts = require('../../utils/adTts');
const { ADVERTISERS_COLLECTION, AD_CREATIVES_COLLECTION } = require('../../utils/config');

const db = testDb.use();
fx.freezeTime();
beforeEach(() => {
  jest.setSystemTime(fx.NOW);
  tools.set();
  for (const f of fs.readdirSync(env.AD_TTS_DIR)) fs.rmSync(path.join(env.AD_TTS_DIR, f), { force: true });
});

const RENDERS = 'ad_tts_renders';
const brand = { projectName: 'Acme Widgets' };
const creative = (over = {}) => ({ embedId: fx.uid('txt:'), message: 'Spring sale on every widget', clickUrl: 'https://acme.example/sale', ...over });
const isolated = (over) => fx.loadIsolated('../../utils/adTts', { env: { ...tools.env, ...over } });
const quiet = () => jest.spyOn(console, 'error').mockImplementation(() => {});

describe('who may carry a spoken spot', () => {
  test('an empty owner list means every creator', () => {
    expect(tts.AUDIO_TICKER_ALLOWED_OWNERS).toEqual([]);
    expect(tts.audioTickerAllowedOn('anyone')).toBe(true);
  });

  test('left unset, the trial runs on badadib only', () => {
    const mod = isolated({ AD_AUDIO_TICKER_ALLOWED_OWNERS: undefined });
    expect(mod.audioTickerAllowedOn('BadAdib')).toBe(true);
    expect(mod.audioTickerAllowedOn('someone')).toBe(false);
  });
});

describe('speakable: a ticker written to be read, said aloud', () => {
  test.each([
    ['links lose their scheme, www and path', 'Visit https://www.shop.io/spring?ref=3s now', 'Visit shop.io now.'],
    ['handles and hashtags lose their sigil', 'Follow @acme for #deals', 'Follow acme for deals.'],
    ['emoji are dropped', 'Big sale 🎉🔥 today', 'Big sale today.'],
    ['whitespace is folded and a full stop added', '  Two   spaces  ', 'Two spaces.'],
    ['existing end punctuation is kept', 'Hurry!', 'Hurry!'],
    ['nothing stays nothing', '', ''],
  ])('%s', (_label, input, want) => expect(tts.speakable(input)).toBe(want));
});

describe('spokenText: disclosure first, always', () => {
  test.each([
    ['product, message and link', creative(), brand,
      'Sponsored message from Acme Widgets. Spring sale on every widget. Click the link in the player to find out more.'],
    ['no link means no "click the link"', creative({ clickUrl: null }), brand,
      'Sponsored message from Acme Widgets. Spring sale on every widget.'],
    ['trailing punctuation on the product is not read as a stutter', creative({ clickUrl: null }), { projectName: 'Freedom isn\'t free,...' },
      'Sponsored message from Freedom isn\'t free. Spring sale on every widget.'],
    ['no product name', creative({ clickUrl: null }), null, 'Sponsored message. Spring sale on every widget.'],
    ['no message at all', { message: '' }, brand, 'Sponsored message from Acme Widgets.'],
  ])('%s', (_label, cr, b, want) => expect(tts.spokenText(cr, b)).toBe(want));
});

describe('file naming', () => {
  test('a render is named by the hash of exactly what is said', () => {
    const a = tts.ttsHash('one');
    expect(a).toMatch(/^[0-9a-f]{40}$/);
    expect(tts.ttsHash('one')).toBe(a);
    expect(tts.ttsHash('two')).not.toBe(a);
  });

  test.each([
    [`${'a'.repeat(40)}.mp3`, true],
    ['../../etc/passwd', false],
    [`${'A'.repeat(40)}.mp3`, false],
    [`${'a'.repeat(40)}.wav`, false],
    [null, false],
  ])('ttsFilePath(%p) resolves: %p', (file, ok) => {
    const p = tts.ttsFilePath(file);
    if (ok) expect(p).toBe(path.join(env.AD_TTS_DIR, file));
    else expect(p).toBeNull();
  });

  test('changing the music bed or the chime renders everything again', () => {
    const text = 'Sponsored message.';
    const hashes = new Set([
      tts.ttsHash(text),
      isolated({ AD_TTS_BED: 'off' }).ttsHash(text),
      isolated({ AD_TTS_BED: '/srv/music/calm.mp3' }).ttsHash(text),
      isolated({ AD_TTS_CHIME: 'false' }).ttsHash(text),
    ]);
    expect(hashes.size).toBe(4);
  });
});

describe('engineReady', () => {
  test('is true with a runnable piper and a readable voice', () => {
    expect(tts.engineReady()).toBe(true);
    expect(tts.enabled()).toBe(true);
  });

  test('is false without them, and so is enabled()', () => {
    const mod = isolated({ AD_TTS_PIPER_BIN: '/nonexistent/piper' });
    expect(mod.engineReady()).toBe(false);
    expect(mod.enabled()).toBe(false);
  });
});

describe('renderCreative', () => {
  test('renders once, stores a ready row, and the second call is the cached file', async () => {
    const cr = creative();
    const row = await tts.renderCreative(db(), cr, brand);
    expect(row).toMatchObject({ status: 'ready', creativeId: cr.embedId, durationSeconds: 6.4, voice: 'en_GB-test-voice' });
    expect(fs.existsSync(tts.ttsFilePath(row.file))).toBe(true);
    expect(await db().collection(RENDERS).findOne({ _id: row.hash })).toMatchObject({ status: 'ready', attempts: 0 });

    const calls = tools.calls();
    expect(calls[0]).toMatch(/^piper --model .*en_GB-test-voice\.onnx --output_file .*\.wav --sentence_silence 0\.3$/);
    const ffmpeg = calls.find((c) => c.startsWith('ffmpeg'));
    expect(ffmpeg).toMatch(/sine=frequency=880/);
    expect(ffmpeg).toMatch(/aevalsrc=/);
    expect(ffmpeg).toMatch(/amix=inputs=2/);
    expect(ffmpeg).toMatch(/loudnorm=I=-16:TP=-1\.5:LRA=11,volume=-2dB/);

    tools.set();
    await expect(tts.renderCreative(db(), cr, brand)).resolves.toMatchObject({ _id: row.hash, status: 'ready' });
    expect(tools.calls()).toEqual([]);
  });

  test('a failure is recorded with its reason, and after three attempts it stops trying', async () => {
    quiet();
    tools.set({ PIPER_FAIL: '1' });
    const cr = creative();
    for (let i = 1; i <= 3; i += 1) {
      await expect(tts.renderCreative(db(), cr, brand)).resolves.toBeNull();
    }
    const failed = await db().collection(RENDERS).findOne({ creativeId: cr.embedId });
    expect(failed).toMatchObject({ status: 'failed', attempts: 3 });
    expect(failed.error).toMatch(/piper exploded/);

    tools.set({ PIPER_FAIL: '1' });
    await expect(tts.renderCreative(db(), cr, brand)).resolves.toMatchObject({ status: 'failed', attempts: 3 });
    expect(tools.calls()).toEqual([]);
  });

  test('a file with no duration is a failed render, not a silent spot', async () => {
    quiet();
    tools.set({ PROBE_DURATION: '0' });
    await expect(tts.renderCreative(db(), creative(), brand)).resolves.toBeNull();
    expect((await db().collection(RENDERS).findOne({})).error).toMatch(/no duration/);
  });

  test('force renders again even when a ready file exists', async () => {
    const cr = creative();
    await tts.renderCreative(db(), cr, brand);
    tools.set();
    await tts.renderCreative(db(), cr, brand, { force: true });
    expect(tools.calls().some((c) => c.startsWith('piper'))).toBe(true);
  });

  test.each([
    ['no music bed', { AD_TTS_BED: 'off' }, (a) => !/amix|aevalsrc='/.test(a)],
    ['a music file looped under the voice', { AD_TTS_BED: '/srv/music/calm.mp3' }, (a) => /-stream_loop -1 -i \/srv\/music\/calm\.mp3/.test(a)],
    ['no chime', { AD_TTS_CHIME: 'false' }, (a) => !/sine=frequency/.test(a)],
  ])('mixes correctly with %s', async (_label, over, check) => {
    const mod = isolated(over);
    await mod.renderCreative(db(), creative(), brand);
    expect(check(tools.calls().find((c) => c.startsWith('ffmpeg')))).toBe(true);
  });
});

describe('readyRendersFor', () => {
  test('finds a render only for the text the creative would be spoken with today', async () => {
    const cr = creative();
    const row = await tts.renderCreative(db(), cr, brand);
    const found = await tts.readyRendersFor(db(), [{ creative: cr, brand }, { creative: null }, { creative: {} }]);
    expect(found.get(cr.embedId)).toMatchObject({ file: row.file, durationSeconds: 6.4 });

    // A renamed product is different speech: no file until the next sweep.
    const renamed = await tts.readyRendersFor(db(), [{ creative: cr, brand: { projectName: 'Acme Two' } }]);
    expect(renamed.size).toBe(0);

    // A row whose file is gone is not playable.
    fs.rmSync(tts.ttsFilePath(row.file));
    expect((await tts.readyRendersFor(db(), [{ creative: cr, brand }])).size).toBe(0);
  });

  test('nothing to look up is an empty map', async () => {
    expect((await tts.readyRendersFor(db(), [])).size).toBe(0);
  });
});

describe('runOnce: the sweep', () => {
  const seedTicker = async (over = {}) => {
    const adv = fx.advertiser();
    const cr = fx.textCreative({ advertiserRef: adv.reference, status: 'review', message: `Offer ${fx.uid('m')}`, ...over });
    await fx.seed(db(), { advertisers: [adv], creatives: [cr] });
    return { adv, cr };
  };

  test('renders every message waiting for review or approved, once', async () => {
    const { cr } = await seedTicker();
    await seedTicker({ status: 'ready' });
    await seedTicker({ status: 'rejected' });
    await expect(tts.runOnce()).resolves.toEqual({ checked: 2, rendered: 2 });
    expect(await db().collection(RENDERS).countDocuments({ creativeId: cr.embedId, status: 'ready' })).toBe(1);
    await expect(tts.runOnce()).resolves.toEqual({ checked: 2, rendered: 0 });
  });

  test('with nothing to say, it says so', async () => {
    await expect(tts.runOnce()).resolves.toEqual({ checked: 0, rendered: 0 });
  });

  test('without an engine, or with writes off, it does nothing', async () => {
    await seedTicker();
    await expect(isolated({ AD_TTS_VOICE: '/nonexistent.onnx' }).runOnce()).resolves.toBeNull();
    await expect(isolated({ ENABLE_MONGO_WRITES: 'false' }).runOnce()).resolves.toBeNull();
    expect(tools.calls()).toEqual([]);
  });

  test('a database failure is logged and the sweep returns null', async () => {
    const err = quiet();
    jest.spyOn(require('../../utils/db'), 'getDb').mockImplementation(() => { throw new Error('no primary'); });
    await expect(tts.runOnce()).resolves.toBeNull();
    expect(err).toHaveBeenCalledWith('[ad-tts] sweep failed:', 'no primary');
  });

  test('the brand name used is the advertiser\'s current one', async () => {
    const { cr } = await seedTicker();
    await db().collection(ADVERTISERS_COLLECTION).updateOne({ reference: cr.advertiserRef }, { $set: { projectName: 'Renamed Co' } });
    await tts.runOnce();
    const row = await db().collection(RENDERS).findOne({ creativeId: cr.embedId });
    expect(row.text).toMatch(/^Sponsored message from Renamed Co\./);
    expect(await db().collection(AD_CREATIVES_COLLECTION).countDocuments()).toBe(1);
  });
});

describe('previewRender: the advertiser hears it before saving', () => {
  const msg = (n) => ({ message: `Preview number ${n}`, clickUrl: 'https://acme.example' });

  test('renders on first ask and is the cached, identical file afterwards', async () => {
    const first = await tts.previewRender(db(), msg(1), brand, 'ref-a');
    expect(first).toMatchObject({ cached: false, durationSeconds: 6.4, text: expect.stringMatching(/^Sponsored message from Acme Widgets\. Preview number 1\./) });
    expect(await db().collection(RENDERS).findOne({ _id: first.file.replace('.mp3', '') })).toMatchObject({ preview: true, creativeId: null });

    tools.set();
    await expect(tts.previewRender(db(), msg(1), brand, 'ref-a')).resolves.toMatchObject({ cached: true, file: first.file });
    expect(tools.calls()).toEqual([]);
  });

  test('without an engine the preview is unavailable', async () => {
    await expect(isolated({ AD_TTS_PIPER_BIN: '/nope' }).previewRender(db(), msg(1), brand, 'r'))
      .rejects.toMatchObject({ code: 'tts_unavailable' });
  });

  test('each advertiser has an hourly allowance of new renders; cached replays are free', async () => {
    const mod = isolated({ AD_TTS_PREVIEWS_PER_HOUR: '1' });
    await mod.previewRender(db(), msg(1), brand, 'ref-b');
    await expect(mod.previewRender(db(), msg(1), brand, 'ref-b')).resolves.toMatchObject({ cached: true });
    await expect(mod.previewRender(db(), msg(2), brand, 'ref-b')).rejects.toMatchObject({ code: 'tts_limit' });
    await expect(mod.previewRender(db(), msg(2), brand, 'ref-other')).resolves.toMatchObject({ cached: false });
    fx.advance(fx.HOUR + 1);
    await expect(mod.previewRender(db(), msg(3), brand, 'ref-b')).resolves.toMatchObject({ cached: false });
  });

  test('a render that fails is reported as tts_failed', async () => {
    quiet();
    tools.set({ FFMPEG_FAIL: '1' });
    await expect(tts.previewRender(db(), msg(9), brand, 'ref-c')).rejects.toMatchObject({ code: 'tts_failed' });
  });

  test('one render at a time with a short queue: the fifth waiting request is turned away', async () => {
    tools.set({ PIPER_DELAY: '0.3' });
    const mod = isolated({});
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map((n) => mod.previewRender(db(), msg(`q${n}`), brand, 'ref-q')));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(4);
    expect(results.find((r) => r.status === 'rejected').reason).toMatchObject({ code: 'tts_busy' });
  });
});
