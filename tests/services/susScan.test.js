/**
 * Suspicious-activity scanner (services/susScan.js): each detector fires on the
 * shape it describes and stays quiet just under its threshold, a finding is
 * alerted once per day, and the Discord webhook (stubbed fetch) gets one embed.
 * The scanner only reads; the one collection it writes is `sus_alerts`.
 */
process.env.SUS_ALERT_WEBHOOK_URL = 'http://127.0.0.1:9/sus-hook';

const { ObjectId } = require('mongodb');
const testDb = require('../helpers/db');
const { NOW, MINUTE, HOUR, DAY, fakeFetch } = require('./_fixtures');
const { runOnce, detect, linksFor, sendWebhook, WINDOW_H, T } = require('../../services/susScan');

const db = testDb.use();

const REAL_TIMERS = ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'];
let realFetch;
beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: REAL_TIMERS });
  realFetch = global.fetch;
  global.fetch = fakeFetch([['http://127.0.0.1:9/sus-hook', () => ({ status: 204, body: '' })]]);
});
afterEach(() => {
  global.fetch = realFetch;
  jest.useRealTimers();
});

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

// Rows are dated by their ObjectId, exactly like the scanner reads them. The time
// is "ms before the (frozen) clock"; a counter keeps the ids unique.
let seq = 0;
const idAgo = (ms) => {
  const base = ObjectId.createFromTime(Math.floor((Date.now() - ms) / 1000)).toHexString();
  seq += 1;
  return new ObjectId(base.slice(0, 16) + seq.toString(16).padStart(8, '0'));
};
const inWindow = () => idAgo(30 * MINUTE);
const inBaseline = (i) => idAgo(WINDOW_H * HOUR + (i % 160) * HOUR + MINUTE);
const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));

const session = (extra = {}) => ({ _id: inWindow(), owner: 'alice', permlink: 'v1', userAgent: CHROME, country: 'DE', watchedPct: 80, ...extra });
const types = (findings) => findings.map((f) => f.type).sort();

