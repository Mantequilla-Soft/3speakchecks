/**
 * Dead-media shadow-bans: POST /video/report-unavailable, GET
 * /video/unavailable-stats and utils/unavailable.js, against a real MongoDB.
 *
 * A client's 404 is a hint. The server re-checks the manifest on EVERY gateway and
 * bans only on unanimous, definite 404s; a timeout or 5xx is not evidence. The CID
 * comes from our own doc, never from the client. `fetch` is stubbed per gateway.
 */
jest.mock('../../utils/hive', () => require('./_hiveMock').create());

const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const F = require('./_fixtures');
const { extractCid, verifyGone, confirmAndBan, unavailableMatch, GATEWAYS } = require('../../utils/unavailable');

const db = testDb.use();
const app = buildApp(['/feeds', require('../../routes/feeds')], ['/', require('../../routes/videos')]);
const report = (body) => request(app).post('/video/report-unavailable').send(body);

/**
 * Answer every gateway fetch from `byHost` (hostname -> status, or 'throw'). The
 * default is a definite 404 everywhere. Returns the list of fetched URLs.
 */
function stubGateways(byHost = {}) {
  const urls = [];
  jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
    urls.push(String(url));
    const answer = byHost[new URL(url).hostname] ?? 404;
    if (answer === 'throw') throw new Error('ECONNRESET');
    return new Response(answer === 200 ? '#EXTM3U' : null, { status: answer });
  });
  return urls;
}

beforeEach(async () => {
  F.pinClock();
  await F.resetFeedCaches(db());
});
afterEach(() => jest.useRealTimers());

describe('extractCid', () => {
  test.each([
    [{ manifest_cid: 'QmEmbed' }, 'QmEmbed'],
    [{ video_v2: 'ipfs://QmLegacy/manifest.m3u8' }, 'QmLegacy'],
    [{ video_v2: 'https://ipfs.3speak.tv/ipfs/QmPath/manifest.m3u8' }, 'QmPath'],
    [{ video_v2: 'https://cdn.example/video.mp4' }, null],
    [{}, null],
    [null, null],
  ])('%j -> %p', (doc, cid) => {
    expect(extractCid(doc)).toBe(cid);
  });
});

describe('verifyGone', () => {
  test('gone only when every gateway gives a definite 404 for both manifests', async () => {
    const urls = stubGateways();
    const out = await verifyGone('QmX');
    expect(out.gone).toBe(true);
    expect(out.results.map((r) => r.verdict)).toEqual(GATEWAYS.map(() => 'gone'));
    expect(urls).toHaveLength(GATEWAYS.length * 2);
  });

  test.each([
    ['a 5xx', 503],
    ['a connection error', 'throw'],
    ['a 200 on the master manifest', 200],
  ])('%s on one gateway is not evidence of absence, and stops the check', async (_label, answer) => {
    stubGateways({ 'hotipfs-3speak-1.b-cdn.net': answer });
    const out = await verifyGone('QmX');
    expect(out.gone).toBe(false);
    expect(out.results).toHaveLength(2);   // short-circuits at the second gateway
  });

  test('a 410 counts as gone', async () => {
    stubGateways(Object.fromEntries(GATEWAYS.map((g) => [new URL(g).hostname, 410])));
    expect((await verifyGone('QmX')).gone).toBe(true);
  });
});

