/**
 * utils/s3Storage.js: which docs have a usable S3 copy, and which URLs are in the
 * bucket. The same rules as the player's (snapievideoplayer hlsGateways.js), so the
 * two agree on what plays from S3.
 */
const S = require('../utils/s3Storage');

const ZONE = 'https://buttercloud.b-cdn.net/vids/QmA/manifest.m3u8';

describe('s3Parts', () => {
  test.each([
    [ZONE, { host: 'buttercloud.b-cdn.net', bucket: 'vids', cid: 'QmA', cidPath: 'QmA/manifest.m3u8' }],
    ['https://s3.3speak.tv/vids/QmA/480p/index.m3u8', { host: 's3.3speak.tv', bucket: 'vids', cid: 'QmA', cidPath: 'QmA/480p/index.m3u8' }],
  ])('%s', (url, parts) => expect(S.s3Parts(url)).toEqual(parts));

  test.each([
    ['http, not https', 'http://s3.3speak.tv/vids/QmA/manifest.m3u8'],
    ['another host', 'https://evil.example/vids/QmA/manifest.m3u8'],
    ['a port', 'https://s3.3speak.tv:8443/vids/QmA/manifest.m3u8'],
    ['credentials', 'https://u:p@s3.3speak.tv/vids/QmA/manifest.m3u8'],
    ['no file under the CID', 'https://s3.3speak.tv/vids/QmA'],
    ['an invalid bucket name', 'https://s3.3speak.tv/A_B/QmA/manifest.m3u8'],
    ['garbage', 'not a url'],
    ['nothing', undefined],
  ])('refuses %s', (_label, url) => expect(S.s3Parts(url)).toBeNull());

  test('`..` cannot climb out of the bucket', () => {
    expect(S.s3Parts('https://s3.3speak.tv/vids/../other/QmA/manifest.m3u8')).toMatchObject({ bucket: 'other' });
  });
});

describe('s3CopyOf', () => {
  test.each(['hot', 'archived', 'promoting'])('%s with our s3_url has a copy', (state) => {
    expect(S.s3CopyOf({ storage_state: state, s3_url: ZONE }, 'QmA')).toEqual({ bucket: 'vids', cid: 'QmA' });
  });

  test.each([
    ['no storage_state', { s3_url: ZONE }],
    ['an unknown state', { storage_state: 'frozen', s3_url: ZONE }],
    ['no s3_url', { storage_state: 'archived' }],
    ['another CID', { storage_state: 'archived', s3_url: 'https://buttercloud.b-cdn.net/vids/QmB/manifest.m3u8' }],
  ])('none with %s', (_label, doc) => expect(S.s3CopyOf(doc, 'QmA')).toBeNull());

  test('no doc, no copy', () => expect(S.s3CopyOf(null)).toBeNull());
});

test('isOffHotnode: archived and promoting only', () => {
  expect(['hot', 'archived', 'promoting', undefined].map((s) => S.isOffHotnode({ storage_state: s })))
    .toEqual([false, true, true, false]);
});

test('s3UrlsFor: the zone first, then s3.3speak.tv', () => {
  expect(S.s3UrlsFor({ bucket: 'vids', cid: 'QmA' }, '480p/index.m3u8')).toEqual([
    'https://buttercloud.b-cdn.net/vids/QmA/480p/index.m3u8',
    'https://s3.3speak.tv/vids/QmA/480p/index.m3u8',
  ]);
  expect(S.s3UrlsFor(null)).toEqual([]);
});

test('s3Siblings and sameS3Folder', () => {
  expect(S.s3Siblings(ZONE)).toEqual(['https://s3.3speak.tv/vids/QmA/manifest.m3u8']);
  expect(S.s3Siblings('https://ipfs-3speak.b-cdn.net/ipfs/QmA/manifest.m3u8')).toEqual([]);
  expect(S.sameS3Folder(ZONE, 'https://s3.3speak.tv/vids/QmA/480p/index.m3u8')).toBe(true);
  expect(S.sameS3Folder(ZONE, 'https://s3.3speak.tv/vids/QmB/480p/index.m3u8')).toBe(false);
  expect(S.sameS3Folder(ZONE, 'https://s3.3speak.tv/other/QmA/manifest.m3u8')).toBe(false);
});

describe('S3_BUCKET pins the bucket', () => {
  afterEach(() => { delete process.env.S3_BUCKET; jest.resetModules(); });

  test('another bucket is refused once S3_BUCKET is set', () => {
    process.env.S3_BUCKET = 'vids';
    jest.isolateModules(() => {
      const P = require('../utils/s3Storage');
      expect(P.s3Parts(ZONE)).not.toBeNull();
      expect(P.s3Parts('https://s3.3speak.tv/other/QmA/manifest.m3u8')).toBeNull();
    });
  });

  test('an invalid S3_BUCKET is ignored with a warning', () => {
    process.env.S3_BUCKET = 'Not A Bucket';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.isolateModules(() => {
      expect(require('../utils/s3Storage').S3_BUCKET).toBe('');
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('S3_BUCKET'));
    warn.mockRestore();
  });
});
