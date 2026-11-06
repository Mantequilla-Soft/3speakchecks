/**
 * The shorts routes (routes/shorts.js) against a real MongoDB:
 *   /shorts             last 7 days, shuffled
 *   /shorts/stories     creators with unseen shorts in the last 3 days (the row above the feeds)
 *   /shorts/:username   one creator's shorts, the profile tab
 *   /shortssorted       the ranked shorts feed (pool in utils/feedPools.js)
 *
 * Every shorts surface hides unlisted, unprocessed, unpublished, unavailable,
 * author-hidden, house-account and moderation-hidden shorts, plus expired stories.
 */
jest.mock('../../utils/hive', () => require('./_hiveMock').create());

const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const { makeSlimFeed, SHORTS_HEAVY_FIELDS } = require('../../utils/slimFeed');
const F = require('./_fixtures');
const { sortedShortsCache } = require('../../utils/cache');
const { getFollowSet } = require('../../utils/followBoost');
const hive = require('../../utils/hive');

const db = testDb.use();
// Mounted like server.js: shorts keep hive_body (it is their caption).
const app = buildApp(['/shortssorted', makeSlimFeed(SHORTS_HEAVY_FIELDS)], ['/', require('../../routes/shorts')]);
const get = (path, query = {}) => request(app).get(path).query(query);
const embeds = () => db().collection('embed-video');
const addShorts = (...docs) => embeds().insertMany(docs);

beforeEach(async () => {
  F.pinClock();
  hive.__reset();
  await F.resetFeedCaches(db());
});
afterEach(() => jest.useRealTimers());

// What keeps a short off every shorts surface. Functions: dates from the pinned clock.
const NEVER_SHOWN = [
  ['unlisted', () => ({ listed_on_3speak: false })],
  ['not processed yet', () => ({ processed: false })],
  ['unpublished', () => ({ status: 'encoding' })],
  ['without an embed_url', () => ({ embed_url: null })],
  ['unavailable', () => ({ unavailable: true })],
  ['hidden from feeds', () => ({ hiddenFromFeed: true })],
  ['NSFW-tagged', () => ({ hive_tags: ['NSFW'] })],
  ['by a house account', () => ({ owner: 'threespeak-fixer', embed_url: '@threespeak-fixer/x' })],
  ['an expired story', () => ({ story: true, story_expires_at: F.hoursAgo(1) })],
];

describe('/shorts', () => {
  test.each(NEVER_SHOWN)('a short that is %s is never shown', async (_label, over) => {
    await addShorts(F.shortVideo({ permlink: 'keep' }), F.shortVideo({ owner: 'bob', permlink: 'drop', embed_url: '@bob/drop', ...over() }));
    const res = await get('/shorts').expect(200);
    expect(F.permlinks(res.body.shorts)).toEqual(['keep']);
  });

  test('only the last seven days, one card per creator + thumbnail, every card badged for listing', async () => {
    await addShorts(
      F.shortVideo({ owner: 'a', permlink: 'new', thumbnail_url: 'same.png', createdAt: F.hoursAgo(1) }),
      F.shortVideo({ owner: 'a', permlink: 'reupload', thumbnail_url: 'same.png', createdAt: F.hoursAgo(2) }),
      F.shortVideo({ owner: 'b', permlink: 'story', story: true, story_expires_at: F.hoursFromNow(3) }),
      F.shortVideo({ owner: 'c', permlink: 'old', createdAt: F.daysAgo(8) }),
    );

    const res = await get('/shorts').expect(200);

    expect(res.body).toMatchObject({ success: true, total: 2, app: 'all' });
    expect(F.permlinks(res.body.shorts).sort()).toEqual(['new', 'story']);
    const story = res.body.shorts.find((s) => s.permlink === 'story');
    expect(story).toMatchObject({ story: true, listed_on_3speak: true, unlisted: false });
    expect(res.body.shorts.find((s) => s.permlink === 'new')).not.toHaveProperty('story');
  });

  test('?app= narrows to one frontend; ?currentuser= drops the creators they dismissed', async () => {
    await addShorts(
      F.shortVideo({ owner: 'a', permlink: 'from-snapie', frontend_app: 'snapie' }),
      F.shortVideo({ owner: 'b', permlink: 'from-3speak' }),
      F.shortVideo({ owner: 'muted', permlink: 'muted-one' }),
    );
    await F.dismissCreator(db(), 'viewer', 'muted');

    expect(F.permlinks((await get('/shorts', { app: 'snapie' }).expect(200)).body.shorts)).toEqual(['from-snapie']);
    const mine = await get('/shorts', { currentuser: 'viewer' }).expect(200);
    expect(F.permlinks(mine.body.shorts).sort()).toEqual(['from-3speak', 'from-snapie']);
  });

  test('pages a shuffled list without repeats', async () => {
    await addShorts(...Array.from({ length: 5 }, (_, i) => F.shortVideo({ owner: `u${i}`, permlink: `s${i}` })));
    const p1 = await get('/shorts', { limit: 3 }).expect(200);
    expect(p1.body).toMatchObject({ total: 5, totalPages: 2 });
    expect(new Set(F.permlinks(p1.body.shorts)).size).toBe(3);
  });
});

