/**
 * utils/adFormats.js: the format registry and the rate card, with the platform
 * defaults coming from utils/adSettings.js. Ported from scripts/test-ad-rates.cjs:
 * a stored platform rate moves new bookings, a negotiated rate beats it, an early
 * advertiser keeps the card they registered on, and a bad number never becomes a
 * free flight.
 */
const fx = require('./_fixtures');

fx.useAdEnv({ ADS_BETA_USERS: 'betauser,meno' });
const testDb = require('../helpers/db');
const formats = require('../../utils/adFormats');
const adSettings = require('../../utils/adSettings');
const { priceForDays, ratePerDayFor } = require('../../utils/adModel');
const config = require('../../utils/config');

const {
  FORMATS, FORMAT_KEYS, DEFAULT_FORMAT, formatOf, payoutPoolOf, activePools, isBookableFormat, rateFor,
  defaultRateFor, snapshotRates, rateCard, creativeSpecError, acceptedKinds, formatAccepts, bookableBy,
  tickerMinSeconds, tickerWords,
} = formats;

const db = testDb.use();
fx.freezeTime();
// The stored rate card is cached in-process: start every test from an empty one.
beforeEach(() => adSettings.refresh());

const built = (key) => FORMATS[key].ratePerSecondDayHbd;
const round3 = (n) => Math.round(n * 1000) / 1000;

describe('the format registry', () => {
  test('every bookable product is listed, and a missing or unknown format reads as the video roll', () => {
    expect(FORMAT_KEYS).toEqual(['video_roll', 'video_banner', 'upload_gate', 'shorts_roll', 'video_ticker', 'audio_spot']);
    expect(DEFAULT_FORMAT).toBe('video_roll');
    expect(formatOf({}).key).toBe('video_roll');
    expect(formatOf(null).key).toBe('video_roll');
    expect(formatOf({ format: 'hologram' }).key).toBe('video_roll');
    expect(formatOf({ format: ' video_banner ' }).key).toBe('video_banner');
  });

  test.each([
    ['video_roll', ['video']],
    ['video_banner', ['image', 'video']],
    ['shorts_roll', ['video']],
    ['video_ticker', ['text']],
    ['audio_spot', ['audio']],
  ])('%s accepts %p', (key, kinds) => {
    expect(acceptedKinds(FORMATS[key])).toEqual(kinds);
    for (const k of ['video', 'image', 'text', 'audio']) expect(formatAccepts(FORMATS[key], k)).toBe(kinds.includes(k));
  });

  test('no format means no kinds', () => {
    expect(acceptedKinds(null)).toEqual([]);
  });

  test('each format pays into its own pool, and the active pools are listed once each', () => {
    expect(payoutPoolOf({ format: 'upload_gate' })).toBe('upload');
    expect(payoutPoolOf({ format: 'shorts_roll' })).toBe('shorts');
    expect(payoutPoolOf({})).toBe('watch');
    expect(activePools().sort()).toEqual(['shorts', 'upload', 'watch']);
  });

  test.each([['video_ticker', true], ['audio_spot', true], ['nope', false], ['', false], [undefined, false]])(
    'isBookableFormat(%p) is %p', (key, ok) => expect(isBookableFormat(key)).toBe(ok),
  );
});

describe('ticker readability', () => {
  test.each([
    ['', 0, config.AD_TICKER_MIN_SECONDS],
    ['   ', 0, config.AD_TICKER_MIN_SECONDS],
    ['Buy now', 2, config.AD_TICKER_MIN_SECONDS],
    ['one two three four five six seven eight nine ten', 10, 9],
    [Array(20).fill('word').join(' '), 20, 14],
  ])('%p has %p words and needs %p seconds', (msg, words, secs) => {
    expect(tickerWords(msg)).toBe(words);
    expect(tickerMinSeconds(msg)).toBe(secs);
  });
});

describe('who may book a beta format', () => {
  test('the audio spot is beta: only beta users may book it', () => {
    expect(FORMATS.audio_spot.beta).toBe(true);
    expect(bookableBy('audio_spot', 'meno')).toBe(true);
    expect(bookableBy('audio_spot', 'MENO')).toBe(true);
    expect(bookableBy('audio_spot', 'stranger')).toBe(false);
  });

  test('a public format is bookable by anyone, an unknown one by nobody', () => {
    expect(bookableBy('video_ticker', 'stranger')).toBe(true);
    expect(bookableBy('video_roll', undefined)).toBe(true);
    expect(bookableBy('hologram', 'meno')).toBe(false);
  });
});

