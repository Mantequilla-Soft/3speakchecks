/**
 * Social channel verification (routes/verify.js): the public hash and link reads,
 * and the signed check/unlink writes. The platform scraper (services/verifier) is
 * mocked; the Hive signatures are real.
 */
// Room for every request this file makes; the limiter has its own test below.
process.env.RATE_LIMIT_MAX = '1000';

jest.mock('../../services/verifier', () => ({ verifyAndStore: jest.fn(), unlinkIfRevoked: jest.fn() }));

const crypto = require('crypto');
const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const { hiveAccount, fakeHiveChain } = require('../helpers/hive');
const { pinClock, NOW } = require('./_fixtures');
const { buildMessage } = require('../../utils/hiveAuth');
const { listPlatforms } = require('../../services/platforms');
const verifier = require('../../services/verifier');

const app = buildApp(['/verify', require('../../routes/verify')]);
testDb.use(); // connects, and empties the links collection before each test
const links = () => require('../../utils/db').getLinksCollection();

const T = NOW.getTime();
const alice = hiveAccount('alice', { postingDelegates: ['threespeak', 'peakd.app'] });
const bob = hiveAccount('bob');
const threespeak = hiveAccount('threespeak');
const peakd = hiveAccount('peakd.app');

const triplet = { hive_username: 'alice', platform: 'youtube', platform_username: 'AliceTube' };
const signed = (action, signer = alice, overrides = {}) => {
  const q = { ...triplet, timestamp: T, ...overrides };
  return { ...q, signature: signer.sign(buildMessage({ action, ...q })) };
};
const record = (extra = {}) => ({
  _id: 'internal', hive_username: 'alice', platform: 'youtube', platform_username: 'AliceTube',
  hash: 'h', verified: true, verified_at: NOW, last_checked: NOW, first_seen: NOW, last_error: null, secret_field: 'x', ...extra,
});
const codeError = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

beforeEach(() => {
  pinClock(NOW);
  fakeHiveChain([alice, bob, threespeak, peakd]);
  verifier.verifyAndStore.mockReset();
  verifier.unlinkIfRevoked.mockReset();
});
afterEach(() => jest.useRealTimers());

describe('GET /verify/hash/:hive_username (public)', () => {
  test('is the md5 of the lower-cased name', async () => {
    const res = await request(app).get('/verify/hash/Alice').expect(200);
    expect(res.body).toEqual({ hive_username: 'alice', hash: crypto.createHash('md5').update('alice').digest('hex') });
  });

  test('400 for a blank name', async () => {
    await request(app).get('/verify/hash/%20').expect(400, { error: 'hive_username is required' });
  });
});

describe('GET /verify/platforms', () => {
  test('lists the platforms that may be linked right now', async () => {
    const res = await request(app).get('/verify/platforms').expect(200);
    expect(res.body.platforms).toEqual(listPlatforms());
  });
});

describe('GET /verify/links/:hive_username (public)', () => {
  beforeEach(async () => {
    await links().insertMany([
      { hive_username: 'alice', platform: 'youtube', platform_username: 'A1', verified: true, last_checked: new Date(T - 1000), internal: 1 },
      { hive_username: 'alice', platform: 'rumble', platform_username: 'A2', verified: false, last_checked: new Date(T) },
      { hive_username: 'bob', platform: 'youtube', platform_username: 'B1', verified: true, last_checked: new Date(T) },
    ]);
  });

  test('shows only verified links of that account, shaped without internal fields', async () => {
    const res = await request(app).get('/verify/links/ALICE').expect(200);
    expect(res.body.hive_username).toBe('alice');
    expect(res.body.links).toEqual([{
      hive_username: 'alice', platform: 'youtube', platform_username: 'A1', verified: true,
      verified_at: null, last_checked: new Date(T - 1000).toISOString(), first_seen: null, last_error: null,
    }]);
  });

  test('include_pending=true adds pending links, verified first', async () => {
    const res = await request(app).get('/verify/links/alice?include_pending=true').expect(200);
    expect(res.body.links.map((l) => [l.platform_username, l.verified])).toEqual([['A1', true], ['A2', false]]);
  });

  test('400 for a blank name', async () => {
    await request(app).get('/verify/links/%20').expect(400);
  });
});

