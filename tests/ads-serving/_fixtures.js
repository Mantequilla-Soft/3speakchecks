/**
 * Shared fixtures for the ad-serving suite (tests/ads-serving).
 *
 * What lives here:
 *   - useAdEnv(): one known ad configuration per test file, set BEFORE any app module
 *     is required, because utils/config.js reads the environment once at require time.
 *   - freezeTime(): a fixed clock for Date only. Real timers keep running, so the
 *     MongoDB driver and supertest behave normally. The fixed instant is in the
 *     future on purpose: ad sessions carry a TTL index, and a document that expires
 *     "in the past" would be swept away by mongod halfway through a test.
 *   - builders for advertisers, creatives and campaigns, and seed() to insert them.
 *   - HLS playlist builders and a fake CDN (global fetch), so manifests are real text
 *     without any network.
 *   - fake media tools: tiny shell scripts standing in for piper, ffmpeg and ffprobe,
 *     and an execFile stand-in for modules that call the binaries by bare name.
 *   - loadIsolated(): a fresh copy of a module with its own environment and mocks,
 *     for configuration that is only read at require time.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const { ObjectId } = require('mongodb');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = new Date('2030-06-03T12:00:00.000Z');

/* ─── environment ────────────────────────────────────────────────────── */

let tmpRoot = null;
function scratchDir() {
  if (!tmpRoot) {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `checker-ads-${process.env.JEST_WORKER_ID || 1}-`));
  }
  return tmpRoot;
}

/**
 * The baseline every file in this folder starts from. Chosen so that nothing hides
 * behind a trial list: every creator carries ads, the stage is public, caps that are
 * keyed on the caller's address are out of the way unless a test asks for them.
 */
function baseEnv() {
  const root = scratchDir();
  const ranges = path.join(root, 'datacenter-ranges.json');
  // 203.0.113.0/24 (TEST-NET-3) plays the part of a hosting provider.
  fs.writeFileSync(ranges, JSON.stringify({ ranges: [{ cidr: '203.0.113.0/24', provider: 'test-cloud' }] }));
  return {
    ADS_STAGE: 'public',
    ADS_ALLOWED_OWNERS: '',
    ADS_BETA_USERS: 'betauser,meno',
    AD_SELFPROMO_ENABLED: 'true',
    AD_SELFPROMO_ALLOWED_OWNERS: '',
    AD_TICKER_ALLOWED_OWNERS: '',
    AD_AUDIO_TICKER_ALLOWED_OWNERS: '',
    AD_GATE_ALLOWED_UPLOADERS: '',
    AD_PREMIUM_OVERRIDE_ACCOUNTS: '',
    AD_SELF_VIEW_ALLOWED_ACCOUNTS: '',
    AD_IP_CAP_EXEMPT_OWNERS: '',
    AD_SESSION_RATE_PER_MIN: '1000',
    AD_COOLDOWN_MINUTES: '0',
    AD_AUDIO_NORMALISE: 'false',
    AD_DATACENTER_RANGES_PATH: ranges,
    AD_BURN_CACHE_DIR: path.join(root, 'burn'),
    AD_TTS_DIR: path.join(root, 'tts'),
    HIVE_AUTH_REQUIRED: 'true',
    ENABLE_MONGO_WRITES: 'true',
  };
}

// Variables a developer's shell might carry that would change what these tests see.
const ALWAYS_UNSET = ['AD_CDN_GATEWAY', 'AD_SELFPROMO_RATE_HBD', 'AD_LANDSCAPE_ON_PORTRAIT', 'AD_GAIN_DB',
  'AD_ELIGIBILITY_TTL_MS', 'AD_SHORTS_IGNORE_REPEAT_CAP', 'AD_LIVE_ROLL_SLOT_PERCENTS', 'AD_SLOT_PERCENTS'];

