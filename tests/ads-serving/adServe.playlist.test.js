/**
 * routes/adServe.js, what the player fetches: the stitched playlist (GET /m/:sid.m3u8),
 * the standalone spot playlist (short.m3u8), the measured segments (/m/:sid/a, /b, /ab,
 * /am<i>), where the break landed (/i) and a spoken spot's file (/m/tts/...).
 * Ported from scripts/test-ad-serving.cjs (playlist and delivery measurement) and
 * scripts/test-ad-selfpromo.cjs (the trim rule).
 *
 * The CDN is a stand-in for global fetch serving real HLS text.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');
const fx = require('./_fixtures');

jest.mock('child_process', () => require('./_fixtures').childProcessMock());
jest.mock('../../utils/adGateways', () => ({ ...jest.requireActual('../../utils/adGateways'), startGatewayProbe: jest.fn() }));
const env = fx.useAdEnv();
const { execFile } = require('child_process');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const config = require('../../utils/config');
const { ensureAdIndexes } = require('../../utils/adModel');

const serve = require('../../routes/adServe');
const app = buildApp(['/m', serve]);
// The public base the app builds its urls from, pinned with the proxy headers nginx sets.
const BASE = 'https://checker.test';
const get = (url, to = app) => request(to).get(url).set('X-Forwarded-Proto', 'https').set('X-Forwarded-Host', 'checker.test');
const db = testDb.use();
fx.freezeTime();
beforeAll(() => ensureAdIndexes());
beforeEach(() => {
  jest.setSystemTime(fx.NOW);
  execFile.reset();
});

const SESSIONS = 'ad_sessions';
const G = fx.GATEWAY;
const CONTENT = `${G}/ipfs/QmContentVideo/manifest.m3u8`;
const CONTENT_480 = `${G}/ipfs/QmContentVideo/480p/index.m3u8`;
const SPOT = `${G}/ipfs/QmAdSpot/manifest.m3u8`;
const SPOT_1080 = `${G}/ipfs/QmAdSpot/1080p/index.m3u8`;
const SPOT_480 = `${G}/ipfs/QmAdSpot/480p/index.m3u8`;
const contentMaster = [
  '#EXTM3U', '#EXT-X-VERSION:3',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",URI="audio/index.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=854x480', '480p/index.m3u8',
].join('\n');
const spotMaster = fx.masterPlaylist([{ bw: 800000, uri: '480p/index.m3u8' }, { bw: 5000000, uri: '1080p/index.m3u8' }]);
/** The usual world: a 30-second video (5 x 6s) and a 12-second spot (3 x 4s). */
const cdn = (over = {}) => fx.fakeCdn({
  [CONTENT]: contentMaster,
  [CONTENT_480]: fx.mediaPlaylist([6, 6, 6, 6, 6]),
  [SPOT]: spotMaster,
  [SPOT_1080]: fx.mediaPlaylist([4, 4, 4]),
  [SPOT_480]: fx.mediaPlaylist([4, 4, 4], { prefix: 'low' }),
  ...over,
});

async function session(over = {}) {
  const sid = crypto.randomBytes(16).toString('hex');
  const camp = fx.campaign();
  const doc = {
    sid, campaignId: camp._id, creativeId: null, adManifestUrl: SPOT, contentManifestUrl: CONTENT, adTrimSeconds: null,
    slotPercent: 25, slotPosition: null, bannerMode: 'burn', banner: null, ticker: null, owner: 'creator1', permlink: 'vid-1',
    viewer: null, adFirstFetchAt: null, startedAt: new Date(Date.now()), expiresAt: fx.fromNow(fx.HOUR), ...over,
  };
  // An explicit undefined means "a session written before that field existed".
  for (const [k, v] of Object.entries(over)) if (v === undefined) delete doc[k];
  await db().collection(SESSIONS).insertOne(doc);
  await db().collection(config.AD_CAMPAIGNS_COLLECTION).insertOne({ ...camp, status: 'scheduled' });
  return doc;
}
const stored = (sid) => db().collection(SESSIONS).findOne({ sid });
const variantPath = (sid, url, extra = '') => `/m/${sid}.m3u8?p=${encodeURIComponent(url)}${extra}`;
const lines = (text) => text.split('\n');
const impression = (sid) => db().collection(config.AD_IMPRESSIONS_COLLECTION).findOne({ sid });

