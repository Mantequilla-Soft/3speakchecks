/**
 * Card reach (routes/cardReach.js): cards seen (sampled, scaled back up) and
 * videos opened, per day, video and surface, and the creator-stats answer built
 * from them: impressions, click-through rate and where viewers found a video.
 */
// No datacenter ranges file in a test checkout: every address is a home one.
jest.mock('../../utils/datacenterIp', () => ({ isDatacenterIp: () => false }));
const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');

const db = testDb.use();
const router = require('../../routes/cardReach');
const app = buildApp(['/', router]);
const { reset } = router._test;

const BROWSER = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const rows = () => db().collection('card_reach_daily').find({}).sort({ _id: 1 }).toArray();
const seen = (body, ua = BROWSER) => request(app).post('/reach/seen').set('User-Agent', ua).send(body);
const open = (body, ua = BROWSER) => request(app).post('/reach/open').set('User-Agent', ua).send(body);

beforeEach(() => reset());

describe('POST /reach/seen', () => {
  test('counts each card once per batch and surface, scaled by the sample rate', async () => {
    await seen({ rate: 0.5, items: [
      { a: 'badadib', p: 'vid1', s: 'discover' },
      { a: 'badadib', p: 'vid1', s: 'discover' },
      { a: 'badadib', p: 'vid1', s: 'search' },
      { a: 'badadib', p: 'vid2', s: 'discover' },
    ] }).expect(204);
    const r = await rows();
    expect(r.map((x) => [x.permlink, x.surface, x.seen])).toEqual([
      ['vid1', 'discover', 2], ['vid1', 'search', 2], ['vid2', 'discover', 2],
    ]);
    expect(r[0].at).toBeInstanceOf(Date);
    expect(Object.keys(r[0]).sort()).toEqual(['_id', 'at', 'author', 'day', 'permlink', 'seen', 'surface']);
  });

  test('a rate outside the allowed list is refused (no multiplying reports)', async () => {
    await seen({ rate: 0.001, items: [{ a: 'badadib', p: 'vid1', s: 'home' }] }).expect(400);
    expect(await rows()).toEqual([]);
  });

  test('unknown surfaces and malformed names are dropped', async () => {
    await seen({ rate: 1, items: [
      { a: 'badadib', p: 'vid1', s: 'nowhere' },
      { a: 'Bad Name', p: 'vid1', s: 'home' },
      { a: 'badadib', p: '../x', s: 'home' },
      { a: 'badadib', p: 'ok', s: 'home' },
    ] }).expect(204);
    expect((await rows()).map((x) => x.permlink)).toEqual(['ok']);
  });

  test('crawlers are answered but not counted', async () => {
    await seen({ rate: 1, items: [{ a: 'badadib', p: 'vid1', s: 'home' }] }, 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)').expect(204);
    expect(await rows()).toEqual([]);
  });

  test('a sendBeacon text/plain body is read too', async () => {
    await request(app).post('/reach/seen').set('User-Agent', BROWSER).set('Content-Type', 'text/plain')
      .send(JSON.stringify({ rate: 1, items: [{ a: 'badadib', p: 'vid1', s: 'home' }] })).expect(204);
    expect((await rows()).map((x) => x.seen)).toEqual([1]);
  });

  test('one address has an hourly budget of cards', () => {
    const { takeSeenBudget } = router._test;
    expect(takeSeenBudget('x', 1000, 0)).toBe(1000);
    expect(takeSeenBudget('x', 1000, 1)).toBe(500);
    expect(takeSeenBudget('x', 10, 2)).toBe(0);
    expect(takeSeenBudget('x', 10, 3600 * 1000 + 3)).toBe(10);
  });
});

describe('POST /reach/open', () => {
  test('counts an open once per address and video in the window', async () => {
    await open({ a: 'badadib', p: 'vid1', s: 'discover' }).expect(204);
    await open({ a: 'badadib', p: 'vid1', s: 'discover' }).expect(204);
    await open({ a: 'badadib', p: 'vid2', s: 'social' }).expect(204);
    expect((await rows()).map((x) => [x.permlink, x.surface, x.opens])).toEqual([
      ['vid1', 'discover', 1], ['vid2', 'social', 1],
    ]);
  });

  test('an unknown source is refused', async () => {
    await open({ a: 'badadib', p: 'vid1', s: 'tv' }).expect(400);
  });
});

describe('GET /creator-stats/reach', () => {
  const today = new Date().toISOString().slice(0, 10);
  const old = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
  const row = (permlink, surface, seenN, opens, day = today, author = 'badadib') => ({
    _id: `${day}|${author}/${permlink}|${surface}`, day, at: new Date(`${day}T00:00:00Z`), author, permlink, surface, seen: seenN, opens,
  });

  beforeEach(async () => {
    await db().collection('embed-video').insertMany([
      { owner: 'badadib', permlink: 'asset1', hive_author: 'badadib', hive_permlink: 'post-one', short: false },
      { owner: 'badadib', permlink: 'asset2', short: true, embed_url: '@badadib/short-two' },
    ]);
    await db().collection('card_reach_daily').insertMany([
      row('post-one', 'discover', 100, 10),
      row('post-one', 'search', 20, 4),
      row('post-one', 'social', 0, 3),
      row('short-two', 'shorts', 50, 5),
      row('post-one', 'discover', 999, 99, old),
      row('other', 'discover', 7, 7, today, 'fan'),
    ]);
    await db().collection('view-durations').insertMany([
      { owner: 'badadib', permlink: 'asset1', source: 'player', updatedAt: new Date() },
      { owner: 'badadib', permlink: 'asset1', source: '3speak', updatedAt: new Date() },
    ]);
  });

  test('impressions, clicks from cards, CTR and where viewers found it, in the range', async () => {
    const { body } = await request(app).get('/creator-stats/reach?username=badadib&days=28').expect(200);
    expect(body.totals).toEqual({ impressions: 170, clicks: 19, opens: 23, ctr: 11.2 });
    expect(body.bySurface.map((s) => [s.surface, s.impressions, s.clicks])).toEqual([
      ['discover', 100, 10], ['shorts', 50, 5], ['search', 20, 4],
    ]);
    expect(body.found).toEqual([
      { source: 'discover', opens: 10 }, { source: 'shorts', opens: 5 }, { source: 'search', opens: 4 },
      { source: 'social', opens: 3 }, { source: 'embed', opens: 1 },
    ]);
    // Keyed by the asset permlink, as the rest of creator stats is.
    expect(body.videos.find((v) => v.permlink === 'asset1')).toEqual({ permlink: 'asset1', impressions: 120, clicks: 14, opens: 18, ctr: 11.7 });
    expect(body.videos.find((v) => v.permlink === 'asset2')).toMatchObject({ impressions: 50, clicks: 5 });
  });

  test('all time includes the older day; the shorts filter keeps only shorts', async () => {
    const all = await request(app).get('/creator-stats/reach?username=badadib').expect(200);
    expect(all.body.totals.impressions).toBe(1169);
    const shorts = await request(app).get('/creator-stats/reach?username=badadib&days=7&content=shorts').expect(200);
    expect(shorts.body.totals).toMatchObject({ impressions: 50, clicks: 5 });
    expect(shorts.body.found).toEqual([{ source: 'shorts', opens: 5 }]);
  });

  test('a bad username is refused', async () => {
    await request(app).get('/creator-stats/reach?username=X').expect(400);
  });
});
