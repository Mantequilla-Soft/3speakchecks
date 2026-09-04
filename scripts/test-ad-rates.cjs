#!/usr/bin/env node
/**
 * Platform rate defaults come from the database, not from the compiled constants.
 *
 *   node scripts/test-ad-rates.cjs
 *
 * Hits real Mongo, like the other suites here, and puts back whatever it found so
 * it can be run against a live checker without repricing anything. The one thing it
 * cannot assert is the HTTP surface — that needs a running process with the new
 * code — so it drives the same functions those routes call.
 */
require('dotenv').config();

/* 🚨 Run against a SCRATCH settings document, never the live one.
 *
 * This suite deletes the rates document and rewrites it several times. The running
 * checker re-reads that same document every 60 seconds and hands whatever it finds to
 * snapshotRates(), which stamps a copy onto every advertiser who registers — kept for a
 * year by design. So an advertiser signing up while this test was mid-run would be
 * priced at a test rate, permanently, and nothing would look wrong afterwards because
 * the `finally` puts the real document back.
 *
 * Set before requiring config, which reads it once. */
process.env.AD_SETTINGS_COLLECTION = process.env.AD_SETTINGS_TEST_COLLECTION || 'ad_settings_ratestest';
const { connectToMongo, getDb } = require('../utils/db');
const adSettings = require('../utils/adSettings');
const { FORMATS, FORMAT_KEYS, rateFor, defaultRateFor, snapshotRates, rateCard } = require('../utils/adFormats');
const { priceForDays, ratePerDayFor } = require('../utils/adModel');
const { AD_DAY_CURVE_K } = require('../utils/config');

/* What a flight SHOULD cost, written out longhand.
 *
 * These used to say `7 * rate * seconds`, which stopped being the price the day the
 * day-curve landed and turned four passing assertions into four failures that looked
 * like a pricing bug. Stating the formula once, here, means a future change to the
 * curve moves the expectations with it instead of against them. */
const expect = (days, rate, secs) => Math.round((days ** AD_DAY_CURVE_K) * rate * secs * 1000) / 1000;
const { AD_SETTINGS_COLLECTION } = require('../utils/config');

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${label}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
}

