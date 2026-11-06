/**
 * videoHiveSync: links embed-video docs to their Hive post, verifies existing
 * links and repairs rotted ones. The chain is a fake behind hiveRpcBatch (posts
 * and account history in memory); every write lands in the real test MongoDB.
 *
 * What matters here: a link is only written after the post is proven to exist,
 * to be the owner's and to reference the asset; nothing that is already linked
 * is overwritten; a miss is stamped so it retries on a cadence; and an outage
 * never turns into a wrong write.
 */
process.env.VIDEO_HIVE_SYNC_BATCH = '5';
process.env.VIDEO_HIVE_SYNC_OWNERS_PER_RUN = '2';
process.env.VIDEO_HIVE_SYNC_VERIFY_BATCH = '3';

jest.mock('../../utils/hive', () => ({ hiveRpcBatch: jest.fn() }));

const testDb = require('../helpers/db');
const { hiveRpcBatch } = require('../../utils/hive');
const {
  syncVideoHiveLinks, verifyLinkedDocs, pickLivePost, parseEmbedUrl, postReferencesAsset,
} = require('../../services/videoHiveSync');
const { NOW, MINUTE, DAY, ago } = require('./_fixtures');

const db = testDb.use();
const ev = () => db().collection('embed-video');

// Fake Date only: the Mongo driver keeps its real timers.
const ONLY_DATE = ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame',
  'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate',
  'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'];

// The worker waits 500ms between owners. In a test that pause fires at once;
// every other timer (the driver's) is left alone.
function skipDelays(...delays) {
  const realSetTimeout = global.setTimeout;
  const asked = [];
  jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms, ...args) => {
    if (delays.includes(ms)) { asked.push(ms); return realSetTimeout(fn, 0, ...args); }
    return realSetTimeout(fn, ms, ...args);
  });
  return asked;
}

// An in-memory chain: posts that exist now, and each account's comment ops
// (oldest first, as get_account_history returns them, deleted posts included).
function fakeChain() {
  const posts = new Map();
  const history = new Map();
  const calls = [];
  hiveRpcBatch.mockImplementation(async (batch) => {
    calls.push(batch);
    return batch.map((r) => {
      if (r.method === 'condenser_api.get_content') {
        const [a, p] = r.params;
        // A missing post comes back as a zeroed stub, the way condenser answers.
        return { id: r.id, result: posts.get(`${a}/${p}`) || { author: '', permlink: '' } };
      }
      if (r.method === 'condenser_api.get_account_history') {
        const ops = (history.get(r.params[0]) || []).map((c, i) => [i, { op: ['comment', c] }]);
        return { id: r.id, result: ops };
      }
      throw new Error(`unexpected ${r.method}`);
    });
  });
  return {
    calls,
    methods: () => calls.flat().map((r) => r.method),
    // `into`: whose history the op shows up in (a reply BY someone else on their post).
    publish(post, { live = true, into = post.author } = {}) {
      const full = { title: '', body: '', json_metadata: '{}', parent_author: '', ...post };
      if (!history.has(into)) history.set(into, []);
      history.get(into).push(full);
      if (live) posts.set(`${full.author}/${full.permlink}`, full);
      return full;
    },
    remove(author, permlink) { posts.delete(`${author}/${permlink}`); },
  };
}

const doc = (owner, permlink, extra = {}) => ({
  owner, permlink, status: 'published', createdAt: ago(DAY), ...extra,
});
const playBody = (owner, permlink) => `Watch https://play.3speak.tv/watch?v=${owner}/${permlink}`;
const get = (owner, permlink) => ev().findOne({ owner, permlink });

beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ONLY_DATE });
  skipDelays(500);
  hiveRpcBatch.mockReset();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.useRealTimers());

describe('parseEmbedUrl', () => {
  test.each([
    ['@alice/abc-123', { author: 'alice', permlink: 'abc-123' }],
    ['  @a.b-c/xyz  ', { author: 'a.b-c', permlink: 'xyz' }],
    ['alice/abc', null],
    ['@alice', null],
    ['@alice/abc/extra', null],
    ['https://3speak.tv/watch?v=alice/abc', null],
    [null, null],
    [42, null],
  ])('%p -> %p', (input, expected) => {
    expect(parseEmbedUrl(input)).toEqual(expected);
  });
});