describe('the detectors', () => {
  test('crawler_sessions: a crawler family with 3+ sessions, grouped across UA versions', async () => {
    await db().collection('view-durations').insertMany([
      session({ userAgent: GOOGLEBOT }),
      session({ userAgent: GOOGLEBOT.replace('2.1', '2.2'), permlink: 'v2' }),
      session({ userAgent: GOOGLEBOT }),
      session({ userAgent: 'Mozilla/5.0 bingbot/2.0' }),           // only 1: quiet
    ]);
    const findings = await detect(db(), NOW);
    expect(findings).toEqual([expect.objectContaining({ type: 'crawler_sessions', subject: 'Googlebot' })]);
    expect(findings[0].text).toMatch(/3 watch sessions .* on 2 video\(s\)/);
  });

  test('ua_country_burst: one browser + country making most of a video\'s sessions', async () => {
    await db().collection('view-durations').insertMany([
      ...many(T.burstMin, () => session()),
      ...many(5, () => session({ userAgent: FIREFOX, country: 'US' })),
      // Another video: 15 from one browser, but only 50% of its sessions.
      ...many(15, () => session({ permlink: 'mixed' })),
      ...many(15, () => session({ permlink: 'mixed', country: 'FR' })),
    ]);
    const findings = await detect(db(), NOW);
    expect(findings.filter((f) => f.type === 'ua_country_burst')).toEqual([
      expect.objectContaining({ subject: 'alice/v1', video: 'alice/v1', text: expect.stringContaining('Chrome 130 on Windows') }),
    ]);
  });

  test('video_view_spike: far above the video\'s own 7-day rate, but not for a normally busy video', async () => {
    await db().collection('view-durations').insertMany([
      // spiky: 25 now, nothing before.
      ...many(T.spikeMin, (i) => session({ permlink: 'spiky', userAgent: `UA-${i}` })),
      // steady: 25 now, and 25 per 2h window all week (84 windows).
      ...many(T.spikeMin, (i) => session({ permlink: 'steady', userAgent: `UA-${i}` })),
      ...many(25 * 84, (i) => ({ ...session({ permlink: 'steady', userAgent: `UA-${i}` }), _id: inBaseline(i) })),
    ]);
    const spikes = (await detect(db(), NOW)).filter((f) => f.type === 'video_view_spike');
    expect(spikes.map((f) => f.subject)).toEqual(['alice/spiky']);
    expect(spikes[0].text).toMatch(/25 sessions in 2h, usually ~0\.0 \(25x\)/);
  });

  test('repeat_ip_views: one address replaying one video 10+ times', async () => {
    await db().collection('views').insertMany([
      ...many(T.repeatIpMin, () => ({ _id: inWindow(), author: 'alice', permlink: 'v1', ipHash: 'abcdef1234567890', userAgent: FIREFOX })),
      ...many(T.repeatIpMin - 1, () => ({ _id: inWindow(), author: 'alice', permlink: 'v2', ipHash: 'ffff', userAgent: FIREFOX })),
    ]);
    const found = (await detect(db(), NOW)).filter((f) => f.type === 'repeat_ip_views');
    expect(found).toEqual([expect.objectContaining({ subject: 'alice/v1#abcdef12', text: expect.stringContaining('10 views') })]);
  });

  test('ad_impression_spike and ads_without_watching: a creator\'s ads far above normal, with no one watching', async () => {
    await db().collection('ad_impressions').insertMany([
      ...many(T.impSpikeMin, (i) => ({ _id: inWindow(), owner: 'farmer', permlink: 'v1', completed: i < 10 })),
      // A big creator at their usual rate: 30 now, ~30 per window all week.
      ...many(30, () => ({ _id: inWindow(), owner: 'big', permlink: 'b1' })),
      ...many(30 * 84, (i) => ({ _id: inBaseline(i), owner: 'big', permlink: 'b1' })),
    ]);
    // big/b1 was watched enough for its ads; farmer/v1 had one session.
    await db().collection('view-durations').insertMany([
      session({ owner: 'farmer', permlink: 'v1' }),
      ...many(20, (i) => session({ owner: 'big', permlink: 'b1', userAgent: `UA-${i}` })),
    ]);
    const findings = await detect(db(), NOW);
    expect(findings.filter((f) => f.type === 'ad_impression_spike').map((f) => f.subject)).toEqual(['farmer']);
    expect(findings.find((f) => f.type === 'ad_impression_spike').text).toMatch(/30 ad impressions.*\(10 completed\)/);
    expect(findings.filter((f) => f.type === 'ads_without_watching').map((f) => f.subject)).toEqual(['farmer/v1']);
  });

  test('self_view_ads: ads on the viewer\'s own video, except the pre-upload gate', async () => {
    await db().collection('ad_sessions').insertMany([
      ...many(T.selfViewMin, (i) => ({ _id: inWindow(), viewer: 'alice', owner: 'alice', permlink: `v${i % 2}`, surface: 'watch' })),
      ...many(10, () => ({ _id: inWindow(), viewer: 'bob', owner: 'bob', surface: 'upload' })),
      ...many(10, () => ({ _id: inWindow(), viewer: 'carol', owner: 'dave', surface: 'watch' })),
    ]);
    const self = (await detect(db(), NOW)).filter((f) => f.type === 'self_view_ads');
    expect(self).toEqual([expect.objectContaining({ subject: 'alice', text: expect.stringContaining('3 ads on their own videos** (2 video(s))') })]);
  });

  test('upload_gate_farming: many pre-upload ads and few uploads; a real uploader is not flagged', async () => {
    await db().collection('ad_sessions').insertMany([
      ...many(T.gateMin, () => ({ _id: inWindow(), owner: 'farmer', surface: 'upload' })),
      ...many(T.gateMin, () => ({ _id: inWindow(), owner: 'creator', surface: 'upload' })),
    ]);
    await db().collection('embed-video').insertMany([
      { owner: 'farmer', permlink: 'one', createdAt: new Date(NOW - 10 * MINUTE) },
      ...many(3, (i) => ({ owner: 'creator', permlink: `u${i}`, createdAt: new Date(NOW - 10 * MINUTE) })),
      // An old upload does not count for the window.
      { owner: 'farmer', permlink: 'old', createdAt: new Date(NOW - 3 * DAY) },
    ]);
    const gate = (await detect(db(), NOW)).filter((f) => f.type === 'upload_gate_farming');
    expect(gate).toEqual([expect.objectContaining({ subject: 'farmer', text: expect.stringContaining('only 1 upload(s)') })]);
  });

  test('quiet traffic produces no findings', async () => {
    await db().collection('view-durations').insertMany(many(10, (i) => session({ userAgent: `UA-${i}` })));
    await db().collection('ad_impressions').insertMany(many(5, () => ({ _id: inWindow(), owner: 'alice', permlink: 'v1' })));
    expect(await detect(db(), NOW)).toEqual([]);
  });

  test('rows older than the window are not counted as current activity', async () => {
    await db().collection('view-durations').insertMany(many(5, () => ({ ...session({ userAgent: GOOGLEBOT }), _id: idAgo(3 * HOUR) })));
    expect(await detect(db(), NOW)).toEqual([]);
  });
});

