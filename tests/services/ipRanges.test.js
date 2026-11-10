/**
 * services/ipRanges.js: the checker's own refresh of the datacenter IP range file
 * that utils/datacenterIp.js reads for the ad server. Every source is stubbed
 * (fakeFetch); files go to a temporary directory.
 *
 * What must hold: a usable set is written and read back by the ad gate, Cloudflare
 * never ends up in it, and every unsafe run (no Cloudflare list, most sources down,
 * a big shrink) leaves the existing file alone.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fakeFetch } = require('./_fixtures');
const { refresh, runIfStale, insideCloudflare } = require('../../services/ipRanges');
const { pickRangesPath, LOCAL_RANGES_PATH, LEGACY_RANGES_PATH } = require('../../utils/datacenterIp');

const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));
const lines = (arr) => arr.join('\n');

const CF_V4 = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13'];
const CF_V6 = ['2400:cb00::/32', '2606:4700::/32'];

// One stub per source. `over` replaces a route's handler: { aws: () => ({ status: 500 }) }.
function sources(over = {}) {
  const h = {
    aws: () => ({ body: { prefixes: [{ ip_prefix: '16.216.88.0/23' }], ipv6_prefixes: [{ ipv6_prefix: '2600:1f00::/24' }] } }),
    gcp: () => ({ body: { prefixes: [{ ipv4Prefix: '34.64.0.0/10' }, { ipv6Prefix: '2600:1900::/28' }] } }),
    oracle: () => ({ body: { regions: [{ cidrs: [{ cidr: '129.146.0.0/16' }] }] } }),
    digitalocean: () => ({ body: '164.90.128.0/17,NL,,,\n' }),
    linode: () => ({ body: '# comment\n172.104.0.0/15,US\n' }),
    vultr: () => ({ body: { subnets: [{ ip_prefix: '45.32.0.0/16' }] } }),
    hetzner: () => ({ body: { data: { prefixes: many(40, (i) => ({ prefix: `5.9.${i}.0/24` })) } } }),
    tn3w: (url) => ({ body: url.includes('ProtonVPN') ? '185.159.157.10\n# x\n185.159.158.0/24\n' : '45.9.0.0/24\n' }),
    datacenter: () => ({
      body: lines([
        ...many(1200, (i) => `100.${Math.floor(i / 256)}.${i % 256}.0/24`),
        '16.216.88.0/23',     // also AWS's: the first source keeps the label
        '104.16.5.0/24',      // inside Cloudflare: must be dropped
        'not a cidr',
      ]),
    }),
    vpn: () => ({ body: lines(many(1000, (i) => `101.${Math.floor(i / 256)}.${i % 256}.0/24`)) }),
    cf4: () => ({ body: lines(CF_V4) }),
    cf6: () => ({ body: lines(CF_V6) }),
    ...over,
  };
  return fakeFetch([
    ['https://ip-ranges.amazonaws.com/', h.aws],
    ['https://www.gstatic.com/ipranges/', h.gcp],
    ['https://docs.oracle.com/', h.oracle],
    ['https://digitalocean.com/', h.digitalocean],
    ['https://geoip.linode.com/', h.linode],
    ['https://geofeed.constant.com/', h.vultr],
    ['https://stat.ripe.net/', h.hetzner],
    ['https://raw.githubusercontent.com/tn3w/', h.tn3w],
    ['https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/datacenter/', h.datacenter],
    ['https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/vpn/', h.vpn],
    ['https://www.cloudflare.com/ips-v4', h.cf4],
    ['https://www.cloudflare.com/ips-v6', h.cf6],
  ]);
}

let dir;
let out;
let realFetch;
const quiet = () => {};
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipranges-')); });
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  out = path.join(dir, `ranges-${Math.random().toString(36).slice(2)}.json`);
  realFetch = global.fetch;
  global.fetch = sources();
});
afterEach(() => {
  global.fetch = realFetch;
  delete process.env.AD_DATACENTER_RANGES_PATH;
  jest.restoreAllMocks();
});
const written = () => JSON.parse(fs.readFileSync(out, 'utf8'));

describe('a refresh', () => {
  test('writes every source, deduped, with Cloudflare taken out, and the ad gate reads it', async () => {
    const r = await refresh({ out, log: quiet });
    expect(r).toMatchObject({ written: true, okSources: 12, sources: 12, droppedCf: 1 });

    const doc = written();
    const byCidr = new Map(doc.ranges.map((x) => [x.cidr, x.provider]));
    expect(doc.count).toBe(doc.ranges.length);
    expect(byCidr.get('16.216.88.0/23')).toBe('aws');            // first claim wins
    expect(byCidr.get('185.159.157.10/32')).toBe('protonvpn');   // bare address = /32
    expect(byCidr.get('5.9.0.0/24')).toBe('hetzner');
    expect(byCidr.has('104.16.5.0/24')).toBe(false);             // inside Cloudflare
    expect(byCidr.has('not a cidr')).toBe(false);
    expect(doc.ranges.filter((x) => x.cidr === '16.216.88.0/23')).toHaveLength(1);
    expect(fs.existsSync(`${out}.tmp`)).toBe(false);

    jest.spyOn(console, 'log').mockImplementation(quiet);
    process.env.AD_DATACENTER_RANGES_PATH = out;
    let gate;
    jest.isolateModules(() => { gate = require('../../utils/datacenterIp'); });
    expect(gate.lookupIp('16.216.88.5')).toEqual({ datacenter: true, provider: 'aws' });
    expect(gate.lookupIp('72.63.226.1').datacenter).toBe(false);
    expect(gate.lookupIp('104.16.5.1').datacenter).toBe(false);
  });

  test('a source that fails is reported and skipped, the rest is still written', async () => {
    global.fetch = sources({ aws: () => ({ status: 503 }) });
    const r = await refresh({ out, log: quiet });
    expect(r).toMatchObject({ written: true, okSources: 11 });
    const doc = written();
    expect(doc.sources.find((s) => s.source === 'aws')).toMatchObject({ ok: false, error: 'HTTP 503' });
    expect(doc.ranges.find((x) => x.cidr === '16.216.88.0/23').provider).toBe('datacenter-list');
  });

  test('a dry run fetches and reports but writes nothing', async () => {
    const r = await refresh({ out, dryRun: true, log: quiet });
    expect(r).toMatchObject({ written: false, okSources: 12 });
    expect(fs.existsSync(out)).toBe(false);
  });
});

describe('unsafe runs keep the existing file', () => {
  const seed = (count) => fs.writeFileSync(out, JSON.stringify({ count, ranges: [{ cidr: '1.2.3.0/24', provider: 'old' }] }));

  test('no Cloudflare list, no write', async () => {
    seed(5);
    global.fetch = sources({ cf4: () => ({ status: 500 }) });
    await expect(refresh({ out, log: quiet })).rejects.toThrow(/Cloudflare/);
    expect(written().ranges[0].provider).toBe('old');
  });

  test('a Cloudflare page that parses to a handful of prefixes counts as failed', async () => {
    global.fetch = sources({ cf4: () => ({ body: '<html>moved</html>' }), cf6: () => ({ body: CF_V6[0] }) });
    await expect(refresh({ out, log: quiet })).rejects.toThrow(/expected ~20/);
    expect(fs.existsSync(out)).toBe(false);
  });

  test('most sources down', async () => {
    seed(5);
    const down = () => ({ status: 500 });
    global.fetch = sources({ aws: down, gcp: down, oracle: down, digitalocean: down, linode: down, vultr: down, hetzner: down });
    await expect(refresh({ out, log: quiet })).rejects.toThrow('only 5/12 sources succeeded');
    expect(written().ranges[0].provider).toBe('old');
  });

  test('a set much smaller than the one on disk', async () => {
    seed(10000);
    await expect(refresh({ out, log: quiet })).rejects.toThrow(/well down on the 10000/);
    expect(written().count).toBe(10000);
  });

  test('too few ranges overall', async () => {
    global.fetch = sources({ datacenter: () => ({ body: 'x' }), vpn: () => ({ body: 'x' }) });
    await expect(refresh({ out, log: quiet })).rejects.toThrow(/expected thousands/);
    expect(fs.existsSync(out)).toBe(false);
  });
});

describe('runIfStale (the scheduled entry point)', () => {
  test('a fresh file is left alone, nothing is fetched', async () => {
    fs.writeFileSync(out, '{}');
    expect(await runIfStale({ out, maxAgeMs: 3600e3 })).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('a missing or old file is refreshed', async () => {
    jest.spyOn(console, 'log').mockImplementation(quiet);
    expect(await runIfStale({ out, maxAgeMs: 3600e3 })).toMatchObject({ written: true });
    const old = (Date.now() - 2 * 3600e3) / 1000;
    fs.utimesSync(out, old, old);
    expect(await runIfStale({ out, maxAgeMs: 3600e3 })).toMatchObject({ written: true });
  });

  test('a failed refresh is logged and never throws', async () => {
    jest.spyOn(console, 'log').mockImplementation(quiet);
    jest.spyOn(console, 'error').mockImplementation(quiet);
    global.fetch = sources({ cf4: () => ({ status: 500 }), cf6: () => ({ status: 500 }) });
    await expect(runIfStale({ out, maxAgeMs: 3600e3 })).resolves.toBeNull();
    expect(console.error).toHaveBeenCalledWith('[ipRanges] refresh failed:', expect.stringMatching(/Cloudflare/));
  });
});

describe('helpers', () => {
  test('Cloudflare containment, v4 and v6', () => {
    const cf = { v4: [{ start: 10, end: 20 }], v6: [] };
    // Real prefixes through the parser: 104.16.0.0/13 holds 104.16.5.0/24, not 104.24.0.0/24.
    const { parseCidrV4, parseCidrV6 } = require('../../utils/datacenterIp');
    const real = { v4: [parseCidrV4('104.16.0.0/13')], v6: [parseCidrV6('2606:4700::/32')] };
    expect(insideCloudflare('104.16.5.0/24', real)).toBe(true);
    expect(insideCloudflare('104.24.0.0/24', real)).toBe(false);
    expect(insideCloudflare('104.0.0.0/8', real)).toBe(false);        // contains CF, is not inside it
    expect(insideCloudflare('2606:4700:10::/48', real)).toBe(true);
    expect(insideCloudflare('2a01:4f8::/29', real)).toBe(false);
    expect(insideCloudflare('garbage', cf)).toBe(false);
  });

  test('the ad gate reads the env override, else its own copy, else ButrAuth\'s', () => {
    expect(pickRangesPath({ env: '/x.json', exists: () => true })).toBe('/x.json');
    expect(pickRangesPath({ env: '', exists: (p) => p === LOCAL_RANGES_PATH })).toBe(LOCAL_RANGES_PATH);
    expect(pickRangesPath({ env: '', exists: () => false })).toBe(LEGACY_RANGES_PATH);
    expect(LOCAL_RANGES_PATH).toBe(path.join(__dirname, '..', '..', 'data', 'datacenter-ranges.json'));
    expect(LEGACY_RANGES_PATH).toMatch(/\/butrauth\/backend\/data\/datacenter-ranges\.json$/);
  });
});
