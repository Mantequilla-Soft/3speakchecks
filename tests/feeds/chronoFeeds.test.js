/**
 * The simple feeds in routes/feeds.js, against a real MongoDB:
 *   /feeds/new          newest first, legacy + embed merged (via utils/feedPools.js)
 *   /feeds/trending     legacy `trending: true`, paginated in Mongo
 *   /feeds/recommended  legacy `recommended: true`, paginated in Mongo
 *   /feeds/promoted     embed videos with a promotion still running
 *   /feeds/firstUploads a creator's very first upload
 *
 * Every one of them must hide the same things: unpublished, unlisted, banned, NSFW
 * (unless opted in), unavailable, author-hidden, moderation-hidden, the house
 * accounts in HIDDEN_AUTHORS, and the viewer's own dismissals.
 */
jest.mock('../../utils/hive', () => require('./_hiveMock').create());

const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const F = require('./_fixtures');
const { NEW_POOL_CACHE_MS, NEW_POOL_SIZE } = require('../../utils/config');
const hive = require('../../utils/hive');

const db = testDb.use();
const app = buildApp(['/feeds', require('../../routes/feeds')]);
const get = (path, query = {}) => request(app).get(`/feeds/${path}`).query(query);
const videos = () => db().collection('videos');
const embeds = () => db().collection('embed-video');

beforeEach(async () => {
  F.pinClock();
  hive.__reset();
  await F.resetFeedCaches(db());
});
afterEach(() => jest.useRealTimers());

// Variations that must keep a doc out of every feed. Functions, so dates come from
// the pinned clock. `legacy` applies to `videos`, `embed` to `embed-video`.
const EXCLUDED = [
  ['unpublished', { status: 'draft' }, { status: 'encoding' }],
  ['banned', { banned: true }, { banned: true }],
  ['flagged NSFW', { isNsfwContent: true }, { isNsfwContent: true }],
  ['tagged nsfw', { tags_v2: ['nsfw'] }, { hive_tags: ['NSFW'] }],
  ['unavailable', { unavailable: true }, { unavailable: true }],
  ['hidden from feeds by its author', { hiddenFromFeed: true }, { hiddenFromFeed: true }],
  ['by a house account', { owner: 'threespeak-fixer' }, { owner: 'threespeak-fixer', hive_author: 'threespeak-fixer' }],
  ['older than the global age bound', () => ({ created: F.daysAgo(7 * 365) }), () => ({ createdAt: F.daysAgo(7 * 365) })],
];
const fields = (f) => (typeof f === 'function' ? f() : f);

