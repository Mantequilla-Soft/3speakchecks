/**
 * utils/videoFrame uploadImage: the frame goes to the image host's /upload as a
 * multipart `image` field with the bearer key, and only an https URL in a
 * success answer is accepted. A loopback stub stands in for the image host.
 */
const { uploadImage } = require('../../utils/videoFrame');
const { stubServer, json } = require('./_fixtures');

let stub;
beforeAll(async () => { stub = await stubServer(); });
afterAll(() => stub.close());
beforeEach(() => { stub.requests.length = 0; });

test('posts the frame with the bearer key and returns the hosted URL', async () => {
  stub.handle((_req, res) => json(res, 200, { success: true, url: 'https://images.3speak.tv/images/a.webp' }));

  const url = await uploadImage(Buffer.from('jpeg-bytes'), { url: `${stub.url}/`, key: 'k1' });

  expect(url).toBe('https://images.3speak.tv/images/a.webp');
  const [req] = stub.requests;
  expect(req.method).toBe('POST');
  expect(req.url).toBe('/upload');
  expect(req.headers.authorization).toBe('Bearer k1');
  expect(req.headers['content-type']).toMatch(/^multipart\/form-data/);
  expect(req.body).toMatch(/name="image"; filename="frame\.jpg"/);
  expect(req.body).toContain('jpeg-bytes');
});

test.each([
  ['an error status', (res) => json(res, 503, { error: 'busy' })],
  ['success:false', (res) => json(res, 200, { success: false, url: 'https://x/y.webp' })],
  ['no url', (res) => json(res, 200, { success: true })],
  ['a non-https url', (res) => json(res, 200, { success: true, url: 'javascript:alert(1)' })],
  ['a body that is not JSON', (res) => { res.writeHead(200); res.end('<html>'); }],
])('throws on %s', async (_label, handler) => {
  stub.handle((_req, res) => handler(res));
  await expect(uploadImage(Buffer.from('x'), { url: stub.url, key: 'k' })).rejects.toThrow(/image upload failed/);
});
