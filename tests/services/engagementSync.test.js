/**
 * Engagement-affinity sync (services/engagementSync.js): what a viewer's row says
 * after a sync, built from their Hive comments (stubbed), reshares and playlist
 * saves (real MongoDB), and how the demand-seeded queue warms a viewer exactly once.
 * The credit rules themselves (creditedAuthor, decay) are covered in
 * tests/engagementBoost.test.js.
 */
jest.mock('../../utils/hive', () => ({
  ...jest.requireActual('../../utils/hive'),
  fetchAccountComments: jest.fn(),
}));

const { waitUntil } = require('../helpers/wait');
const testDb = require('../helpers/db');
const { NOW, DAY } = require('./_fixtures');
const hive = require('../../utils/hive');
const boost = require('../../utils/engagementBoost');
const { syncUser, collectEvents, resolveTopics, scheduleEngagementSync } = require('../../services/engagementSync');

const db = testDb.use();

// Only Date is frozen: the MongoDB driver keeps its real timers.
const REAL_TIMERS = ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'];
beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: REAL_TIMERS });
  hive.fetchAccountComments.mockReset().mockResolvedValue([]);
  boost.invalidate();
});
afterEach(() => jest.useRealTimers());

const at = (daysAgo) => NOW.getTime() - daysAgo * DAY;
// A comment as utils/hive.fetchAccountComments returns it.
const comment = (rootAuthor, rootPermlink, daysAgo = 1, parent = rootAuthor) => ({
  author: 'viewer', permlink: `re-${rootPermlink}`, parent_author: parent,
  root_author: rootAuthor, root_permlink: rootPermlink, created: at(daysAgo), depth: 1,
});

/** Resolve until `check` passes, letting fire-and-forget work run (tests/helpers/wait.js). */
const eventually = (check) => waitUntil(check);

describe('collecting what a viewer engaged with', () => {
  test('credits comments, reshares and playlist saves inside the window, and skips the rest', async () => {
    hive.fetchAccountComments.mockResolvedValue([
      comment('alice', 'talk'),
      comment('viewer', 'own-post'),                   // self-engagement
      comment('peak.snaps', 'snap', 1, 'dbuzz'),       // container root, blacklisted parent
    ]);
    await db().collection('reshares').insertMany([
      { username: 'viewer', author: 'bob', permlink: 'b1', reshared_at: new Date(at(2)) },
      { username: 'viewer', author: 'bob', permlink: 'old', reshared_at: new Date(at(120)) },
      { username: 'viewer', author: 'Viewer', permlink: 'mine', reshared_at: new Date(at(2)) },
      { username: 'someone-else', author: 'carol', permlink: 'c1', reshared_at: new Date(at(2)) },
    ]);
    await db().collection('playlists').insertMany([
      { owner: 'viewer', items: [
        { author: 'carol', permlink: 'c2', added_at: new Date(at(3)) },
        { author: 'carol', permlink: 'stale', added_at: new Date(at(200)) },
        { author: 'leothreads', permlink: 'x', added_at: new Date(at(3)) },
        { author: 'carol', permlink: 'undated' },
      ] },
      { owner: 'viewer', items: [] },
    ]);

    const { events, counts } = await collectEvents(db(), 'Viewer', at(90));

    expect(counts).toEqual({ comments: 1, reshares: 1, saves: 1, self: 1, blacklisted: 1 });
    expect(events).toEqual([
      { author: 'alice', permlink: 'talk', kind: 'comment', at: at(1) },
      { author: 'bob', permlink: 'b1', kind: 'reshare', at: at(2) },
      { author: 'carol', permlink: 'c2', kind: 'save', at: at(3) },
    ]);
    expect(hive.fetchAccountComments).toHaveBeenCalledWith('viewer', at(90), { maxPages: 30 });
  });
});

describe('resolving the topic of engaged posts', () => {
  test('maps a Hive post to its 3Speak asset and picks the winner tag; non-3Speak posts stay out', async () => {
    await db().collection('embed-video').insertOne({ owner: 'alice', permlink: 'asset1', hive_author: 'alice', hive_permlink: 'talk' });
    await db().collection('videos').insertOne({ owner: 'bob', permlink: 'b1' });
    await db().collection('subtitles-tags').insertMany([
      { author: 'alice', permlink: 'asset1', tags: 'tech, music' },
      { author: 'bob', permlink: 'b1', tags: 'cooking' },
    ]);
    // Viewers voted 'music' up on alice's post: it outweighs the auto tag order.
    await db().collection('viewer-tags').insertOne({ author: 'alice', permlink: 'talk', 'viewer-tag': 'music', weight: 5000 });

    const topics = await resolveTopics(db(), [
      { author: 'alice', permlink: 'talk' },
      { author: 'alice', permlink: 'talk' },          // duplicate, looked up once
      { author: 'bob', permlink: 'b1' },
      { author: 'dave', permlink: 'text-post' },      // not a video of ours
      { author: 'erin' },                             // no permlink at all
    ]);

    expect([...topics.entries()]).toEqual([['alice/talk', 'music'], ['bob/b1', 'cooking']]);
  });

  test('an embed wins over a lingering legacy row for the same post', async () => {
    await db().collection('videos').insertOne({ owner: 'alice', permlink: 'talk' });
    await db().collection('embed-video').insertOne({ owner: 'alice', permlink: 'asset1', hive_author: 'alice', hive_permlink: 'talk' });
    await db().collection('subtitles-tags').insertMany([
      { author: 'alice', permlink: 'talk', tags: 'legacy-topic' },
      { author: 'alice', permlink: 'asset1', tags: 'embed-topic' },
    ]);
    const topics = await resolveTopics(db(), [{ author: 'alice', permlink: 'talk' }]);
    expect(topics.get('alice/talk')).toBe('embed-topic');
  });

  test('nothing to look up, or nothing known, resolves to an empty map', async () => {
    expect((await resolveTopics(db(), [{ author: 'x' }])).size).toBe(0);
    expect((await resolveTopics(db(), [{ author: 'x', permlink: 'y' }])).size).toBe(0);
  });
});

