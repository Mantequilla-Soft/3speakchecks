/**
 * Lightning supports run (services/lightningSupports.js runOnce): which @v4vapp
 * credits become `supports` rows, who is named as the tipper, and that re-reading
 * the same history never counts a tip twice. @v4vapp's account history is stubbed
 * at utils/hive.historySince; the parsing helpers are covered in
 * tests/lightningSupports.test.js.
 */
jest.mock('../../utils/hive', () => ({
  ...jest.requireActual('../../utils/hive'),
  historySince: jest.fn(),
}));

const testDb = require('../helpers/db');
const { NOW, MINUTE, DAY } = require('./_fixtures');

const db = testDb.use();
const supports = () => db().collection('supports');
const realDb = require('../../utils/db');

const REAL_TIMERS = ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'];

// BOLT11 spec test vector and its payment hash (same as tests/lightningSupports.test.js).
const SPEC_INVOICE = 'lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql';
const SPEC_HASH = '0001020304050607080900010203040506070809000102030405060708090102';
const OTHER_HASH = 'ff'.repeat(32);

const hiveTs = (date) => date.toISOString().slice(0, 19);   // "2026-11-01T11:50:00", UTC without Z

/** A @v4vapp credit custom_json, as account history returns it. */
function credit({ trx = 'trx1', to = 'alice', sats = 1000, memo, hash = SPEC_HASH, at = new Date(NOW - 10 * MINUTE) } = {}) {
  return [1, {
    trx_id: trx, block: 100, timestamp: hiveTs(at),
    op: ['custom_json', {
      required_auths: ['v4vapp'], required_posting_auths: [], id: 'v4vapp_transfer',
      json: JSON.stringify({
        from_account: 'v4vapp', to_account: to, sats,
        memo: memo ?? `${to} | Great video! https://3speak.tv/watch?v=${to}/my-video #v4vapp #lightningaddress`,
        parent_id: Buffer.from(hash, 'hex').toString('base64'),
      }),
    }],
  }];
}
const payment = (from, memo = SPEC_INVOICE) => [2, { op: ['transfer', { from, to: 'v4vapp', amount: '1.000 HIVE', memo }] }];

let service;
let hive;
let credits;
let transfers;

/** A fresh copy of the service (its "covered until" mark starts empty) on the shared test database. */
function loadService() {
  jest.isolateModules(() => {
    jest.doMock('../../utils/db', () => realDb);
    hive = require('../../utils/hive');
    service = require('../../services/lightningSupports');
  });
  hive.historySince.mockImplementation(async (_account, _since, filter) => (filter === 4 ? transfers : credits));
}

beforeEach(async () => {
  jest.useFakeTimers({ now: NOW, doNotFake: REAL_TIMERS });
  credits = [];
  transfers = [];
  loadService();
  await db().collection('embed-video').insertOne({ owner: 'alice', permlink: 'my-video', short: false });
});
afterEach(() => jest.useRealTimers());

