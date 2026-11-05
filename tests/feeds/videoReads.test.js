/**
 * The single-video read endpoints in routes/videos.js, against a real MongoDB:
 *   GET  /api/video/:owner/:permlink           the "reusable" flag
 *   POST /views                                 batch view counts
 *   GET  /videodetails/:author/:permlink        the watch page's video doc
 *   GET  /transcription-tags/:author/:permlink  the tagger's output
 *   POST /transcription-tags/ai-batch           which cards get the AI badge
 */
jest.mock('../../utils/hive', () => require('./_hiveMock').create());

const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const F = require('./_fixtures');
const hive = require('../../utils/hive');

const db = testDb.use();
const app = buildApp(['/', require('../../routes/videos')]);
const videos = () => db().collection('videos');
const embeds = () => db().collection('embed-video');

beforeEach(async () => {
  F.pinClock();
  hive.__reset();
  await F.resetFeedCaches(db());
});
afterEach(() => jest.useRealTimers());

describe('GET /api/video/:owner/:permlink (reusable)', () => {
  test('a legacy video answers from its own flag, by 3Speak permlink or by Hive permlink', async () => {
    await videos().insertMany([
      F.legacyVideo({ owner: 'leg', permlink: 'asset', reusable: true, embed_url: '@leg/the-hive-post' }),
      F.legacyVideo({ owner: 'leg', permlink: 'plain' }),
    ]);

    expect((await request(app).get('/api/video/leg/asset').expect(200)).body).toEqual({ success: true, reusable: true });
    expect((await request(app).get('/api/video/leg/the-hive-post').expect(200)).body.reusable).toBe(true);
    expect((await request(app).get('/api/video/leg/plain').expect(200)).body.reusable).toBe(false);
  });

  test('an embed video reads the flag from its Hive post, once per half hour', async () => {
    await embeds().insertOne(F.embedVideo({ owner: 'em', permlink: 'asset-e', embed_url: '@em/post-e' }));
    hive.__state.rpc.push([{ result: { json_metadata: JSON.stringify({ video: { reusable: true } }) } }]);

    const first = await request(app).get('/api/video/em/asset-e').expect(200);
    const again = await request(app).get('/api/video/em/post-e').expect(200);   // same post, by Hive permlink

    expect(first.body).toEqual({ success: true, reusable: true });
    expect(again.body.reusable).toBe(true);
    const rpcCalls = hive.__state.calls.filter(([name]) => name === 'hiveRpcBatch');
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0][1][0].params).toEqual(['em', 'post-e']);
  });

  test('a Hive failure or a post without the flag reads as not reusable', async () => {
    await embeds().insertMany([
      F.embedVideo({ owner: 'em', permlink: 'a1', embed_url: '@em/p1' }),
      F.embedVideo({ owner: 'em', permlink: 'a2', embed_url: '@em/p2' }),
    ]);
    hive.__state.rpc.push(new Error('node down'), [{ result: { json_metadata: '{"reusable":false}' } }]);

    expect((await request(app).get('/api/video/em/a1').expect(200)).body.reusable).toBe(false);
    expect((await request(app).get('/api/video/em/a2').expect(200)).body.reusable).toBe(false);
  });

  test('an unknown video is a 404', async () => {
    expect((await request(app).get('/api/video/nobody/nothing').expect(404)).body).toEqual({ success: false, error: 'Video not found' });
  });
});

describe('POST /views', () => {
  test.each([
    [{}, 'videos array is required'],
    [{ videos: 'x' }, 'videos array is required'],
    [{ videos: Array.from({ length: 51 }, (_, i) => ({ author: 'a', permlink: `p${i}` })) }, 'Maximum 50 videos per request'],
    [{ videos: [{ author: 'a' }] }, 'Each video must have author and permlink'],
  ])('rejects %j', async (body, message) => {
    const res = await request(app).post('/views').send(body).expect(400);
    expect(res.body.message).toBe(message);
  });

  test('legacy counts, embed counts by Hive pair, and null for an unknown video', async () => {
    await videos().insertOne(F.legacyVideo({ owner: 'leg', permlink: 'views-l', views: 12 }));
    await embeds().insertOne(F.embedVideo({ owner: 'em', permlink: 'views-e', views: 7 }));

    const res = await request(app).post('/views').send({ videos: [
      { author: 'leg', permlink: 'views-l' },
      { author: 'em', permlink: 'hive-views-e' },
      { author: 'ghost', permlink: 'views-x' },
    ] }).expect(200);

    expect(res.body).toEqual({ success: true, data: { 'leg/views-l': 12, 'em/hive-views-e': 7, 'ghost/views-x': null } });
  });

  test('a count is cached for five minutes', async () => {
    await videos().insertOne(F.legacyVideo({ owner: 'leg', permlink: 'views-cached', views: 1 }));
    const body = { videos: [{ author: 'leg', permlink: 'views-cached' }] };
    await request(app).post('/views').send(body).expect(200);
    await videos().updateOne({ permlink: 'views-cached' }, { $set: { views: 999 } });

    expect((await request(app).post('/views').send(body).expect(200)).body.data['leg/views-cached']).toBe(1);
    F.advanceClock(5 * 60 * 1000);
    expect((await request(app).post('/views').send(body).expect(200)).body.data['leg/views-cached']).toBe(999);
  });
});

