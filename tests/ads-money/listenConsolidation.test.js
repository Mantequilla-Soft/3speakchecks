/**
 * Listen-log consolidation (services/listenConsolidation.js): old rows of
 * `audio-listen-log` are counted into their track's lifetime totals and deleted.
 *
 * The money rule: a row is only ever dropped when it can no longer be owed anything,
 * that is when it was paid or was never payable. A payable row that is still unpaid
 * stays, however old, so a later payout can still pay it.
 *
 * Settings are read when the module loads, so each test loads its own copy. Real
 * MongoDB; "now" is injected.
 */
const testDb = require('../helpers/db');

const db = testDb.use();
const NOW = new Date('2027-06-01T00:00:00Z'); // five months back is 2027-01-01
const OLD = new Date('2026-06-15T00:00:00Z');
const log = () => db().collection('audio-listen-log');
const tracks = () => db().collection('embed-audio');

function loadConsolidation(env = {}, { getDb = () => db() } = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  let mod;
  jest.isolateModules(() => {
    jest.doMock('../../utils/db', () => ({ getDb }));
    mod = require('../../services/listenConsolidation');
    jest.dontMock('../../utils/db');
  });
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return mod;
}

const row = (permlink, over = {}) => ({ permlink, payable: true, paid: true, ppl: false, createdAt: OLD, ...over });
const trackOf = (permlink) => tracks().findOne({ permlink });

beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => {}));

describe('what is folded and removed', () => {
  test('old paid and old anonymous rows are counted into their track and deleted', async () => {
    await tracks().insertOne({ permlink: 'song', owner: 'artist' });
    await log().insertMany([row('song'), row('song'), row('song', { payable: false, paid: false })]);
    await loadConsolidation().runConsolidation(NOW);
    expect(await trackOf('song')).toMatchObject({ archivedListens: 3, archivedPayableListens: 2, listensConsolidatedAt: NOW });
    expect(await log().countDocuments({})).toBe(0);
  });

  test.each([
    ['a payable row that was never paid', { paid: false }],
    ['a legacy row from before `payable` existed, unpaid', { payable: undefined, paid: undefined }],
    ['a paid row younger than five months', { createdAt: new Date('2027-01-02T00:00:00Z') }],
  ])('%s is kept', async (_label, over) => {
    await tracks().insertOne({ permlink: 'song' });
    await log().insertOne(row('song', over));
    await loadConsolidation().runConsolidation(NOW);
    expect(await log().countDocuments({})).toBe(1);
    expect((await trackOf('song')).archivedListens).toBeUndefined();
  });

  test('totals already archived are added to, never replaced', async () => {
    await tracks().insertOne({ permlink: 'song', archivedListens: 10, archivedPayableListens: 4 });
    await log().insertMany([row('song'), row('song', { payable: false, paid: false })]);
    await loadConsolidation().runConsolidation(NOW);
    expect(await trackOf('song')).toMatchObject({ archivedListens: 12, archivedPayableListens: 5 });
  });

  test('a pay-per-listen row that is also a listening session is not archived as a second play', async () => {
    await tracks().insertOne({ permlink: 'song' });
    // Written after listening sessions started being kept (2026-10-31), so the play
    // is already counted from listen-durations.
    await log().insertMany([row('song', { ppl: true, createdAt: new Date('2026-11-15T00:00:00Z') }), row('song', { ppl: true })]);
    await loadConsolidation().runConsolidation(NOW);
    expect(await trackOf('song')).toMatchObject({ archivedListens: 1, archivedPayableListens: 2 });
    expect(await log().countDocuments({})).toBe(0);
  });

  test('rows of a track that no longer exists are still removed', async () => {
    await log().insertMany([row('deleted-song'), row('deleted-song')]);
    await loadConsolidation().runConsolidation(NOW);
    expect(await log().countDocuments({})).toBe(0);
    expect(await tracks().countDocuments({})).toBe(0);
  });

  test('large backlogs are worked through in batches until nothing eligible is left', async () => {
    await tracks().insertMany([{ permlink: 'a' }, { permlink: 'b' }]);
    await log().insertMany(Array.from({ length: 250 }, (_, i) => row(i % 2 ? 'a' : 'b', { payable: i % 5 !== 0 })));
    await log().insertOne(row('a', { paid: false })); // owed, and stays
    const find = jest.spyOn(log().constructor.prototype, 'find');
    await loadConsolidation({ LISTEN_CONSOLIDATE_BATCH: '100' }).runConsolidation(NOW);
    expect(await trackOf('a')).toMatchObject({ archivedListens: 125, archivedPayableListens: 100 });
    expect(await trackOf('b')).toMatchObject({ archivedListens: 125, archivedPayableListens: 100 });
    expect(await log().countDocuments({})).toBe(1);
    // 100 + 100 + 50, then an empty read that ends the loop.
    expect(find.mock.calls.filter(([q]) => q && q.createdAt).length).toBe(4);
  });

  test('LISTEN_CONSOLIDATE_MONTHS moves the cutoff', async () => {
    await log().insertOne(row('song', { createdAt: new Date('2027-04-15T00:00:00Z') }));
    await loadConsolidation({ LISTEN_CONSOLIDATE_MONTHS: '1' }).runConsolidation(NOW);
    expect(await log().countDocuments({})).toBe(0);
  });
});

describe('switches', () => {
  test('a dry run reports the plan and changes nothing', async () => {
    await tracks().insertOne({ permlink: 'song' });
    await log().insertMany([row('song'), row('song', { payable: false, paid: false })]);
    await loadConsolidation({ LISTEN_CONSOLIDATE_DRY_RUN: 'true' }).runConsolidation(NOW);
    expect(await log().countDocuments({})).toBe(2);
    expect((await trackOf('song')).archivedListens).toBeUndefined();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('DRY RUN: 2 rows across 1 tracks'));
  });

  test('without a database connection it does nothing', async () => {
    await expect(loadConsolidation({}, { getDb: () => undefined }).runConsolidation(NOW)).resolves.toBeUndefined();
  });

  test('schedule() checks a minute after boot, then on its interval, and logs a failing check', async () => {
    const realTimeout = global.setTimeout;
    const realInterval = global.setInterval;
    jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms, ...a) => (ms === 60 * 1000 ? 0 : realTimeout(fn, ms, ...a)));
    jest.spyOn(global, 'setInterval').mockImplementation((fn, ms, ...a) => (ms === 6 * 3600 * 1000 ? 0 : realInterval(fn, ms, ...a)));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const mod = loadConsolidation({ LISTEN_CONSOLIDATE_CHECK_HOURS: '6' }, { getDb: () => { throw new Error('no database'); } });
    mod.schedule();
    const first = setTimeout.mock.calls.find(([, ms]) => ms === 60 * 1000);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('checking every 6h [ACTIVE]'));
    first[0]();
    const interval = setInterval.mock.calls.find(([, ms]) => ms === 6 * 3600 * 1000);
    expect(interval).toBeDefined();
    interval[0]();
    await new Promise((r) => setImmediate(r));
    expect(console.error).toHaveBeenCalledWith('[listenConsolidate] tick error:', expect.any(Error));
  });
});