describe('/feeds/new', () => {
  test('merges legacy and embed videos, newest first, without internal fields', async () => {
    await videos().insertMany([
      F.legacyVideo({ owner: 'leo', permlink: 'l-old', created: F.hoursAgo(5) }),
      F.legacyVideo({ owner: 'leo', permlink: 'l-new', created: F.hoursAgo(1) }),
    ]);
    await embeds().insertOne(F.embedVideo({ owner: 'em', permlink: 'e-mid', createdAt: F.hoursAgo(3) }));

    const res = await get('new').expect(200);

    expect(res.body).toMatchObject({ success: true, feed: 'new', page: 1, limit: 50, total: 3, totalPages: 1 });
    expect(F.permlinks(res.body.videos)).toEqual(['l-new', 'hive-e-mid', 'l-old']);
    for (const v of res.body.videos) {
      expect(v).not.toHaveProperty('_sortDate');
      expect(v).not.toHaveProperty('_source');
    }
    expect(res.body.videos[1]).toMatchObject({ owner: 'em', author: 'em', title: 'Title e-mid', tags_v2: [] });
  });

  test.each(EXCLUDED)('a video that is %s is never listed', async (_label, legacyFields, embedFields) => {
    await videos().insertMany([
      F.legacyVideo({ permlink: 'l-keep' }),
      F.legacyVideo({ permlink: 'l-drop', ...fields(legacyFields) }),
    ]);
    await embeds().insertMany([
      F.embedVideo({ permlink: 'e-keep' }),
      F.embedVideo({ permlink: 'e-drop', ...fields(embedFields) }),
    ]);

    const res = await get('new').expect(200);

    expect(F.permlinks(res.body.videos).sort()).toEqual(['hive-e-keep', 'l-keep']);
  });

  test.each([
    ['unlisted', { listed_on_3speak: false }],
    ['missing the listed flag', { listed_on_3speak: undefined }],
    ['a short', { short: true }],
    ['not linked to a Hive post', { hive_permlink: null }],
  ])('an embed video that is %s is not a /new item', async (_label, over) => {
    await embeds().insertOne(F.embedVideo({ permlink: 'e', ...over }));
    expect((await get('new').expect(200)).body.total).toBe(0);
  });

  test.each([
    ['a first upload', { firstUpload: true }],
    ['trending', { trending: true }],
    ['a failed publish', { publishFailed: true }],
  ])('a legacy video that is %s belongs to another feed', async (_label, over) => {
    await videos().insertOne(F.legacyVideo(over));
    expect((await get('new').expect(200)).body.total).toBe(0);
  });

  test('nsfw=true lets tagged and flagged videos through, but never banned ones', async () => {
    await videos().insertMany([
      F.legacyVideo({ permlink: 'a', isNsfwContent: true }),
      F.legacyVideo({ permlink: 'b', banned: true }),
    ]);
    await embeds().insertOne(F.embedVideo({ permlink: 'c', hive_tags: ['nsfw'] }));

    const res = await get('new', { nsfw: 'true' }).expect(200);

    expect(F.permlinks(res.body.videos).sort()).toEqual(['a', 'hive-c']);
  });

  test('an embed video that is also indexed as a legacy video is listed once', async () => {
    await videos().insertOne(F.legacyVideo({ owner: 'dup', permlink: 'hive-same' }));
    await embeds().insertOne(F.embedVideo({ owner: 'dup', permlink: 'same' }));
    const res = await get('new').expect(200);
    expect(res.body.total).toBe(1);
  });

  test('a viewer\'s dismissed creator is dropped, and watched videos stay with hidewatched=0', async () => {
    await videos().insertMany([F.legacyVideo({ owner: 'meh', permlink: 'x' }), F.legacyVideo({ owner: 'ok', permlink: 'y' })]);
    await F.dismissCreator(db(), 'viewer', 'meh');
    await db().collection('watch_history').insertOne(F.watched('viewer', 'ok', 'y'));

    const res = await get('new', { currentuser: 'viewer', hidewatched: 0 }).expect(200);

    expect(F.permlinks(res.body.videos)).toEqual(['y']);
  });

  test('a moderation-hidden creator vanishes from the cached pool immediately', async () => {
    await videos().insertMany([F.legacyVideo({ owner: 'bad', permlink: 'b1' }), F.legacyVideo({ owner: 'good', permlink: 'g1' })]);
    await embeds().insertOne(F.embedVideo({ owner: 'bad', permlink: 'b2' }));
    expect((await get('new').expect(200)).body.total).toBe(3);

    await F.hideCreator(db(), 'bad');

    expect(F.permlinks((await get('new').expect(200)).body.videos)).toEqual(['g1']);
  });

  test('pagination slices the merged list', async () => {
    const docs = Array.from({ length: 5 }, (_, i) => F.legacyVideo({ permlink: `p${i}`, created: F.hoursAgo(i + 1) }));
    await videos().insertMany(docs);

    const res = await get('new', { limit: 2, page: 2 }).expect(200);

    expect(res.body).toMatchObject({ total: 4, totalPages: 2, page: 2, limit: 2 });
    expect(F.permlinks(res.body.videos)).toEqual(['p2', 'p3']);
  });

  test('a page deeper than the shared pool is read straight from Mongo', async () => {
    const docs = Array.from({ length: 3 }, (_, i) => F.legacyVideo({ permlink: `deep${i}`, created: F.hoursAgo(i + 1) }));
    await videos().insertMany(docs);
    const page = Math.ceil((NEW_POOL_SIZE + 1) / 100) + 1;   // (page-1)*100+100 > NEW_POOL_SIZE

    const res = await get('new', { limit: 100, page }).expect(200);

    expect(res.body).toMatchObject({ total: 3, page, videos: [] });
  });

  test('a new upload appears within one pool refresh (stale-while-revalidate)', async () => {
    await videos().insertOne(F.legacyVideo({ permlink: 'first' }));
    expect((await get('new').expect(200)).body.total).toBe(1);

    await videos().insertOne(F.legacyVideo({ permlink: 'second', created: F.hoursAgo(0.5) }));
    expect((await get('new').expect(200)).body.total).toBe(1);        // fresh pool: cached

    F.advanceClock(NEW_POOL_CACHE_MS);
    expect((await get('new').expect(200)).body.total).toBe(1);        // stale: served at once...
    await F.waitFor(async () => (await get('new')).body.total === 2);  // ...refreshed behind it
    expect(F.permlinks((await get('new').expect(200)).body.videos)).toEqual(['second', 'first']);
  });
});

