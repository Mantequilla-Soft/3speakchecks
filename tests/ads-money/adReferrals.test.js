/**
 * Who referred whom, asked of Butter Auth (services/adReferrals.js), and what a
 * settlement does with the answer.
 *
 * Butter Auth is a local express stub on a loopback port. The lookup FAILS OPEN:
 * whatever goes wrong, an account is simply treated as unreferred and the platform
 * keeps the referral share. Only link and invite referrals are ever paid.
 */
jest.mock('../../utils/hive', () => ({ ...jest.requireActual('../../utils/hive'), hiveRpcBatch: jest.fn() }));

const express = require('express');
const testDb = require('../helpers/db');
const F = require('./_fixtures');

let stub;
let seen = [];
let answer = () => ({ status: 200, body: { results: [] } });
let R;
let P;

// Started, and the env pointed at it, BEFORE anything reads utils/config.
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.post('/api/referral/lookup', (req, res) => {
    seen.push(req.body);
    const { status, body } = answer(req.body);
    res.status(status).send(body);
  });
  stub = app.listen(0, '127.0.0.1');
  await new Promise((r) => stub.once('listening', r));
  process.env.BUTRAUTH_URL = `http://127.0.0.1:${stub.address().port}`;
  process.env.BUTRAUTH_CLIENT_ID = 'test-client';
  process.env.BUTRAUTH_CLIENT_SECRET = 'test-client-secret';
  R = require('../../services/adReferrals');
  P = require('../../services/adPayouts');
});
afterAll(() => new Promise((r) => stub.close(r)));

const db = testDb.use();

beforeEach(() => {
  seen = [];
  answer = () => ({ status: 200, body: { results: [] } });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  const { hiveRpcBatch } = require('../../utils/hive');
  hiveRpcBatch.mockReset();
  hiveRpcBatch.mockImplementation(F.contentChain());
});

const results = (...rows) => () => ({ status: 200, body: { results: rows } });

describe('asking Butter Auth', () => {
  test('names are trimmed, lowercased, stripped of @ and asked once, with the client credentials', async () => {
    await R.referralsFor(['@Alice', ' alice ', 'BOB', '', null, 42]);
    expect(seen).toEqual([{ client_id: 'test-client', client_secret: 'test-client-secret', usernames: ['alice', 'bob'] }]);
  });

  test('at most 100 names per request', async () => {
    await R.referralsFor(Array.from({ length: 150 }, (_, i) => `user${i}`));
    expect(seen.map((b) => b.usernames.length)).toEqual([100, 50]);
  });

  test.each([[[]], [null], ['alice']])('nothing to ask about (%p) asks nothing', async (input) => {
    expect((await R.referralsFor(input)).size).toBe(0);
    expect(seen).toEqual([]);
  });

  test('without client credentials nothing is asked and nobody is referred', async () => {
    let isolated;
    const saved = process.env.BUTRAUTH_CLIENT_SECRET;
    process.env.BUTRAUTH_CLIENT_SECRET = '';
    jest.isolateModules(() => { isolated = require('../../services/adReferrals'); });
    process.env.BUTRAUTH_CLIENT_SECRET = saved;
    expect((await isolated.referralsFor(['alice'])).size).toBe(0);
    expect(seen).toEqual([]);
  });
});

