/**
 * services/verifier.js: linking a social channel to a Hive account by the
 * md5-of-username hash the user pastes into the channel's public bio.
 *
 * End to end: the real platform adapters read a stubbed profile (global fetch, or
 * https.get for Rumble), and the result lands in the real social_links collection
 * with its real unique index. What is checked: the hash decides `verified`, rows
 * are keyed by the CANONICAL channel id whatever the user typed, a re-check never
 * duplicates a row, one channel has one verified owner, the per-user cap, the
 * platform switches, and unlink only deletes once the hash is really gone.
 */
jest.mock('../../utils/config', () => ({
  ...jest.requireActual('../../utils/config'),
  YOUTUBE_API_KEY: 'test-youtube-key',
  MAX_LINKS_PER_USER: 3,
}));

const https = require('https');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const testDb = require('../helpers/db');
const { hashForHiveUsername } = require('../../utils/hash');
const { SOCIAL_LINKS_COLLECTION } = require('../../utils/config');
const { fakeFetch } = require('./_fixtures');
const { verifyAndStore, unlinkIfRevoked } = require('../../services/verifier');

const db = testDb.use();
const links = () => db().collection(SOCIAL_LINKS_COLLECTION);
const realFetch = global.fetch;

const UC = 'UCaaaaaaaaaaaaaaaaaaaaaa'; // a YouTube channel id (24 chars)
// What each platform's profile says right now. Tests write into it.
let bio;

// One stub per platform, each putting `bio` where that platform keeps the bio.
function stubPlatforms() {
  global.fetch = fakeFetch([
    ['https://www.googleapis.com/youtube/v3/channels', () => ({ body: { items: [{ id: UC, snippet: { title: 'Alice TV', description: bio } }] } })],
    ['https://soundcloud.com', () => ({ body: '<script src="https://a-v2.sndcdn.com/assets/1-a.js"></script>' })],
    ['https://a-v2.sndcdn.com/', () => ({ body: `client_id:"${'c'.repeat(32)}"` })],
    ['https://api-v2.soundcloud.com/resolve', () => ({ body: { kind: 'user', permalink: 'alice-music', username: 'Alice', description: bio } })],
    ['https://www.tiktok.com/@', () => ({ body: `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify({ __DEFAULT_SCOPE__: { 'webapp.user-detail': { userInfo: { user: { uniqueId: 'AliceDances', signature: bio } } } } })}</script>` })],
    ['http://127.0.0.1:4031/profile/', () => ({ body: { username: 'alice.pics', biography: bio } })],
    ['https://api.bitchute.com/api/beta/channel', () => ({ body: { channel_id: 'Xy12AbC', channel_name: 'Alice', description: bio } })],
  ]);
  jest.spyOn(https, 'get').mockImplementation((url, opts, cb) => {
    const req = new EventEmitter();
    req.destroy = () => {};
    process.nextTick(() => {
      const res = new PassThrough();
      res.statusCode = 200;
      cb(res);
      res.end(`<title>Alice</title><div class="channel-about--description">${bio}</div>`);
    });
    return req;
  });
}

const SWITCHES = ['VERIFY_TIKTOK', 'VERIFY_INSTAGRAM', 'VERIFY_BITCHUTE', 'VERIFY_RUMBLE'];
beforeEach(() => {
  bio = '';
  stubPlatforms();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  global.fetch = realFetch;
  SWITCHES.forEach((k) => delete process.env[k]);
});

const codeOf = (p) => p.then(() => 'resolved', (e) => e.code || e.message);
const ALICE = hashForHiveUsername('alice');
const BOB = hashForHiveUsername('bob');

describe('verifyAndStore, per platform', () => {
  test.each([
    ['youtube', '@AliceTV', UC],
    ['soundcloud', 'https://soundcloud.com/Alice-Music', 'alice-music'],
    ['tiktok', '@AliceDances', 'alicedances'],
    ['instagram', 'https://instagram.com/alice.pics', 'alice.pics'],
    ['bitchute', 'alice', 'Xy12AbC'],
    ['rumble', 'https://rumble.com/c/Alice', 'c/alice'],
  ])('%s: the hash in the bio verifies the channel, stored under its canonical id', async (platform, typed, canonical) => {
    SWITCHES.forEach((k) => { process.env[k] = 'true'; });
    bio = `Find me on 3Speak! ${ALICE}`;
    const saved = await verifyAndStore({ hive_username: 'Alice', platform, platform_username: typed });
    expect(saved).toMatchObject({
      hive_username: 'alice', platform, platform_username: canonical, hash: ALICE, verified: true, last_error: null,
    });
    expect(saved.verified_at).toBeInstanceOf(Date);
    expect(saved.first_seen).toBeInstanceOf(Date);
    expect(await links().countDocuments()).toBe(1);
  });
});

