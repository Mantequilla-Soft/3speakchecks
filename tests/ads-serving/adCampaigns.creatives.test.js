/**
 * routes/adCampaigns.js, the creative side: attaching what a flight runs (a video
 * upload, a banner image, a ticker message, an audio clip), registering creatives
 * before any flight exists, uploading an audio spot and pre-listening to a spoken
 * ticker. Ported from scripts/test-ad-ticker.cjs (the ticker rules) and
 * scripts/test-ad-creative-upload.cjs (a spot must be an unpublished upload, and is
 * never approved by attaching it).
 *
 * No binary runs: child_process.execFile answers for ffprobe, ffmpeg and piper.
 */
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { ObjectId } = require('mongodb');
const fx = require('./_fixtures');

jest.mock('child_process', () => require('./_fixtures').childProcessMock());
jest.mock('../../services/adPaymentClaim', () => ({ claimCampaignPayment: jest.fn(), getHbdPerHive: jest.fn() }));
jest.mock('../../utils/videoDuration', () => ({ videoShapeFromManifest: jest.fn() }));
const tools = fx.fakeMediaTools();
fx.useAdEnv({ ADS_STAGE: 'public', ...tools.env });
const { execFile } = require('child_process');
const { videoShapeFromManifest } = require('../../utils/videoDuration');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const config = require('../../utils/config');

const app = buildApp(['/advertise', require('../../routes/adCampaigns')]);
const db = testDb.use();
fx.freezeTime();

/* What the fake tools answer. Reset before every test. */
let media;
function installTools() {
  media = {
    image: { width: 1456, height: 240 },
    imageFails: false,
    audioProbe: { streams: [{ codec_type: 'audio', channels: 2 }], format: { duration: '9.5' } },
    outSeconds: '9.4',
    ffmpegFails: false,
    tag: 'one',
  };
  execFile.reset();
  execFile.setHandler(async (cmd, args) => {
    const tool = path.basename(cmd);
    const last = args[args.length - 1];
    if (tool === 'ffprobe' && args.includes('stream=width,height')) {
      if (media.imageFails) throw new Error('403 Forbidden');
      return JSON.stringify({ streams: [media.image] });
    }
    if (tool === 'ffprobe' && args.includes('-print_format')) return JSON.stringify(media.audioProbe);
    if (tool === 'ffprobe') return media.outSeconds;
    if (tool === 'ffmpeg') {
      if (media.ffmpegFails) throw new Error('encoder crashed');
      fs.writeFileSync(last, `ID3-${media.tag}`);
      return '';
    }
    if (tool === 'piper') {
      fs.writeFileSync(args[args.indexOf('--output_file') + 1], 'RIFF');
      return '';
    }
    throw new Error(`unexpected ${cmd}`);
  });
}

let adv;
beforeEach(async () => {
  jest.setSystemTime(fx.NOW);
  installTools();
  videoShapeFromManifest.mockReset();
  adv = fx.advertiser({ status: 'approved', hiveAccount: 'acme' });
  await fx.seed(db(), { advertisers: [adv] });
});

const creatives = () => db().collection(config.AD_CREATIVES_COLLECTION);
const campaigns = () => db().collection(config.AD_CAMPAIGNS_COLLECTION);
async function flight(over = {}) {
  const c = fx.campaign({ advertiserRef: adv.reference, creativeEmbedId: null, spotSeconds: 12, status: 'awaiting_payment', paidHbd: 0, ...over });
  await campaigns().insertOne(c);
  return c;
}
async function upload(over = {}) {
  const e = { _id: new ObjectId(), owner: 'acme', permlink: fx.uid('up'), manifest_cid: 'QmEncodedSpot', duration: 10.2, ...over };
  await db().collection('embed-video').insertOne(e);
  return e;
}
const attach = (c, body) => request(app).post(`/advertise/campaigns/${c._id}/creative`).send({ reference: adv.reference, ...body });
const register = (body) => request(app).post('/advertise/creatives').send({ reference: adv.reference, ...body });

