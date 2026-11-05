/**
 * Duration repair (services/durationSync.js): a published video with no length
 * gets one from its own manifest, an unreadable manifest is stamped and retried on
 * a fresh/old cadence, and a duration that is already set is never overwritten.
 * The manifest reader (utils/videoDuration.durationFromManifest) is stubbed per CID.
 */
jest.mock('../../utils/videoDuration', () => ({
  ...jest.requireActual('../../utils/videoDuration'),
  durationFromManifest: jest.fn(),
}));

const { Collection } = require('mongodb');
const testDb = require('../helpers/db');
const { NOW, MINUTE, DAY, ago } = require('./_fixtures');
const vd = require('../../utils/videoDuration');
const { syncDurations, syncLegacyDurations, syncAllDurations } = require('../../services/durationSync');

const db = testDb.use();
const embeds = () => db().collection('embed-video');
const legacy = () => db().collection('videos');

const REAL_TIMERS = ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'];

/** Manifests by CID: a number of seconds, null (unreadable) or an Error (fetch blew up). */
let manifests;
beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: REAL_TIMERS });
  manifests = {};
  vd.durationFromManifest.mockReset().mockImplementation(async (cid) => {
    const v = manifests[cid];
    if (v instanceof Error) throw v;
    return v === undefined ? null : v;
  });
});
afterEach(() => jest.useRealTimers());

const embed = (permlink, extra = {}) => ({
  owner: 'alice', permlink, status: 'published', manifest_cid: `cid-${permlink}`, duration: null, createdAt: ago(10 * DAY), ...extra,
});

describe('embed videos', () => {
  test('fills a missing length from the manifest, rounded, with provenance', async () => {
    await embeds().insertOne(embed('v1'));
    manifests['cid-v1'] = 181.6;

    const run = await syncDurations();

    expect(run).toEqual({ scanned: 1, updated: 1, unreadable: 0 });
    expect(await embeds().findOne({ permlink: 'v1' })).toMatchObject({
      duration: 182, duration_source: 'manifest', duration_backfilled_at: NOW, duration_sync_checked_at: NOW,
    });
  });

  test.each([
    ['null', { duration: null }],
    ['zero', { duration: 0 }],
    ['absent', {}],
  ])('treats a %s duration as unknown', async (_name, durationField) => {
    const { duration: _drop, ...doc } = embed('v1');
    await embeds().insertOne({ ...doc, ...durationField });
    manifests['cid-v1'] = 30;
    expect((await syncDurations()).updated).toBe(1);
  });

  test('a sub-second clip is stored as 1 second, never 0 (0 would read as unknown forever)', async () => {
    await embeds().insertOne(embed('blip'));
    manifests['cid-blip'] = 0.4;
    await syncDurations();
    expect((await embeds().findOne({ permlink: 'blip' })).duration).toBe(1);
  });

  test('leaves alone videos that are not candidates', async () => {
    await embeds().insertMany([
      embed('has-length', { duration: 42 }),
      embed('draft', { status: 'encoding' }),
      embed('no-manifest', { manifest_cid: '' }),
      embed('null-manifest', { manifest_cid: null }),
    ]);
    manifests['cid-has-length'] = 99;

    expect(await syncDurations()).toEqual({ scanned: 0, updated: 0, unreadable: 0 });
    expect(vd.durationFromManifest).not.toHaveBeenCalled();
    expect((await embeds().findOne({ permlink: 'has-length' })).duration).toBe(42);
  });

  test('an unreadable or failing manifest is stamped as checked, and the length stays unknown', async () => {
    await embeds().insertMany([embed('gone'), embed('boom')]);
    manifests['cid-boom'] = new Error('gateway 500');

    const run = await syncDurations();

    expect(run).toEqual({ scanned: 2, updated: 0, unreadable: 2 });
    for (const d of await embeds().find().toArray()) {
      expect(d.duration).toBeNull();
      expect(d.duration_sync_checked_at).toEqual(NOW);
    }
  });

  test('running twice is a no-op the second time: filled docs drop out, stamped ones wait', async () => {
    await embeds().insertMany([embed('ok'), embed('gone')]);
    manifests['cid-ok'] = 60;
    await syncDurations();
    vd.durationFromManifest.mockClear();

    expect(await syncDurations()).toEqual({ scanned: 0, updated: 0, unreadable: 0 });
    expect(vd.durationFromManifest).not.toHaveBeenCalled();
  });

  test('a stamped fresh video is retried after 30 minutes, an old one only after 7 days', async () => {
    await embeds().insertMany([
      embed('fresh-due', { createdAt: ago(DAY), duration_sync_checked_at: ago(31 * MINUTE) }),
      embed('fresh-wait', { createdAt: ago(DAY), duration_sync_checked_at: ago(29 * MINUTE) }),
      embed('old-due', { createdAt: ago(30 * DAY), duration_sync_checked_at: ago(8 * DAY) }),
      embed('old-wait', { createdAt: ago(30 * DAY), duration_sync_checked_at: ago(6 * DAY) }),
    ]);

    await syncDurations();

    const asked = vd.durationFromManifest.mock.calls.map(([cid]) => cid).sort();
    expect(asked).toEqual(['cid-fresh-due', 'cid-old-due']);
  });

  test('works newest first and at most DURATION_SYNC_BATCH (30) per run', async () => {
    await embeds().insertMany(Array.from({ length: 35 }, (_, i) => embed(`v${i}`, { createdAt: ago((i + 1) * MINUTE) })));
    const run = await syncDurations();
    expect(run.scanned).toBe(30);
    const asked = new Set(vd.durationFromManifest.mock.calls.map(([cid]) => cid));
    expect(asked.has('cid-v0')).toBe(true);
    expect(asked.has('cid-v34')).toBe(false);
  });

  test('a length written by someone else while the manifest was read is not overwritten', async () => {
    await embeds().insertOne(embed('race'));
    vd.durationFromManifest.mockImplementation(async () => {
      await embeds().updateOne({ permlink: 'race' }, { $set: { duration: 77 } });   // a late client write
      return 120;
    });

    const run = await syncDurations();

    expect(run.updated).toBe(0);
    expect((await embeds().findOne({ permlink: 'race' })).duration).toBe(77);
  });

  test('a failed write is logged and reported as nothing done', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await embeds().insertOne(embed('v1'));
    manifests['cid-v1'] = 10;
    jest.spyOn(Collection.prototype, 'bulkWrite').mockRejectedValue(new Error('write conflict'));

    expect(await syncDurations()).toEqual({ scanned: 1, updated: 0, unreadable: 0 });
    expect(console.error).toHaveBeenCalledWith('[durationSync] bulkWrite error:', 'write conflict');
  });
});

