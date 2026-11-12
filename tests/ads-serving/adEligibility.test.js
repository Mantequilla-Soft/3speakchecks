/**
 * utils/adEligibility.js: the single place that decides whether a playback (video
 * or audio) carries an ad at all. The gates run hardest first: the trial owner list,
 * the creator watching their own upload, a Pro subscriber, then the creator's own
 * switches for the account and for the one video or track.
 *
 * The premium set is cached in-process, so every test loads a fresh copy of the
 * module (with its own environment) against the real test database.
 */
const fx = require('./_fixtures');

fx.useAdEnv();
const testDb = require('../helpers/db');
const { PREMIUM_USERS_COLLECTION, AD_CREATOR_PREFS_COLLECTION, AD_VIDEO_OPTOUTS_COLLECTION } = require('../../utils/config');

const db = testDb.use();
fx.freezeTime();
beforeEach(() => jest.setSystemTime(fx.NOW));

// The chain, for the payout a post declines or accepts (utils/rewardRefusal.js).
// Every post accepts unless a test lists it in `declined`.
let declined;
beforeEach(() => { declined = new Set(); });
const hiveRpcBatch = async ([call]) => [{ id: 1, result: {
  author: call.params[0],
  max_accepted_payout: declined.has(call.params.join('/')) ? '0.000 HBD' : '1000000.000 HBD',
} }];
const load = (env = {}, getDb = () => db()) => fx.loadIsolated('../../utils/adEligibility', {
  env, mocks: { '../../utils/db': () => ({ getDb }), '../../utils/hive': () => ({ hiveRpcBatch }) },
});
const blockRewards = (username) => db().collection('contentcreators').insertOne({ username, adRewardDisabled: true });

const premium = (username, expires = null) => db().collection(PREMIUM_USERS_COLLECTION)
  .insertOne({ username, premium: true, premium_expires_at: expires });
const prefs = (owner, doc) => db().collection(AD_CREATOR_PREFS_COLLECTION).insertOne({ _id: owner, ...doc });
const videoMode = (owner, permlink, mode) => db().collection(AD_VIDEO_OPTOUTS_COLLECTION)
  .insertOne({ _id: `${owner}/${permlink}`, owner, permlink, ...(mode ? { mode } : {}) });
const trackChoice = (owner, permlink, ads) => db().collection('ad_audio_choices')
  .insertOne({ _id: `${owner}/${permlink}`, ads });

const watch = { viewer: 'viewer1', owner: 'creator1', permlink: 'vid-1' };

