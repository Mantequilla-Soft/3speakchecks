/**
 * How a video's topic is decided and matched to a viewer's interests:
 *   utils/interests.js     parse ?interests=, tiers (exact / sibling), tag matching
 *   utils/effectiveTags.js the ONE winning topic per video (viewer votes + auto tags)
 *   utils/topicTag.js      the display topic (`tag_v2`) on cards
 * The batch readers run against a real MongoDB.
 */
const testDb = require('../helpers/db');
const {
  parseInterests, normalizeTags, tagsMatchInterests, resolveInterestTiers, interestMatchTier,
  interestTierForTag, interestTierMultiplier, fetchTranscriptionTags,
} = require('../../utils/interests');
const { pickWinner, fetchAutoTagsOrdered, fetchViewerWeights, getWinners, AUTO_TAG_WEIGHT } = require('../../utils/effectiveTags');
const { attachTopicTags, V2_SLUGS } = require('../../utils/topicTag');
const F = require('./_fixtures');

const db = testDb.use();
const set = (...xs) => new Set(xs);

describe('parseInterests', () => {
  test.each([
    [{}, []],
    [{ interests: '' }, []],
    [{ interests: ' Music , ,ART,music ' }, ['music', 'art']],
    [{ interests: ['Food', ' travel '] }, ['food', 'travel']],
  ])('%j -> %j', (query, expected) => {
    expect([...parseInterests({ query })]).toEqual(expected);
  });

  test('a request without a query is no interests', () => {
    expect(parseInterests(null).size).toBe(0);
  });
});

describe('normalizeTags and tagsMatchInterests', () => {
  test('accepts a comma string or an array, strips # and case', () => {
    expect([...normalizeTags('#Music, Art ,')]).toEqual(['music', 'art']);
    expect([...normalizeTags(['#Food', 42])]).toEqual(['food', '42']);
    expect(normalizeTags(null).size).toBe(0);
  });

  test('own tags or transcription tags can match; no interests never match', () => {
    expect(tagsMatchInterests(set('music'), null, set('music'))).toBe(true);
    expect(tagsMatchInterests(set(), set('art'), set('art'))).toBe(true);
    expect(tagsMatchInterests(set('music'), set('art'), set('food'))).toBe(false);
    expect(tagsMatchInterests(set('music'), null, set())).toBe(false);
    expect(tagsMatchInterests(set('music'), null, null)).toBe(false);
  });
});

describe('interest tiers', () => {
  test('a TOPIC pick selects itself; its category and siblings are adjacent', () => {
    const tiers = resolveInterestTiers(set('technology'));
    expect([...tiers.selected]).toEqual(['technology']);
    expect([...tiers.adjacent].sort()).toEqual(['education', 'programming', 'science', 'tech-science']);
    expect(tiers.any).toBe(true);
  });

  test('a CATEGORY pick selects everything under it and adds no adjacents', () => {
    const tiers = resolveInterestTiers(set('Tech-Science'));
    expect([...tiers.selected].sort()).toEqual(['education', 'programming', 'science', 'tech-science', 'technology']);
    expect(tiers.adjacent.size).toBe(0);
  });

  test('a selected topic is never also adjacent, and unknown picks are just selected', () => {
    const tiers = resolveInterestTiers(set('music', 'gaming', 'not-a-topic'));
    expect(tiers.selected.has('not-a-topic')).toBe(true);
    expect(tiers.adjacent.has('gaming')).toBe(false);
    expect(tiers.adjacent.has('comedy')).toBe(true);
  });

  test('no picks: nothing matches', () => {
    const tiers = resolveInterestTiers(undefined);
    expect(tiers.any).toBe(false);
    expect(interestMatchTier(set('music'), null, tiers)).toBeNull();
    expect(interestTierForTag('music', tiers)).toBeNull();
  });

  test.each([
    [set('technology'), null, 'exact'],
    [set(), set('science'), 'sibling'],
    [set('food'), set('travel'), null],
  ])('a video tagged %p / transcribed %p is a %p match for "technology"', (own, transcribed, tier) => {
    expect(interestMatchTier(own, transcribed, resolveInterestTiers(set('technology')))).toBe(tier);
  });

  test('a single winning tag maps to a tier and a multiplier', () => {
    const tiers = resolveInterestTiers(set('technology'));
    const mults = { exact: 3, sibling: 1.8 };
    expect(interestTierForTag('TECHNOLOGY', tiers)).toBe('exact');
    expect(interestTierForTag('science', tiers)).toBe('sibling');
    expect(interestTierForTag(null, tiers)).toBeNull();
    expect(['exact', 'sibling', null].map((t) => interestTierMultiplier(t, mults))).toEqual([3, 1.8, 1]);
  });
});

