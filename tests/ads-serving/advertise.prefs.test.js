/**
 * routes/advertise.js, the creator's and viewer's switches: ads on my videos (and
 * the community share), the per-video and per-audio sync from the chain, and the
 * two consent records for viewer and listener rewards.
 *
 * Every write is signed, and the route builds the signed message from the account
 * in the request, so a delegate signature (@threespeak, which holds authority over
 * thousands of accounts) can never be replayed onto somebody else. The cross-account
 * and altered-after-signing cases are ported from scripts/test-advertise.cjs.
 */
const request = require('supertest');
const fx = require('./_fixtures');

fx.useAdEnv({ ADS_STAGE: 'beta', ADS_BETA_USERS: 'meno,alice,bob' });
jest.mock('../../utils/hive', () => ({ ...jest.requireActual('../../utils/hive'), hiveRpcBatch: jest.fn() }));
const { hiveRpcBatch } = require('../../utils/hive');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const { hiveAccount, fakeHiveChain } = require('../helpers/hive');
const {
  AD_CREATOR_PREFS_COLLECTION, AD_VIEWER_PREFS_COLLECTION, AD_VIEWER_WATCH_COLLECTION, AD_LISTENER_LISTEN_COLLECTION,
  AD_CREATOR_POOL_PCT, AD_DEFAULT_COMMUNITY_PCT, AD_VIDEO_OPTOUTS_COLLECTION,
} = require('../../utils/config');

const app = buildApp(['/advertise', require('../../routes/advertise')]);
const db = testDb.use();
fx.freezeTime();

const meno = hiveAccount('meno');
const alice = hiveAccount('alice', { postingDelegates: ['threespeak'] });
const bob = hiveAccount('bob', { postingDelegates: ['threespeak'] });
const threespeak = hiveAccount('threespeak');

beforeEach(() => {
  jest.setSystemTime(fx.NOW);
  fakeHiveChain([meno, alice, bob, threespeak]);
  hiveRpcBatch.mockReset();
});

/* The signed messages, spelled out: this is the protocol the frontend and the 3Speak
 * API server must build byte for byte. */
const creatorMsg = (acct, mode, share, ts) => `3speak-ads|creator-prefs|${acct}|${mode}|${share}|${ts}`;
const viewerMsg = (acct, onOff, ts) => `3speak-ads|viewer-prefs|${acct}|${onOff}|${ts}`;
const listenerMsg = (acct, onOff, ts) => `3speak-ads|listener-prefs|${acct}|${onOff}|${ts}`;

const setCreator = (body) => request(app).post('/advertise/creator/prefs').send(body);
/** A creator-prefs body signed for exactly what it says. */
function creatorBody(signer, { account = signer.name, adsEnabled = true, rollsEnabled, audioEnabled, share = 0, ts = Date.now(), mode } = {}) {
  const m = mode || (!adsEnabled ? 'off'
    : `${rollsEnabled === false ? 'no-rolls' : 'on'}${audioEnabled === true ? '+audio' : audioEnabled === false ? '+no-audio' : ''}`);
  return {
    account, adsEnabled, rollsEnabled, audioEnabled, communitySharePct: share, timestamp: ts,
    signature: signer.sign(creatorMsg(account, m, share, ts)),
  };
}

describe('GET /advertise/creator/prefs/:account', () => {
  test('a creator who never chose has ads on, rolls on, audio on, and the default community share', async () => {
    const res = await request(app).get('/advertise/creator/prefs/meno').expect(200);
    expect(res.body).toMatchObject({
      account: 'meno', adsEnabled: true, rollsEnabled: true, adMode: 'on', audioEnabled: true, updatedAt: null,
      split: { poolPct: AD_CREATOR_POOL_PCT, communityPct: AD_DEFAULT_COMMUNITY_PCT, creatorPct: AD_CREATOR_POOL_PCT - AD_DEFAULT_COMMUNITY_PCT, isDefault: true },
    });
    const { split } = res.body;
    expect(split.platformPct + split.poolPct + split.viewerPct + split.listenerPct).toBeCloseTo(100, 5);
  });

  test('reads back a stored choice', async () => {
    await db().collection(AD_CREATOR_PREFS_COLLECTION).insertOne({ _id: 'meno', adsEnabled: true, rollsEnabled: false, communitySharePct: 0 });
    const res = await request(app).get('/advertise/creator/prefs/MENO').expect(200);
    expect(res.body).toMatchObject({ adsEnabled: true, rollsEnabled: false, adMode: 'no-rolls', audioEnabled: false, split: { communityPct: 0, isDefault: false } });
  });

  test('an invalid account is a 400', async () => {
    await request(app).get('/advertise/creator/prefs/no').expect(400);
  });
});