/** Set the ad configuration for this test file. Call at the top, before any require. */
function useAdEnv(overrides = {}) {
  for (const k of ALWAYS_UNSET) delete process.env[k];
  const env = { ...baseEnv(), ...overrides };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || v === null) delete process.env[k];
    else process.env[k] = String(v);
  }
  fs.mkdirSync(env.AD_BURN_CACHE_DIR || path.join(scratchDir(), 'burn'), { recursive: true });
  fs.mkdirSync(env.AD_TTS_DIR || path.join(scratchDir(), 'tts'), { recursive: true });
  afterAll(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  });
  return env;
}

/**
 * A fresh copy of `modPath` with its own environment and module mocks, without
 * disturbing the copy the rest of the file uses. Paths are relative to this folder.
 */
function loadIsolated(modPath, { env = {}, mocks = {} } = {}) {
  const saved = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || v === null) delete process.env[k];
    else process.env[k] = String(v);
  }
  let mod;
  try {
    jest.isolateModules(() => {
      for (const [p, factory] of Object.entries(mocks)) jest.doMock(p, factory);
      mod = require(modPath);
    });
  } finally {
    for (const p of Object.keys(mocks)) jest.dontMock(p);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return mod;
}

/**
 * A fresh copy of a route module (or anything that reads config at require time)
 * under a different environment, still talking to this file's test database.
 */
function isolatedModule(modPath, env = {}, mocks = {}) {
  const mainDb = require('../../utils/db');
  return loadIsolated(modPath, {
    env,
    mocks: { '../../utils/db': () => ({ ...mainDb, getDb: () => mainDb.getDb() }), ...mocks },
  });
}

/**
 * Make every query fail, to exercise a route's 500 path. Index builds still go
 * through, so the app's own background index work (started on connect) is not
 * caught up in it.
 */
function databaseFails(message = 'database unavailable') {
  const live = require('../../utils/db').getDb();
  const original = live.collection.bind(live);
  jest.spyOn(console, 'error').mockImplementation(() => {});
  return jest.spyOn(live, 'collection').mockImplementation((name) => new Proxy(original(name), {
    get(target, prop) {
      if (prop === 'createIndex' || prop === 'indexes' || prop === 'dropIndex') return target[prop].bind(target);
      throw new Error(message);
    },
  }));
}

/* ─── time ───────────────────────────────────────────────────────────── */

const NOT_DATE = ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate',
  'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'];

/** Freeze Date (only Date) at `at`. Real timers keep running. */
function freezeTime(at = NOW) {
  jest.useFakeTimers({ doNotFake: NOT_DATE, now: new Date(at) });
}
const advance = (ms) => jest.setSystemTime(Date.now() + ms);
const ago = (ms) => new Date(Date.now() - ms);
const fromNow = (ms) => new Date(Date.now() + ms);

/* ─── advertisers, creatives, campaigns ──────────────────────────────── */

let counter = 0;
const uid = (prefix = 'x') => `${prefix}${(counter += 1).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function advertiser(over = {}) {
  return {
    _id: new ObjectId(),
    reference: uid('ref'),
    hiveAccount: 'acme',
    projectName: 'Acme Widgets',
    website: 'https://acme.example/',
    logoUrl: 'https://acme.example/logo.png',
    slogan: 'Widgets for everyone',
    status: 'approved',
    createdAt: ago(10 * DAY),
    ...over,
  };
}

const CID = (tag) => `Qm${String(tag).padEnd(44, 'x').slice(0, 44)}`;

function videoCreative(over = {}) {
  const embedId = over.embedId || uid('vid');
  return {
    _id: new ObjectId(),
    embedId,
    kind: 'video',
    status: 'ready',
    manifestCid: CID(embedId),
    durationSeconds: 12,
    owner: 'acme',
    permlink: embedId,
    createdAt: ago(5 * DAY),
    ...over,
  };
}

function imageCreative(over = {}) {
  const url = over.imageUrl || `https://acme.example/${uid('banner')}.png`;
  return {
    _id: new ObjectId(),
    embedId: `img:${url}`,
    kind: 'image',
    status: 'ready',
    imageUrl: url,
    imageWidth: 1456,
    imageHeight: 240,
    durationSeconds: 0,
    manifestCid: null,
    createdAt: ago(5 * DAY),
    ...over,
  };
}

