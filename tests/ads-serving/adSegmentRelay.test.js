/**
 * services/adSegmentRelay.js: when a gateway cannot be redirected to (it answers a
 * browser's `Origin: null` without CORS), an ad segment is fetched once, kept on disk
 * and served from our own origin. Sibling gateways are tried in turn; nothing too big
 * or empty is ever stored. The CDN is a stand-in for global fetch.
 */
const fs = require('fs');
const path = require('path');
const fx = require('./_fixtures');

const env = fx.useAdEnv();
const { relayedSegment } = require('../../services/adSegmentRelay');
const { isGatewayDown } = require('../../utils/adGateways');

beforeEach(() => {
  for (const f of fs.readdirSync(env.AD_BURN_CACHE_DIR)) fs.rmSync(path.join(env.AD_BURN_CACHE_DIR, f), { force: true });
});

const segOn = (host, n) => `https://${host}/ipfs/QmSpot${n}/720p/0.ts`;

describe('relayedSegment', () => {
  test('fetches a segment once and serves later requests from the cache', async () => {
    const url = segOn('ipfs.3speak.tv', 1);
    const seen = fx.fakeCdn({ [url]: Buffer.from('MPEG-TS bytes') });
    const file = await relayedSegment(url);
    expect(fs.readFileSync(file, 'utf8')).toBe('MPEG-TS bytes');
    expect(path.dirname(file)).toBe(env.AD_BURN_CACHE_DIR);
    expect(await relayedSegment(url)).toBe(file);
    expect(seen).toEqual([url]);
  });

  test('falls back to a sibling gateway with the same path when the first one fails', async () => {
    const url = segOn('ipfs.3speak.tv', 2);
    const sibling = segOn('ipfs-3speak.b-cdn.net', 2);
    const seen = fx.fakeCdn({ [url]: { status: 500 }, [sibling]: Buffer.from('from the sibling') });
    const file = await relayedSegment(url);
    expect(fs.readFileSync(file, 'utf8')).toBe('from the sibling');
    expect(seen.slice(0, 2)).toEqual([url, sibling]);
  });

  test('a 403 (a suspended Bunny zone) marks that gateway down for a while', async () => {
    const url = segOn('hotipfs-3speak-1.b-cdn.net', 3);
    fx.fakeCdn({ [url]: { status: 403 }, [segOn('ipfs-3speak.b-cdn.net', 3)]: Buffer.from('ok') });
    await relayedSegment(url);
    expect(isGatewayDown('hotipfs-3speak-1.b-cdn.net')).toBe(true);
  });

  test.each([
    ['every gateway fails', 'f1', () => ({ status: 502 })],
    ['every gateway answers with nothing', 'f2', () => ({ status: 200, body: '' })],
    ['every gateway answers with something far too big to be a segment', 'f3', () => Buffer.alloc(31 * 1024 * 1024)],
  ])('returns null when %s, and leaves no temp file', async (_label, tag, answer) => {
    const url = segOn('ipfs.3speak.tv', tag);
    fx.fakeCdn(Object.fromEntries(['ipfs.3speak.tv', 'ipfs-3speak.b-cdn.net', 'hotipfs-3speak-1.b-cdn.net', 'ipfs-audio.3speak.tv']
      .map((h) => [segOn(h, tag), answer])));
    await expect(relayedSegment(url)).resolves.toBeNull();
    expect(fs.readdirSync(env.AD_BURN_CACHE_DIR)).toEqual([]);
  });

  test('a url off our gateways is fetched as given, with no siblings to try', async () => {
    const url = 'https://cdn.partner.example/spot/0.ts';
    const seen = fx.fakeCdn({});
    await expect(relayedSegment(url)).resolves.toBeNull();
    expect(seen).toEqual([url]);
  });

  test('two requests for the same segment at once share one fetch', async () => {
    const url = segOn('ipfs.3speak.tv', 4);
    const seen = fx.fakeCdn({ [url]: Buffer.from('once') });
    const [a, b] = await Promise.all([relayedSegment(url), relayedSegment(url)]);
    expect(a).toBe(b);
    expect(seen).toHaveLength(1);
  });
});
