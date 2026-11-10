/**
 * Refresh the datacenter / cloud / VPN IP range file that utils/datacenterIp.js reads
 * (the ad server answers those addresses with no ad).
 *
 * CommonJS port of ButrAuth's backend/scripts/refresh-ip-ranges.js, so the checker
 * no longer depends on a ButrAuth checkout on the same box. Same sources, same
 * safety rules, same file format. Keep the two in step. The disposable-email half
 * of ButrAuth's script is left out: the checker has no use for it.
 *
 * Why it lives here (2026-11-10): the checker read ButrAuth's file by a relative
 * path. On the Helsinki box that works, but the US replica has no ButrAuth checkout,
 * so the lookup failed OPEN there and a datacenter range (72.63.224.0/20) got ad
 * sessions that Helsinki refuses.
 *
 * TWO KINDS OF SOURCE. The cloud feeds (aws, gcp, oracle, digitalocean, linode,
 * vultr) are the provider's own data; hetzner comes from its BGP announcements.
 * The rest are curated third-party lists (per-provider consumer VPNs, X4BNet's
 * datacenter + VPN lists) that cover what no provider publishes. See ButrAuth's
 * script for the false-positive check behind adding them.
 *
 * No viewer's address is ever sent anywhere: every source is a bulk file fetched
 * on a timer and matched locally.
 *
 * CLOUDFLARE IS SUBTRACTED. It is a CDN in front of us, not an origin viewers dial
 * from, and a third-party list can start including it on any day. A run that
 * cannot fetch Cloudflare's own ranges refuses to write at all.
 *
 * A run that is mostly failed, too small, or much smaller than the file already on
 * disk also refuses to write: a stale file is better than a partial one.
 *
 * Scheduling (server.js, EVERY instance, replicas too: each box needs its own
 * file): a minute after boot, then hourly, refresh when the file is missing or
 * older than IP_RANGES_MAX_AGE_H (24). IP_RANGES_REFRESH_ENABLED=false turns it off.
 * By hand: `node scripts/refresh-ip-ranges.js [--out path] [--dry-run]`.
 */
const fs = require('fs');
const path = require('path');
const { parseCidrV4, parseCidrV6, LOCAL_RANGES_PATH } = require('../utils/datacenterIp');

const TIMEOUT_MS = 30000;
const ENABLED = process.env.IP_RANGES_REFRESH_ENABLED !== 'false';
const MAX_AGE_MS = Math.max(1, parseFloat(process.env.IP_RANGES_MAX_AGE_H) || 24) * 3600e3;
const BOOT_DELAY_MS = 60 * 1000;
const CHECK_EVERY_MS = 3600e3;

const CIDR_RE = /^[0-9a-fA-F:.]+\/\d{1,3}$/;

async function get(url, as = 'json') {
  const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return as === 'json' ? r.json() : r.text();
}

