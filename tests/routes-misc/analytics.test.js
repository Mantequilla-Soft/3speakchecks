/**
 * routes/analytics.js: creator stats from the player's watch sessions
 * (view-durations, view-heatmaps) in MongoDB, Hive engagement (utils/hive,
 * mocked) and HafSQL (mocked). Both URL prefixes (/analytics, /creator-stats)
 * serve the same handlers.
 *
 * Access: the routes take a username and no credentials. Everything they return
 * is an aggregate over anonymous sessions or public chain data, and the file says
 * the frontend only shows it on your own profile, so these tests pin that the
 * reads are public and that the privacy rules (no viewer identity, small country
 * buckets suppressed) hold instead.
 */
const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const { NOW, pinClock } = require('./_fixtures');

jest.mock('../../utils/hive', () => ({ ...jest.requireActual('../../utils/hive'), hiveRpcBatch: jest.fn() }));
jest.mock('../../utils/hafsql', () => ({ query: jest.fn() }));
const { hiveRpcBatch } = require('../../utils/hive');
const hafsql = require('../../utils/hafsql');

const app = buildApp(['/', require('../../routes/analytics')]);
const db = testDb.use();

const DAY = 86400000;
const ago = (ms) => new Date(NOW.getTime() - ms);
let sid = 0;
/** One watch session as the player writes it. */
const session = (permlink, extra = {}) => {
  sid += 1;
  return {
    sid: `s${sid}`, owner: 'alice', permlink, contentSeconds: 60, watchedPct: 50, avgRate: 1,
    videoDuration: 120, updatedAt: ago(DAY), startedAt: ago(DAY), source: '3speak', ...extra,
  };
};
const addSessions = (...rows) => db().collection('view-durations').insertMany(rows);
/** Answer condenser_api.get_content for the batch from a map of "author/permlink" to post. */
const hivePosts = (posts) => hiveRpcBatch.mockImplementation(async (batch) => batch.map((b) => ({
  id: b.id, result: posts[`${b.params[0]}/${b.params[1]}`] || null,
})));

beforeEach(async () => {
  pinClock();
  hiveRpcBatch.mockReset();
  hafsql.query.mockReset();
  hivePosts({});
  await db().collection('embed-video').insertMany([
    { owner: 'alice', permlink: 'v1', hive_author: 'alice', hive_permlink: 'hive-v1', hive_title: 'First video', duration: 120, views: 10 },
    { owner: 'alice', permlink: 's1', short: true, embed_url: '@alice/hive-s1', hive_body: '![img](x) Hello **world** this is a #short with https://x.y many words here', duration: 30, views: 10 },
    { owner: 'alice', permlink: 's2', short: true, originalFilename: 'raw.mp4', duration: 30 },
    { owner: 'alice', permlink: 'v2', originalFilename: 'holiday.mp4', duration: 600 },
  ]);
  await db().collection('videos').insertOne({ owner: 'alice', permlink: 'old1', title: 'Legacy talk', duration: 300, views: 5 });
});
afterEach(() => jest.useRealTimers());

describe('every stats route', () => {
  const paths = ['overview', 'timeseries', 'weekly-top', 'ad-income', 'follows', 'hive-year', 'has-data', 'video', 'demographics'];

  test.each(paths.flatMap((p) => [[`/analytics/${p}`], [`/creator-stats/${p}`]]))('%s refuses a missing or malformed username (400)', async (path) => {
    await request(app).get(path).expect(400);
    await request(app).get(`${path}?username=No Way`).expect(400);
  });

  test.each([['has-data'], ['video']])('/analytics/%s refuses a malformed permlink (400)', async (p) => {
    await request(app).get(`/analytics/${p}?username=alice&permlink=a%20b`).expect(400);
    await request(app).get(`/analytics/${p}?username=alice`).expect(400);
  });

  test('reads need no credentials: they are aggregates, the same for any caller', async () => {
    await addSessions(session('v1'));
    const anon = await request(app).get('/analytics/overview?username=alice').expect(200);
    const other = await request(app).get('/creator-stats/overview?username=ALICE').set('Authorization', 'Bearer whatever').expect(200);
    expect(other.body).toEqual(anon.body);
  });
});