describe.each([
  ['trending', { trending: true }],
  ['recommended', { recommended: true }],
])('/feeds/%s', (feed, flag) => {
  test('lists flagged legacy videos newest first, paginated in Mongo with an exact total', async () => {
    await videos().insertMany([
      F.legacyVideo({ permlink: 'a', created: F.hoursAgo(3), ...flag }),
      F.legacyVideo({ permlink: 'b', created: F.hoursAgo(1), ...flag }),
      F.legacyVideo({ permlink: 'c', created: F.hoursAgo(2), ...flag }),
      F.legacyVideo({ permlink: 'unflagged' }),
    ]);

    const p1 = await get(feed, { limit: 2 }).expect(200);
    const p2 = await get(feed, { limit: 2, page: 2 }).expect(200);

    expect(p1.body).toMatchObject({ success: true, feed, total: 3, totalPages: 2 });
    expect(F.permlinks(p1.body.videos)).toEqual(['b', 'c']);
    expect(F.permlinks(p2.body.videos)).toEqual(['a']);
  });

  test.each(EXCLUDED)('a flagged video that is %s is excluded from the page AND the total', async (_l, legacyFields) => {
    await videos().insertMany([
      F.legacyVideo({ permlink: 'keep', ...flag }),
      F.legacyVideo({ permlink: 'drop', ...flag, ...fields(legacyFields) }),
    ]);
    const res = await get(feed).expect(200);
    expect(res.body.total).toBe(1);
    expect(F.permlinks(res.body.videos)).toEqual(['keep']);
  });

  test('dismissals are applied in the query, so pages stay full and the total stays right', async () => {
    await videos().insertMany([
      F.legacyVideo({ owner: 'nope', permlink: 'n1', ...flag }),
      F.legacyVideo({ owner: 'yes', permlink: 'y1', ...flag }),
      F.legacyVideo({ owner: 'yes', permlink: 'y2', ...flag }),
    ]);
    await F.dismissCreator(db(), 'viewer', 'nope');
    await F.dismissVideo(db(), 'viewer', 'yes', 'y2');

    const res = await get(feed, { currentuser: 'viewer' }).expect(200);

    expect(res.body.total).toBe(1);
    expect(F.permlinks(res.body.videos)).toEqual(['y1']);
  });

  test('a moderation-hidden creator is excluded', async () => {
    await videos().insertMany([F.legacyVideo({ owner: 'hid', permlink: 'h', ...flag }), F.legacyVideo({ owner: 'vis', permlink: 'v', ...flag })]);
    await F.hideCreator(db(), 'hid');
    expect(F.permlinks((await get(feed).expect(200)).body.videos)).toEqual(['v']);
  });
});

