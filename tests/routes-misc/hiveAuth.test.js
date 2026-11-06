/**
 * The checker's signature and key gates: utils/hiveAuth.js (Hive posting-key
 * signatures, posting-authority delegates, delegate vouches and the
 * requireHiveSignature middleware), utils/middleware.js (API and Pulse keys) and
 * utils/hash.js (the public verification hash).
 *
 * Signatures are real secp256k1 signatures; only the chain is fake.
 */
const express = require('express');
const crypto = require('crypto');
const request = require('supertest');
const { hiveAccount, fakeHiveChain } = require('../helpers/hive');
const { pinClock, NOW } = require('./_fixtures');
const hiveAuth = require('../../utils/hiveAuth');
const { validateApiKey, validatePulseKey } = require('../../utils/middleware');
const { hashForHiveUsername } = require('../../utils/hash');

const {
  buildMessage, verifyHiveSignedMessage, verifyHiveAuthority,
  getPostingAuthoritySigners, verifyDelegateVouch, requireHiveSignature,
} = hiveAuth;

// Account names are unique per test where the 60s key cache could carry a
// result from one test into the next (the cache is module state).
const threespeak = hiveAccount('threespeak');
const peakd = hiveAccount('peakd.app');
const mallory = hiveAccount('mallory');

afterEach(() => jest.useRealTimers());

describe('verifyHiveSignedMessage: the account own posting key', () => {
  test('accepts a signature made with the account posting key', async () => {
    const alice = hiveAccount('alice-own');
    fakeHiveChain([alice]);
    await expect(verifyHiveSignedMessage({ message: 'hello', signature: alice.sign('hello'), username: 'alice-own' }))
      .resolves.toBe(true);
  });

  test('refuses a signature by another key, and one over a different message', async () => {
    const alice = hiveAccount('alice-other');
    fakeHiveChain([alice, mallory]);
    await expect(verifyHiveSignedMessage({ message: 'hello', signature: mallory.sign('hello'), username: 'alice-other' }))
      .resolves.toBe(false);
    await expect(verifyHiveSignedMessage({ message: 'hello!', signature: alice.sign('hello'), username: 'alice-other' }))
      .resolves.toBe(false);
  });

  test('an unknown account is an error with a code the routes turn into 404', async () => {
    fakeHiveChain([]);
    await expect(verifyHiveSignedMessage({ message: 'm', signature: mallory.sign('m'), username: 'ghost-acct' }))
      .rejects.toMatchObject({ code: 'HIVE_ACCOUNT_NOT_FOUND' });
  });

  test('a malformed signature throws instead of verifying', async () => {
    fakeHiveChain([]);
    await expect(verifyHiveSignedMessage({ message: 'm', signature: 'zz-not-hex', username: 'whoever' })).rejects.toThrow();
  });

  test('posting keys are cached for 60 seconds, then read again', async () => {
    pinClock(NOW);
    const cached = hiveAccount('cache-probe');
    const chain = fakeHiveChain([cached]);
    const ask = () => verifyHiveSignedMessage({ message: 'x', signature: cached.sign('x'), username: 'cache-probe' });

    await ask();
    await ask();
    expect(chain.calls).toHaveLength(1);

    jest.setSystemTime(NOW.getTime() + 61 * 1000);
    await ask();
    expect(chain.calls).toHaveLength(2);
  });
});

describe('getPostingAuthoritySigners: who may sign for an account', () => {
  test('the account itself first, then every delegate that meets the threshold alone', async () => {
    const carol = hiveAccount('carol-signers', { postingDelegates: ['threespeak', 'peakd.app'] });
    fakeHiveChain([carol, threespeak, peakd]);
    const signers = await getPostingAuthoritySigners('carol-signers');
    expect(signers.map((s) => s.account)).toEqual(['carol-signers', 'threespeak', 'peakd.app']);
    expect(signers[0].keys).toEqual([carol.publicKey]);
    expect(signers[1].keys).toEqual([threespeak.publicKey]);
  });

  test('a partial-weight grant, a self-grant and an unreadable delegate are left out', async () => {
    const dave = hiveAccount('dave-signers');
    const daveOnChain = dave.chainAccount({
      posting: {
        weight_threshold: 2,
        account_auths: [['threespeak', 1], ['dave-signers', 2], ['vanished', 2]],
        key_auths: [[dave.publicKey, 2]],
      },
    });
    fakeHiveChain([daveOnChain, threespeak]);
    const signers = await getPostingAuthoritySigners('dave-signers');
    expect(signers.map((s) => s.account)).toEqual(['dave-signers']);
  });

  test('an unknown account is HIVE_ACCOUNT_NOT_FOUND', async () => {
    fakeHiveChain([]);
    await expect(getPostingAuthoritySigners('nobody-here')).rejects.toMatchObject({ code: 'HIVE_ACCOUNT_NOT_FOUND' });
  });

  test('an account without a posting authority object has only itself and no keys', async () => {
    fakeHiveChain([{ name: 'bare-acct' }]);
    expect(await getPostingAuthoritySigners('bare-acct')).toEqual([{ account: 'bare-acct', keys: [] }]);
  });
});

