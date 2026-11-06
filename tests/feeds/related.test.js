/**
 * GET /feeds/related/:author/:permlink, the watch page sidebar, against a real
 * MongoDB.
 *
 * Candidates are the discover pool plus the current creator's own recent uploads.
 * They are pulled, in this order of strength, by sharing the current video's topic
 * (x3), being by the same creator (x2.5) and matching the viewer's interests (x2);
 * the multipliers stack and a seeded +/-15% jitter keeps the rail from freezing.
 */
jest.mock('../../utils/hive', () => require('./_hiveMock').create());

const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const F = require('./_fixtures');
const hive = require('../../utils/hive');

const db = testDb.use();
const app = buildApp(['/feeds', require('../../routes/feeds')]);
const related = (author, permlink, query = {}) =>
  request(app).get(`/feeds/related/${author}/${permlink}`).query({ seed: 3, ...query });

beforeEach(async () => {
  F.pinClock();
  hive.__reset();
  await F.resetFeedCaches(db());
});
afterEach(() => jest.useRealTimers());

/**
 * The page being watched: alice's "cur" (Hive permlink hive-cur), auto-tagged music.
 * Around it: bob's music video (same topic), carol's food video (unrelated, weak),
 * and alice's own newer upload that is NOT in the pool.
 */
async function seedWatchPage() {
  await db().collection('embed-video').insertOne(F.embedVideo({ owner: 'alice', permlink: 'cur' }));
  await db().collection('subtitles-tags').insertOne({ author: 'alice', permlink: 'cur', tags: 'music, art' });
  await db().collection('discover-pool').insertOne(F.poolEntry({ owner: 'alice', assetPermlink: 'cur', winnerTag: 'music' }));
  await F.seedPooled(db(), { video: { owner: 'bob', permlink: 'bob-music' }, entry: { winnerTag: 'music', base: 2 } });
  await F.seedPooled(db(), { video: { owner: 'carol', permlink: 'carol-food' }, entry: { winnerTag: 'food', base: 0.1 } });
  await db().collection('embed-video').insertOne(F.embedVideo({ owner: 'alice', permlink: 'alice-new', createdAt: F.hoursAgo(1) }));
}

describe('input', () => {
  test('an empty author is a 400', async () => {
    const res = await related('@', 'x').expect(400);
    expect(res.body).toEqual({ success: false, error: 'author and permlink are required' });
  });

  test('a video nobody tagged, with an empty pool, is an empty rail', async () => {
    const res = await related('nobody', 'nothing').expect(200);
    expect(res.body).toMatchObject({ success: true, feed: 'related', currentTopic: null, total: 0, videos: [] });
  });
});

describe('ranking', () => {
  test('same topic first, then the same creator, then the rest; the current video never appears', async () => {
    await seedWatchPage();

    const res = await related('Alice', 'hive-cur').expect(200);

    expect(res.body).toMatchObject({ author: 'alice', permlink: 'hive-cur', currentTopic: 'music', topicInInterests: false });
    expect(F.permlinks(res.body.videos)).toEqual(['hive-bob-music', 'hive-alice-new', 'hive-carol-food']);
  });

  test('topicInInterests says whether the current topic is one of the viewer\'s picks', async () => {
    await seedWatchPage();
    const res = await related('alice', 'hive-cur', { interests: 'music' }).expect(200);
    expect(res.body.topicInInterests).toBe(true);
  });

  test('a viewer\'s interest lifts an otherwise unrelated video', async () => {
    await seedWatchPage();
    // food x2 for the interest is still far behind the topic / creator matches...
    const before = await related('alice', 'hive-cur').expect(200);
    await db().collection('discover-pool').updateOne({ assetPermlink: 'carol-food' }, { $set: { base: 2 } });
    require('../../utils/discoverPool').invalidate();
    // ...but with a real base, the interest multiplier takes it past the same-creator pick.
    const after = await related('alice', 'hive-cur', { interests: 'food' }).expect(200);

    expect(F.permlinks(before.body.videos).pop()).toBe('hive-carol-food');
    expect(F.permlinks(after.body.videos).indexOf('hive-carol-food'))
      .toBeLessThan(F.permlinks(after.body.videos).indexOf('hive-alice-new'));
  });

  test('limit is capped at 40 and trims the rail', async () => {
    await seedWatchPage();
    const capped = await related('alice', 'hive-cur', { limit: 500 }).expect(200);
    const one = await related('alice', 'hive-cur', { limit: 1 }).expect(200);
    expect(capped.body.videos).toHaveLength(3);
    expect(one.body.videos).toHaveLength(1);
    expect(one.body.total).toBe(3);
  });
});

describe('what the rail never shows', () => {
  test('NSFW pool entries and NSFW uploads by the creator need the opt-in', async () => {
    await seedWatchPage();
    await db().collection('discover-pool').updateOne({ assetPermlink: 'bob-music' }, { $set: { nsfw: true } });
    await db().collection('embed-video').updateOne({ permlink: 'alice-new' }, { $set: { isNsfwContent: true } });

    const sfw = await related('alice', 'hive-cur').expect(200);
    const nsfw = await related('alice', 'hive-cur', { nsfw: 'true' }).expect(200);

    expect(F.permlinks(sfw.body.videos)).toEqual(['hive-carol-food']);
    expect(nsfw.body.total).toBe(3);
  });

  test.each([
    ['unlisted', { listed_on_3speak: false }],
    ['hidden from feeds', { hiddenFromFeed: true }],
    ['unavailable', { unavailable: true }],
    ['a short', { short: true }],
    ['not yet on Hive', { hive_permlink: null }],
  ])('the creator\'s own upload is not supplemented when it is %s', async (_label, fields) => {
    await seedWatchPage();
    await db().collection('embed-video').updateOne({ permlink: 'alice-new' }, { $set: fields });

    const res = await related('alice', 'hive-cur').expect(200);

    expect(F.permlinks(res.body.videos)).toEqual(['hive-bob-music', 'hive-carol-food']);
  });

  test('the creator\'s legacy uploads are supplemented too, minus failed publishes', async () => {
    await seedWatchPage();
    await db().collection('videos').insertMany([
      F.legacyVideo({ owner: 'alice', permlink: 'old-ok' }),
      F.legacyVideo({ owner: 'alice', permlink: 'old-failed', publishFailed: true }),
    ]);

    const res = await related('alice', 'hive-cur').expect(200);

    expect(F.permlinks(res.body.videos)).toContain('old-ok');
    expect(F.permlinks(res.body.videos)).not.toContain('old-failed');
  });

  test('dismissed creators and watched videos are removed for the viewer', async () => {
    await seedWatchPage();
    await F.dismissCreator(db(), 'viewer', 'bob');
    await db().collection('watch_history').insertOne(F.watched('viewer', 'carol', 'hive-carol-food'));

    const res = await related('alice', 'hive-cur', { currentuser: 'viewer' }).expect(200);

    expect(F.permlinks(res.body.videos)).toEqual(['hive-alice-new']);
  });
});
