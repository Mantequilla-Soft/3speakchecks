/**
 * utils/adModel.js (and utils/adCreativeKinds.js): the booking side's shared shape.
 * Price, flight window and slot arithmetic are pure; servableReason is the one
 * answer to "why is my campaign not running"; creativesByCampaign and the index
 * set-up run against the real test database.
 */
const fx = require('./_fixtures');

fx.useAdEnv();
const testDb = require('../helpers/db');
const model = require('../../utils/adModel');
const { CREATIVE_KINDS } = require('../../utils/adCreativeKinds');
const { AD_LENGTH_SECONDS, AD_DAY_CURVE_K, AD_IMPRESSIONS_COLLECTION, AD_CREATIVES_COLLECTION } = require('../../utils/config');
const { defaultRateFor } = require('../../utils/adFormats');

const {
  STATES, CREATIVE_STATES, priceForDays, ratePerDayFor, validDayCount, windowFrom, slotSecondsFor,
  missingAssetFor, isMotionBanner, servableReason, creativesByCampaign, productionFeeFor, DAY_MS,
} = model;

const db = testDb.use();
// Frozen before the tables below are built, and back at the same instant for every test.
fx.freezeTime();
beforeEach(() => jest.setSystemTime(fx.NOW));

describe('creative kinds', () => {
  test('are a frozen enum, and adModel re-exports the very same object', () => {
    expect(CREATIVE_KINDS).toEqual({ VIDEO: 'video', IMAGE: 'image', TEXT: 'text', AUDIO: 'audio' });
    expect(Object.isFrozen(CREATIVE_KINDS)).toBe(true);
    expect(model.CREATIVE_KINDS).toBe(CREATIVE_KINDS);
  });
});

describe('priceForDays: what a flight costs', () => {
  test('one day is rate x seconds, untouched by the day curve', () => {
    expect(priceForDays(1, 0.5, 10)).toBe(5);
  });

  test('longer flights follow days^K, so each extra day costs a little less', () => {
    const seven = priceForDays(7, 0.5, 10);
    expect(seven).toBeCloseTo(Math.round(7 ** AD_DAY_CURVE_K * 5 * 1000) / 1000, 3);
    expect(seven).toBeLessThan(7 * priceForDays(1, 0.5, 10));
    expect(seven).toBeGreaterThan(priceForDays(1, 0.5, 10));
    expect(priceForDays(30, 0.5, 10) / 30).toBeLessThan(seven / 7);
  });

  test('doubling the spot doubles the price at any flight length', () => {
    for (const days of [1, 7, 30]) {
      expect(priceForDays(days, 0.5, 20)).toBeCloseTo(2 * priceForDays(days, 0.5, 10), 2);
    }
  });

  test.each([[0], [null], ['abc'], [-3]])('a nonsensical rate (%p) falls back to the platform roll rate', (rate) => {
    expect(priceForDays(1, rate, 10)).toBe(Math.round(defaultRateFor('video_roll') * 10 * 1000) / 1000);
  });

  test.each([[0], [undefined], [-1], ['x']])('a nonsensical length (%p) bills the full slot, never zero', (secs) => {
    expect(priceForDays(1, 1, secs)).toBe(AD_LENGTH_SECONDS);
  });

  test.each([[0], [-2], [NaN], ['soon']])('a nonsensical day count (%p) prices at zero rather than throwing', (days) => {
    expect(priceForDays(days, 1, 10)).toBe(0);
  });

  test('is rounded to three decimals (HBD has three)', () => {
    expect(String(priceForDays(3, 0.123456, 7)).split('.')[1].length).toBeLessThanOrEqual(3);
  });
});

