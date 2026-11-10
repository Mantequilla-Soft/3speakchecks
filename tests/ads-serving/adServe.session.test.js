/**
 * routes/adServe.js, POST /m/session on the watch surface: which ad (if any) one
 * playback gets. Ported from scripts/test-ad-serving.cjs (trial gate, selection,
 * frequency cap, premium) and scripts/test-ad-banner-video.cjs (a video banner rides
 * the session as a manifest, not an image).
 *
 * The gates, in the order the route runs them: stage, rate limit, datacenter, crawler, input,
 * one ad per network per video per day, the creator's own connection, the eligibility
 * decision, the quiet period, short videos; then the approval gate, servability, the
 * per-format caps, markets and length targeting; then least-delivered first, one
 * placement per format.
 */
const crypto = require('crypto');
const request = require('supertest');
const fx = require('./_fixtures');

jest.mock('child_process', () => require('./_fixtures').childProcessMock());
jest.mock('../../utils/adGateways', () => ({ ...jest.requireActual('../../utils/adGateways'), startGatewayProbe: jest.fn() }));
jest.mock('../../utils/warmupAudio', () => ({ warmupAudio: jest.fn(async () => ({ owners: [], allowed: [] })) }));
fx.useAdEnv();
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const config = require('../../utils/config');

const serve = require('../../routes/adServe');
const app = buildApp(['/m', serve]);
const db = testDb.use();
fx.freezeTime();
beforeEach(() => jest.setSystemTime(fx.NOW));

const SESSIONS = 'ad_sessions';
const adKey = (id) => crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 12);
const capId = () => crypto.randomBytes(8).toString('hex');
const body = (over = {}) => ({ owner: 'creator1', permlink: 'vid-1', manifestUrl: fx.contentManifest(), capId: capId(), ...over });
const open = (over = {}, { ip = fx.freshIp(), headers = {}, to = app } = {}) => request(to).post('/m/session')
  .set('X-Real-IP', ip).set(headers).send(body(over));
const isolatedApp = (env) => buildApp(['/m', fx.isolatedModule('../../routes/adServe', env)]);
const sessionOf = (res) => db().collection(SESSIONS).findOne({ sid: fx.sidOf(JSON.stringify(res.body)) });
/** A delivered impression of `campaign` to `who` ({ viewer } or { capId }), `minutes` ago. */
async function seen(campaign, who, minutes, field = 'campaignId') {
  const sid = crypto.randomBytes(16).toString('hex');
  const doc = { sid, ...who, startedAt: fx.ago(minutes * fx.MIN) };
  if (field === 'campaignId') doc.campaignId = campaign._id;
  else doc[field] = { campaignId: campaign._id };
  await db().collection(SESSIONS).insertOne(doc);
  await db().collection(config.AD_IMPRESSIONS_COLLECTION).insertOne({ sid, campaignId: campaign._id, completed: true });
}