describe('platform rates: built in, then stored (utils/adSettings.js)', () => {
  test('with nothing stored every format is quoted its built-in rate', () => {
    expect(defaultRateFor('video_roll')).toBe(built('video_roll'));
    expect(defaultRateFor('video_banner')).toBe(built('video_banner'));
    expect(priceForDays(7, null, 10)).toBe(priceForDays(7, built('video_roll'), 10));
  });

  test('the ticker is priced as a share of the banner, and the audio spot as a share of the ticker', () => {
    const ticker = round3(built('video_banner') * config.AD_TICKER_RATE_OF_BANNER);
    expect(defaultRateFor('video_ticker')).toBe(ticker);
    expect(defaultRateFor('audio_spot')).toBe(round3(ticker * config.AD_AUDIO_SPOT_RATE_OF_TICKER));
  });

  test('a stored roll rate is what a booking with no deal is quoted, and the price follows it', async () => {
    await adSettings.setRate('video_roll', 3, 'ops');
    expect(defaultRateFor('video_roll')).toBe(3);
    expect(rateFor(null, 'video_roll')).toBe(3);
    expect(ratePerDayFor(null)).toBe(3);
    expect(priceForDays(7, null, 10)).toBe(priceForDays(7, 3, 10));
    // The other formats are untouched.
    expect(defaultRateFor('video_banner')).toBe(built('video_banner'));
  });

  test('a stored banner rate carries the ticker and the audio spot with it', async () => {
    await adSettings.setRate('video_banner', 0.9);
    expect(defaultRateFor('video_ticker')).toBe(round3(0.9 * config.AD_TICKER_RATE_OF_BANNER));
    await adSettings.setRate('video_ticker', 0.2);
    expect(defaultRateFor('video_ticker')).toBe(0.2);
    expect(defaultRateFor('audio_spot')).toBe(round3(0.2 * config.AD_AUDIO_SPOT_RATE_OF_TICKER));
  });

  test('clearing a stored rate falls back to the built-in, and "cleared" means absent, not a copy', async () => {
    await adSettings.setRate('video_roll', 2);
    const after = await adSettings.setRate('video_roll', null);
    expect(defaultRateFor('video_roll')).toBe(built('video_roll'));
    expect('video_roll' in after.formats).toBe(false);
  });

  test.each([[0], [-1], ['free'], [1001], [Infinity]])('a stored %p is never quoted', async (bad) => {
    await db().collection(config.AD_SETTINGS_COLLECTION)
      .updateOne({ _id: 'rates' }, { $set: { 'formats.video_roll': bad } }, { upsert: true });
    await adSettings.refresh();
    expect(defaultRateFor('video_roll')).toBe(built('video_roll'));
  });
});

describe('rateFor: one advertiser\'s price for one format', () => {
  test('a negotiated rate beats the stored platform default, and reads as custom on the card', async () => {
    await adSettings.setRate('video_roll', 3);
    const adv = { rates: { video_roll: 0.4 } };
    expect(rateFor(adv, 'video_roll')).toBe(0.4);
    const roll = rateCard(adv).find((r) => r.key === 'video_roll');
    expect(roll).toMatchObject({ ratePerSecondDayHbd: 0.4, rateIsCustom: true });
    const standard = rateCard(null).find((r) => r.key === 'video_roll');
    expect(standard).toMatchObject({ ratePerSecondDayHbd: 3, rateIsCustom: false });
  });

  test('the legacy per-advertiser field still prices the roll, and only the roll', () => {
    const legacy = { pricePerSecondDayHbd: 0.7 };
    expect(rateFor(legacy, 'video_roll')).toBe(0.7);
    expect(rateFor(legacy, 'video_banner')).toBe(built('video_banner'));
  });

  test.each([[0], ['free'], [-2], [null]])('an advertiser rate of %p is ignored', (bad) => {
    expect(rateFor({ rates: { video_roll: bad } }, 'video_roll')).toBe(built('video_roll'));
  });

  test('an unknown format is priced as the roll', () => {
    expect(rateFor(null, 'hologram')).toBe(defaultRateFor('video_roll'));
  });
});

