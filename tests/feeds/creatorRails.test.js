/**
 * The creator rails in routes/feeds.js, against a real MongoDB:
 *   /feeds/new-from-following      followed creators with uploads the viewer has not watched
 *   /feeds/suggested-creators      "follow these" (utils/suggestedCreators.js)
 *   /feeds/creator-gated/:username a creator's supporters-only shelf
 */
jest.mock('../../utils/hive', () => require('./_hiveMock').create());

const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const F = require('./_fixtures');
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

describe('/feeds/new-from-following', () => {
  test('a viewer is required', async () => {
    expect((await get('new-from-following').expect(400)).body).toEqual({ error: 'currentuser is required' });
  });

  test('a viewer who follows nobody gets an empty rail', async () => {
    const res = await get('new-from-following', { currentuser: 'loner' }).expect(200);
    expect(res.body).toEqual({ creators: [], days: 7, total_creators: 0, total_items: 0 });
  });

  test('counts each followed creator\'s unwatched shorts and videos, newest activity first', async () => {
    hive.__state.following.set('fan', ['vid', 'shorty', 'idle', 'fan']);
    await embeds().insertMany([
      F.embedVideo({ owner: 'vid', permlink: 'v1', createdAt: F.daysAgo(2) }),
      F.embedVideo({ owner: 'vid', permlink: 'v2', createdAt: F.daysAgo(1) }),
      { ...F.shortVideo({ owner: 'shorty', permlink: 's1', createdAt: F.hoursAgo(3) }), hive_permlink: 'snap-s1' },
      { ...F.shortVideo({ owner: 'shorty', permlink: 's2', createdAt: F.hoursAgo(5) }), hive_permlink: 'snap-s2' },
      F.embedVideo({ owner: 'idle', permlink: 'old', createdAt: F.daysAgo(10) }),       // outside the 7 days
      F.embedVideo({ owner: 'fan', permlink: 'mine' }),                                  // the viewer's own
    ]);
    await videos().insertOne(F.legacyVideo({ owner: 'vid', permlink: 'legacy1', created: F.daysAgo(3) }));
    await db().collection('watch_history').insertOne(F.watched('fan', 'shorty', 'snap-s2'));

    const res = await get('new-from-following', { currentuser: '@Fan' }).expect(200);

    expect(res.body).toMatchObject({ days: 7, total_creators: 2, total_items: 4 });
    expect(res.body.creators).toEqual([
      { username: 'shorty', shorts: 1, videos: 0, total: 1, latest_at: F.hoursAgo(3).toISOString() },
      { username: 'vid', shorts: 0, videos: 3, total: 3, latest_at: F.daysAgo(1).toISOString() },
    ]);
  });

  test('since: only uploads after the "Mark all as seen" moment count; a bad or future value is ignored', async () => {
    hive.__state.following.set('fan', ['vid', 'shorty']);
    await embeds().insertMany([
      F.embedVideo({ owner: 'vid', permlink: 'before', createdAt: F.daysAgo(2) }),
      F.embedVideo({ owner: 'vid', permlink: 'after', createdAt: F.hoursAgo(2) }),
      { ...F.shortVideo({ owner: 'shorty', permlink: 's-before', createdAt: F.daysAgo(3) }), hive_permlink: 'snap-before' },
    ]);
    const since = F.daysAgo(1).toISOString();

    const res = await get('new-from-following', { currentuser: 'fan', since }).expect(200);
    expect(res.body).toMatchObject({ total_creators: 1, total_items: 1 });
    expect(res.body.creators).toEqual([
      { username: 'vid', shorts: 0, videos: 1, total: 1, latest_at: F.hoursAgo(2).toISOString() },
    ]);

    for (const bad of ['nonsense', F.hoursAgo(-5).toISOString()]) {
      const all = await get('new-from-following', { currentuser: 'fan', since: bad }).expect(200);
      expect(all.body.total_items).toBe(3);
    }
  });

  test('visibility follows the feeds: shorts need listed != false, videos need listed == true', async () => {
    hive.__state.following.set('fan', ['maker']);
    await embeds().insertMany([
      { ...F.shortVideo({ owner: 'maker', permlink: 's-nolisted' }), hive_permlink: 'p1' },              // field missing: counts
      { ...F.shortVideo({ owner: 'maker', permlink: 's-unlisted', listed_on_3speak: false }), hive_permlink: 'p2' },
      F.embedVideo({ owner: 'maker', permlink: 'v-nolisted', listed_on_3speak: undefined }),            // does not
      F.embedVideo({ owner: 'maker', permlink: 'v-listed' }),
    ]);

    const [row] = (await get('new-from-following', { currentuser: 'fan' }).expect(200)).body.creators;

    expect(row).toMatchObject({ shorts: 1, videos: 1 });
  });

  test('dismissed creators, house accounts and NSFW are left out', async () => {
    hive.__state.following.set('fan', ['muted', 'threespeak-fixer', 'nsfwer', 'ok']);
    await F.dismissCreator(db(), 'fan', 'muted');
    await embeds().insertMany([
      F.embedVideo({ owner: 'muted', permlink: 'm' }),
      F.embedVideo({ owner: 'threespeak-fixer', permlink: 't' }),
      F.embedVideo({ owner: 'nsfwer', permlink: 'n', hive_tags: ['nsfw'] }),
      F.embedVideo({ owner: 'ok', permlink: 'o' }),
    ]);

    const res = await get('new-from-following', { currentuser: 'fan' }).expect(200);

    expect(res.body.creators.map((c) => c.username)).toEqual(['ok']);
  });

  test.each([
    [{ days: 0 }, 7],
    [{ days: 90 }, 30],
    [{ days: 3 }, 3],
    [{ days: 'x' }, 7],
  ])('days %j is clamped to %i', async (query, days) => {
    hive.__state.following.set('fan', ['someone']);
    expect((await get('new-from-following', { currentuser: 'fan', ...query }).expect(200)).body.days).toBe(days);
  });

  test('limit trims the rail but not the totals', async () => {
    hive.__state.following.set('fan', ['a1', 'a2', 'a3']);
    await embeds().insertMany(['a1', 'a2', 'a3'].map((o, i) => F.embedVideo({ owner: o, permlink: o, createdAt: F.hoursAgo(i + 1) })));
    const res = await get('new-from-following', { currentuser: 'fan', limit: 2 }).expect(200);
    expect(res.body.creators.map((c) => c.username)).toEqual(['a1', 'a2']);
    expect(res.body.total_creators).toBe(3);
  });

  test('a Hive failure is a 500 with a readable error', async () => {
    const logged = F.quietErrors();
    hive.__state.failFollowing = true;
    const res = await get('new-from-following', { currentuser: 'fan' }).expect(500);
    expect(res.body.error).toMatch(/Failed to fetch new uploads/);
    expect(logged).toHaveBeenCalled();
  });
});

