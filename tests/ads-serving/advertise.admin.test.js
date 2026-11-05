/**
 * routes/advertise.js, the operator surface: reviewing applications and creatives,
 * the inventory snapshot, the platform rate card, per-advertiser rates and refunds of
 * refused payments.
 *
 * Behind AD_ADMIN_SECRET, never behind API_SECRET_KEY (that one ships in the public
 * frontend bundle). The gate fails closed: no secret configured means 503, not open.
 */
const request = require('supertest');
const fx = require('./_fixtures');

fx.useAdEnv({ ADS_STAGE: 'beta' });
const testDb = require('../helpers/db');
const { buildApp, apiKeyHeader } = require('../helpers/app');
const adSettings = require('../../utils/adSettings');
const { FORMATS, FORMAT_KEYS, defaultRateFor } = require('../../utils/adFormats');
const {
  ADVERTISERS_COLLECTION, AD_CREATIVES_COLLECTION, AD_INVENTORY_COLLECTION, AD_PAYMENTS_COLLECTION,
} = require('../../utils/config');

const app = buildApp(['/advertise', require('../../routes/advertise')]);
const db = testDb.use();
fx.freezeTime();
beforeEach(async () => {
  jest.setSystemTime(fx.NOW);
  await adSettings.refresh();
});

const admin = (method, path) => request(app)[method](path).set(fx.adminHeader());
const advertisers = () => db().collection(ADVERTISERS_COLLECTION);
const creatives = () => db().collection(AD_CREATIVES_COLLECTION);
const payments = () => db().collection(AD_PAYMENTS_COLLECTION);

const ADMIN_ROUTES = [
  ['get', '/advertise/admin/applications'],
  ['post', '/advertise/admin/applications/000000000000000000000000/decide'],
  ['get', '/advertise/admin/creatives'],
  ['post', '/advertise/admin/creatives/000000000000000000000000/decide'],
  ['get', '/advertise/admin/inventory'],
  ['post', '/advertise/admin/inventory/refresh'],
  ['get', '/advertise/admin/rates'],
  ['post', '/advertise/admin/rates'],
  ['get', '/advertise/admin/advertisers/rates'],
  ['get', '/advertise/admin/advertisers/000000000000000000000000/rates'],
  ['post', '/advertise/admin/advertisers/000000000000000000000000/rates'],
  ['get', '/advertise/admin/refunds'],
  ['post', '/advertise/admin/refunds/abc/settle'],
];

describe('the admin gate', () => {
  test.each(ADMIN_ROUTES)('%s %s refuses a caller with no secret', async (method, path) => {
    await request(app)[method](path).expect(401, { success: false, error: 'Unauthorized' });
  });

  test.each(ADMIN_ROUTES)('%s %s refuses the public API key', async (method, path) => {
    await request(app)[method](path).set(apiKeyHeader()).expect(401);
  });

  test.each([
    ['a wrong secret of the same length', { Authorization: `Bearer ${'x'.repeat(process.env.AD_ADMIN_SECRET.length)}` }, 401],
    ['a wrong secret of another length', { Authorization: 'Bearer short' }, 401],
    ['the secret without "Bearer"', { Authorization: process.env.AD_ADMIN_SECRET }, 401],
    ['the secret as x-admin-secret', { 'x-admin-secret': process.env.AD_ADMIN_SECRET }, 200],
    ['the secret as a bearer token', fx.adminHeader(), 200],
  ])('%s', async (_label, headers, status) => {
    await request(app).get('/advertise/admin/applications').set(headers).expect(status);
  });

  test('with no secret configured the whole surface is a 503, not open', async () => {
    const closed = buildApp(['/advertise', fx.isolatedModule('../../routes/advertise', { AD_ADMIN_SECRET: '' })]);
    const res = await request(closed).get('/advertise/admin/applications').set('Authorization', 'Bearer ').expect(503);
    expect(res.body.error).toMatch(/no AD_ADMIN_SECRET/);
  });

  test('stays reachable while the feature is switched off', async () => {
    const off = buildApp(['/advertise', fx.isolatedModule('../../routes/advertise', { ADS_STAGE: 'off' })]);
    await request(off).get('/advertise/admin/applications').set(fx.adminHeader()).expect(200);
  });
});

