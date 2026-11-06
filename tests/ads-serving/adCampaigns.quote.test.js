/**
 * routes/adCampaigns.js, before anything is booked: the rate card a visitor or an
 * advertiser is quoted (/pricing), which positions are still for sale (/slots), and
 * the plays a booking would be forecast (/forecast), which is the same number a
 * shortfall is later measured against.
 */
const request = require('supertest');
const fx = require('./_fixtures');

fx.useAdEnv({ ADS_STAGE: 'public', ADS_BETA_USERS: 'meno' });
jest.mock('../../services/adPaymentClaim', () => ({ claimCampaignPayment: jest.fn(), getHbdPerHive: jest.fn() }));
const { getHbdPerHive } = require('../../services/adPaymentClaim');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const adSettings = require('../../utils/adSettings');
const { defaultRateFor } = require('../../utils/adFormats');
const config = require('../../utils/config');

const app = buildApp(['/advertise', require('../../routes/adCampaigns')]);
const db = testDb.use();
fx.freezeTime();
beforeEach(async () => {
  jest.setSystemTime(fx.NOW);
  getHbdPerHive.mockReset();
  getHbdPerHive.mockResolvedValue(0.25);
  await adSettings.refresh();
});

const get = (path) => request(app).get(path);

describe('GET /advertise/pricing', () => {
  test('the public card lists every public product at the platform rate, and may be cached', async () => {
    const res = await get('/advertise/pricing').expect(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.body).toMatchObject({
      success: true,
      payTo: config.AD_PAYMENT_ACCOUNT,
      pricePerSecondDayHbd: defaultRateFor('video_roll'),
      rateIsCustom: false,
      minDays: 1,
      maxDays: 90,
      slotPercents: [0, 10, 25, 50, 75],
      maxCreativeSeconds: config.AD_LENGTH_SECONDS,
      slotHoldHours: config.AD_SLOT_HOLD_HOURS,
      dayCurveK: config.AD_DAY_CURVE_K,
      hbdPerHive: 0.25,
      model: 'flat',
    });
    expect(res.body.formats.map((f) => f.key)).not.toContain('audio_spot');
    expect(res.body.productionTiers.map((t) => t.key)).toEqual(['static_banner', 'animated_banner', 'ai_commercial', 'human_commercial']);
    expect(res.body.note).toMatch(new RegExp(`up to ${config.AD_SLOT_MAX_SHARES} advertisers`));
  });

  test('with a reference it quotes that advertiser\'s own deal, and is never cached', async () => {
    const adv = fx.advertiser({ status: 'pending', rates: { video_roll: 0.05 } });
    await fx.seed(db(), { advertisers: [adv] });
    const res = await get(`/advertise/pricing?reference=${adv.reference}`).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ pricePerSecondDayHbd: 0.05, rateIsCustom: true });
    expect(res.body.formats.find((f) => f.key === 'video_roll')).toMatchObject({ ratePerSecondDayHbd: 0.05, rateIsCustom: true });
  });

  test('a rejected advertiser\'s reference gets the public price', async () => {
    const adv = fx.advertiser({ status: 'rejected', rates: { video_roll: 0.05 } });
    await fx.seed(db(), { advertisers: [adv] });
    expect((await get(`/advertise/pricing?reference=${adv.reference}`)).body.rateIsCustom).toBe(false);
  });

  test('?beta=1 also shows the formats still in beta, uncached', async () => {
    const res = await get('/advertise/pricing?beta=1').expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.formats.find((f) => f.key === 'audio_spot')).toMatchObject({ beta: true });
  });

  test('a stored platform rate is what the next visitor is quoted', async () => {
    await adSettings.setRate('video_roll', 0.31);
    expect((await get('/advertise/pricing')).body.pricePerSecondDayHbd).toBe(0.31);
  });

  test('an unreadable HIVE price is quoted as 0 rather than failing the page', async () => {
    getHbdPerHive.mockRejectedValue(new Error('nodes down'));
    expect((await get('/advertise/pricing').expect(200)).body.hbdPerHive).toBe(0);
  });
});

describe('GET /advertise/slots', () => {
  test('lists every position for the window asked about, never cached', async () => {
    const res = await get('/advertise/slots?days=3').expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.startAt).toBe(fx.NOW.toISOString());
    expect(res.body.endAt).toBe(new Date(fx.NOW.getTime() + 3 * fx.DAY).toISOString());
    expect(res.body.slots).toHaveLength(5);
    expect(res.body.slots.every((s) => s.available && s.sharesTaken === 0)).toBe(true);
  });

  test('availability is per format: a full roll position is still open for a banner', async () => {
    await fx.seed(db(), { campaigns: Array.from({ length: config.AD_SLOT_MAX_SHARES }, () => fx.campaign({ slotPercent: 25, startAt: new Date(fx.NOW), endAt: fx.fromNow(10 * fx.DAY) })) });
    const roll = await get('/advertise/slots?days=3').expect(200);
    expect(roll.body.slots.find((s) => s.percent === 25)).toMatchObject({ available: false, sharesLeft: 0 });
    const banner = await get('/advertise/slots?days=3&format=video_banner').expect(200);
    expect(banner.body.slots.find((s) => s.percent === 25).available).toBe(true);
  });

  test('a later start moves the window', async () => {
    const res = await get(`/advertise/slots?days=1&startAt=${fx.fromNow(5 * fx.DAY).toISOString()}`).expect(200);
    expect(res.body.startAt).toBe(fx.fromNow(5 * fx.DAY).toISOString());
  });

  // BUG: see the lapsed-hold test in adSlots.test.js. One abandoned booking older than
  // AD_SLOT_HOLD_HOURS takes the whole availability list down with a 500.
  test('BUG: an abandoned booking older than its hold does not take /slots down', async () => {
    await fx.seed(db(), { campaigns: [fx.campaign({ slotPercent: 50, status: 'awaiting_payment', startAt: null, endAt: null, days: 2, createdAt: fx.ago(2 * fx.DAY) })] });
    const res = await get('/advertise/slots?days=3');
    expect(res.status).toBe(200);
    expect(res.body.slots.find((s) => s.percent === 50).available).toBe(true);
  });

  test.each([['0'], ['91'], ['2.5'], ['']])('days=%p is a 400', async (days) => {
    expect((await get(`/advertise/slots?days=${days}`).expect(400)).body.error).toMatch(/between 1 and 90/);
  });
});