describe('GET /analytics/overview', () => {
  test('nobody watched: zeros, not an error', async () => {
    const res = await request(app).get('/analytics/overview?username=alice').expect(200);
    expect(res.body).toMatchObject({ success: true, days: 0, content: 'all', videos: [], totals: { videos: 0, sessions: 0, avgRate: 1 } });
    expect(hiveRpcBatch).not.toHaveBeenCalled();
  });

  test('totals and per-video stats from sessions, engagement from Hive', async () => {
    await addSessions(
      session('v1', { contentSeconds: 100, watchedPct: 80 }),
      session('v1', { contentSeconds: undefined, watchedSeconds: 50, watchedPct: 40, avgRate: 2 }),
      session('old1', { contentSeconds: 30, watchedPct: 10, videoDuration: 300 }),
      session('v1', { owner: 'bob' }), // someone else's
    );
    hivePosts({
      'alice/hive-v1': { net_votes: 7, children: 3, pending_payout_value: '1.50 HBD', created: '2026-10-01T00:00:00', title: 'Hive title' },
      'alice/old1': { net_votes: 1, children: 0, total_payout_value: '0.25 HBD' },
    });
    const res = await request(app).get('/analytics/overview?username=alice').expect(200);
    expect(res.body.totals).toEqual({
      videos: 2, sessions: 3, viewers: 3, watchSeconds: 180, avgViewDuration: 60,
      avgPct: Math.round(((60 * 2 + 10) / 3) * 10) / 10,
      avgRate: Math.round(((1.5 * 2 + 1) / 3) * 100) / 100,
      engagementRate: Math.round(((8 + 3) / 15) * 1000) / 10,
      votes: 8, comments: 3, payout: 1.75,
    });
    const v1 = res.body.videos.find((v) => v.permlink === 'v1');
    expect(v1).toMatchObject({
      title: 'First video', hiveAuthor: 'alice', hivePermlink: 'hive-v1', sessions: 2, watchSeconds: 150,
      watchPerView: 75, votes: 7, comments: 3, payout: 1.5, realViews: 10, created: '2026-10-01T00:00:00',
      thumbnail: 'https://img.3speak.tv/v1/thumbnail.png',
    });
    expect(res.body.videos.find((v) => v.permlink === 'old1')).toMatchObject({ title: 'Legacy talk', duration: 300 });
    expect(res.body.best.byWatchTime[0].permlink).toBe('v1');
    expect(res.body.best.byVotes.map((v) => v.permlink)).toEqual(['v1', 'old1']);
  });

  test('titles: the Hive title, else for shorts the first words of the post, never the filename', async () => {
    await addSessions(session('s1'), session('s2'), session('v2'), session('gone'));
    hivePosts({ 'alice/s2': { body: '' } });
    const { videos } = (await request(app).get('/analytics/overview?username=alice').expect(200)).body;
    const title = Object.fromEntries(videos.map((v) => [v.permlink, v.title]));
    expect(title).toEqual({
      s1: 'Hello world this is a short with many…',
      s2: 'Untitled short',
      v2: 'holiday.mp4',
      gone: 'gone',
    });
    expect(videos.find((v) => v.permlink === 's1')).toMatchObject({ short: true, hivePermlink: 'hive-s1' });
  });

  test('a short with no snippet in the doc takes the first words of its Hive post', async () => {
    await addSessions(session('s2'));
    hivePosts({ 'alice/s2': { body: 'From the chain body' } });
    const [v] = (await request(app).get('/analytics/overview?username=alice').expect(200)).body.videos;
    expect(v.title).toBe('From the chain body');
  });

  test('a tracked duration under half the stored one is replaced by the stored one', async () => {
    await addSessions(session('v2', { videoDuration: 6 }), session('v1', { videoDuration: 118 }));
    const { videos } = (await request(app).get('/analytics/overview?username=alice').expect(200)).body;
    expect(videos.find((v) => v.permlink === 'v2').duration).toBe(600);
    expect(videos.find((v) => v.permlink === 'v1').duration).toBe(118);
  });

  test('viewers de-duplicate on a legacy viewer id or IP, else count sessions', async () => {
    await addSessions(
      session('v1', { viewerId: 'browser-1' }), session('v1', { viewerId: 'browser-1' }),
      session('v1', { ip: '1.2.3.4' }), session('v1', { ip: '1.2.3.4' }),
      session('v1'),
    );
    const res = await request(app).get('/analytics/overview?username=alice').expect(200);
    expect(res.body.totals).toMatchObject({ sessions: 5, viewers: 3 });
  });

  test('days= picks a window (only 7, 28, 90 or 365; anything else is all time)', async () => {
    await addSessions(session('v1', { updatedAt: ago(2 * DAY) }), session('v1', { updatedAt: ago(20 * DAY) }));
    expect((await request(app).get('/analytics/overview?username=alice&days=7').expect(200)).body.totals.sessions).toBe(1);
    const odd = await request(app).get('/analytics/overview?username=alice&days=8').expect(200);
    expect(odd.body).toMatchObject({ days: 0, totals: { sessions: 2 } });
  });

  test('content= splits videos from shorts', async () => {
    await addSessions(session('v1'), session('s1'), session('old1'));
    const shorts = await request(app).get('/analytics/overview?username=alice&content=shorts').expect(200);
    expect(shorts.body.videos.map((v) => v.permlink)).toEqual(['s1']);
    const videos = await request(app).get('/analytics/overview?username=alice&content=videos').expect(200);
    expect(videos.body.videos.map((v) => v.permlink).sort()).toEqual(['old1', 'v1']);
    expect(videos.body.content).toBe('videos');
  });

  test('Hive being unreachable leaves engagement at zero, the stats still load', async () => {
    await addSessions(session('v1'));
    hiveRpcBatch.mockRejectedValue(new Error('all nodes down'));
    const res = await request(app).get('/analytics/overview?username=alice').expect(200);
    expect(res.body.totals).toMatchObject({ sessions: 1, votes: 0, comments: 0, payout: 0 });
  });

  test('a database failure is a 500', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(require('mongodb').Collection.prototype, 'aggregate').mockImplementation(() => { throw new Error('db down'); });
    await request(app).get('/analytics/overview?username=alice').expect(500);
  });
});

