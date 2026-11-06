/**
 * The author-controlled "hide from feeds" filter: the match helper, the in-memory
 * predicate, and the authoritative hydrate() drop.
 */
const { hiddenFromFeedMatch, isHiddenFromFeed } = require('../utils/hiddenFromFeed');
const { hydrate } = require('../utils/discoverPool');
const testDb = require('./helpers/db');

describe('hiddenFromFeedMatch', () => {
  test('excludes hiddenFromFeed:true and expired stories, nothing else', () => {
    const m = hiddenFromFeedMatch();
    expect(m.hiddenFromFeed).toEqual({ $ne: true });
    expect(Object.keys(m.story_expires_at)).toEqual(['$not']);
    expect(m.story_expires_at.$not.$lte).toBeInstanceOf(Date);
  });

  describe('against a real MongoDB', () => {
    const db = testDb.use();
    const HOUR = 3600 * 1000;

    test('the field-less majority, explicit false and live stories match; hidden and expired do not', async () => {
      const col = db().collection('embed-video');
      await col.insertMany([
        { permlink: 'plain' },
        { permlink: 'explicit-false', hiddenFromFeed: false },
        { permlink: 'hidden', hiddenFromFeed: true },
        { permlink: 'live-story', story: true, story_expires_at: new Date(Date.now() + HOUR) },
        { permlink: 'expired-story', story: true, story_expires_at: new Date(Date.now() - HOUR) },
      ]);
      const shown = (await col.find(hiddenFromFeedMatch()).toArray()).map((d) => d.permlink).sort();
      expect(shown).toEqual(['explicit-false', 'live-story', 'plain']);
    });
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
