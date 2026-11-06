/**
 * routes/supports.js: recording a tip only for a real on-chain transfer, the
 * public tip lists and totals, and hiding a tip, which only the creator who
 * received it may do with a posting-authority signature.
 *
 * Account history and the price feed (utils/hive) are mocked; signatures are
 * real against the fake chain in tests/helpers/hive.js.
 */
const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const { hiveAccount, fakeHiveChain } = require('../helpers/hive');
const { NOW, pinClock } = require('./_fixtures');

jest.mock('../../utils/hive', () => ({
  ...jest.requireActual('../../utils/hive'),
  transfersSince: jest.fn(),
  hiveRpcBatch: jest.fn(),
}));
const { transfersSince, hiveRpcBatch } = require('../../utils/hive');
const hidden = require('../../utils/hiddenCreators');
const supports = require('../../routes/supports');

const app = buildApp(['/', supports]);
const db = testDb.use();

// The chain: alice granted posting authority to @threespeak (which we sign with)
// and to @peakd (which we do not accept for this).
const alice = hiveAccount('alice', { postingDelegates: ['threespeak', 'peakd'] });
const bob = hiveAccount('bob');
const threespeak = hiveAccount('threespeak');
const peakd = hiveAccount('peakd');
const mallory = hiveAccount('mallory');
const erin = hiveAccount('erin');

const hiveTime = (d) => new Date(d).toISOString().slice(0, 19); // Hive stamps: UTC, no zone
const trx = (n) => String(n).padStart(40, '0');
/** One account-history entry for a transfer. */
const transfer = ({ n = 1, from, to = 'alice', amount = '1.000 HBD', memo = '', at = NOW.getTime() - 60000, block = 100 + n }) =>
  [n, { trx_id: trx(n), block, timestamp: hiveTime(at), op: ['transfer', { from, to, amount, memo }] }];

// A fresh tipper per test, so the per-tipper rate limit never carries over.
let tipperCounter = 0;
let tipper;

beforeEach(async () => {
  pinClock();
  tipperCounter += 1;
  tipper = `fan${tipperCounter}`;
  transfersSince.mockReset();
  hiveRpcBatch.mockReset();
  transfersSince.mockResolvedValue([]);
  fakeHiveChain([alice, bob, threespeak, peakd, mallory, erin]);
  await db().collection('embed-video').insertMany([
    { owner: 'alice', permlink: 'vid1', hive_author: 'alice', hive_permlink: 'my-video', hive_title: 'My video', thumbnail_url: 'https://img/v.jpg' },
    { owner: 'alice', permlink: 'sht1', short: true, originalFilename: 'clip.mp4' },
  ]);
  await db().collection('videos').insertOne({ owner: 'alice', permlink: 'legacy1', title: 'Old one', thumbnail: 'ipfs://thumb' });
  await db().collection('embed-audio').insertOne({ owner: 'alice', permlink: 'aud1', post_permlink: 'my-song', title: 'Song' });
  await hidden.refresh(db());
});
afterEach(() => jest.useRealTimers());

// ─── POST /supports/record ───────────────────────────────────────────────────

describe('POST /supports/record: input', () => {
  const record = (body) => request(app).post('/supports/record').send({ tipper, author: 'alice', permlink: 'vid1', amount: '1', currency: 'HBD', ...body });

  test.each([
    ['a malformed tipper', { tipper: 'X' }],
    ['a malformed author', { author: '-bad' }],
    ['a permlink with spaces', { permlink: 'a b' }],
    ['no permlink', { permlink: '' }],
  ])('%s is a 400', async (_label, body) => {
    await record(body).expect(400);
  });

  test('a creator cannot support themselves', async () => {
    const res = await record({ tipper: 'alice' }).expect(400);
    expect(res.body.error).toBe('A creator cannot support themselves');
  });

  test.each([
    ['an unsupported currency', { currency: 'BTC' }],
    ['a zero amount', { amount: '0' }],
    ['a negative amount', { amount: '-5' }],
    ['a non-numeric amount', { amount: 'lots' }],
  ])('%s is a 400', async (_label, body) => {
    await record(body).expect(400);
  });

  test("a permlink the author does not own is a 404, so a tip can't be credited to someone else's video", async () => {
    await record({ author: 'bob' }).expect(404);
    expect(transfersSince).not.toHaveBeenCalled();
  });
});

