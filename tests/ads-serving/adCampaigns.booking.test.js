/**
 * routes/adCampaigns.js, booking a flight: POST /campaigns validates against the
 * format's own rules, prices it at the advertiser's rate on the day curve, holds the
 * position (up to AD_SLOT_MAX_SHARES advertisers), spends earlier credit and writes
 * the payment memo. Then the advertiser's list, the claim hand-off and the ticker's
 * audio switch.
 */
const request = require('supertest');
const fx = require('./_fixtures');

fx.useAdEnv({ ADS_STAGE: 'public', ADS_BETA_USERS: 'meno' });
jest.mock('../../services/adPaymentClaim', () => ({ claimCampaignPayment: jest.fn(), getHbdPerHive: jest.fn() }));
const { claimCampaignPayment } = require('../../services/adPaymentClaim');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const adSettings = require('../../utils/adSettings');
const { priceForDays } = require('../../utils/adModel');
const config = require('../../utils/config');

const app = buildApp(['/advertise', require('../../routes/adCampaigns')]);
const db = testDb.use();
fx.freezeTime();

let adv;
beforeEach(async () => {
  jest.setSystemTime(fx.NOW);
  claimCampaignPayment.mockReset();
  await adSettings.refresh();
  adv = fx.advertiser({ status: 'approved', hiveAccount: 'acme', rates: { video_roll: 0.2, video_banner: 0.1, video_ticker: 0.05 } });
  await fx.seed(db(), { advertisers: [adv] });
});

const campaigns = () => db().collection(config.AD_CAMPAIGNS_COLLECTION);
const book = (over = {}) => request(app).post('/advertise/campaigns')
  .send({ reference: adv.reference, format: 'video_roll', days: 7, slotPercent: 10, spotSeconds: 10, ...over });