describe('POST /advertise/creator/prefs', () => {
  const stored = () => db().collection(AD_CREATOR_PREFS_COLLECTION).findOne({ _id: 'alice' });

  test('the creator\'s own signature switches ads off, and says who signed', async () => {
    const res = await setCreator(creatorBody(alice, { adsEnabled: false, share: 0 })).expect(200);
    expect(res.body).toMatchObject({ adsEnabled: false, adMode: 'off', signedBy: 'alice', audioEnabled: false });
    expect(await stored()).toMatchObject({ adsEnabled: false, communitySharePct: 0, signedBy: 'alice' });
    expect((await stored()).rollsEnabled).toBeUndefined();
  });

  test('@threespeak may sign for a creator who granted it posting authority, and the record says so', async () => {
    const res = await setCreator(creatorBody(threespeak, { account: 'alice', rollsEnabled: false, share: 10 })).expect(200);
    expect(res.body).toMatchObject({ rollsEnabled: false, adMode: 'no-rolls', signedBy: 'threespeak', split: { communityPct: 10, creatorPct: AD_CREATOR_POOL_PCT - 10 } });
  });

  test('"Ads on your audio" rides the signed mode as a suffix and is stored only when sent', async () => {
    await setCreator(creatorBody(alice, { audioEnabled: false })).expect(200);
    expect(await stored()).toMatchObject({ audioEnabled: false });
    // An older client that never sends it leaves the stored choice alone.
    const res = await setCreator(creatorBody(alice, {})).expect(200);
    expect(res.body.audioEnabled).toBe(false);
    await setCreator(creatorBody(alice, { audioEnabled: true })).expect(200);
    expect((await stored()).audioEnabled).toBe(true);
  });

  test('an explicit 0 share stays 0 and is not read as unset; no share at all means the default', async () => {
    await setCreator(creatorBody(alice, { share: 0 })).expect(200);
    expect((await request(app).get('/advertise/creator/prefs/alice')).body.split).toMatchObject({ communityPct: 0, isDefault: false });

    const ts = Date.now();
    await setCreator({
      account: 'bob', adsEnabled: true, timestamp: ts,
      signature: bob.sign(creatorMsg('bob', 'on', AD_DEFAULT_COMMUNITY_PCT, ts)),
    }).expect(200);
    expect((await db().collection(AD_CREATOR_PREFS_COLLECTION).findOne({ _id: 'bob' })).communitySharePct).toBe(AD_DEFAULT_COMMUNITY_PCT);
  });

  test.each([
    ['a share above the creator pool', { communitySharePct: AD_CREATOR_POOL_PCT + 1 }],
    ['a fractional share', { communitySharePct: 12.5 }],
    ['a negative share', { communitySharePct: -1 }],
    ['an invalid account', { account: 'A' }],
  ])('refuses %s with a 400', async (_label, over) => {
    await setCreator({ ...creatorBody(alice), ...over }).expect(400);
  });

  test('an account outside the beta is refused before any signature work', async () => {
    const outsider = hiveAccount('stranger');
    await setCreator(creatorBody(outsider)).expect(403);
  });

  test.each([
    ['the share altered after signing', () => ({ ...creatorBody(alice, { share: 20 }), communitySharePct: 40 })],
    ['on/off flipped after signing', () => ({ ...creatorBody(alice, { adsEnabled: false }), adsEnabled: true })],
    ['rolls flipped after signing', () => ({ ...creatorBody(alice), rollsEnabled: false })],
    ['a signature made for another account', () => ({ ...creatorBody(threespeak, { account: 'alice' }), account: 'bob' })],
    ['another creator\'s own signature', () => creatorBody(bob, { account: 'alice' })],
    ['a signature string that is not one', () => ({ ...creatorBody(alice), signature: 'zzz' })],
  ])('refuses %s with a 401 and stores nothing', async (_label, body) => {
    await setCreator(body()).expect(401, { success: false, error: 'Invalid signature' });
    expect(await db().collection(AD_CREATOR_PREFS_COLLECTION).countDocuments()).toBe(0);
  });

  test('a stale timestamp is refused', async () => {
    await setCreator(creatorBody(alice, { ts: Date.now() - 6 * fx.MIN })).expect(401, { success: false, error: 'timestamp out of tolerance' });
  });

  test('unsigned, it is told the exact message to sign', async () => {
    const res = await setCreator({ account: 'alice', adsEnabled: true, rollsEnabled: false, audioEnabled: true, communitySharePct: 5 }).expect(401);
    expect(res.body.expected_message).toBe('3speak-ads|creator-prefs|alice|no-rolls+audio|5|<ms>');
  });

  test('a beta account Hive has never heard of is a 404', async () => {
    fakeHiveChain([threespeak]);
    await setCreator(creatorBody(meno)).expect(404);
  });
});

