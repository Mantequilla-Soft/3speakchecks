/**
 * utils/suggestedCreators.js end to end against a real MongoDB: topic membership
 * from `leaderboard-topics-v2` (30d), engagement from the creators' recent videos,
 * comment counts and reshares, the relevance gate, topic diversity, the seeded
 * pick, and the profile enrichment. (tests/suggestedCreators.test.js covers the
 * pure rankCandidates step.)
 */
jest.mock('../../utils/hive', () => require('./_hiveMock').create());

const testDb = require('../helpers/db');
const F = require('./_fixtures');
const { getSuggestedCreators, getRecentCreatorEngagement } = require('../../utils/suggestedCreators');

const db = testDb.use();
const topicRow = (user, topic, uploads = 1) => ({ window: '30d', topic, user, video_uploads: uploads });

beforeEach(async () => {
  F.pinClock();
  await F.resetFeedCaches(db());
});
afterEach(() => jest.useRealTimers());

/** A creator active in `topics` ({topic: uploads}) with one recent video of `views`. */
async function creator(user, topics, views = 100) {
  await db().collection('leaderboard-topics-v2').insertMany(Object.entries(topics).map(([t, n]) => topicRow(user, t, n)));
  await db().collection('embed-video').insertOne(F.embedVideo({ owner: user, permlink: `${user}-v`, views, createdAt: F.daysAgo(3) }));
}
const authors = (list) => list.map((c) => c.author);

describe('getRecentCreatorEngagement', () => {
  test('sums views, comments and reshares over each creator\'s last 30 days, keeping the most viewed as a sample', async () => {
    await db().collection('embed-video').insertMany([
      F.embedVideo({ owner: 'alice', permlink: 'a1', views: 10, hive_title: 'Small' }),
      F.embedVideo({ owner: 'alice', permlink: 'a2', views: 90, hive_title: 'Big', thumbnail_url: null }),
      F.embedVideo({ owner: 'alice', permlink: 'old', views: 1000, createdAt: F.daysAgo(31) }),
      F.embedVideo({ owner: 'alice', permlink: 'gone', views: 1000, unavailable: true }),
      F.embedVideo({ owner: 'alice', permlink: 'short', views: 1000, short: true }),
    ]);
    await db().collection('videos').insertOne(F.legacyVideo({ owner: 'bob', permlink: 'b1', views: 5, thumbnail: 'https://t/b1.png' }));
    await db().collection('video-comment-counts').insertOne({ _id: 'alice/hive-a1', comments: 4 });
    await db().collection('reshares').insertMany([{ author: 'alice', permlink: 'hive-a2' }, { author: 'alice', permlink: 'hive-a2' }]);

    const map = await getRecentCreatorEngagement(db());

    expect(map.get('alice')).toMatchObject({ views: 100, comments: 4, reshares: 2, videoCount: 2 });
    expect(map.get('alice').sample).toMatchObject({ permlink: 'hive-a2', title: 'Big', thumbnail: 'https://img.3speak.tv/a2/thumbnail.png' });
    expect(map.get('bob')).toMatchObject({ views: 5, videoCount: 1, sample: { permlink: 'b1', thumbnail: 'https://t/b1.png' } });
  });

  // The reshare tally groups on the RAW author and only lowercases on the way into
  // a Map (utils/suggestedCreators.js:64 and :69), so `Alice/x` and `alice/x` become two
  // groups and the second silently overwrites the first. utils/curation.js documents
  // this exact trap and groups on $toLower for that reason.
  test('reshares whose author differs only in case add up instead of overwriting each other', async () => {
    await db().collection('embed-video').insertOne(F.embedVideo({ owner: 'alice', permlink: 'a2', views: 1 }));
    await db().collection('reshares').insertMany([{ author: 'Alice', permlink: 'hive-a2' }, { author: 'alice', permlink: 'hive-a2' }]);
    expect((await getRecentCreatorEngagement(db())).get('alice').reshares).toBe(2);
  });

  test('is cached; force rebuilds it', async () => {
    await db().collection('embed-video').insertOne(F.embedVideo({ owner: 'alice', permlink: 'a1', views: 1 }));
    await getRecentCreatorEngagement(db());
    await db().collection('embed-video').insertOne(F.embedVideo({ owner: 'carl', permlink: 'c1', views: 1 }));
    expect((await getRecentCreatorEngagement(db())).has('carl')).toBe(false);
    expect((await getRecentCreatorEngagement(db(), { force: true })).has('carl')).toBe(true);
  });
});