describe('a playback that carries an ad', () => {
  test('gets a roll spliced into its own playlist, disclosed, with a counted click-through', async () => {
    const p = fx.placement({ campaign: { slotPercent: 25, projectName: 'Acme Widgets' } });
    await fx.seed(db(), p.all);
    const res = await open({ viewer: 'Viewer1', country: 'de', app: 'Partner_App!' }).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');

    const sid = fx.sidOf(res.body.ad.manifestUrl);
    expect(res.body.ad).toMatchObject({
      manifestUrl: expect.stringMatching(new RegExp(`/m/${sid}\\.m3u8$`)),
      positionPercent: 25, durationSeconds: 12, label: 'Sponsored', adKey: adKey(p.campaign._id), advertiser: 'Acme Widgets',
      brand: { account: 'acme', productName: 'Acme Widgets', logoUrl: p.advertiser.logoUrl, slogan: p.advertiser.slogan, clickUrl: expect.stringMatching(new RegExp(`/m/${sid}/c$`)) },
    });
    expect(res.body).toMatchObject({ banner: null, ticker: null, reason: null, cooldownMinutes: 0, cooldownUntil: null });
    // Nothing a filter list could match.
    expect(JSON.stringify(res.body.ad.manifestUrl)).not.toMatch(/advert|vast|preroll|\bad\b/i);

    expect(await db().collection(SESSIONS).findOne({ sid })).toMatchObject({
      campaignId: p.campaign._id, creativeId: p.creative._id, owner: 'creator1', permlink: 'vid-1', viewer: 'viewer1', country: 'DE',
      app: 'partnerapp', slotPercent: 25, clickUrl: 'https://acme.example/', bannerMode: 'burn', banner: null, ticker: null, adFirstFetchAt: null,
      adManifestUrl: `https://ipfs-3speak.b-cdn.net/ipfs/${p.creative.manifestCid}/manifest.m3u8`,
      contentManifestUrl: fx.contentManifest(),
      expiresAt: fx.fromNow(config.AD_SESSION_TTL_MINUTES * fx.MIN),
    });
  });

  test('a playlist handed over through the gateway proxy is stored unwrapped', async () => {
    await fx.seed(db(), fx.placement().all);
    const inner = fx.contentManifest('QmInner');
    const res = await open({ manifestUrl: `https://play.example/hls?u=${encodeURIComponent(inner)}` }).expect(200);
    expect((await sessionOf(res)).contentManifestUrl).toBe(inner);
  });

  test('an advertiser with no https website gets no click-through', async () => {
    await fx.seed(db(), fx.placement({ advertiser: { website: 'acme.example' } }).all);
    const res = await open().expect(200);
    expect(res.body.ad.brand.clickUrl).toBeNull();
    expect((await sessionOf(res)).clickUrl).toBeNull();
  });

  test('a roll, a banner and a ticker from three advertisers can share one playback', async () => {
    const roll = fx.placement();
    const banner = fx.placement({ format: 'video_banner', advertiser: { hiveAccount: 'bannerco', projectName: 'Banner Co' }, campaign: { slotPercent: 50, spotSeconds: 8 } });
    const ticker = fx.placement({
      format: 'video_ticker',
      advertiser: { hiveAccount: 'tickerco', projectName: 'Ticker Co' },
      creative: { style: 'hold' },
      campaign: { slotPercent: 10, spotSeconds: 9 },
    });
    await fx.seed(db(), fx.together(roll, banner, ticker));
    const res = await open({ ticker: true }).expect(200);
    const sid = fx.sidOf(res.body.ad.manifestUrl);

    expect(res.body.banner).toMatchObject({
      overlay: null, manifestUrl: res.body.ad.manifestUrl, adKey: adKey(banner.campaign._id), positionPercent: 50, durationSeconds: 8,
      brand: { account: 'bannerco', clickUrl: expect.stringMatching(new RegExp(`/m/${sid}/bc$`)) },
      placement: { widthPct: 60, maxHeightPct: 15, bottomPct: 6, aspect: 6.0667 },
    });
    expect(res.body.ticker).toMatchObject({
      message: ticker.creative.message, style: 'hold', account: 'tickerco', productName: 'Ticker Co',
      clickUrl: expect.stringMatching(new RegExp(`/m/${sid}/tc$`)), shownUrl: expect.stringMatching(new RegExp(`/m/${sid}/ticker-shown$`)),
      positionPercent: 10, durationSeconds: 9, adKey: adKey(ticker.campaign._id), capMinutes: 5, label: 'Ad',
    });
    expect(await db().collection(SESSIONS).findOne({ sid })).toMatchObject({
      banner: { campaignId: banner.campaign._id, imageUrl: banner.creative.imageUrl, videoUrl: null, seconds: 8, clickUrl: 'https://acme.example/' },
      ticker: { campaignId: ticker.campaign._id, seconds: 9, clickUrl: ticker.creative.clickUrl },
    });
  });

  test('a banner-only playback still gets the playlist, with the banner as the only placement', async () => {
    await fx.seed(db(), fx.placement({ format: 'video_banner' }).all);
    const res = await open().expect(200);
    expect(res.body.ad).toBeNull();
    expect(res.body.banner.manifestUrl).toMatch(/\/m\/[0-9a-f]{32}\.m3u8$/);
  });

  test('a page that draws the banner itself is handed the creative and its own disclosure', async () => {
    await fx.seed(db(), fx.placement({ format: 'video_banner' }).all);
    const res = await open({ bannerOverlay: 'true' }).expect(200);
    expect(res.body.banner.overlay).toMatchObject({ imageUrl: expect.stringMatching(/^https:\/\/acme\.example\/banner/), videoUrl: null, label: 'Ad' });
    expect((await sessionOf(res)).bannerMode).toBe('overlay');
  });

  test('a moving banner is carried as a manifest, for the burn and for an overlay page', async () => {
    const p = fx.placement({ format: 'video_banner', creative: { kind: 'video', manifestCid: fx.CID('motion'), imageUrl: undefined, imageWidth: undefined, imageHeight: undefined } });
    await fx.seed(db(), p.all);
    const res = await open({ bannerOverlay: true }, { headers: { Origin: 'https://3speak.tv' } }).expect(200);
    expect(res.body.banner.overlay).toMatchObject({ imageUrl: null, videoUrl: expect.stringMatching(/\/ipfs\/Qmmotion.*\/manifest\.m3u8$/) });
    expect(res.body.banner.placement.aspect).toBeNull();
    expect((await sessionOf(res)).banner.videoUrl).toBe(`https://ipfs-3speak.b-cdn.net/ipfs/${fx.CID('motion')}/manifest.m3u8`);
  });
});