describe('the founding discount: an advertiser keeps the card they registered on', () => {
  test('raising the platform rate moves new advertisers and leaves the early one where they were', async () => {
    await adSettings.setRate('video_roll', 1.5);
    await adSettings.setRate('video_banner', 0.25);
    const early = { rates: snapshotRates() };
    expect(Object.keys(early.rates).sort()).toEqual([...FORMAT_KEYS].sort());
    expect(early.rates).toMatchObject({ video_roll: 1.5, video_banner: 0.25 });

    await adSettings.setRate('video_roll', 2.5);
    expect(rateFor(early, 'video_roll')).toBe(1.5);
    expect(rateFor(early, 'video_banner')).toBe(0.25);
    const late = { rates: snapshotRates() };
    expect(rateFor(late, 'video_roll')).toBe(2.5);
    expect(priceForDays(7, rateFor(late, 'video_roll'), 10)).toBeGreaterThan(priceForDays(7, rateFor(early, 'video_roll'), 10));

    // Moving the early advertiser onto platform prices: drop their own roll rate.
    const graduated = { rates: { ...early.rates } };
    delete graduated.rates.video_roll;
    expect(rateFor(graduated, 'video_roll')).toBe(2.5);
    await adSettings.setRate('video_roll', 3);
    expect(rateFor(graduated, 'video_roll')).toBe(3);
    expect(rateFor(graduated, 'video_banner')).toBe(0.25);
  });
});

describe('rateCard: what the booking page is shown', () => {
  test('hides beta formats unless asked, and describes each product completely', () => {
    expect(rateCard(null).map((r) => r.key)).not.toContain('audio_spot');
    const withBeta = rateCard(null, { includeBeta: true });
    const audio = withBeta.find((r) => r.key === 'audio_spot');
    expect(audio).toMatchObject({ beta: true, creativeKind: 'audio', surface: 'audio', positioned: true });
    const banner = withBeta.find((r) => r.key === 'video_banner');
    expect(banner).toMatchObject({ burnsIn: true, creativeKinds: ['image', 'video'], overlayOnly: false });
    expect(banner.creativeSpec).toMatchObject({ minWidth: 728, maxWidth: 4000, maxHeight: 1000, minAspect: 3, maxAspect: 12 });
    const ticker = withBeta.find((r) => r.key === 'video_ticker');
    expect(ticker).toMatchObject({ overlayOnly: true, creativeKind: 'text' });
    expect(ticker.creativeSpec).toMatchObject({ maxChars: 140, styles: ['crawl', 'hold'] });
    expect(withBeta.find((r) => r.key === 'upload_gate')).toMatchObject({ positioned: false, creativeSpec: null });
  });
});

describe('creativeSpecError: does a creative fit the format it is booked on', () => {
  test.each([
    ['a well-shaped banner', 'video_banner', { width: 1456, height: 240 }, null],
    ['a banner too narrow to look sharp', 'video_banner', { width: 600, height: 100 }, /600px wide/],
    ['a banner that is almost square', 'video_banner', { width: 1000, height: 800 }, /at least 3:1/],
    ['a banner too long and thin to read', 'video_banner', { width: 3900, height: 300 }, /too long and thin/],
    ['a tall banner over the height cap', 'video_banner', { width: 4000, height: 1200 }, /most a banner can be is 4000x1000/],
    ['a banner over the pixel cap but well shaped', 'video_banner', { width: 4100, height: 1000 }, /most a banner can be is 4000x1000/],
    ['a portrait shorts spot', 'shorts_roll', { width: 1080, height: 1920 }, null],
    ['a shorts spot that is too narrow', 'shorts_roll', { width: 360, height: 640 }, /360px wide/],
    ['a landscape shorts spot', 'shorts_roll', { width: 1920, height: 1080 }, /landscape/],
    ['a square shorts spot', 'shorts_roll', { width: 1080, height: 1080 }, /close to square/],
    ['a roll, which has no shape rule', 'video_roll', { width: 10, height: 10 }, null],
    ['an unmeasured banner, which is let through', 'video_banner', {}, null],
    ['an unknown format', 'hologram', { width: 1, height: 1 }, null],
  ])('%s', (_label, key, size, want) => {
    const got = creativeSpecError(key, size);
    if (want === null) expect(got).toBeNull();
    else expect(got).toMatch(want);
  });
});
