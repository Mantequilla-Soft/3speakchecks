/**
 * The payment watcher (services/adPaymentWatch.js): credits unpaid bookings without
 * waiting for the advertiser to come back and press "I have sent it".
 *
 * The watcher keeps where its last scan reached in module memory, so every test
 * loads a fresh copy of it (jest.isolateModules) pointed at this worker's database.
 * The chain is a mocked utils/hive. Some tests use the real claim end to end, others
 * a recording claim to see exactly which bookings were claimed.
 */
jest.mock('../../utils/hive', () => ({
  ...jest.requireActual('../../utils/hive'),
  transfersSince: jest.fn(),
  hiveRpcBatch: jest.fn(),
}));

process.env.AD_PAYMENT_ACCOUNT = 'ads-account';

const { ObjectId } = require('mongodb');
const testDb = require('../helpers/db');
const F = require('./_fixtures');
const cfg = require('../../utils/config');

const db = testDb.use();
const ACCOUNT = 'ads-account';
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/** A fresh watcher (and its own mocked chain), optionally with a stand-in claim. */
function loadWatcher({ claim, env = {} } = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  let watcher;
  let hive;
  jest.isolateModules(() => {
    jest.doMock('../../utils/db', () => ({ getDb: () => db() }));
    if (claim) jest.doMock('../../services/adPaymentClaim', () => ({ claimCampaignPayment: claim }));
    hive = require('../../utils/hive');
    watcher = require('../../services/adPaymentWatch');
    // doMock is not scoped to the isolated registry; undo it for the rest of the file.
    jest.dontMock('../../utils/db');
    if (claim) jest.dontMock('../../services/adPaymentClaim');
  });
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  hive.transfersSince.mockResolvedValue([]);
  hive.hiveRpcBatch.mockResolvedValue([{ id: 1, result: { base: '0.250 HBD', quote: '1.000 HIVE' } }]);
  return { watcher, hive };
}

let seq = 0;
const pay = (memo, amount = '100.000 HBD', { from = 'adv', to = ACCOUNT } = {}) => {
  seq += 1;
  return F.transferEntry({ index: seq, trxId: `trx-${seq}`, from, to, amount, memo });
};
async function booking(over = {}) {
  const _id = new ObjectId();
  const c = {
    _id, memo: `ad:${_id}`, hiveAccount: 'adv', advertiserRef: 'adv-ref', status: 'awaiting_payment',
    priceHbd: 100, paidHbd: 0, days: 7, createdAt: new Date(F.NOW.getTime() - HOUR), ...over,
  };
  await F.cols(db()).campaigns.insertOne(c);
  return c;
}
const recordingClaim = () => jest.fn(async () => ({ body: { message: 'ok' } }));