describe('verifyGone with the S3 archive', () => {
  const S3 = 'https://buttercloud.b-cdn.net/vids/QmX/manifest.m3u8';

  test('an archived video gone from every IPFS gateway is alive in its bucket', async () => {
    const urls = stubGateways({ 'buttercloud.b-cdn.net': 200 });
    const out = await verifyGone('QmX', { storage_state: 'archived', s3_url: S3 });
    expect(out.gone).toBe(false);
    expect(out.results).toEqual([{ host: 'https://buttercloud.b-cdn.net', verdict: 'alive' }]);
    expect(urls).toEqual([S3]);   // the zone first, and nothing after a hit
  });

  test('the zone down, s3.3speak.tv still serving: alive', async () => {
    stubGateways({ 'buttercloud.b-cdn.net': 'throw', 's3.3speak.tv': 200 });
    expect((await verifyGone('QmX', { storage_state: 'archived', s3_url: S3 })).gone).toBe(false);
  });

  test('gone only when both S3 hosts AND every IPFS gateway 404', async () => {
    const urls = stubGateways();
    const out = await verifyGone('QmX', { storage_state: 'archived', s3_url: S3 });
    expect(out.gone).toBe(true);
    expect(out.results.map((r) => r.host)).toEqual([
      'https://buttercloud.b-cdn.net', 'https://s3.3speak.tv', ...GATEWAYS,
    ]);
    expect(urls).toContain('https://s3.3speak.tv/vids/QmX/480p/index.m3u8');
  });

  test.each([
    ['no s3_url', undefined],
    ['an s3_url off our hosts', 'https://evil.example/vids/QmX/manifest.m3u8'],
    ['an s3_url for another CID', 'https://buttercloud.b-cdn.net/vids/QmOther/manifest.m3u8'],
  ])('archived with %s is never confirmed gone, and nothing is fetched', async (_label, s3Url) => {
    const urls = stubGateways();
    const out = await verifyGone('QmX', { storage_state: 'promoting', s3_url: s3Url });
    expect(out.gone).toBe(false);
    expect(out.results[0]).toMatchObject({ host: 's3', verdict: 'unknown' });
    expect(urls).toEqual([]);
  });

  test('a hot video with no S3 copy is checked on IPFS only, as before', async () => {
    const urls = stubGateways();
    expect((await verifyGone('QmX', { storage_state: 'hot' })).gone).toBe(true);
    expect(urls).toHaveLength(GATEWAYS.length * 2);
  });

  test('confirmAndBan reads the S3 fields off the doc and leaves an archived video alone', async () => {
    stubGateways({ 'buttercloud.b-cdn.net': 200 });
    await db().collection('embed-video').insertOne(F.embedVideo({
      owner: 'arch', permlink: 'asset-a', manifest_cid: 'QmX', storage_state: 'archived', s3_url: S3,
    }));
    const out = await confirmAndBan(db(), { owner: 'arch', permlink: 'asset-a' });
    expect(out).toMatchObject({ banned: false, reason: 'still-reachable' });
    const doc = await db().collection('embed-video').findOne({ owner: 'arch' });
    expect(doc.unavailable).toBeUndefined();
  });
});