describe('reviewing applications', () => {
  test('the queue can be filtered by status and is newest first, with a capped page size', async () => {
    await advertisers().insertMany([
      fx.advertiser({ status: 'pending', createdAt: fx.ago(3 * fx.DAY), projectName: 'Old' }),
      fx.advertiser({ status: 'pending', createdAt: fx.ago(fx.DAY), projectName: 'New' }),
      fx.advertiser({ status: 'approved' }),
    ]);
    const res = await admin('get', '/advertise/admin/applications?status=pending').expect(200);
    expect(res.body.applications.map((a) => a.projectName)).toEqual(['New', 'Old']);
    expect((await admin('get', '/advertise/admin/applications?status=bogus&limit=1')).body.count).toBe(1);
    expect((await admin('get', '/advertise/admin/applications?limit=0')).body.count).toBe(3);
  });

  test('a decision records who decided, the applicant\'s note and the private one', async () => {
    const doc = fx.advertiser({ status: 'pending' });
    await advertisers().insertOne(doc);
    const res = await admin('post', `/advertise/admin/applications/${doc._id}/decide`)
      .send({ decision: 'APPROVED', applicantNote: 'Welcome', reviewerNote: 'checked', reviewedBy: 'ops' }).expect(200);
    expect(res.body.application).toMatchObject({
      status: 'approved', applicantNote: 'Welcome', reviewerNote: 'checked', reviewedBy: 'ops', reviewedAt: fx.NOW.toISOString(),
    });
  });

  test.each([
    ['a decision that is neither', 'abc', { decision: 'maybe' }, 400],
    ['an id that is not one', 'not-an-id', { decision: 'rejected' }, 400],
    ['an application that does not exist', '0123456789abcdef01234567', { decision: 'rejected' }, 404],
  ])('refuses %s', async (_label, id, body, status) => {
    await admin('post', `/advertise/admin/applications/${id}/decide`).send(body).expect(status);
  });
});

describe('reviewing creatives', () => {
  test('the default queue is what needs a person, with the flights each creative is on', async () => {
    const waiting = fx.videoCreative({ status: 'review', campaignId: 'stale-pointer' });
    const done = fx.videoCreative({ status: 'ready' });
    const a = fx.campaign({ creativeEmbedId: waiting.embedId, name: 'Flight A' });
    const b = fx.campaign({ creativeEmbedId: waiting.embedId, name: 'Flight B', format: undefined });
    await fx.seed(db(), { creatives: [waiting, done], campaigns: [a, b] });

    const res = await admin('get', '/advertise/admin/creatives').expect(200);
    expect(res.body.creatives).toHaveLength(1);
    const [row] = res.body.creatives;
    expect(row).not.toHaveProperty('campaignId');
    expect(row.campaigns.map((c) => c.name).sort()).toEqual(['Flight A', 'Flight B']);
    expect(row.campaigns.find((c) => c.name === 'Flight B').format).toBe('video_roll');

    expect((await admin('get', '/advertise/admin/creatives?status=ready')).body.creatives[0].campaigns).toEqual([]);
  });

  const decide = (cr, body) => admin('post', `/advertise/admin/creatives/${cr._id}/decide`).send(body);

  test('approving makes a spot ready to serve, with the note and reviewer kept', async () => {
    const adv = fx.advertiser({ status: 'approved' });
    const cr = fx.videoCreative({ status: 'review', advertiserRef: adv.reference });
    await fx.seed(db(), { advertisers: [adv], creatives: [cr] });
    const res = await decide(cr, { decision: 'approved', note: 'Looks great', reviewedBy: 'ops' }).expect(200);
    expect(res.body.creative).toMatchObject({ status: 'ready', reviewNote: 'Looks great', reviewedBy: 'ops' });
  });

  test.each([
    ['a banner with no image', fx.imageCreative({ imageUrl: '' }), /banner has no image/],
    ['a ticker with no link', fx.textCreative({ clickUrl: null }), /ticker has no message or link/],
    ['an audio spot with no file', fx.audioCreative({ audioFile: null }), /no file on record/],
    ['a video that has not encoded', fx.videoCreative({ manifestCid: null }), /not finished encoding/],
  ])('refuses to approve %s, saying why', async (_label, cr, why) => {
    await creatives().insertOne({ ...cr, status: 'review', advertiserRef: null });
    const res = await decide(cr, { decision: 'approved' }).expect(409);
    expect(res.body.error).toMatch(why);
    expect((await creatives().findOne({ _id: cr._id })).status).toBe('review');
  });

  test.each([['pending'], ['rejected'], [null]])('refuses to approve a spot whose advertiser is %p', async (status) => {
    const adv = fx.advertiser({ status });
    const cr = fx.videoCreative({ status: 'review', advertiserRef: adv.reference });
    await fx.seed(db(), { advertisers: status ? [adv] : [], creatives: [cr] });
    const res = await decide(cr, { decision: 'approved' }).expect(409);
    expect(res.body.error).toBe(`The advertiser behind that spot is ${status || 'unknown'}. Approve the application first.`);
  });

  test('rejecting needs no asset and no approved advertiser', async () => {
    const cr = fx.videoCreative({ status: 'review', manifestCid: null, advertiserRef: 'ghost' });
    await creatives().insertOne(cr);
    expect((await decide(cr, { decision: 'rejected', note: 'Too loud' }).expect(200)).body.creative)
      .toMatchObject({ status: 'rejected', reviewNote: 'Too loud' });
  });

  test.each([
    ['a decision that is neither', 'abc', { decision: 'meh' }, 400],
    ['an id that is not one', 'zz', { decision: 'rejected' }, 400],
    ['a creative that does not exist', '0123456789abcdef01234567', { decision: 'rejected' }, 404],
  ])('refuses %s', async (_label, id, body, status) => {
    await admin('post', `/advertise/admin/creatives/${id}/decide`).send(body).expect(status);
  });
});

