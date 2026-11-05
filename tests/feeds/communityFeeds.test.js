/**
 * The community feeds in routes/feeds.js, against a real MongoDB:
 *   /feeds/community/:id/new | /trending | /top   one community's videos
 *   /feeds/communities/activity                   per-community counts for the directory
 *
 * Membership: a legacy video carries `community`; an embed video belongs when its
 * Hive post's category is the community, or (some posting clients) when the
 * community id is one of its tags.
 */
jest.mock('../../utils/hive', () => require('./_hiveMock').create());

const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const F = require('./_fixtures');
const hive = require('../../utils/hive');

const db = testDb.use();
const app = buildApp(['/feeds', require('../../routes/feeds')]);
const C = 'hive-112233';
const get = (path, query = {}) => request(app).get(`/feeds/${path}`).query(query);
const videos = () => db().collection('videos');
const embeds = () => db().collection('embed-video');

beforeEach(async () => {
  F.pinClock();
  hive.__reset();
  await F.resetFeedCaches(db());
});
afterEach(() => jest.useRealTimers());

describe('community id validation', () => {
  test.each(['new', 'trending', 'top'])('/community/:id/%s rejects an id that is not hive-<digits>', async (tab) => {
    const res = await get(`community/not-a-community/${tab}`).expect(400);
    expect(res.body).toEqual({ success: false, error: 'community id must look like "hive-<digits>"' });
  });

  test('/top rejects an unknown window', async () => {
    const res = await get(`community/${C}/top`, { window: '2d' }).expect(400);
    expect(res.body.error).toBe('window must be one of 7d, 30d, 365d, all');
  });
});

describe('/community/:id/new', () => {
  test('legacy by `community`, embed by category or tag; newest first; other communities excluded', async () => {
    await videos().insertMany([
      F.legacyVideo({ permlink: 'l1', community: C, created: F.hoursAgo(4) }),
      F.legacyVideo({ permlink: 'l-other', community: 'hive-999' }),
    ]);
    await embeds().insertMany([
      F.embedVideo({ permlink: 'by-category', category: C, createdAt: F.hoursAgo(1) }),
      F.embedVideo({ permlink: 'by-tag', hive_tags: ['vlog', C], createdAt: F.hoursAgo(2) }),
      F.embedVideo({ permlink: 'elsewhere', category: 'hive-999' }),
    ]);

    const res = await get(`community/${C}/new`).expect(200);

    expect(res.body).toMatchObject({ success: true, feed: 'community-new', community: C, total: 3 });
    expect(F.permlinks(res.body.videos)).toEqual(['hive-by-category', 'hive-by-tag', 'l1']);
    expect(res.body.videos[0]).not.toHaveProperty('_sortDate');
  });

  test('an NSFW-tagged post in the community stays out (the tag match and the nsfw filter do not collide)', async () => {
    await embeds().insertMany([
      F.embedVideo({ permlink: 'safe', hive_tags: [C] }),
      F.embedVideo({ permlink: 'spicy', hive_tags: [C, 'nsfw'] }),
    ]);
    expect(F.permlinks((await get(`community/${C}/new`).expect(200)).body.videos)).toEqual(['hive-safe']);
    expect((await get(`community/${C}/new`, { nsfw: 'true' }).expect(200)).body.total).toBe(2);
  });

  test.each([
    ['unlisted', { listed_on_3speak: false }],
    ['a short', { short: true }],
    ['hidden from feeds', { hiddenFromFeed: true }],
    ['unavailable', { unavailable: true }],
    ['by a moderation-hidden creator', { owner: 'gone', hive_author: 'gone' }],
  ])('an embed video that is %s is excluded', async (_label, over) => {
    await F.hideCreator(db(), 'gone');
    await embeds().insertMany([F.embedVideo({ permlink: 'keep', category: C }), F.embedVideo({ permlink: 'drop', category: C, ...over })]);
    expect(F.permlinks((await get(`community/${C}/new`).expect(200)).body.videos)).toEqual(['hive-keep']);
  });

  test('cards carry the display topic from the auto tagger', async () => {
    await embeds().insertOne(F.embedVideo({ owner: 'tagd', permlink: 'asset-t', category: C }));
    await db().collection('subtitles-tags').insertOne({ author: 'tagd', permlink: 'asset-t', tags_list_v2: ['music', 'art'] });

    const [card] = (await get(`community/${C}/new`).expect(200)).body.videos;

    expect(card).toMatchObject({ tag_v2: 'music', tag_v2_source: 'auto', tags_v2_auto: ['music', 'art'] });
  });

  test('pagination and dismissals', async () => {
    await videos().insertMany(Array.from({ length: 4 }, (_, i) =>
      F.legacyVideo({ owner: i === 0 ? 'muted' : 'speaker', permlink: `p${i}`, community: C, created: F.hoursAgo(i + 1) })));
    await F.dismissCreator(db(), 'viewer', 'muted');

    const res = await get(`community/${C}/new`, { currentuser: 'viewer', limit: 2, page: 2 }).expect(200);

    expect(res.body).toMatchObject({ total: 3, totalPages: 2, page: 2 });
    expect(F.permlinks(res.body.videos)).toEqual(['p3']);
  });
});