describe('which campaign is chosen', () => {
  test('the least-delivered eligible flight goes first: delivery is evened out, not auctioned', async () => {
    const busy = fx.placement({ campaign: { deliveredImpressions: 50 } });
    const quiet = fx.placement({ campaign: { deliveredImpressions: 3 } });
    await fx.seed(db(), fx.together(busy, quiet));
    expect((await open().expect(200)).body.ad.adKey).toBe(adKey(quiet.campaign._id));
  });

  test.each([
    ['an advertiser still pending review', { advertiser: { status: 'pending' } }],
    ['a rejected advertiser', { advertiser: { status: 'rejected' } }],
    ['a creative still in review', { creative: { status: 'review' } }],
    ['an unpaid flight', { campaign: { paidHbd: 0 } }],
    ['a paused flight', { campaign: { status: 'paused' } }],
    ['a flight not started yet', { campaign: { startAt: fx.fromNow(fx.HOUR) } }],
    ['a flight that has ended', { campaign: { endAt: fx.ago(1) } }],
    ['a still booked as a roll', { creative: { kind: 'image', imageUrl: 'https://x/y.png' } }],
    ['an audio spot, which is only ever heard', { format: 'audio_spot' }],
  ])('%s never serves', async (_label, over) => {
    await fx.seed(db(), fx.placement(over).all);
    const res = await open().expect(200);
    expect(res.body.ad).toBeNull();
    expect(res.body.reason).toMatch(/no_eligible_campaign|no_campaign/);
  });

  test('a flight whose advertiser reference is missing fails closed', async () => {
    const p = fx.placement();
    await fx.seed(db(), { ...p.all, campaigns: [{ ...p.campaign, advertiserRef: null }] });
    expect((await open()).body.reason).toBe('no_eligible_campaign');
  });

  test('no live flight at all says so', async () => {
    expect((await open().expect(200)).body).toEqual({ ad: null, reason: 'no_campaign' });
  });

  test.each([
    ['a viewer in a booked market', ['DE', 'AT'], 'de', true],
    ['a viewer outside every booked market', ['DE', 'AT'], 'us', false],
    ['a viewer whose country is unknown', ['DE'], undefined, true],
  ])('market targeting: %s', async (_label, markets, country, served) => {
    await fx.seed(db(), fx.placement({ campaign: { markets } }).all);
    expect(!!(await open({ country })).body.ad).toBe(served);
  });

  describe('length targeting reads the stored duration, never the request', () => {
    const targeted = { campaign: { minVideoSeconds: 120, maxVideoSeconds: 900 } };
    test.each([
      ['inside the window', 600, true],
      ['too short', 60, false],
      ['too long', 1200, false],
    ])('a video %s', async (_label, duration, served) => {
      await fx.seed(db(), fx.placement(targeted).all);
      await db().collection('embed-video').insertOne({ owner: 'creator1', permlink: 'vid-1', duration });
      expect(!!(await open({ duration: 600 })).body.ad).toBe(served);
    });

    test('a legacy upload with only a `videos` row is measured from that', async () => {
      await fx.seed(db(), fx.placement(targeted).all);
      await db().collection('videos').insertOne({ owner: 'creator1', permlink: 'vid-1', duration: 300 });
      expect((await open()).body.ad).not.toBeNull();
    });

    test('an unknown length is not evidence of a match', async () => {
      await fx.seed(db(), fx.placement(targeted).all);
      expect((await open()).body.reason).toBe('no_eligible_campaign');
    });
  });

  test('a short opened in a watch page or the embed never gets a watch-surface ad', async () => {
    await fx.seed(db(), fx.placement().all);
    await db().collection('embed-video').insertOne({ owner: 'creator1', permlink: 'vid-1', duration: 65, short: true });
    expect((await open().expect(200)).body).toEqual({ ad: null, reason: 'short_video' });
  });
});