beforeEach(() => {
  F.pinClock();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.useRealTimers());

describe('where a scan starts', () => {
  test('with no booking waiting nothing is read, and the next scan starts from now', async () => {
    const { watcher, hive } = loadWatcher({ claim: recordingClaim() });
    await watcher.runOnce();
    expect(hive.transfersSince).not.toHaveBeenCalled();

    await booking();
    jest.setSystemTime(new Date(F.NOW.getTime() + 2 * MIN));
    await watcher.runOnce();
    expect(hive.transfersSince).toHaveBeenCalledWith(ACCOUNT, F.NOW.getTime() - 10 * MIN, { pageSize: 100 });
  });

  test('the first run after boot reaches back to an hour before the oldest unpaid booking', async () => {
    const { watcher, hive } = loadWatcher({ claim: recordingClaim() });
    await booking({ createdAt: new Date(F.NOW.getTime() - 2 * F.DAY) });
    await booking({ createdAt: new Date(F.NOW.getTime() - 1 * F.DAY) });
    await watcher.runOnce();
    expect(hive.transfersSince).toHaveBeenCalledWith(ACCOUNT, F.NOW.getTime() - 2 * F.DAY - HOUR, { pageSize: 1000 });
  });

  test('a long-abandoned booking does not cost a deep history read: the reach is capped at the expiry window', async () => {
    const { watcher, hive } = loadWatcher({ claim: recordingClaim() });
    await booking({ createdAt: new Date(F.NOW.getTime() - 200 * F.DAY) });
    await watcher.runOnce();
    expect(hive.transfersSince).toHaveBeenCalledWith(ACCOUNT, F.NOW.getTime() - (cfg.AD_BOOKING_EXPIRY_DAYS + 1) * F.DAY, { pageSize: 1000 });
  });

  test('a booking with no date counts as booked now', async () => {
    const { watcher, hive } = loadWatcher({ claim: recordingClaim() });
    await booking({ createdAt: undefined });
    await watcher.runOnce();
    expect(hive.transfersSince).toHaveBeenCalledWith(ACCOUNT, F.NOW.getTime() - HOUR, { pageSize: 1000 });
  });

  test('a clean run moves the window up to when it started, minus a ten-minute overlap', async () => {
    const { watcher, hive } = loadWatcher({ claim: recordingClaim() });
    await booking();
    await watcher.runOnce();
    jest.setSystemTime(new Date(F.NOW.getTime() + 2 * MIN));
    await watcher.runOnce();
    expect(hive.transfersSince).toHaveBeenLastCalledWith(ACCOUNT, F.NOW.getTime() - 10 * MIN, { pageSize: 100 });
  });
});

describe('what gets claimed', () => {
  test('a booking whose payment shows up is credited and scheduled through the ordinary claim', async () => {
    const { watcher, hive } = loadWatcher();
    const c = await booking();
    hive.transfersSince.mockResolvedValue([pay(c.memo)]);
    await watcher.runOnce();
    expect(await F.cols(db()).campaigns.findOne({ _id: c._id })).toMatchObject({ status: 'scheduled', paidHbd: 100 });
    // The claim reused the history the watcher had already read.
    expect(hive.transfersSince).toHaveBeenCalledTimes(1);
  });

  test('a payment from the wrong account is queued for return exactly as a manual claim would', async () => {
    const { watcher, hive } = loadWatcher();
    const c = await booking();
    hive.transfersSince.mockResolvedValue([pay(c.memo, '100.000 HBD', { from: 'stranger' })]);
    await watcher.runOnce();
    expect(await F.cols(db()).payments.findOne({})).toMatchObject({ status: 'refused', refundStatus: 'pending', refundTo: 'stranger' });
    expect((await F.cols(db()).campaigns.findOne({ _id: c._id })).status).toBe('awaiting_payment');
  });

  test('only bookings with a transfer nobody has counted yet are claimed, with the history passed along', async () => {
    const claim = recordingClaim();
    const { watcher, hive } = loadWatcher({ claim });
    const counted = await booking();
    const fresh = await booking();
    const quiet = await booking();
    const ops = [pay(counted.memo), pay(fresh.memo.toUpperCase()), pay('ad:not-a-booking'), pay(quiet.memo, '1.000 HBD', { to: 'elsewhere' }), pay('hello')];
    await F.cols(db()).payments.insertOne({ trx_id: ops[0][1].trx_id, status: 'credited' });
    hive.transfersSince.mockResolvedValue(ops);
    await watcher.runOnce();
    expect(claim.mock.calls.map(([, id, opts]) => [String(id), opts.ops === ops])).toEqual([[String(fresh._id), true]]);
  });

  test('a booking that is paid twice in two transfers is claimed while any of them is uncounted', async () => {
    const claim = recordingClaim();
    const { watcher, hive } = loadWatcher({ claim });
    const c = await booking();
    const ops = [pay(c.memo, '50.000 HBD'), pay(c.memo, '50.000 HBD')];
    await F.cols(db()).payments.insertOne({ trx_id: ops[0][1].trx_id, status: 'credited' });
    hive.transfersSince.mockResolvedValue(ops);
    await watcher.runOnce();
    expect(claim).toHaveBeenCalledTimes(1);
  });
});

describe('failures', () => {
  test('one failing claim does not stop the others, and the window does not move past it', async () => {
    const claim = jest.fn()
      .mockRejectedValueOnce(new Error('claim broke'))
      .mockResolvedValue({ body: { error: 'No matching transfer found yet' } });
    const { watcher, hive } = loadWatcher({ claim });
    const a = await booking();
    const b = await booking();
    hive.transfersSince.mockResolvedValue([pay(a.memo), pay(b.memo)]);
    await watcher.runOnce();
    expect(claim).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith(`[ad-payment-watch] ${a._id} claim failed:`, 'claim broke');

    // Still the first-run reach, not a short catch-up page.
    await watcher.runOnce();
    expect(hive.transfersSince).toHaveBeenLastCalledWith(ACCOUNT, expect.any(Number), { pageSize: 1000 });
  });

  test('a HIVE payment the price feed could not value holds the window, and is credited once the feed is back', async () => {
    const { watcher, hive } = loadWatcher();
    const c = await booking();
    hive.transfersSince.mockResolvedValue([pay(c.memo, '400.000 HIVE')]);
    hive.hiveRpcBatch.mockResolvedValue([]); // every node down
    await watcher.runOnce();
    expect(await F.cols(db()).payments.countDocuments({})).toBe(0);
    expect((await F.cols(db()).campaigns.findOne({ _id: c._id })).paidHbd).toBe(0);

    hive.hiveRpcBatch.mockResolvedValue([{ id: 1, result: { base: '0.250 HBD', quote: '1.000 HIVE' } }]);
    await watcher.runOnce();
    // Still the first-run reach: the window did not move past the uncounted transfer.
    expect(hive.transfersSince).toHaveBeenLastCalledWith(ACCOUNT, expect.any(Number), { pageSize: 1000 });
    expect(await F.cols(db()).campaigns.findOne({ _id: c._id })).toMatchObject({ status: 'scheduled', paidHbd: 100, paidAssets: { HIVE: 400 } });
    expect(await F.cols(db()).payments.countDocuments({ status: 'credited' })).toBe(1);
  });

  test('a chain read that fails is logged, and the next run tries again from the same place', async () => {
    const { watcher, hive } = loadWatcher({ claim: recordingClaim() });
    await booking();
    hive.transfersSince.mockRejectedValueOnce(new Error('all nodes down'));
    await watcher.runOnce();
    expect(console.error).toHaveBeenCalledWith('[ad-payment-watch] run failed:', 'all nodes down');
    await watcher.runOnce();
    expect(hive.transfersSince).toHaveBeenCalledTimes(2);
    expect(hive.transfersSince.mock.calls[1][2]).toEqual({ pageSize: 1000 });
  });

  test('a run already in progress is not started a second time', async () => {
    const { watcher, hive } = loadWatcher({ claim: recordingClaim() });
    await booking();
    await Promise.all([watcher.runOnce(), watcher.runOnce()]);
    expect(hive.transfersSince).toHaveBeenCalledTimes(1);
  });
});

describe('switches', () => {
  test.each([
    ['on by default, outside the off stage', { AD_PAYMENT_WATCH_ENABLED: '', ADS_STAGE: 'public' }, true],
    ['off when AD_PAYMENT_WATCH_ENABLED=false', { AD_PAYMENT_WATCH_ENABLED: 'FALSE' }, false],
    ['off while ads are switched off', { ADS_STAGE: 'off' }, false],
  ])('%s', (_label, env, want) => {
    expect(loadWatcher({ env }).watcher.enabled()).toBe(want);
  });

  test.each([
    [undefined, 2], ['5', 5], ['0', 2], ['-3', 1], ['abc', 2],
  ])('AD_PAYMENT_WATCH_INTERVAL_MIN=%p gives a %p-minute interval', (value, want) => {
    const env = value === undefined ? {} : { AD_PAYMENT_WATCH_INTERVAL_MIN: value };
    expect(loadWatcher({ env }).watcher.INTERVAL_MIN).toBe(want);
  });
});