describe('POST /advertise/creator/video-ads/sync and /audio-ads/sync', () => {
  const sync = (kind, body, ip = fx.freshIp()) => request(app).post(`/advertise/creator/${kind}/sync`).set('X-Real-IP', ip).send(body);
  const content = (author, permlink, meta) => [{ result: { author, permlink, json_metadata: JSON.stringify(meta) } }];

  test('a video opt-out is copied off the chain', async () => {
    hiveRpcBatch.mockResolvedValue(content('alice', 'my-video', { '3speak': { ads: false } }));
    const res = await sync('video-ads', { author: 'alice', permlink: 'my-video' }).expect(200);
    expect(res.body).toEqual({ success: true, owner: 'alice', permlink: 'my-video', adsEnabled: false, rollsEnabled: false, adMode: 'off' });
    expect(await db().collection(AD_VIDEO_OPTOUTS_COLLECTION).countDocuments()).toBe(1);
  });

  test('a remix that points at someone else\'s video is a 409', async () => {
    hiveRpcBatch.mockResolvedValue(content('alice', 'remix', { video: { info: { author: 'bob', permlink: 'orig' } }, '3speak': { ads: false } }));
    await sync('video-ads', { author: 'alice', permlink: 'remix' }).expect(409, { success: false, error: 'not_asset_owner' });
  });

  test('an audio choice is copied off the chain for the creator\'s own linked track', async () => {
    await db().collection('embed-audio').insertOne({ owner: 'alice', permlink: 'track-1', post_permlink: 'my-song' });
    hiveRpcBatch.mockResolvedValue(content('alice', 'my-song', { '3speak': { audioAds: false } }));
    const res = await sync('audio-ads', { author: 'alice', permlink: 'my-song' }).expect(200);
    expect(res.body).toEqual({ success: true, owner: 'alice', permlink: 'track-1', audioAds: false });
  });

  test.each([
    ['video-ads', [], 502],
    ['video-ads', [{ error: { message: 'Post does not exist' } }], 404],
    ['audio-ads', [], 502],
    ['audio-ads', [{ result: { author: 'alice', permlink: 'unlinked', json_metadata: '{}' } }], 404],
  ])('%s: the chain answering %j is a %p', async (kind, answer, status) => {
    hiveRpcBatch.mockResolvedValue(answer);
    await sync(kind, { author: 'alice', permlink: 'unlinked' }).expect(status);
  });

  test.each(['video-ads', 'audio-ads'])('%s refuses a malformed author or permlink', async (kind) => {
    await sync(kind, { author: 'alice', permlink: 'Bad Permlink' }).expect(400);
    await sync(kind, { author: '9', permlink: 'ok' }).expect(400);
    expect(hiveRpcBatch).not.toHaveBeenCalled();
  });

  test('thirty syncs per address per ten minutes, across both kinds', async () => {
    hiveRpcBatch.mockResolvedValue([]);
    const ip = fx.freshIp();
    for (let i = 0; i < 30; i += 1) await sync(i % 2 ? 'video-ads' : 'audio-ads', { author: 'alice', permlink: 'p' }, ip).expect(502);
    await sync('video-ads', { author: 'alice', permlink: 'p' }, ip).expect(429);
    await sync('audio-ads', { author: 'alice', permlink: 'p' }, ip).expect(429);
  });
});