describe('ratePerDayFor: an advertiser\'s negotiated roll rate', () => {
  test.each([
    ['the admin-set per-second rate', { pricePerSecondDayHbd: 0.4 }, 0.4],
    ['the legacy flat field, still honoured', { pricePerDayHbd: 0.9 }, 0.9],
    ['the newer field over the legacy one', { pricePerSecondDayHbd: 0.4, pricePerDayHbd: 0.9 }, 0.4],
  ])('reads %s', (_label, adv, want) => {
    expect(ratePerDayFor(adv)).toBe(want);
  });

  test.each([[null], [{}], [{ pricePerSecondDayHbd: 0 }], [{ pricePerSecondDayHbd: 'cheap' }]])(
    'falls back to the platform rate for %p, never to a free flight',
    (adv) => expect(ratePerDayFor(adv)).toBe(defaultRateFor('video_roll')),
  );
});

describe('validDayCount', () => {
  test.each([
    [1, true], [7, true], [90, true],
    [0, false], [91, false], [2.5, false], ['7', false], [NaN, false],
  ])('%p days -> %p', (days, ok) => expect(validDayCount(days)).toBe(ok));
});

describe('windowFrom: when a paid flight runs', () => {
  test('starts now when no start was asked for', () => {
    const w = windowFrom(null, 3);
    expect(w.startAt.getTime()).toBe(Date.now());
    expect(w.endAt.getTime() - w.startAt.getTime()).toBe(3 * DAY_MS);
  });

  test('starts at the requested date when that is later than now', () => {
    const later = fx.fromNow(2 * fx.DAY);
    expect(windowFrom(later, 1).startAt).toEqual(later);
  });

  test('a requested date already passed is clamped to now, so paying late never burns the flight', () => {
    expect(windowFrom(fx.ago(5 * fx.DAY), 1).startAt.getTime()).toBe(Date.now());
  });
});

describe('slotSecondsFor: where a break lands in a video', () => {
  test.each([
    ['0% is the very start', { slotPercent: 0 }, 300, 0],
    ['25% of five minutes', { slotPercent: 25 }, 300, 75],
    ['rounds to the nearest second', { slotPercent: 10 }, 125, 13],
    ['a percent without a known length lands at 0', { slotPercent: 50 }, 0, 0],
    ['a percent against garbage length lands at 0', { slotPercent: 50 }, 'long', 0],
    ['legacy bookings in absolute seconds are read as seconds', { slotPosition: 30 }, 300, 30],
    ['a negative legacy position is clamped to 0', { slotPosition: -5 }, 300, 0],
    ['nothing booked means the start', null, 300, 0],
  ])('%s', (_label, slot, total, want) => {
    expect(slotSecondsFor(slot, total)).toBe(want);
  });
});

describe('missingAssetFor: what a creative must carry before it can serve', () => {
  test.each([
    ['no creative', null, 'no_creative'],
    ['a still with its image', { kind: 'image', imageUrl: 'https://x/y.png' }, null],
    ['a still without one', { kind: 'image' }, 'creative_has_no_image'],
    ['a ticker with text and link', { kind: 'text', message: 'Hi', clickUrl: 'https://x' }, null],
    ['a ticker without a link', { kind: 'text', message: 'Hi' }, 'creative_has_no_message'],
    ['an audio spot with its file', { kind: 'audio', audioFile: 'a.mp3' }, null],
    ['an audio spot without one', { kind: 'audio' }, 'creative_has_no_audio'],
    ['an encoded video (CID)', { kind: 'video', manifestCid: 'Qm1' }, null],
    ['a legacy encoded video (url)', { manifestUrl: 'https://g/ipfs/Qm1/manifest.m3u8' }, null],
    ['a video still encoding', { kind: 'video' }, 'creative_not_encoded'],
  ])('%s', (_label, cr, want) => expect(missingAssetFor(cr)).toBe(want));
});

describe('isMotionBanner', () => {
  test.each([
    ['a video on a banner flight', { format: 'video_banner' }, { kind: 'video' }, true],
    ['a legacy video (no kind) on a banner flight', { format: 'video_banner' }, {}, true],
    ['a still on a banner flight', { format: 'video_banner' }, { kind: 'image' }, false],
    ['a video on a roll', { format: 'video_roll' }, { kind: 'video' }, false],
    ['no creative', { format: 'video_banner' }, null, false],
    ['no campaign', null, { kind: 'video' }, false],
  ])('%s -> %p', (_label, c, cr, want) => expect(isMotionBanner(c, cr)).toBe(want));
});