describe('POST /video/report-unavailable', () => {
  test('needs author and permlink', async () => {
    expect((await report({ author: 'a' }).expect(400)).body).toEqual({ success: false, error: 'author and permlink are required' });
  });

  test('a video confirmed gone everywhere is shadow-banned and leaves every feed and pool', async () => {
    stubGateways();
    await db().collection('embed-video').insertOne(F.embedVideo({ owner: 'dead', permlink: 'asset-d' }));
    await db().collection('discover-pool').insertOne(F.poolEntry({ owner: 'dead', assetPermlink: 'asset-d' }));
    await db().collection('interest-pool').insertOne(F.poolEntry({ owner: 'dead', assetPermlink: 'asset-d' }));

    const res = await report({ author: 'Dead', permlink: 'hive-asset-d', url: 'https://client/said/this', reportedBy: 'viewer' }).expect(200);

    expect(res.body).toMatchObject({ success: true, banned: true, reason: 'confirmed-gone', cid: 'cid-asset-d' });
    expect(await db().collection('embed-video').findOne({ permlink: 'asset-d' })).toMatchObject({ unavailable: true });
    expect(await db().collection('video-unavailable').findOne({ _id: 'dead/hive-asset-d' })).toMatchObject({
      source: 'embed', reason: 'confirmed-gone', reportedBy: 'viewer', reportedUrl: 'https://client/said/this', cid: 'cid-asset-d',
    });
    expect(await db().collection('discover-pool').countDocuments()).toBe(0);
    expect(await db().collection('interest-pool').countDocuments()).toBe(0);
    expect((await request(app).get('/feeds/new').expect(200)).body.total).toBe(0);
    expect((await request(app).get('/video/unavailable-stats').expect(200)).body).toEqual({ success: true, count: 1 });
  });

  test('the CID is read from OUR doc, never from the URL the client sent', async () => {
    const urls = stubGateways({ 'ipfs.3speak.tv': 200 });
    await db().collection('videos').insertOne(F.legacyVideo({ owner: 'leg', permlink: 'alive', video_v2: 'ipfs://QmReal/manifest.m3u8' }));

    const res = await report({ author: 'leg', permlink: 'alive', url: 'https://x/ipfs/QmSomeoneElse/manifest.m3u8' }).expect(200);

    expect(res.body).toMatchObject({ banned: false, reason: 'still-reachable' });
    expect(urls.every((u) => u.includes('/ipfs/QmReal/'))).toBe(true);
    expect(await db().collection('videos').findOne({ permlink: 'alive' })).not.toHaveProperty('unavailable');
  });

  test('a report storm re-checks a video once an hour, but a known-dead video always answers banned', async () => {
    const urls = stubGateways({ 'ipfs.3speak.tv': 200 });
    await db().collection('embed-video').insertOne(F.embedVideo({ owner: 'ok', permlink: 'fine' }));

    await report({ author: 'ok', permlink: 'fine' }).expect(200);
    const deduped = await report({ author: 'ok', permlink: 'fine' }).expect(200);
    expect(deduped.body).toEqual({ success: true, banned: false, reason: 'recently-checked' });
    const fetchedOnce = urls.length;

    F.advanceClock(60 * 60 * 1000);
    await report({ author: 'ok', permlink: 'fine' }).expect(200);
    expect(urls.length).toBeGreaterThan(fetchedOnce);

    await db().collection('video-unavailable').insertOne({ _id: 'ok/fine' });
    expect((await report({ author: 'ok', permlink: 'fine' }).expect(200)).body).toEqual({ success: true, banned: true, reason: 'already-banned' });
  });

  test('an unknown video is not banned', async () => {
    stubGateways();
    expect((await report({ author: 'no', permlink: 'one' }).expect(200)).body).toMatchObject({ banned: false, reason: 'unknown-video' });
  });

  test('a doc already flagged answers banned without re-checking', async () => {
    const urls = stubGateways();
    await db().collection('videos').insertOne(F.legacyVideo({ owner: 'leg', permlink: 'flagged', unavailable: true }));
    expect((await report({ author: 'leg', permlink: 'flagged' }).expect(200)).body).toMatchObject({ banned: true, reason: 'already-banned' });
    expect(urls).toEqual([]);
  });
});

describe('a video with no manifest CID at all', () => {
  test.each([
    ['a settled published upload (5+ months old) is banned as no-stream', { age: 151 }, true, 'no-stream'],
    ['a young upload might still be encoding: not banned', { age: 10 }, false, 'no-cid'],
    ['an unpublished doc is never banned', { age: 400, status: 'encoding' }, false, 'no-cid'],
  ])('%s', async (_label, { age, status = 'published' }, banned, reason) => {
    const urls = stubGateways();
    await db().collection('videos').insertOne(F.legacyVideo({ owner: 'old', permlink: 'p', status, created: F.daysAgo(age), video_v2: '' }));

    const out = await confirmAndBan(db(), { owner: 'old', permlink: 'p' });

    expect(out).toMatchObject({ banned, reason });
    expect(urls).toEqual([]);   // nothing to fetch: decided from our own doc
    expect(await db().collection('video-unavailable').countDocuments()).toBe(banned ? 1 : 0);
  });
});

describe('unavailableMatch', () => {
  test('matches the field-less majority and explicit false, never true', async () => {
    await db().collection('videos').insertMany([{ k: 'none' }, { k: 'false', unavailable: false }, { k: 'true', unavailable: true }]);
    const kept = await db().collection('videos').find(unavailableMatch()).toArray();
    expect(kept.map((d) => d.k).sort()).toEqual(['false', 'none']);
  });
});
