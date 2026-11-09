/**
 * thumbnailFrame: a published video with no thumbnail anywhere (not on the doc,
 * not on its Hive post) gets a frame of the video as its thumbnail. Only after
 * thumbnailSync has looked, never over a real thumbnail, and an image that has
 * since appeared on the post wins over a frame. ffmpeg, the image host and the
 * chain are fakes; writes go to the real test MongoDB.
 */
process.env.IMAGE_UPLOAD_KEY = 'test-image-key';
process.env.IMAGE_UPLOAD_URL = 'https://images.test';
process.env.THUMBNAIL_FRAME_BATCH = '5';

jest.mock('../../utils/hive', () => ({ hiveRpcBatch: jest.fn() }));
jest.mock('../../utils/videoFrame', () => ({
  grabFrame: jest.fn(), ffmpegAvailable: jest.fn(), uploadImage: jest.fn(),
}));

const testDb = require('../helpers/db');
const { hiveRpcBatch } = require('../../utils/hive');
const { grabFrame, ffmpegAvailable, uploadImage } = require('../../utils/videoFrame');
const { generateFrameThumbnails, _reset } = require('../../services/thumbnailFrame');
const { NOW, MINUTE, DAY, ago } = require('./_fixtures');

const db = testDb.use();
const ev = () => db().collection('embed-video');
const CID = 'QmUuvboErTF1f5ocX5EfzMV8GqpKzmcxAJoBZ7iNRgCtFb';
const FRAME = Buffer.from('jpeg-bytes');

const ONLY_DATE = ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame',
  'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate',
  'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'];

let meta; // author/permlink -> json_metadata of a live post (absent = unreadable)
const video = (permlink, extra = {}) => ({
  owner: 'alice', permlink: `asset-${permlink}`, hive_author: 'alice', hive_permlink: permlink,
  status: 'published', manifest_cid: CID, thumbnail_url: null, short: true,
  thumbnail_sync_checked_at: ago(10 * MINUTE), createdAt: ago(DAY), ...extra,
});
const get = (permlink) => ev().findOne({ hive_permlink: permlink });
const posted = (permlink, m = {}) => meta.set(`alice/${permlink}`, JSON.stringify(m));

beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ONLY_DATE });
  _reset();
  meta = new Map();
  hiveRpcBatch.mockReset().mockImplementation(async (batch) => batch.map((r) => {
    const key = r.params.join('/');
    if (!meta.has(key)) return { id: r.id, result: { author: '', permlink: '' } };
    return { id: r.id, result: { author: r.params[0], permlink: r.params[1], json_metadata: meta.get(key) } };
  }));
  ffmpegAvailable.mockReset().mockResolvedValue(true);
  grabFrame.mockReset().mockResolvedValue({ frame: FRAME, timedOut: false });
  uploadImage.mockReset().mockResolvedValue('https://images.3speak.tv/images/frame.webp');
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.useRealTimers());

