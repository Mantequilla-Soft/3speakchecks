/**
 * routes/adServe.js, measuring delivery: the click-throughs (/c, /bc, /tc), the
 * player's own reports (/w watched seconds, /skipped, /banner-shown, /ticker-shown),
 * the pre-upload gate's proof of posting (/posted), closing a banner (/dismiss) and
 * the burned banner segments (/s/:vk/:i).
 *
 * The rule throughout: an impression is counted once per (session, campaign), never
 * faster than wall-clock time allows, and a click is attributed to the placement it
 * was made on. The banner burn itself (services/adBurner.js) is a stand-in here.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');
const { ObjectId } = require('mongodb');
const fx = require('./_fixtures');

jest.mock('child_process', () => require('./_fixtures').childProcessMock());
jest.mock('../../utils/adGateways', () => ({ ...jest.requireActual('../../utils/adGateways'), startGatewayProbe: jest.fn() }));
jest.mock('../../services/adBurner', () => ({ ...jest.requireActual('../../services/adBurner'), burnSegment: jest.fn() }));
const env = fx.useAdEnv();
const { burnSegment } = require('../../services/adBurner');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const config = require('../../utils/config');
const { ensureAdIndexes } = require('../../utils/adModel');

const app = buildApp(['/m', require('../../routes/adServe')]);
const db = testDb.use();
fx.freezeTime();
beforeAll(() => ensureAdIndexes());
beforeEach(() => {
  jest.setSystemTime(fx.NOW);
  burnSegment.mockReset();
});

const SESSIONS = 'ad_sessions';
const IMPRESSIONS = () => db().collection(config.AD_IMPRESSIONS_COLLECTION);
const CAMPAIGNS = () => db().collection(config.AD_CAMPAIGNS_COLLECTION);
const hex = (n) => crypto.randomBytes(n).toString('hex');

/** A session with a roll, plus any banner / ticker given, and the campaigns behind them. */
async function session(over = {}) {
  const roll = fx.campaign({ status: 'scheduled' });
  const doc = {
    sid: hex(16), campaignId: roll._id, owner: 'creator1', permlink: 'vid-1', viewer: 'viewer1', country: 'DE', app: 'partner',
    clickUrl: 'https://acme.example/', adDurationSeconds: 12, adFirstFetchAt: null, startedAt: new Date(Date.now()),
    banner: null, ticker: null, bannerMode: 'burn', bannerDismissedAt: null, expiresAt: fx.fromNow(fx.HOUR), ...over,
  };
  const ids = [doc.campaignId, doc.banner?.campaignId, doc.ticker?.campaignId].filter(Boolean);
  if (ids.length) await CAMPAIGNS().insertMany(ids.map((_id) => fx.campaign({ _id, status: 'scheduled' })));
  await db().collection(SESSIONS).insertOne(doc);
  return doc;
}
const placement = (over = {}) => ({ campaignId: new ObjectId(), creativeId: new ObjectId(), seconds: 8, clickUrl: 'https://placement.example/landing', ...over });
const impressionOf = (sid, campaignId) => IMPRESSIONS().findOne({ sid, campaignId });
const delivered = async (id) => (await CAMPAIGNS().findOne({ _id: id })).deliveredImpressions;
const post = (url, body = {}) => request(app).post(url).send(body);

