/**
 * utils/videoDuration.js: a video's real length is the sum of its HLS #EXTINF
 * entries, and its real pixel size comes from probing its first segment (the
 * playlist's RESOLUTION is a hardcoded lie). Nothing here ever guesses: an
 * unreadable manifest is null. `fetch` is stubbed per URL and ffprobe is mocked.
 */
const mockProbe = { stdout: '1080,1920\n', fail: false, calls: [] };
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: (cmd, args, opts, cb) => {
    mockProbe.calls.push([cmd, args]);
    if (mockProbe.fail) cb(new Error('ffprobe: invalid data'));
    else cb(null, { stdout: mockProbe.stdout, stderr: '' });
  },
}));

const fs = require('fs');
const { durationFromManifest, videoShapeFromManifest, sumExtinf, GATEWAYS, MAX_PLAUSIBLE_SECONDS, UNKNOWN_DURATION } = require('../../utils/videoDuration');

/** Serve `routes` (url -> body string, Buffer, a status number, or 'throw'); anything else 404s. */
function stubFetch(routes) {
  const seen = [];
  jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
    const u = String(url);
    seen.push(u);
    const r = routes[u];
    if (r === 'throw') throw new Error('ECONNRESET');
    if (typeof r === 'number') return new Response(null, { status: r });
    if (r === undefined) return new Response(null, { status: 404 });
    return new Response(r, { status: 200 });
  });
  return seen;
}

const MEDIA = '#EXTM3U\n#EXTINF:10.5,\nseg0.ts\n#EXTINF:4.5,\nseg1.ts\n#EXT-X-ENDLIST\n';
const MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=854x480\n480p/index.m3u8\n';

beforeEach(() => {
  mockProbe.stdout = '1080,1920\n';
  mockProbe.fail = false;
  mockProbe.calls.length = 0;
});

describe('sumExtinf', () => {
  test.each([
    [MEDIA, 15],
    ['#EXTINF: 2,\n#EXTINF:3.25,', 5.25],
    ['#EXTM3U\nno segments', null],
    ['#EXTINF:0,', null],
    [`#EXTINF:${MAX_PLAUSIBLE_SECONDS + 1},`, null],   // a parse gone wrong, not a long video
  ])('%p -> %p', (text, expected) => {
    expect(sumExtinf(text)).toBe(expected);
  });
});

describe('durationFromManifest', () => {
  const [first, second] = GATEWAYS;

  test('no CID, no answer', async () => {
    expect(await durationFromManifest(null)).toBeNull();
  });

  test('an archived video is read from its S3 copy, the zone first, before any gateway', async () => {
    const seen = stubFetch({
      'https://buttercloud.b-cdn.net/vids/QmS/manifest.m3u8': MASTER,
      'https://buttercloud.b-cdn.net/vids/QmS/480p/index.m3u8': MEDIA,
    });
    const doc = { storage_state: 'archived', s3_url: 'https://buttercloud.b-cdn.net/vids/QmS/manifest.m3u8' };
    expect(await durationFromManifest('QmS', doc)).toBe(15);
    expect(seen.every((u) => u.startsWith('https://buttercloud.b-cdn.net/'))).toBe(true);
  });

  test('an S3 copy that does not answer falls through to s3.3speak.tv, then the gateways', async () => {
    const seen = stubFetch({ [`${first}/QmS/manifest.m3u8`]: MEDIA });
    const doc = { storage_state: 'archived', s3_url: 'https://buttercloud.b-cdn.net/vids/QmS/manifest.m3u8' };
    expect(await durationFromManifest('QmS', doc)).toBe(15);
    expect(seen.slice(0, 2)).toEqual([
      'https://buttercloud.b-cdn.net/vids/QmS/manifest.m3u8',
      'https://s3.3speak.tv/vids/QmS/manifest.m3u8',
    ]);
  });

  test('a media playlist at the manifest URL sums directly', async () => {
    stubFetch({ [`${first}/QmA/manifest.m3u8`]: MEDIA });
    expect(await durationFromManifest('QmA')).toBe(15);
  });

  test('a master playlist is followed to its first variant', async () => {
    stubFetch({ [`${first}/QmB/manifest.m3u8`]: MASTER, [`${first}/QmB/480p/index.m3u8`]: MEDIA });
    expect(await durationFromManifest('QmB')).toBe(15);
  });

  test('a gateway that fails (5xx, network error, unreadable variant) hands over to the next', async () => {
    const seen = stubFetch({
      [`${first}/QmC/manifest.m3u8`]: 500,
      [`${second}/QmC/manifest.m3u8`]: MASTER,
      [`${second}/QmC/480p/index.m3u8`]: MEDIA,
    });
    expect(await durationFromManifest('QmC')).toBe(15);
    expect(seen[0]).toBe(`${first}/QmC/manifest.m3u8`);
  });

  test('nothing readable anywhere is null, never a guess', async () => {
    stubFetch(Object.fromEntries(GATEWAYS.map((g) => [`${g}/QmD/manifest.m3u8`, '#EXTM3U\n#EXT-X-STREAM-INF:X\nnot-a-playlist.txt\n'])));
    expect(await durationFromManifest('QmD')).toBeNull();
    stubFetch(Object.fromEntries(GATEWAYS.map((g) => [`${g}/QmE/manifest.m3u8`, 'throw'])));
    expect(await durationFromManifest('QmE')).toBeNull();
  });

  test('a variant that 404s on every gateway is null', async () => {
    stubFetch(Object.fromEntries(GATEWAYS.map((g) => [`${g}/QmF/manifest.m3u8`, MASTER])));
    expect(await durationFromManifest('QmF')).toBeNull();
  });

  test('UNKNOWN_DURATION matches null, 0 and missing durations', () => {
    expect(UNKNOWN_DURATION).toEqual([{ duration: null }, { duration: 0 }, { duration: { $exists: false } }]);
  });
});

