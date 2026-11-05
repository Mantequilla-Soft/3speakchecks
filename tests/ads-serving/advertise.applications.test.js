/**
 * routes/advertise.js, the advertiser's side: who may use the ad surfaces at all,
 * the application form, looking an application up again (by reference, or signed
 * for "everything of mine"), branding, discarding an unreviewed product, and the
 * public inventory figures. Ported from scripts/test-advertise.cjs (the beta gate).
 *
 * The stage is 'beta' here, as in production until launch: only ADS_BETA_USERS may
 * write. Hive signatures are real, the chain is fake.
 */
const request = require('supertest');
const fx = require('./_fixtures');

fx.useAdEnv({ ADS_STAGE: 'beta', ADS_BETA_USERS: 'meno,alice,bob' });
jest.mock('../../utils/hive', () => ({ ...jest.requireActual('../../utils/hive'), hiveRpcBatch: jest.fn() }));
const { hiveRpcBatch } = require('../../utils/hive');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const { hiveAccount, fakeHiveChain } = require('../helpers/hive');
const { ADVERTISERS_COLLECTION, AD_CAMPAIGNS_COLLECTION, AD_CREATIVES_COLLECTION, AD_INVENTORY_COLLECTION, AD_CATEGORIES } = require('../../utils/config');
const { FORMAT_KEYS } = require('../../utils/adFormats');

const app = buildApp(['/advertise', require('../../routes/advertise')]);
const db = testDb.use();
fx.freezeTime();

const meno = hiveAccount('meno');
const alice = hiveAccount('alice', { postingDelegates: ['threespeak'] });
const bob = hiveAccount('bob');
const threespeak = hiveAccount('threespeak');

beforeEach(() => {
  jest.setSystemTime(fx.NOW);
  fakeHiveChain([meno, alice, bob, threespeak]);
  // Every account asked about exists on Hive unless a test says otherwise.
  hiveRpcBatch.mockReset();
  hiveRpcBatch.mockImplementation(async ([call]) => [{ result: call.params[0].map((name) => ({ name })) }]);
});

const advertisers = () => db().collection(ADVERTISERS_COLLECTION);
const form = (over = {}) => ({
  hiveAccount: 'meno',
  projectName: 'Meno Exchange',
  contact: 'meno@example.com',
  category: 'exchange',
  creativeConcept: 'A fifteen second spot about swapping tokens cheaply.',
  website: 'https://meno.example',
  budgetHbd: 250,
  markets: ['de', 'US'],
  ...over,
});
const apply = (body, ip = fx.freshIp()) => request(app).post('/advertise/apply').set('X-Real-IP', ip).send(body);

describe('GET /advertise/access/:account', () => {
  test.each([
    ['a beta tester', 'meno', { account: 'meno', stage: 'beta', allowed: true }],
    ['anyone else', 'stranger', { account: 'stranger', stage: 'beta', allowed: false }],
    ['a name that cannot be a Hive account', 'X!', { account: null, allowed: false }],
  ])('%s', async (_label, name, want) => {
    const res = await request(app).get(`/advertise/access/${encodeURIComponent(name)}`).expect(200);
    expect(res.body).toMatchObject({ success: true, ...want });
    expect(res.headers['cache-control']).toBe('public, max-age=60');
  });

  test('answers "off" instead of 404ing when the feature is dark, and everyone once it is public', async () => {
    const off = buildApp(['/advertise', fx.isolatedModule('../../routes/advertise', { ADS_STAGE: 'off' })]);
    await request(off).get('/advertise/access/meno').expect(200, { success: true, account: 'meno', stage: 'off', allowed: false });
    const open = buildApp(['/advertise', fx.isolatedModule('../../routes/advertise', { ADS_STAGE: 'public' })]);
    expect((await request(open).get('/advertise/access/stranger')).body.allowed).toBe(true);
  });
});

describe('GET /advertise/has-product/:account', () => {
  test('no product and no graduation is no', async () => {
    const res = await request(app).get('/advertise/has-product/meno').expect(200);
    expect(res.body).toEqual({ success: true, account: 'meno', hasProduct: false, isAdvertiser: false });
  });

  test('a product on file makes the account an advertiser', async () => {
    await advertisers().insertOne(fx.advertiser({ hiveAccount: 'meno', status: 'pending' }));
    expect((await request(app).get('/advertise/has-product/meno')).body).toMatchObject({ hasProduct: true, isAdvertiser: true });
  });

  test('graduating from the advertiser warm-up counts too, without a product', async () => {
    await db().collection('incubation_contacts').insertOne({ hiveAccount: 'meno', email: 'private@example.com' });
    const res = await request(app).get('/advertise/has-product/meno').expect(200);
    expect(res.body).toMatchObject({ hasProduct: false, isAdvertiser: true });
    expect(JSON.stringify(res.body)).not.toMatch(/private@/);
  });

  test('an invalid name is a 400', async () => {
    await request(app).get('/advertise/has-product/A').expect(400);
  });
});