describe('watch links', () => {
  test('an embed with a Hive post links to the watch page, anything else to the player embed', async () => {
    await db().collection('embed-video').insertOne({ owner: 'alice', permlink: 'asset1', hive_author: 'alice', hive_permlink: 'my-post' });
    const links = await linksFor(db(), [
      { type: 'x', video: 'alice/asset1' },
      { type: 'x', video: 'bob/legacy' },
      { type: 'x', subject: 'no-video' },
    ]);
    expect(Object.fromEntries(links)).toEqual({
      'alice/asset1': 'https://3speak.tv/watch?v=alice/my-post',
      'bob/legacy': 'https://play.3speak.tv/embed?v=bob/legacy',
    });
  });

  test('no video findings means no lookup', async () => {
    expect((await linksFor(db(), [{ type: 'x', subject: 'y' }])).size).toBe(0);
  });
});

describe('the webhook message', () => {
  test('one embed, red when money is involved, at most 24 fields plus a count of the rest', async () => {
    const findings = many(26, (i) => ({ type: i === 0 ? 'ad_impression_spike' : 'video_view_spike', subject: `s${i}`, video: i ? `a/v${i}` : undefined, text: `t${i}` }));
    const links = new Map(findings.filter((f) => f.video).map((f) => [f.video, `https://link/${f.video}`]));

    await sendWebhook(findings, links, NOW);

    const [{ url, init }] = global.fetch.calls;
    expect(url).toBe('http://127.0.0.1:9/sus-hook');
    expect(init.method).toBe('POST');
    const { embeds: [embed], username } = JSON.parse(init.body);
    expect(username).toBe('3Speak sus-scan');
    expect(embed.title).toBe('Suspicious activity: 26 new findings');
    expect(embed.color).toBe(0xe03e3e);
    expect(embed.fields).toHaveLength(25);
    expect(embed.fields[1]).toEqual({ name: '📈 View spike: a/v1', value: 't1\nhttps://link/a/v1' });
    expect(embed.fields[24]).toEqual({ name: '…and 2 more', value: 'Ask for the full list.' });
    expect(embed.timestamp).toBe(NOW.toISOString());
  });

  test('amber for view-only findings, singular title for one', async () => {
    await sendWebhook([{ type: 'crawler_sessions', subject: 'Googlebot', text: 'x' }], new Map(), NOW);
    const { embeds: [embed] } = JSON.parse(global.fetch.calls[0].init.body);
    expect(embed.title).toBe('Suspicious activity: 1 new finding');
    expect(embed.color).toBe(0xf0a020);
    expect(embed.fields).toEqual([{ name: '🤖 Crawler sessions', value: 'x' }]);
  });

  test('a webhook error status is thrown to the caller', async () => {
    global.fetch = fakeFetch([['http://127.0.0.1:9/sus-hook', () => ({ status: 429, body: 'slow down' })]]);
    await expect(sendWebhook([{ type: 'x', subject: 'y', text: 'z' }], new Map(), NOW)).rejects.toThrow('webhook 429');
  });
});

