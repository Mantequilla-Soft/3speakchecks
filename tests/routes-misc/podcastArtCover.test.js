/**
 * Cover rendering: utils/podcastCover.js (the square 1400 px covers of 3Speak's own
 * feeds) and utils/podcastArt.js (small covers of outside podcasts).
 *
 * ffmpeg runs for real on a tiny generated image; the image hosts are stand-ins.
 * The point of both modules is that they are NOT open image proxies, so most tests
 * here are about what they refuse to fetch.
 */
const { spawnSync } = require('child_process');

jest.mock('../../utils/safeFetch', () => ({ ...jest.requireActual('../../utils/safeFetch'), safeFetch: jest.fn() }));
const { safeFetch } = require('../../utils/safeFetch');

/** A 64x32 red PNG made by ffmpeg, so every test starts from a real, non-square image. */
const PNG = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x32', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'], { maxBuffer: 1 << 20 }).stdout;

/** Width and height from a JPEG's start-of-frame marker. */
function jpegSize(buf) {
  expect(buf.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(true);
  for (let i = 2; i < buf.length - 9;) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xc3) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error('no SOF marker');
}

/** A minimal fetch Response for the cover fetcher. */
const response = ({ status = 200, body = PNG, headers = {} } = {}) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
});

describe('utils/podcastCover: square feed covers from known image hosts only', () => {
  const { renderCover, isAllowedSource, COVER_SIZE } = require('../../utils/podcastCover');
  let fetchSpy;
  beforeEach(() => { fetchSpy = jest.spyOn(global, 'fetch'); });

  test.each([
    ['https://images.hive.blog/u/alice/avatar/large', true],
    ['https://files.peakd.com/file/x.png', true],
    ['https://IMAGES.3speak.tv/x.png', true],
    ['http://images.hive.blog/u/alice/avatar', false],     // plain http
    ['https://evil.example.com/x.png', false],
    ['https://images.hive.blog.evil.example.com/x.png', false],
    ['https://127.0.0.1/x.png', false],
    ['not a url', false],
  ])('%s allowed: %s', (url, allowed) => {
    expect(isAllowedSource(url)).toBe(allowed);
  });

  test('renders a 1400 px square JPEG, cropped or fitted', async () => {
    fetchSpy.mockResolvedValue(response());
    for (const fit of ['crop', 'fit']) {
      const jpeg = await renderCover('https://images.hive.blog/u/alice/avatar/large', { fit });
      expect(jpegSize(jpeg)).toEqual({ width: COVER_SIZE, height: COVER_SIZE });
    }
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  test('a host outside the list is never asked', async () => {
    await expect(renderCover('https://evil.example.com/x.png')).rejects.toThrow('source not allowed');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('a redirect is followed only while it stays on an allowed host', async () => {
    fetchSpy
      .mockResolvedValueOnce(response({ status: 302, headers: { location: '/u/alice/avatar/small' } }))
      .mockResolvedValueOnce(response({ status: 301, headers: { location: 'http://169.254.169.254/latest/meta-data' } }));
    await expect(renderCover('https://images.hive.blog/u/alice/avatar')).rejects.toThrow('source not allowed: http://169.254.169.254');
    expect(fetchSpy.mock.calls.map((c) => c[0])).toEqual([
      'https://images.hive.blog/u/alice/avatar',
      'https://images.hive.blog/u/alice/avatar/small',
    ]);
  });

  test('more than three redirects is refused', async () => {
    fetchSpy.mockResolvedValue(response({ status: 302, headers: { location: 'https://images.hive.blog/again' } }));
    await expect(renderCover('https://images.hive.blog/start')).rejects.toThrow('too many redirects');
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  test.each([
    ['an error answer', response({ status: 404 }), 'source HTTP 404'],
    ['a declared size over 25 MB', response({ headers: { 'content-length': String(26 * 1024 * 1024) } }), 'source too large'],
    ['a body over 25 MB without a length', response({ body: Buffer.alloc(25 * 1024 * 1024 + 1) }), 'source too large'],
    ['bytes that are not an image', response({ body: Buffer.from('<html>nope</html>') }), /ffmpeg exited/],
  ])('%s fails the render', async (_label, answer, error) => {
    fetchSpy.mockResolvedValue(answer);
    await expect(renderCover('https://images.hive.blog/u/x/avatar')).rejects.toThrow(error);
  });
});

describe('utils/podcastArt: small covers only for tokens the checker signed', () => {
  const { artToken, urlFromToken, renderArt, SIZES } = require('../../utils/podcastArt');
  const image = (n) => `https://cdn.example.com/cover-${n}.jpg`;
  beforeEach(() => safeFetch.mockReset());

  test('a token survives a round trip; a tampered url or signature does not', () => {
    const token = artToken(image('t'));
    expect(urlFromToken(token)).toBe(image('t'));
    const [sig, payload] = token.split('.');
    const other = Buffer.from(image('other')).toString('base64url');
    expect(urlFromToken(`${sig}.${other}`)).toBeNull();
    expect(urlFromToken(`${'A'.repeat(16)}.${payload}`)).toBeNull();
    expect(artToken(`https://cdn.example.com/${'x'.repeat(1500)}`)).toBe('');
  });

  test.each([...SIZES])('renders a %i px square', async (px) => {
    safeFetch.mockResolvedValue({ headers: { 'content-type': 'image/png' }, body: PNG });
    expect(jpegSize(await renderArt(image(`size-${px}`), px))).toEqual({ width: px, height: px });
    expect(safeFetch).toHaveBeenCalledWith(image(`size-${px}`), expect.objectContaining({ maxBytes: 10 * 1024 * 1024 }));
  });

  test('a size it does not offer is refused before any fetch', async () => {
    await expect(renderArt(image('odd'), 100)).rejects.toThrow('bad size');
    expect(safeFetch).not.toHaveBeenCalled();
  });

  test('a rendered cover is kept: the second ask fetches nothing', async () => {
    safeFetch.mockResolvedValue({ headers: { 'content-type': 'application/octet-stream' }, body: PNG });
    const first = await renderArt(image('cached'), 64);
    const second = await renderArt(image('cached'), 64);
    expect(second.equals(first)).toBe(true);
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });

  test('something that is not an image fails, and is not asked for again for a while', async () => {
    safeFetch.mockResolvedValue({ headers: { 'content-type': 'text/html' }, body: Buffer.from('<html>') });
    await expect(renderArt(image('html'), 64)).rejects.toThrow('not an image (text/html)');
    await expect(renderArt(image('html'), 128)).rejects.toThrow('failed recently');
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });

  test('at most two covers are fetched and rendered at once', async () => {
    const pending = [];
    safeFetch.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    const renders = [1, 2, 3].map((n) => renderArt(image(`slot-${n}`), 64));
    await new Promise((r) => setImmediate(r));
    expect(safeFetch).toHaveBeenCalledTimes(2);
    pending[0]({ headers: {}, body: PNG });
    await renders[0];
    await new Promise((r) => setImmediate(r));
    expect(safeFetch).toHaveBeenCalledTimes(3);
    pending[1]({ headers: {}, body: PNG });
    pending[2]({ headers: {}, body: PNG });
    await Promise.all(renders);
  });
});
