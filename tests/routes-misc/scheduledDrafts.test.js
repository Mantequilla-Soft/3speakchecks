/**
 * Drafts and audio in the scheduled posts (routes/scheduledPosts.js and the cron,
 * services/scheduledPosts.js): a post saved as a draft has no time and is never
 * published until POST /publish gives it one; an audio post names its upload,
 * which is held back from every audio list until the cron publishes the post,
 * and its playlist add goes out in the post's own transaction.
 */
const dhive = require('@hiveio/dhive');

process.env.SCHEDULED_POSTS_RUNNER = 'true';
process.env.THREESPEAK_POSTING_KEY = dhive.PrivateKey.fromSeed('checker-tests:threespeak-drafts').toString();

jest.mock('../../utils/hive', () => ({ ...jest.requireActual('../../utils/hive'), hiveRpcBatch: jest.fn() }));

const request = require('supertest');
const { BroadcastAPI } = require('@hiveio/dhive/lib/helpers/broadcast');
const testDb = require('../helpers/db');
const { buildApp, apiKeyHeader } = require('../helpers/app');
const { hiveAccount, fakeHiveChain } = require('../helpers/hive');
const { pinClock, NOW } = require('./_fixtures');
const scheduled = require('../../services/scheduledPosts');

const db = testDb.use();
const app = buildApp(['/scheduled-posts', require('../../routes/scheduledPosts')]);
const queue = () => db().collection('scheduled-posts');
const audioRows = () => db().collection('embed-audio');

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const at = (ms) => new Date(NOW.getTime() + ms).toISOString();

const badadib = hiveAccount('badadib', { postingDelegates: ['threespeak'] });
const fan = hiveAccount('fan');
let broadcasts;

beforeEach(() => {
  pinClock();
  fakeHiveChain([badadib, fan]);
  broadcasts = [];
  jest.spyOn(BroadcastAPI.prototype, 'sendOperations').mockImplementation(async (ops) => {
    broadcasts.push(ops);
    return { id: `tx${broadcasts.length}` };
  });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  delete process.env.SCHEDULED_POSTS_REQUIRE_SIGNATURE;
});

const post = (path, body) => request(app).post(`/scheduled-posts/${path}`).set(apiKeyHeader()).send(body);
const draftBody = (extra = {}) => ({
  owner: 'badadib', permlink: 'my-episode', draft: true, title: 'Episode 5', description: 'notes', body: 'https://audio.3speak.tv/play?a=a-ep5\n\nnotes',
  jsonMetadata: { app: 'new-3speak-tv', tags: ['podcast'], audio: { type: 'podcast', season: 2, episode: 5 } },
  ...extra,
});

describe('saving a draft', () => {
  test('a draft has no time and the status "draft", and is listed under status=draft', async () => {
    const res = await post('create', draftBody()).expect(201);
    expect(res.body).toMatchObject({ success: true, status: 'draft', scheduledOn: null });
    const doc = await queue().findOne({ permlink: 'my-episode' });
    expect(doc).toMatchObject({ status: 'draft', scheduledOn: null, owner: 'badadib' });

    const list = await request(app).get('/scheduled-posts/badadib?status=draft').expect(200);
    expect(list.body.scheduled_posts.map((p) => [p.permlink, p.status, p.kind])).toEqual([['my-episode', 'draft', 'video']]);
    const sched = await request(app).get('/scheduled-posts/badadib?status=scheduled').expect(200);
    expect(sched.body.count).toBe(0);
  });

  test('a draft still needs the @threespeak grant (the cron publishes it later)', async () => {
    await post('create', draftBody({ owner: 'fan' })).expect(403);
  });

  test('signed drafts carry the draft message, not a create with a time', async () => {
    process.env.SCHEDULED_POSTS_REQUIRE_SIGNATURE = 'true';
    const ts = NOW.getTime();
    const good = badadib.sign(`scheduled-post|draft|badadib|my-episode|${ts}`);
    const createShaped = badadib.sign(`scheduled-post|create|badadib|my-episode|undefined|${ts}`);
    await post('create', draftBody({ signature: createShaped, timestamp: ts })).expect(401);
    await post('create', draftBody({ signature: good, timestamp: ts })).expect(201);
  });

  test('the cron never publishes a draft', async () => {
    await post('create', draftBody()).expect(201);
    await scheduled.runOnce();
    expect(broadcasts).toHaveLength(0);
    expect((await queue().findOne({ permlink: 'my-episode' })).status).toBe('draft');
  });

  test('a draft can be edited (and keeps no time) and deleted', async () => {
    await post('create', draftBody()).expect(201);
    await post('update', { owner: 'badadib', permlink: 'my-episode', updates: { title: 'Episode five', scheduledOn: at(DAY) } }).expect(200);
    expect(await queue().findOne({ permlink: 'my-episode' })).toMatchObject({ title: 'Episode five', status: 'draft', scheduledOn: null });
    await post('cancel', { owner: 'badadib', permlink: 'my-episode' }).expect(200);
    expect((await queue().findOne({ permlink: 'my-episode' })).status).toBe('cancelled');
  });
});