function textCreative(over = {}) {
  return {
    _id: new ObjectId(),
    embedId: `txt:${uid('t')}`,
    kind: 'text',
    status: 'ready',
    message: 'Try Acme widgets today',
    clickUrl: 'https://acme.example/go?x=1',
    style: 'crawl',
    durationSeconds: 0,
    createdAt: ago(5 * DAY),
    ...over,
  };
}

function audioCreative(over = {}) {
  return {
    _id: new ObjectId(),
    embedId: `aud:${uid('a')}`,
    kind: 'audio',
    status: 'ready',
    audioFile: `${'a'.repeat(40)}.mp3`,
    clickUrl: 'https://acme.example/listen',
    durationSeconds: 8,
    createdAt: ago(5 * DAY),
    ...over,
  };
}

/** A paid, running flight unless told otherwise. */
function campaign(over = {}) {
  return {
    _id: new ObjectId(),
    advertiserRef: over.advertiserRef || 'ref-missing',
    hiveAccount: 'acme',
    projectName: 'Acme Widgets',
    name: 'Acme spring flight',
    format: 'video_roll',
    status: 'running',
    slotPercent: 0,
    spotSeconds: 12,
    days: 7,
    paidHbd: 10,
    priceHbd: 10,
    startAt: ago(DAY),
    endAt: fromNow(6 * DAY),
    deliveredImpressions: 0,
    markets: [],
    createdAt: ago(2 * DAY),
    ...over,
  };
}

/** Insert whatever is given ({ advertisers, creatives, campaigns, ... }) into the db. */
async function seed(db, { advertisers = [], creatives = [], campaigns = [], ...rest } = {}) {
  const { ADVERTISERS_COLLECTION, AD_CREATIVES_COLLECTION, AD_CAMPAIGNS_COLLECTION } = require('../../utils/config');
  if (advertisers.length) await db.collection(ADVERTISERS_COLLECTION).insertMany(advertisers);
  if (creatives.length) await db.collection(AD_CREATIVES_COLLECTION).insertMany(creatives);
  if (campaigns.length) await db.collection(AD_CAMPAIGNS_COLLECTION).insertMany(campaigns);
  for (const [coll, rows] of Object.entries(rest)) {
    if (rows && rows.length) await db.collection(coll).insertMany(rows);
  }
}

/**
 * One bookable placement end to end: an approved advertiser, a ready creative of the
 * right kind for the format, and a paid running flight pointing at it.
 */
function placement({ format = 'video_roll', advertiser: advOver = {}, creative: crOver = {}, campaign: cOver = {} } = {}) {
  const adv = advertiser(advOver);
  const make = {
    video_roll: videoCreative,
    shorts_roll: videoCreative,
    upload_gate: videoCreative,
    video_banner: imageCreative,
    video_ticker: textCreative,
    audio_spot: audioCreative,
  }[format] || videoCreative;
  const cr = make({ advertiserRef: adv.reference, ...crOver });
  const camp = campaign({
    format,
    advertiserRef: adv.reference,
    hiveAccount: adv.hiveAccount,
    projectName: adv.projectName,
    creativeEmbedId: cr.embedId,
    ...cOver,
  });
  return { advertiser: adv, creative: cr, campaign: camp, all: { advertisers: [adv], creatives: [cr], campaigns: [camp] } };
}

/** Merge several placements into one seed() argument. */
const together = (...ps) => ({
  advertisers: ps.flatMap((p) => p.all.advertisers),
  creatives: ps.flatMap((p) => p.all.creatives),
  campaigns: ps.flatMap((p) => p.all.campaigns),
});

/* ─── HLS ────────────────────────────────────────────────────────────── */

const GATEWAY = 'https://ipfs-3speak.b-cdn.net';
const contentManifest = (cid = 'QmContentVideo') => `${GATEWAY}/ipfs/${cid}/manifest.m3u8`;