describe('videoShapeFromManifest', () => {
  const host = (g) => new URL(g).hostname;
  const url = (h, path) => `https://${h}/ipfs/QmS/${path}`;
  const [h1, h2] = GATEWAYS.map(host);

  test('no URL, no answer', async () => {
    expect(await videoShapeFromManifest('')).toBeNull();
  });

  test('probes the first segment of the first variant, and cleans up its temp file', async () => {
    const seen = stubFetch({
      [url(h1, 'manifest.m3u8')]: MASTER,
      [url(h1, '480p/index.m3u8')]: MEDIA,
      [url(h1, '480p/seg0.ts')]: Buffer.from('fake ts bytes'),
    });
    mockProbe.stdout = '720,1280\n';

    expect(await videoShapeFromManifest(url(h1, 'manifest.m3u8'))).toEqual({ width: 720, height: 1280 });
    expect(seen).toContain(url(h1, '480p/seg0.ts'));
    const tmpFile = mockProbe.calls[0][1].at(-1);
    expect(mockProbe.calls[0][0]).toBe('ffprobe');
    expect(fs.existsSync(tmpFile)).toBe(false);
  });

  test('a manifest missing on one gateway is read from a sibling', async () => {
    stubFetch({
      [url(h2, 'manifest.m3u8')]: MEDIA,
      [url(h2, 'seg0.ts')]: Buffer.from('x'),
    });
    expect(await videoShapeFromManifest(url(h1, 'manifest.m3u8'))).toEqual({ width: 1080, height: 1920 });
  });

  test.each([
    ['the manifest is nowhere', {}],
    ['a master playlist lists no variant', { [url(h1, 'manifest.m3u8')]: '#EXTM3U\n#EXT-X-STREAM-INF:X\n' }],
    ['the variant is nowhere', { [url(h1, 'manifest.m3u8')]: MASTER }],
    ['the playlist has no segment', { [url(h1, 'manifest.m3u8')]: '#EXTM3U\n#EXT-X-ENDLIST\n' }],
    ['the segment fails to download', { [url(h1, 'manifest.m3u8')]: MEDIA, [url(h1, 'seg0.ts')]: 503 }],
    ['the segment request throws', { [url(h1, 'manifest.m3u8')]: MEDIA, [url(h1, 'seg0.ts')]: 'throw' }],
  ])('null when %s', async (_label, routes) => {
    stubFetch(routes);
    expect(await videoShapeFromManifest(url(h1, 'manifest.m3u8'))).toBeNull();
  });

  test.each([
    ['ffprobe fails', () => { mockProbe.fail = true; }],
    ['ffprobe reports no video stream', () => { mockProbe.stdout = '\n'; }],
  ])('null when %s', async (_label, arrange) => {
    arrange();
    stubFetch({ [url(h1, 'manifest.m3u8')]: MEDIA, [url(h1, 'seg0.ts')]: Buffer.from('x') });
    expect(await videoShapeFromManifest(url(h1, 'manifest.m3u8'))).toBeNull();
  });

  test('a URL that is not a URL is null', async () => {
    stubFetch({});
    expect(await videoShapeFromManifest('not a url')).toBeNull();
  });
});