describe('frequency caps count ads that were actually delivered', () => {
  test('a signed-in viewer is not shown the same roll again inside AD_FREQUENCY_CAP_MINUTES', async () => {
    const p = fx.placement();
    await fx.seed(db(), p.all);
    await seen(p.campaign, { viewer: 'viewer1' }, config.AD_FREQUENCY_CAP_MINUTES - 1);
    expect((await open({ viewer: 'viewer1' })).body.reason).toBe('no_eligible_campaign');
    // Somebody else still gets it.
    expect((await open({ viewer: 'viewer2' })).body.ad).not.toBeNull();
  });

  test('after the window the same roll may come round again', async () => {
    const p = fx.placement();
    await fx.seed(db(), p.all);
    await seen(p.campaign, { viewer: 'viewer1' }, config.AD_FREQUENCY_CAP_MINUTES + 1);
    expect((await open({ viewer: 'viewer1' })).body.ad).not.toBeNull();
  });

  test('a placement that was chosen but never played does not burn the cap', async () => {
    const p = fx.placement();
    await fx.seed(db(), p.all);
    await db().collection(SESSIONS).insertOne({ sid: 'f'.repeat(32), viewer: 'viewer1', campaignId: p.campaign._id, startedAt: fx.ago(fx.MIN) });
    expect((await open({ viewer: 'viewer1' })).body.ad).not.toBeNull();
  });

  test('an anonymous viewer is capped by the page\'s capId', async () => {
    const p = fx.placement();
    await fx.seed(db(), p.all);
    const id = capId();
    await seen(p.campaign, { capId: id }, 2);
    expect((await open({ capId: id })).body.reason).toBe('no_eligible_campaign');
    expect((await open({ capId: 'not-hex!' })).body.ad).not.toBeNull();
  });

  test('ads the page says it already showed are skipped; a forged list can only cost it ads', async () => {
    const a = fx.placement({ campaign: { deliveredImpressions: 0 } });
    const b = fx.placement({ campaign: { deliveredImpressions: 5 } });
    await fx.seed(db(), fx.together(a, b));
    const res = await open({ recentAdKeys: [adKey(a.campaign._id), 'zzzz', 42] });
    expect(res.body.ad.adKey).toBe(adKey(b.campaign._id));
  });

  test('a banner has its own, shorter window', async () => {
    const banner = fx.placement({ format: 'video_banner' });
    await fx.seed(db(), banner.all);
    await seen(banner.campaign, { viewer: 'viewer1' }, config.AD_BANNER_FREQUENCY_CAP_MINUTES - 1, 'banner');
    expect((await open({ viewer: 'viewer1' })).body.reason).toBe('no_eligible_campaign');
    await db().collection(SESSIONS).deleteMany({});
    await seen(banner.campaign, { viewer: 'viewer1' }, config.AD_BANNER_FREQUENCY_CAP_MINUTES + 1, 'banner');
    expect((await open({ viewer: 'viewer1' })).body.banner).not.toBeNull();
  });

  test('a ticker has its own window, the shortest of the three', async () => {
    const ticker = fx.placement({ format: 'video_ticker' });
    await fx.seed(db(), ticker.all);
    await seen(ticker.campaign, { viewer: 'viewer1' }, config.AD_TICKER_FREQUENCY_CAP_MINUTES - 1, 'ticker');
    expect((await open({ viewer: 'viewer1', ticker: true })).body.reason).toBe('no_eligible_campaign');
    await db().collection(SESSIONS).deleteMany({});
    await seen(ticker.campaign, { viewer: 'viewer1' }, config.AD_TICKER_FREQUENCY_CAP_MINUTES + 1, 'ticker');
    expect((await open({ viewer: 'viewer1', ticker: true })).body.ticker).not.toBeNull();
  });
});