describe('postReferencesAsset', () => {
  test.each([
    ['the body carries the play URL', { body: playBody('a', 'asset1') }, true],
    ['video.info.permlink names the asset', { body: '', json_metadata: JSON.stringify({ video: { info: { permlink: 'asset1' } } }) }, true],
    ['anywhere in the metadata', { body: '', json_metadata: { app: 'snapie', embed: 'x/asset1' } }, true],
    ['unparseable metadata and no body match', { body: 'nothing', json_metadata: '{not json' }, false],
    ['an unrelated post', { body: 'other', json_metadata: '{"tags":["x"]}' }, false],
  ])('%s', (_label, post, expected) => {
    expect(postReferencesAsset(post, 'asset1')).toBe(expected);
  });

  test('no post or no asset is never a match', () => {
    expect(postReferencesAsset(null, 'a')).toBe(false);
    expect(postReferencesAsset({ body: 'a' }, '')).toBe(false);
  });
});

describe('pickLivePost', () => {
  test('returns the newest referencing post that is still on chain', async () => {
    const chain = fakeChain();
    const older = chain.publish({ author: 'al', permlink: 'snap-1', body: playBody('al', 'a1') });
    chain.publish({ author: 'al', permlink: 'snap-2', body: playBody('al', 'a1') }, { live: false });
    const posts = [older, { author: 'al', permlink: 'snap-2', body: playBody('al', 'a1') }];
    // snap-2 is newer but deleted: the live older twin wins.
    expect((await pickLivePost(posts, 'a1')).permlink).toBe('snap-1');
  });

  test('prefers the newer twin when both are live', async () => {
    const chain = fakeChain();
    const p1 = chain.publish({ author: 'al', permlink: 'snap-1', body: playBody('al', 'a1') });
    const p2 = chain.publish({ author: 'al', permlink: 'snap-2', body: playBody('al', 'a1') });
    expect((await pickLivePost([p1, p2], 'a1')).permlink).toBe('snap-2');
  });

  test('a candidate no node answered for is an error, never "no live post" or an older twin', async () => {
    const chain = fakeChain();
    const p1 = chain.publish({ author: 'al', permlink: 'snap-1', body: playBody('al', 'a1') });
    const p2 = chain.publish({ author: 'al', permlink: 'snap-2', body: playBody('al', 'a1') });
    const inner = hiveRpcBatch.getMockImplementation();
    // The node drops the newest candidate's entry and errors on nothing else.
    hiveRpcBatch.mockImplementation(async (batch) => (await inner(batch)).filter((r) => r.id !== 0));
    await expect(pickLivePost([p1, p2], 'a1')).rejects.toThrow(/al\/snap-2/);
    hiveRpcBatch.mockResolvedValue([]);
    await expect(pickLivePost([p1], 'a1')).rejects.toThrow(/no node answered/);
  });

  test('skips the excluded permlink and asks the chain nothing when no post references the asset', async () => {
    const chain = fakeChain();
    const p1 = chain.publish({ author: 'al', permlink: 'dead', body: playBody('al', 'a1') });
    expect(await pickLivePost([p1], 'a1', 'dead')).toBeNull();
    expect(await pickLivePost([{ author: 'al', permlink: 'x', body: 'unrelated' }], 'a1')).toBeNull();
    expect(chain.calls).toHaveLength(0);
  });
});