describe('GET /videodetails/:author/:permlink', () => {
  test('returns the legacy doc, defaulting mantecurated to false', async () => {
    await videos().insertOne(F.legacyVideo({ owner: 'leg', permlink: 'd1', body: 'full body' }));
    const res = await request(app).get('/videodetails/leg/d1').expect(200);
    expect(res.body).toMatchObject({ owner: 'leg', permlink: 'd1', body: 'full body', mantecurated: false });
  });

  test('finds an embed video by asset permlink or Hive pair', async () => {
    await embeds().insertOne(F.embedVideo({ owner: 'em', permlink: 'd2', mantecurated: true }));
    expect((await request(app).get('/videodetails/em/d2').expect(200)).body.mantecurated).toBe(true);
    expect((await request(app).get('/videodetails/em/hive-d2').expect(200)).body.permlink).toBe('d2');
  });

  test('a banned video is not found', async () => {
    await videos().insertOne(F.legacyVideo({ owner: 'leg', permlink: 'banned', banned: true }));
    expect((await request(app).get('/videodetails/leg/banned').expect(404)).body).toEqual({ error: 'Video not found' });
  });

  test('a moderation-hidden creator\'s watch page is blocked, even through an uploader alias', async () => {
    await F.hideCreator(db(), 'hush');
    await videos().insertOne(F.legacyVideo({ owner: 'hush', permlink: 'h' }));
    await embeds().insertOne(F.embedVideo({ owner: 'uploader', hive_author: 'hush', permlink: 'via-app' }));

    expect((await request(app).get('/videodetails/hush/h').expect(404)).body).toEqual({ error: 'This video is not available', hidden: true });
    expect((await request(app).get('/videodetails/uploader/via-app').expect(404)).body.hidden).toBe(true);
  });
});

describe('GET /transcription-tags/:author/:permlink', () => {
  test('a legacy video reads its tags directly', async () => {
    await db().collection('subtitles-tags').insertOne({ author: 'leg', permlink: 'l1', tags: 'Music, art', tags_list_v2: ['music'], ai_generated_v2: true });
    const res = await request(app).get('/transcription-tags/@Leg/l1').expect(200);
    expect(res.body).toMatchObject({ success: true, author: 'leg', tags: ['music', 'art'], tagsV2: ['music'], resolvedVia: 'direct', aiGenerated: true });
  });

  test('an embed video is resolved from its Hive permlink to the asset', async () => {
    await embeds().insertOne(F.embedVideo({ owner: 'em', permlink: 'asset-z' }));
    await db().collection('subtitles-tags').insertOne({ author: 'em', permlink: 'asset-z', tags: 'food', tags_v2: 'food,travel' });
    const res = await request(app).get('/transcription-tags/em/hive-asset-z').expect(200);
    expect(res.body).toMatchObject({ assetPermlink: 'asset-z', resolvedVia: 'embed', tags: ['food'], tagsV2: ['food', 'travel'], aiGenerated: false });
  });

  test('a video nobody tagged is an empty 200', async () => {
    const res = await request(app).get('/transcription-tags/x/y').expect(200);
    expect(res.body).toMatchObject({ tags: [], resolvedVia: 'none' });
  });

  test('an empty author is a 400', async () => {
    await request(app).get('/transcription-tags/@/y').expect(400);
  });
});

describe('POST /transcription-tags/ai-batch', () => {
  test('flags AI-generated videos addressed by Hive pair or by owner + asset', async () => {
    await embeds().insertOne(F.embedVideo({ owner: 'em', permlink: 'ai-asset' }));
    await db().collection('subtitles-tags').insertMany([
      { author: 'em', permlink: 'ai-asset', ai_generated_v2: true },
      { author: 'leg', permlink: 'human', ai_generated_v2: false },
    ]);

    const res = await request(app).post('/transcription-tags/ai-batch')
      .send({ keys: ['em/hive-ai-asset', 'leg/human', 'nonsense', 'em/ai-asset'] }).expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.flagged.sort()).toEqual(['em/ai-asset', 'em/hive-ai-asset']);
  });

  test('no keys, no flags', async () => {
    expect((await request(app).post('/transcription-tags/ai-batch').send({}).expect(200)).body).toEqual({ success: true, flagged: [] });
  });
});