describe('POST /supports/record: only a real transfer is recorded', () => {
  const record = (body = {}) => request(app).post('/supports/record')
    .send({ tipper, author: 'alice', permlink: 'vid1', amount: '1.000', currency: 'HBD', ...body });
  const rows = () => db().collection('supports').find().toArray();

  test('a matching transfer is stored with the trx id, block and time from the chain', async () => {
    transfersSince.mockResolvedValue([transfer({ from: tipper, memo: 'Great\u0007 video\nthanks' })]);
    const res = await record({ amount: '1', trx_id: 'f'.repeat(40), tippedAt: '2020-01-01' }).expect(200);
    expect(res.body.recorded).toBe(true);
    expect(transfersSince).toHaveBeenCalledWith(tipper, NOW.getTime() - 24 * 3600 * 1000, { maxPages: 10, pageSize: 1000 });
    const [row] = await rows();
    expect(row).toMatchObject({
      trx_id: trx(1), tipper, author: 'alice', permlink: 'vid1', kind: 'video',
      amount: 1, currency: 'HBD', hbd_value: 1, hbd_per_hive: null, block: 101,
      memo: 'Great video\nthanks',
    });
    expect(row.tippedAt).toEqual(new Date(NOW.getTime() - 60000));
  });

  test.each([
    ['sent to someone else', { to: 'bob' }],
    ['of another amount', { amount: '2.000 HBD' }],
    ['in another currency', { amount: '1.000 HIVE' }],
    ['older than a day', { at: NOW.getTime() - 25 * 3600 * 1000 }],
    ['with another memo', { memo: 'something else' }],
  ])('a transfer %s does not match: pending (202)', async (_label, t) => {
    transfersSince.mockResolvedValue([transfer({ from: tipper, memo: 'thanks', ...t })]);
    const res = await record({ memo: 'thanks' }).expect(202);
    expect(res.body).toEqual({ success: true, pending: true });
    expect(await rows()).toHaveLength(0);
  });

  test('other operations and entries without a trx id are ignored', async () => {
    const vote = [1, { trx_id: trx(1), timestamp: hiveTime(NOW), op: ['vote', { voter: tipper }] }];
    const noTrx = transfer({ from: tipper });
    delete noTrx[1].trx_id;
    transfersSince.mockResolvedValue([vote, noTrx, [3, null]]);
    await record().expect(202);
  });

  test('an encrypted memo in the report does not have to match, and an encrypted memo on chain is not kept', async () => {
    transfersSince.mockResolvedValue([transfer({ from: tipper, memo: '#ciphertext' })]);
    await record({ memo: '#whatever' }).expect(200);
    expect((await rows())[0].memo).toBeNull();
  });

  test('a transfer that is already counted is not counted twice', async () => {
    transfersSince.mockResolvedValue([transfer({ from: tipper })]);
    await record().expect(200);
    const again = await record().expect(200);
    expect(again.body).toEqual({ success: true, recorded: false, reason: 'already_recorded' });
    expect(await rows()).toHaveLength(1);
  });

  test('two identical tips in a row each get their own row, newest first', async () => {
    transfersSince.mockResolvedValue([
      transfer({ n: 1, from: tipper, at: NOW.getTime() - 120000 }),
      transfer({ n: 2, from: tipper, at: NOW.getTime() - 60000 }),
    ]);
    expect((await record().expect(200)).body.support.trx_id).toBe(trx(2));
    expect((await record().expect(200)).body.support.trx_id).toBe(trx(1));
    expect((await record().expect(200)).body.reason).toBe('already_recorded');
  });

  test('a HIVE tip is valued at the on-chain median price, which is stored on the row', async () => {
    transfersSince.mockResolvedValue([transfer({ from: tipper, amount: '0.001 HIVE' })]);
    hiveRpcBatch.mockResolvedValue([{ result: { base: '0.250 HBD', quote: '1.000 HIVE' } }]);
    const res = await record({ amount: '0.001', currency: 'hive' }).expect(200);
    // Six decimals, so a tiny tip is not rounded to zero.
    expect(res.body.support).toMatchObject({ currency: 'HIVE', hbd_value: 0.00025, hbd_per_hive: 0.25 });
    expect(hiveRpcBatch.mock.calls[0][0][0].method).toBe('condenser_api.get_current_median_history_price');
  });

  test('no HIVE price is a 503 and nothing is stored', async () => {
    transfersSince.mockResolvedValue([transfer({ from: tipper, amount: '1.000 HIVE' })]);
    hiveRpcBatch.mockResolvedValue([{ result: {} }]);
    await record({ currency: 'HIVE' }).expect(503);
    expect(await rows()).toHaveLength(0);
  });

  test.each([
    ['the Hive permlink of an embed video', 'my-video', 'video'],
    ['a short', 'sht1', 'short'],
    ['a legacy video', 'legacy1', 'video'],
    ['an audio post', 'my-song', 'audio'],
  ])('a tip on %s is recorded with its kind', async (_label, permlink, kind) => {
    transfersSince.mockResolvedValue([transfer({ from: tipper })]);
    const res = await record({ permlink }).expect(200);
    expect(res.body.support).toMatchObject({ permlink, kind });
  });

  test('a history read that fails is a 500, not a crash', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    transfersSince.mockRejectedValue(new Error('node down'));
    await record().expect(500);
  });

  test('one tipper can report 30 times in ten minutes; the 31st is a 429', async () => {
    for (let i = 0; i < 30; i += 1) await record().expect(202);
    const res = await record().expect(429);
    expect(res.body).toEqual({ success: false, error: 'Too many requests' });
  });
});