describe('verifyAndStore', () => {
  test('without the hash the claim is stored unverified (and will expire)', async () => {
    bio = 'no hash here';
    const saved = await verifyAndStore({ hive_username: 'alice', platform: 'youtube', platform_username: '@alicetv' });
    expect(saved).toMatchObject({ verified: false, hash: ALICE });
    expect(saved.verified_at).toBeUndefined();
  });

  test('someone else\'s hash does not verify you', async () => {
    bio = `bob's channel ${BOB}`;
    const saved = await verifyAndStore({ hive_username: 'alice', platform: 'youtube', platform_username: '@alicetv' });
    expect(saved.verified).toBe(false);
  });

  test('checking twice keeps one row, its first_seen, and refreshes the rest', async () => {
    bio = ALICE;
    const first = await verifyAndStore({ hive_username: 'alice', platform: 'youtube', platform_username: '@alicetv' });
    // Typed differently the second time: same canonical channel, same row.
    const second = await verifyAndStore({ hive_username: 'ALICE', platform: 'YouTube', platform_username: UC });
    expect(await links().countDocuments()).toBe(1);
    expect(second._id).toEqual(first._id);
    expect(second.first_seen).toEqual(first.first_seen);
    expect(second.last_checked.getTime()).toBeGreaterThanOrEqual(first.last_checked.getTime());
  });

  test('a verified link whose hash was removed reads as unverified on the next check', async () => {
    bio = ALICE;
    await verifyAndStore({ hive_username: 'alice', platform: 'youtube', platform_username: '@alicetv' });
    bio = '';
    const again = await verifyAndStore({ hive_username: 'alice', platform: 'youtube', platform_username: '@alicetv' });
    expect(again.verified).toBe(false);
  });

  describe('one verified owner per channel', () => {
    test('a channel verified by another Hive account cannot be claimed', async () => {
      bio = `${BOB} ${ALICE}`;
      await verifyAndStore({ hive_username: 'bob', platform: 'youtube', platform_username: '@alicetv' });
      const err = await verifyAndStore({ hive_username: 'alice', platform: 'youtube', platform_username: '@alicetv' }).catch((e) => e);
      expect(err.code).toBe('CHANNEL_ALREADY_LINKED');
      expect(err.claimedBy).toBe('bob');
      expect(await links().countDocuments({ hive_username: 'alice' })).toBe(0);
    });

    test('an unverified claim by someone else does not block the real owner', async () => {
      bio = '';
      await verifyAndStore({ hive_username: 'mallory', platform: 'youtube', platform_username: '@alicetv' });
      bio = ALICE;
      await expect(verifyAndStore({ hive_username: 'alice', platform: 'youtube', platform_username: '@alicetv' }))
        .resolves.toMatchObject({ verified: true });
    });

    test('the same user re-verifying their own channel is not "another account"', async () => {
      bio = ALICE;
      await verifyAndStore({ hive_username: 'alice', platform: 'youtube', platform_username: '@alicetv' });
      await expect(codeOf(verifyAndStore({ hive_username: 'Alice', platform: 'youtube', platform_username: '@alicetv' }))).resolves.toBe('resolved');
    });
  });

  describe('the per-user cap (3 in this file)', () => {
    beforeEach(() => links().insertMany(['a', 'b', 'c'].map((p) => ({
      hive_username: 'alice', platform: 'soundcloud', platform_username: p, verified: true, first_seen: new Date(),
    }))));

    test('a fourth link is refused and nothing is written', async () => {
      bio = ALICE;
      await expect(codeOf(verifyAndStore({ hive_username: 'alice', platform: 'youtube', platform_username: '@alicetv' }))).resolves.toBe('TOO_MANY_LINKS');
      expect(await links().countDocuments({ hive_username: 'alice' })).toBe(3);
    });

    test('re-checking an existing link is still allowed at the cap', async () => {
      await links().deleteOne({ platform_username: 'c' });
      bio = ALICE;
      await verifyAndStore({ hive_username: 'alice', platform: 'youtube', platform_username: '@alicetv' });
      await expect(codeOf(verifyAndStore({ hive_username: 'alice', platform: 'youtube', platform_username: '@alicetv' }))).resolves.toBe('resolved');
    });
  });

  describe('platform switches', () => {
    test('an unknown platform is UNSUPPORTED_PLATFORM', async () => {
      await expect(codeOf(verifyAndStore({ hive_username: 'alice', platform: 'myspace', platform_username: 'x' }))).resolves.toBe('UNSUPPORTED_PLATFORM');
    });

    test('a switched-off platform refuses new links, without asking it anything', async () => {
      await expect(codeOf(verifyAndStore({ hive_username: 'alice', platform: 'tiktok', platform_username: 'alicedances' }))).resolves.toBe('UNSUPPORTED_PLATFORM');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('the warm-up task may link a switched-off platform', async () => {
      bio = ALICE;
      await expect(verifyAndStore({ hive_username: 'alice', platform: 'tiktok', platform_username: 'alicedances' }, { ignoreLinkSwitch: true }))
        .resolves.toMatchObject({ platform: 'tiktok', verified: true });
    });
  });

  test.each([
    [{ platform: 'youtube', platform_username: 'x' }, 'hive_username is required'],
    [{ hive_username: 'alice', platform_username: 'x' }, 'platform is required'],
    [{ hive_username: 'alice', platform: 'youtube' }, 'platform_username is required'],
  ])('missing input %p is refused', async (input, message) => {
    await expect(codeOf(verifyAndStore(input))).resolves.toBe(message);
  });

  test('a platform failure throws and leaves an existing verified link untouched', async () => {
    bio = ALICE;
    const before = await verifyAndStore({ hive_username: 'alice', platform: 'youtube', platform_username: '@alicetv' });
    global.fetch = fakeFetch([['https://www.googleapis.com/', () => ({ status: 500, body: 'backend error' })]]);
    await expect(codeOf(verifyAndStore({ hive_username: 'alice', platform: 'youtube', platform_username: '@alicetv' }))).resolves.toBe('Platform lookup failed');
    expect(await links().findOne({ _id: before._id })).toEqual(before);
  });
});

describe('unlinkIfRevoked', () => {
  beforeEach(async () => {
    bio = ALICE;
    await verifyAndStore({ hive_username: 'alice', platform: 'youtube', platform_username: '@alicetv' });
  });

  test('once the hash is gone from the bio, the row is deleted', async () => {
    bio = 'cleaned up';
    const out = await unlinkIfRevoked({ hive_username: 'Alice', platform: 'youtube', platform_username: UC });
    expect(out.status).toBe('deleted');
    expect(out.record).toMatchObject({ hive_username: 'alice', platform_username: UC });
    expect(await links().countDocuments()).toBe(0);
  });

  test('while the hash is still there the row is kept, re-verified and refreshed', async () => {
    const out = await unlinkIfRevoked({ hive_username: 'alice', platform: 'youtube', platform_username: '@alicetv' });
    expect(out.status).toBe('still_present');
    expect(out.record).toMatchObject({ verified: true, last_error: null });
    expect(await links().countDocuments()).toBe(1);
  });

  test('no row for that channel is not_found, and nothing else is touched', async () => {
    const out = await unlinkIfRevoked({ hive_username: 'bob', platform: 'youtube', platform_username: '@alicetv' });
    expect(out).toEqual({ status: 'not_found' });
    expect(await links().countDocuments()).toBe(1);
  });

  test('a platform failure is lookup_failed and the row stays', async () => {
    global.fetch = fakeFetch([['https://www.googleapis.com/', () => { throw new Error('ECONNRESET'); }]]);
    const out = await unlinkIfRevoked({ hive_username: 'alice', platform: 'youtube', platform_username: '@alicetv' });
    expect(out).toEqual({ status: 'lookup_failed', error: 'ECONNRESET' });
    expect(await links().countDocuments()).toBe(1);
  });

  test('unlinking a switched-off platform is still allowed', async () => {
    await links().insertOne({ hive_username: 'alice', platform: 'tiktok', platform_username: 'alicedances', verified: true, first_seen: new Date() });
    bio = '';
    await expect(unlinkIfRevoked({ hive_username: 'alice', platform: 'tiktok', platform_username: '@AliceDances' }))
      .resolves.toMatchObject({ status: 'deleted' });
  });

  test.each([
    [{ platform: 'youtube', platform_username: 'x' }, 'hive_username is required'],
    [{ hive_username: 'alice', platform_username: 'x' }, 'platform is required'],
    [{ hive_username: 'alice', platform: 'youtube' }, 'platform_username is required'],
    [{ hive_username: 'alice', platform: 'myspace', platform_username: 'x' }, 'UNSUPPORTED_PLATFORM'],
  ])('bad input %p is refused', async (input, code) => {
    await expect(codeOf(unlinkIfRevoked(input))).resolves.toBe(code);
  });

  // services/verifier.js:122-125: the "still_present" branch sets verified: true
  // without the other-owner check that verifyAndStore does (:56-67). So a second Hive
  // account gets a VERIFIED link to a channel someone else already verified: store
  // an unverified claim first, have the channel show both hashes, then call unlink.
  // The one-verified-owner-per-channel rule (409 CHANNEL_ALREADY_LINKED on /verify/check)
  // is bypassed through /verify/unlink.
  test('unlink cannot turn a claim into a second verified owner of a channel', async () => {
    // alice owns the channel (beforeEach). mallory stores an unverified claim...
    bio = '';
    await verifyAndStore({ hive_username: 'mallory', platform: 'youtube', platform_username: '@alicetv' });
    // ...and once mallory's hash shows on the channel too, calls unlink.
    bio = `${ALICE} ${hashForHiveUsername('mallory')}`;
    await unlinkIfRevoked({ hive_username: 'mallory', platform: 'youtube', platform_username: '@alicetv' });
    expect(await links().countDocuments({ platform: 'youtube', platform_username: UC, verified: true })).toBe(1);
  });
});