describe('POST /advertise/campaigns', () => {
  test('books a roll at the advertiser\'s own rate, on the day curve, awaiting payment', async () => {
    const res = await book().expect(201);
    const price = priceForDays(7, 0.2, 10);
    expect(res.body.payment).toMatchObject({
      to: config.AD_PAYMENT_ACCOUNT, amount: `${price.toFixed(3)} HBD`, priceHbd: price, creditAppliedHbd: 0, amountDueHbd: price, alreadyCovered: false,
      memo: expect.stringMatching(/^ad:[0-9a-f]{24}$/),
    });
    expect(res.body.payment.note).toMatch(/Send the transfer with exactly this memo/);
    expect(res.body.campaign).toMatchObject({
      format: 'video_roll', status: 'awaiting_payment', slotPercent: 10, days: 7, priceHbd: price, spotSeconds: 10,
      pricePerSecondDayHbd: 0.2, payFrom: 'acme', startAt: null, endAt: null, outstandingHbd: price, blockedBy: 'unpaid',
      name: 'Acme Widgets campaign',
    });

    const stored = await campaigns().findOne({ memo: res.body.payment.memo });
    expect(stored).toMatchObject({ advertiserRef: adv.reference, hiveAccount: 'acme', paidHbd: 0, forecastShareOf: 1, deliveredImpressions: 0 });
    expect(stored.memo).toBe(`ad:${stored._id}`);
  });

  test('a pending applicant may book; serving is what waits for approval', async () => {
    await db().collection(config.ADVERTISERS_COLLECTION).updateOne({ reference: adv.reference }, { $set: { status: 'pending' } });
    await book().expect(201);
  });

  test('the forecast written onto the booking is the share of the position it will get', async () => {
    await db().collection(config.AD_INVENTORY_COLLECTION).insertOne({ _id: 'current', slots: [{ percent: 10, perDay: 30 }], rollSlots: [{ percent: 10, perDay: 20 }] });
    await fx.seed(db(), { campaigns: [fx.campaign({ slotPercent: 10, startAt: new Date(fx.NOW), endAt: fx.fromNow(30 * fx.DAY) })] });
    const res = await book().expect(201);
    expect(res.body.campaign.forecast).toBe(70);
    expect(await campaigns().findOne({ memo: res.body.payment.memo })).toMatchObject({ forecastImpressions: 70, forecastShareOf: 2 });
  });

  test('a full position is refused with what is still free and when a place opens, never who holds it', async () => {
    const holders = Array.from({ length: config.AD_SLOT_MAX_SHARES }, (_, i) => fx.campaign({
      slotPercent: 10, startAt: new Date(fx.NOW), endAt: fx.fromNow((i + 3) * fx.DAY), advertiserRef: `rival-${i}`,
    }));
    await fx.seed(db(), { campaigns: holders });
    const res = await book().expect(409);
    expect(res.body).toMatchObject({ slotPercent: 10, freeFrom: holders[0].endAt.toISOString(), alternatives: [0, 25, 50, 75] });
    expect(res.body.error).toMatch(/10% position is full .* A place opens up from \d{4}-\d{2}-\d{2}\./);
    expect(JSON.stringify(res.body)).not.toMatch(/rival/);
  });

  test('a banner and a roll at the same position do not compete', async () => {
    await fx.seed(db(), { campaigns: Array.from({ length: config.AD_SLOT_MAX_SHARES }, () => fx.campaign({ slotPercent: 10, startAt: new Date(fx.NOW), endAt: fx.fromNow(30 * fx.DAY) })) });
    await book({ format: 'video_banner', spotSeconds: 20 }).expect(201);
  });

  test('the pre-upload spot has no position to buy', async () => {
    const res = await book({ format: 'upload_gate', slotPercent: 'anything' }).expect(201);
    expect(res.body.campaign).toMatchObject({ format: 'upload_gate', slotPercent: null, forecast: null });
  });

  test('a ticker booking remembers whether it should also be read aloud on audio', async () => {
    const res = await book({ format: 'video_ticker', audioSpot: true }).expect(201);
    expect(res.body.campaign.audioSpot).toBe(true);
    const plain = await book({ format: 'video_ticker', slotPercent: 25 }).expect(201);
    expect(plain.body.campaign.audioSpot).toBe(false);
    expect((await book({ slotPercent: 50 }).expect(201)).body.campaign.audioSpot).toBeNull();
  });

  test('a format still in beta is bookable by beta users only', async () => {
    expect((await book({ format: 'audio_spot' }).expect(403)).body.error).toMatch(/audio spot is not open for booking yet/);
    const tester = fx.advertiser({ hiveAccount: 'meno' });
    await fx.seed(db(), { advertisers: [tester] });
    await book({ reference: tester.reference, format: 'audio_spot', spotSeconds: 20 }).expect(201);
  });

  test('a start up to a day in the past is accepted (a calendar date in a late timezone)', async () => {
    await book({ startAt: fx.ago(20 * fx.HOUR).toISOString() }).expect(201);
  });

  test('"make the spot for us" is folded into the one transfer, by tier or at the old flat fee', async () => {
    const brief = 'A calm voice over the product with our logo at the end.';
    const tier = await book({ production: { requested: true, brief, tier: 'ai_commercial' } }).expect(201);
    expect(tier.body.campaign).toMatchObject({ productionFeeHbd: 50, production: { requested: true, tier: 'ai_commercial', status: 'requested', brief } });
    expect(tier.body.payment.priceHbd).toBe(Math.round((priceForDays(7, 0.2, 10) + 50) * 1000) / 1000);

    const flat = await book({ slotPercent: 25, production: true, productionBrief: brief }).expect(201);
    expect(flat.body.campaign.productionFeeHbd).toBe(config.AD_PRODUCTION_FEE_HBD);
  });

  test('earlier credit is spent on the booking and the transfer asked for is what is left', async () => {
    await fx.seed(db(), { campaigns: [fx.campaign({ advertiserRef: adv.reference, status: 'complete', slotPercent: 50, creditHbd: 1, startAt: fx.ago(20 * fx.DAY), endAt: fx.ago(10 * fx.DAY) })] });
    const res = await book().expect(201);
    const price = priceForDays(7, 0.2, 10);
    expect(res.body.payment).toMatchObject({ creditAppliedHbd: 1, amountDueHbd: Math.round((price - 1) * 1000) / 1000, alreadyCovered: false });
    expect(res.body.payment.note).toMatch(/1 HBD of credit from an earlier campaign has been applied/);
  });

  test('a booking that credit covers in full starts at once, with nothing to send', async () => {
    await fx.seed(db(), { campaigns: [fx.campaign({ advertiserRef: adv.reference, status: 'complete', slotPercent: 50, creditHbd: 500, startAt: fx.ago(20 * fx.DAY), endAt: fx.ago(10 * fx.DAY) })] });
    const res = await book().expect(201);
    expect(res.body.payment).toMatchObject({ alreadyCovered: true, amountDueHbd: 0, amount: '0.000 HBD' });
    expect(res.body.campaign).toMatchObject({ status: 'scheduled', startAt: fx.NOW.toISOString(), outstandingHbd: 0 });
  });

  test.each([
    ['an unknown product reference', { reference: 'nope' }, 403, /No product/],
    ['an unknown format', { format: 'hologram' }, 400, /format must be one of/],
    ['too many days', { days: 91 }, 400, /days must be a whole number between 1 and 90/],
    ['an unreadable start date', { startAt: 'next tuesday-ish' }, 400, /not a date we can read/],
    ['a start date long gone', { startAt: fx.ago(3 * fx.DAY).toISOString() }, 400, /start date has passed/],
    ['a position nobody sells', { slotPercent: 33 }, 400, /slotPercent must be one of/],
    ['a production request without a brief', { production: { requested: true, brief: 'do it' } }, 400, /at least 20 characters/],
    ['a production tier that cannot make this format', { production: { requested: true, brief: 'x'.repeat(30), tier: 'static_banner' } }, 400, /cannot make that kind of ad for a video spot/],
    ['a spot longer than the format allows', { spotSeconds: 16 }, 400, /between 1 and 15 for a video spot/],
    ['a fractional spot', { spotSeconds: 2.5 }, 400, /whole number of seconds/],
    ['a shortest video longer than the longest', { minVideoSeconds: 600, maxVideoSeconds: 60 }, 400, /cannot be longer than the longest/],
  ])('refuses %s', async (_label, over, status, error) => {
    expect((await book(over).expect(status)).body.error).toMatch(error);
    expect(await campaigns().countDocuments()).toBe(0);
  });

  test('markets are kept as upper-case two-letter codes, at most twenty', async () => {
    const res = await book({ markets: ['de', 'FR', 7, 'x', ...Array(30).fill('NL')] }).expect(201);
    expect(res.body.campaign.markets).toEqual(['DE', 'FR', ...Array(18).fill('NL')]);
    expect((await book({ slotPercent: 25, markets: 'DE' }).expect(201)).body.campaign.markets).toEqual([]);
  });

  // BUG (routes/adCampaigns.js POST /campaigns, and the same str(m, 2) in
  // routes/advertise.js /apply): a market is cut to its first two letters before it is
  // checked, so a three-letter ISO code silently becomes another country: "AUT"
  // (Austria) is booked as "AU" (Australia). Booking also never checks the code against
  // the ISO list, so "SWE" (Sweden) is stored as "SW", which is no country at all.
  test('BUG: a three-letter country code is never booked as a different country', async () => {
    const res = await book({ markets: ['AUT'] });
    expect((res.body.campaign && res.body.campaign.markets) || []).not.toContain('AU');
  });

  test.each([['AUT'], ['SWE'], ['ZZ']])('a market %s that is not an ISO two-letter code is refused and books nothing', async (code) => {
    expect((await book({ markets: ['DE', code] }).expect(400)).body.error).toMatch(new RegExp(`Not a country code: ${code}`));
    expect(await campaigns().countDocuments()).toBe(0);
  });

  test('a banner may run longer than a roll: each format has its own cap', async () => {
    await book({ format: 'video_banner', spotSeconds: 20 }).expect(201);
  });
});