// ─── the public lists ────────────────────────────────────────────────────────

describe('the tip lists', () => {
  const tip = (n, extra) => ({
    trx_id: trx(n), tipper: 'bob', author: 'alice', permlink: 'vid1', kind: 'video',
    amount: 1, currency: 'HBD', hbd_value: 1, tippedAt: new Date(NOW.getTime() - n * 60000), createdAt: NOW, ...extra,
  });
  beforeEach(() => db().collection('supports').insertMany([
    tip(1, { hbd_value: 2.5 }),
    tip(2, { tipper: 'carol', permlink: 'my-video' }),
    tip(3, { tipper: null, currency: 'SATS', amount: 1000, hbd_value: 0, via: 'lightning' }),
    tip(4, { tipper: 'carol', permlink: 'legacy1', hidden: true }),
    tip(5, { tipper: 'carol', permlink: 'sht1' }),
    tip(6, { permlink: 'my-song', kind: 'audio' }),
    tip(7, { author: 'dave', permlink: 'x' }),
  ]));

  test("a creator's received tips: newest first, hidden ones out, HBD and sats totalled apart", async () => {
    const res = await request(app).get('/supports/alice').expect(200);
    expect(res.body).toMatchObject({ success: true, total: 5, total_hbd: 5.5, total_sats: 1000, page: 1, limit: 20 });
    expect(res.body.items.map((i) => i.trx_id)).toEqual([1, 2, 3, 5, 6].map(trx));
    expect(res.body.items[0]).not.toHaveProperty('_id');
  });

  test('each tip carries the video it was sent from, by asset or Hive permlink', async () => {
    const { items } = (await request(app).get('/supports/alice?includeHidden=1').expect(200)).body;
    const video = Object.fromEntries(items.map((i) => [i.permlink, i.video]));
    expect(video.vid1).toMatchObject({ title: 'My video', thumbnail: 'https://img/v.jpg', short: false, asset_permlink: 'vid1' });
    expect(video['my-video']).toEqual(video.vid1);
    expect(video.sht1).toMatchObject({ title: 'clip.mp4', short: true, thumbnail: 'https://img.3speak.tv/sht1/thumbnail.png' });
    expect(video.legacy1).toEqual({ title: 'Old one', thumbnail: 'ipfs://thumb', short: false });
    expect(video['my-song']).toEqual({ title: 'Song', thumbnail: '', short: false });
  });

  test("the creator's own tab lists hidden tips too, flagged, while the total stays the visible one", async () => {
    const res = await request(app).get('/supports/alice?includeHidden=1').expect(200);
    expect(res.body.total).toBe(6);
    expect(res.body.total_hbd).toBe(5.5);
    expect(res.body.items.find((i) => i.trx_id === trx(4)).hidden).toBe(true);
  });

  test('paging and the limit cap', async () => {
    const res = await request(app).get('/supports/alice?page=2&limit=2').expect(200);
    expect(res.body.items.map((i) => i.trx_id)).toEqual([trx(3), trx(5)]);
    expect((await request(app).get('/supports/alice?limit=500').expect(200)).body.limit).toBe(50);
  });

  test('distinct supporters, biggest first; anonymous Lightning tips are one supporter', async () => {
    const res = await request(app).get('/supports/alice/supporters').expect(200);
    expect(res.body.total).toBe(3);
    expect(res.body.supporters.map((s) => [s.tipper, s.hbd_total, s.sats_total, s.count])).toEqual([
      ['bob', 3.5, 0, 2], ['carol', 2, 0, 2], [null, 0, 1000, 1],
    ]);
    expect((await request(app).get('/supports/alice/supporters?limit=1').expect(200)).body.supporters).toHaveLength(1);
  });

  test("what a tipper gave, and the creators they supported", async () => {
    const given = await request(app).get('/supports/by/bob').expect(200);
    expect(given.body.items.map((i) => i.trx_id)).toEqual([trx(1), trx(6), trx(7)]);
    const supported = await request(app).get('/supports/by/bob/supported').expect(200);
    expect(supported.body).toMatchObject({ total: 2 });
    expect(supported.body.supported.map((s) => [s.author, s.hbd_total, s.count])).toEqual([['alice', 3.5, 2], ['dave', 1, 1]]);
  });

  test('a hidden creator shows nowhere: not as author, not as tipper, not as a chip', async () => {
    await db().collection('contentcreators').insertOne({ username: 'dave', hidden: true });
    await hidden.refresh(db());
    expect((await request(app).get('/supports/dave').expect(200)).body).toMatchObject({ total: 0, items: [] });
    expect((await request(app).get('/supports/dave/supporters').expect(200)).body).toEqual({ success: true, total: 0, supporters: [] });
    expect((await request(app).get('/supports/by/dave').expect(200)).body.items).toEqual([]);
    expect((await request(app).get('/supports/by/dave/supported').expect(200)).body.supported).toEqual([]);
    // Bob's tip to dave drops out of what bob gave, and out of his chips.
    expect((await request(app).get('/supports/by/bob').expect(200)).body.items.map((i) => i.author)).not.toContain('dave');
    expect((await request(app).get('/supports/by/bob/supported').expect(200)).body.supported.map((s) => s.author)).toEqual(['alice']);
  });

  test.each([
    ['/supports/X!'],
    ['/supports/ab/supporters'],
    ['/supports/by/-x'],
    ['/supports/by/-x/supported'],
  ])('%s is a 400', async (path) => {
    await request(app).get(path).expect(400);
  });

  test('a list read that fails is a 500', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(require('mongodb').Collection.prototype, 'countDocuments').mockRejectedValue(new Error('db down'));
    await request(app).get('/supports/alice').expect(500);
    await request(app).get('/supports/by/bob').expect(500);
  });

  test('an aggregate that fails is a 500', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(require('mongodb').Collection.prototype, 'aggregate').mockImplementation(() => { throw new Error('db down'); });
    await request(app).get('/supports/alice/supporters').expect(500);
    await request(app).get('/supports/by/bob/supported').expect(500);
  });
});