describe('getSuggestedCreators', () => {
  test('no interests or an unknown topic suggests nobody', async () => {
    await creator('singer', { music: 3 });
    expect(await getSuggestedCreators(db(), {})).toEqual([]);
    expect(await getSuggestedCreators(db(), { interests: [] })).toEqual([]);
    expect(await getSuggestedCreators(db(), { interests: ['not-a-topic'] })).toEqual([]);
  });

  test('only creators whose DOMINANT topic is an interest: one music video does not make a gamer a music creator', async () => {
    await creator('singer', { music: 3 }, 50);
    await creator('gamer', { gaming: 10, music: 1 }, 9999);

    const out = await getSuggestedCreators(db(), { interests: ['music'] });

    expect(authors(out)).toEqual(['singer']);
    expect(out[0]).toMatchObject({ basisTopic: 'music', matchedTopics: ['music'], views: 50 });
  });

  test('the caller, people they follow, excluded and hidden accounts are never suggested', async () => {
    await creator('me1', { music: 2 });
    await creator('friend', { music: 2 });
    await creator('badadib', { music: 2 });
    await creator('hush', { music: 2 });
    await creator('fresh', { music: 2 });
    await F.hideCreator(db(), 'hush');

    const out = await getSuggestedCreators(db(), { interests: ['music'], excludeUser: '@Me1', followSet: new Set(['friend']) });

    expect(authors(out)).toEqual(['fresh']);
  });

  test('a category interest is shared out across its topics instead of one topic taking the rail', async () => {
    await creator('gamer1', { gaming: 5 }, 900);
    await creator('gamer2', { gaming: 5 }, 800);
    await creator('gamer3', { gaming: 5 }, 700);
    await creator('comic', { comedy: 5 }, 50);

    const out = await getSuggestedCreators(db(), { interests: ['entertainment'], limit: 3 });

    expect(authors(out)).toEqual(['gamer1', 'comic', 'gamer2']);
  });

  test('a seed draws `limit` from a larger pool, deterministically, best score first', async () => {
    for (const [i, user] of ['aa1', 'aa2', 'aa3', 'aa4', 'aa5'].entries()) await creator(user, { music: 2 }, 1000 - i * 100);

    const a = await getSuggestedCreators(db(), { interests: ['music'], limit: 2, pool: 5, seed: 99 });
    const b = await getSuggestedCreators(db(), { interests: ['music'], limit: 2, pool: 5, seed: 99 });
    const top = await getSuggestedCreators(db(), { interests: ['music'], limit: 2 });

    expect(authors(a)).toEqual(authors(b));
    expect(a[0].score).toBeGreaterThanOrEqual(a[1].score);
    expect(authors(top)).toEqual(['aa1', 'aa2']);
  });

  test('tiles carry the Hive profile name and avatar, with fallbacks', async () => {
    await creator('named', { music: 2 }, 10);
    await creator('plain', { music: 2 }, 5);
    await db().collection('hiveprofiles').insertOne({ username: 'named', display_name: 'The Named One', profile_image: 'https://img/named.png' });

    const out = await getSuggestedCreators(db(), { interests: ['music'] });

    expect(out.map((c) => [c.author, c.display_name, c.avatar])).toEqual([
      ['named', 'The Named One', 'https://img/named.png'],
      ['plain', 'plain', 'https://images.hive.blog/u/plain/avatar'],
    ]);
  });

  test('a creator active in the topic with no measurable engagement is not suggested', async () => {
    await creator('silent', { music: 2 }, 0);
    expect(await getSuggestedCreators(db(), { interests: ['music'] })).toEqual([]);
  });
});