describe('pickWinner: one topic per video', () => {
  test.each([
    ['nothing known', [], {}, null],
    ['the first auto tag, when nobody voted', ['music', 'art'], {}, 'music'],
    ['a strong viewer vote beats the auto tags', ['music', 'art'], { food: AUTO_TAG_WEIGHT + 1 }, 'food'],
    ['votes add to an auto tag', ['music', 'art'], { art: 50 }, 'art'],
    ['equal weight: a voted tag beats a pure auto tag', ['music'], { art: AUTO_TAG_WEIGHT }, 'art'],
    ['equal weight, no votes: name order', [], { zebra: 5, apple: 5 }, 'apple'],
    ['a duplicate auto tag keeps its first position', ['art', 'music', 'art'], {}, 'art'],
  ])('%s', (_label, auto, votes, winner) => {
    expect(pickWinner(auto, votes)).toBe(winner);
  });
});

describe('batch readers (MongoDB)', () => {
  test('fetchAutoTagsOrdered: one query, keys deduplicated and lowercased, tags in tagger order', async () => {
    await db().collection('subtitles-tags').insertMany([
      { author: 'alice', permlink: 'a1', tags: ' Music, ART ,' },
      { author: 'bob', permlink: 'b1', tags: '' },
    ]);
    const map = await fetchAutoTagsOrdered(db(), [
      { author: '@Alice', permlink: 'a1' }, { author: 'alice', permlink: 'a1' }, { author: 'bob', permlink: 'b1' }, null, { author: 'x' },
    ]);
    expect([...map.entries()]).toEqual([['alice/a1', ['music', 'art']], ['bob/b1', []]]);
    expect((await fetchAutoTagsOrdered(db(), [])).size).toBe(0);
  });

  test('fetchViewerWeights: sums each tag\'s vote weights, a missing or zero weight still counts as 1', async () => {
    await db().collection('viewer-tags').insertMany([
      { author: 'alice', permlink: 'a1', voter: 'v1', 'viewer-tag': 'music', weight: 6000 },
      { author: 'alice', permlink: 'a1', voter: 'v2', 'viewer-tag': 'music', weight: -4000 },
      { author: 'alice', permlink: 'a1', voter: 'v3', 'viewer-tag': 'art' },
      { author: 'alice', permlink: 'a1', voter: 'v4', 'viewer-tag': 'art', weight: 0 },
      { author: 'alice', permlink: 'other', voter: 'v1', 'viewer-tag': 'food', weight: 10 },
    ]);
    const map = await fetchViewerWeights(db(), [{ author: 'ALICE', permlink: 'a1' }, { author: 'alice', permlink: 'a1' }]);
    expect(map.get('alice/a1')).toEqual({ music: 10000, art: 2 });
    expect(map.has('alice/other')).toBe(false);
    expect((await fetchViewerWeights(db(), [{}])).size).toBe(0);
  });

  test('fetchTranscriptionTags: a Set of tags per author/permlink', async () => {
    await db().collection('subtitles-tags').insertOne({ author: 'alice', permlink: 'a1', tags: 'Music, art' });
    const map = await fetchTranscriptionTags(db(), [{ author: 'alice', permlink: 'a1' }, { author: 'alice', permlink: 'a1' }, {}]);
    expect([...map.get('alice/a1')]).toEqual(['music', 'art']);
    expect((await fetchTranscriptionTags(db(), null)).size).toBe(0);
  });

  test('getWinners resolves each video by its own asset and Hive keys', async () => {
    await db().collection('subtitles-tags').insertOne({ author: 'alice', permlink: 'asset', tags: 'music' });
    await db().collection('viewer-tags').insertOne({ author: 'alice', permlink: 'hive-post', voter: 'v', 'viewer-tag': 'travel', weight: 10000 });
    const v = { owner: 'alice', asset: 'asset', permlink: 'hive-post' };
    const plain = { owner: 'bob', asset: 'x', permlink: 'y' };

    const winners = await getWinners(db(), [v, plain], (x) => ({ author: x.owner, permlink: x.asset }), (x) => ({ author: x.owner, permlink: x.permlink }));

    expect(winners.get(v)).toBe('travel');      // a full vote ties the auto tag; the voted one wins
    expect(winners.get(plain)).toBeNull();
    expect((await getWinners(db(), [], () => ({}), () => ({}))).size).toBe(0);
  });
});