// ─── POST /supports/hide ─────────────────────────────────────────────────────

describe('POST /supports/hide: only the creator who received a tip', () => {
  const { hideMessage } = supports._test;
  const TRX = trx(9);
  const signed = (signer, { author = 'alice', trxId = TRX, action = 'hide', ts = Date.now() } = {}) => ({
    author, trx_id: trxId, hidden: action === 'hide', timestamp: ts,
    signature: signer.sign(hideMessage(author, trxId, action, ts)),
  });
  const hide = (body) => request(app).post('/supports/hide').send(body);
  const tipRow = () => db().collection('supports').findOne({ trx_id: TRX });

  beforeEach(() => db().collection('supports').insertOne({ trx_id: TRX, tipper: 'bob', author: 'alice', permlink: 'vid1', hbd_value: 1 }));

  test.each([
    ['a malformed author', { author: 'X', trx_id: TRX, hidden: true }],
    ['a trx id that is not 40 hex characters', { author: 'alice', trx_id: 'abc', hidden: true }],
    ['no hidden flag', { author: 'alice', trx_id: TRX }],
    ['a hidden flag that is not a boolean', { author: 'alice', trx_id: TRX, hidden: 'yes' }],
  ])('%s is a 400', async (_label, body) => {
    await hide(body).expect(400);
  });

  test('no signature is a 401 that names the message to sign', async () => {
    const res = await hide({ author: 'alice', trx_id: TRX, hidden: true }).expect(401);
    expect(res.body.expected_message).toBe(`3speak-supports|hide|alice|${TRX}|<ms>`);
  });

  test('the author hides the tip and unhides it again', async () => {
    const res = await hide(signed(alice)).expect(200);
    expect(res.body).toEqual({ success: true, trx_id: TRX, hidden: true });
    expect(await tipRow()).toMatchObject({ hidden: true, hiddenAt: NOW });
    await hide(signed(alice, { action: 'unhide' })).expect(200);
    const row = await tipRow();
    expect(row).not.toHaveProperty('hidden');
    expect(row).not.toHaveProperty('hiddenAt');
  });

  test('@threespeak may sign for a creator who granted it posting authority', async () => {
    await hide(signed(threespeak)).expect(200);
    expect((await tipRow()).hidden).toBe(true);
  });

  test.each([
    ['a stranger', () => signed(mallory)],
    ['a delegate the creator granted but we do not sign with', () => signed(peakd)],
    ['@threespeak for a creator who never granted it', () => signed(threespeak, { author: 'bob' })],
    ['a signature over another tip', () => ({ ...signed(alice, { trxId: trx(8) }), trx_id: TRX })],
    ['an unhide signature sent as a hide', () => ({ ...signed(alice, { action: 'unhide' }), hidden: true })],
    ['a signature over another timestamp', () => ({ ...signed(alice), timestamp: Date.now() - 1000 })],
    ['a signature that is not one', () => ({ ...signed(alice), signature: 'nonsense' })],
  ])('%s is a 401 and nothing changes', async (_label, body) => {
    await hide(body()).expect(401);
    expect((await tipRow()).hidden).toBeUndefined();
  });

  test('a signature older than five minutes is a 401', async () => {
    const res = await hide(signed(alice, { ts: Date.now() - 6 * 60 * 1000 })).expect(401);
    expect(res.body.error).toBe('timestamp out of tolerance');
  });

  test('a signature from the future beyond the window is a 401 too', async () => {
    await hide(signed(alice, { ts: Date.now() + 6 * 60 * 1000 })).expect(401);
  });

  test("a creator cannot hide a tip someone else received: 404, and it stays visible", async () => {
    await hide(signed(bob, { author: 'bob' })).expect(404);
    expect((await tipRow()).hidden).toBeUndefined();
  });

  test('an unknown tip is a 404', async () => {
    await hide(signed(alice, { trxId: trx(77) })).expect(404);
  });

  test('a creator with no Hive account is a 404', async () => {
    await hide(signed(mallory, { author: 'nobody' })).expect(404);
  });

  test('at most 120 changes an hour per creator', async () => {
    // Its own creator: the counter is per process, and other tests here hide alice's tips.
    const t = trx(11);
    await db().collection('supports').insertOne({ trx_id: t, tipper: 'bob', author: 'erin', hbd_value: 1 });
    for (let i = 0; i < 120; i += 1) {
      await hide(signed(erin, { author: 'erin', trxId: t, action: i % 2 ? 'unhide' : 'hide', ts: Date.now() - i })).expect(200);
    }
    const res = await hide(signed(erin, { author: 'erin', trxId: t })).expect(429);
    expect(res.body.error).toMatch(/too many/);
  });

  test('a write that fails is a 502', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(require('mongodb').Collection.prototype, 'updateOne').mockRejectedValue(new Error('db down'));
    // A different creator, so the hourly counter of the test above does not apply.
    await db().collection('supports').insertOne({ trx_id: trx(10), tipper: 'alice', author: 'bob', hbd_value: 1 });
    await hide(signed(bob, { author: 'bob', trxId: trx(10) })).expect(502);
  });
});
