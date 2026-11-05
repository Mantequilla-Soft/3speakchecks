/**
 * services/adCreativeSync.js: moves an uploaded spot from "still encoding" to
 * "waiting for a human" once the encoder has produced a manifest, and rejects one
 * the encoder measured as longer than the slot. It never approves anything itself.
 */
const fx = require('./_fixtures');

fx.useAdEnv();
const testDb = require('../helpers/db');
const sync = require('../../services/adCreativeSync');
const { AD_CREATIVES_COLLECTION, AD_LENGTH_SECONDS } = require('../../utils/config');

const db = testDb.use();
fx.freezeTime();

const creatives = () => db().collection(AD_CREATIVES_COLLECTION);
const pending = (over = {}) => fx.videoCreative({
  status: 'pending', manifestCid: null, manifestUrl: 'https://old-gateway.example/ipfs/QmOld/manifest.m3u8', durationSeconds: 0, ...over,
});

describe('runOnce', () => {
  test('a finished encode moves the spot to review, stores the CID and drops the legacy url', async () => {
    const cr = pending();
    await creatives().insertOne(cr);
    await db().collection('embed-video').insertOne({ owner: 'acme', permlink: cr.permlink, manifest_cid: 'QmEncoded', duration: 11.6 });

    await expect(sync.runOnce()).resolves.toEqual({ checked: 1, advanced: 1, rejected: 0 });
    const after = await creatives().findOne({ _id: cr._id });
    expect(after).toMatchObject({ status: 'review', manifestCid: 'QmEncoded', durationSeconds: 12, encodedAt: new Date(fx.NOW) });
    expect(after).not.toHaveProperty('manifestUrl');
  });

  test('a spot still encoding is left alone for the next tick', async () => {
    const cr = pending();
    await creatives().insertOne(cr);
    await db().collection('embed-video').insertOne({ owner: 'acme', permlink: cr.permlink, manifest_cid: null });
    await expect(sync.runOnce()).resolves.toEqual({ checked: 1, advanced: 0, rejected: 0 });
    expect((await creatives().findOne({ _id: cr._id })).status).toBe('pending');
  });

  test('an encode longer than the slot is rejected with a reason the advertiser can read', async () => {
    const cr = pending();
    await creatives().insertOne(cr);
    await db().collection('embed-video').insertOne({ owner: 'acme', permlink: cr.permlink, manifest_cid: 'QmLong', duration: 90 });
    await expect(sync.runOnce()).resolves.toEqual({ checked: 1, advanced: 0, rejected: 1 });
    const after = await creatives().findOne({ _id: cr._id });
    expect(after.status).toBe('rejected');
    expect(after.reviewNote).toBe(`The encoded spot is 90s. The slot is ${AD_LENGTH_SECONDS}s.`);
  });

  test('without a measured duration it keeps the one the upload reported', async () => {
    const cr = pending({ durationSeconds: 9 });
    await creatives().insertOne(cr);
    await db().collection('embed-video').insertOne({ owner: 'acme', permlink: cr.permlink, manifest_cid: 'QmNoDur' });
    await sync.runOnce();
    expect((await creatives().findOne({ _id: cr._id })).durationSeconds).toBe(9);
  });

  test('approved and rejected spots are never touched', async () => {
    const ready = fx.videoCreative({ status: 'ready' });
    await creatives().insertOne(ready);
    await expect(sync.runOnce()).resolves.toEqual({ checked: 0, advanced: 0 });
  });

  test('with database writes switched off it does nothing', async () => {
    const mod = fx.loadIsolated('../../services/adCreativeSync', { env: { ENABLE_MONGO_WRITES: 'false' } });
    await expect(mod.runOnce()).resolves.toBeNull();
  });

  test('a database failure is logged and the sweep returns null', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const mod = fx.loadIsolated('../../services/adCreativeSync', {
      mocks: { '../../utils/db': () => ({ getDb: () => { throw new Error('connection reset'); } }) },
    });
    await expect(mod.runOnce()).resolves.toBeNull();
    expect(err).toHaveBeenCalledWith('[adCreative] sync failed:', 'connection reset');
  });
});

describe('schedule', () => {
  test('first runs after 90 seconds, then every AD_CREATIVE_SYNC_INTERVAL_MIN minutes', () => {
    const timeout = jest.spyOn(global, 'setTimeout').mockImplementation(() => 0);
    const interval = jest.spyOn(global, 'setInterval').mockImplementation(() => 0);
    // Writes off, so the first run the timer fires is a no-op rather than a stray query.
    const mod = fx.loadIsolated('../../services/adCreativeSync', {
      env: { AD_CREATIVE_SYNC_INTERVAL_MIN: '3', ENABLE_MONGO_WRITES: 'false' },
    });
    mod.schedule();
    expect(timeout).toHaveBeenCalledWith(expect.any(Function), 90 * 1000);
    timeout.mock.calls[0][0]();
    expect(interval).toHaveBeenCalledWith(expect.any(Function), 3 * 60 * 1000);
  });
});