(async () => {
  await connectToMongo();
  const coll = getDb().collection(AD_SETTINGS_COLLECTION);
  const original = await coll.findOne({ _id: adSettings.RATES_ID });

  try {
    const builtIn = FORMATS.video_roll.ratePerSecondDayHbd;

    // 1. No stored value => the compiled default. An empty settings collection must
    //    price at the built-in rate, never at zero.
    await coll.deleteOne({ _id: adSettings.RATES_ID });
    await adSettings.refresh();
    check('no stored rate falls back to the built-in', defaultRateFor('video_roll'), builtIn);
    check('a 10s spot for 7 days at the built-in rate', priceForDays(7, null, 10), expect(7, builtIn, 10));

    // 2. A stored value wins, with no restart and no env change.
    await adSettings.setRate('video_roll', 3, 'test');
    check('stored rate is what a booking is quoted', defaultRateFor('video_roll'), 3);
    check('the price follows it', priceForDays(7, null, 10), expect(7, 3, 10));
    check('an advertiser with no deal gets it', rateFor(null, 'video_roll'), 3);
    check('and so does the legacy roll-rate helper', ratePerDayFor(null), 3);


    // 2b. The day curve: a longer flight costs less per day, and only that.

    //

    // ⚠️ The one-day price is load-bearing. It is the number an advertiser judges the

    // platform on and the one every rate card quotes, so the curve has to leave it

    // exactly where the straight line put it and take the discount out of duration.

    const oneDay = priceForDays(1, 3, 10);

    check('one day is untouched by the curve', oneDay, 3 * 10);

    check('  seven days costs less than seven of them', priceForDays(7, 3, 10) < oneDay * 7, true);

    check('  but more in total than one', priceForDays(7, 3, 10) > oneDay, true);

    check('  and thirty is cheaper per day than seven',

      priceForDays(30, 3, 10) / 30 < priceForDays(7, 3, 10) / 7, true);

    // Spot LENGTH stays linear. Only duration is discounted; a spot twice as long is

    // twice the airtime on every single play and is charged as such.

    check('  a 20s spot is twice a 10s spot, at any length of flight',

      priceForDays(30, 3, 20), Math.round(priceForDays(30, 3, 10) * 2 * 1000) / 1000);

    // A nonsensical day count must never come out free.

    check('  zero days is not a free flight', priceForDays(0, 3, 10), 0);


    // 3. Each format is independent — repricing the roll must not move the banner.
    check('banner untouched by a roll change', defaultRateFor('video_banner'), FORMATS.video_banner.ratePerSecondDayHbd);
    await adSettings.setRate('video_banner', 0.9, 'test');
    check('banner takes its own stored rate', defaultRateFor('video_banner'), 0.9);
    check('roll still on its own', defaultRateFor('video_roll'), 3);

    // 4. A negotiated advertiser rate still beats the platform default. This is the
    //    property that would break if the database default were consulted last.
    const advertiser = { rates: { video_roll: 0.4 } };
    check('negotiated rate beats the stored default', rateFor(advertiser, 'video_roll'), 0.4);
    const card = rateCard(advertiser);
    const roll = card.find((r) => r.key === 'video_roll');
    check('and reads as custom against the STORED default', roll.rateIsCustom, true);
    // The trap this guards: comparing against the compiled default would have called
    // the stored 3 "custom" for every advertiser on the standard rate.
    const standardCard = rateCard(null).find((r) => r.key === 'video_roll');
    check('standard rate does not read as custom', standardCard.rateIsCustom, false);
    check('standard card carries the stored rate', standardCard.ratePerSecondDayHbd, 3);

    // 5. Rubbish in the document is ignored in favour of the built-in, rather than
    //    being quoted. A zero or a string here would otherwise be a free flight.
    for (const bad of [0, -1, 'free', null, 10 ** 9]) {
      await coll.updateOne({ _id: adSettings.RATES_ID }, { $set: { 'formats.video_roll': bad } });
      await adSettings.refresh();
      check(`rejects a stored ${JSON.stringify(bad)}`, defaultRateFor('video_roll'), builtIn);
    }

    // 6. Clearing restores the built-in, and is distinguishable from storing it.
    await adSettings.setRate('video_roll', 2, 'test');
    check('set again before clearing', defaultRateFor('video_roll'), 2);
    await adSettings.setRate('video_roll', null, 'test');
    check('cleared falls back to the built-in', defaultRateFor('video_roll'), builtIn);
    const after = await coll.findOne({ _id: adSettings.RATES_ID });
    check('cleared means absent, not a stored copy', 'video_roll' in (after.formats || {}), false);

    // 7. setRate refuses what validRate refuses, so the CLI and the HTTP route
    //    cannot disagree about what a legal price is.
    let threw = false;
    try { await adSettings.setRate('video_roll', 0); } catch (_) { threw = true; }
    check('setRate refuses a zero rate', threw, true);

    // 8. THE FOUNDING-DISCOUNT LIFECYCLE. An advertiser is handed a copy of the
    //    price list at registration; raising the platform rate afterwards must move
    //    new signups and leave them alone. This is the property the whole "first
    //    four weeks get a discount" plan rests on, so it is tested end to end
    //    rather than assumed from rateFor()'s precedence order.
    console.log('\n  -- founding discount --');
    await adSettings.setRate('video_roll', 1.5, 'test');
    await adSettings.setRate('video_banner', 0.25, 'test');

    // Registers during the discount window.
    const early = { rates: snapshotRates(), ratesSource: 'registration' };
    check('registration captures every format', Object.keys(early.rates).sort(), FORMAT_KEYS.slice().sort());
    check('registration captures the roll rate', early.rates.video_roll, 1.5);
    check('registration captures the banner rate', early.rates.video_banner, 0.25);

    // Four weeks pass; the platform rate goes up.
    await adSettings.setRate('video_roll', 2.5, 'test');
    await adSettings.setRate('video_banner', 0.6, 'test');
    check('the platform rate rose', defaultRateFor('video_roll'), 2.5);
    check('the early advertiser keeps their roll rate', rateFor(early, 'video_roll'), 1.5);
    check('  and their banner rate', rateFor(early, 'video_banner'), 0.25);
    check('  and their flight price', priceForDays(7, rateFor(early, 'video_roll'), 10), expect(7, 1.5, 10));

    // Somebody registering now pays the new price.
    const late = { rates: snapshotRates(), ratesSource: 'registration' };
    check('a new advertiser pays the new rate', rateFor(late, 'video_roll'), 2.5);
    check('  and is quoted more for the same flight',
      priceForDays(7, rateFor(late, 'video_roll'), 10), expect(7, 2.5, 10));

    // A year later: clearing their own rate drops them onto the platform rate AND
    // keeps them tracking it, which storing a copy of today's number would not.
    const graduated = { rates: { ...early.rates } };
    delete graduated.rates.video_roll;
    check('cleared rate falls through to the platform', rateFor(graduated, 'video_roll'), 2.5);
    await adSettings.setRate('video_roll', 3, 'test');
    check('  and keeps tracking it afterwards', rateFor(graduated, 'video_roll'), 3);
    check('  while the untouched format stays put', rateFor(graduated, 'video_banner'), 0.25);

    // A rate stored as 0 on an advertiser must not become a free flight — the
    // advertiser path has to reject rubbish exactly as the platform path does.
    check('an advertiser rate of 0 is ignored', rateFor({ rates: { video_roll: 0 } }, 'video_roll'), 3);
    check('an advertiser rate of "free" is ignored', rateFor({ rates: { video_roll: 'free' } }, 'video_roll'), 3);
  } finally {
    // Scratch collection: nothing to preserve, just remove what the test created.
    await coll.deleteOne({ _id: adSettings.RATES_ID });
    void original;
    await adSettings.refresh();
    console.log('\nrestored the settings document as found.');
  }

  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
