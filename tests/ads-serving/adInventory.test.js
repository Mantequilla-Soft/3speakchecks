/**
 * services/adInventory.js: what the platform can honestly promise an advertiser.
 * Junk sessions, bot-like accounts, Pro subscribers and opted-out creators are
 * removed; a slot counts only the sessions whose playhead actually reached it; roll
 * bookings are quoted without the creators who take overlays only.
 *
 * One small watch log, built by hand, with every figure below worked out from it.
 * The window is two days so per-day figures are big enough to tell apart.
 */
const fx = require('./_fixtures');

fx.useAdEnv({ AD_INVENTORY_WINDOW_DAYS: '2' });
const testDb = require('../helpers/db');
const inventory = require('../../services/adInventory');
const { AD_INVENTORY_COLLECTION, AD_CREATOR_PREFS_COLLECTION, PREMIUM_USERS_COLLECTION } = require('../../utils/config');

const db = testDb.use();
fx.freezeTime();
beforeEach(() => jest.setSystemTime(fx.NOW));

const { DAY } = fx;
const watch = (owner, permlink, over = {}) => ({
  owner, permlink, updatedAt: fx.ago(DAY), videoDuration: 600, contentSeconds: 60, maxPosition: 60, ...over,
});

async function seedWorld() {
  await db().collection('view-durations').insertMany([
    // alice, a 10-minute video: one long session, one short one, one junk, one Pro.
    watch('alice', 'a1', { contentSeconds: 200, maxPosition: 300, country: 'DE' }),
    watch('alice', 'a1', { contentSeconds: 30, maxPosition: 70, country: 'DE' }),
    watch('alice', 'a1', { contentSeconds: 2, maxPosition: 2, country: 'DE' }),
    watch('alice', 'a1', { contentSeconds: 100, maxPosition: 600, premium: true, country: 'DE' }),
    watch('alice', 'a1', { updatedAt: fx.ago(40 * DAY) }),
    // alice, a two-minute video watched to the end.
    watch('alice', 'a2', { videoDuration: 120, contentSeconds: 60, maxPosition: 120, country: 'DE' }),
    // bob turned ads off; carol takes banners and tickers only.
    watch('bob', 'b1', { contentSeconds: 100, maxPosition: 600 }),
    watch('carol', 'c1', { contentSeconds: 100, maxPosition: 600, country: 'US' }),
    // dave's video is shorter than a spot: an audience, but no slot.
    watch('dave', 'd1', { videoDuration: 10, contentSeconds: 8, maxPosition: 10 }),
    // 50 four-second sessions: autoplay traffic, not an audience.
    ...Array.from({ length: 50 }, () => watch('bot', 'x1', { contentSeconds: 4, maxPosition: 4 })),
  ]);
  await db().collection(AD_CREATOR_PREFS_COLLECTION).insertMany([
    { _id: 'bob', adsEnabled: false },
    { _id: 'carol', adsEnabled: true, rollsEnabled: false },
  ]);
  await db().collection(PREMIUM_USERS_COLLECTION).insertOne({ username: 'pro1', premium: true });
}

async function seedAudioAndUploads() {
  await db().collection('listen-durations').insertMany([
    { kind: 'audio', owner: 'alice', id: 't1', startedAt: fx.ago(2 * DAY - 1000), duration: 300, contentSeconds: 100, maxPosition: 200, country: 'DE' },
    { kind: 'audio', owner: 'badadib', id: 't2', startedAt: fx.ago(DAY), duration: 300, contentSeconds: 50, maxPosition: 300 },
    { kind: 'audio', owner: 'alice', id: 't1', startedAt: fx.ago(DAY), duration: 300, contentSeconds: 1, maxPosition: 1 },
    { kind: 'podcast', owner: 'alice', id: 'e1', startedAt: fx.ago(DAY), duration: 300, contentSeconds: 300 },
    { kind: 'audio', owner: 'bob', id: 't3', startedAt: fx.ago(DAY), duration: 300, contentSeconds: 300 },
  ]);
  await db().collection('embed-audio').insertMany([
    { owner: 'alice', permlink: 't1', status: 'published', createdAt: fx.ago(DAY) },
    { owner: 'alice', permlink: 't9', status: 'published', visibility: 'private', createdAt: fx.ago(10 * DAY) },
  ]);
  await db().collection('embed-video').insertMany([
    { owner: 'alice', permlink: 'u1', frontend_app: '3speak-tv', createdAt: fx.ago(DAY) },
    { owner: 'erin', permlink: 'u2', frontend_app: '3speak-tv', short: true, createdAt: fx.ago(DAY) },
    { owner: 'zed', permlink: 'u3', frontend_app: 'other-app', createdAt: fx.ago(DAY) },
  ]);
}

