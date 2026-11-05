/**
 * thumbnailSync: an embed-video whose Hive post carries a thumbnail in its
 * metadata, but whose doc has none, gets that thumbnail copied over. Additive
 * only, stamped so a post with no image is not re-read every run. Chain is a fake
 * behind hiveRpcBatch; writes go to the real test MongoDB.
 */
process.env.THUMBNAIL_SYNC_BATCH = '3';

jest.mock('../../utils/hive', () => ({ hiveRpcBatch: jest.fn() }));

const testDb = require('../helpers/db');
const { hiveRpcBatch } = require('../../utils/hive');
const { syncThumbnails, pickThumbnail } = require('../../services/thumbnailSync');
const { NOW, MINUTE, DAY, ago } = require('./_fixtures');

const db = testDb.use();
const ev = () => db().collection('embed-video');

const ONLY_DATE = ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame',
  'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate',
  'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'];

let meta; // author/permlink -> json_metadata of a live post
function chain() {
  meta = new Map();
  hiveRpcBatch.mockImplementation(async (batch) => batch.map((r) => {
    const key = r.params.join('/');
    if (!meta.has(key)) return { id: r.id, result: { author: '', permlink: '' } };
    return { id: r.id, result: { author: r.params[0], permlink: r.params[1], json_metadata: meta.get(key) } };
  }));
}
const video = (permlink, extra = {}) => ({
  owner: 'alice', permlink: `asset-${permlink}`, hive_author: 'alice', hive_permlink: permlink,
  status: 'published', thumbnail_url: null, createdAt: ago(DAY), ...extra,
});
const get = (permlink) => ev().findOne({ hive_permlink: permlink });
const withImage = (url) => JSON.stringify({ image: [url] });

beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ONLY_DATE });
  hiveRpcBatch.mockReset();
  chain();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.useRealTimers());

describe('pickThumbnail', () => {
  test.each([
    ['the sourceMap thumbnail wins over image[0]',
      { video: { info: { sourceMap: [{ type: 'video', url: 'x' }, { type: 'thumbnail', url: 'https://t/map.jpg' }] } }, image: ['https://t/img.jpg'] },
      'https://t/map.jpg'],
    ['image[0]', { image: ['https://t/img.jpg', 'https://t/2.jpg'] }, 'https://t/img.jpg'],
    ['image as a plain string', { image: 'http://t/s.png' }, 'http://t/s.png'],
    ['an ipfs:// URL is not usable', { image: ['ipfs://Qm123'] }, null],
    ['no image at all', { tags: ['x'] }, null],
  ])('%s', (_label, m, expected) => {
    expect(pickThumbnail({ json_metadata: JSON.stringify(m) })).toBe(expected);
    expect(pickThumbnail({ json_metadata: m })).toBe(expected); // object metadata too
  });

  test.each([[{ json_metadata: '{bad' }], [{ json_metadata: 'null' }], [{}], [null]])('unusable metadata %p -> null', (post) => {
    expect(pickThumbnail(post)).toBeNull();
  });
});