describe('click-throughs are counted once per playback, to the right advertiser', () => {
  test.each([
    ['the roll\'s', 'c', (s) => s.campaignId, (s) => s.clickUrl, {}],
    ['the banner\'s', 'bc', (s) => s.banner.campaignId, (s) => s.banner.clickUrl, { banner: placement() }],
    ['the ticker\'s', 'tc', (s) => s.ticker.campaignId, (s) => s.ticker.clickUrl, { ticker: placement({ clickUrl: 'https://approved.example/with-the-message' }) }],
  ])('%s click redirects to the approved destination and counts once', async (_label, route, campaignOf, destOf, over) => {
    const s = await session(over);
    const res = await request(app).get(`/m/${s.sid}/${route}`).expect(302);
    expect(res.headers.location).toBe(destOf(s));
    expect(res.headers['cache-control']).toBe('no-store');
    await request(app).get(`/m/${s.sid}/${route}`).expect(302);

    expect(await impressionOf(s.sid, campaignOf(s))).toMatchObject({ clicked: true, clickedAt: new Date(fx.NOW), started: true, owner: 'creator1', app: 'partner' });
    expect((await CAMPAIGNS().findOne({ _id: campaignOf(s) })).clicks).toBe(1);
  });

  test('a banner click never lands on the roll that shares the playback', async () => {
    const s = await session({ banner: placement() });
    await IMPRESSIONS().insertOne({ sid: s.sid, campaignId: s.campaignId, started: true });
    await request(app).get(`/m/${s.sid}/bc`).expect(302);
    expect((await impressionOf(s.sid, s.campaignId)).clicked).toBeUndefined();
    expect((await impressionOf(s.sid, s.banner.campaignId)).clicked).toBe(true);
  });

  test.each([
    ['c', { clickUrl: null }],
    ['bc', { banner: placement({ clickUrl: null }) }],
    ['bc', {}],
    ['tc', { ticker: placement({ clickUrl: null }) }],
    ['tc', {}],
  ])('/%s with nowhere to go is a 404', async (route, over) => {
    const s = await session(over);
    await request(app).get(`/m/${s.sid}/${route}`).expect(404);
  });

  test.each(['c', 'bc', 'tc'])('/%s: a bad session id is a 400, a database failure a 502', async (route) => {
    await request(app).get(`/m/nope/${route}`).expect(400);
    fx.databaseFails();
    await request(app).get(`/m/${hex(16)}/${route}`).expect(502);
  });

  test.each([['c', {}], ['bc', { banner: placement() }], ['tc', { ticker: placement() }]])(
    '/%s still redirects when the count cannot be written', async (route, over) => {
      const s = await session(over);
      const real = require('../../utils/db').getDb();
      const original = real.collection.bind(real);
      jest.spyOn(console, 'error').mockImplementation(() => {});
      jest.spyOn(real, 'collection').mockImplementation((name) => (name === config.AD_IMPRESSIONS_COLLECTION
        ? { updateOne: async () => { throw new Error('write conflict'); } } : original(name)));
      await request(app).get(`/m/${s.sid}/${route}`).expect(302);
    },
  );
});

describe('POST /m/:sid/w: seconds of the spot that actually played', () => {
  test('three seconds on screen, by the clock, is a delivered impression', async () => {
    const s = await session({ adFirstFetchAt: fx.ago(10 * 1000) });
    const res = await post(`/m/${s.sid}/w`, { seconds: 9.5 }).expect(200);
    expect(res.body).toEqual({ ok: true, counted: true, credited: 9.5 });
    expect(await impressionOf(s.sid, s.campaignId)).toMatchObject({ completed: true, watchedSeconds: 9.5, country: 'DE', owner: 'creator1' });
    expect(await CAMPAIGNS().findOne({ _id: s.campaignId })).toMatchObject({ deliveredImpressions: 1, status: 'running' });
  });

  test('a claim is credited only with the time that has really passed since the spot started', async () => {
    const s = await session({ adFirstFetchAt: fx.ago(2 * 1000) });
    expect((await post(`/m/${s.sid}/w`, { seconds: 12 })).body).toEqual({ ok: true, counted: false, credited: 2 });
    expect(await delivered(s.campaignId)).toBe(0);
  });

  test('before the first byte of the spot was served nothing has played, whatever the client says', async () => {
    const s = await session();
    expect((await post(`/m/${s.sid}/w`, { seconds: 12 })).body).toEqual({ ok: true, counted: false, credited: 0 });
  });

  test('nobody watches a spot for longer than it runs (one second of drift allowed)', async () => {
    const s = await session({ adFirstFetchAt: fx.ago(60 * 1000), adDurationSeconds: 12 });
    expect((await post(`/m/${s.sid}/w`, { seconds: 45 })).body.credited).toBe(13);
  });

  test('watched seconds only ever grow, also after the impression is complete, and bill once', async () => {
    const s = await session({ adFirstFetchAt: fx.ago(30 * 1000) });
    await post(`/m/${s.sid}/w`, { seconds: 4 });
    await post(`/m/${s.sid}/w`, { seconds: 11 });
    await post(`/m/${s.sid}/w`, { seconds: 6 });
    expect((await impressionOf(s.sid, s.campaignId)).watchedSeconds).toBe(11);
    expect(await delivered(s.campaignId)).toBe(1);
  });

  test('watching the pre-upload spot records the seconds but never bills', async () => {
    const s = await session({ surface: 'upload', owner: 'uploader1', viewer: 'uploader1', adFirstFetchAt: fx.ago(20 * 1000) });
    expect((await post(`/m/${s.sid}/w`, { seconds: 12 })).body).toMatchObject({ counted: false, credited: 12 });
    expect(await impressionOf(s.sid, s.campaignId)).toMatchObject({ owner: 'uploader1', watchedSeconds: 12 });
    expect(await delivered(s.campaignId)).toBe(0);
  });

  test.each([[{ seconds: -1 }], [{ seconds: 'many' }], [{}]])('a report of %j is refused', async (b) => {
    const s = await session();
    expect((await post(`/m/${s.sid}/w`, b)).body).toEqual({ ok: false, reason: 'bad_seconds' });
  });

  test('a session with no spot has nothing to report', async () => {
    const s = await session({ campaignId: null });
    expect((await post(`/m/${s.sid}/w`, { seconds: 3 })).body).toEqual({ ok: false, reason: 'no_spot' });
  });

  test('a live stream\'s pre-roll is tagged live, so its host is paid as a streamer; a video\'s roll is not', async () => {
    const live = await session({ surface: 'live', owner: 'host1', permlink: 'room-1', adFirstFetchAt: fx.ago(10 * 1000) });
    await post(`/m/${live.sid}/w`, { seconds: 9 }).expect(200);
    expect(await impressionOf(live.sid, live.campaignId)).toMatchObject({ completed: true, live: true, owner: 'host1', permlink: 'room-1' });
    const vod = await session({ adFirstFetchAt: fx.ago(10 * 1000) });
    await post(`/m/${vod.sid}/w`, { seconds: 9 }).expect(200);
    expect((await impressionOf(vod.sid, vod.campaignId)).live).toBeUndefined();
  });
});

