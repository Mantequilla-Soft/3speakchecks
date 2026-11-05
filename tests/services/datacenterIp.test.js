/**
 * utils/datacenterIp.js: is an address inside a known datacenter / hosting range?
 *
 * The ad server answers such requests with no ad. The ranges come from a JSON file
 * that another service rewrites nightly; the module re-reads it when its mtime
 * changes (checked at most every 10 minutes) and FAILS OPEN: no file, a broken file
 * or an empty file never turns every visitor into a bot.
 *
 * Each test loads a fresh copy of the module against its own ranges file in a
 * temporary directory, with Date.now pinned so the 10-minute recheck is exact.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const T0 = Date.parse('2026-11-01T12:00:00Z');
const TEN_MIN = 10 * 60 * 1000;

let dir;
let file;
let now;

beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcip-')); });
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  file = path.join(dir, `ranges-${Math.random().toString(36).slice(2)}.json`);
  now = T0;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.AD_DATACENTER_RANGES_PATH;
  delete process.env.AD_BLOCK_DATACENTER_IPS;
});

const writeRanges = (ranges, mtimeMs) => {
  fs.writeFileSync(file, JSON.stringify({ ranges }));
  if (mtimeMs) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
};

function load(env = {}) {
  process.env.AD_DATACENTER_RANGES_PATH = file;
  Object.assign(process.env, env);
  let mod;
  jest.isolateModules(() => { mod = require('../../utils/datacenterIp'); });
  return mod;
}

const RANGES = [
  { cidr: '16.216.88.0/23', provider: 'aws' },       // where Reflectionbot ran from
  { cidr: '34.64.0.0/10', provider: 'gcp' },
  { cidr: '34.80.0.0/16', provider: 'gcp-asia' },    // nested inside the /10 above
  '51.15.0.0/16',                                    // a bare string: provider unknown
  { cidr: '203.0.113.7', provider: 'single' },       // no prefix = /32
  { cidr: '2600:1f00::/24', provider: 'aws' },
  { cidr: '2a01:4f8::/29', provider: 'hetzner' },
];

describe('which addresses are datacenter addresses', () => {
  beforeEach(() => writeRanges(RANGES));

  test.each([
    ['16.216.88.0', 'aws', 'first address of a range'],
    ['16.216.89.255', 'aws', 'last address of a /23'],
    ['34.80.12.1', 'gcp', 'inside a range nested in a bigger one (coalesced)'],
    ['34.127.255.255', 'gcp', 'end of the /10'],
    ['51.15.200.3', 'unknown', 'a bare-string entry'],
    ['203.0.113.7', 'single', 'a single-address entry'],
    ['::ffff:16.216.88.10', 'aws', 'an IPv4-mapped IPv6 form'],
    ['2600:1f00::1', 'aws', 'IPv6 inside a /24'],
    ['2a01:4f8:c17:1234::1', 'hetzner', 'IPv6, abbreviated groups'],
    ['2A01:04F8:0000:0000:0000:0000:0000:0001', 'hetzner', 'IPv6, full and upper case'],
    ['2a01:4f8::1%eth0', 'hetzner', 'IPv6 with a zone id'],
  ])('%s is a datacenter address (%s, %s)', (ip, provider) => {
    const { lookupIp, isDatacenterIp } = load();
    expect(lookupIp(ip)).toEqual({ datacenter: true, provider });
    expect(isDatacenterIp(ip)).toBe(true);
  });

  test.each([
    ['16.216.87.255', 'one below a range'],
    ['16.216.90.0', 'one above a range'],
    ['34.128.0.0', 'just past the /10'],
    ['203.0.113.8', 'next to a single address'],
    ['8.8.8.8', 'nowhere near a range'],
    ['2600:1e00::1', 'IPv6 just below a range'],
    ['2a01:500::1', 'IPv6 elsewhere'],
  ])('%s is a normal visitor (%s)', (ip) => {
    const { lookupIp } = load();
    expect(lookupIp(ip)).toEqual({ datacenter: false, provider: null });
  });

  test.each([
    [''], [null], [undefined], [42], ['not-an-ip'], ['256.1.1.1'], ['1.2.3'],
    ['2600:1f00:::1'], ['2600::1f00::1'], ['2600:1f00:zzzz::1'], ['1:2:3:4:5:6:7:8:9'], ['2600:1f00:'],
    ['::ffff:999.1.1.1'],
  ])('garbage input %p is never a datacenter address', (ip) => {
    const { lookupIp } = load();
    expect(lookupIp(ip)).toEqual({ datacenter: false, provider: null });
  });
});

describe('malformed ranges in the file', () => {
  test('bad entries are skipped and the good ones still apply', () => {
    writeRanges([
      { cidr: '1.2.3.0/33' }, { cidr: '1.2.3.0/x' }, { cidr: '999.0.0.0/8' }, {},
      { cidr: '2600::/129' }, { cidr: 'zz::/16' }, { provider: 'no-cidr' },
      { cidr: '45.33.0.0/17', provider: 'linode' },
    ]);
    const { lookupIp } = load();
    expect(lookupIp('45.33.1.1')).toEqual({ datacenter: true, provider: 'linode' });
    expect(lookupIp('1.2.3.4').datacenter).toBe(false);
  });

  test('an IPv4-only file answers IPv6 addresses as clean, and the other way round', () => {
    writeRanges([{ cidr: '45.33.0.0/17', provider: 'linode' }]);
    expect(load().lookupIp('2600:1f00::1').datacenter).toBe(false);
    writeRanges([{ cidr: '2600:1f00::/24', provider: 'aws' }]);
    expect(load().lookupIp('45.33.1.1').datacenter).toBe(false);
  });

  test('a /0 covers everything of its family', () => {
    writeRanges([{ cidr: '0.0.0.0/0', provider: 'all' }]);
    expect(load().lookupIp('8.8.8.8')).toEqual({ datacenter: true, provider: 'all' });
  });
});

describe('failing open', () => {
  test('no file at all: every address is clean, with a single warning', () => {
    const { lookupIp } = load();
    expect(lookupIp('16.216.88.1').datacenter).toBe(false);
    expect(lookupIp('16.216.88.2').datacenter).toBe(false);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['broken JSON', '{"ranges": ['],
    ['no ranges key', '{}'],
    ['only bad entries', JSON.stringify({ ranges: ['nope', { cidr: '1.2.3.4/99' }] })],
  ])('%s: every address is clean', (_label, contents) => {
    fs.writeFileSync(file, contents);
    expect(load().lookupIp('16.216.88.1').datacenter).toBe(false);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  test('AD_BLOCK_DATACENTER_IPS=false switches the check off entirely', () => {
    writeRanges(RANGES);
    const { lookupIp } = load({ AD_BLOCK_DATACENTER_IPS: 'false' });
    expect(lookupIp('16.216.88.1')).toEqual({ datacenter: false, provider: null });
  });
});

describe('the nightly refresh', () => {
  test('a rewritten file is picked up after the 10-minute recheck, not before', () => {
    writeRanges([{ cidr: '16.216.88.0/23', provider: 'aws' }], T0 - 1000);
    const { lookupIp } = load();
    expect(lookupIp('45.33.1.1').datacenter).toBe(false);

    writeRanges([{ cidr: '45.33.0.0/17', provider: 'linode' }], T0 + 1000);
    now = T0 + TEN_MIN - 1;
    expect(lookupIp('45.33.1.1').datacenter).toBe(false); // not rechecked yet
    now = T0 + TEN_MIN;
    expect(lookupIp('45.33.1.1')).toEqual({ datacenter: true, provider: 'linode' });
    expect(lookupIp('16.216.88.1').datacenter).toBe(false); // the old set is gone
  });

  test('an unchanged mtime is not re-read', () => {
    writeRanges(RANGES, T0 - 1000);
    const { lookupIp } = load();
    lookupIp('8.8.8.8');
    const read = jest.spyOn(fs, 'readFileSync');
    now = T0 + TEN_MIN;
    lookupIp('8.8.8.8');
    expect(read).not.toHaveBeenCalled();
  });

  test('a bad refresh keeps the last good set instead of failing open', () => {
    writeRanges([{ cidr: '16.216.88.0/23', provider: 'aws' }], T0 - 1000);
    const { lookupIp } = load();
    expect(lookupIp('16.216.88.1').datacenter).toBe(true);

    fs.writeFileSync(file, '{"ranges": []}');
    fs.utimesSync(file, (T0 + 1000) / 1000, (T0 + 1000) / 1000);
    now = T0 + TEN_MIN;
    expect(lookupIp('16.216.88.1')).toEqual({ datacenter: true, provider: 'aws' });
  });

  test('a file that appears later is loaded on the next call (no 10-minute wait while empty)', () => {
    const { lookupIp } = load();
    expect(lookupIp('16.216.88.1').datacenter).toBe(false);
    writeRanges([{ cidr: '16.216.88.0/23', provider: 'aws' }]);
    now = T0 + 1;
    expect(lookupIp('16.216.88.1').datacenter).toBe(true);
  });
});
