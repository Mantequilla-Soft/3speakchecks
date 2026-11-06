/**
 * utils/safeFetch.js: fetching a URL a user typed in, from inside our network.
 *
 * The SSRF guard has three layers, and each is tested on its own:
 *   1. checkUrl / isBlockedAddress: scheme, port, credentials, local names and
 *      literal private addresses are refused before any socket exists.
 *   2. the `lookup` hook: the address DNS answers is judged at connect time, so a
 *      name that resolves to a private address (or to a mix) is refused.
 *   3. every redirect hop goes through 1 and 2 again.
 *
 * The suite cannot let safeFetch connect to a real outside host (the test network
 * guard refuses it), and safeFetch itself refuses loopback. So http.request and
 * https.request are wrapped: the wrapper runs the code's OWN lookup hook against a
 * fake DNS table first, exactly as the socket would, and only then sends the
 * request to a local stub server, with the original Host header. What the code
 * decides is real; only where the bytes finally go is redirected.
 */
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const os = require('os');
const zlib = require('zlib');
const { EventEmitter } = require('events');

const {
  safeFetch, safeStream, splitCredentials, checkUrl, isBlockedAddress, FetchError, USER_AGENT,
} = require('../../utils/safeFetch');
const { stubServer } = require('./_fixtures');

// ── fake DNS ──────────────────────────────────────────────────────────────────
// name -> list of addresses. Answers synchronously, like a warm resolver cache.
const PUBLIC_A = '93.184.216.34';
const PUBLIC_B = '151.101.1.69';
const DNS = {
  'feeds.example': [PUBLIC_A],
  'cdn.example': [PUBLIC_B],
  'other.example': ['2606:2800:220:1:248:1893:25c8:1946'],
  'rebind.example': ['127.0.0.1'],
  'metadata.example': ['169.254.169.254'],
  'lan.example': ['192.168.1.10'],
  'mixed.example': [PUBLIC_A, '10.0.0.7'],
  'v6local.example': ['fd00::1'],
  'mapped.example': ['::ffff:127.0.0.1'],
};

function fakeDns() {
  return jest.spyOn(dns, 'lookup').mockImplementation((host, opts, cb) => {
    const list = DNS[host];
    if (!list) return cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' }));
    return cb(null, list.map((address) => ({ address, family: net.isIPv6(address) ? 6 : 4 })));
  });
}

// ── request router ────────────────────────────────────────────────────────────
// Every http(s).request safeFetch makes is recorded in `hops` and, once the code's
// own lookup hook has let it through, delivered to the stub server.
let stub;
let hops;
const realHttpRequest = http.request;

function failedRequest(err) {
  const req = new EventEmitter();
  req.end = () => process.nextTick(() => req.emit('error', err));
  req.destroy = () => {};
  req.setTimeout = () => req;
  return req;
}

function routeToStub() {
  const route = (u, opts) => {
    hops.push({ url: u.toString(), opts });
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!net.isIP(host)) {
      // What net.Socket does before it connects: ask the lookup hook it was given.
      let lookupErr = null;
      opts.lookup(host, { all: true }, (err) => { lookupErr = err; });
      if (lookupErr) return failedRequest(lookupErr);
    }
    return realHttpRequest.call(http, {
      host: '127.0.0.1',
      port: stub.port,
      path: `${u.pathname}${u.search}`,
      method: opts.method,
      headers: { ...opts.headers, host: u.host },
      timeout: opts.timeout,
    });
  };
  jest.spyOn(http, 'request').mockImplementation(route);
  jest.spyOn(https, 'request').mockImplementation(route);
}

beforeAll(async () => { stub = await stubServer(); });
afterAll(() => stub.close());
beforeEach(() => {
  hops = [];
  stub.requests.length = 0;
  fakeDns();
  routeToStub();
});

// A handler keyed by path, for the stub server.
const routes = (table) => (req, res) => {
  const handler = table[req.url.split('?')[0]];
  if (!handler) { res.statusCode = 404; return res.end('no route'); }
  return handler(req, res);
};
const redirect = (status, location) => (_req, res) => { res.writeHead(status, { Location: location }); res.end(); };
const ok = (body, headers = {}) => (_req, res) => { res.writeHead(200, headers); res.end(body); };

