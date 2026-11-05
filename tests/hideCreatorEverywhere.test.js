/**
 * "Don't show this creator" covers every content type a viewer browses
 * (owner, 2026-11-05): audio, playlists and shorts, not just videos.
 * utils/userFilters.js excludeHiddenCreators / hiddenCreatorsOf, with a fake db.
 */
const { excludeHiddenCreators, hiddenCreatorsOf } = require('../utils/userFilters');

const fakeDb = (creatorRows, { fail = false } = {}) => ({
  collection: (name) => ({
    find: () => ({
      toArray: async () => {
        if (fail) throw new Error('mongo down');
        return name === 'user-hidden-creators' ? creatorRows : [];
      },
    }),
  }),
});

describe('hide creator everywhere', () => {
  test('adds an owner $nin clause without touching existing filters', async () => {
    const q = { status: 'published', owner: { $nin: ['spam'] }, $and: [{ $or: [{ a: 1 }] }] };
    await excludeHiddenCreators(fakeDb([{ creator: '@Alice' }, { creator: 'bob' }]), q, 'Viewer');
    expect(q.owner).toEqual({ $nin: ['spam'] });
    expect(q.$and).toEqual([{ $or: [{ a: 1 }] }, { owner: { $nin: ['alice', 'bob'] } }]);
  });

  test('custom field name', async () => {
    const q = {};
    await excludeHiddenCreators(fakeDb([{ creator: 'alice' }]), q, 'viewer', 'author');
    expect(q.$and).toEqual([{ author: { $nin: ['alice'] } }]);
  });

  test('no viewer, nothing hidden, or a failed lookup: query unchanged', async () => {
    for (const [db, user] of [
      [fakeDb([{ creator: 'alice' }]), ''],
      [fakeDb([]), 'viewer'],
      [fakeDb([{ creator: 'alice' }], { fail: true }), 'viewer'],
    ]) {
      const q = { status: 'published' };
      await excludeHiddenCreators(db, q, user);
      expect(q).toEqual({ status: 'published' });
    }
  });

  test('hiddenCreatorsOf returns lowercased names', async () => {
    expect(await hiddenCreatorsOf(fakeDb([{ creator: '@Alice' }]), 'viewer')).toEqual(['alice']);
    expect(await hiddenCreatorsOf(fakeDb([{ creator: 'alice' }]), null)).toEqual([]);
  });
});
