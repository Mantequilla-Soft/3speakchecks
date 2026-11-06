/**
 * routes/adSelfPromo.js: a creator runs the opening seconds of their own published
 * video as an ad. Ported from scripts/test-ad-selfpromo.cjs: only your own, encoded,
 * posted video is eligible; the booking is charged at the rate it was quoted on the
 * day curve; the creative carries the trim and is never auto-approved; an advertiser
 * record stands for the channel, approved without a human.
 */
const request = require('supertest');
const { ObjectId } = require('mongodb');
const fx = require('./_fixtures');

fx.useAdEnv({ ADS_STAGE: 'public', AD_SELFPROMO_ALLOWED_OWNERS: 'badadib' });
jest.mock('../../utils/hive', () => ({ ...jest.requireActual('../../utils/hive'), hiveRpcBatch: jest.fn() }));
jest.mock('../../utils/videoDuration', () => ({ videoShapeFromManifest: jest.fn() }));
const { hiveRpcBatch } = require('../../utils/hive');
const { videoShapeFromManifest } = require('../../utils/videoDuration');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const { priceForDays } = require('../../utils/adModel');
const { rateFor } = require('../../utils/adFormats');
const config = require('../../utils/config');

const app = buildApp(['/advertise', require('../../routes/adSelfPromo')]);
const db = testDb.use();
fx.freezeTime();

/** The chain: a median price and a profile, unless a test says otherwise. */
function chain({ price = { base: '0.250 HBD', quote: '1.000 HIVE' }, profile = { name: 'Creator One', profile_image: 'https://img.example/c1.png' } } = {}) {
  hiveRpcBatch.mockImplementation(async ([call]) => {
    if (call.method === 'condenser_api.get_current_median_history_price') return price ? [{ result: price }] : [];
    if (call.method === 'bridge.get_profile') {
      if (profile instanceof Error) throw profile;
      return [{ result: { metadata: { profile } } }];
    }
    return [];
  });
}

let video;
beforeEach(async () => {
  jest.setSystemTime(fx.NOW);
  hiveRpcBatch.mockReset();
  videoShapeFromManifest.mockReset();
  chain();
  video = {
    _id: new ObjectId(), owner: 'creator1', permlink: 'asset-1', status: 'published', hive_author: 'creator1', hive_permlink: 'my-video',
    hive_title: 'How I build widgets', manifest_cid: 'QmPublished', duration: 600, thumbnail_url: 'https://img.example/t.jpg',
  };
  await db().collection('embed-video').insertOne(video);
});

const options = (q) => request(app).get('/advertise/selfpromo/options').query({ account: 'creator1', owner: 'creator1', permlink: 'asset-1', ...q });
const book = (body) => request(app).post('/advertise/selfpromo/book')
  .send({ account: 'creator1', owner: 'creator1', permlink: 'asset-1', format: 'video_roll', days: 3, spotSeconds: 10, ...body });
const campaigns = () => db().collection(config.AD_CAMPAIGNS_COLLECTION);
const advertisers = () => db().collection(config.ADVERTISERS_COLLECTION);