describe('the inventory snapshot', () => {
  test('is a 503 before the first run, then the full snapshot including who was excluded', async () => {
    await admin('get', '/advertise/admin/inventory').expect(503);
    await db().collection(AD_INVENTORY_COLLECTION).insertOne({ _id: 'current', excluded: { optedOutAccounts: ['bob'] } });
    expect((await admin('get', '/advertise/admin/inventory').expect(200)).body.snapshot.excluded.optedOutAccounts).toEqual(['bob']);
  });

  test('a refresh runs the forecast now and returns what it wrote', async () => {
    const res = await admin('post', '/advertise/admin/inventory/refresh').expect(200);
    expect(res.body.snapshot).toMatchObject({ _id: 'current', windowDays: 30 });
    expect(await db().collection(AD_INVENTORY_COLLECTION).countDocuments()).toBe(1);
  });

  test('a refresh that cannot write says so', async () => {
    const ro = buildApp(['/advertise', fx.isolatedModule('../../routes/advertise', { ENABLE_MONGO_WRITES: 'false' })]);
    await request(ro).post('/advertise/admin/inventory/refresh').set(fx.adminHeader()).expect(500);
  });
});

describe('the platform rate card', () => {
  test('lists every format with its price now, the built-in fallback and where the number came from', async () => {
    await adSettings.setRate('video_banner', 0.5, 'ops');
    const res = await admin('get', '/advertise/admin/rates').expect(200);
    expect(res.body.rates.map((r) => r.format)).toEqual(FORMAT_KEYS);
    expect(res.body.rates.find((r) => r.format === 'video_banner')).toMatchObject({ ratePerSecondDayHbd: 0.5, builtInHbd: FORMATS.video_banner.ratePerSecondDayHbd, source: 'database' });
    expect(res.body.rates.find((r) => r.format === 'video_roll')).toMatchObject({ source: 'built-in' });
    expect(res.body).toMatchObject({ updatedBy: 'ops', maxRate: adSettings.MAX_RATE });
  });

  test('setting a rate moves the next quote at once, and clearing it restores the built-in', async () => {
    const set = await admin('post', '/advertise/admin/rates').send({ format: 'video_roll', ratePerSecondDayHbd: '0.4', updatedBy: 'ops' }).expect(200);
    expect(set.body).toMatchObject({ format: 'video_roll', previousHbd: FORMATS.video_roll.ratePerSecondDayHbd, ratePerSecondDayHbd: 0.4 });
    expect(defaultRateFor('video_roll')).toBe(0.4);

    const cleared = await admin('post', '/advertise/admin/rates').send({ format: 'video_roll', ratePerSecondDayHbd: null }).expect(200);
    expect(cleared.body.ratePerSecondDayHbd).toBe(FORMATS.video_roll.ratePerSecondDayHbd);
  });

  test.each([
    ['an unknown format', { format: 'hologram', ratePerSecondDayHbd: 1 }, /Unknown format/],
    ['a zero rate', { format: 'video_roll', ratePerSecondDayHbd: 0 }, /greater than 0/],
    ['a typo that would be a four-figure invoice', { format: 'video_roll', ratePerSecondDayHbd: 2500 }, /at most 1000/],
  ])('refuses %s', async (_label, body, error) => {
    expect((await admin('post', '/advertise/admin/rates').send(body).expect(400)).body.error).toMatch(error);
  });
});

