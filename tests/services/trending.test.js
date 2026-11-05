/**
 * Legacy trending flag (services/trending.js): which `videos` rows carry
 * trending: true after a run. Score = views + 2 x votes + 3 x comments (in Mongo)
 * + 10 x the live Hive reward (stubbed at utils/hive.fetchHiveRewards).
 */
jest.mock('../../utils/hive', () => ({
  ...jest.requireActual('../../utils/hive'),
  fetchHiveRewards: jest.fn(),
}));

const testDb = require('../helpers/db');
const { NOW, DAY, ago } = require('./_fixtures');
const hive = require('../../utils/hive');
const { calculateAndFlagTrendingVideos } = require('../../services/trending');

const db = testDb.use();
const videos = () => db().collection('videos');

const REAL_TIMERS = ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'];
beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: REAL_TIMERS });
  hive.fetchHiveRewards.mockReset().mockResolvedValue(new Map());
});
afterEach(() => jest.useRealTimers());

const video = (permlink, extra = {}) => ({
  _id: permlink, owner: 'alice', permlink, status: 'published', created: ago(DAY), views: 0, ...extra,
});
const flagged = async () => (await videos().find({ trending: true }).toArray()).map((v) => v._id).sort();

describe('which videos are trending', () => {
  test('only recent, published, unbanned videos of visible creators qualify', async () => {
    await videos().insertMany([
      video('ok', { views: 5 }),
      video('old', { views: 500, created: ago(8 * DAY) }),
      video('draft', { views: 500, status: 'uploaded' }),
      video('banned', { views: 500, banned: true }),
      video('hidden', { views: 500, owner: 'threespeak-fixer' }),
    ]);

    await calculateAndFlagTrendingVideos();

    expect(await flagged()).toEqual(['ok']);
  });

  test('yesterday\'s flags are cleared before today\'s are set', async () => {
    await videos().insertMany([
      video('was-trending', { trending: true, created: ago(9 * DAY) }),
      video('now-trending', { views: 1 }),
    ]);
    await calculateAndFlagTrendingVideos();
    expect(await flagged()).toEqual(['now-trending']);
    expect((await videos().findOne({ _id: 'was-trending' })).trending).toBe(false);
  });

  test('the live Hive reward outweighs raw views (x10 per HBD)', async () => {
    await videos().insertMany([
      ...Array.from({ length: 50 }, (_, i) => video(`views${i}`, { views: 20 })),
      video('rewarded', { views: 0, author: 'bob' }),
    ]);
    hive.fetchHiveRewards.mockResolvedValue(new Map([['bob/rewarded', { reward: 2.5 }]]));

    await calculateAndFlagTrendingVideos();

    const set = await flagged();
    expect(set).toHaveLength(50);
    expect(set).toContain('rewarded');                // 25 > 20
    // The reward is looked up by the Hive author when the row has one.
    const asked = hive.fetchHiveRewards.mock.calls[0][0];
    expect(asked).toContainEqual({ author: 'bob', permlink: 'rewarded' });
  });

  test('votes and comments weigh 2 and 3 points', async () => {
    await videos().insertMany([
      ...Array.from({ length: 49 }, (_, i) => video(`filler${i}`, { views: 100 })),
      video('votes', { stats: { num_votes: 4 } }),         // 8
      video('comments', { stats: { num_comments: 3 } }),   // 9
      video('views', { views: 7 }),                        // 7
    ]);
    await calculateAndFlagTrendingVideos();
    const set = await flagged();
    expect(set).toContain('comments');
    expect(set).not.toContain('views');
    expect(set).not.toContain('votes');
  });

  test('at most 50 videos are flagged', async () => {
    await videos().insertMany(Array.from({ length: 60 }, (_, i) => video(`v${i}`, { views: i })));
    await calculateAndFlagTrendingVideos();
    expect(await videos().countDocuments({ trending: true })).toBe(50);
  });

  test('running twice gives the same set', async () => {
    await videos().insertMany(Array.from({ length: 55 }, (_, i) => video(`v${i}`, { views: i })));
    await calculateAndFlagTrendingVideos();
    const first = await flagged();
    await calculateAndFlagTrendingVideos();
    expect(await flagged()).toEqual(first);
  });

  test('no candidates flags nothing and makes no Hive call', async () => {
    await calculateAndFlagTrendingVideos();
    expect(await videos().countDocuments({ trending: true })).toBe(0);
    expect(hive.fetchHiveRewards).not.toHaveBeenCalled();
  });

  test('a Hive reward miss scores the video on its Mongo numbers alone', async () => {
    await videos().insertOne(video('v', { views: 3 }));
    hive.fetchHiveRewards.mockResolvedValue(new Map());
    await calculateAndFlagTrendingVideos();
    expect(await flagged()).toEqual(['v']);
  });

  test('an error inside the run is logged, never thrown into the scheduler', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await videos().insertOne(video('v', { views: 3 }));
    hive.fetchHiveRewards.mockRejectedValue(new Error('boom'));
    await expect(calculateAndFlagTrendingVideos()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith('Error calculating trending videos:', expect.any(Error));
  });
});
