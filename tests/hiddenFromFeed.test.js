/**
 * The author-controlled "hide from feeds" filter: the match helper, the in-memory
 * predicate, and the authoritative hydrate() drop.
 */
const { hiddenFromFeedMatch, isHiddenFromFeed } = require('../utils/hiddenFromFeed');
const { hydrate } = require('../utils/discoverPool');

describe('hiddenFromFeedMatch', () => {
  test('excludes only hiddenFromFeed:true; the field-less majority still match', () => {
    expect(hiddenFromFeedMatch()).toEqual({ hiddenFromFeed: { $ne: true } });
    // A $ne:true condition matches docs where the field is absent OR false — i.e.
    // every ordinary video — and rejects only the explicitly-hidden ones.
    const cond = hiddenFromFeedMatch().hiddenFromFeed;
    const matches = (v) => v !== true;              // Mongo $ne:true semantics
    expect(matches(undefined)).toBe(true);          // no field → shown
    expect(matches(false)).toBe(true);              // explicit false → shown
    expect(matches(true)).toBe(false);              // hidden → excluded
    expect(cond).toEqual({ $ne: true });
  });
});

describe('isHiddenFromFeed', () => {
  test('true only for the explicit flag', () => {
    expect(isHiddenFromFeed({ hiddenFromFeed: true })).toBe(true);
    expect(isHiddenFromFeed({ hiddenFromFeed: false })).toBe(false);
    expect(isHiddenFromFeed({})).toBe(false);
    expect(isHiddenFromFeed(null)).toBe(false);
    expect(isHiddenFromFeed(undefined)).toBe(false);
  });
});

describe('hydrate() drops hidden videos using the FRESH doc', () => {
  // Minimal db double: hydrate only calls collection(name).find({$or}).toArray().
  const makeDb = (embeds, legacy) => ({
    collection: (name) => ({
      find: () => ({
        toArray: async () => (name === 'embed-video' ? embeds : legacy),
      }),
    }),
  });

  test('an embed video flagged AFTER the pool was built is dropped at hydrate time', async () => {
    const embeds = [
      { owner: 'alice', permlink: 'asset1', hive_author: 'alice', hive_permlink: 'p1', createdAt: new Date() },
      { owner: 'bob', permlink: 'asset2', hive_author: 'bob', hive_permlink: 'p2', createdAt: new Date(), hiddenFromFeed: true },
    ];
    const entries = [
      { owner: 'alice', assetPermlink: 'asset1', permlink: 'p1', source: 'embed' },
      { owner: 'bob', assetPermlink: 'asset2', permlink: 'p2', source: 'embed' },
    ];
    const out = await hydrate(makeDb(embeds, []), entries);
    expect(out.map((v) => v.owner)).toEqual(['alice']);   // bob dropped
  });

  test('a legacy video flagged AFTER the pool was built is dropped too', async () => {
    const legacy = [
      { owner: 'carol', permlink: 'p3', created: new Date() },
      { owner: 'dave', permlink: 'p4', created: new Date(), hiddenFromFeed: true },
    ];
    const entries = [
      { owner: 'carol', permlink: 'p3', source: 'legacy' },
      { owner: 'dave', permlink: 'p4', source: 'legacy' },
    ];
    const out = await hydrate(makeDb([], legacy), entries);
    expect(out.map((v) => v.owner)).toEqual(['carol']);   // dave dropped
  });
});
