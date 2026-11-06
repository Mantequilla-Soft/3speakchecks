/**
 * utils/adSlots.js: how many advertisers already hold a position over a window.
 * A position carries up to AD_SLOT_MAX_SHARES flights; an unpaid booking holds its
 * place provisionally for AD_SLOT_HOLD_HOURS, and only once its advertiser has been
 * approved. Formats never compete with each other for the same moment.
 */
const fx = require('./_fixtures');

fx.useAdEnv();
const testDb = require('../helpers/db');
const { effectiveWindow, slotHolders, findSlotConflict, slotAvailability, HOLDING } = require('../../utils/adSlots');
const { AD_SLOT_HOLD_HOURS, AD_SLOT_MAX_SHARES, AD_SLOT_PERCENTS } = require('../../utils/config');

const db = testDb.use();
fx.freezeTime();
beforeEach(() => jest.setSystemTime(fx.NOW));

const { DAY, HOUR } = fx;
const flightWindow = (days = 7) => ({ start: Date.now(), end: Date.now() + days * DAY });

/** A paid flight on `slotPercent` running from now for `days`. */
const paid = (slotPercent, over = {}) => fx.campaign({
  slotPercent, status: 'running', startAt: new Date(Date.now()), endAt: fx.fromNow(7 * DAY), ...over,
});

describe('effectiveWindow', () => {
  test.each(['complete', 'cancelled', 'rejected'])('a %s campaign holds nothing', (status) => {
    expect(effectiveWindow(fx.campaign({ status }))).toBeNull();
  });

  test('no campaign holds nothing', () => expect(effectiveWindow(null)).toBeNull());

  test('a paid flight holds its real window', () => {
    const c = paid(10);
    expect(effectiveWindow(c)).toEqual({ start: c.startAt.getTime(), end: c.endAt.getTime(), provisional: false });
  });

  test('an unpaid booking holds the window it would get if it paid now', () => {
    const c = fx.campaign({ status: 'awaiting_payment', startAt: null, endAt: null, days: 3, createdAt: fx.ago(HOUR) });
    expect(effectiveWindow(c)).toEqual({ start: Date.now(), end: Date.now() + 3 * DAY, provisional: true });
  });

  test('an unpaid booking with a later requested start is held from that start', () => {
    const start = fx.fromNow(2 * DAY);
    const c = fx.campaign({ status: 'awaiting_payment', startAt: null, endAt: null, days: 1, createdAt: fx.ago(HOUR), requestedStartAt: start });
    expect(effectiveWindow(c).start).toBe(start.getTime());
  });

  test('the provisional hold lapses after AD_SLOT_HOLD_HOURS, so an abandoned booking frees the slot', () => {
    const c = fx.campaign({ status: 'awaiting_payment', startAt: null, endAt: null, days: 3 });
    c.createdAt = fx.ago(AD_SLOT_HOLD_HOURS * HOUR - 1);
    expect(effectiveWindow(c)).not.toBeNull();
    c.createdAt = fx.ago(AD_SLOT_HOLD_HOURS * HOUR + 1);
    expect(effectiveWindow(c)).toBeNull();
  });

  test('an unpaid booking with no day count, or no booking date, holds nothing', () => {
    expect(effectiveWindow(fx.campaign({ status: 'draft', startAt: null, endAt: null, days: 0 }))).toBeNull();
    expect(effectiveWindow(fx.campaign({ status: 'draft', startAt: null, endAt: null, days: 2, createdAt: null }))).toBeNull();
  });

  test('every live state holds a slot', () => {
    expect(HOLDING).toEqual(['draft', 'awaiting_payment', 'scheduled', 'running', 'paused']);
  });
});