describe('servableReason: the one answer to "why is my campaign not running"', () => {
  const running = (over = {}) => ({
    status: STATES.RUNNING, paidHbd: 5, startAt: fx.ago(fx.HOUR), endAt: fx.fromNow(fx.DAY), ...over,
  });
  const readyVideo = { kind: 'video', status: CREATIVE_STATES.READY, manifestCid: 'Qm1' };

  test('a paid, running roll with an approved encoded spot serves', () => {
    expect(servableReason(running(), readyVideo)).toBeNull();
  });

  test.each([
    ['no campaign at all', null, readyVideo, 'no_campaign'],
    ['paused', running({ status: STATES.PAUSED }), readyVideo, 'paused'],
    ['cancelled', running({ status: STATES.CANCELLED }), readyVideo, 'cancelled'],
    ['complete', running({ status: STATES.COMPLETE }), readyVideo, 'complete'],
    ['still a draft', running({ status: STATES.DRAFT }), readyVideo, 'not_submitted'],
    ['unpaid', running({ paidHbd: 0 }), readyVideo, 'unpaid'],
    ['no creative attached', running(), null, 'no_creative'],
    ['a ticker message on a roll', running(), { kind: 'text', status: 'ready' }, 'creative_is_a_ticker'],
    ['an audio clip on a roll', running(), { kind: 'audio', status: 'ready' }, 'creative_is_audio'],
    ['a still on a roll', running(), { kind: 'image', status: 'ready', imageUrl: 'https://x' }, 'creative_is_an_image'],
    ['a video on a ticker flight', running({ format: 'video_ticker' }), readyVideo, 'creative_is_a_video'],
    ['a spot still in review', running(), { ...readyVideo, status: 'review' }, 'creative_review'],
    ['a rejected spot', running(), { ...readyVideo, status: 'rejected' }, 'creative_rejected'],
    ['an approved spot that never encoded', running(), { kind: 'video', status: 'ready' }, 'creative_not_encoded'],
    ['a flight that has not started', running({ startAt: fx.fromNow(fx.HOUR) }), readyVideo, 'not_started'],
    ['a flight that has ended', running({ endAt: fx.ago(1) }), readyVideo, 'ended'],
  ])('%s -> %s', (_label, c, cr, want) => {
    expect(servableReason(c, cr)).toBe(want);
  });

  test('a flight ends exactly at endAt, not a millisecond later', () => {
    const c = running({ endAt: new Date(Date.now()) });
    expect(servableReason(c, readyVideo)).toBe('ended');
  });

  test('a legacy creative with no kind is a video, exactly as the console shows it', () => {
    expect(servableReason(running(), { status: 'ready', manifestCid: 'Qm1' })).toBeNull();
  });

  test('a banner flight accepts a still and a video alike', () => {
    const banner = running({ format: 'video_banner' });
    expect(servableReason(banner, { kind: 'image', status: 'ready', imageUrl: 'https://x/b.png' })).toBeNull();
    expect(servableReason(banner, readyVideo)).toBeNull();
  });
});

describe('productionFeeFor: "have us make the ad"', () => {
  test.each([
    ['a static banner is a flat fee', 'static_banner', 'video_banner', 20, 5],
    ['an animated banner is per started 5 seconds', 'animated_banner', 'video_banner', 12, 30],
    ['an AI commercial for a roll', 'ai_commercial', 'video_roll', 15, 75],
    ['a human commercial for a shorts spot', 'human_commercial', 'shorts_roll', 6, 80],
    ['a missing length bills the full slot', 'ai_commercial', 'upload_gate', undefined, Math.ceil(AD_LENGTH_SECONDS / 5) * 25],
  ])('%s', (_label, tier, format, secs, want) => {
    expect(productionFeeFor(tier, format, secs)).toBe(want);
  });

  test.each([
    ['an unknown tier', 'golden_commercial', 'video_roll'],
    ['a tier that cannot be made for the format', 'static_banner', 'video_roll'],
    ['anything for a ticker', 'ai_commercial', 'video_ticker'],
  ])('%s is refused with null', (_label, tier, format) => {
    expect(productionFeeFor(tier, format, 10)).toBeNull();
  });
});