describe('GET /advertise/campaigns', () => {
  test('lists the advertiser\'s own flights, what each one runs, and why it is not serving', async () => {
    const reviewSpot = fx.videoCreative({ status: 'review', advertiserRef: adv.reference, durationSeconds: 10 });
    const running = fx.campaign({ advertiserRef: adv.reference, creativeEmbedId: reviewSpot.embedId, createdAt: fx.ago(fx.HOUR), clicks: 4, deliveredImpressions: 9 });
    const ticker = fx.campaign({ advertiserRef: adv.reference, format: 'video_ticker', creativeEmbedId: null, createdAt: fx.ago(2 * fx.HOUR) });
    const someoneElse = fx.campaign({ advertiserRef: 'other' });
    await fx.seed(db(), { creatives: [reviewSpot], campaigns: [running, ticker, someoneElse] });
    await db().collection(config.AD_IMPRESSIONS_COLLECTION).insertMany([
      { sid: 'a', campaignId: running._id, watchedSeconds: 10 },
      { sid: 'b', campaignId: running._id, watchedSeconds: 4 },
      { sid: 'c', campaignId: running._id, watchedSeconds: 0 },
    ]);

    const res = await request(app).get(`/advertise/campaigns?reference=${adv.reference}`).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.campaigns.map((c) => c.id)).toEqual([String(running._id), String(ticker._id)]);
    const [roll, tick] = res.body.campaigns;
    expect(roll).toMatchObject({
      blockedBy: 'creative_review', clicks: 4, delivered: 9,
      creative: { embedId: reviewSpot.embedId, status: 'review', encoded: true, previewUrl: `https://3speak.tv/embed/acme/${reviewSpot.permlink}` },
      watch: { avgSeconds: 7, views: 2, toEndShare: 0.5 },
    });
    expect(tick).toMatchObject({ format: 'video_ticker', creativeKinds: ['text'], blockedBy: 'no_creative', watch: null, audioSpot: false });
    expect(res.body).toMatchObject({ balanceHbd: 0, entries: [] });
  });

  test('carries the credit balance with its working shown', async () => {
    await fx.seed(db(), { campaigns: [
      fx.campaign({ advertiserRef: adv.reference, name: 'Short flight', creditHbd: 4, deliveryRate: 0.6, closedAt: fx.ago(3 * fx.DAY) }),
      fx.campaign({ advertiserRef: adv.reference, name: 'Next flight', creditAppliedHbd: 1.5, creditAppliedAt: fx.ago(fx.DAY) }),
    ] });
    const res = await request(app).get(`/advertise/campaigns?reference=${adv.reference}`).expect(200);
    expect(res.body.balanceHbd).toBe(2.5);
    expect(res.body.entries).toEqual([
      expect.objectContaining({ kind: 'earned', hbd: 4, reason: 'Delivered 60% of the forecast for this flight' }),
      expect.objectContaining({ kind: 'spent', hbd: 1.5, reason: 'Applied to this booking' }),
    ]);
  });

  test('watch time that cannot be read leaves the list intact', async () => {
    await fx.seed(db(), { campaigns: [fx.campaign({ advertiserRef: adv.reference })] });
    const real = require('../../utils/db').getDb();
    const original = real.collection.bind(real);
    jest.spyOn(real, 'collection').mockImplementation((name) => {
      if (name !== config.AD_IMPRESSIONS_COLLECTION) return original(name);
      return { aggregate: () => ({ toArray: async () => { throw new Error('agg failed'); } }) };
    });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).get(`/advertise/campaigns?reference=${adv.reference}`).expect(200);
    expect(res.body.campaigns[0].watch).toBeNull();
  });

  test('an unknown reference is a 403', async () => {
    await request(app).get('/advertise/campaigns?reference=nope').expect(403);
  });
});