// Each source returns CIDR strings. A source that throws is reported and skipped:
// one provider having a bad day must not wipe the set.
const SOURCES = [
  {
    name: 'aws',
    async fetch() {
      const d = await get('https://ip-ranges.amazonaws.com/ip-ranges.json');
      return [
        ...(d.prefixes || []).map((p) => p.ip_prefix),
        ...(d.ipv6_prefixes || []).map((p) => p.ipv6_prefix),
      ];
    },
  },
  {
    name: 'gcp',
    async fetch() {
      const d = await get('https://www.gstatic.com/ipranges/cloud.json');
      return (d.prefixes || []).map((p) => p.ipv4Prefix || p.ipv6Prefix);
    },
  },
  {
    name: 'oracle',
    async fetch() {
      const d = await get('https://docs.oracle.com/en-us/iaas/tools/public_ip_ranges.json');
      return (d.regions || []).flatMap((r) => (r.cidrs || []).map((c) => c.cidr));
    },
  },
  {
    name: 'digitalocean',
    async fetch() {
      const t = await get('https://digitalocean.com/geo/google.csv', 'text');
      return t.split('\n').map((l) => l.split(',')[0]).filter(Boolean);
    },
  },
  {
    name: 'linode',
    async fetch() {
      const t = await get('https://geoip.linode.com/', 'text');
      return t.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',')[0]).filter(Boolean);
    },
  },
  {
    name: 'vultr',
    async fetch() {
      const d = await get('https://geofeed.constant.com/?json');
      return (d.subnets || []).map((s) => s.ip_prefix || s.ipv6_prefix).filter(Boolean);
    },
  },
  // Hetzner publishes no feed, so take what its networks announce in BGP.
  {
    name: 'hetzner',
    async fetch() {
      const out = [];
      for (const asn of [24940, 213230, 212317]) {
        const d = await get(`https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS${asn}`);
        for (const p of (d && d.data && d.data.prefixes) || []) if (p.prefix) out.push(p.prefix);
      }
      if (out.length < 100) throw new Error(`only ${out.length} prefixes, expected hundreds`);
      return out;
    },
  },
  // Consumer VPNs, one provider per source (exits and entries), so a refusal can
  // say WHICH network an address belongs to.
  ...[
    { name: 'protonvpn', repo: 'ProtonVPN-IPs', files: ['protonvpn_ip_ranges.txt', 'protonvpn_entry_ip_ranges.txt'] },
    { name: 'windscribe', repo: 'Windscribe-IPs', files: ['windscribe_ips.txt', 'windscribe_entry_ips.txt'] },
    { name: 'tunnelbear', repo: 'TunnelBear-IPs', files: ['tunnelbear_ips.txt'] },
  ].map(({ name, repo, files }) => ({
    name,
    async fetch() {
      const out = [];
      for (const f of files) {
        // `master`, not `main`: these repos still use the old default branch.
        const t = await get(`https://raw.githubusercontent.com/tn3w/${repo}/master/${f}`, 'text');
        for (const line of t.split('\n')) {
          const v = line.trim();
          if (!v || v.startsWith('#')) continue;
          // Some files list bare addresses; a bare address is a /32.
          out.push(v.includes('/') ? v : `${v}/32`);
        }
      }
      if (!out.length) throw new Error('no ranges parsed');
      return out;
    },
  })),
  // The long tail of hosting companies that publish nothing. LAST, because dedupe
  // keeps the first source to claim a range, so a named provider wins the label.
  ...[
    { name: 'datacenter-list', file: 'datacenter/ipv4.txt' },
    { name: 'vpn-list', file: 'vpn/ipv4.txt' },
  ].map(({ name, file }) => ({
    name,
    async fetch() {
      const t = await get(`https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/${file}`, 'text');
      const out = t.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
      if (out.length < 1000) throw new Error(`only ${out.length} ranges, expected thousands`);
      return out;
    },
  })),
];

// Hosting ranges with no machine-readable feed. Add ranges as abuse is observed.
const MANUAL = { provider: 'manual', cidrs: [] };

const CLOUDFLARE_SOURCES = ['https://www.cloudflare.com/ips-v4', 'https://www.cloudflare.com/ips-v6'];

async function cloudflareRanges() {
  const cidrs = [];
  for (const url of CLOUDFLARE_SOURCES) {
    const t = await get(url, 'text');
    for (const line of t.split('\n')) {
      const v = line.trim();
      if (v && !v.startsWith('#') && CIDR_RE.test(v)) cidrs.push(v);
    }
  }
  // ~15 v4 + ~7 v6 for years. A handful means the page changed shape.
  if (cidrs.length < 10) throw new Error(`only ${cidrs.length} prefixes parsed, expected ~20`);
  const v4 = [];
  const v6 = [];
  for (const c of cidrs) {
    const a = parseCidrV4(c);
    if (a) { v4.push(a); continue; }
    const b = parseCidrV6(c);
    if (b) v6.push(b);
  }
  return { v4, v6 };
}

/** Does `cidr` fall inside any Cloudflare prefix? Containment, not equality. */
function insideCloudflare(cidr, cf) {
  if (!cidr.includes(':')) {
    const a = parseCidrV4(cidr);
    return !!a && cf.v4.some((r) => a.start >= r.start && a.end <= r.end);
  }
  const b = parseCidrV6(cidr);
  return !!b && cf.v6.some((r) => b.start >= r.start && b.end <= r.end);
}

/**
 * Fetch every source and write the file. Throws (and leaves the existing file
 * alone) when the result is not safe to use. Returns a summary.
 */