describe('attaching a video upload to a flight', () => {
  test('an encoded upload goes to review, never straight to ready, and the flight points at it', async () => {
    const c = await flight();
    const e = await upload();
    const res = await attach(c, { embedId: String(e._id) }).expect(200);
    expect(res.body.campaign).toMatchObject({
      blockedBy: 'unpaid', creative: { embedId: String(e._id), kind: 'video', status: 'review', durationSeconds: 10, encoded: true },
    });
    expect(await creatives().findOne({ embedId: String(e._id) })).toMatchObject({ manifestCid: 'QmEncodedSpot', owner: 'acme', advertiserRef: adv.reference });
    expect((await campaigns().findOne({ _id: c._id })).creativeEmbedId).toBe(String(e._id));
  });

  test('an upload still encoding is accepted as pending, and found by permlink too', async () => {
    const c = await flight();
    const e = await upload({ manifest_cid: null });
    const res = await attach(c, { embedId: e.permlink }).expect(200);
    expect(res.body.campaign.creative).toMatchObject({ status: 'pending', encoded: false });
  });

  test('a spot a human already approved stays approved when it is attached to another flight', async () => {
    const e = await upload();
    await creatives().insertOne(fx.videoCreative({ embedId: String(e._id), status: 'ready', advertiserRef: adv.reference, manifestUrl: 'https://old.example/ipfs/QmX/manifest.m3u8' }));
    const [a, b] = [await flight(), await flight({ slotPercent: 25 })];
    await attach(a, { embedId: String(e._id) }).expect(200);
    await attach(b, { embedId: String(e._id) }).expect(200);
    const cr = await creatives().findOne({ embedId: String(e._id) });
    expect(cr.status).toBe('ready');
    expect(cr).not.toHaveProperty('manifestUrl');
    expect(await campaigns().countDocuments({ creativeEmbedId: String(e._id) })).toBe(2);
  });

  test('an upload published to Hive is refused: an ad must not also be somebody\'s post', async () => {
    const c = await flight();
    const e = await upload({ hive_author: 'acme', hive_permlink: 'my-post' });
    expect((await attach(c, { embedId: String(e._id) }).expect(400)).body.error).toMatch(/published to Hive/);
  });

  test.each([
    ['a spot longer than the booked slot, with a way out', { spotSeconds: 12 }, 14, /The spot is 14s and this flight booked a 12s slot\. Book a longer slot \(up to 15s\)/],
    ['a spot longer than the longest slot there is', { spotSeconds: 15 }, 16, /booked a 15s slot\.$/],
    ['an old flight with no booked length, against the format cap', { spotSeconds: null }, 16, /booked a 15s slot/],
  ])('refuses %s', async (_label, over, duration, error) => {
    const c = await flight(over);
    const e = await upload({ duration });
    expect((await attach(c, { embedId: String(e._id) }).expect(400)).body.error).toMatch(error);
  });

  test('a banner video has to cover the booking, because it plays once and does not loop', async () => {
    const c = await flight({ format: 'video_banner', spotSeconds: 20 });
    const short = await upload({ duration: 5 });
    expect((await attach(c, { embedId: String(short._id) }).expect(400)).body.error).toMatch(/runs for 20s and that video is 5s/);
    const long = await upload({ duration: 45 });
    await attach(c, { embedId: String(long._id) }).expect(200);
  });

  test('a shorts spot is measured from the media and must be portrait; the measurement is kept', async () => {
    const c = await flight({ format: 'shorts_roll', spotSeconds: 10, slotPercent: null });
    const landscape = await upload({ duration: 8 });
    videoShapeFromManifest.mockResolvedValueOnce({ width: 1920, height: 1080 });
    expect((await attach(c, { embedId: String(landscape._id) }).expect(400)).body.error).toMatch(/landscape/);

    const portrait = await upload({ duration: 8 });
    videoShapeFromManifest.mockResolvedValueOnce({ width: 1080, height: 1920 });
    await attach(c, { embedId: String(portrait._id) }).expect(200);
    expect(await creatives().findOne({ embedId: String(portrait._id) })).toMatchObject({ videoWidth: 1080, videoHeight: 1920 });
    expect(videoShapeFromManifest.mock.calls[1][0]).toBe('https://ipfs-3speak.b-cdn.net/ipfs/QmEncodedSpot/manifest.m3u8');

    await attach(c, { embedId: String(portrait._id) }).expect(200);
    expect(videoShapeFromManifest).toHaveBeenCalledTimes(2);
  });

  test('a shape we could not measure does not block the advertiser', async () => {
    const c = await flight({ format: 'shorts_roll', spotSeconds: 10, slotPercent: null });
    const e = await upload({ duration: 8 });
    videoShapeFromManifest.mockResolvedValueOnce(null);
    await attach(c, { embedId: String(e._id) }).expect(200);
  });

  test.each([
    ['no embedId', {}, 400, /embedId is required/],
    ['an upload that does not exist', { embedId: 'ghost-upload' }, 404, /not found/],
    ['an upload id that does not exist', { embedId: String(new ObjectId()) }, 404, /not found/],
  ])('refuses %s', async (_label, body, status, error) => {
    const c = await flight();
    expect((await attach(c, body).expect(status)).body.error).toMatch(error);
  });
});