describe('verifyHiveAuthority: own key or an allowed delegate', () => {
  const message = 'set-pref|erin-auth|1';

  test('the owner signing records the owner as signer', async () => {
    const erin = hiveAccount('erin-auth', { postingDelegates: ['threespeak'] });
    fakeHiveChain([erin, threespeak]);
    await expect(verifyHiveAuthority({ message, signature: erin.sign(message), username: 'erin-auth', allowedDelegates: ['threespeak'] }))
      .resolves.toEqual({ ok: true, signer: 'erin-auth' });
  });

  test('@threespeak signing under a granted authority is accepted and named', async () => {
    const erin = hiveAccount('erin-deleg', { postingDelegates: ['threespeak'] });
    fakeHiveChain([erin, threespeak]);
    await expect(verifyHiveAuthority({ message, signature: threespeak.sign(message), username: 'erin-deleg', allowedDelegates: ['threespeak'] }))
      .resolves.toEqual({ ok: true, signer: 'threespeak' });
  });

  test('a third-party delegate the user did grant is refused when the allow-list excludes it', async () => {
    const erin = hiveAccount('erin-third', { postingDelegates: ['threespeak', 'peakd.app'] });
    fakeHiveChain([erin, threespeak, peakd]);
    await expect(verifyHiveAuthority({ message, signature: peakd.sign(message), username: 'erin-third', allowedDelegates: ['threespeak'] }))
      .resolves.toEqual({ ok: false, signer: null });
  });

  test('with no allow-list every Hive-native delegate counts', async () => {
    const erin = hiveAccount('erin-native', { postingDelegates: ['peakd.app'] });
    fakeHiveChain([erin, peakd]);
    await expect(verifyHiveAuthority({ message, signature: peakd.sign(message), username: 'erin-native' }))
      .resolves.toEqual({ ok: true, signer: 'peakd.app' });
  });

  test('@threespeak cannot sign for an account that never granted it authority', async () => {
    const frank = hiveAccount('frank-nogrant');
    fakeHiveChain([frank, threespeak]);
    await expect(verifyHiveAuthority({ message, signature: threespeak.sign(message), username: 'frank-nogrant', allowedDelegates: ['threespeak'] }))
      .resolves.toEqual({ ok: false, signer: null });
  });

  test('a stranger key is refused', async () => {
    const gina = hiveAccount('gina-auth');
    fakeHiveChain([gina, mallory]);
    await expect(verifyHiveAuthority({ message, signature: mallory.sign(message), username: 'gina-auth', allowedDelegates: ['threespeak'] }))
      .resolves.toEqual({ ok: false, signer: null });
  });
});

describe('verifyDelegateVouch: our own account attesting a session', () => {
  test('a message signed by a listed delegate vouches, naming it', async () => {
    fakeHiveChain([hiveAccount('vouch-a')]);
    const a = hiveAccount('vouch-a');
    await expect(verifyDelegateVouch({ message: 'vouch|x', signature: a.sign('vouch|x'), delegates: ['vouch-a'] }))
      .resolves.toEqual({ ok: true, signer: 'vouch-a' });
  });

  test('a key outside the delegate list does not vouch, and an unreadable delegate is skipped', async () => {
    const real = hiveAccount('vouch-b');
    fakeHiveChain([real]);
    await expect(verifyDelegateVouch({ message: 'm', signature: mallory.sign('m'), delegates: ['vouch-missing', 'vouch-b'] }))
      .resolves.toEqual({ ok: false, signer: null });
    await expect(verifyDelegateVouch({ message: 'm', signature: real.sign('m'), delegates: ['vouch-missing2', 'vouch-b'] }))
      .resolves.toEqual({ ok: true, signer: 'vouch-b' });
  });

  test('no delegates configured means nothing vouches', async () => {
    await expect(verifyDelegateVouch({ message: 'm', signature: mallory.sign('m'), delegates: undefined }))
      .resolves.toEqual({ ok: false, signer: null });
  });
});