describe('POST /m/:sid/skipped', () => {
  test('a skip after the threshold is a delivered impression, flagged as skipped, counted once', async () => {
    const s = await session();
    await post(`/m/${s.sid}/skipped`).expect(200, { ok: true });
    await post(`/m/${s.sid}/skipped`).expect(200, { ok: true });
    expect(await impressionOf(s.sid, s.campaignId)).toMatchObject({ completed: true, skipped: true });
    expect(await delivered(s.campaignId)).toBe(1);
  });

  test('without a spot it is refused', async () => {
    const s = await session({ campaignId: null });
    expect((await post(`/m/${s.sid}/skipped`)).body).toEqual({ ok: false, reason: 'no_spot' });
  });

  test('a skipped pre-roll on a live stream is tagged live', async () => {
    const s = await session({ surface: 'live' });
    await post(`/m/${s.sid}/skipped`).expect(200, { ok: true });
    expect(await impressionOf(s.sid, s.campaignId)).toMatchObject({ skipped: true, live: true });
  });
});

describe('POST /m/:sid/ticker-shown and /banner-shown: what only the page can see', () => {
  test('a ticker claim before the booked run could have elapsed is refused', async () => {
    const s = await session({ ticker: placement({ seconds: 10 }) });
    fx.advance(4 * 1000);
    expect((await post(`/m/${s.sid}/ticker-shown`)).body).toEqual({ ok: false, reason: 'too_soon', elapsed: 4 });
    expect(await impressionOf(s.sid, s.ticker.campaignId)).toBeNull();
  });

  test('after the run it is a completed ticker impression, counted once', async () => {
    const s = await session({ ticker: placement({ seconds: 10 }) });
    fx.advance(10 * config.AD_PACING_MIN_FRACTION * 1000);
    await post(`/m/${s.sid}/ticker-shown`).expect(200, { ok: true });
    await post(`/m/${s.sid}/ticker-shown`).expect(200, { ok: true });
    expect(await impressionOf(s.sid, s.ticker.campaignId)).toMatchObject({ ticker: true, completed: true, owner: 'creator1' });
    expect(await delivered(s.ticker.campaignId)).toBe(1);
  });

  test.each([
    ['heard in the audio player', { surface: 'audio' }, { audio: true }],
    ['shown over a live stream', { surface: 'live' }, { live: true }],
    ['on an outside podcast episode', { surface: 'audio', owner: null, podcastEpisode: 'ep-1', podcastFeed: 'feed-1' }, { podcastEpisode: 'ep-1', podcastFeed: 'feed-1', owner: null }],
    ['on a warm-up account\'s track', { surface: 'audio', owner: null, warmupOwner: 'warm1' }, { warmupOwner: 'warm1', owner: null }],
  ])('a ticker %s is tagged so payout can tell', async (_label, over, tags) => {
    const s = await session({ ticker: placement({ seconds: 0 }), ...over });
    await post(`/m/${s.sid}/ticker-shown`).expect(200, { ok: true });
    expect(await impressionOf(s.sid, s.ticker.campaignId)).toMatchObject(tags);
  });

  test('a session without a ticker has none to claim', async () => {
    const s = await session();
    expect((await post(`/m/${s.sid}/ticker-shown`)).body).toEqual({ ok: false, reason: 'no_ticker' });
  });

  test('an overlay banner is counted after most of its run, flagged as overlay-delivered', async () => {
    const s = await session({ bannerMode: 'overlay', banner: placement({ seconds: 8 }) });
    expect((await post(`/m/${s.sid}/banner-shown`)).body).toMatchObject({ ok: false, reason: 'too_soon' });
    fx.advance(4 * 1000);
    await post(`/m/${s.sid}/banner-shown`).expect(200, { ok: true });
    expect(await impressionOf(s.sid, s.banner.campaignId)).toMatchObject({ bannerOverlay: true, completed: true });
  });

  test('an overlay banner on a live stream is tagged live', async () => {
    const s = await session({ surface: 'live', bannerMode: 'overlay', banner: placement({ seconds: 0 }) });
    await post(`/m/${s.sid}/banner-shown`).expect(200);
    expect(await impressionOf(s.sid, s.banner.campaignId)).toMatchObject({ live: true });
  });

  test('a burned banner measures itself and can never shortcut that by claiming here', async () => {
    const s = await session({ bannerMode: 'burn', banner: placement() });
    fx.advance(60 * 1000);
    expect((await post(`/m/${s.sid}/banner-shown`)).body).toEqual({ ok: false, reason: 'not_an_overlay' });
    const none = await session();
    expect((await post(`/m/${none.sid}/banner-shown`)).body).toEqual({ ok: false, reason: 'no_banner' });
  });
});