describe('POST /advertise/apply', () => {
  test('a complete application is filed as pending, on today\'s rate card', async () => {
    const res = await apply(form()).expect(201);
    expect(res.body).toMatchObject({ success: true, status: 'pending', reference: expect.stringMatching(/^[A-Za-z0-9_-]{12}$/) });

    const doc = await advertisers().findOne({ reference: res.body.reference });
    expect(doc).toMatchObject({
      hiveAccount: 'meno', hiveVerified: false, accountExists: true, status: 'pending', markets: ['DE', 'US'],
      budgetHbd: 250, production: null, reviewerNote: null, ratesSource: 'registration', ratesFrom: null,
    });
    expect(Object.keys(doc.rates).sort()).toEqual([...FORMAT_KEYS].sort());
  });

  test('a signed application is marked verified', async () => {
    const timestamp = Date.now();
    await apply(form({ timestamp, signature: meno.sign(`3speak-ads|apply|meno|${timestamp}`) })).expect(201);
    expect(await advertisers().findOne({ hiveAccount: 'meno' })).toMatchObject({ hiveVerified: true });
  });

  test.each([
    ['a signature by somebody else', () => ({ timestamp: Date.now(), signature: bob.sign(`3speak-ads|apply|meno|${Date.now()}`) }), 'Invalid signature'],
    ['a signature that is not one', () => ({ timestamp: Date.now(), signature: 'not-a-signature' }), 'Invalid signature'],
    ['a stale timestamp', () => {
      const timestamp = Date.now() - 10 * fx.MIN;
      return { timestamp, signature: meno.sign(`3speak-ads|apply|meno|${timestamp}`) };
    }, 'timestamp out of tolerance'],
    ['an unreadable timestamp', () => ({ timestamp: 'soon', signature: meno.sign('x') }), 'invalid timestamp'],
  ])('refuses %s with a 401 and files nothing', async (_label, sig, error) => {
    await apply(form(sig())).expect(401, { success: false, error });
    expect(await advertisers().countDocuments()).toBe(0);
  });

  test('outside the beta, the answer comes before any nit-picking of the form', async () => {
    const res = await apply({ hiveAccount: 'stranger' }).expect(403);
    expect(res.body.error).toMatch(/closed testing/);
  });

  test.each([
    ['no Hive account', { hiveAccount: '' }, /valid Hive account/],
    ['no project name', { projectName: ' ' }, /projectName is required/],
    ['no contact', { contact: '' }, /contact is required/],
    ['an unknown category', { category: 'casino' }, new RegExp(`one of: ${AD_CATEGORIES.join(', ')}`)],
    ['a pitch under 20 characters', { creativeConcept: 'Buy tokens' }, /at least 20 characters/],
    ['a website that is not a url', { website: 'meno.example' }, /must start with http/],
    ['a market that is not a country', { markets: ['DE', 'ZZ'] }, /Not a country code: ZZ/],
    ['a production request with no brief', { production: { requested: true, brief: 'make it' } }, /what the spot should say/],
  ])('refuses %s with a 400', async (_label, over, error) => {
    const res = await apply(form(over)).expect(400);
    expect(res.body.error).toMatch(error);
  });

  test('a Hive account that does not exist is refused; an RPC outage is not held against anyone', async () => {
    hiveRpcBatch.mockResolvedValueOnce([{ result: [] }]);
    await apply(form()).expect(400, { success: false, error: 'That Hive account does not exist' });

    hiveRpcBatch.mockResolvedValueOnce([]);
    const res = await apply(form()).expect(201);
    expect((await advertisers().findOne({ reference: res.body.reference })).accountExists).toBeNull();

    hiveRpcBatch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await apply(form({ hiveAccount: 'alice' })).expect(201);
  });

  test('one application under review at a time', async () => {
    const first = await apply(form()).expect(201);
    const second = await apply(form({ projectName: 'Another thing' })).expect(409);
    expect(second.body).toMatchObject({ reference: first.body.reference, status: 'pending' });
  });

  test('an approved advertiser may open another product, which inherits their current deal', async () => {
    const older = fx.advertiser({ hiveAccount: 'meno', status: 'approved', rates: { video_roll: 0.1 }, ratesSetAt: fx.ago(30 * fx.DAY) });
    const newer = fx.advertiser({ hiveAccount: 'meno', status: 'approved', rates: { video_roll: 0.05 }, ratesSetAt: fx.ago(fx.DAY) });
    const refused = fx.advertiser({ hiveAccount: 'meno', status: 'rejected', rates: { video_roll: 0.001 }, ratesSetAt: new Date(fx.NOW) });
    await advertisers().insertMany([older, newer, refused]);

    const res = await apply(form({ projectName: 'Second product' })).expect(201);
    expect(await advertisers().findOne({ reference: res.body.reference }))
      .toMatchObject({ rates: { video_roll: 0.05 }, ratesSource: 'inherited', ratesFrom: newer.reference });
  });

  test('a production request is kept with its brief, and money fields are cleaned', async () => {
    const brief = 'Show the app swapping two tokens in under a second.';
    const res = await apply(form({ production: { requested: true, brief }, budgetHbd: -40, markets: 'DE' })).expect(201);
    expect(await advertisers().findOne({ reference: res.body.reference }))
      .toMatchObject({ production: { requested: true, brief }, budgetHbd: 0, markets: [] });
  });

  test('three applications per address per ten minutes; refused forms do not count', async () => {
    const ip = fx.freshIp();
    await apply(form({ category: 'nope' }), ip).expect(400);
    for (const name of ['meno', 'alice', 'bob']) {
      await advertisers().deleteMany({});
      await apply(form({ hiveAccount: name }), ip).expect(201);
    }
    await apply(form({ hiveAccount: 'meno' }), ip).expect(429);
    fx.advance(10 * fx.MIN + 1);
    await advertisers().deleteMany({});
    await apply(form({ hiveAccount: 'meno' }), ip).expect(201);
  });
});