describe('buildMessage: the canonical verifier message', () => {
  test('binds action, lower-cased account, platform, channel and timestamp', () => {
    expect(buildMessage({ action: 'check', hive_username: 'Alice', platform: 'youtube', platform_username: 'AliceTube', timestamp: 123 }))
      .toBe('3speak-social-verifier|check|alice|youtube|AliceTube|123');
  });

  test('missing parts become empty fields, never "undefined"', () => {
    expect(buildMessage({ action: 'unlink', timestamp: 1 })).toBe('3speak-social-verifier|unlink||||1');
  });
});

describe('requireHiveSignature middleware', () => {
  const T = NOW.getTime();
  const owner = hiveAccount('henry-sig', { postingDelegates: ['threespeak', 'peakd.app'] });
  const appFor = (mw) => {
    const app = express();
    app.get('/gate', mw, (_req, res) => res.json({ passed: true }));
    return app;
  };
  const app = appFor(requireHiveSignature('check'));
  const base = { hive_username: 'henry-sig', platform: 'youtube', platform_username: 'HenryTube' };
  const signedQuery = (signer, overrides = {}, signFor = {}) => {
    const q = { ...base, timestamp: T, ...overrides };
    const msg = buildMessage({ action: 'check', ...q, ...signFor });
    return { ...q, signature: signer.sign(msg) };
  };

  beforeEach(() => {
    pinClock(NOW);
    fakeHiveChain([owner, threespeak, peakd, mallory, hiveAccount('ivy-sig')]);
  });

  test.each([
    ['hive_username', { platform: 'youtube', platform_username: 'x' }],
    ['platform', { hive_username: 'henry-sig', platform_username: 'x' }],
    ['platform_username', { hive_username: 'henry-sig', platform: 'youtube' }],
  ])('400 without %s', async (_missing, query) => {
    await request(app).get('/gate').query(query).expect(400);
  });

  test('401 without a signature, telling the client exactly what to sign', async () => {
    const res = await request(app).get('/gate').query(base).expect(401);
    expect(res.body.expected_message).toBe('3speak-social-verifier|check|henry-sig|youtube|HenryTube|<ms>');
  });

  test('401 for a timestamp that is not a number', async () => {
    const res = await request(app).get('/gate').query({ ...base, signature: 'abc', timestamp: 'soon' }).expect(401);
    expect(res.body.error).toBe('Invalid timestamp');
  });

  test.each([
    ['expired (6 minutes old)', -6 * 60 * 1000],
    ['from the future (6 minutes ahead)', 6 * 60 * 1000],
  ])('401 for a signature %s', async (_label, offset) => {
    const res = await request(app).get('/gate').query(signedQuery(owner, { timestamp: T + offset })).expect(401);
    expect(res.body.error).toBe('Timestamp out of tolerance window');
  });

  test('passes with the owner signature, also when the name arrives upper-cased', async () => {
    await request(app).get('/gate').query(signedQuery(owner)).expect(200, { passed: true });
    await request(app).get('/gate').query(signedQuery(owner, { hive_username: 'HENRY-SIG' })).expect(200);
  });

  test('passes with the signature and timestamp in headers instead of the query', async () => {
    const { signature, timestamp, ...q } = signedQuery(owner);
    await request(app).get('/gate').query(q)
      .set('x-hive-signature', signature).set('x-hive-timestamp', String(timestamp))
      .expect(200);
  });

  test('passes with @threespeak signing under the granted posting authority', async () => {
    await request(app).get('/gate').query(signedQuery(threespeak)).expect(200);
  });

  test('401 for a third-party delegate (peakd.app) even though the user granted it', async () => {
    await request(app).get('/gate').query(signedQuery(peakd)).expect(401, { error: 'Invalid signature' });
  });

  test('401 for a stranger signature', async () => {
    await request(app).get('/gate').query(signedQuery(mallory)).expect(401);
  });

  test('a signature made by user A is refused for user B', async () => {
    const ivy = hiveAccount('ivy-sig');
    const forA = signedQuery(ivy, { hive_username: 'ivy-sig' });
    await request(app).get('/gate').query({ ...forA, hive_username: 'henry-sig' }).expect(401);
  });

  test.each([
    ['another channel', { platform_username: 'SomeoneElse' }],
    ['another platform', { platform: 'rumble' }],
    ['another timestamp', { timestamp: T + 1000 }],
  ])('a captured signature cannot be replayed for %s', async (_label, change) => {
    const captured = signedQuery(owner);
    await request(app).get('/gate').query({ ...captured, ...change }).expect(401);
  });

  test('a signature for "check" cannot be replayed against "unlink"', async () => {
    const unlinkApp = appFor(requireHiveSignature('unlink'));
    await request(unlinkApp).get('/gate').query(signedQuery(owner)).expect(401);
  });

  test('404 when the Hive account does not exist', async () => {
    await request(app).get('/gate').query(signedQuery(mallory, { hive_username: 'no-such-acct' })).expect(404);
  });

  test('401 (not 500) for a signature that is not a signature', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await request(app).get('/gate').query({ ...base, timestamp: T, signature: 'deadbeef' }).expect(401, { error: 'Invalid signature' });
  });

  test('HIVE_AUTH_REQUIRED=false lets every request through (development switch)', async () => {
    process.env.HIVE_AUTH_REQUIRED = 'false';
    let open;
    jest.isolateModules(() => { open = require('../../utils/hiveAuth').requireHiveSignature('check'); });
    delete process.env.HIVE_AUTH_REQUIRED;
    await request(appFor(open)).get('/gate').expect(200);
  });
});