describe('the creator\'s and the client\'s say', () => {
  test('a creator who takes overlays only gets the banner and never the roll', async () => {
    await fx.seed(db(), fx.together(fx.placement(), fx.placement({ format: 'video_banner' })));
    await db().collection(config.AD_CREATOR_PREFS_COLLECTION).insertOne({ _id: 'creator1', rollsEnabled: false });
    const res = await open().expect(200);
    expect(res.body.ad).toBeNull();
    expect(res.body.banner).not.toBeNull();
  });

  test.each([
    ['the creator turned ads off', async () => db().collection(config.AD_CREATOR_PREFS_COLLECTION).insertOne({ _id: 'creator1', adsEnabled: false }), 'creator_opted_out'],
    ['this video has ads off', async () => db().collection(config.AD_VIDEO_OPTOUTS_COLLECTION).insertOne({ _id: 'creator1/vid-1', mode: 'off' }), 'video_opted_out'],
  ])('no ad when %s', async (_label, arrange, reason) => {
    await fx.seed(db(), fx.placement().all);
    await arrange();
    expect((await open()).body).toEqual({ ad: null, reason, premium: false });
  });

  test('the creator never gets an ad on their own video', async () => {
    await fx.seed(db(), fx.placement().all);
    expect((await open({ viewer: 'Creator1' })).body).toMatchObject({ ad: null, reason: 'own_video' });
  });

  test('a Pro subscriber gets none, and the answer is echoed so the player can flag the session', async () => {
    const fresh = isolatedApp({});
    await fx.seed(db(), fx.placement().all);
    await db().collection(config.PREMIUM_USERS_COLLECTION).insertOne({ username: 'pro1', premium: true });
    expect((await open({ viewer: 'pro1' }, { to: fresh })).body).toEqual({ ad: null, reason: 'premium_viewer', premium: true });
  });

  test('a ticker goes only to a page that can draw one', async () => {
    await fx.seed(db(), fx.placement({ format: 'video_ticker' }).all);
    expect((await open()).body.reason).toBe('no_eligible_campaign');
    expect((await open({ ticker: 'true' })).body.ticker).not.toBeNull();
  });

  test('while tickers are limited to some creators, nobody else carries one', async () => {
    const limited = isolatedApp({ AD_TICKER_ALLOWED_OWNERS: 'badadib' });
    await fx.seed(db(), fx.placement({ format: 'video_ticker' }).all);
    expect((await open({ ticker: true }, { to: limited })).body.ticker).toBeFalsy();
    expect((await open({ ticker: true, owner: 'badadib' }, { to: limited })).body.ticker).not.toBeNull();
  });

  test('a self-promo flight appears only on the creators allowed to carry them', async () => {
    const limited = isolatedApp({ AD_SELFPROMO_ALLOWED_OWNERS: 'badadib' });
    await fx.seed(db(), fx.placement({ campaign: { selfPromo: true } }).all);
    expect((await open({}, { to: limited })).body.reason).toBe('no_campaign');
    expect((await open({ owner: 'badadib' }, { to: limited })).body.ad).not.toBeNull();
  });

  test('while ads are a closed trial, only the trial owners\' videos carry them', async () => {
    const trial = isolatedApp({ ADS_ALLOWED_OWNERS: 'badadib' });
    await fx.seed(db(), fx.placement().all);
    expect((await open({}, { to: trial })).body).toMatchObject({ ad: null, reason: 'owner_not_in_trial' });
  });
});