describe('creativesByCampaign: the link points campaign -> creative', () => {
  test('one creative can serve several flights, and only approved ones are returned for serving', async () => {
    const shared = fx.videoCreative({ status: 'ready' });
    const inReview = fx.videoCreative({ status: 'review' });
    const a = fx.campaign({ creativeEmbedId: shared.embedId });
    const b = fx.campaign({ creativeEmbedId: shared.embedId });
    const c = fx.campaign({ creativeEmbedId: inReview.embedId });
    const none = fx.campaign({ creativeEmbedId: null });
    await fx.seed(db(), { creatives: [shared, inReview] });

    const serving = await creativesByCampaign(db(), [a, b, c, none]);
    expect(serving.get(String(a._id)).embedId).toBe(shared.embedId);
    expect(serving.get(String(b._id)).embedId).toBe(shared.embedId);
    expect(serving.has(String(c._id))).toBe(false);
    expect(serving.has(String(none._id))).toBe(false);

    const listing = await creativesByCampaign(db(), [c], { readyOnly: false });
    expect(listing.get(String(c._id)).status).toBe('review');
  });

  test('no campaigns, or none with a creative, is an empty map without a query', async () => {
    const spy = jest.spyOn(db(), 'collection');
    expect((await creativesByCampaign(db(), [])).size).toBe(0);
    expect((await creativesByCampaign(db(), null)).size).toBe(0);
    expect((await creativesByCampaign(db(), [fx.campaign({ creativeEmbedId: null })])).size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('ensureAdIndexes', () => {
  const fresh = (getDb) => fx.loadIsolated('../../utils/adModel', { mocks: { '../../utils/db': () => ({ getDb }) } });

  test('replaces the old sid-only unique index, so a roll and a banner in one playback both count', async () => {
    await db().collection(AD_IMPRESSIONS_COLLECTION).createIndex({ sid: 1 }, { unique: true, name: 'sid_1' });
    await fresh(() => db()).ensureAdIndexes();

    const ix = await db().collection(AD_IMPRESSIONS_COLLECTION).indexes();
    const sidOnly = ix.find((i) => i.name === 'sid_1');
    expect(sidOnly && sidOnly.unique).toBeFalsy();
    expect(ix.some((i) => i.unique && JSON.stringify(i.key) === JSON.stringify({ sid: 1, campaignId: 1 }))).toBe(true);
    const creativeIx = await db().collection(AD_CREATIVES_COLLECTION).indexes();
    expect(creativeIx.some((i) => i.unique && i.key.embedId === 1)).toBe(true);

    await db().collection(AD_IMPRESSIONS_COLLECTION).insertOne({ sid: 's1', campaignId: 'roll' });
    await db().collection(AD_IMPRESSIONS_COLLECTION).insertOne({ sid: 's1', campaignId: 'banner' });
    await expect(db().collection(AD_IMPRESSIONS_COLLECTION).insertOne({ sid: 's1', campaignId: 'roll' }))
      .rejects.toMatchObject({ code: 11000 });
  });

  test('runs once per process, and a failure is logged and retried on the next call', async () => {
    let fail = true;
    const getDb = jest.fn(() => {
      if (fail) throw new Error('mongo is down');
      return db();
    });
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const mod = fresh(getDb);

    await mod.ensureAdIndexes();
    expect(err).toHaveBeenCalledWith('[ad-model] index ensure failed:', 'mongo is down');

    fail = false;
    await mod.ensureAdIndexes();
    const calls = getDb.mock.calls.length;
    await mod.ensureAdIndexes();
    expect(getDb.mock.calls.length).toBe(calls);
  });
});