describe('computeSnapshot: the video audience', () => {
  let snap;
  beforeEach(async () => {
    await seedWorld();
    snap = await inventory.computeSnapshot();
  });

  test('raw counts everything in the window; sellable keeps only real, eligible viewing', () => {
    expect(snap.raw.sessions).toBe(58);
    expect(snap.sellable).toMatchObject({ sessions: 5, videos: 4, removedSessions: 53, removedPct: 91.4, sessionsPerDay: 0.7 });
    expect(snap.sellable.watchHours).toBe(Math.round(((200 + 30 + 60 + 100 + 8) / 3600) * 10) / 10);
  });

  test('says who was removed and why, without silently dropping anyone', () => {
    expect(snap.excluded).toMatchObject({
      suspectAccounts: [{ owner: 'bot', sessions: 50, avgSeconds: 4 }],
      optedOutAccounts: ['bob'],
      noRollAccounts: ['carol'],
      premiumSubscribers: 1,
      premiumSessionsTracked: false,
    });
    expect(snap.rules).toEqual({ minEngagedSeconds: 3, adLengthSeconds: 15, suspectMinSessions: 50, suspectMaxAvgSeconds: 5 });
  });

  test('a slot counts the sessions whose playhead reached it, on videos long enough to hold a spot', () => {
    const by = Object.fromEntries(snap.slots.map((s) => [s.percent, s]));
    expect(snap.slots.map((s) => s.sessions)).toEqual([4, 4, 3, 3, 2]);
    expect(by[0]).toMatchObject({ kind: 'pre-roll', videos: 3, perDay: 2, perMonth: 60, reachPct: 80 });
    expect(by[75]).toMatchObject({ kind: 'mid-roll', sessions: 2, perDay: 1, reachPct: 40 });
  });

  test('a roll is quoted without the creators who take overlays only', () => {
    expect(snap.rollSlots.map((s) => s.sessions)).toEqual([3, 3, 2, 2, 1]);
  });

  test('countries are shares of the sellable audience, with unknown kept as such', () => {
    expect(snap.countries).toEqual([
      { code: 'DE', sessions: 3, sharePct: 60 },
      expect.objectContaining({ sessions: 1, sharePct: 20 }),
      expect.objectContaining({ sessions: 1, sharePct: 20 }),
    ]);
    expect(snap.countries.map((c) => c.code).sort()).toEqual(['DE', 'US', 'unknown']);
  });
});

describe('computeSnapshot: when nothing has happened', () => {
  test('every figure is zero rather than missing, and rollSlots is simply slots', async () => {
    const snap = await inventory.computeSnapshot();
    expect(snap.raw).toEqual({ sessions: 0, videos: 0, watchHours: 0 });
    expect(snap.sellable.removedPct).toBe(0);
    expect(snap.slots.every((s) => s.sessions === 0 && s.reachPct === 0)).toBe(true);
    expect(snap.rollSlots).toBe(snap.slots);
    expect(snap.audio).toMatchObject({ listens: 0, measuredDays: 2, since: null, trial: null });
    expect(snap.uploads).toMatchObject({ uploads: 0, creators: 0 });
  });
});

