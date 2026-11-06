/**
 * routes/promote.js: paid video promotion. The frontend transfers HBD or HIVE to the
 * promotion account with memo `promote:<author>/<permlink>`, then calls /promote/claim.
 * The value credited must come only from the chain, each transfer must count once,
 * and the promotion is capped at MAX_PROMOTION_DAYS from now.
 *
 * Hive is a jest.fn (account history and the median price); the videos and the
 * payment ledger are real MongoDB collections.
 */
const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp, apiKeyHeader } = require('../helpers/app');
const { pinClock, NOW } = require('./_fixtures');

jest.mock('../../utils/hive', () => ({ ...jest.requireActual('../../utils/hive'), hiveRpcBatch: jest.fn() }));
const { hiveRpcBatch } = require('../../utils/hive');
const { PROMOTION_ACCOUNT, COST_PER_24H_PROMOTION_HBD, MAX_PROMOTION_DAYS } = require('../../utils/config');

const db = testDb.use();
const app = buildApp(['/', require('../../routes/promote')]);
const DAY = 24 * 3600 * 1000;

// What the chain says, per test.
let history = [];
let price = { base: '0.250 HBD', quote: '1.000 HIVE' }; // 1 HIVE = 0.25 HBD

let seq = 0;
const transfer = (amount, memo, extra = {}) => [seq++, {
  trx_id: extra.trx_id || `trx-${seq}`,
  op: ['transfer', { from: 'payer', to: PROMOTION_ACCOUNT, amount, memo, ...extra.op }],
}];

beforeEach(() => {
  pinClock();
  history = [];
  price = { base: '0.250 HBD', quote: '1.000 HIVE' };
  hiveRpcBatch.mockReset();
  hiveRpcBatch.mockImplementation(async ([call]) => {
    if (call.method === 'condenser_api.get_account_history') return [{ result: history }];
    if (call.method === 'condenser_api.get_current_median_history_price') return [{ result: price }];
    throw new Error(`unexpected ${call.method}`);
  });
});
afterEach(() => jest.useRealTimers());

const claim = (body, headers = apiKeyHeader()) => request(app).put('/promote/claim').set(headers).send(body);
const embed = (extra = {}) => db().collection('embed-video').insertOne({ owner: 'alice', permlink: 'vid', ...extra });
const promotedUntil = async (coll = 'embed-video') => (await db().collection(coll).findOne())?.promotedUntil;