describe('POST /m/:sid/posted: the pre-upload spot completes when the upload exists', () => {
  const gate = (over = {}) => session({ surface: 'upload', owner: 'uploader1', viewer: 'uploader1', permlink: null, ...over });

  test('a video posted by the same account after the spot settles the impression to the uploader', async () => {
    const s = await gate();
    await db().collection('embed-video').insertOne({ owner: 'uploader1', permlink: 'asset-1', hive_permlink: 'new-post', createdAt: fx.fromNow(fx.MIN) });
    await post(`/m/${s.sid}/posted`, { permlink: 'new-post' }).expect(200, { ok: true });
    expect(await impressionOf(s.sid, s.campaignId)).toMatchObject({ completed: true, owner: 'uploader1', permlink: 'new-post' });
    expect(await delivered(s.campaignId)).toBe(1);
  });

  test('an audio upload, found by its own permlink or its Hive post, settles it too', async () => {
    const s = await gate();
    await db().collection('embed-audio').insertOne({ owner: 'uploader1', permlink: 'aud-1', post_permlink: 'song-post', createdAt: new Date(Date.now()) });
    await post(`/m/${s.sid}/posted`, { permlink: 'song-post' }).expect(200, { ok: true });
  });

  test.each([
    ['an upload by another account', { owner: 'someone-else', permlink: 'p1', createdAt: new Date(fx.NOW) }],
    ['an old upload pointed at to settle a new spot', { owner: 'uploader1', permlink: 'p1', createdAt: fx.ago(2 * fx.HOUR) }],
  ])('%s does not count', async (_label, row) => {
    const s = await gate();
    await db().collection('embed-video').insertOne(row);
    expect((await post(`/m/${s.sid}/posted`, { permlink: 'p1' })).body).toEqual({ ok: false, reason: 'no_matching_upload' });
    expect(await delivered(s.campaignId)).toBe(0);
  });

  test.each([
    ['no permlink', {}, { surface: 'upload', viewer: 'u' }, 'no_permlink'],
    ['a watch session', { permlink: 'p' }, { surface: undefined }, 'not_a_gate'],
    ['a gate session with no uploader', { permlink: 'p' }, { surface: 'upload', viewer: null }, 'no_uploader'],
  ])('%s is refused, but still answers 200', async (_label, b, over, reason) => {
    const s = await session(over);
    await post(`/m/${s.sid}/posted`, b).expect(200, { ok: false, reason });
  });
});