describe('recording a tip', () => {
  test('a credit linking the credited creator\'s own post becomes a SATS support from the Hive payer', async () => {
    credits = [credit()];
    transfers = [payment('Tibfox')];

    await service.runOnce();

    const rows = await supports().find({}, { projection: { _id: 0 } }).toArray();
    expect(rows).toEqual([{
      trx_id: 'trx1', tipper: 'tibfox', author: 'alice', permlink: 'my-video', kind: 'video',
      hbd_value: 0, amount: 1000, currency: 'SATS', hbd_per_hive: null, via: 'lightning',
      payment_hash: SPEC_HASH, memo: 'Great video! https://3speak.tv/watch?v=alice/my-video',
      block: 100, tippedAt: new Date(NOW - 10 * MINUTE), createdAt: NOW,
    }]);
  });

  test('a payment not made from Hive is recorded as anonymous', async () => {
    credits = [credit({ hash: OTHER_HASH })];
    transfers = [payment('tibfox')];
    await service.runOnce();
    expect((await supports().findOne({ trx_id: 'trx1' })).tipper).toBeNull();
  });

  test('a short is recorded with kind "short"', async () => {
    await db().collection('embed-video').insertOne({ owner: 'alice', permlink: 'clip', short: true });
    credits = [credit({ memo: 'alice | https://3speak.tv/shorts?v=alice/clip' })];
    await service.runOnce();
    expect((await supports().findOne({ trx_id: 'trx1' })).kind).toBe('short');
  });

  test('the first run reads a 7-day backfill in big pages; payers are looked up an hour before the oldest tip', async () => {
    credits = [credit({ at: new Date(NOW - 2 * DAY) })];
    await service.runOnce();

    const [first, second] = hive.historySince.mock.calls;
    expect(first).toEqual(['v4vapp', NOW - 7 * DAY, 2 ** 18, { pageSize: 1000 }]);
    expect(second).toEqual(['v4vapp', NOW - 2 * DAY - 60 * MINUTE, 4, { pageSize: 1000 }]);
  });

  test('later runs resume from the last run with a 10 minute overlap, in small pages', async () => {
    await service.runOnce();
    jest.setSystemTime(new Date(NOW.getTime() + 2 * MINUTE));
    hive.historySince.mockClear();

    await service.runOnce();

    expect(hive.historySince.mock.calls[0]).toEqual(['v4vapp', NOW - 10 * MINUTE, 2 ** 18, { pageSize: 100 }]);
  });
});

describe('what is not a tip', () => {
  test.each([
    ['a link to somebody else\'s post', { memo: 'alice | https://3speak.tv/watch?v=bob/my-video' }],
    ['no 3Speak link at all', { memo: 'alice | thanks!' }],
    ['a post we do not know', { memo: 'alice | https://3speak.tv/watch?v=alice/unknown' }],
    ['a credit older than the scan window', { at: new Date(NOW - 8 * DAY) }],
  ])('%s', async (_name, opts) => {
    credits = [credit(opts)];
    await service.runOnce();
    expect(await supports().countDocuments()).toBe(0);
  });

  test('a creator paying themselves is not support', async () => {
    credits = [credit()];
    transfers = [payment('alice')];
    await service.runOnce();
    expect(await supports().countDocuments()).toBe(0);
  });

  test('no tip credits means no payer lookup and no database work', async () => {
    credits = [credit({ memo: 'alice | hi' })];
    await service.runOnce();
    expect(hive.historySince).toHaveBeenCalledTimes(1);
  });
});

describe('idempotency and failures', () => {
  test('re-reading the same history never records a tip twice', async () => {
    credits = [credit(), credit({ trx: 'trx2', sats: 21 })];
    await service.runOnce();
    jest.setSystemTime(new Date(NOW.getTime() + 2 * MINUTE));
    await service.runOnce();

    expect(await supports().countDocuments()).toBe(2);
    // The second pass knew both trx ids, so it did not even look for payers.
    expect(hive.historySince.mock.calls.filter((c) => c[2] === 4)).toHaveLength(1);
  });

  test('a duplicate inside one batch is absorbed by the unique trx_id', async () => {
    credits = [credit(), credit()];
    await service.runOnce();
    expect(await supports().countDocuments()).toBe(1);
  });

  test('a Hive failure is logged, nothing is written, and the next run still backfills', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    hive.historySince.mockRejectedValueOnce(new Error('history unavailable'));

    await expect(service.runOnce()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith('[lightning-supports] run failed:', 'history unavailable');

    credits = [credit()];
    await service.runOnce();
    expect(hive.historySince.mock.calls[1][1]).toBe(NOW - 7 * DAY);   // the mark did not move
    expect(await supports().countDocuments()).toBe(1);
  });

  test('a second call while a run is in progress does nothing', async () => {
    let release;
    hive.historySince.mockImplementationOnce(() => new Promise((r) => { release = () => r([]); }));
    const first = service.runOnce();
    await service.runOnce();
    expect(hive.historySince).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  test('is on by default and polls every 2 minutes', () => {
    expect(service.enabled()).toBe(true);
    expect(service.INTERVAL_MIN).toBe(2);
  });
});