describe('GET /m/:sid.m3u8, the master playlist', () => {
  test('every variant (and rendition group) comes back through us, and nothing says "ad"', async () => {
    cdn();
    const s = await session();
    const res = await get(`/m/${s.sid}.m3u8`).expect(200);
    expect(res.headers['content-type']).toMatch(/application\/vnd\.apple\.mpegurl/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain(variantPath(s.sid, CONTENT_480));
    expect(res.text).toContain(`URI="${BASE}${variantPath(s.sid, `${G}/ipfs/QmContentVideo/audio/index.m3u8`)}"`);
    expect(res.text).not.toMatch(/\bad\b|advertise|vast|preroll/i);
  });

  test('?nobanner=1 travels into every variant url', async () => {
    cdn();
    const s = await session();
    const res = await get(`/m/${s.sid}.m3u8?nobanner=1`).expect(200);
    expect(res.text).toContain(variantPath(s.sid, CONTENT_480, '&nobanner=1'));
  });

  test.each([
    ['a session id that is not one', 'not-a-sid', 400],
    ['a session that has expired', 'a'.repeat(32), 404],
  ])('%s', async (_label, sid, status) => {
    await get(`/m/${sid}.m3u8`).expect(status);
  });

  test('a nested playlist pointing off the content\'s own gateways is refused', async () => {
    cdn();
    const s = await session();
    await get(variantPath(s.sid, 'https://evil.example/x.m3u8')).expect(400, 'out of scope');
  });
});

describe('GET /m/:sid.m3u8?p=..., the spliced media playlist', () => {
  test('the spot lands at the first segment boundary at or after its booked percent', async () => {
    cdn();
    const s = await session({ slotPercent: 25 });
    const res = await get(variantPath(s.sid, CONTENT_480)).expect(200);
    const l = lines(res.text);
    const base = BASE;
    expect(l.filter((x) => x === '#EXT-X-DISCONTINUITY')).toHaveLength(2);
    // 25% of 30s is 7.5s: the break goes in after the second 6s segment, at 12s.
    const first = l.indexOf('#EXT-X-DISCONTINUITY');
    expect(l.slice(first - 1, first + 9)).toEqual([
      `${G}/ipfs/QmContentVideo/480p/seg1.ts`,
      '#EXT-X-DISCONTINUITY',
      '#EXTINF:4.000,', `${base}/m/${s.sid}/a`,
      '#EXTINF:4.000,', `${G}/ipfs/QmAdSpot/1080p/seg1.ts`,
      '#EXTINF:4.000,', `${base}/m/${s.sid}/b`,
      '#EXT-X-DISCONTINUITY',
      '#EXTINF:6.000,',
    ]);
    expect(l.filter((x) => x.endsWith('.ts')).every((x) => x.startsWith('https://ipfs-3speak.b-cdn.net/'))).toBe(true);
    expect(await stored(s.sid)).toMatchObject({ adStartAt: 12, adDurationSeconds: 12, adConformTo: null, adConformFrom: null });
  });

  test('a pre-roll goes in before the first segment', async () => {
    cdn();
    const s = await session({ slotPercent: 0 });
    const res = await get(variantPath(s.sid, CONTENT_480)).expect(200);
    const l = lines(res.text);
    expect(l.indexOf('#EXT-X-DISCONTINUITY')).toBeLessThan(l.findIndex((x) => x.includes('QmContentVideo')));
    expect((await stored(s.sid)).adStartAt).toBe(0);
  });

  test('a video shorter than the (legacy, seconds) slot it was booked against runs the spot at the end', async () => {
    cdn();
    const s = await session({ slotPercent: undefined, slotPosition: 1000 });
    const res = await get(variantPath(s.sid, CONTENT_480)).expect(200);
    expect(lines(res.text).slice(-2)).toEqual([`${BASE}/m/${s.sid}/b`, '#EXT-X-DISCONTINUITY']);
    expect((await stored(s.sid)).adStartAt).toBe(30);
  });

  // BUG (routes/adServe.js POST /session writes `slotPercent: campaign.slotPercent ?? null`,
  // and utils/adModel.js slotSecondsFor reads Number(null) as 0%): a legacy flight booked
  // "30 seconds in" (slotPosition only) is spliced in as a PRE-ROLL on every playback,
  // because its session carries slotPercent null rather than no slotPercent at all.
  test.skip('BUG: a legacy flight booked in seconds keeps its position once it is on a session', async () => {
    cdn();
    const s = await session({ slotPercent: null, slotPosition: 13 });
    await get(variantPath(s.sid, CONTENT_480)).expect(200);
    expect((await stored(s.sid)).adStartAt).toBe(18);
  });

  test('a one-segment spot is both the opening and the closing measurement', async () => {
    cdn({ [SPOT]: fx.mediaPlaylist([5]) });
    const s = await session();
    expect((await get(variantPath(s.sid, CONTENT_480))).text).toContain(`/m/${s.sid}/ab`);
  });

  test('a self-promo booking plays only the whole segments that fit its trim', async () => {
    cdn();
    const s = await session({ adTrimSeconds: 9 });
    await get(variantPath(s.sid, CONTENT_480)).expect(200);
    expect((await stored(s.sid)).adDurationSeconds).toBe(8);
  });

  test('a banner-only playback is returned absolutised and otherwise untouched', async () => {
    cdn();
    const s = await session({ adManifestUrl: null, campaignId: null });
    const res = await get(variantPath(s.sid, CONTENT_480)).expect(200);
    expect(res.text).not.toContain('#EXT-X-DISCONTINUITY');
    expect(res.text).toContain(`${G}/ipfs/QmContentVideo/480p/seg4.ts`);
  });

  describe('a burned banner', () => {
    const banner = (over = {}) => ({ campaignId: fx.campaign()._id, imageUrl: 'https://acme.example/b.png', videoUrl: null, slotPercent: 50, seconds: 8, clickUrl: null, ...over });
    const vk = crypto.createHash('sha1').update(CONTENT_480).digest('hex').slice(0, 12);

    test('covers the fewest segments that reach the booked seconds, from the first boundary at or after its position', async () => {
      cdn();
      const s = await session({ adManifestUrl: null, banner: banner() });
      const res = await get(variantPath(s.sid, CONTENT_480)).expect(200);
      const base = BASE;
      // 50% of 30s is 15s: the banner starts at 18s and needs two 6s segments for 8s.
      expect(res.text).toContain(`${base}/m/${s.sid}/s/${vk}/0`);
      expect(res.text).toContain(`${base}/m/${s.sid}/s/${vk}/1`);
      expect(res.text).not.toContain(`/s/${vk}/2`);
      expect(await stored(s.sid)).toMatchObject({
        bannerStartAt: 18, bannerDurationSeconds: 12, bannerBookedSeconds: 8,
        bannerSegs: { [vk]: [`${G}/ipfs/QmContentVideo/480p/seg3.ts`, `${G}/ipfs/QmContentVideo/480p/seg4.ts`] },
      });
    });

    test('is placed against the content before any roll is spliced in, so a pre-roll does not move it', async () => {
      cdn();
      const s = await session({ slotPercent: 0, banner: banner() });
      await get(variantPath(s.sid, CONTENT_480)).expect(200);
      expect(await stored(s.sid)).toMatchObject({ bannerStartAt: 18, adStartAt: 0 });
    });

    test('booked past the last boundary of a short video, it takes the last segment', async () => {
      cdn({ [CONTENT_480]: fx.mediaPlaylist([20, 20]) });
      const s = await session({ adManifestUrl: null, banner: banner({ slotPercent: 75, seconds: 3 }) });
      await get(variantPath(s.sid, CONTENT_480)).expect(200);
      expect((await stored(s.sid)).bannerStartAt).toBe(20);
    });

    test('an overlay page gets the unchanged playlist, but still learns where the banner runs', async () => {
      cdn();
      const s = await session({ adManifestUrl: null, bannerMode: 'overlay', banner: banner() });
      const res = await get(variantPath(s.sid, CONTENT_480)).expect(200);
      expect(res.text).not.toContain('/s/');
      const after = await stored(s.sid);
      expect(after).toMatchObject({ bannerStartAt: 18, bannerBookedSeconds: 8 });
      expect(after.bannerSegs).toBeUndefined();
    });

    test.each([
      ['the shadow copy asked for with ?nobanner=1', {}, '&nobanner=1'],
      ['a banner the viewer already closed', { bannerDismissedAt: fx.ago(1000) }, ''],
      ['a banner with neither image nor video', { banner: banner({ imageUrl: null }) }, ''],
    ])('is not written for %s', async (_label, over, q) => {
      cdn();
      const s = await session({ adManifestUrl: null, banner: banner(), ...over });
      const res = await get(variantPath(s.sid, CONTENT_480, q)).expect(200);
      expect(res.text).not.toContain('/s/');
    });
  });

  describe('gateways and failure', () => {
    test('content read through a gateway this page cannot use is re-read from one it can', async () => {
      const onPublic = 'https://ipfs.3speak.tv/ipfs/QmContentVideo/480p/index.m3u8';
      const sibling = `${G}/ipfs/QmContentVideo/480p/index.m3u8`;
      cdn({ [onPublic]: fx.mediaPlaylist([6, 6]), [sibling]: fx.mediaPlaylist([6, 6]) });
      const s = await session({ contentManifestUrl: 'https://ipfs.3speak.tv/ipfs/QmContentVideo/manifest.m3u8', adManifestUrl: null });
      const res = await get(variantPath(s.sid, onPublic)).set('Origin', 'https://elsewhere.example').expect(200);
      expect(res.text).toContain(`${G}/ipfs/QmContentVideo/480p/seg0.ts`);
      expect(res.text).not.toContain('ipfs.3speak.tv');
    });

    test('fails open when no gateway this page can use answers', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      const onPublic = 'https://ipfs.3speak.tv/ipfs/QmContentVideo/480p/index.m3u8';
      // Only the gateway without CORS for this page has the playlist.
      fx.fakeCdn({ [onPublic]: fx.mediaPlaylist([6, 6]) });
      const s = await session({ contentManifestUrl: 'https://ipfs.3speak.tv/ipfs/QmContentVideo/manifest.m3u8', adManifestUrl: null });
      const res = await get(variantPath(s.sid, onPublic)).set('Origin', 'https://elsewhere.example').expect(302);
      expect(res.headers.location).toBe(s.contentManifestUrl);
    });

    test('fails open to the plain video when the content cannot be read, so a viewer never loses it', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      fx.fakeCdn({});
      const s = await session();
      const res = await get(`/m/${s.sid}.m3u8`).expect(302);
      expect(res.headers.location).toBe(CONTENT);
    });

    test('fails open when the spot cannot be read, too', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      cdn({ [SPOT]: { status: 500 }, [SPOT_1080]: { status: 500 } });
      const s = await session();
      await get(variantPath(s.sid, CONTENT_480)).expect(302);
    });

    test('with no session to fall back to, it is a 502', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      fx.databaseFails();
      await get(`/m/${'c'.repeat(32)}.m3u8`).expect(502, 'manifest unavailable');
    });
  });
});