describe('POST /m/:sid/dismiss: the viewer closed the banner', () => {
  test('stops the banner from here on, records it on the impression, and keeps the first time', async () => {
    const s = await session({ banner: placement() });
    await IMPRESSIONS().insertOne({ sid: s.sid, campaignId: s.banner.campaignId, completed: true });
    await post(`/m/${s.sid}/dismiss`).expect(200, { ok: true });
    fx.advance(5000);
    await post(`/m/${s.sid}/dismiss`).expect(200, { ok: true });
    expect((await db().collection(SESSIONS).findOne({ sid: s.sid })).bannerDismissedAt).toEqual(new Date(fx.NOW));
    // The impression stands; dismissal is recorded alongside it.
    expect(await impressionOf(s.sid, s.banner.campaignId)).toMatchObject({ completed: true, bannerDismissed: true });
  });

  test('without a banner there is nothing to close', async () => {
    const s = await session();
    expect((await post(`/m/${s.sid}/dismiss`)).body).toEqual({ ok: false, reason: 'no_banner' });
  });
});

describe('every report route', () => {
  test.each(['w', 'skipped', 'ticker-shown', 'posted', 'banner-shown', 'dismiss'])(
    '/%s: a bad session id is a 400, an unknown session is not a spot, a database failure is ok:false',
    async (route) => {
      expect((await post(`/m/zz/${route}`, { seconds: 3, permlink: 'p' }).expect(400)).body).toEqual({ ok: false });
      expect((await post(`/m/${hex(16)}/${route}`, { seconds: 3, permlink: 'p' }).expect(200)).body.ok).toBe(false);
      fx.databaseFails();
      expect((await post(`/m/${hex(16)}/${route}`, { seconds: 3, permlink: 'p' }).expect(200)).body).toEqual({ ok: false });
    },
  );

  test('a delivery that cannot be written is logged and the player is not made to retry forever', async () => {
    const s = await session({ adFirstFetchAt: fx.ago(10 * 1000) });
    const real = require('../../utils/db').getDb();
    const original = real.collection.bind(real);
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(real, 'collection').mockImplementation((name) => (name === config.AD_IMPRESSIONS_COLLECTION
      ? { updateOne: async () => { throw new Error('disk full'); } } : original(name)));
    await post(`/m/${s.sid}/w`, { seconds: 5 }).expect(200);
    expect(err).toHaveBeenCalledWith('[ad-serve] impression write failed:', 'disk full');
  });
});