describe('GET /analytics/timeseries', () => {
  test('a continuous daily series, 28 days by default, ending today', async () => {
    await addSessions(
      session('v1', { updatedAt: ago(0), contentSeconds: 30 }),
      session('v1', { updatedAt: ago(0), contentSeconds: 40 }),
      session('v1', { updatedAt: ago(3 * DAY), contentSeconds: 10 }),
      session('v1', { updatedAt: ago(40 * DAY) }),
    );
    const res = await request(app).get('/analytics/timeseries?username=alice').expect(200);
    expect(res.body.days).toBe(28);
    expect(res.body.series).toHaveLength(28);
    expect(res.body.series[27]).toEqual({ date: '2026-11-01', watchSeconds: 70, views: 2, viewers: 2 });
    expect(res.body.series[24]).toEqual({ date: '2026-10-29', watchSeconds: 10, views: 1, viewers: 1 });
    expect(res.body.series[0]).toEqual({ date: '2026-10-05', watchSeconds: 0, views: 0, viewers: 0 });
  });

  test('days=7 gives a week, content= applies', async () => {
    await addSessions(session('s1', { updatedAt: ago(0) }), session('v1', { updatedAt: ago(0) }));
    const res = await request(app).get('/creator-stats/timeseries?username=alice&days=7&content=shorts').expect(200);
    expect(res.body.series).toHaveLength(7);
    expect(res.body.series[6].views).toBe(1);
  });
});

describe('GET /creator-stats/weekly-top', () => {
  test('per ISO week (Monday start), the videos with the most watch time, capped by per=', async () => {
    // 2026-11-01 is a Sunday: its week started on Monday 2026-10-26.
    await addSessions(
      session('v1', { updatedAt: ago(0), contentSeconds: 100 }),
      session('s1', { updatedAt: ago(DAY), contentSeconds: 300 }),
      session('old1', { updatedAt: ago(2 * DAY), contentSeconds: 50 }),
      session('v2', { updatedAt: ago(7 * DAY), contentSeconds: 20 }),
      session('v2', { updatedAt: ago(7 * DAY), contentSeconds: 0, watchedSeconds: 0 }),
    );
    const res = await request(app).get('/creator-stats/weekly-top?username=alice&per=2').expect(200);
    expect(res.body.days).toBe(365);
    expect(Object.keys(res.body.weeks).sort()).toEqual(['2026-10-19', '2026-10-26']);
    expect(res.body.weeks['2026-10-26'].map((v) => [v.permlink, v.watchSeconds])).toEqual([['s1', 300], ['v1', 100]]);
    expect(res.body.weeks['2026-10-26'][0]).toMatchObject({ short: true, title: 'Hello world this is a short with many…', hivePermlink: 'hive-s1' });
    expect(res.body.weeks['2026-10-19']).toEqual([expect.objectContaining({ permlink: 'v2', title: 'holiday.mp4' })]);
  });

  test('no sessions: no weeks', async () => {
    expect((await request(app).get('/creator-stats/weekly-top?username=alice').expect(200)).body.weeks).toEqual({});
  });
});