describe('legacy videos', () => {
  const old = (id, extra = {}) => ({
    _id: id, owner: 'bob', permlink: id, status: 'published', created: ago(10 * DAY),
    video_v2: `ipfs://Qm${id}/manifest.m3u8`, duration: null, ...extra,
  });

  test('reads the CID out of video_v2 and stores the unrounded length', async () => {
    await legacy().insertOne(old('a'));
    manifests.Qma = 181.649705;

    expect(await syncLegacyDurations()).toEqual({ scanned: 1, updated: 1, unreadable: 0 });
    expect(await legacy().findOne({ _id: 'a' })).toMatchObject({ duration: 181.649705, duration_source: 'manifest' });
    expect(vd.durationFromManifest).toHaveBeenCalledWith('Qma');
  });

  test('skips rows whose video_v2 is not an IPFS manifest, and stamps unreadable ones', async () => {
    await legacy().insertMany([
      old('a'),
      old('b', { video_v2: 'https://cdn.example/b.mp4' }),
      old('c', { duration: 50 }),
    ]);

    expect(await syncLegacyDurations()).toEqual({ scanned: 1, updated: 0, unreadable: 1 });
    expect((await legacy().findOne({ _id: 'a' })).duration_sync_checked_at).toEqual(NOW);
    expect((await legacy().findOne({ _id: 'b' })).duration_sync_checked_at).toBeUndefined();
  });

  test('nothing to do returns zeros without reading a manifest', async () => {
    expect(await syncLegacyDurations()).toEqual({ scanned: 0, updated: 0, unreadable: 0 });
  });

  test('a failed write is logged, not thrown', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await legacy().insertOne(old('a'));
    jest.spyOn(Collection.prototype, 'bulkWrite').mockRejectedValue(new Error('disk full'));
    expect(await syncLegacyDurations()).toEqual({ scanned: 1, updated: 0, unreadable: 0 });
  });
});

describe('the scheduled cycle', () => {
  test('embed videos every cycle, legacy videos on the first and every sixth', async () => {
    const legacyRan = [];
    for (let i = 0; i < 7; i += 1) legacyRan.push((await syncAllDurations()).legacy !== null);
    expect(legacyRan).toEqual([true, false, false, false, false, false, true]);
  });
});