describe('GET /verify/check: signed link check', () => {
  describe('who may ask', () => {
    test('401 without a signature, and the platform is never contacted', async () => {
      const res = await request(app).get('/verify/check').query(triplet).expect(401);
      expect(res.body.expected_message).toBe('3speak-social-verifier|check|alice|youtube|AliceTube|<ms>');
      expect(verifier.verifyAndStore).not.toHaveBeenCalled();
    });

    test.each([
      ['another user (bob)', () => signed('check', bob)],
      ['a third-party delegate (peakd.app)', () => signed('check', peakd)],
      ['a signature made for unlink', () => signed('unlink')],
      ['an expired signature', () => signed('check', alice, { timestamp: T - 10 * 60 * 1000 })],
      ['a signature for another channel', () => ({ ...signed('check'), platform_username: 'NotMine' })],
    ])('401 for %s', async (_label, query) => {
      await request(app).get('/verify/check').query(query()).expect(401);
      expect(verifier.verifyAndStore).not.toHaveBeenCalled();
    });

    test('bob cannot link a channel to alice with his own valid signature', async () => {
      const bobs = signed('check', bob, { hive_username: 'bob' });
      await request(app).get('/verify/check').query({ ...bobs, hive_username: 'alice' }).expect(401);
      expect(verifier.verifyAndStore).not.toHaveBeenCalled();
    });

    test('@threespeak may sign for an account that granted it posting authority', async () => {
      verifier.verifyAndStore.mockResolvedValue(record());
      await request(app).get('/verify/check').query(signed('check', threespeak)).expect(200);
    });
  });

  test('the stored record comes back in the public shape', async () => {
    verifier.verifyAndStore.mockResolvedValue(record());
    const res = await request(app).get('/verify/check').query(signed('check')).expect(200);
    expect(verifier.verifyAndStore).toHaveBeenCalledWith(triplet);
    expect(res.body).toEqual({
      hive_username: 'alice', platform: 'youtube', platform_username: 'AliceTube', hash: 'h', verified: true,
      verified_at: NOW.toISOString(), last_checked: NOW.toISOString(), first_seen: NOW.toISOString(), last_error: null,
    });
  });

  test('an empty result is answered as null', async () => {
    verifier.verifyAndStore.mockResolvedValue(null);
    const res = await request(app).get('/verify/check').query(signed('check')).expect(200);
    expect(res.body).toBeNull();
  });

  test.each([
    ['UNSUPPORTED_PLATFORM', 400, (b) => expect(b.supported).toEqual(listPlatforms())],
    ['CHANNEL_NOT_FOUND', 404, () => {}],
    ['CHANNEL_ALREADY_LINKED', 409, (b) => expect(b.claimed_by).toBe('carol')],
    ['TOO_MANY_LINKS', 409, () => {}],
    ['SCRAPER_EXPLODED', 502, (b) => expect(b.error).toBe('Platform lookup failed.')],
  ])('a %s failure is answered %i', async (code, status, more) => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    verifier.verifyAndStore.mockRejectedValue(codeError(code, `failed: ${code}`, { claimedBy: 'carol' }));
    const res = await request(app).get('/verify/check').query(signed('check')).expect(status);
    more(res.body);
  });
});

describe('GET /verify/unlink: signed unlink', () => {
  test('401 for a check signature replayed against unlink', async () => {
    await request(app).get('/verify/unlink').query(signed('check')).expect(401);
    expect(verifier.unlinkIfRevoked).not.toHaveBeenCalled();
  });

  test('401 for another user signature', async () => {
    await request(app).get('/verify/unlink').query(signed('unlink', bob)).expect(401);
    expect(verifier.unlinkIfRevoked).not.toHaveBeenCalled();
  });

  test.each([
    ['deleted', 200, { deleted: true }],
    ['still_present', 409, { deleted: false, still_present: true }],
    ['not_found', 404, { deleted: false, error: 'No stored link for that triplet' }],
    ['lookup_failed', 502, { deleted: false, error: 'Platform lookup failed.' }],
    ['something_new', 500, { deleted: false, error: 'Unknown status' }],
  ])('status %s is answered %i', async (status, code, body) => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    verifier.unlinkIfRevoked.mockResolvedValue({ status, record: record(), error: 'x' });
    const res = await request(app).get('/verify/unlink').query(signed('unlink')).expect(code);
    expect(res.body).toMatchObject(body);
    expect(verifier.unlinkIfRevoked).toHaveBeenCalledWith(triplet);
  });

  test('a deleted link returns the record in the public shape', async () => {
    verifier.unlinkIfRevoked.mockResolvedValue({ status: 'deleted', record: record() });
    const res = await request(app).get('/verify/unlink').query(signed('unlink')).expect(200);
    expect(res.body.record).not.toHaveProperty('_id');
    expect(res.body.record).not.toHaveProperty('secret_field');
  });

  test('an unsupported platform is 400 with the supported list, any other error 500', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    verifier.unlinkIfRevoked.mockRejectedValueOnce(codeError('UNSUPPORTED_PLATFORM', 'no'));
    const bad = await request(app).get('/verify/unlink').query(signed('unlink')).expect(400);
    expect(bad.body.supported).toEqual(listPlatforms());

    verifier.unlinkIfRevoked.mockRejectedValueOnce(new Error('db down'));
    await request(app).get('/verify/unlink').query(signed('unlink')).expect(500, { error: 'db down' });
    verifier.unlinkIfRevoked.mockRejectedValueOnce({});
    await request(app).get('/verify/unlink').query(signed('unlink')).expect(500, { error: 'Internal server error' });
  });
});

// SECURITY, denial of service (utils/hiveAuth.js:171-175): requireHiveSignature
// reads String(req.query.x) at the top of an async middleware, outside its
// try/catch. Express 4's query parser turns ?hive_username[toString]=x into an
// object whose toString is a string; String() throws, the rejection is unhandled
// and on Node 22 the checker process exits. Correct behaviour is a 400.
test.each([['/verify/check'], ['/verify/unlink']])('%s with a query value that cannot become a string is a 400, not a process crash', async (path) => {
  await request(app).get(`${path}?hive_username[toString]=x&platform=youtube&platform_username=y`).timeout(2000).expect(400);
});

describe('rate limit on the signed writes', () => {
  test('check and unlink share one per-client budget and answer 429 past it', async () => {
    process.env.RATE_LIMIT_MAX = '2';
    let limited;
    jest.isolateModules(() => { limited = buildApp(['/verify', require('../../routes/verify')]); });
    process.env.RATE_LIMIT_MAX = '1000';

    await request(limited).get('/verify/check').query(triplet).expect(401);
    await request(limited).get('/verify/unlink').query(triplet).expect(401);
    const res = await request(limited).get('/verify/check').query(triplet).expect(429);
    expect(res.body).toEqual({ error: 'Too many requests, slow down.' });
  });
});

describe('when the links store fails', () => {
  test('GET /verify/links answers 500 without details', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(require('mongodb').Collection.prototype, 'find').mockImplementation(() => { throw new Error('boom'); });
    await request(app).get('/verify/links/alice').expect(500, { error: 'Internal server error' });
  });
});