describe('GET /promote/quote', () => {
  test('publishes the account, the price per day, the cap and the HIVE price', async () => {
    const res = await request(app).get('/promote/quote').expect(200);
    expect(res.body).toEqual({
      success: true, account: PROMOTION_ACCOUNT, costPer24hHbd: COST_PER_24H_PROMOTION_HBD,
      maxDays: MAX_PROMOTION_DAYS, hbdPerHive: 0.25,
    });
  });

  test('an unreadable price feed reads as 0 rather than a crash', async () => {
    price = { base: 'n/a', quote: '' };
    expect((await request(app).get('/promote/quote').expect(200)).body.hbdPerHive).toBe(0);
  });

  test('a Hive outage is a 500', async () => {
    hiveRpcBatch.mockRejectedValue(new Error('all nodes down'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await request(app).get('/promote/quote').expect(500);
  });
});

describe('GET /promote/status', () => {
  test('an embed video promoted into the future is promoted', async () => {
    await embed({ hive_author: 'alice', hive_permlink: 'hive-vid', promotedUntil: new Date(NOW.getTime() + DAY) });
    const res = await request(app).get('/promote/status/alice/hive-vid').expect(200);
    expect(res.body).toEqual({ success: true, promoted: true, promotedUntil: new Date(NOW.getTime() + DAY).toISOString() });
  });

  test('a legacy video whose promotion ran out is not promoted', async () => {
    await db().collection('videos').insertOne({ owner: 'alice', permlink: 'old', promotedUntil: new Date(NOW.getTime() - 1) });
    expect((await request(app).get('/promote/status/alice/old').expect(200)).body.promoted).toBe(false);
  });

  test('an unknown video is simply not promoted', async () => {
    expect((await request(app).get('/promote/status/nobody/nothing').expect(200)).body)
      .toEqual({ success: true, promotedUntil: null, promoted: false });
  });
});

describe('PUT /promote/claim: access and input', () => {
  test.each([
    ['no Authorization header', {}],
    ['a wrong key', { Authorization: 'Bearer wrong' }],
    ['a non-bearer scheme', { Authorization: `Token ${process.env.API_SECRET_KEY}` }],
    ['a header with extra parts', { Authorization: `Bearer ${process.env.API_SECRET_KEY} extra` }],
  ])('%s is a 401 and reads nothing from Hive', async (_label, headers) => {
    await embed();
    history = [transfer('1.000 HBD', 'promote:alice/vid')];
    await claim({ author: 'alice', permlink: 'vid' }, headers).expect(401);
    expect(hiveRpcBatch).not.toHaveBeenCalled();
    expect(await promotedUntil()).toBeUndefined();
  });

  test.each([[{}], [{ author: 'alice' }], [{ permlink: 'vid' }]])('a missing author or permlink (%j) is a 400', async (body) => {
    await claim(body).expect(400);
  });

  test('a video that is not indexed yet is a 404 and the payment stays unclaimed for a retry', async () => {
    history = [transfer('1.000 HBD', 'promote:alice/vid')];
    const res = await claim({ author: 'alice', permlink: 'vid' }).expect(404);
    expect(res.body.error).toBe('Video not indexed yet');
    expect(await db().collection('promotion_payments').countDocuments()).toBe(0);
  });

  // The body goes into the Mongo filter unchecked, so {"$ne": null} matches any
  // video, and the expected memo becomes "promote:[object object]/[object object]".
  // A payer who sends that literal memo promotes whichever video Mongo returns first.
  // author/permlink should be required to be strings. (routes/promote.js:86-98)
  test('an operator object as author/permlink is refused, not used as a query', async () => {
    await embed({ owner: 'victim-or-random', permlink: 'whatever' });
    history = [transfer('1.000 HBD', 'promote:[object Object]/[object Object]')];
    await claim({ author: { $ne: null }, permlink: { $ne: null } }).expect(400);
    expect(await promotedUntil()).toBeUndefined();
  });
});

describe('PUT /promote/claim: crediting', () => {
  test('1 HBD at 0.5 HBD a day buys two days from now, recorded once in the ledger', async () => {
    await embed();
    history = [transfer('1.000 HBD', 'promote:alice/vid', { trx_id: 'abc' })];

    const res = await claim({ author: 'alice', permlink: 'vid' }).expect(200);

    const until = new Date(NOW.getTime() + 2 * DAY);
    expect(res.body).toMatchObject({ success: true, message: 'Promotion credited', addedDays: 2, valueHbd: 1, promotedUntil: until.toISOString() });
    expect(await promotedUntil()).toEqual(until);
    expect(await db().collection('promotion_payments').find({}, { projection: { _id: 0 } }).toArray())
      .toEqual([{ trx_id: 'abc', author: 'alice', permlink: 'vid', from: 'payer', amount: '1.000 HBD', processedAt: NOW }]);
  });

  test('HIVE is valued at the on-chain median price, never at a client figure', async () => {
    await embed();
    history = [transfer('4.000 HIVE', 'promote:alice/vid')];
    const res = await claim({ author: 'alice', permlink: 'vid', amount: '1000 HBD', valueHbd: 1000 }).expect(200);
    expect(res.body).toMatchObject({ valueHbd: 1, addedDays: 2 });
  });

  test('the memo match ignores case and surrounding space, but needs the exact video', async () => {
    await embed();
    history = [
      transfer('0.500 HBD', '  PROMOTE:Alice/VID  '),
      transfer('9.000 HBD', 'promote:alice/vid-other'),
      transfer('9.000 HBD', 'promote:alice/vid please'),
    ];
    expect((await claim({ author: 'alice', permlink: 'vid' }).expect(200)).body.addedDays).toBe(1);
  });

  test('only transfers TO the promotion account with a transaction id count', async () => {
    await embed();
    history = [
      transfer('5.000 HBD', 'promote:alice/vid', { op: { to: 'someone-else' } }),
      [99, { trx_id: '', op: ['transfer', { to: PROMOTION_ACCOUNT, amount: '5.000 HBD', memo: 'promote:alice/vid' }] }],
      [98, { trx_id: 'x', op: ['vote', { memo: 'promote:alice/vid' }] }],
      [97, null],
    ];
    const res = await claim({ author: 'alice', permlink: 'vid' }).expect(404);
    expect(res.body.error).toBe('No payment found');
  });

  test('a replayed claim credits nothing the second time', async () => {
    await embed();
    history = [transfer('1.000 HBD', 'promote:alice/vid', { trx_id: 'once' })];
    await claim({ author: 'alice', permlink: 'vid' }).expect(200);
    const res = await claim({ author: 'alice', permlink: 'vid' }).expect(200);
    expect(res.body).toMatchObject({ message: 'Already credited', addedDays: 0, promotedUntil: new Date(NOW.getTime() + 2 * DAY).toISOString() });
  });

  test('two claims racing for the same transfer credit it exactly once', async () => {
    await embed();
    history = [transfer('1.000 HBD', 'promote:alice/vid', { trx_id: 'race' })];
    const results = await Promise.all([claim({ author: 'alice', permlink: 'vid' }), claim({ author: 'alice', permlink: 'vid' })]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results.map((r) => r.body.addedDays).sort()).toEqual([0, 2]);
    expect(await promotedUntil()).toEqual(new Date(NOW.getTime() + 2 * DAY));
  });

  test('a new payment extends a running promotion instead of restarting it', async () => {
    await embed({ promotedUntil: new Date(NOW.getTime() + DAY) });
    history = [transfer('0.500 HBD', 'promote:alice/vid')];
    await claim({ author: 'alice', permlink: 'vid' }).expect(200);
    expect(await promotedUntil()).toEqual(new Date(NOW.getTime() + 2 * DAY));
  });

  test('a promotion is capped at the maximum days from now, however much was paid', async () => {
    await embed();
    history = [transfer('100.000 HBD', 'promote:alice/vid')];
    await claim({ author: 'alice', permlink: 'vid' }).expect(200);
    expect(await promotedUntil()).toEqual(new Date(NOW.getTime() + MAX_PROMOTION_DAYS * DAY));
  });

  test('a video that exists both as embed and legacy gets the promotion on both rows', async () => {
    await embed();
    await db().collection('videos').insertOne({ owner: 'alice', permlink: 'vid' });
    history = [transfer('0.500 HBD', 'promote:alice/vid')];
    await claim({ author: 'alice', permlink: 'vid' }).expect(200);
    const until = new Date(NOW.getTime() + DAY);
    expect(await promotedUntil('embed-video')).toEqual(until);
    expect(await promotedUntil('videos')).toEqual(until);
  });

  test('an unknown token symbol is worth nothing', async () => {
    await embed();
    history = [transfer('50.000 STEEM', 'promote:alice/vid')];
    expect((await claim({ author: 'alice', permlink: 'vid' }).expect(200)).body).toMatchObject({ valueHbd: 0, addedDays: 0 });
  });

  test('if writing the credit fails, the ledger reservation is rolled back so the payment is not lost', async () => {
    await embed();
    history = [transfer('1.000 HBD', 'promote:alice/vid', { trx_id: 'keep-me' })];
    const { Collection } = require('mongodb');
    jest.spyOn(Collection.prototype, 'updateOne').mockRejectedValueOnce(new Error('write conflict'));
    jest.spyOn(console, 'error').mockImplementation(() => {});

    await claim({ author: 'alice', permlink: 'vid' }).expect(500);
    expect(await db().collection('promotion_payments').countDocuments()).toBe(0);

    // The retry then credits the same transfer normally.
    jest.restoreAllMocks();
    expect((await claim({ author: 'alice', permlink: 'vid' }).expect(200)).body.addedDays).toBe(2);
  });

  test('a Hive outage while reading history is a 500, not a silent no-payment', async () => {
    await embed();
    hiveRpcBatch.mockRejectedValue(new Error('timeout'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await claim({ author: 'alice', permlink: 'vid' }).expect(500);
    expect(res.body.message).toBe('Failed to verify promotion payment');
  });
});
