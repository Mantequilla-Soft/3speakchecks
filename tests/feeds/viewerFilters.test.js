/**
 * Who may never appear, against a real MongoDB:
 *   utils/userFilters.js     a viewer's own dismissals ("not interested", "don't show this creator")
 *   utils/hiddenCreators.js  creators hidden by moderation, a cached platform-wide set
 * Both fail open: a broken lookup shows everything rather than taking a feed down.
 */
const testDb = require('../helpers/db');
const F = require('./_fixtures');
const uf = require('../../utils/userFilters');
const hc = require('../../utils/hiddenCreators');

const db = testDb.use();

beforeEach(async () => {
  F.pinClock();
  await F.resetFeedCaches(db());
});
afterEach(() => jest.useRealTimers());

const brokenDb = { collection: () => ({ find: () => ({ toArray: async () => { throw new Error('mongo down'); } }) }) };

describe('userFilters', () => {
  test('normUser trims, lowercases and drops a leading @', () => {
    expect(['  @Alice ', null, '@', 'bob'].map(uf.normUser)).toEqual(['alice', '', '', 'bob']);
  });

  test('ensureUserFilterIndexes indexes both collections by username, idempotently', async () => {
    await uf.ensureUserFilterIndexes(db());
    await uf.ensureUserFilterIndexes(db());
    for (const name of [uf.HIDDEN_VIDEOS, uf.HIDDEN_CREATORS]) {
      const keys = (await db().collection(name).indexes()).map((i) => i.key);
      expect(keys).toContainEqual({ username: 1 });
    }
  });

  test('getUserFilters: the viewer\'s own dismissals only, keys normalised', async () => {
    await F.dismissVideo(db(), 'viewer', '@Bob', 'p1');
    await F.dismissCreator(db(), 'viewer', 'CAROL');
    await F.dismissCreator(db(), 'someone-else', 'dave');

    const filters = await uf.getUserFilters(db(), ' @Viewer ');

    expect([...filters.videos]).toEqual(['bob/p1']);
    expect([...filters.creators]).toEqual(['carol']);
  });

  test('no viewer, or a failed lookup, is "no dismissals"', async () => {
    for (const [d, user] of [[db(), ''], [brokenDb, 'viewer']]) {
      const filters = await uf.getUserFilters(d, user);
      expect(filters.videos.size + filters.creators.size).toBe(0);
    }
  });

  test('applyUserFilters drops dismissed videos and every video of a dismissed creator', () => {
    const filters = { videos: new Set(['bob/p1']), creators: new Set(['carol']) };
    const videos = [{ owner: 'Bob', permlink: 'p1' }, { owner: 'bob', permlink: 'p2' }, { owner: '@Carol', permlink: 'x' }];
    const kept = uf.applyUserFilters(videos, filters, (v) => v);
    expect(kept).toEqual([{ owner: 'bob', permlink: 'p2' }]);
    const empty = { videos: new Set(), creators: new Set() };
    expect(uf.applyUserFilters(videos, empty, (v) => v)).toBe(videos);
    expect(uf.applyUserFilters(videos, null, (v) => v)).toBe(videos);
  });

  test('applyUserFilterQuery excludes the dismissals in Mongo, merging with existing $nin / $nor', async () => {
    await db().collection('videos').insertMany([
      F.legacyVideo({ owner: 'house', permlink: 'h' }),
      F.legacyVideo({ owner: 'carol', permlink: 'c' }),
      F.legacyVideo({ owner: 'bob', permlink: 'p1' }),
      F.legacyVideo({ owner: 'bob', permlink: 'p2' }),
      F.legacyVideo({ owner: 'eve', permlink: 'e', banned: true }),
    ]);
    const filters = { videos: new Set(['bob/p1']), creators: new Set(['carol']) };
    const query = { owner: { $nin: ['house'] }, $nor: [{ banned: true }] };

    uf.applyUserFilterQuery(query, filters);

    expect(query.owner.$nin.sort()).toEqual(['carol', 'house']);
    expect(F.permlinks(await db().collection('videos').find(query).toArray())).toEqual(['p2']);
    expect(uf.applyUserFilterQuery({ a: 1 }, null)).toEqual({ a: 1 });
    expect(uf.applyUserFilterQuery({ a: 1 }, { videos: new Set(), creators: new Set() })).toEqual({ a: 1 });
  });

  test('excludeHiddenCreators adds its own $and clause, which a real query honours', async () => {
    await F.dismissCreator(db(), 'viewer', 'muted');
    await db().collection('embed-audio').insertMany([{ owner: 'muted', permlink: 'a' }, { owner: 'fine', permlink: 'b' }]);
    const query = await uf.excludeHiddenCreators(db(), { owner: { $ne: 'nobody' } }, 'viewer');
    expect(F.permlinks(await db().collection('embed-audio').find(query).toArray())).toEqual(['b']);
    expect(await uf.hiddenCreatorsOf(db(), 'viewer')).toEqual(['muted']);
  });
});