async function refresh({ out = LOCAL_RANGES_PATH, dryRun = false, log = console.log } = {}) {
  const collected = [];
  const report = [];
  for (const src of SOURCES) {
    try {
      const list = (await src.fetch()).filter((c) => typeof c === 'string' && CIDR_RE.test(c.trim()));
      for (const cidr of list) collected.push({ cidr: cidr.trim(), provider: src.name });
      report.push({ source: src.name, count: list.length, ok: true });
    } catch (err) {
      report.push({ source: src.name, count: 0, ok: false, error: err.message });
    }
  }
  for (const cidr of MANUAL.cidrs) collected.push({ cidr, provider: MANUAL.provider });

  // Fatal on failure: writing a set that MIGHT contain Cloudflare could refuse ads
  // to every viewer behind a misconfigured proxy at once.
  let cf;
  try {
    cf = await cloudflareRanges();
  } catch (err) {
    throw new Error(`could not fetch Cloudflare's ranges (${err.message}), keeping the existing file`);
  }

  const seen = new Set();
  const ranges = [];
  let droppedCf = 0;
  for (const r of collected) {
    if (insideCloudflare(r.cidr, cf)) { droppedCf += 1; continue; }
    if (seen.has(r.cidr)) continue;
    seen.add(r.cidr);
    ranges.push(r);
  }

  for (const r of report) log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.source.padEnd(15)} ${r.ok ? r.count : r.error}`);
  if (droppedCf) log(`  note: dropped ${droppedCf} range(s) inside Cloudflare: a source has started listing the CDN`);

  const okSources = report.filter((r) => r.ok).length;
  if (okSources < Math.ceil(SOURCES.length / 2)) {
    throw new Error(`only ${okSources}/${SOURCES.length} sources succeeded, keeping the existing file`);
  }
  if (ranges.length < 1000) {
    throw new Error(`only ${ranges.length} ranges collected, expected thousands, keeping the existing file`);
  }
  // One aggregated list alone clears the floor above, so also compare with what is
  // on disk: losing more than a third means something upstream broke.
  try {
    const prevCount = Number(JSON.parse(fs.readFileSync(out, 'utf8')).count) || 0;
    if (prevCount > 0 && ranges.length < prevCount * 0.65) {
      throw Object.assign(new Error(`${ranges.length} ranges is well down on the ${prevCount} already on disk, keeping the existing file (delete it and re-run if the shrink is intended)`), { fatal: true });
    }
  } catch (err) {
    if (err.fatal) throw err;
    if (err.code !== 'ENOENT') log(`  note: could not read existing ${out} (${err.message})`);
  }

  const summary = { count: ranges.length, okSources, sources: SOURCES.length, droppedCf, written: false, out };
  log(`  total ${ranges.length} unique ranges from ${okSources}/${SOURCES.length} sources`);
  if (dryRun) return summary;

  fs.mkdirSync(path.dirname(out), { recursive: true });
  // Write-then-rename: datacenterIp.js never sees a half-written file.
  const tmp = `${out}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ generatedAt: new Date().toISOString(), sources: report, count: ranges.length, ranges }));
  fs.renameSync(tmp, out);
  log(`  wrote ${out}`);
  return { ...summary, written: true };
}

/** File age in ms, or Infinity when there is none. */
function ageOf(file) {
  try { return Date.now() - fs.statSync(file).mtimeMs; } catch { return Infinity; }
}

let running = false;
/** Refresh when the file is missing or older than the max age. Never throws. */
async function runIfStale({ out = LOCAL_RANGES_PATH, maxAgeMs = MAX_AGE_MS } = {}) {
  if (running || ageOf(out) < maxAgeMs) return null;
  running = true;
  try {
    const r = await refresh({ out, log: (l) => console.log(`[ipRanges]${l}`) });
    return r;
  } catch (err) {
    console.error('[ipRanges] refresh failed:', err.message);
    return null;
  } finally {
    running = false;
  }
}

/** Boot hook for server.js. Every instance runs it: each box needs its own file. */
function start() {
  if (!ENABLED) {
    console.log('[ipRanges] IP_RANGES_REFRESH_ENABLED=false: not refreshing the datacenter range file');
    return;
  }
  setTimeout(() => runIfStale(), BOOT_DELAY_MS).unref();
  setInterval(() => runIfStale(), CHECK_EVERY_MS).unref();
}

module.exports = { refresh, runIfStale, start, insideCloudflare, SOURCES, CLOUDFLARE_SOURCES };