describe('the quiet period after an ad (AD_COOLDOWN_MINUTES)', () => {
  let quiet;
  beforeAll(() => { quiet = isolatedApp({ AD_COOLDOWN_MINUTES: '10' }); });

  test('a served ad tells the page how long to stay quiet', async () => {
    await fx.seed(db(), fx.placement().all);
    const res = await open({}, { to: quiet }).expect(200);
    expect(res.body).toMatchObject({ cooldownMinutes: 10, cooldownUntil: Date.now() + 10 * fx.MIN });
  });

  test('an anonymous page inside its quiet period gets none; a claim from the future is ignored', async () => {
    await fx.seed(db(), fx.placement().all);
    expect((await open({ lastAdAt: Date.now() - 4 * fx.MIN }, { to: quiet })).body).toEqual({ ad: null, reason: 'cooldown', cooldownMinutes: 10 });
    expect((await open({ lastAdAt: Date.now() + 5 * fx.MIN }, { to: quiet })).body.ad).not.toBeNull();
    expect((await open({ lastAdAt: Date.now() - 11 * fx.MIN }, { to: quiet })).body.ad).not.toBeNull();
  });

  test('a signed-in viewer is checked against their own delivered sessions', async () => {
    await fx.seed(db(), fx.placement().all);
    await db().collection(SESSIONS).insertOne({ sid: 'a'.repeat(32), viewer: 'viewer1', startedAt: fx.ago(3 * fx.MIN), adStartAt: 0 });
    expect((await open({ viewer: 'viewer1' }, { to: quiet })).body.reason).toBe('cooldown');
    expect((await open({ viewer: 'viewer2' }, { to: quiet })).body.ad).not.toBeNull();
  });
});

describe('caps keyed on the caller\'s network', () => {
  test('one ad per network per video per day, marked only once the ad has really played', async () => {
    await fx.seed(db(), fx.placement().all);
    const first = await open({}, { ip: '198.51.100.20' }).expect(200);
    // Handed out but not played: the next page load from that network still gets one.
    const second = await open({}, { ip: '198.51.100.21' }).expect(200);
    expect(second.body.ad).not.toBeNull();

    // The first one plays to its end (the player reports the watched seconds).
    const sid = fx.sidOf(first.body.ad.manifestUrl);
    await db().collection(SESSIONS).updateOne({ sid }, { $set: { adFirstFetchAt: fx.ago(20 * 1000), adDurationSeconds: 12 } });
    await request(app).post(`/m/${sid}/w`).send({ seconds: 12 }).expect(200, { ok: true, counted: true, credited: 12 });

    expect((await open({}, { ip: '198.51.100.99' })).body).toEqual({ ad: null, reason: 'repeat_viewer' });
    expect((await open({ permlink: 'another-video' }, { ip: '198.51.100.99' })).body.ad).not.toBeNull();
    expect((await open({}, { ip: '198.51.101.5' })).body.ad).not.toBeNull();
    // Kept in Mongo, so a restart does not hand every address a fresh first ad.
    expect(await db().collection('ad_repeat_gate').countDocuments({ _id: /^s:/ })).toBe(1);
    expect((await open({}, { ip: '198.51.100.7', to: isolatedApp({}) })).body.reason).toBe('repeat_viewer');
    fx.advance(24 * fx.HOUR + 1);
    expect((await open({}, { ip: '198.51.100.7', to: isolatedApp({}) })).body.ad).not.toBeNull();
  });

  test('the platform\'s own test channel is exempt from the network caps', async () => {
    const exempt = isolatedApp({ AD_IP_CAP_EXEMPT_OWNERS: 'creator1' });
    await fx.seed(db(), fx.placement().all);
    await db().collection('ad_repeat_gate').insertOne({ _id: 's:anything', exp: fx.fromNow(fx.HOUR) });
    expect((await open({}, { to: exempt })).body.ad).not.toBeNull();
  });

  test('the creator watching signed out from their own connection, or its /24, gets no ad', async () => {
    const hmac = (v) => crypto.createHmac('sha256', process.env.IP_HASH_SECRET).update(v).digest('hex').slice(0, 32);
    await fx.seed(db(), fx.placement().all);
    // The same keyed hashes the upload service and the player store, never the address.
    await db().collection('embed-video').insertOne({
      owner: 'uploader7', permlink: 'old', createdAt: fx.ago(fx.DAY),
      uploader_ip_hash: hmac('ip:192.0.2.10'), uploader_net_hash: hmac('net:192.0.2.0/24'),
    });
    await db().collection('ad_viewer_watch').insertOne({
      viewer: 'uploader8', at: fx.ago(fx.DAY),
      viewer_ip_hash: hmac('ip:2001:db8:1:2::9'), viewer_net_hash: hmac('net:2001:db8:1::/48'),
    });

    expect((await open({ owner: 'uploader7' }, { ip: '192.0.2.10' })).body.reason).toBe('own_video');
    expect((await open({ owner: 'uploader7' }, { ip: '::ffff:192.0.2.77' })).body.reason).toBe('own_video');
    expect((await open({ owner: 'uploader7' }, { ip: '192.0.3.10' })).body.ad).not.toBeNull();
    expect((await open({ owner: 'uploader8' }, { ip: '2001:db8:1:ffff::1' })).body.reason).toBe('own_video');
  });

  test('a script in a loop is cut off after AD_SESSION_RATE_PER_MIN, and gets "no ad", not an error', async () => {
    const limited = isolatedApp({ AD_SESSION_RATE_PER_MIN: '2' });
    const ip = fx.freshIp();
    await open({}, { ip, to: limited }).expect(200);
    await open({}, { ip, to: limited }).expect(200);
    expect((await open({}, { ip, to: limited }).expect(200)).body).toEqual({ ad: null, reason: 'rate_limited' });
    expect((await open({}, { to: limited })).body.reason).not.toBe('rate_limited');
    fx.advance(60 * 1000);
    expect((await open({}, { ip, to: limited })).body.reason).not.toBe('rate_limited');
  });

  test('hosting ranges get no ads: no real viewer browses from one', async () => {
    await fx.seed(db(), fx.placement().all);
    expect((await open({}, { ip: '203.0.113.50' })).body).toEqual({ ad: null, reason: 'datacenter' });
    expect((await open({}, { headers: { 'X-Real-IP': '', 'X-Forwarded-For': '203.0.113.9, 10.0.0.1' } })).body.reason).toBe('datacenter');
  });

  test('crawlers that render the page get no ad, and no session is written for them', async () => {
    await fx.seed(db(), fx.placement().all);
    const applebot = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)';
    const before = await db().collection(SESSIONS).countDocuments();
    expect((await open({}, { headers: { 'User-Agent': applebot } })).body).toEqual({ ad: null, reason: 'crawler' });
    expect(await db().collection(SESSIONS).countDocuments()).toBe(before);
    // The same request from a browser is served.
    const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';
    expect((await open({}, { headers: { 'User-Agent': chrome } })).body.ad).not.toBeNull();
  });
});