describe('/feeds/suggested-creators', () => {
  /** A creator who uploads `topic` content (30d topic board) with some engagement. */
  async function seedCreator(user, topic, { views = 100, uploads = 3 } = {}) {
    await db().collection('leaderboard-topics-v2').insertOne({ window: '30d', topic, user, video_uploads: uploads });
    await embeds().insertOne(F.embedVideo({ owner: user, permlink: `${user}-v`, views, createdAt: F.daysAgo(2) }));
  }

  test('no interests is an empty rail', async () => {
    const res = await get('suggested-creators').expect(200);
    expect(res.body).toEqual({ success: true, feed: 'suggested-creators', interests: [], creators: [] });
  });

  test('suggests interest-matching creators by engagement, never the viewer', async () => {
    await seedCreator('bigmusic', 'music', { views: 1000 });
    await seedCreator('smallmusic', 'music', { views: 10 });
    await seedCreator('gamer', 'gaming', { views: 5000 });
    await seedCreator('me', 'music', { views: 99999 });

    const res = await get('suggested-creators', { interests: 'music', currentuser: 'me' }).expect(200);

    expect(res.body).toMatchObject({ success: true, interests: ['music'], count: 2 });
    expect(res.body.creators.map((c) => c.author)).toEqual(['bigmusic', 'smallmusic']);
    expect(res.body.creators[0]).toMatchObject({ basisTopic: 'music', display_name: 'bigmusic', avatar: 'https://images.hive.blog/u/bigmusic/avatar' });
  });

  test('limit is clamped to the configured maximum', async () => {
    await seedCreator('one', 'music');
    const res = await get('suggested-creators', { interests: 'music', limit: 1000 }).expect(200);
    expect(res.body.count).toBe(1);
  });
});

describe('/feeds/creator-gated/:username', () => {
  test.each(['ab', 'UPPER_case!', 'x'.repeat(17)])('rejects the invalid username %p', async (name) => {
    const res = await get(`creator-gated/${encodeURIComponent(name)}`).expect(400);
    expect(res.body).toEqual({ error: 'invalid username', videos: [] });
  });

  test('lists the creator\'s supporters-only videos newest first, by uploader or Hive author', async () => {
    await embeds().insertMany([
      F.embedVideo({ owner: 'maker', permlink: 'g-old', gated: true, createdAt: F.daysAgo(3) }),
      F.embedVideo({ owner: 'app-account', hive_author: 'maker', permlink: 'g-new', gated: true, createdAt: F.hoursAgo(1) }),
      F.embedVideo({ owner: 'maker', permlink: 'public' }),
      F.embedVideo({ owner: 'maker', permlink: 'g-gone', gated: true, unavailable: true }),
      F.embedVideo({ owner: 'maker', permlink: 'g-draft', gated: true, status: 'encoding' }),
      F.embedVideo({ owner: 'other', permlink: 'g-other', gated: true }),
    ]);

    const res = await get('creator-gated/@Maker').expect(200);

    expect(res.body.count).toBe(2);
    expect(F.permlinks(res.body.videos)).toEqual(['hive-g-new', 'hive-g-old']);
    expect(res.body.videos.every((v) => v.gated === true)).toBe(true);
  });

  test('a creator with nothing gated gets an empty list, not a 404', async () => {
    expect((await get('creator-gated/nobody').expect(200)).body).toEqual({ videos: [], count: 0 });
  });

  test('limit is capped at 100', async () => {
    await embeds().insertMany(Array.from({ length: 3 }, (_, i) => F.embedVideo({ owner: 'maker', permlink: `g${i}`, gated: true })));
    expect((await get('creator-gated/maker', { limit: 2 }).expect(200)).body.count).toBe(2);
    expect((await get('creator-gated/maker', { limit: 100000 }).expect(200)).body.count).toBe(3);
  });
});

describe('the card mapper', () => {
  test('transformEmbedVideoToLegacy keeps the gated flag as a strict boolean', () => {
    const { transformEmbedVideoToLegacy } = require('../../routes/feeds').__testables;
    expect(transformEmbedVideoToLegacy(F.embedVideo({ gated: 'yes' })).gated).toBe(false);
    expect(transformEmbedVideoToLegacy(F.embedVideo({ gated: true })).gated).toBe(true);
    expect(transformEmbedVideoToLegacy(F.embedVideo({ thumbnail_url: null, manifest_cid: null }))).toMatchObject({
      images: { thumbnail: 'https://img.3speak.tv/asset-1/thumbnail.png' },
      spkvideo: { play_url: null },
    });
  });
});