describe('validateApiKey', () => {
  const app = express();
  app.get('/p', validateApiKey, (_req, res) => res.json({ ok: true }));

  test.each([
    ['no Authorization header', undefined, 'Missing Authorization header'],
    ['a Basic scheme', 'Basic test-api-secret', 'Invalid authorization format. Use: Bearer YOUR_API_KEY'],
    ['an extra part', 'Bearer test-api-secret extra', 'Invalid authorization format. Use: Bearer YOUR_API_KEY'],
    ['the wrong key', 'Bearer not-the-key', 'Invalid API key'],
    ['the Pulse key (separate secret)', 'Bearer test-pulse-key', 'Invalid API key'],
  ])('401 with %s', async (_label, header, message) => {
    const req = request(app).get('/p');
    if (header) req.set('Authorization', header);
    const res = await req.expect(401);
    expect(res.body).toEqual({ success: false, error: 'Unauthorized', message });
  });

  test('passes with Bearer <API_SECRET_KEY>', async () => {
    await request(app).get('/p').set('Authorization', 'Bearer test-api-secret').expect(200, { ok: true });
  });
});

describe('validatePulseKey', () => {
  const appWith = (mw) => {
    const app = express();
    app.get('/hot', mw, (_req, res) => res.json({ ok: true }));
    return app;
  };
  const app = appWith(validatePulseKey);

  test.each([
    ['no header', undefined],
    ['the API key (must not double as the Pulse key)', 'Bearer test-api-secret'],
    ['a key of the same length but different', `Bearer ${'x'.repeat('test-pulse-key'.length)}`],
    ['the right key without the Bearer scheme', 'test-pulse-key'],
  ])('401 with %s', async (_label, header) => {
    const req = request(app).get('/hot');
    if (header) req.set('Authorization', header);
    await req.expect(401);
  });

  test('passes with Bearer <PULSE_API_KEY>', async () => {
    await request(app).get('/hot').set('Authorization', 'Bearer test-pulse-key').expect(200);
  });

  test('an unset PULSE_API_KEY refuses everything, including an empty bearer', async () => {
    const saved = process.env.PULSE_API_KEY;
    delete process.env.PULSE_API_KEY;
    let mw;
    jest.isolateModules(() => { mw = require('../../utils/middleware').validatePulseKey; });
    process.env.PULSE_API_KEY = saved;
    await request(appWith(mw)).get('/hot').set('Authorization', 'Bearer ').expect(401);
    await request(appWith(mw)).get('/hot').expect(401);
  });
});

describe('hashForHiveUsername: the public verification hash', () => {
  test('is the md5 of the trimmed, lower-cased name', () => {
    const expected = crypto.createHash('md5').update('alice').digest('hex');
    expect(hashForHiveUsername('alice')).toBe(expected);
    expect(hashForHiveUsername('  ALICE ')).toBe(expected);
  });

  test.each([[''], ['   '], [null], [undefined]])('refuses an empty name (%p)', (name) => {
    expect(() => hashForHiveUsername(name)).toThrow('hive_username is required');
  });
});