describe('/shorts/stories', () => {
  test('creators with shorts in the last three days, most unseen first', async () => {
    await addShorts(
      F.shortVideo({ owner: 'busy', permlink: 'b1', thumbnail_url: '1' }),
      F.shortVideo({ owner: 'busy', permlink: 'b2', thumbnail_url: '2' }),
      F.shortVideo({ owner: 'calm', permlink: 'c1' }),
      F.shortVideo({ owner: 'stale', permlink: 's1', createdAt: F.daysAgo(4) }),
    );

    const res = await get('/shorts/stories').expect(200);

    expect(res.body).toEqual({
      success: true,
      currentUserHasShort: false,
      creators: [{ username: 'busy', unseen_count: 2 }, { username: 'calm', unseen_count: 1 }],
    });
  });

  test('low-reputation authors are left out', async () => {
    hive.reputationCache.set('spammy', { reputation: 10 });
    hive.reputationCache.set('decent', { reputation: 40 });
    await addShorts(
      F.shortVideo({ owner: 'spammy', permlink: 'x' }),
      F.shortVideo({ owner: 'decent', permlink: 'y' }),
    );
    expect((await get('/shorts/stories').expect(200)).body.creators.map((c) => c.username)).toEqual(['decent']);
  });

  test('for a viewer: dismissals always, watched only with hide-watched, own-short and followed flags', async () => {
    hive.__state.following.set('viewer', ['followed']);
    await addShorts(
      F.shortVideo({ owner: 'followed', permlink: 'f1' }),
      F.shortVideo({ owner: 'watchedone', permlink: 'w1' }),
      F.shortVideo({ owner: 'muted', permlink: 'm1' }),
      F.shortVideo({ owner: 'viewer', permlink: 'mine' }),
    );
    await F.dismissCreator(db(), 'viewer', 'muted');
    await db().collection('watch_history').insertOne(F.watched('viewer', 'watchedone', 'snap-w1'));

    const hide = await get('/shorts/stories', { currentuser: 'viewer' }).expect(200);
    const show = await get('/shorts/stories', { currentuser: 'viewer', hidewatched: '0' }).expect(200);

    expect(hide.body.currentUserHasShort).toBe(true);
    expect(hide.body.creators.map((c) => c.username).sort()).toEqual(['followed', 'viewer']);
    expect(hide.body.creators.find((c) => c.username === 'followed').followed).toBe(true);
    expect(show.body.creators.map((c) => c.username).sort()).toEqual(['followed', 'viewer', 'watchedone']);
  });
});