describe('per-advertiser rates', () => {
  let founding;
  let current;
  beforeEach(async () => {
    founding = fx.advertiser({ hiveAccount: 'early', rates: { video_roll: 0.1 }, ratesSource: 'registration', createdAt: fx.ago(400 * fx.DAY) });
    current = fx.advertiser({ hiveAccount: 'late', rates: {}, createdAt: fx.ago(fx.DAY) });
    await advertisers().insertMany([founding, current]);
  });
  const rates = (id, body) => admin('post', `/advertise/admin/advertisers/${id}/rates`).send(body);

  test('the working list shows only advertisers below today\'s platform prices, unless all are asked for', async () => {
    const below = await admin('get', '/advertise/admin/advertisers/rates').expect(200);
    expect(below.body.advertisers.map((a) => a.hiveAccount)).toEqual(['early']);
    const roll = below.body.advertisers[0].rates.find((r) => r.format === 'video_roll');
    expect(roll).toMatchObject({ ratePerSecondDayHbd: 0.1, hasOwnRate: true, deltaHbd: Math.round((0.1 - defaultRateFor('video_roll')) * 1000) / 1000 });
    expect((await admin('get', '/advertise/admin/advertisers/rates?all=1')).body.count).toBe(2);
  });

  test('one advertiser\'s rates against the platform\'s, format by format', async () => {
    const res = await admin('get', `/advertise/admin/advertisers/${founding._id}/rates`).expect(200);
    expect(res.body.advertiser).toMatchObject({ hiveAccount: 'early', ratesSource: 'registration' });
    expect(res.body.rates).toHaveLength(FORMAT_KEYS.length);
  });

  test('one format at a time; null drops them onto the platform rate and keeps them tracking it', async () => {
    const one = await rates(founding._id, { format: 'video_banner', ratePerSecondDayHbd: 0.07, updatedBy: 'ops' }).expect(200);
    expect(one.body.changed).toEqual([{ format: 'video_banner', previousHbd: defaultRateFor('video_banner'), ratePerSecondDayHbd: 0.07 }]);
    expect(await advertisers().findOne({ _id: founding._id })).toMatchObject({ rates: { video_roll: 0.1, video_banner: 0.07 }, ratesSource: 'admin' });

    await rates(founding._id, { format: 'video_roll' }).expect(200);
    const after = await advertisers().findOne({ _id: founding._id });
    expect(after.rates).not.toHaveProperty('video_roll');
  });

  test('several formats in one write', async () => {
    await rates(founding._id, { rates: { video_roll: 0.3, shorts_roll: 0.2, video_banner: '' } }).expect(200);
    expect((await advertisers().findOne({ _id: founding._id })).rates).toEqual({ video_roll: 0.3, shorts_roll: 0.2 });
  });

  test('re-freezing at today\'s platform card ends a founding discount in one call', async () => {
    await adSettings.setRate('video_roll', 0.9);
    await rates(founding._id, { snapshotPlatform: true }).expect(200);
    expect((await advertisers().findOne({ _id: founding._id })).rates.video_roll).toBe(0.9);
  });

  test.each([
    ['nothing to change', {}, 400, /Send \{ format/],
    ['an empty map', { rates: {} }, 400, /No rates given/],
    ['an unknown format among good ones', { rates: { video_roll: 0.3, hologram: 1 } }, 400, /Unknown format "hologram"/],
    ['a bad rate among good ones', { rates: { video_roll: 0.3, video_banner: -1 } }, 400, /video_banner: rate must be/],
  ])('refuses %s and changes nothing', async (_label, body, status, error) => {
    expect((await rates(founding._id, body).expect(status)).body.error).toMatch(error);
    expect((await advertisers().findOne({ _id: founding._id })).rates).toEqual({ video_roll: 0.1 });
  });

  test.each([
    ['get', 'bad-id', 400], ['get', '0123456789abcdef01234567', 404],
    ['post', 'bad-id', 400], ['post', '0123456789abcdef01234567', 404],
  ])('%s with advertiser id %s is a %p', async (method, id, status) => {
    await admin(method, `/advertise/admin/advertisers/${id}/rates`).send({ format: 'video_roll', ratePerSecondDayHbd: 1 }).expect(status);
  });
});

describe('refunds of refused payments', () => {
  beforeEach(async () => {
    await payments().insertMany([
      {
        trx_id: 'tx-pending', status: 'refused', refundStatus: 'pending', from: 'payer', refundTo: 'real-payer',
        amount: '5.000 HBD', reason: 'wrong_payer', expectedFrom: 'acme', processedAt: fx.ago(fx.HOUR),
      },
      { trx_id: 'tx-review', status: 'refused', refundStatus: 'review', from: 'payer2', amount: '1.000 HBD', processedAt: fx.ago(fx.HOUR) },
      { trx_id: 'tx-done', status: 'refused', refundStatus: 'returned', from: 'p3', amount: '2.000 HBD', returnedTrxId: 'back-1', returnedAt: fx.ago(fx.DAY) },
    ]);
  });

  test('the queue shows pending returns by default, sent back to whoever really paid', async () => {
    const res = await admin('get', '/advertise/admin/refunds').expect(200);
    expect(res.body.refunds).toEqual([expect.objectContaining({ trx_id: 'tx-pending', returnTo: 'real-payer', amount: '5.000 HBD', reason: 'wrong_payer' })]);
    expect((await admin('get', '/advertise/admin/refunds?status=review')).body.refunds[0]).toMatchObject({ trx_id: 'tx-review', returnTo: 'payer2' });
  });

  test('settling needs the transaction that sent the money back, and records it', async () => {
    await admin('post', '/advertise/admin/refunds/tx-pending/settle').send({}).expect(400);
    const res = await admin('post', '/advertise/admin/refunds/tx-pending/settle').send({ returnedTrxId: 'back-2', returnedBy: 'ops' }).expect(200);
    expect(res.body.refund).toEqual({ trx_id: 'tx-pending', returnTo: 'real-payer', amount: '5.000 HBD', returnedTrxId: 'back-2' });
    expect(await payments().findOne({ trx_id: 'tx-pending' })).toMatchObject({ refundStatus: 'returned', returnedBy: 'ops' });
  });

  test('settling twice is refused loudly, so nobody sends the money a second time', async () => {
    const res = await admin('post', '/advertise/admin/refunds/tx-done/settle').send({ returnedTrxId: 'again' }).expect(409);
    expect(res.body.error).toMatch(/Already returned .* back-1\. Do not send it again\./);
  });

  test('an unknown transaction is a 404', async () => {
    await admin('post', '/advertise/admin/refunds/nope/settle').send({ returnedTrxId: 'x' }).expect(404);
  });
});

describe('a database failure is a 500 that says nothing about why', () => {
  test.each([
    ['get', '/advertise/admin/applications', {}],
    ['post', '/advertise/admin/applications/0123456789abcdef01234567/decide', { decision: 'approved' }],
    ['get', '/advertise/admin/creatives', {}],
    ['post', '/advertise/admin/creatives/0123456789abcdef01234567/decide', { decision: 'approved' }],
    ['get', '/advertise/admin/inventory', {}],
    ['get', '/advertise/admin/advertisers/rates', {}],
    ['get', '/advertise/admin/advertisers/0123456789abcdef01234567/rates', {}],
    ['post', '/advertise/admin/advertisers/0123456789abcdef01234567/rates', { format: 'video_roll' }],
    ['get', '/advertise/admin/refunds', {}],
    ['post', '/advertise/admin/refunds/tx/settle', { returnedTrxId: 'x' }],
    ['post', '/advertise/admin/rates', { format: 'video_roll', ratePerSecondDayHbd: 1 }],
  ])('%s %s', async (method, path, body) => {
    fx.databaseFails();
    await admin(method, path).send(body).expect(500, { success: false, error: 'Internal server error' });
  });
});