describe('adDecision: should this video playback carry an ad', () => {
  test('by default it carries ads, rolls included', async () => {
    await expect(load().adDecision(watch)).resolves.toEqual({ ads: true, reason: null, rolls: true, rollsReason: null });
  });

  test('while a trial list is set, only those owners carry ads, before any database read', async () => {
    const getDb = jest.fn(() => db());
    const { adDecision } = load({ ADS_ALLOWED_OWNERS: 'badadib' }, getDb);
    await expect(adDecision(watch)).resolves.toEqual({ ads: false, reason: 'owner_not_in_trial' });
    await expect(adDecision({ ...watch, owner: '' })).resolves.toMatchObject({ reason: 'owner_not_in_trial' });
    expect(getDb).not.toHaveBeenCalled();
    await expect(adDecision({ ...watch, owner: '@BadAdib' })).resolves.toMatchObject({ ads: true });
  });

  test('a creator never sees an ad on their own video, whatever the case of the name', async () => {
    await expect(load().adDecision({ ...watch, viewer: 'Creator1' })).resolves.toEqual({ ads: false, reason: 'own_video' });
  });

  test('an account on the self-view list may see ads on its own uploads (testing only)', async () => {
    const { adDecision } = load({ AD_SELF_VIEW_ALLOWED_ACCOUNTS: 'creator1' });
    await expect(adDecision({ ...watch, viewer: 'creator1' })).resolves.toMatchObject({ ads: true });
  });

  test('a Pro subscriber gets no ad, and the reason says why', async () => {
    await premium('viewer1');
    await expect(load().adDecision(watch)).resolves.toEqual({ ads: false, reason: 'premium_viewer' });
  });

  test('a one-day pass that lapsed a second ago is not premium, even before the sync catches up', async () => {
    await premium('viewer1', fx.ago(1000));
    await expect(load().adDecision(watch)).resolves.toMatchObject({ ads: true });
  });

  test('a pass that is still running is premium', async () => {
    await premium('viewer1', fx.fromNow(fx.HOUR));
    await expect(load().adDecision(watch)).resolves.toMatchObject({ reason: 'premium_viewer' });
  });

  test('an account on the premium-override list is treated as a non-subscriber (testing only)', async () => {
    await premium('viewer1');
    await expect(load({ AD_PREMIUM_OVERRIDE_ACCOUNTS: 'viewer1' }).adDecision(watch)).resolves.toMatchObject({ ads: true });
  });

  test('when the premium set cannot be read the answer is no ad, never an ad in front of a subscriber', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const broken = () => ({ collection: () => ({ find: () => ({ toArray: async () => { throw new Error('timeout'); } }) }) });
    await expect(load({}, broken).adDecision(watch)).resolves.toEqual({ ads: false, reason: 'unknown_premium_state' });
    expect(err).toHaveBeenCalledWith('[ad-eligibility] premium load failed:', 'timeout');
  });

  test.each([
    ['the creator turned ads off', { adsEnabled: false }, null, { ads: false, reason: 'creator_opted_out' }],
    ['the creator takes overlays only', { rollsEnabled: false }, null, { ads: true, rolls: false, rollsReason: 'creator_no_rolls' }],
    ['this one video has ads off', null, 'off', { ads: false, reason: 'video_opted_out' }],
    ['this one video has rolls off', null, 'no-rolls', { ads: true, rolls: false, rollsReason: 'video_no_rolls' }],
    ['an opt-out row from before modes existed means off', null, 'legacy', { ads: false, reason: 'video_opted_out' }],
    ['account off beats a video that only refuses rolls', { adsEnabled: false }, 'no-rolls', { reason: 'creator_opted_out' }],
  ])('%s', async (_label, account, video, want) => {
    if (account) await prefs('creator1', account);
    if (video) await videoMode('creator1', 'vid-1', video === 'legacy' ? null : video);
    await expect(load().adDecision(watch)).resolves.toMatchObject(want);
  });

  test('a reward-blocked creator carries no ads, whatever their own switches say', async () => {
    await blockRewards('creator1');
    await prefs('creator1', { adsEnabled: true });
    await expect(load().adDecision(watch)).resolves.toEqual({ ads: false, reason: 'creator_reward_blocked' });
    await expect(load().adDecision({ ...watch, owner: 'creator2' })).resolves.toMatchObject({ ads: true });
  });

  test('a video whose Hive post declines rewards carries no ads; its sibling does', async () => {
    await db().collection('embed-video').insertMany([
      { owner: 'creator1', permlink: 'vid-1', hive_author: 'creator1', hive_permlink: 'post-1' },
      { owner: 'creator1', permlink: 'vid-2', hive_author: 'creator1', hive_permlink: 'post-2' },
    ]);
    declined.add('creator1/post-1');
    const { adDecision } = load();
    await expect(adDecision(watch)).resolves.toEqual({ ads: false, reason: 'rewards_declined' });
    await expect(adDecision({ ...watch, permlink: 'vid-2' })).resolves.toMatchObject({ ads: true });
  });

  test('a live stream announced with rewards declined carries no ads (room = post permlink)', async () => {
    declined.add('creator1/room-1');
    await expect(load().adDecision({ ...watch, permlink: 'room-1' })).resolves.toMatchObject({ reason: 'rewards_declined' });
  });

  test('a Pro subscriber still reads as premium on declined content, so the player can flag the session', async () => {
    await premium('viewer1');
    declined.add('creator1/vid-1');
    await expect(load().adDecision(watch)).resolves.toEqual({ ads: false, reason: 'premium_viewer' });
  });

  test('an anonymous viewer is never a subscriber and still gets the creator\'s rules', async () => {
    await prefs('creator1', { adsEnabled: false });
    await expect(load().adDecision({ ...watch, viewer: null })).resolves.toMatchObject({ reason: 'creator_opted_out' });
  });
});

describe('the premium cache', () => {
  test('a stale set answers at once and refreshes in the background, once', async () => {
    const real = db();
    let loads = 0;
    const counting = () => ({
      collection: (name) => {
        const c = real.collection(name);
        if (name !== PREMIUM_USERS_COLLECTION) return c;
        return { find: (...a) => { loads += 1; return c.find(...a); } };
      },
    });
    const { isPremiumViewer } = load({ AD_ELIGIBILITY_TTL_MS: '1000' }, counting);
    await expect(isPremiumViewer('viewer1')).resolves.toBe(false);
    expect(loads).toBe(1);

    fx.advance(1001);
    const answers = await Promise.all([isPremiumViewer('viewer1'), isPremiumViewer('viewer1')]);
    expect(answers).toEqual([false, false]);
    expect(loads).toBe(2);
  });

  test('a blank name is never a subscriber, and a row without a name is ignored', async () => {
    await db().collection(PREMIUM_USERS_COLLECTION).insertOne({ username: '', premium: true });
    const { isPremiumViewer } = load();
    await expect(isPremiumViewer('')).resolves.toBe(false);
    await expect(isPremiumViewer('nobody')).resolves.toBe(false);
  });
});