describe('/shorts/:username', () => {
  test('rejects an absurd username', async () => {
    await get(`/shorts/${'x'.repeat(51)}`).expect(400);
  });

  test('the creator\'s shorts, newest first, enriched from Hive', async () => {
    await addShorts(
      F.shortVideo({ owner: 'cr', permlink: 'older', createdAt: F.daysAgo(40) }),   // no time window on a profile
      F.shortVideo({ owner: 'cr', permlink: 'newer', embed_title: 'fallback title' }),
      F.shortVideo({ owner: 'someone', permlink: 'theirs' }),
    );
    hive.__state.rewards.set('cr/snap-newer', { reward: 1, title: 'On Hive', body: 'caption', tags: ['fun'], sound: { id: 's' } });
    hive.__state.live.set('cr/snap-newer', { reward: 2.5, votes: 4, comments: 1, author_reputation: 60 });
    hive.__state.followers.set('cr', 321);

    const res = await get('/shorts/cr').expect(200);

    expect(res.body).toMatchObject({ success: true, total: 2, totalPages: 1 });
    expect(F.permlinks(res.body.shorts)).toEqual(['newer', 'older']);
    expect(res.body.shorts[0]).toMatchObject({
      hive_title: 'On Hive', hive_body: 'caption', hive_tags: ['fun'], hive_sound: { id: 's' },
      hive_reward: 2.5, hive_votes: 4, hive_comments: 1, hive_author_reputation: 60, hive_followers: 321,
    });
    expect(res.body.shorts[1]).toMatchObject({ hive_title: 'Short older', hive_votes: 0, hive_author_reputation: 25 });
  });

  test('unlisted shorts only with include_unlisted (the owner\'s own profile), badged', async () => {
    await addShorts(F.shortVideo({ owner: 'cr', permlink: 'hidden-one', listed_on_3speak: false }));
    expect((await get('/shorts/cr').expect(200)).body).toMatchObject({ total: 0, shorts: [] });
    const own = await get('/shorts/cr', { include_unlisted: '1' }).expect(200);
    expect(own.body.shorts[0]).toMatchObject({ permlink: 'hidden-one', listed_on_3speak: false, unlisted: true });
  });

  test('live stories are listed with their badge; expired ones drop out; story=1 is the live stories alone', async () => {
    await addShorts(
      F.shortVideo({ owner: 'cr', permlink: 'plain' }),
      F.storyVideo({ owner: 'cr', permlink: 'live' }),
      F.storyVideo({ owner: 'cr', permlink: 'expired', story_posted_at: F.hoursAgo(30) }),
    );

    const all = await get('/shorts/cr').expect(200);
    const stories = await get('/shorts/cr', { story: '1' }).expect(200);

    expect(F.permlinks(all.body.shorts).sort()).toEqual(['live', 'plain']);
    expect(all.body.shorts.find((s) => s.permlink === 'live')).toMatchObject({ story: true });
    expect(F.permlinks(stories.body.shorts)).toEqual(['live']);
  });

  test('pagination, and NSFW only with the opt-in', async () => {
    await addShorts(
      ...[1, 2, 3].map((i) => F.shortVideo({ owner: 'cr', permlink: `p${i}`, createdAt: F.hoursAgo(i) })),
      F.shortVideo({ owner: 'cr', permlink: 'spicy', hive_tags: ['nsfw'] }),
    );
    const res = await get('/shorts/cr', { limit: 2, page: 2 }).expect(200);
    expect(res.body).toMatchObject({ total: 3, totalPages: 2 });
    expect(F.permlinks(res.body.shorts)).toEqual(['p3']);
    expect((await get('/shorts/cr', { nsfw: 'true' }).expect(200)).body.total).toBe(4);
  });
});