describe('GET /m/:sid/:n, the measured segments', () => {
  const seg = (s, n, q = '') => get(`/m/${s.sid}/${n}${q}`);

  test('the opening segment starts the clock and opens an impression, then 302s to the CDN', async () => {
    cdn();
    const s = await session();
    const res = await seg(s, 'a').expect(302);
    expect(res.headers.location).toBe(`${G}/ipfs/QmAdSpot/1080p/seg0.ts`);
    expect((await stored(s.sid)).adFirstFetchAt).toEqual(new Date(fx.NOW));
    expect(await impression(s.sid)).toMatchObject({ started: true, owner: 'creator1', permlink: 'vid-1', payoutId: null, at: new Date(fx.NOW) });
    expect((await impression(s.sid)).completed).toBeUndefined();
    // A second opening fetch (a retry) does not restart the clock.
    fx.advance(1000);
    await seg(s, 'a').expect(302);
    expect((await stored(s.sid)).adFirstFetchAt).toEqual(new Date(fx.NOW));
  });

  test('the closing segment completes the impression once, and only after the spot could have played', async () => {
    cdn();
    const s = await session({ adFirstFetchAt: new Date(Date.now()) });
    // Fetched at once: the bytes go out, but nothing is counted.
    await seg(s, 'b').expect(302);
    expect(await impression(s.sid)).toBeNull();

    fx.advance(config.AD_COUNT_AFTER_SECONDS * config.AD_PACING_MIN_FRACTION * 1000 + 1);
    await seg(s, 'b').expect(302);
    expect(await impression(s.sid)).toMatchObject({ completed: true, completedAt: new Date(Date.now()) });
    const camp = await db().collection(config.AD_CAMPAIGNS_COLLECTION).findOne({ _id: s.campaignId });
    expect(camp).toMatchObject({ deliveredImpressions: 1, status: 'running' });

    // A replay (a seek back into the break) bills nothing twice.
    await seg(s, 'b').expect(302);
    expect((await db().collection(config.AD_CAMPAIGNS_COLLECTION).findOne({ _id: s.campaignId })).deliveredImpressions).toBe(1);
  });

  test('a one-segment spot completes on its single measured fetch', async () => {
    cdn({ [SPOT]: fx.mediaPlaylist([5]) });
    const s = await session({ adFirstFetchAt: fx.ago(10 * 1000) });
    await seg(s, 'ab').expect(302);
    expect(await impression(s.sid)).toMatchObject({ completed: true });
  });

  test('watching the pre-upload spot never completes it: posting does', async () => {
    cdn();
    const s = await session({ surface: 'upload', adFirstFetchAt: fx.ago(60 * 1000) });
    await seg(s, 'b').expect(302);
    expect(await impression(s.sid)).toMatchObject({ started: true });
    expect((await impression(s.sid)).completed).toBeUndefined();
  });

  test('a standalone spot\'s player gets the rendition it is on (?v=), and middle segments by index', async () => {
    cdn();
    const s = await session();
    expect((await seg(s, 'a', '?v=1').expect(302)).headers.location).toBe(`${G}/ipfs/QmAdSpot/480p/low0.ts`);
    expect((await seg(s, 'am1').expect(302)).headers.location).toBe(`${G}/ipfs/QmAdSpot/1080p/seg1.ts`);
    await seg(s, 'am9').expect(404, 'no such segment');
  });

  test('a segment on a gateway a browser cannot follow a redirect to is relayed from our origin', async () => {
    const relayHost = 'https://ipfs.3speak.tv/ipfs/QmRelaySpot';
    cdn({ [`${relayHost}/manifest.m3u8`]: fx.mediaPlaylist([4, 4]), [`${relayHost}/seg0.ts`]: Buffer.from('RELAYED-BYTES') });
    const s = await session({ adManifestUrl: `${relayHost}/manifest.m3u8` });
    const res = await seg(s, 'a').expect(200);
    expect(res.headers['content-type']).toMatch(/video\/mp2t/);
    expect(Buffer.from(res.body).toString()).toBe('RELAYED-BYTES');
  });

  test('if even the relay fails, the redirect is still better than nothing', async () => {
    const relayHost = 'https://ipfs.3speak.tv/ipfs/QmDeadSpot';
    cdn({ [`${relayHost}/manifest.m3u8`]: fx.mediaPlaylist([4, 4]) });
    const s = await session({ adManifestUrl: `${relayHost}/manifest.m3u8` });
    expect((await seg(s, 'b').expect(302)).headers.location).toBe(`${relayHost}/seg1.ts`);
  });

  test.each([
    ['a segment name that is not one', 'a'.repeat(32), 'x1', 400],
    ['an expired session', 'a'.repeat(32), 'a', 404],
  ])('%s', async (_label, sid, n, status) => {
    await get(`/m/${sid}/${n}`).expect(status);
  });

  test('a session with no spot has no segments', async () => {
    const s = await session({ adManifestUrl: null });
    await seg(s, 'a').expect(404, 'no spot on this session');
  });

  test('an unreadable spot is a 502', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    fx.fakeCdn({});
    const s = await session();
    await seg(s, 'a').expect(502);
  });
});