describe('viewer rewards: consent to be identified', () => {
  const setViewer = (body) => request(app).post('/advertise/viewer/prefs').send(body);
  const viewerBody = (signer, on, { account = signer.name, ts = Date.now() } = {}) => ({
    account, rewardsEnabled: on, timestamp: ts, signature: signer.sign(viewerMsg(account, on === true ? 'on' : 'off', ts)),
  });

  test('nobody is opted in until they say so, and an unasked viewer reads as undecided', async () => {
    const res = await request(app).get('/advertise/viewer/prefs/alice').expect(200);
    expect(res.body).toMatchObject({ rewardsEnabled: false, decided: false, listenEnabled: false, listenDecided: false });
  });

  test('a signed opt-in is stored with who signed it', async () => {
    await setViewer(viewerBody(alice, true)).expect(200, { success: true, account: 'alice', rewardsEnabled: true, decided: true, removedWatchRows: 0 });
    expect(await db().collection(AD_VIEWER_PREFS_COLLECTION).findOne({ _id: 'alice' })).toMatchObject({ rewardsEnabled: true, signedBy: 'alice' });
    expect((await request(app).get('/advertise/viewer/prefs/alice')).body).toMatchObject({ rewardsEnabled: true, decided: true });
  });

  test('opting out deletes the identified watch rows already collected', async () => {
    await db().collection(AD_VIEWER_WATCH_COLLECTION).insertMany([
      { viewer: 'alice', owner: 'x', permlink: '1' }, { viewer: 'alice', owner: 'x', permlink: '2' }, { viewer: 'bob', owner: 'x', permlink: '1' },
    ]);
    const res = await setViewer(viewerBody(threespeak, false, { account: 'alice' })).expect(200);
    expect(res.body).toMatchObject({ rewardsEnabled: false, removedWatchRows: 2 });
    expect(await db().collection(AD_VIEWER_WATCH_COLLECTION).countDocuments()).toBe(1);
  });

  test('anything that is not literally true is a decline, and the signature has to say "off"', async () => {
    const ts = Date.now();
    await setViewer({ account: 'alice', rewardsEnabled: 'yes', timestamp: ts, signature: alice.sign(viewerMsg('alice', 'on', ts)) }).expect(401);
    await setViewer({ account: 'alice', rewardsEnabled: 'yes', timestamp: ts, signature: alice.sign(viewerMsg('alice', 'off', ts)) })
      .expect(200);
    expect((await db().collection(AD_VIEWER_PREFS_COLLECTION).findOne({ _id: 'alice' })).rewardsEnabled).toBe(false);
  });

  test.each([
    ['unsigned', { account: 'alice', rewardsEnabled: true }, 401, /Signature required/],
    ['stale', () => viewerBody(alice, true, { ts: Date.now() - 6 * fx.MIN }), 401, /out of tolerance/],
    ['signed for someone else', () => ({ ...viewerBody(bob, true), account: 'alice' }), 401, /Invalid signature/],
    ['a garbage signature', () => ({ ...viewerBody(alice, true), signature: 'x' }), 401, /Invalid signature/],
    ['outside the beta', () => viewerBody(hiveAccount('stranger'), true), 403, /closed testing/],
    ['an invalid account', { account: '!!', rewardsEnabled: true }, 400, /Invalid account/],
  ])('refuses %s', async (_label, body, status, error) => {
    const res = await setViewer(typeof body === 'function' ? body() : body).expect(status);
    expect(res.body.error).toMatch(error);
  });

  test('an account missing from Hive is a 404, and an invalid one a 400 on read', async () => {
    fakeHiveChain([]);
    await setViewer(viewerBody(meno, true)).expect(404);
    await request(app).get('/advertise/viewer/prefs/B').expect(400);
  });
});