describe('input', () => {
  test.each([
    ['an owner that is not an id', { owner: 'not valid!' }, /Invalid owner\/permlink/],
    ['no permlink', { permlink: '' }, /Invalid owner\/permlink/],
    ['a content playlist that is not https', { manifestUrl: 'http://ipfs-3speak.b-cdn.net/ipfs/Qm/manifest.m3u8' }, /must be an https URL/],
  ])('%s is a 400', async (_label, over, error) => {
    expect((await open(over).expect(400)).body.error).toMatch(error);
  });

  test('with the ad platform dark the route is a 404, and so is everything under /m', async () => {
    const dark = isolatedApp({ ADS_STAGE: 'off' });
    await open({}, { to: dark }).expect(404);
    await request(dark).get(`/m/${'a'.repeat(32)}.m3u8`).expect(404);
  });

  test('a database failure answers with an error, never a half-made session', async () => {
    fx.databaseFails();
    await open().expect(500, { error: 'Could not open a session' });
  });
});

describe('the helpers kept reachable for scripts (module.exports.__test)', () => {
  const { trimOf, adSecondsFor, selfPromoAllowedOn } = serve.__test;

  test('a trimmed creative reports the trim as its length, an ordinary one its own duration', () => {
    expect(trimOf({ trimToSeconds: 15 })).toBe(15);
    expect(trimOf({ trimToSeconds: 0 })).toBeNull();
    expect(trimOf({})).toBeNull();
    expect(adSecondsFor({ trimToSeconds: 15, durationSeconds: 600 }, null)).toBe(15);
    expect(adSecondsFor({ durationSeconds: 12 }, { spotSeconds: 10 })).toBe(12);
    expect(adSecondsFor({}, { spotSeconds: 10 })).toBe(10);
    expect(adSecondsFor(null, null)).toBeNull();
  });

  test('with no self-promo list everyone carries self-promo ads', () => {
    expect(selfPromoAllowedOn('anyone')).toBe(true);
  });

  test('with a list, only those owners do, whatever the case', () => {
    const limited = fx.isolatedModule('../../routes/adServe', { AD_SELFPROMO_ALLOWED_OWNERS: 'badadib' }).__test;
    expect(limited.selfPromoAllowedOn('BADADIB')).toBe(true);
    expect(limited.selfPromoAllowedOn('somebody-else')).toBe(false);
  });
});
