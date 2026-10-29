/**
 * Fetching a URL that a USER typed in, from inside our network.
 *
 * An outside podcast feed is any URL anyone pastes into the Podcasts tab, and the
 * server fetches it. Without care that is a way to make this box request things
 * only it can reach: a Mongo port, the checker itself on :3131, the cloud
 * metadata address, or this host's own PUBLIC address, which reaches every
 * service bound to 0.0.0.0 from the inside even where the firewall closes it.
 *
 * So, for every hop (redirects included):
 * - http/https only, ports 80/443 (and 8080/8443) only;
 * - the address the socket ACTUALLY connects to is checked, in the `lookup`
 *   hook, so a DNS answer that changes between "check" and "connect" changes
 *   nothing; literal IPs are checked before any request is made;
 * - private, loopback, link-local, CGNAT, multicast, reserved and this host's own
 *   addresses are refused;
 * - the body is capped AFTER decompression (a gzip bomb is a small download),
 *   and the whole fetch has one deadline.
 */
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const os = require('os');
const zlib = require('zlib');

const USER_AGENT = '3SpeakPodcastBot/1.0 (+https://3speak.tv)';
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
  ['2001:db8::', 32], ['100::', 64],
]) blocked.addSubnet(addr, prefix, 'ipv6');

// This host's own addresses, public ones included (see the header).
for (const list of Object.values(os.networkInterfaces())) {
  for (const i of list || []) {
    try { blocked.addAddress(i.address.split('%')[0], i.family === 'IPv6' ? 'ipv6' : 'ipv4'); } catch (_) { /* odd iface */ }
  }
}
for (const a of String(process.env.SAFE_FETCH_BLOCK_IPS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
  try { blocked.addAddress(a, net.isIPv6(a) ? 'ipv6' : 'ipv4'); } catch (_) { /* ignore */ }
}

/** True when a request to `ip` must not be made. */
function isBlockedAddress(ip) {
  const family = net.isIP(ip);
  if (!family) return true;
  if (family === 6) {
    const lower = ip.toLowerCase();
    // IPv4 in IPv6 clothing: mapped (::ffff:a.b.c.d), NAT64 (64:ff9b::a.b.c.d) and
    // 6to4 (2002:AABB:CCDD::) all end up at an IPv4 address; judge that one.
    const mapped = lower.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]);
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(lower) || lower.startsWith('64:ff9b:') || lower.startsWith('2002:')) return true;
    return blocked.check(ip, 'ipv6');
  }
  return blocked.check(ip, 'ipv4');
}

class FetchError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err);
    const ok = (addresses || []).filter((a) => !isBlockedAddress(a.address));
    // One bad answer poisons the lot: a name that resolves to both a public and a
    // private address is exactly the trick this guards against.
    if (!ok.length || ok.length !== addresses.length) {
      return callback(new FetchError('blocked_address', `refusing to connect to ${hostname}`));
    }
    if (options && options.all) return callback(null, ok);
    return callback(null, ok[0].address, ok[0].family);
  });
}

/** Parse and vet one URL. Throws FetchError('bad_url' | 'blocked_address'). */
function checkUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch (_) { throw new FetchError('bad_url', 'not a URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new FetchError('bad_url', 'only http(s) URLs');
  if (u.username || u.password) throw new FetchError('bad_url', 'no credentials in URLs');
  if (!ALLOWED_PORTS.has(u.port)) throw new FetchError('bad_url', 'port not allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new FetchError('blocked_address', 'local host names are not allowed');
  }
  if (net.isIP(host) && isBlockedAddress(host)) throw new FetchError('blocked_address', 'address not allowed');
  return u;
}

function requestOnce(u, { headers, timeoutMs, maxBytes, deadline }) {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'GET',
      lookup: guardedLookup,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        ...headers,
      },
      timeout: timeoutMs,
    });
    const left = deadline - Date.now();
    const timer = setTimeout(() => req.destroy(new FetchError('timeout', 'took too long')), Math.max(1, left));
    req.on('timeout', () => req.destroy(new FetchError('timeout', 'took too long')));
    req.on('error', (err) => { clearTimeout(timer); reject(err instanceof FetchError ? err : new FetchError(err.code === 'blocked_address' ? 'blocked_address' : 'network', err.message)); });
    req.on('response', (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 || status === 304 || status >= 400) {
        res.resume();
        clearTimeout(timer);
        return resolve({ status, headers: res.headers, body: null });
      }
      const declared = parseInt(res.headers['content-length'], 10);
      if (Number.isFinite(declared) && declared > maxBytes && !res.headers['content-encoding']) {
        res.destroy();
        clearTimeout(timer);
        return reject(new FetchError('too_large', 'feed is too large'));
      }
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = [];
      let size = 0;
      stream.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) {
          res.destroy();
          stream.destroy(new FetchError('too_large', 'feed is too large'));
          return;
        }
        chunks.push(c);
      });
      stream.on('error', (err) => { clearTimeout(timer); reject(err instanceof FetchError ? err : new FetchError('network', err.message)); });
      stream.on('end', () => { clearTimeout(timer); resolve({ status, headers: res.headers, body: Buffer.concat(chunks) }); });
    });
    req.end();
  });
}

/**
 * GET a user-supplied URL safely.
 * @returns {Promise<{status, url, permanent, headers, body: Buffer|null}>}
 *   `url` is where it ended up; `permanent` is true when every redirect on the way
 *   was a 301/308 (the feed has really moved). 304 comes back with body null.
 */
async function safeFetch(rawUrl, { headers = {}, timeoutMs = 15000, maxBytes = 16 * 1024 * 1024, maxRedirects = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let u = checkUrl(rawUrl);
  let permanent = true;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    // Conditional headers belong to the URL we stored them for, not a redirect target.
    const res = await requestOnce(u, { headers: hop === 0 ? headers : {}, timeoutMs, maxBytes, deadline });
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      const loc = res.headers.location;
      if (!loc) throw new FetchError(`http_${res.status}`, 'redirect without a location');
      if (res.status !== 301 && res.status !== 308) permanent = false;
      u = checkUrl(new URL(loc, u).toString());
      continue;
    }
    if (res.status >= 400) throw new FetchError(`http_${res.status}`, `server answered ${res.status}`);
    return { ...res, url: u.toString(), permanent };
  }
  throw new FetchError('too_many_redirects', 'too many redirects');
}

module.exports = { safeFetch, checkUrl, isBlockedAddress, FetchError, USER_AGENT };