describe('path 1: a doc whose embed_url names its own post', () => {
  test('is linked, marked processed and gets the post metadata it lacks', async () => {
    const chain = fakeChain();
    chain.publish({
      author: 'alice', permlink: 'my-short', title: 'Hello', body: playBody('alice', 'asset1'),
      json_metadata: JSON.stringify({ tags: ['music', 7, 'live'] }),
    });
    await ev().insertOne(doc('alice', 'asset1', { embed_url: '@alice/my-short' }));

    const res = await syncVideoHiveLinks();

    expect(res).toMatchObject({ scanned: 1, linked: 1, missed: 0, errors: 0 });
    const d = await get('alice', 'asset1');
    expect(d).toMatchObject({
      hive_author: 'alice', hive_permlink: 'my-short', embed_url: '@alice/my-short',
      hive_title: 'Hello', hive_body: playBody('alice', 'asset1'), hive_tags: ['music', 'live'],
      processed: true,
    });
    expect(d.hive_link_synced_at).toEqual(NOW);
    expect(d.processedAt).toEqual(NOW);
    expect(d).not.toHaveProperty('hive_tags_lower'); // tagSync's job, never written here
  });

  test('keeps a title, body and tags the doc already has', async () => {
    const chain = fakeChain();
    chain.publish({
      author: 'alice', permlink: 'p', title: 'Chain title', body: playBody('alice', 'asset1'),
      json_metadata: JSON.stringify({ tags: ['chain'] }),
    });
    await ev().insertOne(doc('alice', 'asset1', {
      embed_url: '@alice/p', hive_title: 'Curated', hive_body: 'Mine', hive_tags: ['curated'], processed: true,
      processedAt: ago(DAY),
    }));

    await syncVideoHiveLinks();

    const d = await get('alice', 'asset1');
    expect(d).toMatchObject({ hive_permlink: 'p', hive_title: 'Curated', hive_body: 'Mine', hive_tags: ['curated'] });
    expect(d.processedAt).toEqual(ago(DAY)); // already processed: the stamp is not moved
  });

  test('a post that does not exist (yet) is stamped as a miss, not linked', async () => {
    fakeChain();
    await ev().insertOne(doc('alice', 'asset1', { embed_url: '@alice/never-posted' }));

    const res = await syncVideoHiveLinks();

    expect(res).toMatchObject({ linked: 0, missed: 1 });
    const d = await get('alice', 'asset1');
    expect(d.hive_permlink).toBeUndefined();
    expect(d.hive_link_checked_at).toEqual(NOW);
  });

  test('a post that does not reference the asset is refused', async () => {
    const chain = fakeChain();
    chain.publish({ author: 'alice', permlink: 'other-post', body: 'a cat picture' });
    await ev().insertOne(doc('alice', 'asset1', { embed_url: '@alice/other-post' }));

    const res = await syncVideoHiveLinks();

    expect(res).toMatchObject({ linked: 0, missed: 1 });
    expect((await get('alice', 'asset1')).hive_permlink).toBeUndefined();
  });

  test('an embed_url pointing at somebody else\'s post is not trusted: the owner\'s history must confirm it', async () => {
    const chain = fakeChain();
    chain.publish({ author: 'mallory', permlink: 'claim', body: playBody('alice', 'asset1') });
    await ev().insertOne(doc('alice', 'asset1', { embed_url: '@mallory/claim' }));

    const res = await syncVideoHiveLinks();

    expect(res).toMatchObject({ linked: 0, missed: 1 });
    expect((await get('alice', 'asset1')).hive_author).toBeUndefined();
    expect(chain.methods()).toContain('condenser_api.get_account_history');
    expect(chain.calls.flat().filter((r) => r.method === 'condenser_api.get_content')
      .map((r) => r.params[0])).not.toContain('mallory');
  });
});

describe('path 2: no embed_url, the owner\'s recent comments are searched', () => {
  test('links the owner\'s live post that references the asset, ignoring replies by others', async () => {
    const chain = fakeChain();
    chain.publish({ author: 'bob', permlink: 'bob-first', body: playBody('bob', 'asset2') });
    chain.publish({ author: 'bob', permlink: 'bob-short', body: playBody('bob', 'asset2'), parent_permlink: 'peak.snaps' });
    // Newest op in bob's history is a reply BY eve that quotes the link: never his post.
    chain.publish({ author: 'eve', permlink: 'eve-reply', body: playBody('bob', 'asset2') }, { into: 'bob' });
    await ev().insertOne(doc('bob', 'asset2'));

    const res = await syncVideoHiveLinks();

    expect(res.linked).toBe(1);
    // Both of bob's posts reference the asset; the newest live one wins.
    expect(await get('bob', 'asset2')).toMatchObject({ hive_author: 'bob', hive_permlink: 'bob-short', processed: true });
  });

  test('a client that published twice and dropped the second attempt is linked to the live first one', async () => {
    const chain = fakeChain();
    chain.publish({ author: 'rach', permlink: 'snap-397', body: playBody('rach', 'mlh6') });
    chain.publish({ author: 'rach', permlink: 'snap-592', body: playBody('rach', 'mlh6') }, { live: false });
    await ev().insertOne(doc('rach', 'mlh6'));

    await syncVideoHiveLinks();

    expect((await get('rach', 'mlh6')).hive_permlink).toBe('snap-397');
  });

  test('no matching post: stamped as a miss and left unlinked', async () => {
    const chain = fakeChain();
    chain.publish({ author: 'bob', permlink: 'unrelated', body: 'hello' });
    await ev().insertOne(doc('bob', 'asset2'));

    const res = await syncVideoHiveLinks();

    expect(res).toMatchObject({ linked: 0, missed: 1 });
    expect((await get('bob', 'asset2')).hive_link_checked_at).toEqual(NOW);
  });

  test('walks at most VIDEO_HIVE_SYNC_OWNERS_PER_RUN owners per run', async () => {
    const chain = fakeChain();
    await ev().insertMany(['o1', 'o2', 'o3'].map((o, i) => doc(o, `a${i}`, { createdAt: ago((i + 1) * MINUTE) })));

    const res = await syncVideoHiveLinks();

    expect(res.scanned).toBe(3);
    const walked = chain.calls.flat().filter((r) => r.method === 'condenser_api.get_account_history').map((r) => r.params[0]);
    expect(walked).toEqual(['o1', 'o2']);           // newest first, o3 waits for the next run
    expect((await get('o3', 'a2')).hive_link_checked_at).toBeUndefined();
  });

  test('a failing history walk for one owner is counted and does not stop the others', async () => {
    const chain = fakeChain();
    chain.publish({ author: 'ok', permlink: 'p', body: playBody('ok', 'a-ok') });
    const inner = hiveRpcBatch.getMockImplementation();
    hiveRpcBatch.mockImplementation(async (batch) => {
      if (batch[0].params[0] === 'broken') throw new Error('socket hang up');
      return inner(batch);
    });
    await ev().insertMany([doc('broken', 'a-b', { createdAt: ago(MINUTE) }), doc('ok', 'a-ok', { createdAt: ago(2 * MINUTE) })]);

    const res = await syncVideoHiveLinks();

    expect(res).toMatchObject({ linked: 1, errors: 1 });
    expect((await get('broken', 'a-b')).hive_link_checked_at).toBeUndefined(); // retried next run
  });

  test('a history walk no node answered is an error, not a miss', async () => {
    fakeChain();
    hiveRpcBatch.mockResolvedValue([]); // what hiveRpcBatch answers once every node failed
    await ev().insertOne(doc('bob', 'asset2'));

    const res = await syncVideoHiveLinks();

    expect(res).toMatchObject({ linked: 0, missed: 0, errors: 1 });
    expect((await get('bob', 'asset2')).hive_link_checked_at).toBeUndefined();
  });
});