describe('GET /m/:sid/short.m3u8, a spot that plays on its own', () => {
  test('lists every rendition, the one nearest 720p first', async () => {
    cdn();
    const s = await session({ surface: 'shorts' });
    const res = await get(`/m/${s.sid}/short.m3u8`).expect(200);
    const l = lines(res.text);
    expect(l[2]).toMatch(/BANDWIDTH=800000/);
    expect(l[3]).toMatch(new RegExp(`/m/${s.sid}/short\\.m3u8\\?v=1$`));
    expect(l[5]).toMatch(new RegExp(`/m/${s.sid}/short\\.m3u8\\?v=0$`));
  });

  test('one rendition is its segments, measured first and last, carrying the rendition', async () => {
    cdn();
    const s = await session({ surface: 'upload' });
    const res = await get(`/m/${s.sid}/short.m3u8?v=0`).expect(200);
    expect(lines(res.text)).toEqual([
      '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXTINF:4.000,', `${BASE}/m/${s.sid}/a?v=0`,
      '#EXTINF:4.000,', `${G}/ipfs/QmAdSpot/1080p/seg1.ts`,
      '#EXTINF:4.000,', `${BASE}/m/${s.sid}/b?v=0`,
      '#EXT-X-ENDLIST',
    ]);
  });

  test('a spot with a single rendition and a single segment is one "ab" measurement', async () => {
    cdn({ [SPOT]: fx.mediaPlaylist([3]) });
    const s = await session({ surface: 'live' });
    expect((await get(`/m/${s.sid}/short.m3u8`).expect(200)).text).toContain(`/m/${s.sid}/ab`);
  });

  test.each([
    ['a watch session', { surface: undefined }, 404],
    ['a live session without a roll', { surface: 'live', campaignId: null }, 404],
    ['a session with no spot', { surface: 'shorts', adManifestUrl: null }, 404],
  ])('is not served for %s', async (_label, over, status) => {
    cdn();
    const s = await session(over);
    await get(`/m/${s.sid}/short.m3u8`).expect(status);
  });

  test('a bad id is a 400; an unreadable spot a 502, with nothing to fall back to', async () => {
    await get('/m/zz/short.m3u8').expect(400);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    fx.fakeCdn({});
    const s = await session({ surface: 'shorts' });
    await get(`/m/${s.sid}/short.m3u8`).expect(502);
  });
});