describe('attaching a banner image', () => {
  test('a well-shaped https image is stored with its measured size, in review', async () => {
    const c = await flight({ format: 'video_banner', spotSeconds: 10 });
    const res = await attach(c, { imageUrl: 'https://acme.example/strip.png' }).expect(200);
    expect(res.body.creative).toMatchObject({ embedId: 'img:https://acme.example/strip.png', kind: 'image', status: 'review', imageWidth: 1456, imageHeight: 240, durationSeconds: 0 });
    expect(execFile.calls[0][1]).toContain('https://acme.example/strip.png');
    expect((await campaigns().findOne({ _id: c._id })).creativeEmbedId).toBe('img:https://acme.example/strip.png');
  });

  test('an image that is not banner-shaped is refused with a reason', async () => {
    media.image = { width: 800, height: 800 };
    const c = await flight({ format: 'video_banner', spotSeconds: 10 });
    expect((await attach(c, { imageUrl: 'https://acme.example/square.png' }).expect(400)).body.error).toMatch(/at least 3:1/);
  });

  test('an image that cannot be measured is let through, without a size', async () => {
    media.imageFails = true;
    const c = await flight({ format: 'video_banner', spotSeconds: 10 });
    expect((await attach(c, { imageUrl: 'https://acme.example/x.png' }).expect(200)).body.creative).toMatchObject({ imageWidth: null, imageHeight: null });
  });

  test('a banner a human already decided on keeps that decision', async () => {
    await creatives().insertOne(fx.imageCreative({ imageUrl: 'https://acme.example/ok.png', status: 'rejected' }));
    const c = await flight({ format: 'video_banner', spotSeconds: 10 });
    expect((await attach(c, { imageUrl: 'https://acme.example/ok.png' }).expect(200)).body.creative.status).toBe('rejected');
  });

  test.each([
    ['an image on a roll', { format: 'video_roll' }, { imageUrl: 'https://acme.example/x.png' }, /video spot is a video\. Upload the spot/],
    ['a plain http image', { format: 'video_banner' }, { imageUrl: 'http://acme.example/x.png' }, /imageUrl must be an https URL/],
  ])('refuses %s', async (_label, over, body, error) => {
    const c = await flight(over);
    expect((await attach(c, body).expect(400)).body.error).toMatch(error);
  });
});