/** A VOD media playlist of `durations` segments, relative URIs seg0.ts, seg1.ts ... */
function mediaPlaylist(durations, { prefix = 'seg' } = {}) {
  const target = Math.ceil(Math.max(...durations, 1));
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${target}`, '#EXT-X-MEDIA-SEQUENCE:0'];
  durations.forEach((d, i) => { lines.push(`#EXTINF:${d.toFixed(3)},`, `${prefix}${i}.ts`); });
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n');
}

/** A master playlist. `variants` = [{ bw, uri, res }]. */
function masterPlaylist(variants) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  for (const v of variants) {
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${v.bw},RESOLUTION=${v.res || '854x480'}`, v.uri);
  }
  return lines.join('\n');
}

/**
 * Stand in for the CDN. `routes` maps a full URL to a playlist string, to
 * { status, body }, or to a function (url) => either. Anything else is a 404.
 * Returns the list of URLs that were asked for.
 */
function fakeCdn(routes = {}) {
  const seen = [];
  jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
    const url = String(input && input.url ? input.url : input);
    seen.push(url);
    let hit = routes[url];
    if (typeof hit === 'function') hit = await hit(url);
    if (hit === undefined) return new Response('not found', { status: 404 });
    if (typeof hit === 'string' || Buffer.isBuffer(hit)) return new Response(hit, { status: 200 });
    return new Response(hit.body ?? '', { status: hit.status ?? 200 });
  });
  return seen;
}

/* ─── fake media tools ───────────────────────────────────────────────── */

/**
 * Shell scripts standing in for piper, ffmpeg and ffprobe, for the modules that are
 * told where the binaries are (utils/adTts.js, utils/adAudioSpot.js). Their behaviour
 * comes from a state file the test writes with set(); every call is logged so a test
 * can see what was run and with which arguments.
 *
 * A child process does not see process.env changes made inside a test file, so the
 * scripts carry the absolute path of their state file and log rather than reading
 * them from the environment.
 */
function fakeMediaTools() {
  const dir = path.join(scratchDir(), 'bin');
  fs.mkdirSync(dir, { recursive: true });
  const state = path.join(dir, 'state.sh');
  const log = path.join(dir, 'calls.log');
  const voice = path.join(dir, 'en_GB-test-voice.onnx');
  fs.writeFileSync(voice, 'voice');

  const header = `#!/bin/sh\n. "${state}"\n`;
  const lastArg = 'for a in "$@"; do last="$a"; done\n';
  const scripts = {
    piper: `${header}echo "piper $*" >> "${log}"\ncat > /dev/null\n`
      + 'if [ -n "$PIPER_DELAY" ]; then sleep "$PIPER_DELAY"; fi\n'
      + 'if [ "$PIPER_FAIL" = "1" ]; then echo "piper exploded" >&2; exit 3; fi\n'
      + 'out=""; prev=""; for a in "$@"; do if [ "$prev" = "--output_file" ]; then out="$a"; fi; prev="$a"; done\n'
      + 'printf "RIFFfakeWAVE" > "$out"\n',
    ffmpeg: `${header}echo "ffmpeg $*" >> "${log}"\n`
      + 'if [ "$FFMPEG_FAIL" = "1" ]; then echo "ffmpeg exploded" >&2; exit 1; fi\n'
      + `${lastArg}printf "ID3fake-%s" "$FFMPEG_TAG" > "$last"\n`,
    ffprobe: `${header}echo "ffprobe $*" >> "${log}"\n`
      + 'if [ "$FFPROBE_FAIL" = "1" ]; then echo "ffprobe exploded" >&2; exit 1; fi\n'
      + 'case "$*" in *print_format*) printf "%s" "$PROBE_JSON" ;; *) printf "%s\\n" "$PROBE_DURATION" ;; esac\n',
  };
  for (const [name, body] of Object.entries(scripts)) {
    fs.writeFileSync(path.join(dir, name), body);
    fs.chmodSync(path.join(dir, name), 0o755);
  }

  const defaults = {
    PIPER_FAIL: '0', PIPER_DELAY: '', FFMPEG_FAIL: '0', FFPROBE_FAIL: '0', FFMPEG_TAG: 'one', PROBE_DURATION: '6.4',
    PROBE_JSON: JSON.stringify({ streams: [{ codec_type: 'audio', channels: 2 }], format: { duration: '9.5' } }),
  };
  const set = (over = {}) => {
    const s = { ...defaults, ...over };
    fs.writeFileSync(state, Object.entries(s)
      .map(([k, v]) => `${k}='${String(v).replace(/'/g, "'\\''")}'`).join('\n'));
    fs.writeFileSync(log, '');
  };
  set();
  const calls = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);

  return {
    dir,
    env: {
      AD_TTS_PIPER_BIN: path.join(dir, 'piper'),
      AD_TTS_VOICE: voice,
      AD_TTS_FFMPEG: path.join(dir, 'ffmpeg'),
      AD_TTS_FFPROBE: path.join(dir, 'ffprobe'),
    },
    set,
    calls,
  };
}

