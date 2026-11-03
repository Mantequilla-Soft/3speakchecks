/**
 * utils/linkedAudio.js: an outside episode whose link names a 3Speak post resolves
 * to the creator's own track. In-memory, nothing talks to Mongo.
 */
const { linkedAudioPermlink } = require('../utils/linkedAudio');

function fakeDb(rows) {
  const matches = (doc, q) => doc.owner === q.owner && q.post_permlink.$in.includes(doc.post_permlink);
  return { collection: () => ({ findOne: async (q) => rows.find((d) => matches(d, q)) || null }) };
}

const db = fakeDb([
  { owner: 'alice', permlink: 'a1b2c3d4', post_permlink: 'my-first-show', status: 'published' },
  { owner: 'alice', permlink: 'e5f6g7h8', post_permlink: 'alice/old-style-row' },
  { owner: 'alice', permlink: 'draft001', post_permlink: 'not-yet-out', status: 'processing' },
]);

describe('linkedAudioPermlink', () => {
  test('finds the track behind the post', async () => {
    expect(await linkedAudioPermlink(db, 'alice', 'my-first-show')).toBe('a1b2c3d4');
  });
  test('reads rows that store "author/permlink"', async () => {
    expect(await linkedAudioPermlink(db, 'alice', 'old-style-row')).toBe('e5f6g7h8');
  });
  test('owner is matched case-insensitively from the link', async () => {
    expect(await linkedAudioPermlink(db, 'Alice', 'my-first-show')).toBe('a1b2c3d4');
  });
  test('another owner claiming the post gets nothing', async () => {
    expect(await linkedAudioPermlink(db, 'mallory', 'my-first-show')).toBeNull();
  });
  test('unpublished track and unknown post: nothing', async () => {
    expect(await linkedAudioPermlink(db, 'alice', 'not-yet-out')).toBeNull();
    expect(await linkedAudioPermlink(db, 'alice', 'no-such-post')).toBeNull();
  });
  test('malformed input never reaches the database', async () => {
    const boom = { collection: () => { throw new Error('queried'); } };
    expect(await linkedAudioPermlink(boom, 'alice', '../x y')).toBeNull();
    expect(await linkedAudioPermlink(boom, '', 'my-first-show')).toBeNull();
    expect(await linkedAudioPermlink(boom, { $ne: 1 }, 'my-first-show')).toBeNull();
  });
});