describe('a scan run', () => {
  const seedCrawler = () => db().collection('view-durations').insertMany(many(3, () => session({ userAgent: GOOGLEBOT })));

  test('alerts a new finding once, remembers it for the day, and does not repeat it', async () => {
    await seedCrawler();

    const first = await runOnce();
    expect(types(first)).toEqual(['crawler_sessions']);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(await db().collection('sus_alerts').findOne({ _id: 'crawler_sessions|Googlebot|2026-11-01' }))
      .toMatchObject({ type: 'crawler_sessions', at: NOW });

    jest.setSystemTime(new Date(NOW.getTime() + 10 * MINUTE));
    expect(await runOnce()).toEqual([]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const alert = await db().collection('sus_alerts').findOne({ _id: 'crawler_sessions|Googlebot|2026-11-01' });
    expect(alert.lastAt).toEqual(new Date(NOW.getTime() + 10 * MINUTE));
    expect(await db().collection('sus_alerts').countDocuments()).toBe(1);
  });

  test('the same pattern is alerted again on the next UTC day', async () => {
    await seedCrawler();
    await runOnce();
    jest.setSystemTime(new Date('2026-11-02T00:10:00Z'));
    await seedCrawler();                             // the crawler is back in the new window
    expect(types(await runOnce())).toEqual(['crawler_sessions']);
    expect(await db().collection('sus_alerts').countDocuments()).toBe(2);
  });

  test('a dry run reports findings without remembering or sending them', async () => {
    await seedCrawler();
    expect(types(await runOnce({ dryRun: true }))).toEqual(['crawler_sessions']);
    expect(await db().collection('sus_alerts').countDocuments()).toBe(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('nothing found sends nothing', async () => {
    expect(await runOnce()).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('the scan never changes the data it reads', async () => {
    await seedCrawler();
    const before = await db().collection('view-durations').find().toArray();
    await runOnce();
    expect(await db().collection('view-durations').find().toArray()).toEqual(before);
  });

  test('a failed webhook is logged and the run resolves empty', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    global.fetch = fakeFetch([['http://127.0.0.1:9/sus-hook', () => ({ status: 500, body: '' })]]);
    await seedCrawler();
    await expect(runOnce()).resolves.toEqual([]);
    expect(console.error).toHaveBeenCalledWith('[susScan] run failed:', 'webhook 500');
  });

  test('a finding whose webhook delivery failed is alerted again on the next run', async () => {
    // Regression: every finding is recorded in sus_alerts BEFORE the webhook is sent.
    // When Discord was down or rate-limited, the finding stayed marked "alerted
    // today", so every later run that day filtered it out and nobody was ever told.
    global.fetch = fakeFetch([['http://127.0.0.1:9/sus-hook', () => ({ status: 503, body: '' })]]);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await seedCrawler();
    await runOnce();

    expect(await db().collection('sus_alerts').countDocuments()).toBe(0);

    global.fetch = fakeFetch([['http://127.0.0.1:9/sus-hook', () => ({ status: 204, body: '' })]]);
    expect(types(await runOnce())).toEqual(['crawler_sessions']);
    expect(await db().collection('sus_alerts').countDocuments()).toBe(1);
  });

  test('when forgetting an undelivered alert fails too, the webhook error is still the one reported', async () => {
    const { Collection } = require('mongodb');
    global.fetch = fakeFetch([['http://127.0.0.1:9/sus-hook', () => ({ status: 503, body: '' })]]);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(Collection.prototype, 'deleteMany').mockRejectedValue(new Error('primary stepped down'));
    await seedCrawler();
    await expect(runOnce()).resolves.toEqual([]);
    expect(console.error).toHaveBeenCalledWith('[susScan] could not forget undelivered alerts:', 'primary stepped down');
    expect(console.error).toHaveBeenCalledWith('[susScan] run failed:', 'webhook 503');
  });
});
