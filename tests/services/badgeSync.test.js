/**
 * Badge index refresh (services/badgeSync.js): a run reports what the index did
 * and a failed run is never fatal (the directory keeps last time's rows). The
 * indexer itself (utils/badgeIndex.runBadgeIndex) is stubbed.
 */
jest.mock('../../utils/badgeIndex', () => ({ runBadgeIndex: jest.fn() }));

const { runBadgeIndex } = require('../../utils/badgeIndex');
const { runOnce } = require('../../services/badgeSync');

beforeEach(() => runBadgeIndex.mockReset());

test('a successful run logs how many badges were indexed', async () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  runBadgeIndex.mockResolvedValue({ imported: 12, indexed: 340 });

  await runOnce();

  expect(runBadgeIndex).toHaveBeenCalledTimes(1);
  expect(log.mock.calls[0][0]).toMatch(/^\[badges\] indexed 340 badges \(12 in the peakd list\) in \d+ms$/);
});

test('a failed run is logged and swallowed, so the scheduler keeps going', async () => {
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  runBadgeIndex.mockRejectedValue(new Error('hive unreachable'));

  await expect(runOnce()).resolves.toBeUndefined();

  expect(error).toHaveBeenCalledWith('[badges] index run failed:', 'hive unreachable');
});
