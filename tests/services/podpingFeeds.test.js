/**
 * Podping (services/podpingFeeds.js): a channel feed that gained an item is
 * announced once through the local hivepinger, only while hivepinger is healthy,
 * never for banned or hidden channels, and a failed ping is retried. Hivepinger
 * is a local stub server; the items live in the real test MongoDB.
 */
const { ObjectId } = require('mongodb');
const testDb = require('../helpers/db');
const { stubServer, json, text, HOUR } = require('./_fixtures');

const db = testDb.use();
const col = (name) => db().collection(name);

let pinger;
let healthy;
let failFor; // owners whose ping hivepinger refuses
let podping;

beforeAll(async () => {
  pinger = await stubServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/health') return healthy ? json(res, 200, { ok: true }) : text(res, 503, 'no key');
    if (u.pathname === '/podping/') {
      const owner = (u.searchParams.get('url').match(/rss\/(.+)\.xml$/) || [])[1];
      return failFor.has(owner) ? text(res, 500, 'nope') : text(res, 200, 'queued');
    }
    return text(res, 404, '');
  });
  process.env.PODPING_URL = `${pinger.url}/`;
  podping = require('../../services/podpingFeeds');
});

afterAll(async () => {
  delete process.env.PODPING_URL;
  await pinger.close();
});

