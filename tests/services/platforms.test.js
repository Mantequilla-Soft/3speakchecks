/**
 * services/platforms/*: reading a public profile for the bio-hash verification.
 *
 * Each adapter turns whatever the user pasted into a canonical id and returns the
 * profile text the hash is searched in. Failures are split in two on purpose:
 * CHANNEL_NOT_FOUND (the user typed a wrong name, a 404 for the route) and a
 * generic 'Platform lookup failed' (our problem, a 502) that never leaks API keys,
 * quotas or proxy credentials. Every platform's HTTP is stubbed: global fetch for
 * the API ones, https.get for Rumble.
 */
jest.mock('../../utils/config', () => ({
  ...jest.requireActual('../../utils/config'),
  YOUTUBE_API_KEY: 'test-youtube-key',
}));

const https = require('https');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { fakeFetch } = require('./_fixtures');

const youtube = require('../../services/platforms/youtube');
const tiktok = require('../../services/platforms/tiktok');
const instagram = require('../../services/platforms/instagram');
const bitchute = require('../../services/platforms/bitchute');
const rumble = require('../../services/platforms/rumble');
const { getPlatform, listPlatforms, isLinkEnabled } = require('../../services/platforms');

const realFetch = global.fetch;
let errors;
let warns;
beforeEach(() => {
  errors = jest.spyOn(console, 'error').mockImplementation(() => {});
  warns = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { global.fetch = realFetch; });

const failure = async (p) => p.then(() => 'resolved', (e) => (e.code ? e.code : e.message));
const logged = () => [...errors.mock.calls, ...warns.mock.calls].flat().join('\n');

describe('the platform registry and the link switches', () => {
  const KEYS = ['VERIFY_YOUTUBE', 'VERIFY_SOUNDCLOUD', 'VERIFY_TIKTOK', 'VERIFY_INSTAGRAM', 'VERIFY_BITCHUTE', 'VERIFY_RUMBLE'];
  beforeEach(() => KEYS.forEach((k) => delete process.env[k]));
  afterEach(() => KEYS.forEach((k) => delete process.env[k]));

  test('names are matched case- and space-insensitively; unknown is null', () => {
    expect(getPlatform(' YouTube ').name).toBe('youtube');
    expect(getPlatform('myspace')).toBeNull();
    expect(getPlatform(undefined)).toBeNull();
  });

  test('by default only YouTube and SoundCloud can be linked', () => {
    expect(listPlatforms()).toEqual(['youtube', 'soundcloud']);
  });

  test('VERIFY_<NAME> switches a platform on or off, read at call time', () => {
    process.env.VERIFY_TIKTOK = 'true';
    process.env.VERIFY_SOUNDCLOUD = 'false';
    expect(listPlatforms()).toEqual(['youtube', 'tiktok']);
    expect(isLinkEnabled('TikTok')).toBe(true);
    process.env.VERIFY_TIKTOK = 'yes'; // anything but true/false = the default
    expect(isLinkEnabled('tiktok')).toBe(false);
    expect(isLinkEnabled('myspace')).toBe(false);
  });
});

describe('YouTube', () => {
  const ID = 'UC1234567890123456789012';
  const api = (handler) => { global.fetch = fakeFetch([['https://www.googleapis.com/youtube/v3/channels', handler]]); };

  test('a @handle is looked up by handle and keyed by the immutable channel id', async () => {
    api(() => ({ body: { items: [{ id: ID, snippet: { title: 'Alice', description: 'hash: abc' } }] } }));
    await expect(youtube.fetchProfile('@alice')).resolves.toEqual({ canonical_username: ID, text: 'Alice\nhash: abc' });
    const url = new URL(global.fetch.calls[0].url);
    expect(url.searchParams.get('forHandle')).toBe('alice');
    expect(url.searchParams.get('id')).toBeNull();
    expect(url.searchParams.get('key')).toBe('test-youtube-key');
  });

  test('a channel id is looked up by id', async () => {
    api(() => ({ body: { items: [{ id: ID, snippet: {} }] } }));
    await expect(youtube.fetchProfile(` ${ID} `)).resolves.toEqual({ canonical_username: ID, text: '' });
    expect(new URL(global.fetch.calls[0].url).searchParams.get('id')).toBe(ID);
  });

  test('no items is CHANNEL_NOT_FOUND', async () => {
    api(() => ({ body: { items: [] } }));
    await expect(failure(youtube.fetchProfile('@ghost'))).resolves.toBe('CHANNEL_NOT_FOUND');
    api(() => ({ body: {} }));
    await expect(failure(youtube.fetchProfile('@ghost'))).resolves.toBe('CHANNEL_NOT_FOUND');
  });

  test('an API error (quota, bad key) is a generic failure; the details stay in the log', async () => {
    api(() => ({ status: 403, body: { error: { message: 'quotaExceeded' } } }));
    const err = await youtube.fetchProfile('@alice').catch((e) => e);
    expect(err.message).toBe('Platform lookup failed');
    expect(err.message).not.toMatch(/quota|key/i);
    expect(logged()).toMatch(/403/);
  });

  test('an empty name is refused before any request', async () => {
    api(() => ({ body: {} }));
    await expect(failure(youtube.fetchProfile('  '))).resolves.toBe('platform_username is required');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('without an API key nothing is sent', async () => {
    let fresh;
    jest.isolateModules(() => {
      // The isolated copy of the (mocked) config, with the key blanked before the
      // adapter reads it.
      require('../../utils/config').YOUTUBE_API_KEY = '';
      fresh = require('../../services/platforms/youtube');
    });
    api(() => ({ body: {} }));
    await expect(failure(fresh.fetchProfile('@alice'))).resolves.toBe('YOUTUBE_API_KEY is not configured');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('SoundCloud', () => {
  const CLIENT_A = 'a'.repeat(32);
  const CLIENT_B = 'b'.repeat(32);
  let sc;
  let currentClient;
  let resolveAnswer;

  beforeEach(() => {
    jest.isolateModules(() => { sc = require('../../services/platforms/soundcloud'); }); // empty client_id cache
    currentClient = CLIENT_A;
    resolveAnswer = () => ({ body: { kind: 'user', permalink: 'DJ-Alice', username: 'DJ Alice', full_name: 'Alice A', city: 'Berlin', description: 'abc' } });
    global.fetch = fakeFetch([
      ['https://soundcloud.com', () => ({ body: '<script crossorigin src="https://a-v2.sndcdn.com/assets/0-x.js"></script><script crossorigin src="https://a-v2.sndcdn.com/assets/50-y.js"></script>' })],
      ['https://a-v2.sndcdn.com/assets/0-x.js', () => ({ body: 'nothing here' })],
      ['https://a-v2.sndcdn.com/assets/50-y.js', () => ({ body: `({client_id:"${currentClient}",x:1})` })],
      ['https://api-v2.soundcloud.com/resolve', (url) => {
        if (new URL(url).searchParams.get('client_id') !== currentClient) return { status: 401, body: {} };
        return resolveAnswer(url);
      }],
    ]);
  });

  test.each([
    ['dj-alice'], ['@DJ-Alice'], ['soundcloud.com/dj-alice'], ['https://soundcloud.com/dj-alice/tracks?x=1#top'],
  ])('%p resolves to the permalink slug', async (input) => {
    await expect(sc.fetchProfile(input)).resolves.toEqual({ canonical_username: 'dj-alice', text: 'DJ Alice\nAlice A\nBerlin\nabc' });
    const resolve = global.fetch.calls.find((c) => c.url.startsWith('https://api-v2.soundcloud.com/resolve'));
    expect(new URL(resolve.url).searchParams.get('url')).toBe('https://soundcloud.com/dj-alice');
  });

  test('the client_id is lifted once and then reused', async () => {
    await sc.fetchProfile('dj-alice');
    await sc.fetchProfile('dj-alice');
    expect(global.fetch.calls.filter((c) => c.url === 'https://soundcloud.com')).toHaveLength(1);
  });

  test('a rotated client_id (401/403) is re-derived once and the lookup retried', async () => {
    await sc.fetchProfile('dj-alice');
    currentClient = CLIENT_B;
    await expect(sc.fetchProfile('dj-alice')).resolves.toMatchObject({ canonical_username: 'dj-alice' });
    expect(global.fetch.calls.filter((c) => c.url === 'https://soundcloud.com')).toHaveLength(2);
  });

  test.each([
    ['a 404', () => ({ status: 404, body: {} })],
    ['a track, not a user', () => ({ body: { kind: 'track', permalink: 'x' } })],
    ['a user without a permalink', () => ({ body: { kind: 'user' } })],
  ])('%s is CHANNEL_NOT_FOUND', async (_l, answer) => {
    resolveAnswer = answer;
    await expect(failure(sc.fetchProfile('dj-alice'))).resolves.toBe('CHANNEL_NOT_FOUND');
  });

  test.each([
    ['a 500 from the API', () => ({ status: 500, body: 'oops' })],
    ['a body that is not JSON', () => ({ body: '<html>' })],
  ])('%s is a generic failure', async (_l, answer) => {
    resolveAnswer = answer;
    await expect(failure(sc.fetchProfile('dj-alice'))).resolves.toBe('Platform lookup failed');
  });

  test('no client_id in any bundle, or the site down, is a generic failure', async () => {
    currentClient = 'short'; // does not match the 20+ character pattern
    await expect(failure(sc.fetchProfile('dj-alice'))).resolves.toBe('Platform lookup failed');
    jest.isolateModules(() => { sc = require('../../services/platforms/soundcloud'); });
    global.fetch = fakeFetch([['https://soundcloud.com', () => ({ status: 503, body: '' })]]);
    await expect(failure(sc.fetchProfile('dj-alice'))).resolves.toBe('Platform lookup failed');
  });

  test('an empty name is refused', async () => {
    await expect(failure(sc.fetchProfile(' @ '))).resolves.toBe('platform_username is required');
  });
});

describe('TikTok', () => {
  const page = (user) => `<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({ __DEFAULT_SCOPE__: { 'webapp.user-detail': { userInfo: { user } } } })}</script></html>`;
  const site = (handler) => { global.fetch = fakeFetch([['https://www.tiktok.com/@', handler]]); };

  test.each([
    ['Alice.Dances', 'alice.dances'],
    ['@alice_dances', 'alice_dances'],
    ['https://www.tiktok.com/@Alice/video/123?lang=en', 'alice'],
    ['tiktok.com/@alice', 'alice'],
    ['a', ''],                 // too short
    ['has space', 'has'],
    ['bad!chars', ''],
    ['x'.repeat(25), ''],      // too long
    ['', ''],
  ])('extractHandle(%p) = %p', (raw, out) => expect(tiktok.extractHandle(raw)).toBe(out));

  test('reads handle, nickname and bio from the rehydration blob', async () => {
    site(() => ({ body: page({ uniqueId: 'Alice', nickname: 'Ali', signature: 'my hash abc' }) }));
    await expect(tiktok.fetchProfile('@alice')).resolves.toEqual({ canonical_username: 'alice', text: 'Alice\nAli\nmy hash abc' });
    expect(global.fetch.calls[0].url).toBe('https://www.tiktok.com/@alice');
  });

  test('an invalid handle is CHANNEL_NOT_FOUND without a request', async () => {
    site(() => ({ body: '' }));
    await expect(failure(tiktok.fetchProfile('bad!'))).resolves.toBe('CHANNEL_NOT_FOUND');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('a page without a user in the blob is CHANNEL_NOT_FOUND', async () => {
    site(() => ({ body: page(null) }));
    await expect(failure(tiktok.fetchProfile('ghost'))).resolves.toBe('CHANNEL_NOT_FOUND');
  });

  test.each([
    ['an HTTP error', () => ({ status: 403, body: '' })],
    ['a captcha page without the blob', () => ({ body: '<html>verify you are human</html>' })],
    ['a broken blob', () => ({ body: '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">{nope</script>' })],
    ['a network error', () => { throw new Error('ECONNRESET'); }],
  ])('%s is a generic failure', async (_l, handler) => {
    site(handler);
    await expect(failure(tiktok.fetchProfile('alice'))).resolves.toBe('Platform lookup failed');
  });
});

describe('Instagram (through the local browser service)', () => {
  const svc = (handler) => { global.fetch = fakeFetch([['http://127.0.0.1:4031/profile/', handler]]); };

  test.each([
    ['Alice.Photos', 'alice.photos'],
    ['@alice_p', 'alice_p'],
    ['https://www.instagram.com/alice/?hl=en', 'alice'],
    ['instagram.com/p/Cxyz', ''],      // a post, not a profile
    ['https://instagram.com/reel/abc', ''],
    ['explore', ''],
    ['bad name!', 'bad'],
    ['x'.repeat(31), ''],
  ])('extractUsername(%p) = %p', (raw, out) => expect(instagram.extractUsername(raw)).toBe(out));

  test('name, full name, bio and the header text are searched', async () => {
    svc(() => ({ body: { username: 'Alice', fullName: 'Alice A', biography: 'bio', headerText: 'header abc' } }));
    await expect(instagram.fetchProfile('@alice')).resolves.toEqual({ canonical_username: 'alice', text: 'Alice\nAlice A\nbio\nheader abc' });
    expect(global.fetch.calls[0].url).toBe('http://127.0.0.1:4031/profile/alice');
  });

  test('a 404 from the service is CHANNEL_NOT_FOUND; a bad name never reaches it', async () => {
    svc(() => ({ status: 404, body: { code: 'not_found' } }));
    await expect(failure(instagram.fetchProfile('ghost'))).resolves.toBe('CHANNEL_NOT_FOUND');
    await expect(failure(instagram.fetchProfile('p'))).resolves.toBe('CHANNEL_NOT_FOUND');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['the service is down', () => { throw new Error('ECONNREFUSED'); }],
    ['the service answers 429', () => ({ status: 429, body: { code: 'rate_limited', error: 'slow down' } })],
    ['a 200 without a username', () => ({ body: {} })],
    ['a body that is not JSON', () => ({ body: 'oops' })],
  ])('%s is a generic failure', async (_l, handler) => {
    svc(handler);
    await expect(failure(instagram.fetchProfile('alice'))).resolves.toBe('Platform lookup failed');
  });
});

describe('BitChute', () => {
  const api = (handler) => { global.fetch = fakeFetch([['https://api.bitchute.com/api/beta/channel', handler]]); };

  test.each([
    ['1VBwRfyNcKdX', '1VBwRfyNcKdX'],                         // case kept: ids are case-sensitive
    ['https://www.bitchute.com/channel/my-slug/', 'my-slug'],
    ['@my_slug', 'my_slug'],
    ['x', ''],
    ['bad!', ''],
  ])('extractChannel(%p) = %p', (raw, out) => expect(bitchute.extractChannel(raw)).toBe(out));

  test('POSTs the channel id and is keyed by the immutable channel_id', async () => {
    api(() => ({ body: { channel_id: 'AbC123', channel_name: 'Alice', url_slug: 'alice', profile_name: 'A', description: 'abc' } }));
    await expect(bitchute.fetchProfile('alice')).resolves.toEqual({ canonical_username: 'AbC123', text: 'Alice\nalice\nA\nabc' });
    const { init } = global.fetch.calls[0];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ channel_id: 'alice' });
  });

  test.each([
    ['a 404', () => ({ status: 404, body: {} })],
    ['a 200 without a channel_id', () => ({ body: { error: 'nope' } })],
  ])('%s is CHANNEL_NOT_FOUND', async (_l, handler) => {
    api(handler);
    await expect(failure(bitchute.fetchProfile('alice'))).resolves.toBe('CHANNEL_NOT_FOUND');
  });

  test('an invalid channel is CHANNEL_NOT_FOUND without a request', async () => {
    api(() => ({ body: {} }));
    await expect(failure(bitchute.fetchProfile('!'))).resolves.toBe('CHANNEL_NOT_FOUND');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test.each([
    ['a 500', () => ({ status: 500, body: 'x' })],
    ['a network error', () => { throw new Error('ETIMEDOUT'); }],
  ])('%s is a generic failure', async (_l, handler) => {
    api(handler);
    await expect(failure(bitchute.fetchProfile('alice'))).resolves.toBe('Platform lookup failed');
  });
});

describe('Rumble (About page, optionally through a residential proxy)', () => {
  // https.get, answered by `pages` in order: { status, body } or an Error to throw,
  // or 'timeout' to make the request time out.
  let pages;
  let gets;
  beforeEach(() => {
    pages = [];
    gets = [];
    delete process.env.RUMBLE_FETCH_PROXY;
    jest.spyOn(https, 'get').mockImplementation((url, opts, cb) => {
      gets.push({ url: String(url), opts });
      const req = new EventEmitter();
      req.destroy = (err) => { if (err) process.nextTick(() => req.emit('error', err)); };
      const next = pages.shift() || { status: 500, body: '' };
      process.nextTick(() => {
        if (next instanceof Error) return req.emit('error', next);
        if (next === 'timeout') return req.emit('timeout');
        const res = new PassThrough();
        res.statusCode = next.status;
        cb(res);
        res.end(next.body);
        return undefined;
      });
      return req;
    });
  });
  afterEach(() => { delete process.env.RUMBLE_FETCH_PROXY; });

  const about = (desc) => `<html><head><title>Alice &amp; Co - Rumble</title></head><body><div class="channel-about--description" data-x="1"><p>Line one<br/>hash &#39;abc&#39; &lt;3 &quot;q&quot; &gt;</p></div></body></html>`.replace('Line one', desc);

  test.each([
    ['Alice', 'c/alice'],
    ['@Alice', 'c/alice'],
    ['c/Alice', 'c/alice'],
    ['USER/Alice', 'user/alice'],
    ['https://rumble.com/c/AliceTV/about?e=1', 'c/alicetv'],
    ['rumble.com/user/bob', 'user/bob'],
    ['', ''],
    ['bad!name', ''],
  ])('extractChannel(%p) = %p', (raw, out) => expect(rumble.extractChannel(raw)).toBe(out));

  test('reads the title and the About description, HTML decoded', async () => {
    pages = [{ status: 200, body: about('Line one') }];
    await expect(rumble.fetchProfile('Alice')).resolves.toEqual({
      canonical_username: 'c/alice',
      text: 'Alice & Co - Rumble\nLine one\nhash \'abc\' <3 "q" >',
    });
    expect(gets[0].url).toBe('https://rumble.com/c/alice/about');
    expect(gets[0].opts.agent).toBeUndefined(); // no proxy configured: direct, one attempt
  });

  test('a page without the description block still yields the title', async () => {
    pages = [{ status: 200, body: '<title>Bob</title>' }];
    await expect(rumble.fetchProfile('bob')).resolves.toEqual({ canonical_username: 'c/bob', text: 'Bob' });
  });

  test('a 404 is CHANNEL_NOT_FOUND; an invalid name sends nothing', async () => {
    pages = [{ status: 404, body: '' }];
    await expect(failure(rumble.fetchProfile('ghost'))).resolves.toBe('CHANNEL_NOT_FOUND');
    await expect(failure(rumble.fetchProfile('!'))).resolves.toBe('CHANNEL_NOT_FOUND');
    expect(gets).toHaveLength(1);
  });

  test('without a proxy a Cloudflare challenge is not retried', async () => {
    pages = [{ status: 403, body: 'Just a moment...' }, { status: 200, body: about('x') }];
    await expect(failure(rumble.fetchProfile('alice'))).resolves.toBe('Platform lookup failed');
    expect(gets).toHaveLength(1);
  });

  test('through the proxy a challenged exit IP is swapped for another, up to six attempts', async () => {
    process.env.RUMBLE_FETCH_PROXY = 'http://user:s3cret@proxy.example:{port:10000-10009}';
    pages = [{ status: 403, body: '' }, new Error('socket hang up'), 'timeout', { status: 200, body: about('ok') }];
    await expect(rumble.fetchProfile('alice')).resolves.toMatchObject({ canonical_username: 'c/alice' });
    expect(gets).toHaveLength(4);
    for (const g of gets) {
      const port = Number(g.opts.agent.proxy.port);
      expect(port).toBeGreaterThanOrEqual(10000);
      expect(port).toBeLessThanOrEqual(10009);
    }
  });

  test('gives up after six attempts', async () => {
    process.env.RUMBLE_FETCH_PROXY = 'http://proxy.example:8000/{session}';
    pages = Array.from({ length: 10 }, () => ({ status: 403, body: '' }));
    await expect(failure(rumble.fetchProfile('alice'))).resolves.toBe('Platform lookup failed');
    expect(gets).toHaveLength(6);
  });

  test('proxy credentials never reach the log', async () => {
    process.env.RUMBLE_FETCH_PROXY = 'http://user:s3cret@proxy.example:8000';
    pages = Array.from({ length: 6 }, () => new Error('connect ECONNREFUSED http://user:s3cret@proxy.example:8000'));
    await failure(rumble.fetchProfile('alice'));
    expect(logged()).toMatch(/ECONNREFUSED/);
    expect(logged()).not.toMatch(/s3cret/);
    expect(logged()).toMatch(/\/\/\*\*\*@proxy\.example/);
  });
});