describe('POST /advertise/campaigns/:id/claim', () => {
  test('hands the claim to the payment service and shows the campaign as the advertiser sees it', async () => {
    const c = fx.campaign({ advertiserRef: adv.reference });
    claimCampaignPayment.mockResolvedValue({ status: 200, body: { success: true, credited: '5.000 HBD' }, campaign: c, creative: null });
    const res = await request(app).post(`/advertise/campaigns/${c._id}/claim`).expect(200);
    expect(res.body).toMatchObject({ success: true, credited: '5.000 HBD', campaign: { id: String(c._id), blockedBy: 'no_creative' } });
    expect(String(claimCampaignPayment.mock.calls[0][1])).toBe(String(c._id));
  });

  test('passes the service\'s own refusal straight through', async () => {
    claimCampaignPayment.mockResolvedValue({ status: 402, body: { success: false, error: 'No matching transfer yet' } });
    await request(app).post(`/advertise/campaigns/${fx.campaign()._id}/claim`).expect(402, { success: false, error: 'No matching transfer yet' });
  });

  test('a malformed id is a 400 and a service failure a 500', async () => {
    await request(app).post('/advertise/campaigns/xyz/claim').expect(400);
    claimCampaignPayment.mockRejectedValue(new Error('rpc'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await request(app).post(`/advertise/campaigns/${fx.campaign()._id}/claim`).expect(500);
  });
});

describe('POST /advertise/campaigns/:id/audio: a ticker on audio, or not', () => {
  let ticker;
  beforeEach(async () => {
    ticker = fx.campaign({ advertiserRef: adv.reference, format: 'video_ticker' });
    await fx.seed(db(), { campaigns: [ticker] });
  });
  const flip = (id, body) => request(app).post(`/advertise/campaigns/${id}/audio`).send({ reference: adv.reference, ...body });

  test('switches it on and off', async () => {
    await flip(ticker._id, { audioSpot: true }).expect(200, { success: true, audioSpot: true });
    expect((await campaigns().findOne({ _id: ticker._id })).audioSpot).toBe(true);
    await flip(ticker._id, { audioSpot: false }).expect(200);
    expect((await campaigns().findOne({ _id: ticker._id })).audioSpot).toBe(false);
  });

  test.each([
    ['an unknown reference', () => [ticker._id, { reference: 'nope', audioSpot: true }], 403],
    ['a malformed id', () => ['zz', { audioSpot: true }], 400],
    ['a value that is not a boolean', () => [ticker._id, { audioSpot: 'yes' }], 400],
    ['somebody else\'s flight', () => [fx.campaign()._id, { audioSpot: true }], 404],
  ])('refuses %s', async (_label, args, status) => {
    const [id, body] = args();
    await flip(id, body).expect(status);
  });

  test('only a ticker flight has the switch', async () => {
    const roll = fx.campaign({ advertiserRef: adv.reference });
    await fx.seed(db(), { campaigns: [roll] });
    expect((await flip(roll._id, { audioSpot: true }).expect(400)).body.error).toMatch(/Only a ticker flight/);
  });
});

describe('a database failure is a 500 that says nothing about why', () => {
  test.each([
    ['post', '/advertise/campaigns'],
    ['get', '/advertise/campaigns?reference=x'],
    ['post', '/advertise/campaigns/0123456789abcdef01234567/audio'],
  ])('%s %s', async (method, path) => {
    fx.databaseFails();
    const res = await request(app)[method](path).send({ reference: 'x', audioSpot: true });
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(JSON.stringify(res.body)).not.toMatch(/database unavailable/);
  });
});

describe('when the feature is switched off', () => {
  test.each([['post', '/advertise/campaigns'], ['get', '/advertise/campaigns'], ['post', '/advertise/campaigns/x/claim'], ['post', '/advertise/campaigns/x/audio']])(
    '%s %s is a 404', async (method, path) => {
      const off = buildApp(['/advertise', fx.isolatedModule('../../routes/adCampaigns', { ADS_STAGE: 'off' })]);
      await request(off)[method](path).send({}).expect(404);
    },
  );
});