describe('creatorAdMode and creatorOptedOut', () => {
  test.each([
    ['no row', null, 'on'],
    ['ads on', { adsEnabled: true }, 'on'],
    ['ads off', { adsEnabled: false }, 'off'],
    ['rolls off', { rollsEnabled: false }, 'no-rolls'],
    ['only a literal false counts', { adsEnabled: 'no', rollsEnabled: 0 }, 'on'],
  ])('%s -> %s', async (_label, doc, mode) => {
    if (doc) await prefs('creator1', doc);
    const { creatorAdMode, creatorOptedOut } = load();
    await expect(creatorAdMode('@Creator1')).resolves.toBe(mode);
    await expect(creatorOptedOut('creator1')).resolves.toBe(mode === 'off');
  });

  test('no owner means the default', async () => {
    await expect(load().creatorAdMode('')).resolves.toBe('on');
  });
});

describe('audioEnabledOf: "Ads on your audio" for a stored prefs row', () => {
  const { audioEnabledOf } = require('../../utils/adEligibility');
  test.each([
    ['no row', null, true],
    ['ads off wins over everything', { adsEnabled: false, audioEnabled: true }, false],
    ['an explicit yes', { audioEnabled: true, rollsEnabled: false }, true],
    ['an explicit no', { audioEnabled: false }, false],
    ['no choice, but rolls off: a spoken spot pauses the audio like a roll', { rollsEnabled: false }, false],
    ['no choice, everything else on', { adsEnabled: true }, true],
  ])('%s -> %p', (_label, doc, want) => expect(audioEnabledOf(doc)).toBe(want));
});

describe('audioAdDecision: should this audio playback carry a spoken spot', () => {
  const listen = { viewer: 'listener1', owner: 'creator1', permlink: 'track-1' };

  test('by default it does', async () => {
    await expect(load().audioAdDecision(listen)).resolves.toEqual({ ads: true, reason: null });
  });

  test.each([
    ['owner outside the trial', { ADS_ALLOWED_OWNERS: 'badadib' }, listen, 'owner_not_in_trial'],
    ['no owner at all, with a trial list', { ADS_ALLOWED_OWNERS: 'badadib' }, { ...listen, owner: '' }, 'owner_not_in_trial'],
    ['the creator listening to their own track', {}, { ...listen, viewer: 'creator1' }, 'own_video'],
  ])('refused: %s', async (_label, env, args, reason) => {
    await expect(load(env).audioAdDecision(args)).resolves.toEqual({ ads: false, reason });
  });

  test('a Pro listener gets none; an unreadable premium set gets none', async () => {
    await premium('listener1');
    await expect(load().audioAdDecision(listen)).resolves.toEqual({ ads: false, reason: 'premium_viewer' });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const broken = () => ({ collection: () => ({ find: () => ({ toArray: async () => { throw new Error('down'); } }) }) });
    await expect(load({}, broken).audioAdDecision(listen)).resolves.toEqual({ ads: false, reason: 'unknown_premium_state' });
  });

  test('a reward-blocked creator or a declined episode gets none, even with the track switched on', async () => {
    await trackChoice('creator1', 'track-1', true);
    await blockRewards('creator1');
    await expect(load().audioAdDecision(listen)).resolves.toEqual({ ads: false, reason: 'creator_reward_blocked' });
    await db().collection('contentcreators').deleteMany({});
    await db().collection('embed-audio').insertOne({ owner: 'creator1', permlink: 'track-1', post_permlink: 'ep-1' });
    declined.add('creator1/ep-1');
    await expect(load().audioAdDecision(listen)).resolves.toEqual({ ads: false, reason: 'rewards_declined' });
  });

  test.each([
    ['the track says no, the account says yes', { audioEnabled: true }, false, { ads: false, reason: 'audio_opted_out' }],
    ['the track says yes, the account says no', { audioEnabled: false }, true, { ads: true, reason: null }],
    ['no track choice: the account decides', { audioEnabled: false }, null, { ads: false, reason: 'creator_audio_off' }],
    ['no track choice, legacy no-rolls account', { rollsEnabled: false }, null, { ads: false, reason: 'creator_audio_off' }],
  ])('%s', async (_label, account, track, want) => {
    await prefs('creator1', account);
    if (track !== null) await trackChoice('creator1', 'track-1', track);
    await expect(load().audioAdDecision(listen)).resolves.toEqual(want);
  });
});
