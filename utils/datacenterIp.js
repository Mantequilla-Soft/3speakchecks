/**
 * Is this address inside a known datacenter / cloud / VPN-hosting range?
 *
 * Used by the ad server (routes/adServe.js) so a request from a hosting range is
 * answered with no ad: a real viewer does not browse from an AWS box, a script
 * does. Reflectionbot ran from 16.216.88.0/23 and generated one paid impression
 * per page load before it was caught (2026-09-28).
 *
 * CommonJS port of butrauth/backend/src/services/ip-intel.js, reading the SAME
 * file that ButrAuth's refresh timer (butrauth-ip-ranges-prod.service) rewrites
 * nightly, so both services judge an address identically. Keep the parsing and
 * coalescing in step with that file.
 *
 *   * Offline. No address ever leaves the box.
 *   * FAILS OPEN. A missing or unreadable file means every address is clean:
 *     losing the filter must never mean losing every ad.
 *   * Re-reads the file when its mtime changes (checked at most every 10 min), so
 *     the nightly refresh applies without a restart.
 *   * Cloudflare is already SUBTRACTED from the file by the refresh script.
 */
const fs = require('fs');
const path = require('path');

const RANGES_PATH = process.env.AD_DATACENTER_RANGES_PATH
  || path.join(__dirname, '..', '..', 'butrauth', 'backend', 'data', 'datacenter-ranges.json');
const ENABLED = process.env.AD_BLOCK_DATACENTER_IPS !== 'false';
const RECHECK_MS = 10 * 60 * 1000;

let v4 = [];
let v6 = [];
let loadedMtime = 0;
let lastCheck = 0;
let warned = false;

function ipv4ToInt(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const o = Number(m[i]);
    if (!Number.isInteger(o) || o < 0 || o > 255) return null;
    n = n * 256 + o;
  }
  return n;
}

function ipv6ToBigInt(ip) {
  let s = ip.trim().toLowerCase();
  if (s.includes('%')) s = s.split('%')[0];
  if (!s.includes(':')) return null;
  const v4tail = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (v4tail) {
    const n = ipv4ToInt(v4tail[1]);
    if (n === null) return null;
    s = s.slice(0, v4tail.index) + ((n >>> 16) & 0xffff).toString(16) + ':' + (n & 0xffff).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  // An empty group is a stray colon: malformed, not "zero".
  const splitStrict = (part) => {
    if (part === '') return [];
    const groups = part.split(':');
    return groups.some((g) => g === '') ? null : groups;
  };
  const head = splitStrict(halves[0]);
  const tail = halves.length === 2 ? splitStrict(halves[1]) : null;
  if (head === null || (halves.length === 2 && tail === null)) return null;
  let groups;
  if (tail === null) {
    groups = head;
  } else {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill('0'), ...tail];
  }
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

function normalizeIp(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  const ip = raw.trim();
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ip);
  return mapped ? mapped[1] : ip;
}

function parseCidrV4(cidr) {
  const [addr, bitsRaw] = String(cidr).split('/');
  const base = ipv4ToInt(addr);
  if (base === null) return null;
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const size = 2 ** (32 - bits);
  const start = Math.floor(base / size) * size;
  return { start, end: start + size - 1 };
}

function parseCidrV6(cidr) {
  const [addr, bitsRaw] = String(cidr).split('/');
  const base = ipv6ToBigInt(addr);
  if (base === null) return null;
  const bits = bitsRaw === undefined ? 128 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 128) return null;
  const hostBits = BigInt(128 - bits);
  const start = (base >> hostBits) << hostBits;
  return { start, end: start + (1n << hostBits) - 1n };
}

/**
 * Merge overlapping / nested intervals. REQUIRED for correctness: providers
 * publish broad ranges alongside sub-ranges, and the binary search below would
 * miss an address inside a container range that sorts before a nested one.
 */
function coalesce(sorted) {
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + (typeof last.end === 'bigint' ? 1n : 1)) {
      if (r.end > last.end) last.end = r.end;
    } else {
      out.push({ start: r.start, end: r.end, provider: r.provider });
    }
  }
  return out;
}

function loadRanges() {
  try {
    const doc = JSON.parse(fs.readFileSync(RANGES_PATH, 'utf8'));
    const nextV4 = [];
    const nextV6 = [];
    for (const entry of doc.ranges || []) {
      const cidr = typeof entry === 'string' ? entry : entry.cidr;
      const provider = typeof entry === 'string' ? 'unknown' : (entry.provider || 'unknown');
      if (!cidr) continue;
      const r = cidr.includes(':') ? parseCidrV6(cidr) : parseCidrV4(cidr);
      if (r) (cidr.includes(':') ? nextV6 : nextV4).push({ ...r, provider });
    }
    nextV4.sort((a, b) => a.start - b.start);
    nextV6.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    // Keep a good set rather than swap in an empty one from a bad refresh.
    if (!nextV4.length && !nextV6.length) throw new Error('no ranges in file');
    v4 = coalesce(nextV4);
    v6 = coalesce(nextV6);
    console.log(`[datacenterIp] loaded ${v4.length} v4 + ${v6.length} v6 ranges from ${RANGES_PATH}`);
  } catch (err) {
    if (!warned) console.warn(`[datacenterIp] ranges unavailable (${err.message}), failing OPEN`);
    warned = true;
  }
}

function refreshIfChanged() {
  const now = Date.now();
  if (now - lastCheck < RECHECK_MS && (v4.length || v6.length)) return;
  lastCheck = now;
  try {
    const mtime = fs.statSync(RANGES_PATH).mtimeMs;
    if (mtime !== loadedMtime) { loadedMtime = mtime; loadRanges(); }
  } catch (err) {
    if (!warned) console.warn(`[datacenterIp] cannot stat ${RANGES_PATH} (${err.message}), failing OPEN`);
    warned = true;
  }
}

function findIn(list, value) {
  let lo = 0; let hi = list.length - 1; let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (value < list[mid].start) hi = mid - 1;
    else { best = list[mid]; lo = mid + 1; }
  }
  return best;
}

/** { datacenter, provider }. Unknown, unparseable or no data -> datacenter:false. */
function lookupIp(rawIp) {
  if (!ENABLED) return { datacenter: false, provider: null };
  refreshIfChanged();
  const ip = normalizeIp(rawIp);
  if (!ip) return { datacenter: false, provider: null };
  const n = ip.includes(':') ? ipv6ToBigInt(ip) : ipv4ToInt(ip);
  const list = ip.includes(':') ? v6 : v4;
  if (n === null || !list.length) return { datacenter: false, provider: null };
  const hit = findIn(list, n);
  if (hit && n >= hit.start && n <= hit.end) return { datacenter: true, provider: hit.provider };
  return { datacenter: false, provider: null };
}

const isDatacenterIp = (rawIp) => lookupIp(rawIp).datacenter;

module.exports = { lookupIp, isDatacenterIp };