describe('GET /advertise/application/:reference', () => {
  test('shows the applicant their own record, and never the reviewer\'s private note', async () => {
    const doc = fx.advertiser({
      status: 'approved', applicantNote: 'Welcome aboard', reviewerNote: 'checked their exchange licence',
      production: { requested: true, brief: 'Make it bold' }, reviewedAt: fx.ago(fx.HOUR),
    });
    await advertisers().insertOne(doc);
    const res = await request(app).get(`/advertise/application/${doc.reference}`).expect(200);
    expect(res.body).toMatchObject({
      status: 'approved', note: 'Welcome aboard', production: { requested: true, brief: 'Make it bold' },
      logoUrl: doc.logoUrl, slogan: doc.slogan,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/licence|contact/);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('an unknown reference is a 404', async () => {
    await request(app).get('/advertise/application/nope').expect(404);
  });
});

describe('POST /advertise/mine', () => {
  const mine = (body) => request(app).post('/advertise/mine').send(body);
  const signedBy = (signer, account, word = 'mine', timestamp = Date.now()) => ({
    account, timestamp, signature: signer.sign(`3speak-ads|${word}|${account}|${timestamp}`),
  });

  beforeEach(async () => {
    await advertisers().insertMany([
      fx.advertiser({ hiveAccount: 'alice', reference: 'old-one', createdAt: fx.ago(9 * fx.DAY), reviewerNote: 'internal' }),
      fx.advertiser({ hiveAccount: 'alice', reference: 'new-one', createdAt: fx.ago(fx.DAY) }),
      fx.advertiser({ hiveAccount: 'bob', reference: 'bobs' }),
    ]);
  });

  test('the account\'s own signature lists its applications, newest first, without our notes', async () => {
    const res = await mine(signedBy(alice, 'alice')).expect(200);
    expect(res.body.applications.map((a) => a.reference)).toEqual(['new-one', 'old-one']);
    expect(JSON.stringify(res.body)).not.toMatch(/internal|contact/);
  });

  test('a signature from the @threespeak posting delegate works for HiveSigner and Butter Auth users', async () => {
    await mine(signedBy(threespeak, 'alice')).expect(200);
  });

  test('a vouch from 3Speak\'s API works without any posting grant', async () => {
    await mine({ ...signedBy(threespeak, 'bob', 'mine-vouch'), vouched: true }).expect(200);
  });

  test.each([
    ['a vouch signed by the user, not by 3Speak', () => ({ ...signedBy(bob, 'bob', 'mine-vouch'), vouched: true })],
    ['a user signature passed off as a vouch', () => ({ ...signedBy(bob, 'bob'), vouched: true })],
    ['a signature made for another account', () => ({ ...signedBy(alice, 'alice'), account: 'bob' })],
    ['a delegate the account never granted', () => signedBy(threespeak, 'bob')],
    ['a signature string that is not one', () => ({ ...signedBy(alice, 'alice'), signature: 'garbage' })],
  ])('refuses %s', async (_label, body) => {
    await mine(body()).expect(401, { success: false, error: 'Invalid signature' });
  });

  test('unsigned, it says exactly what to sign', async () => {
    const res = await mine({ account: 'alice' }).expect(401);
    expect(res.body.expected_message).toBe('3speak-ads|mine|alice|<ms>');
  });

  test('a stale signature is refused', async () => {
    await mine(signedBy(alice, 'alice', 'mine', Date.now() - 6 * fx.MIN)).expect(401, { success: false, error: 'timestamp out of tolerance' });
  });

  test('an account Hive has never heard of is a 404', async () => {
    const ghost = hiveAccount('ghost-acct');
    await mine(signedBy(ghost, 'ghost-acct')).expect(404);
  });

  test('an invalid account name is a 400', async () => {
    await mine({ account: '1x' }).expect(400);
  });

  test('with signatures switched off the list is open (development only)', async () => {
    const open = buildApp(['/advertise', fx.isolatedModule('../../routes/advertise', { HIVE_AUTH_REQUIRED: 'false' })]);
    expect((await request(open).post('/advertise/mine').send({ account: 'bob' }).expect(200)).body.applications).toHaveLength(1);
  });
});

describe('POST /advertise/branding', () => {
  const brand = (body) => request(app).post('/advertise/branding').send(body);
  let ref;
  beforeEach(async () => {
    const doc = fx.advertiser({ status: 'pending', logoUrl: 'https://acme.example/logo.png', slogan: 'Old slogan' });
    ref = doc.reference;
    await advertisers().insertOne(doc);
  });

  test('saves the slogan without touching the logo it was not sent', async () => {
    const res = await brand({ reference: ref, slogan: '  New slogan  ' }).expect(200);
    expect(res.body).toEqual({ success: true, logoUrl: 'https://acme.example/logo.png', slogan: 'New slogan' });
  });

  test('an empty string removes a field', async () => {
    expect((await brand({ reference: ref, logoUrl: '' }).expect(200)).body.logoUrl).toBeNull();
  });

  test.each([
    ['a logo that is not https', { logoUrl: 'http://acme.example/logo.png' }, 400],
    ['a slogan over 50 characters', { slogan: 'x'.repeat(51) }, 400],
    ['no reference', { reference: '' }, 400],
    ['a reference nobody holds', { reference: 'nope' }, 403],
  ])('refuses %s', async (_label, over, status) => {
    await brand({ reference: ref, ...over }).expect(status);
  });

  test('a rejected product cannot be rebranded', async () => {
    await advertisers().updateOne({ reference: ref }, { $set: { status: 'rejected' } });
    await brand({ reference: ref, slogan: 'Hi' }).expect(403);
  });
});

describe('POST /advertise/product/discard', () => {
  const discard = (reference) => request(app).post('/advertise/product/discard').send({ reference });

  test('removes an unreviewed product with its bookings and ad videos', async () => {
    const p = fx.placement({ advertiser: { status: 'pending' }, campaign: { paidHbd: 0, status: 'awaiting_payment' } });
    await fx.seed(db(), p.all);
    const res = await discard(p.advertiser.reference).expect(200);
    expect(res.body.discarded).toEqual({ product: 1, campaigns: 1, creatives: 1 });
    expect(await db().collection(AD_CAMPAIGNS_COLLECTION).countDocuments()).toBe(0);
    expect(await db().collection(AD_CREATIVES_COLLECTION).countDocuments()).toBe(0);
    expect(await advertisers().countDocuments()).toBe(0);
  });

  test('refuses once a reviewer has looked at it', async () => {
    const adv = fx.advertiser({ status: 'approved' });
    await advertisers().insertOne(adv);
    expect((await discard(adv.reference).expect(409)).body.error).toMatch(/already been reviewed/);
  });

  test('refuses once any booking has been paid for', async () => {
    const p = fx.placement({ advertiser: { status: 'pending' }, campaign: { paidHbd: 3 } });
    await fx.seed(db(), p.all);
    expect((await discard(p.advertiser.reference).expect(409)).body.error).toMatch(/paid for/);
    expect(await advertisers().countDocuments()).toBe(1);
  });

  test('no reference is a 400, an unknown one a 404', async () => {
    await discard('').expect(400);
    await discard('ghost').expect(404);
  });
});

describe('GET /advertise/inventory', () => {
  const snapshot = (over = {}) => ({
    _id: 'current', runAt: fx.ago(fx.HOUR), windowDays: 30,
    rules: { minEngagedSeconds: 3 },
    sellable: { sessionsPerDay: 12.5, sessions: 400, videos: 80, watchHours: 50, removedSessions: 100, removedPct: 20 },
    countries: [{ code: 'DE', sessions: 300, sharePct: 75 }],
    slots: [{ percent: 0, kind: 'pre-roll', perDay: 12, perMonth: 360, reachPct: 100, videos: 80, sessions: 360 }],
    excluded: { suspectAccounts: [{ owner: 'bot', sessions: 99 }], optedOutAccounts: ['secret-creator'] },
    audio: { measuredDays: 4, listensPerDay: 3, slots: [], countries: [] },
    uploads: { uploads: 9 },
    ...over,
  });

  test('is a 503 until the forecast has run', async () => {
    await request(app).get('/advertise/inventory').expect(503);
  });

  test('publishes the cleaned audience and the slots, never who was excluded', async () => {
    await db().collection(AD_INVENTORY_COLLECTION).insertOne(snapshot());
    const res = await request(app).get('/advertise/inventory').expect(200);
    expect(res.body).toMatchObject({
      audience: { sessionsPerDay: 12.5, sessionsPerWindow: 400, countries: [{ code: 'DE' }] },
      slots: [{ percent: 0, perDay: 12, reachPct: 100 }],
      trial: { active: false, owners: [] },
      audio: { measuredDays: 4, listensPerDay: 3 },
      uploads: { uploads: 9 },
      quality: { removedSessions: 100, removedPct: 20, minEngagedSeconds: 3 },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/bot|secret-creator/);
    expect(res.headers['cache-control']).toBe('public, max-age=900');
  });

  test('says so plainly while serving is restricted to a trial', async () => {
    const trial = buildApp(['/advertise', fx.isolatedModule('../../routes/advertise', { ADS_ALLOWED_OWNERS: 'badadib' })]);
    await db().collection(AD_INVENTORY_COLLECTION).insertOne(snapshot());
    const res = await request(trial).get('/advertise/inventory').expect(200);
    expect(res.body.trial).toMatchObject({ active: true, owners: ['badadib'] });
    expect(res.body.trial.note).toMatch(/@badadib/);
  });

  test('an old snapshot without the audio and upload audiences has them read live', async () => {
    await db().collection(AD_INVENTORY_COLLECTION).insertOne(snapshot({ audio: undefined, uploads: undefined }));
    const res = await request(app).get('/advertise/inventory').expect(200);
    expect(res.body.audio).toMatchObject({ listensPerDay: 0 });
    expect(res.body.uploads).toMatchObject({ uploads: 0 });
  });
});

describe('when the feature is switched off', () => {
  const off = () => buildApp(['/advertise', fx.isolatedModule('../../routes/advertise', { ADS_STAGE: 'off' })]);
  test.each([
    ['get', '/advertise/inventory'],
    ['post', '/advertise/apply'],
    ['get', '/advertise/application/x'],
    ['post', '/advertise/mine'],
    ['post', '/advertise/branding'],
    ['post', '/advertise/product/discard'],
  ])('%s %s is a 404', async (method, path) => {
    await request(off())[method](path).send({}).expect(404);
  });
});

describe('a database failure is a 500 that says nothing about why', () => {
  test.each([
    ['get', '/advertise/has-product/meno', undefined],
    ['get', '/advertise/inventory', undefined],
    ['post', '/advertise/apply', form()],
    ['get', '/advertise/application/x', undefined],
    ['post', '/advertise/branding', { reference: 'x' }],
    ['post', '/advertise/product/discard', { reference: 'x' }],
  ])('%s %s', async (method, path, body) => {
    fx.databaseFails('connection pool cleared');
    const res = await request(app)[method](path).set('X-Real-IP', fx.freshIp()).send(body).expect(500);
    expect(res.body).toEqual({ success: false, error: 'Internal server error' });
  });

  test('POST /advertise/mine (after a valid signature)', async () => {
    const timestamp = Date.now();
    const body = { account: 'bob', timestamp, signature: bob.sign(`3speak-ads|mine|bob|${timestamp}`) };
    fx.databaseFails();
    await request(app).post('/advertise/mine').send(body).expect(500);
  });
});