describe('GET /creator-stats/ad-income', () => {
  test('paid payouts in the window, split by kind; a payout without parts is its kind', async () => {
    await db().collection('ad_payouts').insertMany([
      { account: 'alice', status: 'paid', paidAt: ago(DAY), periodKey: '2026-10', parts: { creator: 1.5, viewer: 0.5 }, hbd: 2 },
      { account: 'alice', status: 'paid', paidAt: ago(40 * DAY), periodKey: '2026-09', kind: 'referral', hbd: 0.3 },
      { account: 'alice', status: 'paid', paidAt: ago(50 * DAY), periodKey: '2026-08', hbd: 0.1, parts: {} },
      { account: 'alice', status: 'pending', paidAt: ago(DAY), periodKey: '2026-10b', hbd: 9 },
      { account: 'alice', status: 'paid', paidAt: ago(400 * DAY), periodKey: '2025-09', hbd: 9 },
      { account: 'bob', status: 'paid', paidAt: ago(DAY), periodKey: '2026-10', hbd: 9 },
    ]);
    const res = await request(app).get('/creator-stats/ad-income?username=alice').expect(200);
    expect(res.body.periods).toEqual({
      '2026-10': { creator: 1.5, viewer: 0.5 },
      '2026-09': { referral: 0.3 },
      '2026-08': { creator: 0.1 },
    });
    const month = await request(app).get('/creator-stats/ad-income?username=alice&days=28').expect(200);
    expect(Object.keys(month.body.periods)).toEqual(['2026-10']);
  });
});

describe('GET /creator-stats/follows (HafSQL)', () => {
  test("followers and followings since the window's first block, newest first", async () => {
    hafsql.query.mockImplementation(async (sql, params) => {
      if (/as head/.test(sql)) return [{ head: '1000000' }];
      if (/where following_name = \$1/.test(sql)) return [{ account: 'bob', block: 999000 }];
      if (/where follower_name = \$1/.test(sql)) return [{ account: 'carol', block: 998000 }];
      throw new Error(`unexpected ${sql} ${params}`);
    });
    const res = await request(app).get('/creator-stats/follows?username=alice&days=7').expect(200);
    expect(res.body).toEqual({
      success: true, username: 'alice', days: 7, headBlock: 1000000,
      followers: [{ account: 'bob', block: 999000 }], following: [{ account: 'carol', block: 998000 }],
    });
    const since = 1000000 - 7 * 28800;
    expect(hafsql.query.mock.calls.slice(1).map((c) => c[1])).toEqual([['alice', since], ['alice', since]]);
  });

  test('HafSQL down is a 500', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    hafsql.query.mockRejectedValue(new Error('pg down'));
    await request(app).get('/creator-stats/follows?username=alice').expect(500);
  });
});

