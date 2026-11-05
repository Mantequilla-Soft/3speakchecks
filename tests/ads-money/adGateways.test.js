/**
 * Which IPFS gateway serves an ad asset, and for whom (utils/adGateways.js).
 *
 * Rows store a CID; a url is chosen at the moment of use: a host that can pull cold
 * content, readable by the page asking when a page asks, healthy hosts first. A
 * gateway seen answering 403 (Bunny's suspension page) moves to the back for five
 * minutes and the background probe keeps that honest. Pure apart from the probe,
 * whose fetch is stubbed; the clock is pinned for the down-marks.
 */
const CID = 'QmTestCid';
const NOW = new Date('2026-11-01T12:00:00Z');

/** A fresh copy of the module (its down-marks live in module memory). */
function load(env = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  let mod;
  jest.isolateModules(() => { mod = require('../../utils/adGateways'); });
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return mod;
}

let G;
beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  G = load({ AD_CDN_GATEWAY: '', AD_GATEWAY_PROBE_CID: '' });
});
afterEach(() => jest.useRealTimers());

describe('choosing a host', () => {
  test('a server-side read gets the first gateway that can pull cold content', () => {
    expect(G.preferredHost()).toBe('ipfs-3speak.b-cdn.net');
  });

  test('the gateway that cannot deliver cold content is never chosen, even though its CORS is fine', () => {
    expect(G.COLD_CAPABLE_HOSTS).not.toContain('hotipfs-3speak-1.b-cdn.net');
    expect(G.CORS_HOSTS).toContain('hotipfs-3speak-1.b-cdn.net');
  });

  test('a page on 3speak.tv may be handed ipfs.3speak.tv when the Bunny zone is down; any other page may not', () => {
    G.markGatewayDown(`https://ipfs-3speak.b-cdn.net/ipfs/${CID}/manifest.m3u8`);
    expect(G.preferredHost({ browser: true, origin: 'https://3speak.tv' })).toBe('ipfs.3speak.tv');
    // A third-party page cannot read ipfs.3speak.tv, so the down zone is still its best.
    expect(G.preferredHost({ browser: true, origin: 'https://example.com' })).toBe('ipfs-3speak.b-cdn.net');
    expect(G.preferredHost({ browser: true })).toBe('ipfs-3speak.b-cdn.net');
  });

  test('a host marked down goes to the back, not away, and comes back after five minutes', () => {
    G.markGatewayDown('https://ipfs-3speak.b-cdn.net/x');
    expect(G.isGatewayDown('ipfs-3speak.b-cdn.net')).toBe(true);
    expect(G.preferredHost()).toBe('ipfs.3speak.tv');
    jest.setSystemTime(NOW.getTime() + 5 * 60 * 1000);
    expect(G.isGatewayDown('ipfs-3speak.b-cdn.net')).toBe(false);
    expect(G.preferredHost()).toBe('ipfs-3speak.b-cdn.net');
  });

  test('only our own gateways can be marked down, and a non-url is ignored', () => {
    G.markGatewayDown('https://images.example.com/banner.png');
    G.markGatewayDown('not a url');
    expect(G.isGatewayDown('images.example.com')).toBe(false);
  });

  test.each([
    ['a bare hostname', 'my-gateway.example'],
    ['a full url', 'https://my-gateway.example/ipfs/'],
  ])('AD_CDN_GATEWAY as %s goes to the front of the preference', (_label, value) => {
    expect(load({ AD_CDN_GATEWAY: value }).preferredHost({ browser: true })).toBe('my-gateway.example');
  });

  test('an AD_CDN_GATEWAY that is not a host is ignored', () => {
    expect(load({ AD_CDN_GATEWAY: 'https://' }).preferredHost()).toBe('ipfs-3speak.b-cdn.net');
  });
});

describe('urls from CIDs', () => {
  test('a manifest url is built on the host chosen now, never one stored on the row', () => {
    expect(G.manifestUrlFor(CID)).toBe(`https://ipfs-3speak.b-cdn.net/ipfs/${CID}/manifest.m3u8`);
    expect(G.manifestUrlFor(null)).toBeNull();
  });

  test.each([
    ['a creative with a CID', { manifestCid: CID }, `https://ipfs-3speak.b-cdn.net/ipfs/${CID}/manifest.m3u8`],
    ['a legacy creative that stored a url on a dead host', { manifestUrl: `https://hotipfs-3speak-1.b-cdn.net/ipfs/${CID}/manifest.m3u8` }, `https://ipfs-3speak.b-cdn.net/ipfs/${CID}/manifest.m3u8`],
    ['a creative still encoding', {}, null],
    ['no creative', null, null],
  ])('%s', (_label, creative, want) => {
    expect(G.creativeManifestUrl(creative)).toBe(want);
  });

  test.each([
    [`https://x/ipfs/${CID}/manifest.m3u8`, CID],
    [`https://x/ipfs/${CID}`, null],
    [undefined, null],
  ])('cidFromManifestUrl(%p) is %p', (url, want) => {
    expect(G.cidFromManifestUrl(url)).toBe(want);
  });

  test.each([
    [{ manifestCid: CID }, true], [{ manifestUrl: 'https://x/ipfs/y/manifest.m3u8' }, true], [{}, false], [null, false],
  ])('creativeIsEncoded(%p) is %p', (creative, want) => {
    expect(G.creativeIsEncoded(creative)).toBe(want);
  });
});