describe('attaching a ticker message (scripts/test-ad-ticker.cjs)', () => {
  test('text and link become a creative in review; line breaks and runs of spaces are folded', async () => {
    const c = await flight({ format: 'video_ticker', spotSeconds: 10 });
    const res = await attach(c, { message: 'Try  Ticker Co\ntoday,   it is great', clickUrl: 'https://example.com/go?x=1' }).expect(200);
    expect(res.body.campaign.creative).toMatchObject({
      kind: 'text', status: 'review', message: 'Try Ticker Co today, it is great', clickUrl: 'https://example.com/go?x=1', tickerStyle: 'crawl', minSeconds: 8,
    });
    expect(res.body.campaign.creative.embedId).toMatch(/^txt:[0-9a-f]{24}$/);
  });

  test('the same text is the same creative (and keeps its review); a different style is a new one', async () => {
    const c = await flight({ format: 'video_ticker', spotSeconds: 10 });
    const body = { message: 'Same words', clickUrl: 'https://example.com' };
    const first = (await attach(c, body).expect(200)).body.campaign.creative.embedId;
    await creatives().updateOne({ embedId: first }, { $set: { status: 'ready' } });
    const again = (await attach(c, body).expect(200)).body.campaign.creative;
    expect(again).toMatchObject({ embedId: first, status: 'ready' });
    const held = (await attach(c, { ...body, style: 'hold' }).expect(200)).body.campaign.creative;
    expect(held.embedId).not.toBe(first);
    expect(held.tickerStyle).toBe('hold');
  });

  test('a saved ticker can be picked by its key, but only the advertiser\'s own', async () => {
    const own = fx.textCreative({ advertiserRef: adv.reference, message: 'Short one' });
    const theirs = fx.textCreative({ advertiserRef: 'someone-else' });
    await creatives().insertMany([own, theirs]);
    const c = await flight({ format: 'video_ticker', spotSeconds: 10 });
    await attach(c, { embedId: own.embedId }).expect(200);
    await attach(c, { embedId: theirs.embedId }).expect(404);
  });

  test('a message that needs longer than the booking is refused with both ways out', async () => {
    const c = await flight({ format: 'video_ticker', spotSeconds: 10 });
    const res = await attach(c, { message: Array(20).fill('word').join(' '), clickUrl: 'https://example.com' }).expect(400);
    expect(res.body).toMatchObject({ minSeconds: 14 });
    expect(res.body.error).toBe('This message has 20 words and needs at least 14 seconds to be readable; this booking is 10. Book 14 seconds or more, or shorten the message.');
  });

  test.each([
    ['no message', { message: '   ', clickUrl: 'https://example.com' }, /Write the message/],
    ['141 characters', { message: 'x'.repeat(141), clickUrl: 'https://example.com' }, /Keep the message to 140 characters\. It is 141\./],
    ['a plain http link', { message: 'Hi there', clickUrl: 'http://example.com' }, /full https:\/\/ address/],
    ['no link at all', { message: 'Hi there' }, /full https:\/\/ address/],
    ['more words than any booking can show', { message: Array(36).fill('w').join(' '), clickUrl: 'https://example.com' }, /needs about 22 seconds to read and a ticker runs at most 20/],
    ['an image instead of text', { imageUrl: 'https://acme.example/x.png' }, /A ticker runs a message and a link/],
  ])('refuses %s', async (_label, body, error) => {
    const c = await flight({ format: 'video_ticker', spotSeconds: 20 });
    expect((await attach(c, body).expect(400)).body.error).toMatch(error);
  });

  test('a ticker message is refused on a roll flight', async () => {
    const c = await flight();
    expect((await attach(c, { message: 'Hello', clickUrl: 'https://example.com' }).expect(400)).body.error).toMatch(/video spot needs a file, not a ticker message/);
  });
});