describe('GET /creator-stats/hive-year (HafSQL)', () => {
  const answer = (sql) => {
    if (/as head/.test(sql)) return [{ head: 100000000 }];
    if (/operation_vote_view/.test(sql)) return [{ account: 'bob', n: 4 }, { account: 'hivebuzz', n: 99 }, { account: 'carol', n: 1 }];
    if (/operation_comment_view/.test(sql)) return [{ account: 'carol', n: 2 }, { account: 'dave', n: 1 }];
    if (/author_reward/.test(sql)) return [{ permlink: 'p1', hbd: 1, hive: 2, vests: 3, n: 1 }, { permlink: 'p2', hbd: 0.5, hive: 0, vests: 1, n: 2 }];
    if (/transfer_table/.test(sql)) return [{ amount: 0.5, symbol: 'HBD', memo: '3Speak ad revenue share 2026-10' }];
    throw new Error(`unexpected ${sql}`);
  };

  test('fans scored by votes plus three per reply, service accounts left out; rewards summed per post', async () => {
    hafsql.query.mockImplementation(async (sql) => answer(sql));
    const res = await request(app).get('/creator-stats/hive-year?username=alice').expect(200);
    expect(res.body.fans).toEqual([
      { account: 'carol', votes: 1, comments: 2 },
      { account: 'bob', votes: 4, comments: 0 },
      { account: 'dave', votes: 0, comments: 1 },
    ]);
    expect(res.body.author).toEqual({ hbd: 1.5, hive: 2, vests: 4, count: 3, byPost: { p1: { hbd: 1, hive: 2, vests: 3 }, p2: { hbd: 0.5, hive: 0, vests: 1 } } });
    expect(res.body.ads).toHaveLength(1);
    const sinceBlock = 100000000 - 365 * 28800;
    expect(res.body.sinceBlock).toBe(sinceBlock);
    // HAF operation ids carry the block number in their high 32 bits.
    const rewardCall = hafsql.query.mock.calls.find((c) => /author_reward/.test(c[0]));
    expect(rewardCall[1]).toEqual(['alice', (BigInt(sinceBlock) << 32n).toString()]);
  });

  test('one answer per account and window is kept for 30 minutes', async () => {
    hafsql.query.mockImplementation(async (sql) => answer(sql));
    await request(app).get('/creator-stats/hive-year?username=cached&days=90').expect(200);
    const calls = hafsql.query.mock.calls.length;
    await request(app).get('/creator-stats/hive-year?username=cached&days=90').expect(200);
    expect(hafsql.query.mock.calls.length).toBe(calls);
    jest.setSystemTime(Date.now() + 31 * 60 * 1000);
    await request(app).get('/creator-stats/hive-year?username=cached&days=90').expect(200);
    expect(hafsql.query.mock.calls.length).toBe(calls * 2);
  });

  test('a failed read is a 500 and is not cached', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    hafsql.query.mockRejectedValue(new Error('pg down'));
    await request(app).get('/creator-stats/hive-year?username=flaky').expect(500);
    hafsql.query.mockImplementation(async (sql) => answer(sql));
    await request(app).get('/creator-stats/hive-year?username=flaky').expect(200);
  });
});

describe('GET /analytics/has-data', () => {
  test('counts sessions on the asset, found by asset or Hive permlink', async () => {
    await addSessions(session('v1'), session('v1'));
    expect((await request(app).get('/analytics/has-data?username=alice&permlink=hive-v1').expect(200)).body).toEqual({ success: true, hasData: true, sessions: 2 });
    expect((await request(app).get('/analytics/has-data?username=alice&permlink=v2').expect(200)).body).toEqual({ success: true, hasData: false, sessions: 0 });
  });
});

describe('GET /analytics/video', () => {
  test('no sessions: sessions 0', async () => {
    expect((await request(app).get('/analytics/video?username=alice&permlink=v1').expect(200)).body).toEqual({ success: true, username: 'alice', permlink: 'v1', sessions: 0 });
  });

  test('retention per slice, most-replayed normalized, and the stored duration when every row is mis-tracked', async () => {
    await addSessions(
      session('v1', { videoDuration: 6, startPosition: 0, maxPosition: 60, watchedPct: 50, avgRate: 1 }),
      session('v1', { videoDuration: 6, startPosition: 60, lastPosition: 120, maxPosition: 0, watchedPct: 50, avgRate: 2, contentSeconds: undefined, watchedSeconds: 30 }),
    );
    await db().collection('view-heatmaps').insertOne({ owner: 'alice', permlink: 'v1', bucketCount: 4, buckets: [1, 4, '2', null] });
    const res = await request(app).get('/analytics/video?username=alice&permlink=hive-v1').expect(200);
    expect(res.body).toMatchObject({ permlink: 'v1', duration: 120, sessions: 2, viewers: 2, watchSeconds: 90, avgPct: 50, avgRate: 1.5 });
    expect(res.body.retention).toHaveLength(100);
    expect(res.body.retention[0]).toBe(50);
    expect(res.body.retention[50]).toBe(100); // both sessions were at the middle
    expect(res.body.retention[99]).toBe(50);
    expect(res.body.replay).toEqual({ bucketCount: 4, normalized: [0.25, 1, 0.5, 0] });
  });

  test('a legacy video, a flat heatmap, and a video with no stored duration', async () => {
    await addSessions(session('old1', { videoDuration: 300, maxPosition: 300 }), session('nometa', { videoDuration: 50 }));
    await db().collection('view-heatmaps').insertOne({ owner: 'alice', permlink: 'old1', buckets: [0, 0] });
    const legacy = await request(app).get('/analytics/video?username=alice&permlink=old1').expect(200);
    expect(legacy.body).toMatchObject({ duration: 300, replay: { bucketCount: 2, normalized: [0, 0] } });
    const bare = await request(app).get('/analytics/video?username=alice&permlink=nometa').expect(200);
    expect(bare.body).toMatchObject({ duration: 50, replay: { bucketCount: 100, normalized: [] } });
  });
});