describe('GET /m/:sid/s/:vk/:i: a segment with the banner burned in', () => {
  const VK = 'abcdef123456';
  const originals = ['https://ipfs-3speak.b-cdn.net/ipfs/QmC/480p/seg3.ts', 'https://ipfs-3speak.b-cdn.net/ipfs/QmC/480p/seg4.ts'];
  const burnedBanner = (over = {}) => session({
    banner: placement({ imageUrl: 'https://acme.example/b.png', videoUrl: null, seconds: 8 }),
    bannerSegs: { [VK]: originals }, bannerDurationSeconds: 12, bannerBookedSeconds: 8, ...over,
  });
  const burnedFile = () => {
    const f = path.join(env.AD_BURN_CACHE_DIR, `burned-${hex(4)}.ts`);
    fs.writeFileSync(f, 'BURNED');
    return f;
  };

  test('serves the burned bytes, revalidated rather than immutable, and counts the banner as shown', async () => {
    const s = await burnedBanner();
    burnSegment.mockResolvedValue(burnedFile());
    const res = await request(app).get(`/m/${s.sid}/s/${VK}/0`).expect(200);
    expect(res.headers).toMatchObject({ 'content-type': 'video/mp2t', 'cache-control': 'private, no-cache' });
    expect(Buffer.from(res.body).toString()).toBe('BURNED');
    expect(burnSegment).toHaveBeenCalledWith({ segmentUrl: originals[0], imageUrl: 'https://acme.example/b.png', videoUrl: null, visibleSeconds: 8, offsetSeconds: 0 });
    expect(await impressionOf(s.sid, s.banner.campaignId)).toMatchObject({ completed: true, owner: 'creator1' });
    expect(await delivered(s.banner.campaignId)).toBe(1);
  });

  test('the last segment is burned only for the booked seconds left in it, picking up where the banner was', async () => {
    const s = await burnedBanner({ adFirstFetchAt: fx.ago(60 * 1000) });
    burnSegment.mockResolvedValue(burnedFile());
    await request(app).get(`/m/${s.sid}/s/${VK}/1`).expect(200);
    expect(burnSegment).toHaveBeenCalledWith(expect.objectContaining({ segmentUrl: originals[1], visibleSeconds: 2, offsetSeconds: 6 }));
  });

  test('a segment past the booked seconds is the plain video', async () => {
    const s = await burnedBanner({ bannerBookedSeconds: 5 });
    expect((await request(app).get(`/m/${s.sid}/s/${VK}/1`).expect(302)).headers.location).toBe(originals[1]);
    expect(burnSegment).not.toHaveBeenCalled();
  });

  test('a session from before the booked figure existed burns the whole segment', async () => {
    const s = await burnedBanner({ bannerBookedSeconds: undefined });
    burnSegment.mockResolvedValue(burnedFile());
    await request(app).get(`/m/${s.sid}/s/${VK}/1`).expect(200);
    expect(burnSegment).toHaveBeenCalledWith(expect.objectContaining({ visibleSeconds: null }));
  });

  test('after the viewer closed it, the plain segment is served and no CPU is spent burning', async () => {
    const s = await burnedBanner({ bannerDismissedAt: fx.ago(1000) });
    expect((await request(app).get(`/m/${s.sid}/s/${VK}/0`).expect(302)).headers.location).toBe(originals[0]);
    expect(burnSegment).not.toHaveBeenCalled();
  });

  test.each([
    ['the burn produces nothing', () => burnSegment.mockResolvedValue(null)],
    ['the burn throws', () => { jest.spyOn(console, 'error').mockImplementation(() => {}); burnSegment.mockRejectedValue(new Error('ffmpeg died')); }],
  ])('fails open to the original segment when %s', async (_label, arrange) => {
    const s = await burnedBanner();
    arrange();
    expect((await request(app).get(`/m/${s.sid}/s/${VK}/0`).expect(302)).headers.location).toBe(originals[0]);
  });

  test('a burst of fetches from the buffer still burns every segment; pacing only decides what counts', async () => {
    const s = await burnedBanner({ adFirstFetchAt: new Date(Date.now()) });
    burnSegment.mockImplementation(async () => burnedFile());
    await request(app).get(`/m/${s.sid}/s/${VK}/1`).expect(200);
    expect(burnSegment).toHaveBeenCalledTimes(1);
    expect(await impressionOf(s.sid, s.banner.campaignId)).toBeNull();
  });

  test.each([
    ['a bad session id', 'zz', VK, '0', 400],
    ['a bad variant key', null, 'NOT-HEX', '0', 400],
    ['a negative index', null, VK, '-1', 400],
    ['an index past the covered run', null, VK, '2', 404],
    ['a variant this session never rendered', null, 'ffffff', '0', 404],
  ])('%s', async (_label, sidOverride, vk, i, status) => {
    const s = await burnedBanner();
    await request(app).get(`/m/${sidOverride || s.sid}/s/${vk}/${i}`).expect(status);
  });

  test('a session without a banner, or an expired one, is a 404; a database failure a 502', async () => {
    const s = await session();
    await request(app).get(`/m/${s.sid}/s/${VK}/0`).expect(404);
    await request(app).get(`/m/${hex(16)}/s/${VK}/0`).expect(404);
    fx.databaseFails();
    await request(app).get(`/m/${hex(16)}/s/${VK}/0`).expect(502);
  });
});

describe('with the ad platform dark', () => {
  test.each([
    ['get', 'c'], ['get', 'bc'], ['get', 'tc'], ['get', 'i'], ['get', 'short.m3u8'], ['get', 'a'], ['get', 's/abcdef/0'],
    ['post', 'w'], ['post', 'skipped'], ['post', 'ticker-shown'], ['post', 'banner-shown'], ['post', 'dismiss'], ['post', 'posted'],
  ])('%s /m/:sid/%s is a 404', async (method, route) => {
    const dark = buildApp(['/m', fx.isolatedModule('../../routes/adServe', { ADS_STAGE: 'off' })]);
    await request(dark)[method](`/m/${hex(16)}/${route}`).expect(404);
  });
});