describe('selection, cadence and idempotency', () => {
  test('takes at most VIDEO_HIVE_SYNC_BATCH docs, newest first, and only published ones', async () => {
    fakeChain();
    await ev().insertMany([
      ...Array.from({ length: 6 }, (_, i) => doc('alice', `a${i}`, { embed_url: `@alice/p${i}`, createdAt: ago((i + 1) * MINUTE) })),
      doc('alice', 'draft', { status: 'encoding' }),
    ]);

    const res = await syncVideoHiveLinks();

    expect(res.scanned).toBe(5);
    expect((await get('alice', 'a5')).hive_link_checked_at).toBeUndefined(); // the oldest waits
    expect((await get('alice', 'draft')).hive_link_checked_at).toBeUndefined();
  });

  test('running again re-links nothing; after one verification stamp the data is stable', async () => {
    const chain = fakeChain();
    chain.publish({ author: 'alice', permlink: 'p', body: playBody('alice', 'linked') });
    await ev().insertMany([
      doc('alice', 'linked', { embed_url: '@alice/p' }),
      doc('alice', 'missing', { embed_url: '@alice/nope' }),
    ]);
    await syncVideoHiveLinks();
    const after1 = await ev().find({}, { sort: { permlink: 1 } }).toArray();

    // The second run finds no backlog. A link written by this worker carries no
    // verified stamp yet, so the verify pass reads it once and stamps it.
    const res2 = await syncVideoHiveLinks();
    expect(res2).toMatchObject({ scanned: 0, linked: 0, verify: { checked: 1, verified: 1 } });
    const after2 = await ev().find({}, { sort: { permlink: 1 } }).toArray();
    const { hive_link_verified_at: stamp, ...linkedAfter2 } = after2[0];
    expect(stamp).toEqual(NOW);
    expect(linkedAfter2).toEqual(after1[0]);
    expect(after2[1]).toEqual(after1[1]);

    const res3 = await syncVideoHiveLinks();
    expect(res3).toMatchObject({ scanned: 0, linked: 0, verify: { checked: 0 } });
    expect(await ev().find({}, { sort: { permlink: 1 } }).toArray()).toEqual(after2);
  });

  test('a fresh miss is retried after the short recheck, an old one only after days', async () => {
    fakeChain();
    await ev().insertMany([
      doc('alice', 'fresh', { embed_url: '@alice/x', hive_link_checked_at: ago(31 * MINUTE), createdAt: ago(DAY) }),
      doc('alice', 'fresh-recent', { embed_url: '@alice/y', hive_link_checked_at: ago(10 * MINUTE), createdAt: ago(DAY) }),
      doc('alice', 'old', { embed_url: '@alice/z', hive_link_checked_at: ago(DAY), createdAt: ago(30 * DAY) }),
      doc('alice', 'old-due', { embed_url: '@alice/w', hive_link_checked_at: ago(8 * DAY), createdAt: ago(30 * DAY) }),
    ]);

    const res = await syncVideoHiveLinks();

    expect(res.scanned).toBe(2);
    expect((await get('alice', 'fresh')).hive_link_checked_at).toEqual(NOW);
    expect((await get('alice', 'old-due')).hive_link_checked_at).toEqual(NOW);
    expect((await get('alice', 'fresh-recent')).hive_link_checked_at).toEqual(ago(10 * MINUTE));
    expect((await get('alice', 'old')).hive_link_checked_at).toEqual(ago(DAY));
  });

  test('never overwrites a link the upstream indexer wrote between our read and our write', async () => {
    const chain = fakeChain();
    chain.publish({ author: 'alice', permlink: 'ours', body: playBody('alice', 'asset1') });
    const inner = hiveRpcBatch.getMockImplementation();
    hiveRpcBatch.mockImplementation(async (batch) => {
      // The indexer links the doc while we are on the network.
      await ev().updateOne({ permlink: 'asset1' }, { $set: { hive_author: 'alice', hive_permlink: 'indexer-wins' } });
      return inner(batch);
    });
    await ev().insertOne(doc('alice', 'asset1', { embed_url: '@alice/ours' }));

    await syncVideoHiveLinks();

    expect((await get('alice', 'asset1')).hive_permlink).toBe('indexer-wins');
  });

  test('a total Hive outage writes nothing: every doc stays due for the next run', async () => {
    fakeChain();
    hiveRpcBatch.mockResolvedValue([]); // what hiveRpcBatch answers once every node failed
    await ev().insertOne(doc('alice', 'asset1', { embed_url: '@alice/p' }));

    const res = await syncVideoHiveLinks();

    expect(res).toMatchObject({ scanned: 1, linked: 0, missed: 0 });
    expect((await get('alice', 'asset1')).hive_link_checked_at).toBeUndefined();
  });

  test('a get_content batch that throws is counted as an error and leaves the docs unstamped', async () => {
    hiveRpcBatch.mockRejectedValue(new Error('fetch failed'));
    await ev().insertOne(doc('alice', 'asset1', { embed_url: '@alice/p' }));

    const res = await syncVideoHiveLinks();

    expect(res.errors).toBe(1);
    expect((await get('alice', 'asset1')).hive_link_checked_at).toBeUndefined();
  });

  test('an empty backlog does no work at all', async () => {
    const chain = fakeChain();
    expect(await syncVideoHiveLinks()).toMatchObject({ scanned: 0, linked: 0, missed: 0, errors: 0 });
    expect(chain.calls).toHaveLength(0);
  });
});