describe('attachTopicTags: the display topic on a card', () => {
  const autoKey = (v) => ({ author: v.owner, permlink: v.asset });
  const hiveKey = (v) => ({ author: v.owner, permlink: v.permlink });

  test('the tagger\'s best v2 tag, overridden by the viewers\' choice when it is a v2 slug', async () => {
    await db().collection('subtitles-tags').insertMany([
      { author: 'alice', permlink: 'a1', tags_list_v2: ['Music', 'art'] },
      { author: 'bob', permlink: 'b1', tags_v2: 'food,travel' },
    ]);
    await db().collection('viewer-tags').insertMany([
      { author: 'bob', permlink: 'hb', voter: 'v1', 'viewer-tag': 'tutorial', weight: 10000 },   // retired v1 slug: ignored
      { author: 'bob', permlink: 'hb', voter: 'v2', 'viewer-tag': 'travel', weight: 1 },
      { author: 'carl', permlink: 'hc', voter: 'v1', 'viewer-tag': 'pets', weight: 5 },
      { author: 'carl', permlink: 'hc', voter: 'v2', 'viewer-tag': 'nature', weight: 5 },       // tie: name order
    ]);
    const items = [
      { owner: 'alice', asset: 'a1', permlink: 'ha' },
      { owner: 'bob', asset: 'b1', permlink: 'hb' },
      { owner: 'carl', asset: 'c1', permlink: 'hc' },
      { owner: 'dora', asset: null, permlink: 'hd' },
    ];

    await attachTopicTags(db(), items, autoKey, hiveKey);

    expect(items.map((v) => [v.tag_v2, v.tag_v2_source])).toEqual([
      ['music', 'auto'], ['travel', 'viewer'], ['nature', 'viewer'], [undefined, undefined],
    ]);
    expect(items[1].tags_v2_auto).toEqual(['food', 'travel']);
  });

  test('an empty list is returned as is', async () => {
    const empty = [];
    expect(await attachTopicTags(db(), empty, autoKey, hiveKey)).toBe(empty);
    expect(await attachTopicTags(db(), null, autoKey, hiveKey)).toBeNull();
  });

  test('a failure is logged and leaves the cards untouched: decoration never breaks a feed', async () => {
    const logged = F.quietErrors();
    const items = [{ owner: 'a', asset: 'x', permlink: 'y' }];
    const broken = { collection: () => { throw new Error('mongo down'); } };
    expect(await attachTopicTags(broken, items, autoKey, hiveKey)).toEqual([{ owner: 'a', asset: 'x', permlink: 'y' }]);
    expect(logged).toHaveBeenCalledWith('attachTopicTags failed:', 'mongo down');
  });

  test('the v2 vocabulary has the 7 categories and their topics', () => {
    expect(V2_SLUGS.has('tech-science')).toBe(true);
    expect(V2_SLUGS.has('programming')).toBe(true);
    expect(V2_SLUGS.has('tutorial')).toBe(false);
  });
});