describe('GET /m/:sid/i, where the break really landed', () => {
  test('nothing is guessed before a variant has been rendered', async () => {
    const s = await session();
    expect((await get(`/m/${s.sid}/i`).expect(200)).body).toEqual({
      adStartAt: null, adDurationSeconds: null, skipAfterSeconds: null, bannerStartAt: null,
      bannerCloseAfterSeconds: config.AD_BANNER_CLOSE_AFTER_SECONDS, bannerDurationSeconds: null,
    });
  });

  test.each([
    ['a 12-second spot may be skipped after 5 seconds', 12, 5],
    ['a spot at the minimum length has no skip', config.AD_SKIP_MIN_SPOT_SECONDS, null],
    ['a spot just over it does', config.AD_SKIP_MIN_SPOT_SECONDS + 0.5, 5],
  ])('%s', async (_label, adDurationSeconds, skip) => {
    const s = await session({ adStartAt: 12, adDurationSeconds });
    expect((await get(`/m/${s.sid}/i`)).body).toMatchObject({ adStartAt: 12, adDurationSeconds, skipAfterSeconds: skip });
  });

  test.each([
    ['the booked seconds, not the span of segments they landed on', { bannerStartAt: 18, bannerDurationSeconds: 12, bannerBookedSeconds: 8 }, 8],
    ['never more than the segments it covers', { bannerStartAt: 18, bannerDurationSeconds: 6, bannerBookedSeconds: 8 }, 6],
    ['an older session without a booked figure reports the span', { bannerStartAt: 18, bannerDurationSeconds: 12 }, 12],
  ])('a banner is on screen for %s', async (_label, over, seconds) => {
    const s = await session(over);
    expect((await get(`/m/${s.sid}/i`)).body).toMatchObject({ bannerStartAt: 18, bannerDurationSeconds: seconds });
  });

  test('a bad id is a 400, an expired session a 404, a database failure a 500', async () => {
    await get('/m/nope/i').expect(400);
    await get(`/m/${'d'.repeat(32)}/i`).expect(404);
    fx.databaseFails();
    await get(`/m/${'d'.repeat(32)}/i`).expect(500);
  });
});

