/**
 * scripts/emulate-payout.cjs and the read-only handle under it (utils/readOnlyDb.js).
 *
 * The promise both make: the emulation reports exactly what a real settlement would
 * write, and the database is left byte-for-byte as it was, viewer and listener
 * rows included. The old script settled for real and then undid its writes; the undo
 * missed the `payoutId` stamped on viewer and listener rows. The "nothing changed"
 * test below is the one that would have caught it.
 */
jest.mock('../../utils/hive', () => ({ ...jest.requireActual('../../utils/hive'), hiveRpcBatch: jest.fn() }));

const { hiveRpcBatch } = require('../../utils/hive');
const testDb = require('../helpers/db');
const F = require('./_fixtures');
const P = require('../../services/adPayouts');
const cfg = require('../../utils/config');
const { ensureAdIndexes } = require('../../utils/adModel');
const { readOnlyDb } = require('../../utils/readOnlyDb');
const { emulate } = require('../../scripts/emulate-payout.cjs');

const db = testDb.use();
const period = P.periodContaining(F.PERIOD_AT.getTime());
const NAMES = [
  cfg.AD_CAMPAIGNS_COLLECTION, cfg.AD_IMPRESSIONS_COLLECTION, cfg.AD_PAYOUTS_COLLECTION,
  cfg.AD_PAYOUT_PERIODS_COLLECTION, cfg.AD_VIEWER_WATCH_COLLECTION, cfg.AD_LISTENER_LISTEN_COLLECTION,
];
const snapshot = async () => Object.fromEntries(await Promise.all(
  NAMES.map(async (n) => [n, JSON.stringify(await db().collection(n).find({}).sort({ _id: 1 }).toArray())]),
));

beforeAll(() => ensureAdIndexes());
beforeEach(() => {
  F.pinClock();
  hiveRpcBatch.mockReset();
  hiveRpcBatch.mockImplementation(F.contentChain());
});
afterEach(() => jest.useRealTimers());

/** A period with something for every kind of row: creator, streamer, viewer, stream viewer, listener. */
async function busyPeriod() {
  const c = await F.seedCampaign(db(), period);
  await F.seedImpressions(db(), c, 3, { owner: 'creator-x', period });
  await F.seedImpressions(db(), c, 1, { owner: 'host1', permlink: 'room-1', period, extra: { live: true } });
  await F.seedWatches(db(), [['viewer-a', 600]]);
  await F.seedWatches(db(), [['stream-b', 300]], { live: true });
  await F.seedListens(db(), [['carol', 'audio', 100]]);
}

describe('readOnlyDb', () => {
  test('reads are real; writes are recorded, answered, and never applied', async () => {
    await db().collection('things').insertOne({ _id: 1, n: 1 });
    const { db: ro, writes } = readOnlyDb(db());
    expect(await ro.collection('things').findOne({ _id: 1 })).toEqual({ _id: 1, n: 1 });
    expect(await ro.collection('things').find({}).toArray()).toHaveLength(1);
    expect(await ro.collection('things').countDocuments({})).toBe(1);

    expect(await ro.collection('things').updateOne({ _id: 1 }, { $set: { n: 2 } }, { upsert: true })).toMatchObject({ acknowledged: true });
    await ro.collection('things').updateMany({}, { $set: { n: 3 } });
    await ro.collection('things').insertOne({ _id: 2 });
    await ro.collection('things').insertMany([{ _id: 3 }, { _id: 4 }]);
    await ro.collection('things').deleteMany({});
    await ro.collection('things').bulkWrite([{ deleteOne: { filter: { _id: 1 } } }]);
    await ro.collection('things').findOneAndUpdate({ _id: 1 }, { $set: { n: 4 } });
    await ro.collection('things').createIndex({ n: 1 });
    await ro.collection('things').drop();

    expect(await db().collection('things').find({}).toArray()).toEqual([{ _id: 1, n: 1 }]);
    expect(writes.map((w) => w.op)).toEqual([
      'updateOne', 'updateMany', 'insertOne', 'insertMany', 'deleteMany', 'bulkWrite', 'findOneAndUpdate', 'createIndex', 'drop',
    ]);
    expect(writes[0]).toEqual({ collection: 'things', op: 'updateOne', args: [{ _id: 1 }, { $set: { n: 2 } }, { upsert: true }] });
  });

  test('a method it does not know is refused, not forwarded', () => {
    const { db: ro } = readOnlyDb(db());
    expect(() => ro.collection('things').someFutureWrite).toThrow(/not a known read, refused/);
    expect(() => ro.dropDatabase).toThrow(/not allowed/);
    expect(() => ro.admin).toThrow(/not allowed/);
  });

  test('the collection name and the database name still read through', () => {
    const { db: ro } = readOnlyDb(db());
    expect(ro.collection('things').collectionName).toBe('things');
    expect(ro.databaseName).toBe(db().databaseName);
  });
});

describe('emulate-payout', () => {
  test('leaves the database exactly as it was: payouts, periods, impressions, viewer AND listener rows', async () => {
    await busyPeriod();
    const before = await snapshot();
    const out = await emulate(db(), period, () => {});
    expect(out.rows.length).toBeGreaterThan(0);
    expect(await snapshot()).toEqual(before);
  });

  test('reports exactly what a real settlement then writes, labels and parts included', async () => {
    await busyPeriod();
    const out = await emulate(db(), period, () => {});
    const predicted = Object.fromEntries(out.rows.map((r) => [r.account, [r.hbd, r.kind, r.parts]]));

    await P.settlePeriod(db(), period);
    const real = await F.payoutsOf(db(), period.key);
    expect(predicted).toEqual(Object.fromEntries(Object.entries(real).map(([a, r]) => [a, [r.hbd, r.kind, r.parts]])));
    expect(predicted.host1[1]).toBe('streamer');
    expect(predicted['stream-b'][1]).toBe('stream-viewer');
    expect(predicted.carol[1]).toBe('listener');
  });

  test('says what it would claim and prints the period record', async () => {
    await busyPeriod();
    const lines = [];
    const out = await emulate(db(), period, (l) => lines.push(l));
    const text = lines.join('\n');
    expect(text).toMatch(/would claim: 4 impressions, 2 viewer rows, 1 listener rows/);
    expect(text).toMatch(/nothing was written: \d+ write\(s\) recorded and dropped/);
    expect(text).toMatch(/@host1 {2}50\.000 HBD|@host1 {2}\d+\.\d{3} HBD {2}\(streamer\)/);
    expect(out.period).toMatchObject({ impressions: 4, status: 'settled' });
  });

  test('an already settled period: says so and writes nothing', async () => {
    await busyPeriod();
    await P.settlePeriod(db(), period);
    const before = await snapshot();
    const lines = [];
    const out = await emulate(db(), period, (l) => lines.push(l));
    expect(out.result).toBeNull();
    expect(lines.join('\n')).toMatch(/already settled/);
    expect(await snapshot()).toEqual(before);
  });
});