describe('/shortssorted', () => {
  const sorted = (query = {}) => get('/shortssorted', { seed: 11, ...query });

  test.each(NEVER_SHOWN)('a short that is %s is never ranked', async (_label, over) => {
    await addShorts(F.shortVideo({ permlink: 'keep' }), F.shortVideo({ owner: 'bob', permlink: 'drop', embed_url: '@bob/drop', ...over() }));
    expect(F.permlinks((await sorted()).body.shorts)).toEqual(['keep']);
  });

  test('cards carry the Hive caption and live stats; the window is 30 days', async () => {
    await addShorts(
      F.shortVideo({ owner: 'cr', permlink: 'in' }),
      F.shortVideo({ owner: 'old', permlink: 'out', createdAt: F.daysAgo(31) }),
    );
    hive.__state.rewards.set('cr/snap-in', { reward: 0.5, title: 'T', body: 'the caption', tags: ['x'] });
    hive.__state.live.set('cr/snap-in', { reward: 0.7, votes: 3, comments: 2, author_reputation: 55 });

    const res = await sorted().expect(200);

    expect(res.body).toMatchObject({ success: true, seed: 11, total: 1, app: 'all' });
    expect(res.body.shorts[0]).toMatchObject({
      permlink: 'in', hive_title: 'T', hive_body: 'the caption', hive_reward: 0.7, hive_votes: 3,
      reshare_count: 0, winner_tag: null, listed_on_3speak: true,
    });
  });

  test('low-reputation authors are dropped AFTER dedup', async () => {
    hive.reputationCache.set('spammy', { reputation: 5 });
    await addShorts(F.shortVideo({ owner: 'spammy', permlink: 'x' }), F.shortVideo({ owner: 'ok', permlink: 'y' }));
    expect(F.permlinks((await sorted()).body.shorts)).toEqual(['y']);
  });

  test('back-to-back shorts by the same creator collapse to the first', async () => {
    await addShorts(
      F.shortVideo({ owner: 'solo', permlink: 'one', thumbnail_url: '1' }),
      F.shortVideo({ owner: 'solo', permlink: 'two', thumbnail_url: '2' }),
      F.shortVideo({ owner: 'solo', permlink: 'three', thumbnail_url: '3' }),
    );
    expect((await sorted()).body.total).toBe(1);
  });

  test('a seed gives the same order every time; chrono=1 is newest first', async () => {
    await addShorts(...[1, 2, 3, 4].map((i) => F.shortVideo({ owner: `u${i}`, permlink: `s${i}`, createdAt: F.hoursAgo(i * 30) })));

    const a = await sorted().expect(200);
    sortedShortsCache.clear();
    const b = await sorted().expect(200);
    const chrono = await sorted({ chrono: 'true' }).expect(200);

    expect(F.permlinks(b.body.shorts)).toEqual(F.permlinks(a.body.shorts));
    expect(F.permlinks(chrono.body.shorts)).toEqual(['s1', 's2', 's3', 's4']);
  });

  test('topic= lifts shorts that share the watched video\'s topic', async () => {
    await addShorts(
      F.shortVideo({ owner: 'chef', permlink: 'cooking', createdAt: F.hoursAgo(2) }),
      F.shortVideo({ owner: 'dj', permlink: 'beats', createdAt: F.hoursAgo(2) }),
    );
    await db().collection('subtitles-tags').insertMany([
      { author: 'chef', permlink: 'cooking', tags: 'food' },
      { author: 'dj', permlink: 'beats', tags: 'music' },
    ]);

    const res = await sorted({ topic: 'food' }).expect(200);

    expect(F.permlinks(res.body.shorts)).toEqual(['cooking', 'beats']);
    expect(res.body.shorts[0].winner_tag).toBe('food');
  });

  test('onlyinterests=1 keeps only shorts whose winning topic is an interest', async () => {
    await addShorts(F.shortVideo({ owner: 'chef', permlink: 'cooking' }), F.shortVideo({ owner: 'dj', permlink: 'beats' }), F.shortVideo({ owner: 'x', permlink: 'untagged' }));
    await db().collection('subtitles-tags').insertMany([
      { author: 'chef', permlink: 'cooking', tags: 'food' },
      { author: 'dj', permlink: 'beats', tags: 'music' },
    ]);

    expect(F.permlinks((await sorted({ interests: 'music', onlyinterests: '1' })).body.shorts)).toEqual(['beats']);
    expect((await sorted({ interests: 'music' })).body.total).toBe(3);    // boost, not filter
  });

  test('followedby= is the follow feed: only followed Hive authors, over a 60-day window', async () => {
    hive.__state.following.set('fan', ['Idol']);
    await addShorts(
      F.shortVideo({ owner: 'uploader-app', embed_url: '@idol/clip', permlink: 'by-idol', createdAt: F.daysAgo(45) }),
      F.shortVideo({ owner: 'other', permlink: 'not-followed' }),
    );
    expect(F.permlinks((await sorted({ followedby: '@fan' })).body.shorts)).toEqual(['by-idol']);
    expect((await sorted({ followedby: 'nobody' })).body.shorts).toEqual([]);
  });

  test('live stories lead the feed, a followed creator\'s first', async () => {
    hive.__state.following.set('viewer', ['friend']);
    getFollowSet('viewer');
    await F.flushPromises();
    await addShorts(
      F.shortVideo({ owner: 'popular', permlink: 'regular', createdAt: F.hoursAgo(0.1) }),
      F.storyVideo({ owner: 'stranger', permlink: 'story-a', story_posted_at: F.hoursAgo(1) }),
      F.storyVideo({ owner: 'friend', permlink: 'story-b', story_posted_at: F.hoursAgo(5) }),
    );

    const res = await sorted({ currentuser: 'viewer', hidewatched: '0' }).expect(200);

    expect(F.permlinks(res.body.shorts)).toEqual(['story-b', 'story-a', 'regular']);
    expect(res.body.shorts[0]).toMatchObject({ story: true });
  });

  test('watched shorts move to the END, least recently watched first, rather than vanish', async () => {
    await addShorts(...['a', 'b', 'c'].map((o) => F.shortVideo({ owner: o, permlink: o })));
    await db().collection('watch_history').insertMany([
      F.watched('viewer', 'a', 'snap-a', { last_watched_at: F.hoursAgo(1) }),
      F.watched('viewer', 'b', 'snap-b', { last_watched_at: F.hoursAgo(5) }),
    ]);

    const res = await sorted({ currentuser: 'viewer' }).expect(200);

    expect(F.permlinks(res.body.shorts)).toEqual(['c', 'b', 'a']);
  });

  test('the ranked list is frozen for the session, but a dismissal takes effect at once', async () => {
    await addShorts(F.shortVideo({ owner: 'a', permlink: 'a1' }), F.shortVideo({ owner: 'b', permlink: 'b1' }));
    hive.__state.following.set('viewer', []);
    getFollowSet('viewer');
    await F.flushPromises();
    expect((await sorted({ currentuser: 'viewer' })).body.total).toBe(2);

    await addShorts(F.shortVideo({ owner: 'c', permlink: 'c1' }));          // new short: not in the frozen list
    await F.dismissCreator(db(), 'viewer', 'a');                          // dismissal: live

    const res = await sorted({ currentuser: 'viewer' }).expect(200);
    expect(F.permlinks(res.body.shorts)).toEqual(['b1']);
  });

  test('a cold follow set is not frozen into the cache; a warm one is', async () => {
    await addShorts(F.shortVideo({ owner: 'a', permlink: 'a1' }));
    hive.__state.following.set('newcomer', ['a']);

    await sorted({ currentuser: 'newcomer' }).expect(200);
    expect([...sortedShortsCache.keys()].some((k) => k.includes('user:newcomer'))).toBe(false);

    await F.flushPromises();      // the follow set finished warming in the background
    await sorted({ currentuser: 'newcomer' }).expect(200);
    expect([...sortedShortsCache.keys()].some((k) => k.includes('user:newcomer'))).toBe(true);
  });

  test('a story that expires while the list is cached drops from the page, without shifting later pages', async () => {
    await addShorts(
      F.storyVideo({ owner: 's', permlink: 'ending', story_posted_at: F.hoursAgo(23.9) }),
      F.shortVideo({ owner: 'r', permlink: 'regular' }),
    );
    expect((await sorted()).body.shorts).toHaveLength(2);

    F.advanceClock(10 * 60 * 1000);   // past the story's end, inside the 15-minute list cache

    const res = await sorted().expect(200);
    expect(F.permlinks(res.body.shorts)).toEqual(['regular']);
    expect(res.body.total).toBe(2);
  });

  test('?app= and pagination', async () => {
    await addShorts(
      ...[1, 2, 3].map((i) => F.shortVideo({ owner: `u${i}`, permlink: `s${i}`, frontend_app: 'snapie' })),
      F.shortVideo({ owner: 'z', permlink: 'elsewhere' }),
    );
    const res = await sorted({ app: 'snapie', limit: 2 }).expect(200);
    expect(res.body).toMatchObject({ app: 'snapie', total: 3, totalPages: 2 });
    expect(res.body.shorts).toHaveLength(2);
  });
});