describe('verifying links that already exist', () => {
  const linked = (owner, permlink, hivePermlink, extra = {}) => doc(owner, permlink, {
    hive_author: owner, hive_permlink: hivePermlink, embed_url: `@${owner}/${hivePermlink}`, ...extra,
  });

  test('a link that still resolves is stamped verified and marked processed', async () => {
    const chain = fakeChain();
    chain.publish({ author: 'alice', permlink: 'p', body: playBody('alice', 'a1') });
    await ev().insertOne(linked('alice', 'a1', 'p'));

    const res = await syncVideoHiveLinks();

    expect(res.verify).toMatchObject({ checked: 1, verified: 1, repaired: 0, dead: 0 });
    expect(await get('alice', 'a1')).toMatchObject({ hive_permlink: 'p', hive_link_verified_at: NOW, processed: true });
  });

  test('a link to a deleted post is repointed at the live twin, keeping curated text', async () => {
    const chain = fakeChain();
    chain.publish({ author: 'rach', permlink: 'snap-592', body: playBody('rach', 'mlh6') }, { live: false });
    chain.publish({ author: 'rach', permlink: 'snap-397', title: 'Twin', body: playBody('rach', 'mlh6') });
    await ev().insertOne(linked('rach', 'mlh6', 'snap-592', { hive_title: 'Hand curated' }));

    const res = await syncVideoHiveLinks();

    expect(res.verify).toMatchObject({ checked: 1, repaired: 1, dead: 0 });
    expect(await get('rach', 'mlh6')).toMatchObject({
      hive_permlink: 'snap-397', embed_url: '@rach/snap-397', hive_title: 'Hand curated',
      hive_link_repaired_at: NOW, hive_link_verified_at: NOW, processed: true,
    });
  });

  test('a dead link with no live replacement is stamped dead and LEFT in place', async () => {
    const chain = fakeChain();
    chain.publish({ author: 'alice', permlink: 'gone', body: playBody('alice', 'a1') }, { live: false });
    await ev().insertOne(linked('alice', 'a1', 'gone'));

    const res = await syncVideoHiveLinks();

    expect(res.verify).toMatchObject({ dead: 1, repaired: 0 });
    expect(await get('alice', 'a1')).toMatchObject({
      hive_permlink: 'gone', embed_url: '@alice/gone', hive_link_dead_at: NOW, hive_link_verified_at: NOW,
    });
  });

  test('links verified within VIDEO_HIVE_SYNC_VERIFY_DAYS are not re-read; at most VERIFY_BATCH per run', async () => {
    const chain = fakeChain();
    for (let i = 0; i < 5; i++) chain.publish({ author: 'al', permlink: `p${i}`, body: playBody('al', `a${i}`) });
    await ev().insertMany([
      linked('al', 'a0', 'p0', { hive_link_verified_at: ago(DAY), createdAt: ago(MINUTE) }),
      linked('al', 'a1', 'p1', { hive_link_verified_at: ago(15 * DAY), createdAt: ago(2 * MINUTE) }),
      linked('al', 'a2', 'p2', { createdAt: ago(3 * MINUTE) }),
      linked('al', 'a3', 'p3', { createdAt: ago(4 * MINUTE) }),
      linked('al', 'a4', 'p4', { createdAt: ago(5 * MINUTE) }),
    ]);

    const out = await verifyLinkedDocs(ev());

    expect(out.checked).toBe(3);
    expect((await get('al', 'a0')).hive_link_verified_at).toEqual(ago(DAY));
    expect((await get('al', 'a4')).hive_link_verified_at).toBeUndefined();
  });

  test('a verify batch that throws is counted and stamps nothing', async () => {
    hiveRpcBatch.mockRejectedValue(new Error('timeout'));
    await ev().insertOne(linked('alice', 'a1', 'p'));

    const out = await verifyLinkedDocs(ev());

    expect(out).toMatchObject({ checked: 1, errors: 1, verified: 0, dead: 0 });
    expect((await get('alice', 'a1')).hive_link_verified_at).toBeUndefined();
  });

  test('a throwing repair walk is counted and the doc is left unstamped', async () => {
    const chain = fakeChain();
    const inner = hiveRpcBatch.getMockImplementation();
    hiveRpcBatch.mockImplementation(async (batch) => {
      if (batch[0].method === 'condenser_api.get_account_history') throw new Error('socket hang up');
      return inner(batch);
    });
    chain.publish({ author: 'alice', permlink: 'gone', body: 'x' }, { live: false });
    await ev().insertOne(linked('alice', 'a1', 'gone'));

    const out = await verifyLinkedDocs(ev());

    expect(out).toMatchObject({ errors: 1, dead: 0 });
    expect((await get('alice', 'a1')).hive_link_dead_at).toBeUndefined();
  });

  // Regression: getRecentComments() goes through hiveRpcBatch, which never throws:
  // when every node fails it resolves []. An outage between the verify read and the
  // history walk used to read as "no posts", and the doc was stamped
  // hive_link_dead_at plus a fresh hive_link_verified_at, so it was not looked at
  // again for 14 days even though the live twin was on chain.
  test('a Hive outage during the repair walk never marks a repairable link dead', async () => {
    const chain = fakeChain();
    chain.publish({ author: 'rach', permlink: 'snap-592', body: playBody('rach', 'mlh6') }, { live: false });
    chain.publish({ author: 'rach', permlink: 'snap-397', body: playBody('rach', 'mlh6') });
    const inner = hiveRpcBatch.getMockImplementation();
    hiveRpcBatch.mockImplementation(async (batch) => (
      batch[0].method === 'condenser_api.get_account_history' ? [] : inner(batch)));
    await ev().insertOne(linked('rach', 'mlh6', 'snap-592'));

    const out = await verifyLinkedDocs(ev());

    expect(out.dead).toBe(0);
    const d = await get('rach', 'mlh6');
    expect(d.hive_link_dead_at).toBeUndefined();
    expect(d.hive_link_verified_at).toBeUndefined();
  });
});
