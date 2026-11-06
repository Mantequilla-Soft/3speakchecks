/**
 * communityDenorm: copies each community's title onto the legacy videos posted
 * in it (`hive` holds the community account), so feeds can show it without a
 * join. Real test MongoDB.
 */
const testDb = require('../helpers/db');
const { denormalizeCommunityTitles } = require('../../services/communityDenorm');

const db = testDb.use();
const videos = () => db().collection('videos');
const communities = () => db().collection('hivecommunities');

beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));

test('writes the community title onto every video posted in it, and only there', async () => {
  await communities().insertMany([
    { name: 'hive-100001', title: 'Music' },
    { name: 'hive-100002', title: 'Travel' },
    { name: 'hive-100003' }, // no title yet: nothing to copy
  ]);
  await videos().insertMany([
    { permlink: 'a', hive: 'hive-100001' },
    { permlink: 'b', hive: 'hive-100001', community_title: 'Old name' },
    { permlink: 'c', hive: 'hive-100002', community_title: 'Travel' },
    { permlink: 'd', hive: 'hive-100003' },
    { permlink: 'e', hive: 'hive-999999' },
  ]);

  await denormalizeCommunityTitles();

  const titles = Object.fromEntries((await videos().find({}).toArray()).map((v) => [v.permlink, v.community_title]));
  expect(titles).toEqual({ a: 'Music', b: 'Music', c: 'Travel', d: undefined, e: undefined });
});

test('handles more than one batch of 50 communities', async () => {
  const names = Array.from({ length: 120 }, (_, i) => `hive-${200000 + i}`);
  await communities().insertMany(names.map((name, i) => ({ name, title: `T${i}` })));
  await videos().insertMany(names.map((hive) => ({ hive })));
  const { Collection } = require('mongodb');
  const bulk = jest.spyOn(Collection.prototype, 'bulkWrite');

  await denormalizeCommunityTitles();

  expect(bulk.mock.calls.map(([ops]) => ops.length)).toEqual([50, 50, 20]);
  expect(await videos().countDocuments({ community_title: { $exists: true } })).toBe(120);
});

test('running twice modifies nothing the second time', async () => {
  await communities().insertOne({ name: 'hive-1', title: 'One' });
  await videos().insertOne({ hive: 'hive-1' });
  await denormalizeCommunityTitles();
  const { Collection } = require('mongodb');
  const bulk = jest.spyOn(Collection.prototype, 'bulkWrite');

  await denormalizeCommunityTitles();

  expect((await bulk.mock.results[0].value).modifiedCount).toBe(0);
});

test('a database failure is logged, never thrown', async () => {
  const { Collection } = require('mongodb');
  jest.spyOn(Collection.prototype, 'find').mockImplementation(() => { throw new Error('connection reset'); });

  await expect(denormalizeCommunityTitles()).resolves.toBeUndefined();
  expect(console.error).toHaveBeenCalledWith('Community title denormalization failed:', expect.any(Error));
});
