/**
 * routes/viewerTags.js: the topic label a viewer picks next to their vote, and the
 * per-video consensus that merges viewer weights with the transcription tagger's
 * auto tags.
 *
 * The consensus is computed by a real aggregation, so it runs against MongoDB.
 */
const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const { pinClock, NOW } = require('./_fixtures');

const db = testDb.use();
const app = buildApp(['/', require('../../routes/viewerTags')]);
const tags = () => db().collection('viewer-tags');

afterEach(() => jest.useRealTimers());

const vote = (body) => request(app).post('/viewer-tag').send({ author: 'bob', permlink: 'vid', tag: 'music', ...body });

describe('recording a viewer tag', () => {
  test('stores the canonical tag with the vote weight under one id per voter and video', async () => {
    pinClock();
    const res = await vote({ username: '@Alice', author: '@Bob', tag: ' #MUSIC ', weight: '7500' }).expect(200);

    expect(res.body).toEqual({ success: true, 'viewer-tag': 'music' });
    expect(await tags().find().toArray()).toEqual([{
      _id: 'alice:bob:vid', voter: 'alice', author: 'bob', permlink: 'vid',
      'viewer-tag': 'music', weight: 7500, updatedAt: NOW, createdAt: NOW,
    }]);
  });

  test('re-voting with a new tag overwrites the old one and keeps createdAt', async () => {
    pinClock(NOW);
    await vote({ username: 'alice', tag: 'music' }).expect(200);
    const later = pinClock(new Date(NOW.getTime() + 3_600_000));
    await vote({ username: 'alice', tag: 'finance' }).expect(200);

    const rows = await tags().find().toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ 'viewer-tag': 'finance', createdAt: NOW, updatedAt: later });
  });

  test('accepts voter/owner as synonyms and stores a non-numeric weight as null', async () => {
    await request(app).post('/viewer-tag').send({ voter: 'alice', owner: 'bob', permlink: 'vid', tag: 'music', weight: 'lots' }).expect(200);
    expect(await tags().findOne()).toMatchObject({ voter: 'alice', author: 'bob', weight: null });
  });

  test.each([
    [{ username: '', author: 'bob', permlink: 'vid' }],
    [{ username: 'alice', author: '', permlink: 'vid' }],
    [{ username: 'alice', author: 'bob', permlink: '   ' }],
  ])('a missing identity field %j is a 400', async (body) => {
    const res = await request(app).post('/viewer-tag').send({ tag: 'music', ...body }).expect(400);
    expect(res.body.error).toBe('username, author and permlink are required');
    expect(await tags().countDocuments()).toBe(0);
  });

  test.each(['', 'not-a-topic', '<script>', 'MUSIC!'])('a tag outside the taxonomy (%p) is a 400 that lists the allowed tags', async (tag) => {
    const res = await vote({ username: 'alice', tag }).expect(400);
    expect(res.body.error).toBe('tag must be one of the interest taxonomy');
    expect(res.body.allowed).toEqual(expect.arrayContaining(['music', 'finance', 'tech-science']));
    expect(await tags().countDocuments()).toBe(0);
  });

  // SECURITY: this endpoint takes no signature (by design, see the file header), but the
  // header's premise that it "can't affect anyone else's experience" does not hold:
  // services/discoverWorker.js and utils/effectiveTags.js read these weights to pick the
  // winning topic of a video for everybody. Because `weight` is taken verbatim, one
  // unsigned request can outweigh every real voter and every auto tag (each auto tag is
  // worth 10000). A Hive vote weight is at most 10000, so anything above it should be
  // refused or clamped. (routes/viewerTags.js:155)
  test('an unsigned caller can store an unbounded weight that outvotes everyone', async () => {
    const res = await vote({ username: 'mallory', weight: 1e12 });
    if (res.status === 200) {
      expect(Math.abs((await tags().findOne({ voter: 'mallory' })).weight)).toBeLessThanOrEqual(10000);
    } else {
      expect(res.status).toBe(400);
    }
  });
  test('a stored weight beyond a full vote (a row from before the clamp) counts as one full vote', async () => {
    await tags().insertMany([
      { _id: 'mallory:bob:vid', voter: 'mallory', author: 'bob', permlink: 'vid', 'viewer-tag': 'music', weight: 1e12 },
      { _id: 'alice:bob:vid', voter: 'alice', author: 'bob', permlink: 'vid', 'viewer-tag': 'finance', weight: 10000 },
      { _id: 'carol:bob:vid', voter: 'carol', author: 'bob', permlink: 'vid', 'viewer-tag': 'finance', weight: 500 },
    ]);
    const res = await request(app).get('/viewer-tags/bob/vid').expect(200);
    expect(res.body.winner).toBe('finance');
    expect(res.body.counts.find((c) => c.tag === 'music')).toMatchObject({ weight: 10000, voters: [{ voter: 'mallory', weight: 10000 }] });
  });
});

describe('has this viewer already tagged the video', () => {
  test('returns the tag when there is one', async () => {
    await tags().insertOne({ _id: 'alice:bob:vid', voter: 'alice', author: 'bob', permlink: 'vid', 'viewer-tag': 'music' });
    const res = await request(app).get('/viewer-tag/mine/@ALICE/Bob/vid').expect(200);
    expect(res.body).toEqual({ success: true, tagged: true, tag: 'music' });
  });

  test('says no for a video the viewer never tagged', async () => {
    const res = await request(app).get('/viewer-tag/mine/alice/bob/other').expect(200);
    expect(res.body).toEqual({ success: true, tagged: false, tag: null });
  });

  test('a blank permlink is a 400', async () => {
    await request(app).get('/viewer-tag/mine/alice/bob/%20').expect(400);
  });
});