describe('hiddenCreators', () => {
  beforeEach(async () => {
    await db().collection('contentcreators').insertMany([
      { username: 'Hush', hidden: true },
      { username: 'quiet', hidden: true },
      { username: 'loud', hidden: false },
      { hidden: true },
    ]);
    await hc.refresh(db());
  });

  test('the set holds the hidden usernames, lowercased', async () => {
    expect([...(await hc.getHiddenSet(db()))].sort()).toEqual(['hush', 'quiet']);
    expect((await hc.hiddenList(db())).sort()).toEqual(['hush', 'quiet']);
    expect(await hc.isHidden(db(), 'HUSH')).toBe(true);
    expect(await hc.isHidden(db(), 'loud')).toBe(false);
    expect(await hc.isHidden(db(), null)).toBe(false);
  });

  test('cached for its TTL, reloaded after it', async () => {
    await db().collection('contentcreators').insertOne({ username: 'newly', hidden: true });
    expect(await hc.isHidden(db(), 'newly')).toBe(false);
    F.advanceClock(5 * 60 * 1000);
    expect(await hc.isHidden(db(), 'newly')).toBe(true);
  });

  test('a failed reload keeps the last set instead of un-hiding everyone', async () => {
    const warned = F.quietWarnings();
    F.advanceClock(5 * 60 * 1000);
    const broken = { collection: () => ({ find: () => ({ toArray: async () => { throw new Error('mongo down'); } }) }) };
    expect([...(await hc.getHiddenSet(broken))].sort()).toEqual(['hush', 'quiet']);
    expect(warned).toHaveBeenCalledWith('[hidden] refresh failed, using stale set:', 'mongo down');
  });

  test('filterHiddenDocs checks owner, author and hive_author', async () => {
    const docs = [{ owner: 'hush' }, { author: 'Quiet' }, { hive_author: 'hush', owner: 'app' }, { owner: 'loud' }, null];
    expect(await hc.filterHiddenDocs(db(), docs)).toEqual([{ owner: 'loud' }, null]);
    expect(await hc.filterHiddenDocs(db(), docs, ['author'])).toHaveLength(4);
    const empty = [];
    expect(await hc.filterHiddenDocs(db(), empty)).toBe(empty);
  });

  test('with nobody hidden, filterHiddenDocs hands back the same array', async () => {
    await db().collection('contentcreators').deleteMany({});
    await hc.refresh(db());
    const docs = [{ owner: 'a' }];
    expect(await hc.filterHiddenDocs(db(), docs)).toBe(docs);
  });

  test('hiddenSubset answers which of the named accounts are hidden', async () => {
    expect(await hc.hiddenSubset(db(), ['loud', 'HUSH', '', null, 'quiet'])).toEqual(['hush', 'quiet']);
    expect(await hc.hiddenSubset(db(), undefined)).toEqual([]);
  });

  test('the sync accessors read the warm cache and start the background warmer once', () => {
    const intervals = jest.spyOn(global, 'setInterval');
    expect(hc.hiddenListSync().sort()).toEqual(['hush', 'quiet']);
    expect(hc.isHiddenSync('Quiet')).toBe(true);
    expect(hc.isHiddenSync('loud')).toBe(false);
    expect(intervals.mock.calls.length).toBeLessThanOrEqual(1);
    intervals.mock.results.forEach((r) => clearInterval(r.value));
  });
});