describe('listener rewards: a separate consent', () => {
  const setListener = (body) => request(app).post('/advertise/listener/prefs').send(body);
  const listenerBody = (signer, on, { account = signer.name, ts = Date.now() } = {}) => ({
    account, listenEnabled: on, timestamp: ts, signature: signer.sign(listenerMsg(account, on === true ? 'on' : 'off', ts)),
  });

  test('opting in to listening is not an opt-in to watching, and the other way round', async () => {
    await setListener(listenerBody(alice, true)).expect(200, { success: true, account: 'alice', listenEnabled: true, listenDecided: true, removedListenRows: 0 });
    expect((await request(app).get('/advertise/viewer/prefs/alice')).body).toMatchObject({
      rewardsEnabled: false, decided: false, listenEnabled: true, listenDecided: true,
    });
  });

  test('a viewer-rewards signature cannot be replayed as a listener consent', async () => {
    const ts = Date.now();
    await setListener({ account: 'alice', listenEnabled: true, timestamp: ts, signature: alice.sign(viewerMsg('alice', 'on', ts)) }).expect(401);
  });

  test('opting out deletes the identified listening rows', async () => {
    await db().collection(AD_LISTENER_LISTEN_COLLECTION).insertMany([{ listener: 'alice' }, { listener: 'bob' }]);
    const res = await setListener(listenerBody(threespeak, false, { account: 'alice' })).expect(200);
    expect(res.body.removedListenRows).toBe(1);
    expect(await db().collection(AD_VIEWER_PREFS_COLLECTION).findOne({ _id: 'alice' })).toMatchObject({ listenEnabled: false, listenSignedBy: 'threespeak' });
  });

  test.each([
    ['unsigned', { account: 'alice', listenEnabled: true }, 401],
    ['stale', () => listenerBody(alice, true, { ts: Date.now() - 6 * fx.MIN }), 401],
    ['a garbage signature', () => ({ ...listenerBody(alice, true), signature: 'x' }), 401],
    ['outside the beta', () => listenerBody(hiveAccount('stranger'), true), 403],
    ['an invalid account', { account: '!!' }, 400],
  ])('refuses %s', async (_label, body, status) => {
    await setListener(typeof body === 'function' ? body() : body).expect(status);
  });

  test('an account missing from Hive is a 404', async () => {
    fakeHiveChain([]);
    await setListener(listenerBody(meno, true)).expect(404);
  });
});

describe('with signatures switched off (development only)', () => {
  const open = () => buildApp(['/advertise', fx.isolatedModule('../../routes/advertise', { HIVE_AUTH_REQUIRED: 'false' })]);
  test.each([
    ['/advertise/creator/prefs', { account: 'alice', adsEnabled: false }, { signedBy: 'alice' }],
    ['/advertise/viewer/prefs', { account: 'alice', rewardsEnabled: true }, { rewardsEnabled: true }],
    ['/advertise/listener/prefs', { account: 'alice', listenEnabled: true }, { listenEnabled: true }],
  ])('%s is accepted unsigned', async (path, body, want) => {
    expect((await request(open()).post(path).send(body).expect(200)).body).toMatchObject(want);
  });
});

describe('a database failure is a 500 that says nothing about why', () => {
  test.each([
    ['get', '/advertise/creator/prefs/alice'],
    ['get', '/advertise/viewer/prefs/alice'],
  ])('%s %s', async (method, path) => {
    fx.databaseFails();
    await request(app)[method](path).expect(500, { success: false, error: 'Internal server error' });
  });

  test.each([
    ['/advertise/creator/prefs', () => creatorBody(alice)],
    ['/advertise/viewer/prefs', () => {
      const ts = Date.now();
      return { account: 'alice', rewardsEnabled: true, timestamp: ts, signature: alice.sign(viewerMsg('alice', 'on', ts)) };
    }],
    ['/advertise/listener/prefs', () => {
      const ts = Date.now();
      return { account: 'alice', listenEnabled: true, timestamp: ts, signature: alice.sign(listenerMsg('alice', 'on', ts)) };
    }],
  ])('POST %s, signed', async (path, body) => {
    fx.databaseFails();
    await request(app).post(path).send(body()).expect(500);
  });

  test.each(['video-ads', 'audio-ads'])('the %s sync, when the mirror cannot be written', async (kind) => {
    hiveRpcBatch.mockResolvedValue([{ result: { author: 'alice', permlink: 'p', json_metadata: '{}' } }]);
    fx.databaseFails();
    await request(app).post(`/advertise/creator/${kind}/sync`).set('X-Real-IP', fx.freshIp()).send({ author: 'alice', permlink: 'p' }).expect(500);
  });
});