/**
 * An execFile stand-in for `jest.mock('child_process', ...)`, for the modules that
 * run ffprobe and ffmpeg by bare name. Nothing real is ever spawned: a test sets a
 * handler (cmd, args) => stdout string | Promise, or throws to make the tool fail.
 *
 *   jest.mock('child_process', () => require('./_fixtures').childProcessMock());
 *   const { execFile } = require('child_process');
 *   execFile.setHandler((cmd, args) => ...);
 */
function childProcessMock() {
  const actual = jest.requireActual('child_process');
  let handler = (cmd) => { throw new Error(`[tests] no fake for ${cmd}`); };
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, args]);
    return String((await handler(cmd, args)) ?? '');
  };
  function execFile(cmd, args, opts, cb) {
    const done = typeof opts === 'function' ? opts : cb;
    run(cmd, args).then((stdout) => done && done(null, stdout, ''), (err) => done && done(err, '', String(err.message)));
    return { stdin: { end() {} } };
  }
  execFile[util.promisify.custom] = (cmd, args) => run(cmd, args).then((stdout) => ({ stdout, stderr: '' }));
  execFile.setHandler = (fn) => { handler = fn; };
  execFile.calls = calls;
  execFile.reset = () => {
    calls.length = 0;
    handler = (cmd) => { throw new Error(`[tests] no fake for ${cmd}`); };
  };
  return { ...actual, execFile };
}

/**
 * For writes the code deliberately does not wait for (fire-and-forget caches): retry
 * a read until it holds. Each try is a real round trip, so no fixed delay is needed.
 */
// Polls until `check` returns something truthy, for writes the code under test
// deliberately does not wait for. Bounded by wall time, not by a number of ticks:
// on a busy machine (the whole suite in parallel) a background write can take
// many event-loop turns. performance.now, because these tests fake Date.
const { performance } = require('perf_hooks');
async function eventually(check, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs;
  let last;
  for (;;) {
    last = await check();
    if (last || performance.now() > deadline) return last;
    await new Promise((r) => setTimeout(r, 5));
  }
}

/* ─── requests ───────────────────────────────────────────────────────── */

let ipCounter = 0;
/** A fresh caller address on its own /24 every time, so per-network caps never collide. */
function freshIp() {
  ipCounter += 1;
  return `10.${(ipCounter >> 8) & 255}.${ipCounter & 255}.7`;
}

const adminHeader = () => ({ Authorization: `Bearer ${process.env.AD_ADMIN_SECRET}` });

/** The path (and query) of an absolute URL the app handed back, for supertest. */
const pathOf = (url) => { const u = new URL(url); return `${u.pathname}${u.search}`; };
const sidOf = (url) => (/\/m\/([0-9a-f]{32})/.exec(String(url)) || [])[1] || null;

module.exports = {
  MIN, HOUR, DAY, NOW, CID, GATEWAY,
  useAdEnv, loadIsolated, isolatedModule, databaseFails, scratchDir,
  freezeTime, advance, ago, fromNow,
  uid, advertiser, videoCreative, imageCreative, textCreative, audioCreative, campaign, seed, placement, together,
  contentManifest, mediaPlaylist, masterPlaylist, fakeCdn,
  fakeMediaTools, childProcessMock, eventually,
  freshIp, adminHeader, pathOf, sidOf,
};