describe('GET /analytics/demographics: privacy rules', () => {
  const many = (n, extra) => Array.from({ length: n }, () => session('v1', extra));

  test('a country with fewer than five sessions is not published, it counts as unknown', async () => {
    await addSessions(...many(5, { country: 'DE' }), ...many(2, { country: 'LI' }), ...many(1, { country: null }));
    const res = await request(app).get('/analytics/demographics?username=alice').expect(200);
    expect(res.body.byCountry).toEqual([{ country: 'DE', sessions: 5, viewers: 5 }]);
    expect(res.body).toMatchObject({ totalSessions: 8, totalViewers: 8, locatedViewers: 5, unknownViewers: 3, newViewers: null, returningViewers: null });
  });

  test('legacy rows with a raw IP are geolocated on read', async () => {
    // Five US addresses (one of them twice), and a private one that cannot be located.
    const ips = ['8.8.8.8', '8.8.8.8', '8.8.4.4', '8.8.8.1', '8.8.8.2', '8.8.8.3'];
    await addSessions(...ips.map((ip) => session('v1', { ip })), session('v1', { ip: '10.0.0.1' }));
    const res = await request(app).get('/analytics/demographics?username=alice').expect(200);
    expect(res.body.byCountry).toEqual([{ country: 'US', sessions: 6, viewers: 5 }]);
    expect(res.body).toMatchObject({ totalSessions: 6, locatedViewers: 5, unknownViewers: 1 });
  });

  test('devices, browsers, sources and when people watch (UTC day x hour)', async () => {
    const sunday10 = new Date('2026-11-01T10:30:00Z');
    await addSessions(
      session('v1', { userAgent: 'Mozilla/5.0 (iPhone) Mobile Safari/604.1', startedAt: sunday10 }),
      session('v1', { userAgent: 'Mozilla/5.0 (Windows) Chrome/120 Safari/537', startedAt: sunday10 }),
      session('v1', { userAgent: 'Mozilla/5.0 (Windows) Chrome/120 Edg/120', source: undefined }),
      session('v1', { userAgent: 'Mozilla/5.0 (iPad) Firefox/120' }),
      session('v1', { userAgent: 'SmartTV OPR/90' }),
      session('v1', { userAgent: 'Googlebot crawl' }),
    );
    const res = await request(app).get('/analytics/demographics?username=alice&days=28&content=videos').expect(200);
    const byDevice = Object.fromEntries(res.body.byDevice.map((d) => [d.device, d.sessions]));
    // A bot has no device of its own: it counts as a desktop.
    expect(byDevice).toEqual({ Mobile: 1, Desktop: 3, Tablet: 1, TV: 1 });
    const byBrowser = Object.fromEntries(res.body.byBrowser.map((b) => [b.browser, b.sessions]));
    expect(byBrowser).toEqual({ Safari: 1, Chrome: 1, Edge: 1, Firefox: 1, Opera: 1, Other: 1 });
    expect(res.body.bySource).toEqual([{ source: '3speak', sessions: 5 }, { source: 'player', sessions: 1 }]);
    expect(res.body.whenHeatmap).toHaveLength(7);
    expect(res.body.whenHeatmap[0][10]).toBe(2); // Sunday 10:00 UTC
    expect(res.body.whenHeatmap[6][12]).toBe(4); // Saturday 12:00 UTC, the other four
  });
});