describe('POST /scheduled-posts/publish', () => {
  test('now: the draft becomes due at once and the cron publishes it on its next run', async () => {
    await post('create', draftBody()).expect(201);
    const res = await post('publish', { owner: 'badadib', permlink: 'my-episode', scheduledOn: NOW.toISOString() }).expect(200);
    expect(res.body).toMatchObject({ success: true, status: 'scheduled', scheduledOn: NOW.toISOString() });
    await scheduled.runOnce();
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0][0]).toEqual(['comment', expect.objectContaining({ author: 'badadib', permlink: 'my-episode', title: 'Episode 5' })]);
    expect((await queue().findOne({ permlink: 'my-episode' })).status).toBe('posted');
  });

  test('later: a time between 5 minutes and 90 days; nothing else', async () => {
    await post('create', draftBody()).expect(201);
    await post('publish', { owner: 'badadib', permlink: 'my-episode', scheduledOn: at(2 * MIN) }).expect(422);
    await post('publish', { owner: 'badadib', permlink: 'my-episode', scheduledOn: at(91 * DAY) }).expect(422);
    await post('publish', { owner: 'badadib', permlink: 'my-episode', scheduledOn: 'tomorrow' }).expect(422);
    await post('publish', { owner: 'badadib', permlink: 'my-episode', scheduledOn: at(DAY) }).expect(200);
    expect(await queue().findOne({ permlink: 'my-episode' })).toMatchObject({ status: 'scheduled', scheduledOn: new Date(at(DAY)) });
  });

  test('only a draft can be published this way', async () => {
    await post('publish', { owner: 'badadib', permlink: 'nothing', scheduledOn: NOW.toISOString() }).expect(404);
    await post('create', { ...draftBody(), draft: false, scheduledOn: at(DAY) }).expect(201);
    await post('publish', { owner: 'badadib', permlink: 'my-episode', scheduledOn: NOW.toISOString() }).expect(404);
  });

  test('signed: the publish message names the time', async () => {
    process.env.SCHEDULED_POSTS_REQUIRE_SIGNATURE = 'true';
    const ts = NOW.getTime();
    await queue().insertOne({ owner: 'badadib', permlink: 'my-episode', status: 'draft', scheduledOn: null, createdAt: NOW });
    const when = at(DAY);
    await post('publish', { owner: 'badadib', permlink: 'my-episode', scheduledOn: when, timestamp: ts, signature: badadib.sign(`scheduled-post|publish|badadib|my-episode|${at(2 * DAY)}|${ts}`) }).expect(401);
    await post('publish', { owner: 'badadib', permlink: 'my-episode', scheduledOn: when, timestamp: ts, signature: badadib.sign(`scheduled-post|publish|badadib|my-episode|${when}|${ts}`) }).expect(200);
  });
});

describe('audio posts', () => {
  const upload = (extra = {}) => audioRows().insertOne({
    owner: 'badadib', permlink: 'a-ep5', status: 'published', post_permlink: null, audio_cid: 'bafyaudio', createdAt: NOW, ...extra,
  });

  test('the upload is held back while the post waits, then linked and shown when it is out', async () => {
    await upload();
    await post('create', draftBody({ audioPermlink: 'a-ep5', playlistAdd: { playlist_id: 'pl-podcast-0001', position: 0 } })).expect(201);
    expect(await audioRows().findOne({ permlink: 'a-ep5' })).toMatchObject({ status: 'scheduled', scheduled_post: 'my-episode' });
    const list = await request(app).get('/scheduled-posts/badadib?status=draft').expect(200);
    expect(list.body.scheduled_posts[0].kind).toBe('audio');

    await post('publish', { owner: 'badadib', permlink: 'my-episode', scheduledOn: NOW.toISOString() }).expect(200);
    await scheduled.runOnce();

    // The playlist add rides in the post's own transaction, as the owner.
    expect(broadcasts).toHaveLength(1);
    const ops = broadcasts[0];
    expect(ops.map((o) => o[0])).toEqual(['comment', 'comment_options', 'custom_json']);
    expect(ops[2][1]).toMatchObject({ id: '3speak_playlist_add', required_posting_auths: ['badadib'] });
    expect(JSON.parse(ops[2][1].json)).toEqual({ playlist_id: 'pl-podcast-0001', author: 'badadib', permlink: 'my-episode', position: 0 });

    const row = await audioRows().findOne({ permlink: 'a-ep5' });
    expect(row).toMatchObject({ status: 'published', post_permlink: 'my-episode', post_author: 'badadib' });
    expect(row.scheduled_post).toBeUndefined();
  });

  test('an upload already linked to a post is neither held nor relinked', async () => {
    await upload({ post_permlink: 'older-post' });
    await post('create', draftBody({ audioPermlink: 'a-ep5', draft: false, scheduledOn: at(DAY) })).expect(201);
    expect(await audioRows().findOne({ permlink: 'a-ep5' })).toMatchObject({ status: 'published', post_permlink: 'older-post' });
  });

  test('bad audio fields are refused', async () => {
    await post('create', draftBody({ audioPermlink: 'Bad Permlink' })).expect(422);
    await post('create', draftBody({ playlistAdd: { playlist_id: 'x' } })).expect(422);
  });

  test('buildOperations: no playlist op without playlistAdd', () => {
    const ops = scheduled.buildOperations({ owner: 'badadib', permlink: 'p', title: 't', body: 'b', jsonMetadata: {} });
    expect(ops.map((o) => o[0])).toEqual(['comment', 'comment_options']);
  });
});