describe('attaching an audio clip', () => {
  const clip = (over = {}) => fx.audioCreative({ advertiserRef: adv.reference, durationSeconds: 8.2, ...over });

  test('an uploaded clip is attached by its key when the booking holds it', async () => {
    const a = clip();
    await creatives().insertOne(a);
    const c = await flight({ format: 'audio_spot', spotSeconds: 10 });
    const res = await attach(c, { embedId: a.embedId }).expect(200);
    expect(res.body.creative).toMatchObject({ kind: 'audio', audioPath: `/m/tts/${a.audioFile}` });
  });

  test.each([
    ['a clip longer than the booking', () => clip({ durationSeconds: 12.1 }), { format: 'audio_spot', spotSeconds: 10 },
      (a) => ({ embedId: a.embedId }), 400, /This clip is 13 seconds and this booking is 10/],
    ['somebody else\'s clip', () => clip({ advertiserRef: 'other' }), { format: 'audio_spot' }, (a) => ({ embedId: a.embedId }), 404, /not found/],
    ['a clip on a roll flight', () => clip(), { format: 'video_roll' }, (a) => ({ embedId: a.embedId }), 400, /cannot run an audio file/],
    ['an audio flight sent a video', () => clip(), { format: 'audio_spot' }, () => ({ embedId: 'some-video' }), 400, /Send the key of one you uploaded/],
  ])('refuses %s', async (_label, make, over, body, status, error) => {
    const a = make();
    await creatives().insertOne(a);
    const c = await flight(over);
    expect((await attach(c, body(a)).expect(status)).body.error).toMatch(error);
  });
});

describe('who may attach', () => {
  test.each([
    ['an unknown reference', (c) => [c._id, { reference: 'nope' }], 403],
    ['a malformed campaign id', () => ['xyz', {}], 400],
    ['another advertiser\'s flight', () => [new ObjectId(), {}], 404],
  ])('refuses %s', async (_label, args, status) => {
    const c = await flight();
    const [id, body] = args(c);
    await request(app).post(`/advertise/campaigns/${id}/creative`).send({ reference: adv.reference, ...body }).expect(status);
  });
});

describe('POST /advertise/creatives: a creative before any flight', () => {
  test('a ticker message is stored for review', async () => {
    const res = await register({ message: 'Hello  world', clickUrl: 'https://example.com' }).expect(201);
    expect(res.body.creative).toMatchObject({ kind: 'text', status: 'review', message: 'Hello world' });
    expect((await register({ message: '', clickUrl: 'https://example.com' }).expect(400)).body.error).toMatch(/Write the message/);
  });

  test('an image is stored with its size; it is an asset to build a spot around', async () => {
    const res = await register({ imageUrl: 'https://acme.example/logo.png' }).expect(201);
    expect(res.body.creative).toMatchObject({ kind: 'image', imageWidth: 1456, status: 'review' });
    await register({ imageUrl: 'ftp://acme.example/logo.png' }).expect(400);
  });

  test('a video upload is registered pending until it encodes, with a preview link', async () => {
    const e = await upload({ manifest_cid: null });
    const res = await register({ embedId: String(e._id) }).expect(201);
    expect(res.body.creative).toMatchObject({ status: 'pending', previewUrl: `https://3speak.tv/embed/acme/${e.permlink}` });
    const done = await upload();
    expect((await register({ embedId: done.permlink }).expect(201)).body.creative.status).toBe('review');
  });

  test.each([
    ['nothing to register', () => ({}), 400, /embedId or imageUrl is required/],
    ['an unknown upload', () => ({ embedId: 'ghost' }), 404, /not found/],
  ])('refuses %s', async (_label, body, status, error) => {
    expect((await register(body()).expect(status)).body.error).toMatch(error);
  });

  test('refuses a published upload and one longer than the slot', async () => {
    const published = await upload({ hive_permlink: 'p' });
    expect((await register({ embedId: String(published._id) }).expect(400)).body.error).toMatch(/published to Hive/);
    const long = await upload({ duration: 16 });
    expect((await register({ embedId: String(long._id) }).expect(400)).body.error).toBe(`The spot is 16s. The slot is ${config.AD_LENGTH_SECONDS}s.`);
  });

  test('a pending applicant may attach four files, may re-upload one of them, and no more', async () => {
    await db().collection(config.ADVERTISERS_COLLECTION).updateOne({ reference: adv.reference }, { $set: { status: 'pending' } });
    const ups = [];
    for (let i = 0; i < 4; i += 1) ups.push(await upload());
    for (const e of ups) await register({ embedId: String(e._id) }).expect(201);
    expect((await register({ embedId: String((await upload())._id) }).expect(429)).body.error).toMatch(/up to 4 files/);
    await register({ embedId: String(ups[0]._id) }).expect(201);
    await register({ message: 'One more', clickUrl: 'https://example.com' }).expect(429);
    await register({ imageUrl: 'https://acme.example/more.png' }).expect(429);
  });

  test('an approved advertiser has no file cap', async () => {
    for (let i = 0; i < 5; i += 1) await register({ embedId: String((await upload())._id) }).expect(201);
  });

  test('an unknown reference is a 403', async () => {
    await request(app).post('/advertise/creatives').send({ reference: 'nope', message: 'x' }).expect(403);
  });
});