describe('reading the answer', () => {
  test('keeps the referrer, the source and the date of each referral', async () => {
    answer = results(
      { username: 'Adv1', referredBy: ' ALICE ', referredAt: '2026-10-20T00:00:00Z', source: 'link' },
      { username: 'adv2', referredBy: 'bob', referredAt: 'not a date', source: 'invite' },
      { username: 'adv3', referredBy: 'carl' },
    );
    const got = await R.referralsFor(['adv1', 'adv2', 'adv3']);
    expect(Object.fromEntries(got)).toEqual({
      adv1: { referrer: 'alice', source: 'link', referredAt: new Date('2026-10-20T00:00:00Z') },
      adv2: { referrer: 'bob', source: 'invite', referredAt: null },
      adv3: { referrer: 'carl', source: null, referredAt: null },
    });
  });

  test('a self-referral, an empty referrer and a row with no name are dropped', async () => {
    answer = results(
      { username: 'adv1', referredBy: 'ADV1', source: 'link' },
      { username: 'adv2', referredBy: '', source: 'link' },
      { referredBy: 'alice', source: 'link' },
      null,
    );
    expect((await R.referralsFor(['adv1', 'adv2'])).size).toBe(0);
  });

  test('only link and invite referrals are payable advertiser referrals', async () => {
    answer = results(
      { username: 'adv1', referredBy: 'alice', source: 'link' },
      { username: 'adv2', referredBy: 'bob', source: 'invite' },
      { username: 'adv3', referredBy: 'chatgpt', source: 'typed' },
      { username: 'adv4', referredBy: 'dan' },
    );
    expect([...(await R.referrersFor(['adv1', 'adv2', 'adv3', 'adv4'])).entries()]).toEqual([['adv1', 'alice'], ['adv2', 'bob']]);
    expect([...R.PAID_SOURCES].sort()).toEqual(['invite', 'link']);
  });
});

describe('failing open', () => {
  test.each([
    ['an error status', () => ({ status: 500, body: { results: [{ username: 'adv1', referredBy: 'alice', source: 'link' }] } })],
    ['a body without results', () => ({ status: 200, body: { ok: true } })],
    ['a body that is not JSON', () => ({ status: 200, body: '<html>' })],
  ])('%s treats everyone as unreferred, without throwing', async (_label, a) => {
    answer = a;
    await expect(R.referralsFor(['adv1'])).resolves.toEqual(new Map());
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('treated as unreferred'));
  });

  test('one failed batch does not lose the answers of the next', async () => {
    let n = 0;
    answer = (body) => {
      n += 1;
      if (n === 1) return { status: 503, body: {} };
      return { status: 200, body: { results: body.usernames.map((u) => ({ username: u, referredBy: 'alice', source: 'link' })) } };
    };
    const got = await R.referralsFor(Array.from({ length: 101 }, (_, i) => `user${i}`));
    expect([...got.keys()]).toEqual(['user100']);
  });

  test('an unreachable Butter Auth is the same as nobody referred', async () => {
    let isolated;
    const saved = process.env.BUTRAUTH_URL;
    process.env.BUTRAUTH_URL = 'http://127.0.0.1:9';
    jest.isolateModules(() => { isolated = require('../../services/adReferrals'); });
    process.env.BUTRAUTH_URL = saved;
    await expect(isolated.referralsFor(['adv1'])).resolves.toEqual(new Map());
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('lookup error'));
  });
});

describe('inside a settlement, through the real lookup', () => {
  const period = () => P.periodContaining(F.PERIOD_AT.getTime());
  const chainKnows = (...names) => ({
    client: { database: { getAccounts: async (asked) => asked.filter((n) => names.includes(n)).map((name) => ({ name })) } },
  });

  test('a link-referred advertiser pays their referrer 2 of a 100 HBD shown campaign', async () => {
    answer = results({ username: 'adv', referredBy: 'refbob', source: 'link', referredAt: '2026-09-01T00:00:00Z' });
    const c = await F.seedCampaign(db(), period(), { hiveAccount: 'adv' });
    await F.seedImpressions(db(), c, 1, { owner: 'creatorx', period: period() });
    await P.settlePeriod(db(), period(), chainKnows('refbob'));
    expect((await F.payoutsOf(db(), period().key)).refbob).toMatchObject({ hbd: 2, kind: 'referral' });
  });

  test('with Butter Auth failing the period still settles, and the platform keeps the share', async () => {
    answer = () => ({ status: 500, body: {} });
    const c = await F.seedCampaign(db(), period(), { hiveAccount: 'adv' });
    await F.seedImpressions(db(), c, 1, { owner: 'creatorx', period: period() });
    await P.settlePeriod(db(), period(), chainKnows('refbob'));
    const paid = await F.payoutsOf(db(), period().key);
    expect(paid.creatorx.hbd).toBe(50);
    expect(paid.refbob).toBeUndefined();
    expect((await F.cols(db()).periods.findOne({ _id: period().key })).status).toBe('settled');
  });
});