describe('a viewer\'s affinity row', () => {
  async function seedTwoCreators() {
    // alice: a comment today and one 45 days ago (one half-life). bob: a reshare today.
    hive.fetchAccountComments.mockResolvedValue([comment('alice', 'talk', 0), comment('alice', 'talk2', 45)]);
    await db().collection('reshares').insertOne({ username: 'viewer', author: 'bob', permlink: 'b1', reshared_at: new Date(at(0)) });
    await db().collection('embed-video').insertOne({ owner: 'alice', permlink: 'a1', hive_author: 'alice', hive_permlink: 'talk' });
    await db().collection('subtitles-tags').insertOne({ author: 'alice', permlink: 'a1', tags: 'tech' });
    await db().collection('videos').insertOne({ owner: 'bob', permlink: 'b1' });
    await db().collection('subtitles-tags').insertOne({ author: 'bob', permlink: 'b1', tags: 'music' });
  }

  test('weighs creators with the half-life decay and stores topics as shares of the whole', async () => {
    await seedTwoCreators();

    const out = await syncUser(db(), '@Viewer');

    const row = await db().collection('user-engagement').findOne({ _id: 'viewer' });
    expect(row.authors).toEqual({ alice: 1.5, bob: 1 });
    // alice/talk2 is not a 3Speak video, so only two events carry a topic.
    expect(row.topic_events).toBe(2);
    expect(row.topics).toEqual({ tech: 0.5, music: 0.5 });
    expect(row.events).toEqual({ comments: 2, reshares: 1, saves: 0 });
    expect(row.skipped).toEqual({ self: 0, blacklisted: 0 });
    expect(row.window_days).toBe(90);
    expect(row.updated_at).toEqual(NOW);
    expect(out).toMatchObject({ user: 'viewer', authors: row.authors });
  });

  test('a second sync with the same history rewrites the same row, it never accumulates', async () => {
    await seedTwoCreators();
    await syncUser(db(), 'viewer');
    const first = await db().collection('user-engagement').findOne({ _id: 'viewer' });

    await syncUser(db(), 'viewer');

    const rows = await db().collection('user-engagement').find().toArray();
    expect(rows).toHaveLength(1);
    const { duration_ms: _a, ...a } = first;
    const { duration_ms: _b, ...b } = rows[0];
    expect(b).toEqual(a);
  });

  test('a viewer with no engagement gets an empty row, not an error', async () => {
    const out = await syncUser(db(), 'quiet');
    expect(out).toMatchObject({ authors: {}, topics: {}, topic_events: 0 });
    expect(await db().collection('user-engagement').countDocuments({ _id: 'quiet' })).toBe(1);
  });

  test('a Hive failure fails the sync and leaves the previous row untouched', async () => {
    await db().collection('user-engagement').insertOne({ _id: 'viewer', authors: { alice: 3 }, updated_at: new Date(at(1)) });
    hive.fetchAccountComments.mockRejectedValue(new Error('all nodes down'));

    await expect(syncUser(db(), 'viewer')).rejects.toThrow('all nodes down');

    expect(await db().collection('user-engagement').findOne({ _id: 'viewer' }))
      .toEqual({ _id: 'viewer', authors: { alice: 3 }, updated_at: new Date(at(1)) });
  });
});

describe('the demand-seeded background sync', () => {
  let ticks;
  beforeEach(() => {
    ticks = [];
    jest.spyOn(global, 'setInterval').mockImplementation((fn, ms) => { ticks.push({ fn, ms }); return 0; });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  test('a first feed request queues the viewer, the sync builds their row, and the next request sees it', async () => {
    scheduleEngagementSync();
    expect(ticks).toEqual([{ fn: expect.any(Function), ms: 60 * 1000 }]);
    hive.fetchAccountComments.mockResolvedValue([comment('alice', 'talk', 0)]);

    // Cold viewer: no row yet, so no boost, and a sync starts right away.
    expect(await boost.getEngagementAffinity(db(), 'viewer')).toBeNull();
    await eventually(async () => (await db().collection('user-engagement').countDocuments({ _id: 'viewer' })) === 1);

    // The cached miss was dropped, so the very next request reads the fresh row.
    await eventually(async () => (await boost.getEngagementAffinity(db(), 'viewer')) !== null);
    expect((await boost.getEngagementAffinity(db(), 'viewer')).authors).toEqual({ alice: 1 });

    // Already dequeued when it started: the interval tick does not walk Hive again.
    ticks[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(hive.fetchAccountComments).toHaveBeenCalledTimes(1);
  });

  test('a failed background sync is logged, never thrown at the feed request', async () => {
    scheduleEngagementSync();
    hive.fetchAccountComments.mockRejectedValue(new Error('rpc timeout'));

    await expect(boost.getEngagementAffinity(db(), 'viewer')).resolves.toBeNull();
    await eventually(() => console.warn.mock.calls.length > 0);
    expect(console.warn.mock.calls[0].join(' ')).toMatch(/sync failed for viewer.*rpc timeout/);
    expect(await db().collection('user-engagement').countDocuments()).toBe(0);
  });
});