describe('GET /advertise/selfpromo/options: is this video eligible', () => {
  test('their own published, encoded, posted video is eligible, quoted at the self-promo rate', async () => {
    const res = await options().expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      eligible: true, hbdPerHive: 0.25, slogan: config.AD_SELFPROMO_SLOGAN, minDays: 1, maxDays: 90, limitedToOwners: ['badadib'],
      formats: [{ key: 'video_roll', ratePerSecondDayHbd: config.AD_SELFPROMO_RATE_HBD, maxSeconds: 15, surface: 'watch' }],
      video: { owner: 'creator1', hiveAuthor: 'creator1', hivePermlink: 'my-video', title: 'How I build widgets', durationSeconds: 600, isShort: false },
    });
  });

  test('a short can run as a shorts spot or as a roll, never longer than itself', async () => {
    await db().collection('embed-video').updateOne({ _id: video._id }, { $set: { short: true, duration: 8 } });
    const res = await options().expect(200);
    expect(res.body.formats.map((f) => [f.key, f.maxSeconds])).toEqual([['shorts_roll', 8], ['video_roll', 8]]);
  });

  test('the video is also found by its Hive post', async () => {
    expect((await options({ owner: 'creator1', permlink: 'my-video' })).body.eligible).toBe(true);
  });

  test('an unreadable price is sent as null rather than as zero', async () => {
    chain({ price: null });
    expect((await options()).body.hbdPerHive).toBeNull();
    hiveRpcBatch.mockRejectedValue(new Error('nodes down'));
    expect((await options()).body.hbdPerHive).toBeNull();
  });

  test.each([
    ['an unknown video', { permlink: 'nope' }, null, /could not find that video/],
    ['somebody else\'s video', { account: 'intruder' }, null, /only promote your own video/],
    ['a video still processing', {}, { status: 'encoding' }, /still processing/],
    ['a video with no Hive post', {}, { hive_permlink: null }, /no Hive post yet/],
    ['a video whose encode has not finished', {}, { manifest_cid: null }, /still encoding/],
  ])('%s is not eligible, with a reason', async (_label, q, change, reason) => {
    if (change) await db().collection('embed-video').updateOne({ _id: video._id }, { $set: change });
    const res = await options(q).expect(200);
    expect(res.body).toMatchObject({ success: true, eligible: false, reason: expect.stringMatching(reason) });
  });

  test.each([
    ['an invalid account', { account: 'X' }, /valid Hive account/],
    ['no owner', { owner: '' }, /owner and permlink are required/],
    ['no permlink', { permlink: '' }, /owner and permlink are required/],
  ])('refuses %s with a 400', async (_label, q, error) => {
    expect((await options(q).expect(400)).body.error).toMatch(error);
  });
});