describe('GET /advertise/forecast', () => {
  const snapshot = (over = {}) => db().collection(config.AD_INVENTORY_COLLECTION).insertOne({
    _id: 'current',
    slots: [{ percent: 0, perDay: 10 }, { percent: 25, perDay: 4 }],
    rollSlots: [{ percent: 0, perDay: 8 }, { percent: 25, perDay: 3 }],
    ...over,
  });

  test('a roll is quoted from the pool without the overlay-only creators', async () => {
    await snapshot();
    const res = await get('/advertise/forecast?days=7&slotPercent=0').expect(200);
    expect(res.body).toEqual({ success: true, forecast: 56, days: 7, sharedWith: 0 });
  });

  test('a banner is quoted from the whole pool', async () => {
    await snapshot();
    expect((await get('/advertise/forecast?format=video_banner&days=7&slotPercent=25')).body.forecast).toBe(28);
  });

  test('a position already carrying an advertiser is quoted its share', async () => {
    await snapshot();
    await fx.seed(db(), { campaigns: [fx.campaign({ format: 'video_banner', slotPercent: 25, startAt: new Date(fx.NOW), endAt: fx.fromNow(30 * fx.DAY) })] });
    const res = await get('/advertise/forecast?format=video_banner&days=7&slotPercent=25').expect(200);
    expect(res.body).toMatchObject({ forecast: 14, sharedWith: 1 });
  });

  test('length targeting measures the inventory actually bought, and the answer is cached for ten minutes', async () => {
    const watchRow = (videoDuration) => ({ owner: 'c', permlink: `v${videoDuration}`, updatedAt: fx.ago(fx.HOUR), videoDuration, contentSeconds: 60, maxPosition: 60 });
    await db().collection('view-durations').insertMany(Array.from({ length: 30 }, () => watchRow(600)));
    const ask = () => get('/advertise/forecast?format=video_banner&days=10&slotPercent=0&minVideoSeconds=300');
    expect((await ask().expect(200)).body.forecast).toBe(10);

    await db().collection('view-durations').insertMany(Array.from({ length: 30 }, () => watchRow(900)));
    expect((await ask()).body.forecast).toBe(10);
    fx.advance(10 * fx.MIN + 1);
    expect((await ask()).body.forecast).toBe(20);
  });

  test('the pre-upload spot is not sold against plays, so it has no forecast', async () => {
    await snapshot();
    expect((await get('/advertise/forecast?format=upload_gate&days=7').expect(200)).body).toMatchObject({ forecast: null, sharedWith: 0 });
  });

  test('with no inventory run yet the forecast is null, not invented', async () => {
    expect((await get('/advertise/forecast?days=7&slotPercent=0').expect(200)).body.forecast).toBeNull();
  });

  test('an unreadable start is quoted as "as soon as approved"', async () => {
    await snapshot();
    expect((await get('/advertise/forecast?days=1&slotPercent=0&startAt=garbage').expect(200)).body.forecast).toBe(8);
  });

  test.each([
    ['an unknown format', 'format=hologram&days=7&slotPercent=0', /format must be one of/],
    ['a day count out of range', 'days=0&slotPercent=0', /days must be/],
    ['a position nobody sells', 'days=7&slotPercent=33', /slotPercent must be one of: 0, 10, 25, 50, 75/],
  ])('refuses %s', async (_label, q, error) => {
    expect((await get(`/advertise/forecast?${q}`).expect(400)).body.error).toMatch(error);
  });
});

describe('when the feature is switched off', () => {
  test.each([['/advertise/pricing'], ['/advertise/slots?days=1'], ['/advertise/forecast?days=1']])('%s is a 404', async (path) => {
    const off = buildApp(['/advertise', fx.isolatedModule('../../routes/adCampaigns', { ADS_STAGE: 'off' })]);
    await request(off).get(path).expect(404, { success: false, error: 'Not found' });
  });
});

describe('a database failure is a 500 that says nothing about why', () => {
  test.each([['/advertise/pricing?reference=r'], ['/advertise/slots?days=1']])('%s', async (path) => {
    fx.databaseFails();
    await get(path).expect(500, { success: false, error: 'Internal server error' });
  });
});