describe('syncThumbnails', () => {
  test.each([[null], [''], [undefined]])('fills a thumbnail_url of %p from the post', async (empty) => {
    meta.set('alice/p1', withImage('https://img/p1.jpg'));
    const v = video('p1', { thumbnail_url: empty });
    if (empty === undefined) delete v.thumbnail_url;
    await ev().insertOne(v);

    const res = await syncThumbnails();

    expect(res).toEqual({ scanned: 1, updated: 1, noImage: 0 });
    expect(await get('p1')).toMatchObject({
      thumbnail_url: 'https://img/p1.jpg', thumbnail_backfilled_at: NOW, thumbnail_sync_checked_at: NOW,
    });
  });

  test('never touches a doc that already has a thumbnail', async () => {
    meta.set('alice/p1', withImage('https://img/p1.jpg'));
    await ev().insertOne(video('p1', { thumbnail_url: 'https://mine.jpg' }));

    expect(await syncThumbnails()).toEqual({ scanned: 0, updated: 0 });
    expect((await get('p1')).thumbnail_url).toBe('https://mine.jpg');
  });

  test('a thumbnail uploaded while the worker was on the network is kept', async () => {
    meta.set('alice/p1', withImage('https://img/from-chain.jpg'));
    const inner = hiveRpcBatch.getMockImplementation();
    hiveRpcBatch.mockImplementation(async (batch) => {
      await ev().updateOne({ hive_permlink: 'p1' }, { $set: { thumbnail_url: 'https://img/uploaded.jpg' } });
      return inner(batch);
    });
    await ev().insertOne(video('p1'));

    const res = await syncThumbnails();

    expect(res.updated).toBe(0);
    expect((await get('p1')).thumbnail_url).toBe('https://img/uploaded.jpg');
  });

  test('a post with no image is stamped and counted apart from real fills', async () => {
    meta.set('alice/hit', withImage('https://img/hit.jpg'));
    meta.set('alice/noimg', JSON.stringify({ tags: ['a'] }));
    await ev().insertMany([video('hit'), video('noimg')]);

    const res = await syncThumbnails();

    expect(res).toEqual({ scanned: 2, updated: 1, noImage: 1 });
    const miss = await get('noimg');
    expect(miss.thumbnail_url).toBeNull();
    expect(miss.thumbnail_sync_checked_at).toEqual(NOW);
  });

  test('a deleted post is left unstamped so it is retried next run', async () => {
    await ev().insertOne(video('gone'));

    expect(await syncThumbnails()).toEqual({ scanned: 1, updated: 0, noImage: 0 });
    expect((await get('gone')).thumbnail_sync_checked_at).toBeUndefined();
  });

  test('a fresh miss is retried after 30 minutes, an old one only after 7 days', async () => {
    await ev().insertMany([
      video('fresh-due', { thumbnail_sync_checked_at: ago(31 * MINUTE) }),
      video('fresh-wait', { thumbnail_sync_checked_at: ago(10 * MINUTE) }),
      video('old-due', { createdAt: ago(30 * DAY), thumbnail_sync_checked_at: ago(8 * DAY) }),
      video('old-wait', { createdAt: ago(30 * DAY), thumbnail_sync_checked_at: ago(DAY) }),
    ]);

    await syncThumbnails();

    const asked = hiveRpcBatch.mock.calls[0][0].map((r) => r.params[1]).sort();
    expect(asked).toEqual(['fresh-due', 'old-due']);
  });

  test('takes at most THUMBNAIL_SYNC_BATCH docs per run, newest first', async () => {
    await ev().insertMany([1, 2, 3, 4].map((i) => video(`p${i}`, { createdAt: ago(i * MINUTE) })));

    const res = await syncThumbnails();

    expect(res.scanned).toBe(3);
    expect(hiveRpcBatch.mock.calls[0][0].map((r) => r.params[1])).toEqual(['p1', 'p2', 'p3']);
  });

  test('running twice changes nothing the second time', async () => {
    meta.set('alice/hit', withImage('https://img/hit.jpg'));
    meta.set('alice/noimg', '{}');
    await ev().insertMany([video('hit'), video('noimg')]);
    await syncThumbnails();
    const after = await ev().find({}).sort({ hive_permlink: 1 }).toArray();

    expect(await syncThumbnails()).toEqual({ scanned: 0, updated: 0 });
    expect(await ev().find({}).sort({ hive_permlink: 1 }).toArray()).toEqual(after);
  });

  test('a total Hive outage writes nothing', async () => {
    hiveRpcBatch.mockResolvedValue([]);
    await ev().insertOne(video('p1'));

    expect(await syncThumbnails()).toEqual({ scanned: 1, updated: 0, noImage: 0 });
    expect((await get('p1')).thumbnail_sync_checked_at).toBeUndefined();
  });

  test('a failing bulk write is logged and the run still returns', async () => {
    meta.set('alice/p1', withImage('https://img/p1.jpg'));
    await ev().insertOne(video('p1'));
    const { Collection } = require('mongodb');
    jest.spyOn(Collection.prototype, 'bulkWrite').mockRejectedValue(new Error('not primary'));

    await expect(syncThumbnails()).resolves.toEqual({ scanned: 1, updated: 0, noImage: 0 });
    expect(console.error).toHaveBeenCalledWith('[thumbnailSync] bulkWrite error:', 'not primary');
  });
});