describe('POST /advertise/selfpromo/book', () => {
  test('books the opening seconds as a roll, awaiting payment, charged at the quoted rate on the day curve', async () => {
    const res = await book().expect(200);
    const rate = config.AD_SELFPROMO_RATE_HBD;
    expect(res.body).toMatchObject({
      success: true, payTo: config.AD_PAYMENT_ACCOUNT, ratePerSecondDayHbd: rate, totalHbd: priceForDays(3, rate, 10),
      spotSeconds: 10, days: 3, slotPercent: 10, reviewRequired: true, memo: `ad:${res.body.campaignId}`,
    });

    const camp = await campaigns().findOne({ _id: new ObjectId(res.body.campaignId) });
    expect(camp).toMatchObject({
      selfPromo: true, status: 'awaiting_payment', paidHbd: 0, format: 'video_roll', hiveAccount: 'creator1',
      name: 'Creator One: How I build widgets', creativeEmbedId: String(video._id),
      selfPromoVideo: { owner: 'creator1', permlink: 'asset-1', hiveAuthor: 'creator1', hivePermlink: 'my-video' },
    });

    const creative = await db().collection(config.AD_CREATIVES_COLLECTION).findOne({ embedId: String(video._id) });
    expect(creative).toMatchObject({ trimToSeconds: 10, status: 'review', manifestCid: 'QmPublished', selfPromo: true, kind: 'video' });

    const adv = await advertisers().findOne({ reference: res.body.reference });
    expect(adv).toMatchObject({
      selfPromo: true, status: 'approved', approvedBy: 'self-promo', slogan: config.AD_SELFPROMO_SLOGAN,
      projectName: 'Creator One', logoUrl: 'https://img.example/c1.png', website: 'https://3speak.tv/@creator1',
      rates: { video_roll: config.AD_SELFPROMO_RATE_HBD, shorts_roll: config.AD_SELFPROMO_RATE_HBD },
    });
    expect(adv.reference).toMatch(/^sp-creator1-/);
  });

  test('a second booking reuses the channel\'s advertiser and refreshes its name and avatar', async () => {
    const first = await book().expect(200);
    chain({ profile: { name: 'Creator Renamed', profile_image: 'https://img.example/new.png' } });
    const second = await book({ days: 2 }).expect(200);
    expect(second.body.reference).toBe(first.body.reference);
    expect(await advertisers().countDocuments()).toBe(1);
    expect(await advertisers().findOne({})).toMatchObject({ projectName: 'Creator Renamed', logoUrl: 'https://img.example/new.png' });
  });

  test('an old self-promo record on platform prices is moved onto the self-promo rate', async () => {
    await advertisers().insertOne(fx.advertiser({ hiveAccount: 'creator1', selfPromo: true, rates: { video_roll: 0.25 }, projectName: 'Creator One', logoUrl: 'https://img.example/c1.png' }));
    await book().expect(200);
    expect((await advertisers().findOne({ selfPromo: true })).rates.video_roll).toBe(config.AD_SELFPROMO_RATE_HBD);
  });

  test('a creative already reviewed keeps its decision', async () => {
    await db().collection(config.AD_CREATIVES_COLLECTION).insertOne(fx.videoCreative({ embedId: String(video._id), status: 'rejected' }));
    await book().expect(200);
    expect((await db().collection(config.AD_CREATIVES_COLLECTION).findOne({ embedId: String(video._id) })).status).toBe('rejected');
  });

  test('the position is chosen for them: the first free mid-roll, then the pre-roll', async () => {
    const fill = (pct) => Array.from({ length: config.AD_SLOT_MAX_SHARES }, () => fx.campaign({ slotPercent: pct, startAt: new Date(fx.NOW), endAt: fx.fromNow(10 * fx.DAY) }));
    await fx.seed(db(), { campaigns: [...fill(10), ...fill(25), ...fill(50), ...fill(75)] });
    expect((await book().expect(200)).body.slotPercent).toBe(0);
  });

  test('when every position is full it says when the first opens', async () => {
    await fx.seed(db(), { campaigns: [0, 10, 25, 50, 75].flatMap((pct) => Array.from({ length: config.AD_SLOT_MAX_SHARES }, () => fx.campaign({
      slotPercent: pct, startAt: new Date(fx.NOW), endAt: fx.fromNow(5 * fx.DAY),
    }))) });
    const res = await book().expect(409);
    expect(res.body.error).toBe(`Every position is full for those dates. The first one opens up on ${fx.fromNow(5 * fx.DAY).toISOString().slice(0, 10)}.`);
  });

  test('a shorts spot has no position, and must be portrait', async () => {
    await db().collection('embed-video').updateOne({ _id: video._id }, { $set: { short: true, duration: 30 } });
    videoShapeFromManifest.mockResolvedValueOnce({ width: 1920, height: 1080 });
    expect((await book({ format: 'shorts_roll' }).expect(400)).body.error).toMatch(/landscape/);
    expect(videoShapeFromManifest).toHaveBeenCalledWith('https://ipfs-3speak.b-cdn.net/ipfs/QmPublished/manifest.m3u8');

    videoShapeFromManifest.mockResolvedValueOnce({ width: 1080, height: 1920 });
    expect((await book({ format: 'shorts_roll' }).expect(200)).body.slotPercent).toBeNull();

    videoShapeFromManifest.mockRejectedValueOnce(new Error('cold gateway'));
    await book({ format: 'shorts_roll' }).expect(200);
  });

  test('an unreadable profile falls back to the account name and its Hive avatar', async () => {
    chain({ profile: new Error('bridge down') });
    const res = await book().expect(200);
    expect(await advertisers().findOne({ reference: res.body.reference }))
      .toMatchObject({ projectName: '@creator1', logoUrl: 'https://images.hive.blog/u/creator1/avatar' });
  });

  test.each([
    ['an invalid account', { account: '' }, /valid Hive account/],
    ['somebody else\'s video', { account: 'intruder' }, /only promote your own/],
    ['a shorts spot for a full video', { format: 'shorts_roll' }, /Shorts spots need a short/],
    ['a format self-promo does not offer', { format: 'video_banner' }, /can only run as a video roll/],
    ['a day count out of range', { days: 0 }, /days must be a whole number/],
    ['an unreadable start date', { startAt: 'someday' }, /not a date we can read/],
    ['a start date long gone', { startAt: fx.ago(2 * fx.DAY).toISOString() }, /start date has passed/],
    ['a spot longer than the format allows', { spotSeconds: 16 }, /between 1 and 15/],
    ['a shortest video longer than the longest', { minVideoSeconds: 300, maxVideoSeconds: 60 }, /cannot be longer/],
  ])('refuses %s with a 400 and books nothing', async (_label, body, error) => {
    expect((await book(body).expect(400)).body.error).toMatch(error);
    expect(await campaigns().countDocuments()).toBe(0);
  });

  test('a short cannot be booked for longer than it runs', async () => {
    await db().collection('embed-video').updateOne({ _id: video._id }, { $set: { short: true, duration: 6 } });
    expect((await book({ spotSeconds: 7 }).expect(400)).body.error).toMatch(/between 1 and 6/);
  });

  test('a short can also run as a roll inside a long video', async () => {
    await db().collection('embed-video').updateOne({ _id: video._id }, { $set: { short: true, duration: 12 } });
    await book({ format: 'video_roll', spotSeconds: 12 }).expect(200);
  });
});