describe('GET /m/tts/:file, a spoken spot\'s sound', () => {
  test('is served as audio, cached for good and readable from any page', async () => {
    const file = `${'e'.repeat(40)}.mp3`;
    fs.writeFileSync(path.join(env.AD_TTS_DIR, file), 'ID3-spoken');
    const res = await get(`/m/tts/${file}`).expect(200);
    expect(res.headers).toMatchObject({ 'content-type': 'audio/mpeg', 'cache-control': 'public, max-age=31536000, immutable', 'access-control-allow-origin': '*' });
  });

  test('a name that is not a render is a 400, a missing one a 404', async () => {
    await get('/m/tts/..%2F..%2Fsecrets.mp3').expect(400);
    await get(`/m/tts/${'f'.repeat(40)}.mp3`).expect(404);
  });
});

describe('the trim rule (loadAdSegments, via __test)', () => {
  const { loadAdSegments } = serve.__test;
  const tenFours = `${G}/ipfs/QmTen/manifest.m3u8`;
  beforeEach(() => fx.fakeCdn({
    [tenFours]: fx.mediaPlaylist(Array(10).fill(4)),
    [`${G}/ipfs/QmEmpty/manifest.m3u8`]: '#EXTM3U\n#EXT-X-ENDLIST',
    [`${G}/ipfs/QmNoVariant/manifest.m3u8`]: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n#comment',
  }));

  test.each([
    ['15s of 4s segments keeps 3 (12s), never 4 (16s)', 15, 3],
    ['a booking shorter than one segment still keeps one', 1, 1],
    ['a booking longer than the media keeps everything', 600, 10],
    ['no trim keeps everything', null, 10],
  ])('%s', async (_label, trim, count) => {
    expect(await loadAdSegments(tenFours, trim)).toHaveLength(count);
  });

  test('a playlist with no segments, or a master with no variant, is an error', async () => {
    await expect(loadAdSegments(`${G}/ipfs/QmEmpty/manifest.m3u8`)).rejects.toThrow('creative has no segments');
    await expect(loadAdSegments(`${G}/ipfs/QmNoVariant/manifest.m3u8`)).rejects.toThrow('no variant in creative manifest');
  });

  test('a body that is not a playlist is not one', async () => {
    fx.fakeCdn({ [tenFours]: '<html>suspended</html>' });
    await expect(loadAdSegments(tenFours)).rejects.toThrow('not a manifest');
  });
});

