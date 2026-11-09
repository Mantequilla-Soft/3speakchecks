/**
 * routes/adServe.js, POST /m/session on the surfaces that are not a watch page:
 *   - shorts: a spot BETWEEN shorts, paced in shorts watched, not minutes;
 *   - upload: the pre-upload gate, which fails open in every direction;
 *   - live: a stream gets an opening roll and a ticker, never a banner;
 *   - audio: a ticker read aloud, or an advertiser's own clip, at most one per
 *     listener per AD_AUDIO_COOLDOWN_MINUTES (15), whichever advertiser.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');
const { ObjectId } = require('mongodb');
const fx = require('./_fixtures');

jest.mock('child_process', () => require('./_fixtures').childProcessMock());
jest.mock('../../utils/adGateways', () => ({ ...jest.requireActual('../../utils/adGateways'), startGatewayProbe: jest.fn() }));
jest.mock('../../utils/warmupAudio', () => ({ warmupAudio: jest.fn() }));
// The streaming server, asked whether a room is live (utils/liveRoom.js has its own tests).
jest.mock('../../utils/liveRoom', () => ({ liveRoom: jest.fn() }));
const env = fx.useAdEnv();
const { warmupAudio } = require('../../utils/warmupAudio');
const { liveRoom } = require('../../utils/liveRoom');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const config = require('../../utils/config');
const { ttsHash, spokenText } = require('../../utils/adTts');

const app = buildApp(['/m', require('../../routes/adServe')]);
const db = testDb.use();
fx.freezeTime();
beforeEach(() => {
  jest.setSystemTime(fx.NOW);
  warmupAudio.mockResolvedValue({ owners: [], allowed: [] });
  liveRoom.mockReset();
  liveRoom.mockResolvedValue({ liveAt: '2026-11-01T11:00:00.000Z' });
});

const SESSIONS = 'ad_sessions';
const adKey = (id) => crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 12);
const hex = (n) => crypto.randomBytes(n).toString('hex');
const open = (b, { ip = fx.freshIp(), to = app } = {}) => request(to).post('/m/session').set('X-Real-IP', ip).send(b);
const isolatedApp = (e) => buildApp(['/m', fx.isolatedModule('../../routes/adServe', e)]);
const sessionOf = (res) => db().collection(SESSIONS).findOne({ sid: fx.sidOf(JSON.stringify(res.body)) });
async function delivered(campaign, who, minutes, extra = {}) {
  const sid = hex(16);
  await db().collection(SESSIONS).insertOne({ sid, ...who, startedAt: fx.ago(minutes * fx.MIN), ...extra(campaign) });
  await db().collection(config.AD_IMPRESSIONS_COLLECTION).insertOne({ sid, campaignId: campaign._id, owner: who.viewer, completed: true, completedAt: fx.ago(minutes * fx.MIN) });
}

describe('shorts: a spot between one short and the next', () => {
  const shorts = (over = {}) => ({ surface: 'shorts', owner: 'creator1', permlink: 'short-1', shortsWatched: 5, capId: hex(8), ...over });

  test('after every Nth short, a full-screen spot with its own playlist and disclosure', async () => {
    const p = fx.placement({ format: 'shorts_roll', campaign: { slotPercent: null } });
    await fx.seed(db(), p.all);
    const res = await open(shorts({ viewer: 'viewer1' })).expect(200);
    const sid = fx.sidOf(res.body.shortsAd.manifestUrl);
    expect(res.body).toMatchObject({
      ad: null, reason: null, everyN: config.AD_SHORTS_EVERY_N,
      shortsAd: {
        manifestUrl: expect.stringMatching(new RegExp(`/m/${sid}/short\\.m3u8$`)), durationSeconds: 12, label: 'Sponsored', adKey: adKey(p.campaign._id),
        brand: { account: 'acme', productName: 'Acme Widgets', clickUrl: expect.stringMatching(new RegExp(`/m/${sid}/c$`)) },
      },
    });
    expect(await db().collection(SESSIONS).findOne({ sid })).toMatchObject({ surface: 'shorts', owner: 'creator1', permlink: 'short-1', viewer: 'viewer1', contentManifestUrl: null });
  });

  test('before the Nth short there is nothing, and the page is told the cadence', async () => {
    await fx.seed(db(), fx.placement({ format: 'shorts_roll' }).all);
    expect((await open(shorts({ shortsWatched: 2 }))).body).toEqual({ ad: null, reason: 'shorts_cadence', everyN: config.AD_SHORTS_EVERY_N, shortsWatched: 2 });
    expect((await open(shorts({ shortsWatched: 'lots' }))).body.reason).toBe('shorts_cadence');
  });

  test('a spot is a roll: a creator who takes overlays only gets none', async () => {
    await fx.seed(db(), fx.placement({ format: 'shorts_roll' }).all);
    await db().collection(config.AD_CREATOR_PREFS_COLLECTION).insertOne({ _id: 'creator1', rollsEnabled: false });
    expect((await open(shorts())).body).toEqual({ ad: null, reason: 'creator_no_rolls' });
  });

  test('a trimmed creative (self-promo) runs only its booked seconds', async () => {
    await fx.seed(db(), fx.placement({ format: 'shorts_roll', creative: { trimToSeconds: 6, durationSeconds: 60 } }).all);
    const res = await open(shorts()).expect(200);
    expect(res.body.shortsAd.durationSeconds).toBe(6);
    expect((await sessionOf(res)).adTrimSeconds).toBe(6);
  });

  test('the same spot does not follow a viewer down the feed', async () => {
    const a = fx.placement({ format: 'shorts_roll', campaign: { deliveredImpressions: 0 } });
    const b = fx.placement({ format: 'shorts_roll', campaign: { deliveredImpressions: 9 } });
    await fx.seed(db(), fx.together(a, b));
    await delivered(a.campaign, { viewer: 'viewer1' }, 2, (c) => ({ campaignId: c._id }));
    expect((await open(shorts({ viewer: 'viewer1' }))).body.shortsAd.adKey).toBe(adKey(b.campaign._id));
    expect((await open(shorts({ recentAdKeys: [adKey(a.campaign._id), adKey(b.campaign._id)] }))).body)
      .toEqual({ ad: null, reason: 'no_eligible_campaign', everyN: config.AD_SHORTS_EVERY_N });
  });

  test('the testing switch that lets one spot come round again drops both halves of the cap together', async () => {
    const repeat = isolatedApp({ AD_SHORTS_IGNORE_REPEAT_CAP: 'true' });
    const a = fx.placement({ format: 'shorts_roll' });
    await fx.seed(db(), a.all);
    await delivered(a.campaign, { viewer: 'viewer1' }, 2, (c) => ({ campaignId: c._id }));
    expect((await open(shorts({ viewer: 'viewer1', recentAdKeys: [adKey(a.campaign._id)] }), { to: repeat })).body.shortsAd).toBeTruthy();
  });

  test.each([
    ['an unapproved advertiser', { advertiser: { status: 'pending' } }],
    ['a creative in review', { creative: { status: 'review' } }],
    ['a viewer outside the booked market', { campaign: { markets: ['BR'] } }],
  ])('%s never serves', async (_label, over) => {
    await fx.seed(db(), fx.placement({ format: 'shorts_roll', ...over }).all);
    expect((await open(shorts({ country: 'de' }))).body.reason).toBe('no_eligible_campaign');
  });

  test('a shorts spot is never served on a watch page, and a watch roll never between shorts', async () => {
    await fx.seed(db(), fx.placement({ format: 'video_roll' }).all);
    expect((await open(shorts())).body).toEqual({ ad: null, reason: 'no_campaign', everyN: config.AD_SHORTS_EVERY_N });
  });

  test('the minutes cooldown of the watch surface does not mute the shorts feed', async () => {
    const quiet = isolatedApp({ AD_COOLDOWN_MINUTES: '10' });
    await fx.seed(db(), fx.placement({ format: 'shorts_roll' }).all);
    expect((await open(shorts({ lastAdAt: Date.now() - fx.MIN }), { to: quiet })).body.shortsAd).toBeTruthy();
  });
});

describe('the pre-upload gate', () => {
  const gate = (over = {}) => ({ surface: 'upload', viewer: 'uploader1', ...over });

  test('plays a spot to the uploader, who is also the one credited for it', async () => {
    const p = fx.placement({ format: 'upload_gate', campaign: { slotPercent: null } });
    await fx.seed(db(), p.all);
    const res = await open(gate()).expect(200);
    const sid = fx.sidOf(res.body.uploadAd.manifestUrl);
    expect(res.body.uploadAd).toMatchObject({
      manifestUrl: expect.stringMatching(/\/short\.m3u8$/), label: 'Sponsored', adKey: adKey(p.campaign._id), advertiser: 'Acme Widgets',
      brand: { clickUrl: expect.stringMatching(new RegExp(`/m/${sid}/c$`)) },
    });
    expect(await db().collection(SESSIONS).findOne({ sid })).toMatchObject({ surface: 'upload', owner: 'uploader1', viewer: 'uploader1', permlink: null });
  });

  test('fails open: no uploader, no campaign, or nothing eligible all mean "post now"', async () => {
    expect((await open(gate({ viewer: '' }))).body).toEqual({ ad: null, reason: 'no_uploader' });
    expect((await open(gate())).body).toEqual({ ad: null, reason: 'no_campaign' });
    await fx.seed(db(), fx.placement({ format: 'upload_gate', advertiser: { status: 'pending' } }).all);
    expect((await open(gate())).body).toEqual({ ad: null, reason: 'no_eligible_campaign' });
  });

  test('a creator\'s self-promotion never stands between somebody and their upload', async () => {
    await fx.seed(db(), fx.placement({ format: 'upload_gate', campaign: { selfPromo: true } }).all);
    expect((await open(gate())).body.reason).toBe('no_campaign');
  });

  test('the cap counts spots watched to completion, so an abandoned studio visit re-serves', async () => {
    const p = fx.placement({ format: 'upload_gate' });
    await fx.seed(db(), p.all);
    await db().collection(SESSIONS).insertOne({ sid: hex(16), surface: 'upload', viewer: 'uploader1', campaignId: p.campaign._id, startedAt: fx.ago(fx.MIN) });
    expect((await open(gate())).body.uploadAd).toBeTruthy();
    await db().collection(config.AD_IMPRESSIONS_COLLECTION).insertOne({ sid: hex(16), campaignId: p.campaign._id, owner: 'uploader1', completed: true, completedAt: fx.ago(fx.MIN) });
    expect((await open(gate())).body.reason).toBe('no_eligible_campaign');
  });

  test('only listed uploaders while the gate is a trial; Pro subscribers are never gated', async () => {
    const trial = isolatedApp({ AD_GATE_ALLOWED_UPLOADERS: 'ashenadib' });
    await fx.seed(db(), fx.placement({ format: 'upload_gate' }).all);
    expect((await open(gate(), { to: trial })).body).toEqual({ ad: null, reason: 'uploader_not_in_trial' });
    await db().collection(config.PREMIUM_USERS_COLLECTION).insertOne({ username: 'ashenadib', premium: true });
    expect((await open(gate({ viewer: 'ashenadib' }), { to: trial })).body).toEqual({ ad: null, reason: 'premium_viewer', premium: true });
  });

  test('the gate has no video, so it is not held to the network-per-video cap', async () => {
    await fx.seed(db(), fx.placement({ format: 'upload_gate' }).all);
    await db().collection('ad_repeat_gate').insertOne({ _id: 's:x', exp: fx.fromNow(fx.HOUR) });
    expect((await open(gate(), { ip: '198.51.100.1' })).body.uploadAd).toBeTruthy();
    expect((await open(gate({ viewer: 'uploader2' }), { ip: '198.51.100.2' })).body.uploadAd).toBeTruthy();
  });
});

describe('live streams', () => {
  const live = (over = {}) => ({ surface: 'live', owner: 'host1', permlink: 'room-1', preroll: true, ticker: true, capId: hex(8), ...over });

  test('a page that can play one gets an opening roll on its own playlist, with a skip after five seconds', async () => {
    const p = fx.placement({ campaign: { slotPercent: 50 } });
    await fx.seed(db(), p.all);
    const res = await open(live()).expect(200);
    expect(res.body.ad).toMatchObject({ manifestUrl: expect.stringMatching(/\/short\.m3u8$/), preroll: true, skipAfterSeconds: config.AD_SKIP_AFTER_SECONDS });
    expect(await sessionOf(res)).toMatchObject({ surface: 'live', adDurationSeconds: 12, bannerMode: 'overlay' });
  });

  test('the earliest booked position wins the one roll a stream has; least-delivered decides a tie', async () => {
    const late = fx.placement({ campaign: { slotPercent: 75, deliveredImpressions: 0 } });
    const pre = fx.placement({ campaign: { slotPercent: 0, deliveredImpressions: 40 } });
    const legacyPre = fx.placement({ campaign: { slotPercent: null, slotPosition: 0, deliveredImpressions: 10 } });
    await fx.seed(db(), fx.together(late, pre, legacyPre));
    expect((await open(live())).body.ad.adKey).toBe(adKey(legacyPre.campaign._id));
  });

  test('a legacy roll sold at a number of seconds in is not a pre-roll, so it does not open a stream', async () => {
    await fx.seed(db(), fx.placement({ campaign: { slotPercent: null, slotPosition: 30 } }).all);
    expect((await open(live({ ticker: false }))).body.reason).toBe('no_eligible_campaign');
  });

  test('a page that cannot play a pre-roll gets the ticker only; banners never run over a stream', async () => {
    await fx.seed(db(), fx.together(fx.placement(), fx.placement({ format: 'video_banner' }), fx.placement({ format: 'video_ticker' })));
    const res = await open(live({ preroll: false })).expect(200);
    expect(res.body.ad).toBeNull();
    expect(res.body.banner).toBeNull();
    expect(res.body.ticker).toBeTruthy();
  });

  test('only rolls booked at a listed position play before a stream; a legacy roll only if sold as a pre-roll', async () => {
    const narrow = isolatedApp({ AD_LIVE_ROLL_SLOT_PERCENTS: '0' });
    await fx.seed(db(), fx.placement({ campaign: { slotPercent: 50 } }).all);
    expect((await open(live({ ticker: false }), { to: narrow })).body.reason).toBe('no_eligible_campaign');
    await fx.seed(db(), fx.placement({ campaign: { slotPercent: null, slotPosition: 0 } }).all);
    expect((await open(live(), { to: narrow })).body.ad).toBeTruthy();
  });

  test('length targeting treats a stream as AD_LIVE_ASSUMED_SECONDS long', async () => {
    await fx.seed(db(), fx.placement({ campaign: { minVideoSeconds: config.AD_LIVE_ASSUMED_SECONDS + 1 } }).all);
    expect((await open(live())).body.reason).toBe('no_eligible_campaign');
  });

  test('the streaming server is asked whether this host is live in this room', async () => {
    await fx.seed(db(), fx.placement({ campaign: { slotPercent: 0 } }).all);
    await open(live({ owner: 'Host1' })).expect(200);
    expect(liveRoom).toHaveBeenCalledWith('host1', 'room-1');
  });

  test('a room that is not a live stream by that host gets nothing: no invented rooms drawing streamer money', async () => {
    await fx.seed(db(), fx.together(fx.placement({ campaign: { slotPercent: 0 } }), fx.placement({ format: 'video_ticker' })));
    liveRoom.mockResolvedValue(null);
    expect((await open(live())).body).toEqual({ ad: null, reason: 'not_live' });
    expect(await db().collection(SESSIONS).countDocuments({ surface: 'live' })).toBe(0);
  });

  test('a watch page is never asked about: the check is for streams only', async () => {
    await fx.seed(db(), fx.placement().all);
    await open({ owner: 'creator1', permlink: 'vid-1', capId: hex(8) });
    expect(liveRoom).not.toHaveBeenCalled();
  });

  test('with live ads switched off a stream gets nothing', async () => {
    const off = isolatedApp({ AD_LIVE_ENABLED: 'false' });
    expect((await open(live(), { to: off })).body).toEqual({ ad: null, reason: 'live_ads_off' });
  });
});

describe('audio: one spoken or uploaded spot per listener per quiet period', () => {
  let track;
  beforeEach(async () => {
    track = { owner: 'creator1', permlink: 'track-1', post_permlink: 'my-song', status: 'published', duration: 240 };
    await db().collection('embed-audio').insertOne(track);
  });
  const listen = (over = {}) => ({ surface: 'audio', audioSpot: true, owner: 'creator1', permlink: 'track-1', capId: hex(8), ...over });
  /** An audio_spot flight whose clip exists on disk. */
  async function clipFlight(over = {}) {
    const file = `${hex(20)}.mp3`;
    fs.writeFileSync(path.join(env.AD_TTS_DIR, file), 'ID3');
    const p = fx.placement({ format: 'audio_spot', creative: { audioFile: file, durationSeconds: 8.4 }, campaign: { slotPercent: 25 }, ...over });
    await fx.seed(db(), p.all);
    return { ...p, file };
  }
  /** A ticker flight that is also read aloud, with its speech rendered. */
  async function spokenTicker(over = {}) {
    const p = fx.placement({ format: 'video_ticker', campaign: { audioSpot: true, slotPercent: 10 }, ...over });
    await fx.seed(db(), p.all);
    const hash = ttsHash(spokenText(p.creative, p.advertiser));
    fs.writeFileSync(path.join(env.AD_TTS_DIR, `${hash}.mp3`), 'ID3');
    await db().collection('ad_tts_renders').insertOne({ _id: hash, hash, file: `${hash}.mp3`, durationSeconds: 7.2, status: 'ready' });
    return { ...p, hash };
  }

  test('an uploaded clip plays at the booked point, with its link and no text to crawl', async () => {
    const p = await clipFlight();
    const res = await open(listen({ viewer: 'listener1' })).expect(200);
    const sid = fx.sidOf(res.body.audioAd.shownUrl);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ ad: null, reason: null });
    expect(res.body.audioAd).toMatchObject({
      audioUrl: expect.stringMatching(new RegExp(`/m/tts/${p.file}$`)), durationSeconds: 8.4, positionPercent: 25, message: '', style: 'hold',
      account: 'acme', productName: 'Acme Widgets', clickUrl: expect.stringMatching(new RegExp(`/m/${sid}/tc$`)), adKey: adKey(p.campaign._id),
      capMinutes: config.AD_TICKER_FREQUENCY_CAP_MINUTES, label: 'Ad',
    });
    expect(await db().collection(SESSIONS).findOne({ sid })).toMatchObject({
      surface: 'audio', owner: 'creator1', permlink: 'my-song', audioPermlink: 'track-1', viewer: 'listener1', campaignId: null,
      ticker: { campaignId: p.campaign._id, seconds: 9, tts: p.file.replace('.mp3', '') },
    });
  });

  test('a ticker the advertiser chose to have read aloud plays its rendered speech, words shown', async () => {
    const p = await spokenTicker();
    const res = await open(listen()).expect(200);
    expect(res.body.audioAd).toMatchObject({
      audioUrl: expect.stringMatching(new RegExp(`/m/tts/${p.hash}\\.mp3$`)),
      durationSeconds: 7.2, message: p.creative.message, style: 'crawl', positionPercent: 10,
    });
  });

  test('a ticker that was not opted in to audio stays on video', async () => {
    await fx.seed(db(), fx.placement({ format: 'video_ticker' }).all);
    expect((await open(listen())).body).toEqual({ ad: null, reason: 'no_campaign' });
  });

  test('a ticker whose speech is not rendered yet is simply not offered', async () => {
    await fx.seed(db(), fx.placement({ format: 'video_ticker', campaign: { audioSpot: true } }).all);
    expect((await open(listen())).body).toEqual({ ad: null, reason: 'no_rendered_audio' });
  });

  test('a clip whose file is missing on disk is not offered either', async () => {
    await fx.seed(db(), fx.placement({ format: 'audio_spot', creative: { audioFile: `${'b'.repeat(40)}.mp3` } }).all);
    expect((await open(listen())).body.reason).toBe('no_rendered_audio');
  });

  test('the least-delivered playable flight goes first', async () => {
    await clipFlight({ campaign: { deliveredImpressions: 30, slotPercent: 0 } });
    const fresh = await spokenTicker({ campaign: { audioSpot: true, deliveredImpressions: 1, slotPercent: 10 } });
    expect((await open(listen())).body.audioAd.adKey).toBe(adKey(fresh.campaign._id));
  });

  describe('the 15-minute quiet period', () => {
    const heard = async (who, minutes, extraMs = 0) => {
      const sid = hex(16);
      await db().collection(SESSIONS).insertOne({ sid, surface: 'audio', ...who, startedAt: fx.ago(minutes * fx.MIN + extraMs) });
      await db().collection(config.AD_IMPRESSIONS_COLLECTION).insertOne({ sid, campaignId: new ObjectId(), completed: true });
    };

    test('a signed-in listener who heard any audio ad in the last 15 minutes hears no other', async () => {
      await clipFlight();
      await heard({ viewer: 'listener1' }, config.AD_AUDIO_COOLDOWN_MINUTES - 1);
      expect((await open(listen({ viewer: 'listener1' }))).body).toEqual({ ad: null, reason: 'cooldown', cooldownMinutes: 15 });
      expect((await open(listen({ viewer: 'listener2' }))).body.audioAd).toBeTruthy();
    });

    test('exactly 15 minutes later it is still quiet; a millisecond after, the next spot may play', async () => {
      await clipFlight();
      await heard({ viewer: 'listener1' }, config.AD_AUDIO_COOLDOWN_MINUTES);
      expect((await open(listen({ viewer: 'listener1' }))).body.reason).toBe('cooldown');
      await heard({ viewer: 'listener2' }, config.AD_AUDIO_COOLDOWN_MINUTES, 1);
      expect((await open(listen({ viewer: 'listener2' }))).body.audioAd).toBeTruthy();
    });

    test('an anonymous listener is kept apart by capId, for as long as the page lives', async () => {
      await clipFlight();
      const id = hex(8);
      await heard({ capId: id }, 3);
      expect((await open(listen({ capId: id }))).body.reason).toBe('cooldown');
    });

    test('a spot handed out but never heard to the end does not start it', async () => {
      await clipFlight();
      await db().collection(SESSIONS).insertOne({ sid: hex(16), surface: 'audio', viewer: 'listener1', startedAt: fx.ago(fx.MIN) });
      expect((await open(listen({ viewer: 'listener1' }))).body.audioAd).toBeTruthy();
    });

    test('with the quiet period set to 0 there is none', async () => {
      const none = isolatedApp({ AD_AUDIO_COOLDOWN_MINUTES: '0' });
      await clipFlight();
      await heard({ viewer: 'listener1' }, 1);
      expect((await open(listen({ viewer: 'listener1' }), { to: none })).body.audioAd).toBeTruthy();
    });
  });

  test('a ticker heard on audio counts against the same cap as one seen on a video', async () => {
    const p = await spokenTicker();
    await delivered(p.campaign, { viewer: 'listener1' }, config.AD_TICKER_FREQUENCY_CAP_MINUTES - 1, (c) => ({ ticker: { campaignId: c._id } }));
    const res = await open(listen({ viewer: 'listener1' }), { to: isolatedApp({ AD_AUDIO_COOLDOWN_MINUTES: '0' }) });
    expect(res.body.reason).toBe('no_eligible_campaign');
  });

  test.each([
    ['the advertiser is not approved', { advertiser: { status: 'pending' } }],
    ['the listener is outside the booked market', { campaign: { markets: ['JP'] } }],
    ['the track is shorter than the flight targets', { campaign: { minVideoSeconds: 600 } }],
    ['the track is longer than the flight targets', { campaign: { maxVideoSeconds: 60 } }],
  ])('no spot when %s', async (_label, over) => {
    await clipFlight(over);
    expect((await open(listen({ country: 'de' }))).body.reason).toBe('no_eligible_campaign');
  });

  test('a track of unknown length never matches a length-targeted flight', async () => {
    await db().collection('embed-audio').updateOne({ permlink: 'track-1' }, { $unset: { duration: '' } });
    await clipFlight({ campaign: { minVideoSeconds: 10 } });
    expect((await open(listen())).body.reason).toBe('no_eligible_campaign');
  });

  test.each([
    ['a player that cannot play one', { audioSpot: false }, 'no_audio_spot'],
    ['a track that does not exist', { permlink: 'nope' }, 'no_audio'],
  ])('nothing for %s', async (_label, over, reason) => {
    await clipFlight();
    expect((await open(listen(over))).body).toEqual({ ad: null, reason });
  });

  test('a track that is not published carries nothing', async () => {
    await db().collection('embed-audio').updateOne({ permlink: 'track-1' }, { $set: { status: 'processing' } });
    await clipFlight();
    expect((await open(listen())).body.reason).toBe('no_audio');
  });

  test('the creator\'s "Ads on your audio" decides', async () => {
    await clipFlight();
    await db().collection(config.AD_CREATOR_PREFS_COLLECTION).insertOne({ _id: 'creator1', audioEnabled: false });
    expect((await open(listen())).body).toEqual({ ad: null, reason: 'creator_audio_off', premium: false });
  });

  test('while audio spots are a trial, only the listed owners carry them; outside episodes none at all', async () => {
    const trial = isolatedApp({ AD_AUDIO_TICKER_ALLOWED_OWNERS: 'badadib' });
    await clipFlight();
    expect((await open(listen(), { to: trial })).body).toEqual({ ad: null, reason: 'owner_not_in_trial' });
  });

  test('with audio spots switched off, nothing plays', async () => {
    const off = isolatedApp({ AD_AUDIO_TICKER_ENABLED: 'false' });
    await clipFlight();
    expect((await open(listen(), { to: off })).body).toEqual({ ad: null, reason: 'audio_ads_off' });
  });

  describe('an outside podcast episode that is really 3Speak audio', () => {
    test('is played as the creator\'s own track, found through its Hive post', async () => {
      await clipFlight();
      const res = await open(listen({ permlink: undefined, postPermlink: 'my-song' })).expect(200);
      expect(await sessionOf(res)).toMatchObject({ owner: 'creator1', audioPermlink: 'track-1', permlink: 'my-song' });
    });

    test('with no audio behind the post, nothing plays; a malformed post is a 400', async () => {
      await clipFlight();
      expect((await open(listen({ permlink: undefined, postPermlink: 'unknown-post' }))).body).toEqual({ ad: null, reason: 'no_audio' });
      await open(listen({ permlink: undefined, postPermlink: 'Bad Post!' })).expect(400);
    });
  });

  describe('an outside episode with no 3Speak creator', () => {
    const feedId = new ObjectId();
    const episodeId = `${feedId}:${'A'.repeat(16)}`;
    beforeEach(async () => {
      await db().collection('podcast_feeds').insertOne({ _id: feedId, private: false });
      await db().collection('podcast_episodes').insertOne({ _id: episodeId, feed_id: String(feedId), duration: 1800 });
    });
    const episode = (over = {}) => ({ surface: 'audio', audioSpot: true, episodeId, capId: hex(8), ...over });

    test('carries a spot whose creator share stays with the platform', async () => {
      await clipFlight();
      const res = await open(episode()).expect(200);
      expect(await sessionOf(res)).toMatchObject({ owner: null, permlink: null, audioPermlink: null, podcastEpisode: episodeId, podcastFeed: String(feedId) });
    });

    test('an episode we do not know has nothing', async () => {
      await clipFlight();
      expect((await open(episode({ episodeId: `${new ObjectId()}:${'B'.repeat(16)}` }))).body).toEqual({ ad: null, reason: 'no_audio' });
    });

    test('a private (paid or password) feed carries no ads', async () => {
      await clipFlight();
      await db().collection('podcast_feeds').updateOne({ _id: feedId }, { $set: { private: true } });
      expect((await open(episode())).body).toEqual({ ad: null, reason: 'private_feed' });
    });

    test('an episode whose feed is gone is treated as private', async () => {
      await clipFlight();
      await db().collection('podcast_feeds').deleteMany({});
      expect((await open(episode())).body.reason).toBe('private_feed');
    });

    test('a malformed episode id is a 400', async () => {
      await open(episode({ episodeId: 'not-an-episode' })).expect(400);
    });

    test('a Pro listener hears none on an outside episode either', async () => {
      const fresh = isolatedApp({});
      await clipFlight();
      await db().collection(config.PREMIUM_USERS_COLLECTION).insertOne({ username: 'pro2', premium: true });
      expect((await open(episode({ viewer: 'pro2' }), { to: fresh })).body).toEqual({ ad: null, reason: 'premium_viewer', premium: true });
    });

    test('can be switched off on its own', async () => {
      const off = isolatedApp({ AD_AUDIO_EXTERNAL_ENABLED: 'false' });
      expect((await open(episode(), { to: off })).body).toEqual({ ad: null, reason: 'external_audio_ads_off' });
    });
  });

  test('a warm-up account\'s own track carries ads, with no owner to credit', async () => {
    warmupAudio.mockResolvedValue({ owners: ['creator1'], allowed: ['track-1'] });
    await clipFlight();
    const res = await open(listen()).expect(200);
    expect(await sessionOf(res)).toMatchObject({ owner: null, permlink: null, audioPermlink: 'track-1', warmupOwner: 'creator1' });
  });
});