const codeOf = (p) => p.then(() => 'resolved', (e) => e.code);

describe('isBlockedAddress: the addresses no fetch may reach', () => {
  test.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.0.9', 'the whole 127/8'],
    ['10.1.2.3', 'RFC 1918 10/8'],
    ['172.16.0.1', 'RFC 1918 172.16/12'],
    ['172.31.255.255', 'top of 172.16/12'],
    ['192.168.0.1', 'RFC 1918 192.168/16'],
    ['169.254.169.254', 'cloud metadata (link-local)'],
    ['100.64.0.1', 'CGNAT'],
    ['0.0.0.0', 'this network'],
    ['224.0.0.1', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['198.18.0.1', 'benchmarking'],
    ['192.0.2.1', 'documentation'],
    ['::1', 'IPv6 loopback'],
    ['::', 'IPv6 unspecified'],
    ['fd00::1', 'IPv6 unique local'],
    ['fe80::1', 'IPv6 link-local'],
    ['ff02::1', 'IPv6 multicast'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:7f00:1', 'IPv4-mapped loopback, hex form'],
    ['::FFFF:10.0.0.1', 'IPv4-mapped private, upper case'],
    ['64:ff9b::10.0.0.1', 'NAT64 of a private address'],
    ['64:ff9b:1::1', 'local-use NAT64'],
    ['2002:7f00:1::', '6to4 (wraps an IPv4 address)'],
    ['not-an-ip', 'anything that is not an address'],
    ['', 'empty'],
  ])('%s is refused (%s)', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  test.each([
    ['93.184.216.34'],
    ['8.8.8.8'],
    ['172.32.0.1'], // just outside 172.16/12
    ['100.128.0.1'], // just outside CGNAT
    ['2606:2800:220:1:248:1893:25c8:1946'],
    ['::ffff:93.184.216.34'], // mapped, but to a public address
    ['64:ff9b::8.8.8.8'],
  ])('%s is a public address and allowed', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });

  test('every address of this host is refused, its public one included', () => {
    const own = Object.values(os.networkInterfaces()).flat().filter(Boolean).map((i) => i.address.split('%')[0]);
    expect(own.length).toBeGreaterThan(0);
    for (const ip of own) expect(isBlockedAddress(ip)).toBe(true);
  });

  test('SAFE_FETCH_BLOCK_IPS adds extra addresses, and ignores junk entries', () => {
    const prev = process.env.SAFE_FETCH_BLOCK_IPS;
    process.env.SAFE_FETCH_BLOCK_IPS = ' 93.184.216.34 , 2606:2800:220:1::5, not-an-ip,';
    try {
      jest.isolateModules(() => {
        const fresh = require('../../utils/safeFetch');
        expect(fresh.isBlockedAddress('93.184.216.34')).toBe(true);
        expect(fresh.isBlockedAddress('2606:2800:220:1::5')).toBe(true);
        expect(fresh.isBlockedAddress('8.8.8.8')).toBe(false);
      });
    } finally {
      if (prev === undefined) delete process.env.SAFE_FETCH_BLOCK_IPS; else process.env.SAFE_FETCH_BLOCK_IPS = prev;
    }
  });
});