beforeEach(() => {
  healthy = true;
  failFor = new Set();
  pinger.requests.length = 0;
  delete process.env.PODPING_ENABLED;
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

const pings = () => pinger.requests
  .filter((r) => r.url.startsWith('/podping/'))
  .map((r) => Object.fromEntries(new URL(r.url, 'http://x').searchParams));
const pingedFeeds = () => pings().map((p) => p.url).sort();

const oidHoursAgo = (h) => ObjectId.createFromTime(Math.floor((Date.now() - h * HOUR) / 1000));
const video = (author, permlink, extra = {}) => ({
  _id: new ObjectId(), owner: author, hive_author: author, hive_permlink: permlink,
  status: 'published', short: false, listed_on_3speak: true, ...extra,
});
const audio = (owner, permlink, extra = {}) => ({ _id: new ObjectId(), owner, post_permlink: permlink, ...extra });

describe('announcing new feed items', () => {
  test('a new video pings its channel feed as an update of a video-medium feed', async () => {
    await col('embed-video').insertOne(video('alice', 'first'));

    await podping.runOnce();

    expect(pings()).toEqual([{ url: 'https://3speak.tv/rss/alice.xml', reason: 'update', medium: 'video' }]);
    const sent = await col('podping_sent').findOne({ _id: 'v:alice/first' });
    expect(sent).toMatchObject({ owner: 'alice' });
    expect(sent.sentAt).toBeInstanceOf(Date);
  });

  test('a new audio post pings its owner feed too', async () => {
    await col('embed-audio').insertOne(audio('bob', 'song'));
    await podping.runOnce();
    expect(pingedFeeds()).toEqual(['https://3speak.tv/rss/bob.xml']);
    expect(await col('podping_sent').countDocuments({ _id: 'a:bob/song' })).toBe(1);
  });

  test('several new items of one channel are a single ping, each item remembered', async () => {
    await col('embed-video').insertMany([video('carol', 'one'), video('carol', 'two')]);
    await col('embed-audio').insertOne(audio('carol', 'three'));

    await podping.runOnce();

    expect(pingedFeeds()).toEqual(['https://3speak.tv/rss/carol.xml']);
    expect(await col('podping_sent').countDocuments({ owner: 'carol' })).toBe(3);
  });

  test('running again pings nothing more: each item is announced once', async () => {
    await col('embed-video').insertOne(video('dan', 'once'));
    await podping.runOnce();
    pinger.requests.length = 0;

    await podping.runOnce();

    expect(pings()).toEqual([]);
    expect(await col('podping_sent').countDocuments()).toBe(1);
  });

  test('a later item of an already announced channel is pinged again', async () => {
    await col('embed-video').insertOne(video('erin', 'a'));
    await podping.runOnce();
    await col('embed-video').insertOne(video('erin', 'b'));
    pinger.requests.length = 0;

    await podping.runOnce();

    expect(pingedFeeds()).toEqual(['https://3speak.tv/rss/erin.xml']);
  });
});

describe('what is not a feed change', () => {
  test.each([
    ['a short', video('fay', 'p', { short: true })],
    ['an unlisted video', video('fay', 'p', { listed_on_3speak: false })],
    ['a video not on Hive yet', video('fay', 'p', { hive_permlink: null })],
    ['a video still encoding', video('fay', 'p', { status: 'encoding_ipfs' })],
    ['an upload older than the 48-hour window', video('fay', 'p', { _id: oidHoursAgo(49) })],
    ['an owner that is not a Hive name', video('Not A Name!', 'p')],
  ])('%s is not pinged', async (_name, doc) => {
    await col('embed-video').insertOne(doc);
    await podping.runOnce();
    expect(pings()).toEqual([]);
    expect(await col('podping_sent').countDocuments()).toBe(0);
  });

  test('audio without a Hive post is not pinged', async () => {
    await col('embed-audio').insertOne(audio('gus', null));
    await podping.runOnce();
    expect(pings()).toEqual([]);
  });

  test.each([['banned'], ['hidden']])('a %s channel is not announced, but its items are remembered', async (flag) => {
    await col('contentcreators').insertOne({ username: 'hank', [flag]: true });
    await col('embed-video').insertMany([video('hank', 'x'), video('ivy', 'y')]);

    await podping.runOnce();

    expect(pingedFeeds()).toEqual(['https://3speak.tv/rss/ivy.xml']);
    expect(await col('podping_sent').countDocuments({ owner: 'hank' })).toBe(1);
  });
});

describe('hivepinger outages', () => {
  test('while /health fails nothing is pinged or remembered', async () => {
    healthy = false;
    await col('embed-video').insertOne(video('jack', 'p'));

    await podping.runOnce();

    expect(pings()).toEqual([]);
    expect(await col('podping_sent').countDocuments()).toBe(0);
  });

  test('a refused ping is not remembered, so the next run retries it', async () => {
    failFor = new Set(['kim']);
    await col('embed-video').insertMany([video('kim', 'p'), video('lee', 'q')]);

    await podping.runOnce();
    expect(await col('podping_sent').distinct('owner')).toEqual(['lee']);

    failFor = new Set();
    pinger.requests.length = 0;
    await podping.runOnce();

    expect(pingedFeeds()).toEqual(['https://3speak.tv/rss/kim.xml']);
    expect(await col('podping_sent').countDocuments()).toBe(2);
  });

  test('hivepinger coming back after an outage resumes pinging', async () => {
    await col('embed-video').insertOne(video('mia', 'p'));
    healthy = false;
    await podping.runOnce();
    healthy = true;
    await podping.runOnce();
    expect(pingedFeeds()).toEqual(['https://3speak.tv/rss/mia.xml']);
  });

  test('an unreachable hivepinger counts as down, quietly', async () => {
    // A port that was just closed: the connection is refused at once.
    const gone = await stubServer();
    await gone.close();
    const isolated = loadWith({ PODPING_URL: gone.url });
    await col('embed-video').insertOne(video('ned', 'p'));
    const err = jest.spyOn(console, 'error');

    await isolated.runOnce();

    expect(err).not.toHaveBeenCalled();
    expect(await col('podping_sent').countDocuments()).toBe(0);
  });
});

describe('switches and bookkeeping', () => {
  test('PODPING_ENABLED=false turns the job off, read on every run', async () => {
    await col('embed-video').insertOne(video('olga', 'p'));
    process.env.PODPING_ENABLED = 'false';
    expect(podping.enabled()).toBe(false);

    await podping.runOnce();

    expect(pinger.requests).toEqual([]);
    delete process.env.PODPING_ENABLED;
    expect(podping.enabled()).toBe(true);
  });

  test('two overlapping runs do the work once', async () => {
    await col('embed-video').insertOne(video('pat', 'p'));
    await Promise.all([podping.runOnce(), podping.runOnce()]);
    expect(pingedFeeds()).toEqual(['https://3speak.tv/rss/pat.xml']);
  });

  test('the sent log expires after the window plus a day', async () => {
    await col('embed-video').insertOne(video('quinn', 'p'));
    await podping.runOnce();
    const ttl = (await col('podping_sent').indexes()).find((i) => i.key.sentAt === 1);
    expect(ttl.expireAfterSeconds).toBe((48 + 24) * 3600);
  });

  test('a database failure is logged, not thrown, and the next run still works', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    // A fresh copy ensures its TTL index first; an existing index on the same
    // field with other options makes that fail for real.
    await col('podping_sent').dropIndexes().catch(() => {});
    await col('podping_sent').createIndex({ sentAt: 1 }, { expireAfterSeconds: 1 });
    const fresh = loadWith({ PODPING_URL: pinger.url });
    await col('embed-video').insertOne(video('rae', 'p'));

    await expect(fresh.runOnce()).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith('[podping] run:', expect.stringMatching(/index|expireAfterSeconds/i));
    expect(pings()).toEqual([]);

    await col('podping_sent').dropIndexes();
    await fresh.runOnce();
    expect(pingedFeeds()).toEqual(['https://3speak.tv/rss/rae.xml']);
  });

  test('the run interval defaults to five minutes', () => {
    expect(podping.INTERVAL_MIN).toBe(5);
  });
});

// A fresh copy of the service read with extra environment, sharing this file's
// connected utils/db (an isolated registry would otherwise get an unconnected one).
function loadWith(env) {
  const sharedDb = require('../../utils/db');
  let mod;
  jest.isolateModules(() => {
    const saved = {};
    for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
    try {
      jest.doMock('../../utils/db', () => sharedDb);
      mod = require('../../services/podpingFeeds');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
  return mod;
}