describe('/feeds/promoted', () => {
  test('lists running promotions, the one expiring soonest first', async () => {
    await embeds().insertMany([
      F.embedVideo({ permlink: 'late', promotedUntil: F.hoursFromNow(48) }),
      F.embedVideo({ permlink: 'soon', promotedUntil: F.hoursFromNow(2) }),
      F.embedVideo({ permlink: 'over', promotedUntil: F.hoursAgo(1) }),
      F.embedVideo({ permlink: 'never' }),
    ]);

    const res = await get('promoted').expect(200);

    expect(res.body).toMatchObject({ success: true, feed: 'promoted', limit: 20, total: 2 });
    expect(F.permlinks(res.body.videos)).toEqual(['hive-soon', 'hive-late']);
    expect(res.body.videos[0]).toMatchObject({ promoted: true, author: 'alice' });
  });

  test.each(EXCLUDED)('a promotion for a video that is %s is not shown', async (_l, _legacy, embedFields) => {
    await embeds().insertMany([
      F.embedVideo({ permlink: 'keep', promotedUntil: F.hoursFromNow(5) }),
      F.embedVideo({ permlink: 'drop', promotedUntil: F.hoursFromNow(5), ...fields(embedFields) }),
    ]);
    expect(F.permlinks((await get('promoted').expect(200)).body.videos)).toEqual(['hive-keep']);
  });

  test('limit is capped at 50', async () => {
    expect((await get('promoted', { limit: 999 }).expect(200)).body.limit).toBe(50);
  });

  test('a watched promotion is filtered by the Hive author too, when the uploader differs', async () => {
    // Uploaded by an app account on behalf of the Hive author.
    await embeds().insertOne(F.embedVideo({ owner: 'uploader-app', hive_author: 'realauthor', permlink: 'p', promotedUntil: F.hoursFromNow(3) }));
    await db().collection('watch_history').insertOne(F.watched('viewer', 'realauthor', 'hive-p'));

    const res = await get('promoted', { currentuser: 'viewer' }).expect(200);

    expect(res.body.videos).toEqual([]);
  });
});

describe('/feeds/firstUploads', () => {
  test('a legacy first upload is listed; a trending one is not', async () => {
    await videos().insertMany([
      F.legacyVideo({ owner: 'newbie', permlink: 'hello', firstUpload: true }),
      F.legacyVideo({ owner: 'star', permlink: 'boom', firstUpload: true, trending: true }),
    ]);
    const res = await get('firstUploads').expect(200);
    expect(F.permlinks(res.body.videos)).toEqual(['hello']);
    expect(res.body.videos[0]).not.toHaveProperty('_rankScore');
  });

  test('an embed creator counts only while they have exactly one listed upload and no legacy history', async () => {
    await embeds().insertMany([
      F.embedVideo({ owner: 'fresh', permlink: 'only-one' }),
      F.embedVideo({ owner: 'busy', permlink: 'one' }),
      F.embedVideo({ owner: 'busy', permlink: 'two' }),
      F.embedVideo({ owner: 'veteran', permlink: 'new-era' }),
    ]);
    await videos().insertOne(F.legacyVideo({ owner: 'veteran', permlink: 'ancient', status: 'deleted' }));

    const res = await get('firstUploads').expect(200);

    expect(F.permlinks(res.body.videos)).toEqual(['hive-only-one']);
    expect(res.body.videos[0]).toMatchObject({ firstUpload: true, owner: 'fresh' });
  });

  test('newest first by default, dismissals and watched applied for the viewer', async () => {
    await videos().insertMany([
      F.legacyVideo({ owner: 'a1', permlink: 'old', firstUpload: true, created: F.daysAgo(3) }),
      F.legacyVideo({ owner: 'a2', permlink: 'new', firstUpload: true, created: F.hoursAgo(1) }),
      F.legacyVideo({ owner: 'a3', permlink: 'mid', firstUpload: true, created: F.daysAgo(1) }),
    ]);

    const all = await get('firstUploads').expect(200);
    await F.dismissCreator(db(), 'viewer', 'a3');
    const mine = await get('firstUploads', { currentuser: 'viewer' }).expect(200);

    expect(F.permlinks(all.body.videos)).toEqual(['new', 'mid', 'old']);
    expect(F.permlinks(mine.body.videos)).toEqual(['new', 'old']);
  });
});