describe('checkUrl: what is refused before any connection is made', () => {
  test.each([
    ['not a url', 'bad_url'],
    ['ftp://feeds.example/rss', 'bad_url'],
    ['file:///etc/passwd', 'bad_url'],
    ['gopher://feeds.example/', 'bad_url'],
    ['https://user:pw@feeds.example/rss', 'bad_url'],
    ['https://feeds.example:22/rss', 'bad_url'],
    ['http://feeds.example:3131/', 'bad_url'],
    ['http://feeds.example:27017/', 'bad_url'],
    ['http://localhost/', 'blocked_address'],
    ['http://api.localhost/', 'blocked_address'],
    ['http://metadata.google.internal/', 'blocked_address'],
    ['http://printer.local/', 'blocked_address'],
    ['http://127.0.0.1/', 'blocked_address'],
    ['http://127.1/', 'blocked_address'], // shorthand, the URL parser expands it
    ['http://2130706433/', 'blocked_address'], // decimal 127.0.0.1
    ['http://0x7f.0.0.1/', 'blocked_address'], // hex
    ['http://169.254.169.254/latest/meta-data/', 'blocked_address'],
    ['http://[::1]/', 'blocked_address'],
    ['http://[::ffff:127.0.0.1]/', 'blocked_address'],
    ['http://[fd00::1]:8080/', 'blocked_address'],
  ])('%s -> %s', (url, code) => {
    let err;
    try { checkUrl(url); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(FetchError);
    expect(err.code).toBe(code);
  });

  test.each([
    ['https://feeds.example/rss', ''],
    ['http://feeds.example:80/rss', ''],
    ['http://feeds.example:8080/rss', '8080'],
    ['https://feeds.example:8443/rss', '8443'],
    ['  https://feeds.example/rss  ', ''],
    ['http://93.184.216.34/rss', ''],
  ])('%s is accepted', (url, port) => {
    const u = checkUrl(url);
    expect(u).toBeInstanceOf(URL);
    expect(u.port).toBe(port);
  });
});

describe('the lookup hook judges the address DNS actually answers', () => {
  test.each([
    ['rebind.example', 'a public-looking name that resolves to loopback'],
    ['metadata.example', 'a name that resolves to the metadata service'],
    ['lan.example', 'a name that resolves into the LAN'],
    ['v6local.example', 'a name with an IPv6 unique-local answer'],
    ['mapped.example', 'a name whose AAAA is an IPv4-mapped loopback'],
    ['mixed.example', 'a name with one public and one private answer'],
  ])('%s is refused (%s), and nothing reaches a server', async (host) => {
    await expect(codeOf(safeFetch(`https://${host}/feed.xml`))).resolves.toBe('blocked_address');
    expect(stub.requests).toHaveLength(0);
  });

  test('an unknown name is a network error, not a crash', async () => {
    await expect(codeOf(safeFetch('https://nowhere.example/feed.xml'))).resolves.toBe('network');
  });

  test('the hook hands back every vetted address when asked for all of them', async () => {
    stub.handle(ok('x'));
    await safeFetch('https://feeds.example/');
    const { lookup } = hops[0].opts;
    const all = await new Promise((r) => lookup('other.example', { all: true }, (e, a) => r(a)));
    expect(all).toEqual([{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }]);
    const one = await new Promise((r) => lookup('feeds.example', {}, (e, a, f) => r([a, f])));
    expect(one).toEqual([PUBLIC_A, 4]);
  });

  test('every hop is made with the guarded lookup, never the default resolver', async () => {
    stub.handle(routes({ '/a': redirect(302, 'https://cdn.example/b'), '/b': ok('done') }));
    await safeFetch('https://feeds.example/a');
    expect(hops).toHaveLength(2);
    for (const h of hops) expect(typeof h.opts.lookup).toBe('function');
    expect(hops[0].opts.lookup).toBe(hops[1].opts.lookup);
  });
});

describe('redirects are vetted hop by hop', () => {
  test.each([
    ['http://10.0.0.1/admin', 'blocked_address', 'a literal private address'],
    ['http://127.0.0.1:3131/pulse/hot-set', 'bad_url', 'the checker itself (port not allowed)'],
    ['http://169.254.169.254/latest/meta-data/', 'blocked_address', 'the metadata address'],
    ['http://[::1]/', 'blocked_address', 'IPv6 loopback'],
    ['https://rebind.example/', 'blocked_address', 'a name that resolves to loopback'],
    ['https://mixed.example/', 'blocked_address', 'a name with a private answer among public ones'],
    ['http://localhost/', 'blocked_address', 'localhost by name'],
    ['ftp://feeds.example/x', 'bad_url', 'another scheme'],
    ['https://user:pw@cdn.example/', 'bad_url', 'credentials smuggled into the target'],
  ])('a redirect to %s is refused: %s (%s)', async (location, code) => {
    stub.handle(routes({ '/start': redirect(302, location) }));
    await expect(codeOf(safeFetch('https://feeds.example/start'))).resolves.toBe(code);
    // Only the first hop ever reached a server.
    expect(stub.requests.map((r) => r.url)).toEqual(['/start']);
  });

  test('a relative redirect stays on the same host and is followed', async () => {
    stub.handle(routes({ '/old': redirect(301, '/new?x=1'), '/new': ok('<rss/>') }));
    const res = await safeFetch('https://feeds.example/old');
    expect(res.status).toBe(200);
    expect(res.url).toBe('https://feeds.example/new?x=1');
    expect(res.body.toString()).toBe('<rss/>');
  });

  test('permanent is true only when every hop was a 301 or 308', async () => {
    stub.handle(routes({
      '/p1': redirect(301, '/p2'), '/p2': redirect(308, '/end'),
      '/t1': redirect(301, '/t2'), '/t2': redirect(302, '/end'),
      '/end': ok('ok'),
    }));
    expect((await safeFetch('https://feeds.example/p1')).permanent).toBe(true);
    expect((await safeFetch('https://feeds.example/t1')).permanent).toBe(false);
    expect((await safeFetch('https://feeds.example/end')).permanent).toBe(true);
  });

  test('a redirect loop stops at maxRedirects', async () => {
    stub.handle(routes({ '/loop': redirect(302, '/loop') }));
    await expect(codeOf(safeFetch('https://feeds.example/loop', { maxRedirects: 3 }))).resolves.toBe('too_many_redirects');
    expect(stub.requests).toHaveLength(4); // the first request plus three redirects
  });

  test('a redirect without a Location is an error named after its status', async () => {
    stub.handle(routes({ '/r': (_q, res) => { res.statusCode = 302; res.end(); } }));
    await expect(codeOf(safeFetch('https://feeds.example/r'))).resolves.toBe('http_302');
  });
});

describe('headers and credentials', () => {
  test('sends the bot User-Agent and accepts compressed answers', async () => {
    stub.handle(ok('x'));
    await safeFetch('https://feeds.example/');
    const h = stub.requests[0].headers;
    expect(h['user-agent']).toBe(USER_AGENT);
    expect(h['accept-encoding']).toMatch(/gzip/);
    expect(h.host).toBe('feeds.example');
  });

  test('conditional headers go to the first URL only, not to a redirect target', async () => {
    stub.handle(routes({ '/a': redirect(302, 'https://cdn.example/b'), '/b': ok('x') }));
    await safeFetch('https://feeds.example/a', { headers: { 'If-None-Match': '"v1"' } });
    expect(stub.requests[0].headers['if-none-match']).toBe('"v1"');
    expect(stub.requests[1].headers['if-none-match']).toBeUndefined();
  });

  test('a private feed password follows same-origin hops and never leaves the origin', async () => {
    stub.handle(routes({
      '/a': redirect(302, '/b'),
      '/b': redirect(302, 'https://cdn.example/c'),
      '/c': ok('x'),
    }));
    await safeFetch('https://feeds.example/a', { auth: 'Basic c2VjcmV0' });
    const auth = stub.requests.map((r) => [r.headers.host, r.headers.authorization]);
    expect(auth).toEqual([
      ['feeds.example', 'Basic c2VjcmV0'],
      ['feeds.example', 'Basic c2VjcmV0'],
      ['cdn.example', undefined],
    ]);
  });

  test('a switch from https to http on the same host counts as another origin', async () => {
    stub.handle(routes({ '/a': redirect(302, 'http://feeds.example/b'), '/b': ok('x') }));
    await safeFetch('https://feeds.example/a', { auth: 'Basic c2VjcmV0' });
    expect(stub.requests[1].headers.authorization).toBeUndefined();
  });
});

describe('splitCredentials', () => {
  test('moves user:pass out of the URL into a Basic header', () => {
    const { url, auth } = splitCredentials('https://al%40ice:p%3Ass@feeds.example/private.xml');
    expect(url).toBe('https://feeds.example/private.xml');
    expect(Buffer.from(auth.replace(/^Basic /, ''), 'base64').toString()).toBe('al@ice:p:ss');
  });

  test('a URL without credentials comes back unchanged with no header', () => {
    expect(splitCredentials(' https://feeds.example/a ')).toEqual({ url: 'https://feeds.example/a', auth: '' });
  });

  test('a broken percent escape is used as typed instead of throwing', () => {
    const { auth } = splitCredentials('https://bob:100%@feeds.example/');
    expect(Buffer.from(auth.replace(/^Basic /, ''), 'base64').toString()).toBe('bob:100%');
  });

  test('garbage is passed through for checkUrl to refuse', () => {
    expect(splitCredentials('not a url')).toEqual({ url: 'not a url', auth: '' });
    expect(splitCredentials(undefined)).toEqual({ url: '', auth: '' });
  });
});

describe('answers and body limits', () => {
  test('a 304 comes back with no body', async () => {
    stub.handle((_q, res) => { res.statusCode = 304; res.end(); });
    const res = await safeFetch('https://feeds.example/', { headers: { 'If-None-Match': '"v1"' } });
    expect(res.status).toBe(304);
    expect(res.body).toBeNull();
  });

  test.each([404, 410, 500, 503])('HTTP %i is an error named after the status', async (status) => {
    stub.handle((_q, res) => { res.statusCode = status; res.end('nope'); });
    await expect(codeOf(safeFetch('https://feeds.example/'))).resolves.toBe(`http_${status}`);
  });

  test('a declared Content-Length over the cap is refused without reading the body', async () => {
    stub.handle(ok('x'.repeat(2000), { 'Content-Length': '2000' }));
    await expect(codeOf(safeFetch('https://feeds.example/', { maxBytes: 1000 }))).resolves.toBe('too_large');
  });

  // Regression: for an uncompressed answer `stream` IS `res`, so res.destroy() ran
  // first and the stream.destroy(FetchError) after it was a no-op on an already
  // destroyed stream: no 'error' was ever emitted. What was already buffered still
  // arrived and 'end' fired, so the caller got status 200 and a body silently
  // TRUNCATED at maxBytes (a cut-off XML feed parsed as if whole), or, when the
  // socket was cut before 'end', a 'timeout' at the deadline.
  test('an uncompressed chunked body past the cap is refused, not returned truncated', async () => {
    stub.handle((_q, res) => {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      for (let i = 0; i < 20; i += 1) res.write('y'.repeat(500));
      res.end();
    });
    await expect(codeOf(safeFetch('https://feeds.example/', { maxBytes: 4000, timeoutMs: 5000 })))
      .resolves.toBe('too_large');
  });

  test('a gzip bomb is measured after decompression: a tiny download, refused', async () => {
    const bomb = zlib.gzipSync(Buffer.alloc(5 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(10 * 1024);
    stub.handle(ok(bomb, { 'Content-Encoding': 'gzip', 'Content-Length': String(bomb.length) }));
    await expect(codeOf(safeFetch('https://feeds.example/', { maxBytes: 64 * 1024 }))).resolves.toBe('too_large');
  });

  test.each([
    ['gzip', zlib.gzipSync],
    ['x-gzip', zlib.gzipSync],
    ['deflate', zlib.deflateSync],
    ['br', zlib.brotliCompressSync],
  ])('a %s body is decompressed', async (encoding, compress) => {
    const xml = '<rss><channel><title>Ünïcode</title></channel></rss>';
    stub.handle(ok(compress(Buffer.from(xml)), { 'Content-Encoding': encoding }));
    const res = await safeFetch('https://feeds.example/');
    expect(res.body.toString('utf8')).toBe(xml);
  });

  test('a corrupt compressed body is a network error', async () => {
    stub.handle(ok(Buffer.from('definitely not gzip'), { 'Content-Encoding': 'gzip' }));
    await expect(codeOf(safeFetch('https://feeds.example/'))).resolves.toBe('network');
  });

  test('a server that never answers runs into the deadline', async () => {
    stub.handle(() => { /* hold the request open */ });
    await expect(codeOf(safeFetch('https://feeds.example/', { timeoutMs: 60 }))).resolves.toBe('timeout');
  });

  test('a connection dropped mid-answer is a network error', async () => {
    stub.handle((req, res) => {
      res.writeHead(200, { 'Content-Length': '100' });
      res.write('partial');
      req.socket.destroy();
    });
    await expect(codeOf(safeFetch('https://feeds.example/'))).resolves.toBe('network');
  });

  // Regression: the redirect and error branches called res.resume(), which reads
  // and discards the rest of the body for as long as the server keeps sending. The
  // fetch itself returned, but the socket stayed open, draining, with no deadline
  // (the timer was cleared). A hostile feed answering every refresh with an endless
  // 302 body tied up one socket per refresh, forever.
  test('a redirect hop is closed, not left draining an endless body after the fetch returned', async () => {
    let hopSocket;
    let timer;
    stub.handle(routes({
      '/start': (req, res) => {
        hopSocket = req.socket;
        res.writeHead(302, { Location: '/end' });
        timer = setInterval(() => res.write('z'.repeat(1024)), 5);
      },
      '/end': ok('done'),
    }));
    try {
      await safeFetch('https://feeds.example/start', { timeoutMs: 2000 });
      const closed = await new Promise((resolve) => {
        if (hopSocket.destroyed) return resolve(true);
        hopSocket.once('close', () => resolve(true));
        setTimeout(() => resolve(false), 300).unref();
      });
      expect(closed).toBe(true);
    } finally {
      clearInterval(timer);
    }
  });
});

describe('safeStream', () => {
  const readAll = (stream) => new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString()));
    stream.on('error', reject);
  });

  test('hands back the live response stream, uncompressed, after vetted redirects', async () => {
    stub.handle(routes({ '/ep.mp3': redirect(302, 'https://cdn.example/files/ep.mp3'), '/files/ep.mp3': ok('ID3audio', { 'Content-Type': 'audio/mpeg' }) }));
    const res = await safeStream('https://feeds.example/ep.mp3', { headers: { Range: 'bytes=0-' } });
    expect(res.status).toBe(200);
    expect(res.url).toBe('https://cdn.example/files/ep.mp3');
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(await readAll(res.stream)).toBe('ID3audio');
    // Range is forwarded on every hop (the CDN needs it), compression is never asked for.
    expect(stub.requests.map((r) => r.headers.range)).toEqual(['bytes=0-', 'bytes=0-']);
    expect(stub.requests[0].headers['accept-encoding']).toBe('identity');
  });

  test('a redirect into the private network is refused', async () => {
    stub.handle(routes({ '/ep.mp3': redirect(302, 'http://192.168.0.1/ep.mp3') }));
    await expect(codeOf(safeStream('https://feeds.example/ep.mp3'))).resolves.toBe('blocked_address');
  });

  test('a name that resolves to loopback is refused', async () => {
    await expect(codeOf(safeStream('https://rebind.example/ep.mp3'))).resolves.toBe('blocked_address');
    expect(stub.requests).toHaveLength(0);
  });

  test.each([[304], [403], [404], [500]])('HTTP %i is thrown, not streamed', async (status) => {
    stub.handle((_q, res) => { res.statusCode = status; res.end(); });
    await expect(codeOf(safeStream('https://feeds.example/ep.mp3'))).resolves.toBe(`http_${status}`);
  });

  test('a redirect without a Location, and a redirect loop, are refused', async () => {
    stub.handle(routes({ '/nl': (_q, res) => { res.statusCode = 307; res.end(); }, '/loop': redirect(302, '/loop') }));
    await expect(codeOf(safeStream('https://feeds.example/nl'))).resolves.toBe('http_307');
    await expect(codeOf(safeStream('https://feeds.example/loop', { maxRedirects: 2 }))).resolves.toBe('too_many_redirects');
  });

  test('the auth header stays on its own origin', async () => {
    stub.handle(routes({ '/a': redirect(302, 'https://cdn.example/b'), '/b': ok('x') }));
    const res = await safeStream('https://feeds.example/a', { auth: 'Basic c2VjcmV0' });
    res.abort();
    expect(stub.requests.map((r) => r.headers.authorization)).toEqual(['Basic c2VjcmV0', undefined]);
  });

  test('a host that never answers runs into the deadline', async () => {
    stub.handle(() => { /* hold */ });
    await expect(codeOf(safeStream('https://feeds.example/ep.mp3', { timeoutMs: 60 }))).resolves.toBe('timeout');
  });

  test('a host that stalls mid-file is cut off by the idle timeout', async () => {
    stub.handle((_q, res) => { res.writeHead(200); res.write('start'); /* then silence */ });
    const res = await safeStream('https://feeds.example/ep.mp3', { idleMs: 60 });
    const err = await readAll(res.stream).then(() => null, (e) => e);
    expect(err).toBeTruthy();
  });

  test('a bad URL is refused up front', async () => {
    await expect(codeOf(safeStream('file:///etc/passwd'))).resolves.toBe('bad_url');
  });
});