describe('what a browser can read', () => {
  test.each([
    ['https://ipfs-3speak.b-cdn.net/a', null, true, true],
    ['https://ipfs.3speak.tv/a', 'https://3speak.tv', true, false],
    ['https://ipfs.3speak.tv/a', 'https://play.3speak.tv', true, false],
    ['https://ipfs.3speak.tv/a', 'https://www.3speak.tv', false, false],
    ['https://ipfs.3speak.tv/a', null, false, false],
    ['https://images.example.com/a', null, false, false],
  ])('%s from %s: readable %p, safe to redirect to %p', (url, origin, readable, redirectable) => {
    expect(G.isBrowserSafe(url, origin)).toBe(readable);
    expect(G.isRedirectSafe(url)).toBe(redirectable);
  });

  test('a gateway url is moved onto a host the page can read; anything else is untouched', () => {
    expect(G.browserAssetUrl(`https://hotipfs-3speak-1.b-cdn.net/ipfs/${CID}/a.ts?x=1`))
      .toBe(`https://ipfs-3speak.b-cdn.net/ipfs/${CID}/a.ts?x=1`);
    expect(G.browserAssetUrl('https://images.example.com/banner.png')).toBe('https://images.example.com/banner.png');
    expect(G.browserAssetUrl('not a url')).toBe('not a url');
  });

  test('siblings are the same object on every other gateway, in fallback order', () => {
    expect(G.gatewaySiblings(`https://ipfs-3speak.b-cdn.net/ipfs/${CID}/a.ts`)).toEqual([
      `https://ipfs.3speak.tv/ipfs/${CID}/a.ts`,
      `https://hotipfs-3speak-1.b-cdn.net/ipfs/${CID}/a.ts`,
      `https://ipfs-audio.3speak.tv/ipfs/${CID}/a.ts`,
    ]);
    expect(G.gatewaySiblings('https://images.example.com/a')).toEqual([]);
    expect(G.gatewaySiblings('nope')).toEqual([]);
  });

  test('open-CORS siblings keep only what this page can read, healthy hosts first', () => {
    const url = `https://ipfs.3speak.tv/ipfs/${CID}/a.ts`;
    G.markGatewayDown(`https://ipfs-3speak.b-cdn.net/ipfs/${CID}/a.ts`);
    expect(G.openCorsSiblings(url, 'https://www.3speak.tv')).toEqual([
      `https://hotipfs-3speak-1.b-cdn.net/ipfs/${CID}/a.ts`,
      `https://ipfs-audio.3speak.tv/ipfs/${CID}/a.ts`,
      `https://ipfs-3speak.b-cdn.net/ipfs/${CID}/a.ts`,
    ]);
  });

  test('urlsHealthFirst moves urls on down hosts to the back and keeps the rest in order', () => {
    G.markGatewayDown('https://ipfs.3speak.tv/');
    expect(G.urlsHealthFirst(['https://ipfs.3speak.tv/1', 'bad', 'https://ipfs-3speak.b-cdn.net/2']))
      .toEqual(['bad', 'https://ipfs-3speak.b-cdn.net/2', 'https://ipfs.3speak.tv/1']);
  });

  test.each([
    ['the same origin', 'https://a.example/x', 'https://a.example/y', true],
    ['two of our gateways', 'https://ipfs.3speak.tv/x', 'https://ipfs-3speak.b-cdn.net/y', true],
    ['one of ours and a stranger', 'https://ipfs.3speak.tv/x', 'https://evil.example/y', false],
    ['a non-url', 'nope', 'https://ipfs.3speak.tv/y', false],
  ])('sameContentScope: %s', (_label, a, b, want) => {
    expect(G.sameContentScope(a, b)).toBe(want);
  });
});

describe('the gateway probe', () => {
  test('a 403 marks a zone down, any other answer clears it, and an unreachable zone keeps its last state', async () => {
    G.markGatewayDown('https://ipfs-audio.3speak.tv/');
    G.markGatewayDown('https://hotipfs-3speak-1.b-cdn.net/');
    const seen = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      seen.push(url);
      if (url.includes('ipfs-3speak.b-cdn.net')) return { status: 403 };
      if (url.includes('hotipfs')) return { status: 500 };
      throw new Error('unreachable');
    });
    G.startGatewayProbe();
    G.startGatewayProbe(); // a second start is a no-op
    await jest.advanceTimersByTimeAsync(0);
    expect(seen.sort()).toEqual(G.CORS_HOSTS.map((h) => `https://${h}/ipfs/QmRTYhAotD5onwzi3HEZD8bptmb7cccUiuaEZhjqJcz1Ra/manifest.m3u8`).sort());
    expect(G.isGatewayDown('ipfs-3speak.b-cdn.net')).toBe(true);
    expect(G.isGatewayDown('hotipfs-3speak-1.b-cdn.net')).toBe(false);
    expect(G.isGatewayDown('ipfs-audio.3speak.tv')).toBe(true);

    // Every two minutes after that, without anyone asking.
    await jest.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(seen).toHaveLength(6);
  });

  test('the probe asks for the CID configured in AD_GATEWAY_PROBE_CID', async () => {
    const mod = load({ AD_GATEWAY_PROBE_CID: 'QmOther' });
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue({ status: 200 });
    mod.startGatewayProbe();
    await jest.advanceTimersByTimeAsync(0);
    expect(fetch.mock.calls.every(([url]) => url.includes('/ipfs/QmOther/'))).toBe(true);
  });
});