describe('re-encoding the spot to match the video (AD_AUDIO_NORMALISE on)', () => {
  const PROBES = 'ad_media_probe';
  const key = (u) => crypto.createHash('sha1').update(u).digest('hex').slice(0, 16);
  let conformApp;
  beforeAll(() => { conformApp = buildApp(['/m', fx.isolatedModule('../../routes/adServe', { AD_AUDIO_NORMALISE: 'true' })]); });

  test('the playlist routes every spot segment through us, and the shape is decided once and kept', async () => {
    cdn();
    execFile.setHandler(async (cmd, args) => {
      if (cmd !== 'ffmpeg') throw new Error(`unexpected ${cmd}`);
      fs.writeFileSync(args[args.length - 1], 'CONFORMED');
      return '';
    });
    // Both shapes are already known from an earlier run (the probe cache in Mongo).
    await db().collection(PROBES).insertMany([
      { _id: key(CONTENT_480), url: CONTENT_480, shape: { profile: 'main', level: 31, width: 1280, height: 720, sampleRate: 48000 } },
      { _id: key(SPOT), url: SPOT, shape: { profile: 'high', level: 40, width: 1920, height: 1080, sampleRate: 44100 } },
    ]);
    const s = await session();
    const res = await get(variantPath(s.sid, CONTENT_480), conformApp).expect(200);
    expect(res.text).toContain(`/m/${s.sid}/am1`);
    expect(await stored(s.sid)).toMatchObject({ adConformTo: null, adConformFrom: { content: CONTENT_480, ad: SPOT } });

    // Decided in the background, from the cached shapes: the video's own.
    const decided = await fx.eventually(async () => (await stored(s.sid)).adConformTo);
    expect(decided).toMatchObject({ width: 1280, height: 720, sampleRate: 48000 });

    const segRes = await get(`/m/${s.sid}/a`, conformApp).expect(200);
    expect(Buffer.from(segRes.body).toString()).toBe('CONFORMED');
    expect(fs.readdirSync(env.AD_BURN_CACHE_DIR).some((f) => f.startsWith('cf-'))).toBe(true);
  });
});