describe('/community/:id/trending', () => {
  test('most viewed within the last 30 days', async () => {
    await videos().insertMany([
      F.legacyVideo({ permlink: 'l-hot', community: C, views: 50, created: F.daysAgo(3) }),
      F.legacyVideo({ permlink: 'l-ancient', community: C, views: 5000, created: F.daysAgo(40) }),
    ]);
    await embeds().insertMany([
      F.embedVideo({ permlink: 'e-warm', category: C, views: 20, createdAt: F.daysAgo(1) }),
      F.embedVideo({ permlink: 'e-old', category: C, views: 9000, createdAt: F.daysAgo(31) }),
    ]);

    const res = await get(`community/${C}/trending`).expect(200);

    expect(res.body).toMatchObject({ feed: 'community-trending', total: 2 });
    expect(F.permlinks(res.body.videos)).toEqual(['l-hot', 'hive-e-warm']);
    expect(res.body.videos[0]).not.toHaveProperty('_rankScore');
    expect(res.body.videos[0]).not.toHaveProperty('_views');
  });

  test('chrono=1 lists the same window newest first', async () => {
    await videos().insertMany([
      F.legacyVideo({ permlink: 'popular', community: C, views: 99, created: F.daysAgo(5) }),
      F.legacyVideo({ permlink: 'newest', community: C, views: 0, created: F.hoursAgo(1) }),
    ]);
    expect(F.permlinks((await get(`community/${C}/trending`, { chrono: 1 }).expect(200)).body.videos)).toEqual(['newest', 'popular']);
  });

  test('hides what the viewer already watched', async () => {
    await videos().insertMany([
      F.legacyVideo({ owner: 'w', permlink: 'seen', community: C, views: 9 }),
      F.legacyVideo({ owner: 'w', permlink: 'unseen', community: C, views: 1 }),
    ]);
    await db().collection('watch_history').insertOne(F.watched('viewer', 'w', 'seen'));
    expect(F.permlinks((await get(`community/${C}/trending`, { currentuser: 'viewer' }).expect(200)).body.videos)).toEqual(['unseen']);
  });
});