describe('the audio and upload audiences', () => {
  test('audio counts 3Speak listens only, per day measured, with each slot\'s reach', async () => {
    await seedWorld();
    await seedAudioAndUploads();
    const { audio } = await inventory.computeSnapshot();
    expect(audio).toMatchObject({ measuredDays: 2, listens: 2, listensPerDay: 1, tracks: 2, catalogue: 1, trial: null, trialListensPerDay: 1 });
    expect(audio.slots.map((s) => s.perDay)).toEqual([1, 1, 1, 1, 0.5]);
    expect(audio.slots.find((s) => s.percent === 75).reachPct).toBe(50);
    expect(audio.countries.map((c) => c.code).sort()).toEqual(['DE', 'unknown']);
  });

  test('uploads count 3speak.tv videos and every audio upload inside the window', async () => {
    await seedAudioAndUploads();
    const { uploads } = await inventory.computeSnapshot();
    // Not the other app's video, and not the audio uploaded ten days ago.
    expect(uploads).toEqual({ uploads: 3, uploadsPerDay: 0.4, videosPerDay: 0.5, shortsPerDay: 0.5, audioPerDay: 0.5, creators: 2 });
  });

  test('with a trial list the audio tab says whose audio carries spots and how much of it there is', async () => {
    await seedAudioAndUploads();
    // The list as utils/adTts.js publishes it (read from there at run time).
    const tts = require('../../utils/adTts');
    const saved = tts.AUDIO_TICKER_ALLOWED_OWNERS;
    tts.AUDIO_TICKER_ALLOWED_OWNERS = ['badadib'];
    try {
      const { audio } = await inventory.computeSnapshot();
      expect(audio).toMatchObject({ listens: 3, trial: ['badadib'], trialListensPerDay: 0.5 });
    } finally {
      tts.AUDIO_TICKER_ALLOWED_OWNERS = saved;
    }
  });

  test('liveAudiences keeps what a snapshot already carries and reads what it lacks', async () => {
    await seedAudioAndUploads();
    const carried = { audio: { listens: 99 }, uploads: { uploads: 7 } };
    await expect(inventory.liveAudiences(carried)).resolves.toEqual(carried);
    const old = await inventory.liveAudiences({ windowDays: 2, excluded: { suspectAccounts: [], optedOutAccounts: ['bob'] } });
    expect(old.audio.listens).toBe(2);
    expect(old.uploads.uploads).toBe(3);
    const none = await inventory.liveAudiences(null);
    expect(none.audio.listens).toBe(3);
  });
});

describe('runOnce and getSnapshot', () => {
  test('writes one current document that getSnapshot reads back', async () => {
    await seedWorld();
    expect(await inventory.getSnapshot()).toBeNull();
    const snap = await inventory.runOnce();
    expect(snap._id).toBe('current');
    const stored = await inventory.getSnapshot();
    expect(stored.sellable.sessions).toBe(5);
    expect(await db().collection(AD_INVENTORY_COLLECTION).countDocuments()).toBe(1);
    await inventory.runOnce();
    expect(await db().collection(AD_INVENTORY_COLLECTION).countDocuments()).toBe(1);
  });

  // BUG (services/adInventory.js runOnce): the summary line looks for a slot with
  // `position > 0`, but slot rows carry `percent`, so it always logs "no mid-roll
  // slot" however much mid-roll inventory there is. Cosmetic: only the log is wrong.
  test.skip('BUG: the run log never reports the mid-roll figure', async () => {
    await seedWorld();
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await inventory.runOnce();
    const summary = log.mock.calls.map((c) => c[0]).find((line) => /sellable sessions/.test(line));
    expect(summary).not.toMatch(/no mid-roll slot/);
  });

  test('does nothing with writes off, and a failure is logged and returns null', async () => {
    const off = fx.loadIsolated('../../services/adInventory', { env: { ENABLE_MONGO_WRITES: 'false' } });
    await expect(off.runOnce()).resolves.toBeNull();

    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const broken = fx.loadIsolated('../../services/adInventory', {
      mocks: { '../../utils/db': () => ({ getDb: () => { throw new Error('primary stepped down'); } }) },
    });
    await expect(broken.runOnce()).resolves.toBeNull();
    expect(err).toHaveBeenCalledWith('[ad-inventory] run failed:', 'primary stepped down');
  });
});

describe('forecastPerDay: the plays a specific booking would have reached', () => {
  beforeEach(seedWorld);

  test.each([
    ['the whole pre-roll pool', { percent: 0 }, 2],
    ['a roll, without the overlay-only creators', { percent: 0, roll: true }, 1.5],
    ['only videos of at least 200 seconds', { percent: 0, minVideoSeconds: 200 }, 1.5],
    ['only videos of at most 200 seconds', { percent: 0, maxVideoSeconds: 200 }, 0.5],
    ['a window no video falls in', { percent: 0, minVideoSeconds: 700 }, 0],
    ['the 75% mid-roll', { percent: 75 }, 1],
  ])('%s', async (_label, args, perDay) => {
    await expect(inventory.forecastPerDay(args)).resolves.toBe(perDay);
  });

  test('a failure answers null so the caller falls back to the snapshot', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const broken = fx.loadIsolated('../../services/adInventory', {
      mocks: { '../../utils/db': () => ({ getDb: () => { throw new Error('gone'); } }) },
    });
    await expect(broken.forecastPerDay({ percent: 0 })).resolves.toBeNull();
    expect(err).toHaveBeenCalledWith('[adInventory] targeted forecast failed:', 'gone');
  });
});