describe('the consensus for one video', () => {
  const row = (voter, tag, weight, extra = {}) => ({
    _id: `${voter}:bob:vid`, voter, author: 'bob', permlink: 'vid', 'viewer-tag': tag, weight, ...extra,
  });

  test('sums vote weights per tag, lists voters heaviest first and picks the heaviest tag', async () => {
    await tags().insertMany([
      row('alice', 'music', 6000),
      row('carol', 'music', 2000),
      row('dave', 'finance', 9000),
      { ...row('erin', 'finance', 100), permlink: 'other-video', _id: 'erin:bob:other' },
    ]);

    const res = await request(app).get('/viewer-tags/bob/vid').expect(200);

    expect(res.body).toMatchObject({
      success: true, author: 'bob', permlink: 'vid', total: 3, totalWeight: 17000,
      autoTags: [], autoTagsV1: [], autoTagModelV2: null, winner: 'finance',
    });
    expect(res.body.counts).toEqual([
      { tag: 'finance', weight: 9000, count: 1, auto: false, pct: 52.9, voters: [{ voter: 'dave', weight: 9000 }] },
      { tag: 'music', weight: 8000, count: 2, auto: false, pct: 47.1,
        voters: [{ voter: 'alice', weight: 6000 }, { voter: 'carol', weight: 2000 }] },
    ]);
  });

  test('a missing, zero or negative weight still counts as a vote of at least 1', async () => {
    await tags().insertMany([row('alice', 'music', null), row('carol', 'music', 0), row('dave', 'music', -500)]);
    const res = await request(app).get('/viewer-tags/bob/vid').expect(200);
    expect(res.body.counts[0]).toMatchObject({ tag: 'music', weight: 502, count: 3 });
  });

  test('each v2 auto tag adds a full 10000 vote, and v1 tags are reported but never counted', async () => {
    await db().collection('subtitles-tags').insertOne({
      author: 'bob', permlink: 'vid', tags: 'news,travel', tags_list_v2: ['Music', 'technology'], tag_model_v2: 'tagger-v2',
    });
    await tags().insertOne(row('alice', 'music', 5000));

    const res = await request(app).get('/viewer-tags/bob/vid').expect(200);

    expect(res.body).toMatchObject({
      total: 1, totalWeight: 25000, autoTags: ['music', 'technology'], autoTagsV1: ['news', 'travel'],
      autoTagModelV2: 'tagger-v2', winner: 'music',
    });
    expect(res.body.counts.map((c) => [c.tag, c.weight, c.count, c.auto, c.pct])).toEqual([
      ['music', 15000, 1, true, 60],
      ['technology', 10000, 0, true, 40],
    ]);
  });

  test('an embed video finds its auto tags through the hive permlink to asset permlink mapping', async () => {
    await db().collection('embed-video').insertOne({ owner: 'bob', permlink: 'asset-1', hive_author: 'bob', hive_permlink: 'vid' });
    await db().collection('subtitles-tags').insertOne({ author: 'bob', permlink: 'asset-1', tags_v2: 'gaming' });
    const res = await request(app).get('/viewer-tags/bob/vid').expect(200);
    expect(res.body.autoTags).toEqual(['gaming']);
    expect(res.body.winner).toBe('gaming');
  });

  test('equal weights fall back to voter count, then to the tag name', async () => {
    await tags().insertMany([
      row('a1', 'zen', 1000), row('a2', 'beta', 1000), row('a3', 'alpha', 500), row('a4', 'alpha', 500),
    ]);
    const res = await request(app).get('/viewer-tags/bob/vid').expect(200);
    expect(res.body.counts.map((c) => c.tag)).toEqual(['alpha', 'beta', 'zen']);
  });

  test('caps the voter list of a tag at the 60 heaviest', async () => {
    await tags().insertMany(Array.from({ length: 70 }, (_, i) => row(`v${i}`, 'music', i + 1)));
    const res = await request(app).get('/viewer-tags/bob/vid').expect(200);
    const { voters, count } = res.body.counts[0];
    expect(count).toBe(70);
    expect(voters).toHaveLength(60);
    expect(voters[0]).toEqual({ voter: 'v69', weight: 70 });
    expect(voters[59].weight).toBe(11);
  });

  test('a video nobody tagged has no winner and no division by zero', async () => {
    const res = await request(app).get('/viewer-tags/bob/untagged').expect(200);
    expect(res.body).toMatchObject({ total: 0, totalWeight: 1, winner: null, counts: [] });
  });

  test('a blank permlink is a 400', async () => {
    await request(app).get('/viewer-tags/bob/%20').expect(400);
  });
});

describe('when the database fails', () => {
  const { Collection } = require('mongodb');
  test.each([
    ['post', '/viewer-tag', { username: 'a', author: 'b', permlink: 'p', tag: 'music' }, 'updateOne'],
    ['get', '/viewer-tag/mine/a/b/p', undefined, 'findOne'],
    ['get', '/viewer-tags/b/p', undefined, 'aggregate'],
  ])('%s %s answers a generic 500', async (method, path, body, op) => {
    jest.spyOn(Collection.prototype, op).mockImplementation(() => { throw new Error('boom'); });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app)[method](path).send(body).expect(500);
    expect(res.body).toEqual({ success: false, error: 'Internal server error' });
  });
});