describe('slotHolders', () => {
  test('counts the paid flights that overlap, and reports when the earliest of them ends', async () => {
    const early = paid(25, { endAt: fx.fromNow(2 * DAY) });
    const late = paid(25, { endAt: fx.fromNow(5 * DAY) });
    const otherSlot = paid(50);
    const before = paid(25, { startAt: fx.ago(10 * DAY), endAt: fx.ago(DAY) });
    await fx.seed(db(), { campaigns: [early, late, otherSlot, before] });

    const out = await slotHolders(db(), { slotPercent: 25, ...flightWindow() });
    expect(out.holders).toBe(2);
    expect(out.freeFrom).toEqual(early.endAt);
  });

  test('never counts the campaign being re-quoted', async () => {
    const self = paid(10);
    await fx.seed(db(), { campaigns: [self] });
    expect((await slotHolders(db(), { slotPercent: 10, ...flightWindow(), excludeId: self._id })).holders).toBe(0);
  });

  test('a banner at 25% does not consume the roll at 25%', async () => {
    await fx.seed(db(), { campaigns: [paid(25, { format: 'video_banner' }), paid(25)] });
    expect((await slotHolders(db(), { slotPercent: 25, ...flightWindow(), format: 'video_roll' })).holders).toBe(1);
    expect((await slotHolders(db(), { slotPercent: 25, ...flightWindow(), format: 'video_banner' })).holders).toBe(1);
    expect((await slotHolders(db(), { slotPercent: 25, ...flightWindow() })).holders).toBe(2);
  });

  test('a provisional hold counts only when its advertiser has been approved', async () => {
    const approved = fx.advertiser({ status: 'approved' });
    const pending = fx.advertiser({ status: 'pending' });
    const unpaid = (adv) => fx.campaign({
      advertiserRef: adv.reference, slotPercent: 75, status: 'awaiting_payment', startAt: null, endAt: null, days: 3, createdAt: fx.ago(HOUR),
    });
    await fx.seed(db(), { advertisers: [approved, pending], campaigns: [unpaid(approved), unpaid(pending)] });
    expect((await slotHolders(db(), { slotPercent: 75, ...flightWindow() })).holders).toBe(1);
  });

  // BUG (utils/adSlots.js slotHolders, both `effectiveWindow(c, now).provisional` reads):
  // effectiveWindow() returns null for an unpaid booking whose AD_SLOT_HOLD_HOURS hold has
  // lapsed, and the result is dereferenced without a check. Nothing cancels an abandoned
  // booking before AD_BOOKING_EXPIRY_DAYS, so from 24 hours after one is made the
  // query throws a TypeError for that position: GET /advertise/slots and every booking
  // at that position (POST /campaigns, /selfpromo/book) answer 500 until it is removed.
  test('BUG: an abandoned booking whose hold has lapsed frees its position instead of breaking the query', async () => {
    await fx.seed(db(), { campaigns: [fx.campaign({
      slotPercent: 10, status: 'awaiting_payment', startAt: null, endAt: null, days: 3, createdAt: fx.ago(AD_SLOT_HOLD_HOURS * HOUR + 1),
    })] });
    await expect(slotHolders(db(), { slotPercent: 10, ...flightWindow() })).resolves.toEqual({ holders: 0, freeFrom: null });
  });

  test('no position asked about means nothing held', async () => {
    expect(await slotHolders(db(), { slotPercent: null, ...flightWindow() })).toEqual({ holders: 0, freeFrom: null });
  });
});

describe('findSlotConflict and slotAvailability', () => {
  test(`a position takes ${AD_SLOT_MAX_SHARES} advertisers, then is full until the first one finishes`, async () => {
    const holders = Array.from({ length: AD_SLOT_MAX_SHARES }, (_, i) => paid(10, { endAt: fx.fromNow((i + 2) * DAY) }));
    await fx.seed(db(), { campaigns: holders.slice(0, -1) });
    expect(await findSlotConflict(db(), { slotPercent: 10, ...flightWindow() })).toBeNull();

    await fx.seed(db(), { campaigns: holders.slice(-1) });
    expect(await findSlotConflict(db(), { slotPercent: 10, ...flightWindow() }))
      .toEqual({ holders: AD_SLOT_MAX_SHARES, maxShares: AD_SLOT_MAX_SHARES, freeFrom: holders[0].endAt });
  });

  test('availability lists every position with the shares taken, and when a full one frees up', async () => {
    const full = Array.from({ length: AD_SLOT_MAX_SHARES }, () => paid(50));
    await fx.seed(db(), { campaigns: [...full, paid(0)] });

    const slots = await slotAvailability(db(), flightWindow());
    expect(slots.map((s) => s.percent)).toEqual(AD_SLOT_PERCENTS);
    expect(slots.find((s) => s.percent === 0)).toMatchObject({ available: true, sharesTaken: 1, sharesLeft: AD_SLOT_MAX_SHARES - 1, freeFrom: null });
    expect(slots.find((s) => s.percent === 50)).toMatchObject({ available: false, sharesTaken: AD_SLOT_MAX_SHARES, sharesLeft: 0, freeFrom: full[0].endAt });
    expect(slots.find((s) => s.percent === 75)).toMatchObject({ available: true, sharesTaken: 0, sharesTotal: AD_SLOT_MAX_SHARES });
    // Who holds a position is never part of the answer.
    expect(JSON.stringify(slots)).not.toMatch(/advertiserRef|_id/);
  });

  test('a window after every holder has finished is free again', async () => {
    await fx.seed(db(), { campaigns: Array.from({ length: AD_SLOT_MAX_SHARES }, () => paid(25)) });
    const later = { start: Date.now() + 8 * DAY, end: Date.now() + 9 * DAY };
    expect(await findSlotConflict(db(), { slotPercent: 25, ...later })).toBeNull();
  });
});