describe('known problems with self-promo bookings', () => {
  // BUG (routes/adSelfPromo.js book): the campaign is written with startAt/endAt at
  // booking time, unlike POST /campaigns, which leaves them null until the money lands
  // (services/adPaymentClaim.js sets the real window then). utils/adSlots.js reads a
  // dated campaign as PAID, so an abandoned, unpaid self-promo booking holds one of the
  // position's shares for its whole flight instead of for the AD_SLOT_HOLD_HOURS hold.
  test('BUG: an unpaid self-promo booking stops holding its position once the hold lapses', async () => {
    const { slotHolders } = require('../../utils/adSlots');
    const res = await book({ days: 7 }).expect(200);
    fx.advance((config.AD_SLOT_HOLD_HOURS + 1) * fx.HOUR);
    const held = await slotHolders(db(), { slotPercent: res.body.slotPercent, start: Date.now(), end: Date.now() + fx.DAY });
    expect(held.holders).toBe(0);
  });

  // BUG (routes/adSelfPromo.js book stores `totalHbd`; routes/adCampaigns.js
  // publicCampaign reads `priceHbd`): the advertiser's campaign list shows an unpaid
  // self-promo flight with nothing outstanding and no amount due, next to
  // blockedBy 'unpaid'. services/adPaymentClaim.js priceOf already reads both fields.
  test('BUG: the campaign list shows what an unpaid self-promo flight still owes', async () => {
    jest.doMock('../../services/adPaymentClaim', () => ({ claimCampaignPayment: jest.fn(), getHbdPerHive: jest.fn() }));
    const both = buildApp(['/advertise', require('../../routes/adSelfPromo')], ['/advertise', require('../../routes/adCampaigns')]);
    const booked = await request(both).post('/advertise/selfpromo/book')
      .send({ account: 'creator1', owner: 'creator1', permlink: 'asset-1', format: 'video_roll', days: 3, spotSeconds: 10 }).expect(200);
    const list = await request(both).get(`/advertise/campaigns?reference=${booked.body.reference}`).expect(200);
    expect(list.body.campaigns[0]).toMatchObject({ blockedBy: 'unpaid', outstandingHbd: booked.body.totalHbd, amountDueHbd: booked.body.totalHbd });
  });
});

describe('with no self-promo rate configured', () => {
  test('the platform rate applies, and a channel that applied before keeps its own card', async () => {
    const platform = buildApp(['/advertise', fx.isolatedModule('../../routes/adSelfPromo', { AD_SELFPROMO_RATE_HBD: '0' })]);
    expect((await request(platform).get('/advertise/selfpromo/options').query({ account: 'creator1', owner: 'creator1', permlink: 'asset-1' })).body.formats[0].ratePerSecondDayHbd)
      .toBe(rateFor(null, 'video_roll'));

    await advertisers().insertOne(fx.advertiser({ hiveAccount: 'creator1', status: 'approved', rates: { video_roll: 0.09 }, ratesSetAt: fx.ago(fx.DAY) }));
    const res = await request(platform).post('/advertise/selfpromo/book')
      .send({ account: 'creator1', owner: 'creator1', permlink: 'asset-1', format: 'video_roll', days: 1, spotSeconds: 5 }).expect(200);
    expect(res.body).toMatchObject({ ratePerSecondDayHbd: 0.09, totalHbd: priceForDays(1, 0.09, 5) });
    expect((await advertisers().findOne({ selfPromo: true })).rates.video_roll).toBe(0.09);
  });
});

describe('when the product is off', () => {
  test.each([
    ['the whole ad platform is dark', { ADS_STAGE: 'off' }],
    ['self-promotion is switched off', { AD_SELFPROMO_ENABLED: 'false' }],
  ])('every route is a 404 when %s', async (_label, env) => {
    const off = buildApp(['/advertise', fx.isolatedModule('../../routes/adSelfPromo', env)]);
    await request(off).get('/advertise/selfpromo/options').expect(404);
    await request(off).post('/advertise/selfpromo/book').send({}).expect(404);
  });
});

describe('a database failure is a 500 that says nothing about why', () => {
  test.each([['get', '/advertise/selfpromo/options?account=creator1&owner=creator1&permlink=asset-1'], ['post', '/advertise/selfpromo/book']])('%s %s', async (method, path) => {
    fx.databaseFails();
    await request(app)[method](path).send({ account: 'creator1' }).expect(500, { success: false, error: 'Internal server error' });
  });
});