describe('GET /advertise/creatives', () => {
  test('lists the advertiser\'s creatives, newest first, each described for its kind', async () => {
    await creatives().insertMany([
      fx.audioCreative({ advertiserRef: adv.reference, createdAt: fx.ago(fx.HOUR) }),
      fx.textCreative({ advertiserRef: adv.reference, style: 'hold', createdAt: fx.ago(2 * fx.HOUR) }),
      fx.videoCreative({ advertiserRef: 'other' }),
    ]);
    const res = await request(app).get(`/advertise/creatives?reference=${adv.reference}`).expect(200);
    expect(res.body.creatives.map((c) => c.kind)).toEqual(['audio', 'text']);
    expect(res.body.creatives[0]).toMatchObject({ audioPath: expect.stringMatching(/^\/m\/tts\/a{40}\.mp3$/), tickerStyle: null, minSeconds: null });
    expect(res.body.creatives[1]).toMatchObject({ tickerStyle: 'hold', minSeconds: expect.any(Number), audioPath: null });
    await request(app).get('/advertise/creatives?reference=nope').expect(403);
  });
});

describe('POST /advertise/creatives/audio: uploading an audio spot', () => {
  const MP3 = Buffer.concat([Buffer.from('ID3\u0004\u0000', 'latin1'), Buffer.alloc(64)]);
  const send = (body, q = {}) => request(app).post('/advertise/creatives/audio')
    .query({ reference: adv.reference, clickUrl: 'https://acme.example/listen', ...q })
    .set('Content-Type', 'audio/mpeg').send(body);

  test('levels and stores the clip, and saves it as an audio creative in review', async () => {
    const res = await send(MP3).expect(201);
    expect(res.body.creative).toMatchObject({ kind: 'audio', status: 'review', durationSeconds: 9.4, clickUrl: 'https://acme.example/listen' });
    expect(res.body.creative.embedId).toMatch(/^aud:[0-9a-f]{24}$/);
    expect(res.body.creative.audioPath).toMatch(/^\/m\/tts\/[0-9a-f]{40}\.mp3$/);
  });

  test('the same clip with the same link is the same creative, and keeps its review', async () => {
    const first = (await send(MP3).expect(201)).body.creative.embedId;
    await creatives().updateOne({ embedId: first }, { $set: { status: 'ready' } });
    expect((await send(MP3).expect(201)).body.creative).toMatchObject({ embedId: first, status: 'ready' });
  });

  test.each([
    ['not sound at all', () => Buffer.from('#EXTM3U\n'.padEnd(40, 'x')), () => {}, 400, 'audio_not_supported'],
    ['a clip over the limit', () => MP3, () => { media.audioProbe.format.duration = '45'; }, 400, 'audio_too_long'],
    ['a clip with no sound in it', () => MP3, () => { media.audioProbe.streams = []; }, 400, 'audio_no_stream'],
    ['an encode that fails', () => MP3, () => { media.ffmpegFails = true; }, 500, 'audio_failed'],
  ])('refuses %s, with the reason as a code', async (_label, body, arrange, status, code) => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    arrange();
    const res = await send(body()).expect(status);
    expect(res.body.code).toBe(code);
  });

  test('a clip over the limit says how long it is', async () => {
    media.audioProbe.format.duration = '45';
    expect((await send(MP3).expect(400)).body.error).toBe(`That clip is 45s. An audio spot can be at most ${config.AD_AUDIO_SPOT_MAX_SECONDS}s.`);
  });

  test.each([
    ['an unknown reference', { reference: 'nope' }, MP3, 403],
    ['a link that is not https', { clickUrl: 'http://acme.example' }, MP3, 400],
    ['no link', { clickUrl: '' }, MP3, 400],
    ['no file', {}, Buffer.alloc(0), 400],
  ])('refuses %s', async (_label, q, body, status) => {
    await send(body, q).expect(status);
  });

  test('twenty uploads an hour per advertiser, counted whether or not they worked', async () => {
    const junk = Buffer.from('not audio at all, just text bytes');
    for (let i = 0; i < 20; i += 1) await send(junk).expect(400);
    await send(MP3).expect(429);
    fx.advance(fx.HOUR + 1);
    await send(MP3).expect(201);
  });
});