describe('generateFrameThumbnails', () => {
  test('a video with no thumbnail on the doc or the post gets a frame', async () => {
    posted('p1', { tags: ['x'] });
    await ev().insertOne(video('p1'));

    const res = await generateFrameThumbnails();

    expect(res).toMatchObject({ scanned: 1, generated: 1, fromPost: 0, failed: 0 });
    expect(grabFrame).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`/ipfs/${CID}/manifest\\.m3u8$`)), 1);
    expect(uploadImage).toHaveBeenCalledWith(FRAME, { url: 'https://images.test', key: 'test-image-key' });
    expect(await get('p1')).toMatchObject({
      thumbnail_url: 'https://images.3speak.tv/images/frame.webp', thumbnail_source: 'frame', thumbnail_generated_at: NOW,
    });
  });

  test('an image that has since appeared on the post wins over a frame', async () => {
    posted('p1', { image: ['https://img/real.jpg'] });
    await ev().insertOne(video('p1'));

    const res = await generateFrameThumbnails();

    expect(res).toMatchObject({ fromPost: 1, generated: 0 });
    expect(grabFrame).not.toHaveBeenCalled();
    expect((await get('p1')).thumbnail_url).toBe('https://img/real.jpg');
  });

  test.each([
    ['already has a thumbnail', { thumbnail_url: 'https://img/x.jpg' }],
    ['thumbnailSync has not looked at the post yet', { thumbnail_sync_checked_at: undefined }],
    ['uploaded too recently', { createdAt: ago(30 * MINUTE) }],
    ['not published', { status: 'encoding' }],
    ['gated', { gated: true }],
    ['no Hive post', { hive_author: null, hive_permlink: null }],
    ['no manifest', { manifest_cid: null }],
    ['out of attempts', { thumbnail_frame_attempts: 3, thumbnail_frame_failed_at: ago(DAY) }],
    ['failed too recently to retry', { thumbnail_frame_attempts: 1, thumbnail_frame_failed_at: ago(MINUTE) }],
  ])('skipped when %s', async (_label, extra) => {
    posted('p1');
    const v = video('p1', extra);
    for (const k of Object.keys(v)) if (v[k] === undefined) delete v[k];
    await ev().insertOne(v);

    const res = await generateFrameThumbnails();

    expect(res.scanned).toBe(0);
    expect(grabFrame).not.toHaveBeenCalled();
  });

  test('a failed frame is counted, retried later, and leaves the thumbnail empty', async () => {
    posted('p1');
    await ev().insertOne(video('p1', { thumbnail_frame_attempts: 1, thumbnail_frame_failed_at: ago(DAY) }));
    grabFrame.mockResolvedValue({ frame: null, timedOut: false });

    const res = await generateFrameThumbnails();

    expect(res).toMatchObject({ scanned: 1, failed: 1, generated: 0 });
    // Ran to the end with nothing at 1 s: the start is tried too, on every gateway.
    expect(grabFrame.mock.calls.filter((c) => c[1] === 0).length).toBe(grabFrame.mock.calls.length / 2);
    expect(await get('p1')).toMatchObject({
      thumbnail_url: null, thumbnail_frame_attempts: 2, thumbnail_frame_failed_at: NOW, thumbnail_frame_error: 'no frame',
    });
    expect(uploadImage).not.toHaveBeenCalled();
  });

  test('a gateway that stalls is passed over for the next one, without a second seek', async () => {
    posted('p1');
    await ev().insertOne(video('p1'));
    grabFrame
      .mockResolvedValueOnce({ frame: null, timedOut: true })
      .mockResolvedValueOnce({ frame: FRAME, timedOut: false });

    const res = await generateFrameThumbnails();

    expect(res.generated).toBe(1);
    expect(grabFrame).toHaveBeenCalledTimes(2);
    const [a, b] = grabFrame.mock.calls;
    expect([a[1], b[1]]).toEqual([1, 1]);
    expect(new URL(a[0]).host).not.toBe(new URL(b[0]).host);
  });

  test('an upload failure is recorded as a failed attempt', async () => {
    posted('p1');
    await ev().insertOne(video('p1'));
    uploadImage.mockRejectedValue(new Error('image upload failed (503)'));

    await generateFrameThumbnails();

    expect(await get('p1')).toMatchObject({
      thumbnail_url: null, thumbnail_frame_attempts: 1, thumbnail_frame_error: 'image upload failed (503)',
    });
  });

  test('a post that cannot be read is left for the next run, unstamped', async () => {
    await ev().insertOne(video('gone'));   // no meta: the chain answers with an empty post

    const res = await generateFrameThumbnails();

    expect(res).toMatchObject({ scanned: 1, generated: 0, failed: 0 });
    expect(grabFrame).not.toHaveBeenCalled();
    expect(await get('gone')).not.toHaveProperty('thumbnail_frame_attempts');
  });

  test('never overwrites a thumbnail that arrives while the frame is being made', async () => {
    posted('p1');
    await ev().insertOne(video('p1'));
    grabFrame.mockImplementation(async () => {
      await ev().updateOne({ hive_permlink: 'p1' }, { $set: { thumbnail_url: 'https://img/uploaded.jpg' } });
      return { frame: FRAME, timedOut: false };
    });

    const res = await generateFrameThumbnails();

    expect(res.generated).toBe(0);
    expect((await get('p1')).thumbnail_url).toBe('https://img/uploaded.jpg');
  });

  test('a manifest_cid that is not a CID is never handed to ffmpeg', async () => {
    posted('p1');
    await ev().insertOne(video('p1', { manifest_cid: 'file:///etc/passwd' }));

    await generateFrameThumbnails();

    expect(grabFrame).not.toHaveBeenCalled();
    expect(await get('p1')).toMatchObject({ thumbnail_frame_error: 'bad manifest_cid' });
  });

  test('newest first, at most a batch per run', async () => {
    for (let i = 0; i < 7; i++) {
      posted(`p${i}`);
      await ev().insertOne(video(`p${i}`, { createdAt: ago(DAY + i * MINUTE) }));
    }

    const res = await generateFrameThumbnails();

    expect(res.generated).toBe(5);
    expect((await get('p5')).thumbnail_url).toBeNull();
    expect((await get('p0')).thumbnail_source).toBe('frame');
  });

  test('without ffmpeg the job does nothing and says so once', async () => {
    ffmpegAvailable.mockResolvedValue(false);
    posted('p1');
    await ev().insertOne(video('p1'));

    expect(await generateFrameThumbnails()).toEqual({ skipped: 'no ffmpeg' });
    expect(await generateFrameThumbnails()).toEqual({ skipped: 'no ffmpeg' });
    expect(ffmpegAvailable).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect((await get('p1')).thumbnail_url).toBeNull();
  });
});