describe('/community/:id/top', () => {
  beforeEach(async () => {
    await videos().insertMany([
      F.legacyVideo({ permlink: 'week', community: C, views: 10, created: F.daysAgo(2) }),
      F.legacyVideo({ permlink: 'month', community: C, views: 30, created: F.daysAgo(20) }),
      F.legacyVideo({ permlink: 'year', community: C, views: 100, created: F.daysAgo(200) }),
      F.legacyVideo({ permlink: 'ages', community: C, views: 500, created: F.daysAgo(1000) }),
    ]);
    await embeds().insertOne(F.embedVideo({ permlink: 'e-month', category: C, views: 20, createdAt: F.daysAgo(10) }));
  });

  test.each([
    ['7d', ['week']],
    ['30d', ['month', 'hive-e-month', 'week']],
    ['365d', ['year', 'month', 'hive-e-month', 'week']],
    ['all', ['ages', 'year', 'month', 'hive-e-month', 'week']],
  ])('window %s ranks only by views', async (window, expected) => {
    const res = await get(`community/${C}/top`, { window }).expect(200);
    expect(res.body).toMatchObject({ feed: 'community-top', window });
    expect(F.permlinks(res.body.videos)).toEqual(expected);
  });

  test('defaults to 30 days and pages through the merged ranking', async () => {
    const res = await get(`community/${C}/top`, { limit: 1, page: 2 }).expect(200);
    expect(res.body.window).toBe('30d');
    expect(F.permlinks(res.body.videos)).toEqual(['hive-e-month']);
  });
});

describe('/communities/activity', () => {
  test('counts today / this week / this month per community, from both collections, once per post', async () => {
    await videos().insertMany([
      F.legacyVideo({ owner: 'a', permlink: 'today', community: C, created: F.hoursAgo(2) }),
      F.legacyVideo({ owner: 'a', permlink: 'week', community: C, created: F.daysAgo(3) }),
      F.legacyVideo({ owner: 'b', permlink: 'month', community: C, created: F.daysAgo(20) }),
      F.legacyVideo({ owner: 'b', permlink: 'too-old', community: C, created: F.daysAgo(40) }),
      F.legacyVideo({ owner: 'z', permlink: 'other', community: 'hive-777', created: F.hoursAgo(1) }),
    ]);
    await embeds().insertMany([
      F.embedVideo({ owner: 'c', permlink: 'e1', category: C, createdAt: F.hoursAgo(1) }),
      F.embedVideo({ owner: 'd', permlink: 'e2', hive_tags: ['x', C], createdAt: F.daysAgo(5) }),
      // The same Hive post as legacy "today": counted once.
      F.embedVideo({ owner: 'a', permlink: 'dup', hive_permlink: 'today', category: C, createdAt: F.hoursAgo(2) }),
    ]);

    const res = await get('communities/activity').expect(200);

    expect(res.body).toMatchObject({ success: true, windowDays: 30 });
    expect(res.body.communities[C]).toMatchObject({ today: 2, week: 4, month: 5 });
    expect(res.body.communities['hive-777']).toMatchObject({ today: 1, week: 1, month: 1 });
  });

  test('the thumbnail strip prefers different creators, newest first, three at most', async () => {
    await videos().insertMany([
      F.legacyVideo({ owner: 'prolific', permlink: 'p1', community: C, created: F.hoursAgo(1) }),
      F.legacyVideo({ owner: 'prolific', permlink: 'p2', community: C, created: F.hoursAgo(2) }),
      F.legacyVideo({ owner: 'prolific', permlink: 'p3', community: C, created: F.hoursAgo(3) }),
      F.legacyVideo({ owner: 'quiet', permlink: 'q1', community: C, created: F.hoursAgo(4) }),
    ]);

    const { latest } = (await get('communities/activity').expect(200)).body.communities[C];

    expect(F.permlinks(latest)).toEqual(['p1', 'q1', 'p2']);
  });

  test('NSFW is always excluded: a directory thumbnail is shown before anyone opts in', async () => {
    await videos().insertOne(F.legacyVideo({ permlink: 'n', community: C, isNsfwContent: true }));
    await embeds().insertOne(F.embedVideo({ permlink: 'n2', category: C, hive_tags: ['nsfw'] }));
    const res = await get('communities/activity', { nsfw: 'true' }).expect(200);
    expect(res.body.communities).toEqual({});
  });

  test('is cached for ten minutes', async () => {
    await get('communities/activity').expect(200);
    await videos().insertOne(F.legacyVideo({ permlink: 'new', community: C }));
    expect((await get('communities/activity').expect(200)).body.communities).toEqual({});
  });
});