describe('POST /advertise/creatives/listen: hearing a ticker before saving it', () => {
  const listen = (body, headers = {}) => request(app).post('/advertise/creatives/listen').set(headers)
    .send({ reference: adv.reference, message: 'Spring sale on widgets', clickUrl: 'https://acme.example', ...body });

  test('renders the exact spot a listener would hear and says where to fetch it', async () => {
    const res = await listen({}, { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'checker.example' }).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      success: true,
      audioUrl: expect.stringMatching(/^https:\/\/checker\.example\/m\/tts\/[0-9a-f]{40}\.mp3$/),
      durationSeconds: 9.4,
      text: 'Sponsored message from Acme Widgets. Spring sale on widgets. Click the link in the player to find out more.',
    });
    expect(await creatives().countDocuments()).toBe(0);
  });

  test('the message is checked by the same rules as saving it', async () => {
    expect((await listen({ clickUrl: 'http://acme.example' }).expect(400)).body.error).toMatch(/https/);
  });

  test('a render that fails is a 500 with its code', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    media.ffmpegFails = true;
    expect((await listen({ message: 'A different message' }).expect(500)).body).toMatchObject({ code: 'tts_failed' });
  });

  test('without a speech engine on the box it is a 503', async () => {
    const noTts = buildApp(['/advertise', fx.isolatedModule('../../routes/adCampaigns', { AD_TTS_PIPER_BIN: '/nonexistent/piper' })]);
    const res = await request(noTts).post('/advertise/creatives/listen')
      .send({ reference: adv.reference, message: 'Hi', clickUrl: 'https://acme.example' }).expect(503);
    expect(res.body).toMatchObject({ code: 'tts_unavailable', error: 'Listening is not available right now.' });
  });

  test('an unknown reference is a 403', async () => {
    await listen({ reference: 'nope' }).expect(403);
  });
});

describe('a database failure is a 500 that says nothing about why', () => {
  test.each([
    ['post', '/advertise/campaigns/0123456789abcdef01234567/creative', { reference: 'x' }],
    ['post', '/advertise/creatives', { reference: 'x' }],
    ['get', '/advertise/creatives?reference=x', undefined],
  ])('%s %s', async (method, p, body) => {
    fx.databaseFails();
    await request(app)[method](p).send(body).expect(500, { success: false, error: 'Internal server error' });
  });

  test('POST /advertise/creatives/audio', async () => {
    fx.databaseFails();
    await request(app).post('/advertise/creatives/audio?reference=x').send(Buffer.from('x')).expect(500);
  });

  test('POST /advertise/creatives/listen', async () => {
    fx.databaseFails();
    const res = await request(app).post('/advertise/creatives/listen').send({ reference: 'x' }).expect(500);
    expect(res.body).toMatchObject({ success: false, code: null });
  });
});
