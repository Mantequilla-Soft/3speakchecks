/**
 * GET /search and GET /search/suggest (routes/search.js) against a real MongoDB
 * with the app's own text indexes (config/search-weights.json).
 *
 * Search spans legacy videos, embed videos, shorts, audio, communities, profiles,
 * public playlists, plus a join from the tagger's AI tags. It must hide what the
 * feeds hide (unlisted, author-hidden, unavailable, NSFW unless opted in,
 * moderation-hidden creators), then rank by text score with mild popularity and
 * optional recency boosts.
 */
jest.mock('../../utils/hive', () => require('./_hiveMock').create());

const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const F = require('./_fixtures');
const searchWeights = require('../../config/search-weights.json');

const db = testDb.use();
const app = buildApp(['/search', require('../../routes/search')]);
const search = (query) => request(app).get('/search').query(query);
const suggest = (q) => request(app).get('/search/suggest').query({ q });
const col = (name) => db().collection(name);

// connectToMongo starts the text index builds in the background; make sure they
// exist before the first $text query (same spec, so this is a no-op or a wait).
beforeAll(async () => {
  for (const cfg of Object.values(searchWeights)) {
    const fields = Object.fromEntries(Object.keys(cfg.fields).map((f) => [f, 'text']));
    const opts = { name: cfg.indexName, weights: cfg.fields };
    if (cfg.languageOverride) opts.language_override = cfg.languageOverride;
    await col(cfg.collection).createIndex(fields, opts);
  }
});

beforeEach(async () => {
  F.pinClock();
  await F.resetFeedCaches(db());
});
afterEach(() => jest.useRealTimers());

const keys = (results) => results.map((r) => `${r.type}:${r.permlink || r.username || r.name}`);

describe('input', () => {
  test.each([[{}], [{ q: '   ' }]])('a missing query %j is a 400', async (query) => {
    expect((await search(query).expect(400)).body).toEqual({ success: false, error: 'Query parameter "q" is required' });
  });
});

describe('what search finds', () => {
  beforeEach(async () => {
    await col('videos').insertOne(F.legacyVideo({ owner: 'prof', permlink: 'qm-legacy', title: 'Quantum physics explained', views: 10 }));
    await col('embed-video').insertMany([
      F.embedVideo({ owner: 'lab', permlink: 'qm-embed', hive_title: 'Quantum computing today' }),
      F.shortVideo({ owner: 'clipper', permlink: 'qm-short', hive_title: 'Quantum in 60 seconds' }),
    ]);
    await col('embed-audio').insertOne({ owner: 'pod', permlink: 'qm-audio', title: 'Quantum podcast', tags: 'science, physics', createdAt: F.hoursAgo(1) });
    await col('hivecommunities').insertOne({ name: 'hive-100100', title: 'Quantum Club', about: 'physics', subscribers: 5 });
    await col('hiveprofiles').insertOne({ username: 'quantumgirl', display_name: 'Quantum Girl', about: 'I like physics' });
    await col('playlists').insertMany([
      { name: 'Quantum favourites', owner: 'prof', access: 'public', items: [{}, {}], created_at: F.hoursAgo(1) },
      { name: 'Quantum private', owner: 'prof', access: 'private', items: [] },
      { name: 'Watch Later', owner: 'prof', access: 'public', tags: ['quantum'], items: [] },
    ]);
  });

  test('every content type, each in its own card shape', async () => {
    const res = await search({ q: 'quantum' }).expect(200);

    expect(res.body).toMatchObject({ success: true, query: 'quantum', sort: 'relevance', page: 1, limit: 20, total: 7 });
    expect(keys(res.body.results).sort()).toEqual([
      'audio:qm-audio', 'community:hive-100100', 'playlist:Quantum favourites', 'short:qm-short',
      'user:quantumgirl', 'video:hive-qm-embed', 'video:qm-legacy',
    ].sort());
    const byType = Object.fromEntries(res.body.results.map((r) => [r.type, r]));
    expect(byType.audio.tags).toEqual(['science', 'physics']);
    expect(byType.playlist).toMatchObject({ video_count: 2, owner: 'prof' });
    expect(byType.short).toMatchObject({ permlink: 'qm-short', embed_url: '@clipper/snap-qm-short' });
  });

  test.each([
    ['video', ['video:hive-qm-embed', 'video:qm-legacy']],
    ['short', ['short:qm-short']],
    ['audio', ['audio:qm-audio']],
    ['user,community', ['community:hive-100100', 'user:quantumgirl']],
    ['playlist', ['playlist:Quantum favourites']],
  ])('type=%s narrows the results', async (type, expected) => {
    const res = await search({ q: 'quantum', type }).expect(200);
    expect(keys(res.body.results).sort()).toEqual(expected);
  });

  test('matches are highlighted unless highlight=false', async () => {
    const res = await search({ q: 'quantum -noise', type: 'video,user' }).expect(200);
    const legacy = res.body.results.find((r) => r.permlink === 'qm-legacy');
    expect(legacy.title_highlighted).toBe('<mark>Quantum</mark> physics explained');
    expect(res.body.results.find((r) => r.type === 'user').display_name_highlighted).toBe('<mark>Quantum</mark> Girl');

    const plain = await search({ q: 'quantum', highlight: 'false' }).expect(200);
    expect(plain.body.results[0]).not.toHaveProperty('title_highlighted');
  });

  test('pages through the merged, deduplicated results', async () => {
    const p1 = await search({ q: 'quantum', limit: 3 }).expect(200);
    const p3 = await search({ q: 'quantum', limit: 3, page: 3 }).expect(200);
    expect(p1.body).toMatchObject({ total: 7, totalPages: 3 });
    expect(p3.body.results).toHaveLength(1);
    expect(keys(p1.body.results)).not.toContain(keys(p3.body.results)[0]);
  });
});

describe('what search never returns', () => {
  test.each([
    ['unlisted', { listed_on_3speak: false }],
    ['hidden from feeds', { hiddenFromFeed: true }],
    ['unavailable', { unavailable: true }],
    ['NSFW-tagged', { hive_tags: ['nsfw'] }],
    ['a draft', { status: 'encoding' }],
    ['not on Hive yet', { hive_permlink: null }],
    ['by a moderation-hidden creator', { owner: 'hush', hive_author: 'hush' }],
  ])('an embed video that is %s', async (_label, over) => {
    await F.hideCreator(db(), 'hush');
    await col('embed-video').insertMany([
      F.embedVideo({ permlink: 'ok', hive_title: 'Volcano tour' }),
      F.embedVideo({ permlink: 'no', hive_title: 'Volcano eruption', ...over }),
    ]);
    expect(keys((await search({ q: 'volcano' }).expect(200)).body.results)).toEqual(['video:hive-ok']);
  });

  test.each([
    ['a failed publish', { publishFailed: true }],
    ['NSFW-tagged', { tags_v2: ['nsfw'] }],
    ['by a moderation-hidden creator', { owner: 'hush' }],
  ])('a legacy video that is %s', async (_label, over) => {
    await F.hideCreator(db(), 'hush');
    await col('videos').insertMany([
      F.legacyVideo({ permlink: 'ok', title: 'Volcano tour' }),
      F.legacyVideo({ permlink: 'no', title: 'Volcano eruption', ...over }),
    ]);
    expect(keys((await search({ q: 'volcano' }).expect(200)).body.results)).toEqual(['video:ok']);
  });

  test('NSFW results appear once the viewer opts in', async () => {
    await col('videos').insertOne(F.legacyVideo({ permlink: 'spicy', title: 'Volcano heat', isNsfwContent: true }));
    expect((await search({ q: 'volcano' }).expect(200)).body.total).toBe(0);
    expect((await search({ q: 'volcano', nsfw: 'true' }).expect(200)).body.total).toBe(1);
  });

  test('a moderation-hidden profile is not a user result', async () => {
    await F.hideCreator(db(), 'hush');
    await col('hiveprofiles').insertMany([{ username: 'hush', display_name: 'Volcano Hush' }, { username: 'fine', display_name: 'Volcano Fine' }]);
    expect(keys((await search({ q: 'volcano', type: 'user' }).expect(200)).body.results)).toEqual(['user:fine']);
  });

  // Every shorts feed hides an unlisted short (`listed_on_3speak: { $ne: false }`),
  // and search hides unlisted long-form videos. The shorts search has no listing
  // clause (routes/search.js:285-294), so an unlisted short is publicly searchable.
  test('an UNLISTED short is not returned by search', async () => {
    await col('embed-video').insertOne(F.shortVideo({ permlink: 'secret', hive_title: 'Volcano secret', listed_on_3speak: false }));
    expect((await search({ q: 'volcano' }).expect(200)).body.total).toBe(0);
  });

  // The shorts search drops hidden creators by `hive_author` only
  // (routes/search.js:292), but shorts are addressed by `owner` and usually carry
  // no hive_author, and `$nin` matches a missing field. So a moderation-hidden
  // creator's shorts stay searchable; the feeds filter shorts by `owner`.
  test('a moderation-hidden creator\'s SHORT is not returned by search', async () => {
    await F.hideCreator(db(), 'hush');
    await col('embed-video').insertOne(F.shortVideo({ owner: 'hush', embed_url: '@hush/x', permlink: 'h', hive_title: 'Volcano short' }));
    expect((await search({ q: 'volcano' }).expect(200)).body.total).toBe(0);
  });

  test('a moderation-hidden creator\'s public playlist is not a result', async () => {
    await F.hideCreator(db(), 'hush');
    await col('playlists').insertMany([
      { name: 'Volcano picks', owner: 'hush', access: 'public', items: [] },
      { name: 'Volcano best', owner: 'fine', access: 'public', items: [] },
    ]);
    const res = await search({ q: 'volcano', type: 'playlist' }).expect(200);
    expect(res.body.results.map((r) => r.owner)).toEqual(['fine']);
  });

  // The AI-tag join reaches embed docs by owner/permlink, so it must apply the same
  // visibility as the text search: no unlisted video, no hidden creator by owner.
  test.each([
    ['unlisted', { owner: 'em', listed_on_3speak: false }],
    ['by a moderation-hidden owner without a hive_author', { owner: 'hush', hive_author: undefined }],
  ])('the AI tag join never returns an embed video that is %s', async (_label, over) => {
    await F.hideCreator(db(), 'hush');
    const doc = F.embedVideo({ permlink: 'joined', hive_title: 'Untitled', ...over });
    if (over.hive_author === undefined) delete doc.hive_author;
    await col('embed-video').insertOne(doc);
    await col('subtitles-tags').insertOne({ author: doc.owner, permlink: 'joined', tags: 'astronomy' });
    expect((await search({ q: 'astronomy' }).expect(200)).body.total).toBe(0);
  });
});

describe('ranking', () => {
  test('a title match outranks a description match', async () => {
    await col('videos').insertMany([
      F.legacyVideo({ permlink: 'in-description', title: 'My trip', description: 'we saw a glacier' }),
      F.legacyVideo({ permlink: 'in-title', title: 'Glacier hike' }),
    ]);
    expect(keys((await search({ q: 'glacier' }).expect(200)).body.results)).toEqual(['video:in-title', 'video:in-description']);
  });

  test('views give a mild boost between equal text matches', async () => {
    await col('videos').insertMany([
      F.legacyVideo({ permlink: 'quiet', title: 'Glacier hike', views: 0 }),
      F.legacyVideo({ permlink: 'watched', title: 'Glacier hike', views: 1000 }),
    ]);
    const res = await search({ q: 'glacier' }).expect(200);
    expect(keys(res.body.results)).toEqual(['video:watched', 'video:quiet']);
    expect(res.body.results[0].score / res.body.results[1].score).toBeCloseTo(1.3, 5);   // 1 + log10(1000)/10
  });

  test('sort=date favours newer content', async () => {
    await col('videos').insertMany([
      F.legacyVideo({ permlink: 'old-but-popular', title: 'Glacier hike', views: 100, created: F.daysAgo(300) }),
      F.legacyVideo({ permlink: 'new', title: 'Glacier hike', created: F.daysAgo(1) }),
    ]);
    expect(keys((await search({ q: 'glacier' }).expect(200)).body.results)[0]).toBe('video:old-but-popular');
    const byDate = await search({ q: 'glacier', sort: 'date' }).expect(200);
    expect(byDate.body.sort).toBe('date');
    expect(keys(byDate.body.results)[0]).toBe('video:new');
  });

  test('the AI tag join finds a video whose text never says the word, once', async () => {
    await col('videos').insertOne(F.legacyVideo({ owner: 'leg', permlink: 'by-tag', title: 'Untitled vlog' }));
    await col('embed-video').insertOne(F.embedVideo({ owner: 'em', permlink: 'both', hive_title: 'Astronomy night' }));
    await col('subtitles-tags').insertMany([
      { author: 'leg', permlink: 'by-tag', tags: 'astronomy, stars' },
      { author: 'em', permlink: 'both', tags: 'astronomy' },
    ]);

    const res = await search({ q: 'astronomy' }).expect(200);

    expect(keys(res.body.results)).toEqual(['video:hive-both', 'video:by-tag']);   // text hit first, then the tag hit
    expect(res.body.results[1].score).toBe(0.5);
  });
});

describe('filters', () => {
  test('tag= keeps results carrying the tag; communities and users pass through', async () => {
    await col('videos').insertMany([
      F.legacyVideo({ permlink: 'tagged', title: 'Jazz night', tags_v2: ['music'] }),
      F.legacyVideo({ permlink: 'untagged', title: 'Jazz talk', tags_v2: ['talk'] }),
    ]);
    await col('hiveprofiles').insertOne({ username: 'jazzman', display_name: 'Jazz Man' });

    const res = await search({ q: 'jazz', tag: 'MUSIC' }).expect(200);

    expect(res.body.filters.tag).toBe('music');
    expect(keys(res.body.results).sort()).toEqual(['user:jazzman', 'video:tagged']);
  });

  test('from/to bound the creation date and are echoed back; an invalid date is ignored', async () => {
    await col('videos').insertMany([
      F.legacyVideo({ permlink: 'jan', title: 'Jazz night', created: new Date('2026-01-15T00:00:00Z') }),
      F.legacyVideo({ permlink: 'jun', title: 'Jazz night', created: new Date('2026-06-15T00:00:00Z') }),
    ]);

    const res = await search({ q: 'jazz', from: '2026-03-01', to: '2026-12-31' }).expect(200);
    const invalid = await search({ q: 'jazz', from: 'not-a-date' }).expect(200);

    expect(keys(res.body.results)).toEqual(['video:jun']);
    expect(res.body.filters).toMatchObject({ from: '2026-03-01T00:00:00.000Z', to: '2026-12-31T00:00:00.000Z' });
    expect(invalid.body.total).toBe(2);
    expect(invalid.body.filters.from).toBeUndefined();
  });

  test('community= keeps a community\'s legacy videos', async () => {
    await col('videos').insertMany([
      F.legacyVideo({ permlink: 'inside', title: 'Jazz night', community: 'hive-123456' }),
      F.legacyVideo({ permlink: 'outside', title: 'Jazz night' }),
    ]);
    expect(keys((await search({ q: 'jazz', community: 'hive-123456' }).expect(200)).body.results)).toEqual(['video:inside']);
  });

  // Embed videos record their community as `category` (services/embedCategorySync.js,
  // and the community feeds match category OR a hive_tags entry), but the search
  // filter asks embed docs for a `community` field that nothing ever writes
  // (routes/search.js:205). Filtering by community therefore drops every embed video.
  test('community= keeps the embed videos of that community', async () => {
    await col('embed-video').insertOne(F.embedVideo({ permlink: 'inside', hive_title: 'Jazz night', category: 'hive-123456' }));
    expect(keys((await search({ q: 'jazz', community: 'hive-123456' }).expect(200)).body.results)).toEqual(['video:hive-inside']);
  });
});

describe('GET /search/suggest', () => {
  test('under two characters suggests nothing', async () => {
    expect((await suggest('a').expect(200)).body).toEqual({ success: true, suggestions: [] });
    expect((await request(app).get('/search/suggest').expect(200)).body.suggestions).toEqual([]);
  });

  test('titles, users, tags, communities and playlists, each capped and deduplicated', async () => {
    await col('videos').insertMany([
      F.legacyVideo({ owner: 'a', permlink: 'p1', title: 'Garden tour', tags_v2: ['gardening', '#Garden'] }),
      F.legacyVideo({ owner: 'a', permlink: 'p1-dup', title: 'Garden tips', status: 'draft' }),
    ]);
    await col('embed-video').insertMany([
      F.embedVideo({ owner: 'a', permlink: 'p1x', hive_permlink: 'p1', hive_title: 'Garden tour' }), // same Hive post as the legacy one
      F.embedVideo({ owner: 'b', permlink: 'e2', hive_title: 'Garden at night', hive_tags: ['GARDEN', 'night'] }),
    ]);
    await col('hiveprofiles').insertMany([
      { username: 'gardener', display_name: 'G', profile_image: 'img' },
      { username: 'zed', display_name: 'The Garden Guy' },
    ]);
    await col('hivecommunities').insertMany([
      { name: 'hive-1', title: 'Gardens small', subscribers: 1 },
      { name: 'hive-2', title: 'Gardens big', subscribers: 99 },
    ]);
    await col('playlists').insertOne({ name: 'Garden picks', owner: 'a', access: 'public', items: [{}] });

    const res = await suggest('gard').expect(200);
    const of = (type) => res.body.suggestions.filter((s) => s.type === type);

    expect(res.body.query).toBe('gard');
    expect(of('title').map((t) => t.text)).toEqual(['Garden tour', 'Garden at night']);
    expect(of('user').map((u) => u.username).sort()).toEqual(['gardener', 'zed']);
    expect(of('tag').map((t) => t.text)).toEqual(['gardening', 'Garden']);
    expect(of('community').map((c) => c.name)).toEqual(['hive-2', 'hive-1']);
    expect(of('playlist')).toEqual([expect.objectContaining({ name: 'Garden picks', video_count: 1 })]);
  });

  test('regex characters are matched literally', async () => {
    await col('videos').insertOne(F.legacyVideo({ permlink: 'cpp', title: 'C++ basics', tags_v2: ['c++'] }));
    const res = await suggest('c++').expect(200);
    expect(res.body.suggestions.map((s) => s.text)).toEqual(['C++ basics', 'c++']);
  });

  test('a moderation-hidden creator\'s profile and embed titles are not suggested', async () => {
    await F.hideCreator(db(), 'hush');
    await col('hiveprofiles').insertOne({ username: 'hush', display_name: 'Garden Hush' });
    await col('embed-video').insertOne(F.embedVideo({ owner: 'hush', permlink: 'h', hive_title: 'Garden secrets' }));
    expect((await suggest('garden').expect(200)).body.suggestions).toEqual([]);
  });

  // The hidden-creator doc (utils/hiddenCreators.js) removes their content from
  // search, and the embed-title and profile suggestions do drop them, but the legacy
  // title suggestion has no hidden-creator clause (routes/search.js:32-35).
  test('a moderation-hidden creator\'s LEGACY titles are not suggested', async () => {
    await F.hideCreator(db(), 'hush');
    await col('videos').insertOne(F.legacyVideo({ owner: 'hush', permlink: 'h', title: 'Garden secrets' }));
    expect((await suggest('garden').expect(200)).body.suggestions).toEqual([]);
  });

  // An unlisted video is hidden "from feeds AND from anyone else's view"
  // (utils/hiddenFromFeed.js), and full search drops it, but the embed-title
  // suggestion has no listing clause (routes/search.js:38-46): its title is offered
  // to anyone who types a few letters of it.
  test('an UNLISTED embed video\'s title is not suggested', async () => {
    await col('embed-video').insertOne(F.embedVideo({ permlink: 'u', hive_title: 'Garden private', listed_on_3speak: false }));
    expect((await suggest('garden').expect(200)).body.suggestions).toEqual([]);
  });

  test('a moderation-hidden creator\'s tags are not suggested, legacy or embed', async () => {
    await F.hideCreator(db(), 'hush');
    await col('videos').insertOne(F.legacyVideo({ owner: 'hush', permlink: 'l', title: 'Untitled', tags_v2: ['gardening'] }));
    await col('embed-video').insertMany([
      F.embedVideo({ owner: 'hush', permlink: 'e', hive_title: 'Untitled', hive_tags: ['gardenparty'] }),
      // owner hidden, hive_author someone else: the owner still decides
      F.embedVideo({ owner: 'hush', hive_author: 'front', permlink: 'e2', hive_title: 'Untitled', hive_tags: ['gardenhush'] }),
    ]);
    expect((await suggest('garden').expect(200)).body.suggestions).toEqual([]);
  });

  test('an UNLISTED embed video\'s tags are not suggested', async () => {
    await col('embed-video').insertOne(F.embedVideo({ permlink: 'u', hive_title: 'Untitled', hive_tags: ['gardensecret'], listed_on_3speak: false }));
    expect((await suggest('garden').expect(200)).body.suggestions).toEqual([]);
  });

  test('an embed title whose OWNER is hidden is not suggested even under another hive_author', async () => {
    await F.hideCreator(db(), 'hush');
    await col('embed-video').insertOne(F.embedVideo({ owner: 'hush', hive_author: 'front', permlink: 'h', hive_title: 'Garden secrets' }));
    expect((await suggest('garden').expect(200)).body.suggestions).toEqual([]);
  });

  test('a moderation-hidden creator\'s playlist is not suggested', async () => {
    await F.hideCreator(db(), 'hush');
    await col('playlists').insertOne({ name: 'Garden picks', owner: 'hush', access: 'public', items: [] });
    expect((await suggest('garden').expect(200)).body.suggestions).toEqual([]);
  });

  test('the same tags from a visible creator are still suggested', async () => {
    await F.hideCreator(db(), 'hush');
    await col('videos').insertOne(F.legacyVideo({ owner: 'fine', permlink: 'l', title: 'Untitled', tags_v2: ['gardening'] }));
    await col('embed-video').insertOne(F.embedVideo({ owner: 'fine', permlink: 'e', hive_title: 'Untitled', hive_tags: ['gardenparty'] }));
    const tags = (await suggest('garden').expect(200)).body.suggestions.filter((x) => x.type === 'tag').map((t) => t.text);
    expect(tags).toEqual(['gardening', 'gardenparty']);
  });
});

// A common word makes $text score every matching doc (~2.5s for "music" on prod),
// so the merged list is cached briefly (utils/searchCache.js).
describe('the result cache', () => {
  const add = (permlink, title) => col('videos').insertOne(F.legacyVideo({ permlink, title }));

  test('a repeated search inside the TTL is served from the cache; after it, from the database', async () => {
    await add('a', 'Ocean waves');
    expect((await search({ q: 'ocean' }).expect(200)).body.total).toBe(1);

    await add('b', 'Ocean storm');
    expect((await search({ q: 'OCEAN' }).expect(200)).body.total).toBe(1);   // case does not change the key

    F.advanceClock(61 * 1000);
    expect((await search({ q: 'ocean' }).expect(200)).body.total).toBe(2);
  });

  test('every page of one search reads the same list; highlighting never leaks into the cache', async () => {
    await col('videos').insertMany([1, 2, 3].map((i) => F.legacyVideo({ permlink: `p${i}`, title: `Ocean ${i}`, views: i })));

    const p1 = await search({ q: 'ocean', limit: 2 }).expect(200);
    const p2 = await search({ q: 'ocean', limit: 2, page: 2, highlight: 'false' }).expect(200);
    const again = await search({ q: 'ocean', limit: 2, highlight: 'false' }).expect(200);

    expect(p1.body.results[0].title_highlighted).toBe('<mark>Ocean</mark> 3');
    expect(keys([...p1.body.results, ...p2.body.results])).toEqual(['video:p3', 'video:p2', 'video:p1']);
    expect(again.body.results[0]).not.toHaveProperty('title_highlighted');
    expect(again.body.results[0].score).toBe(p1.body.results[0].score);   // the view boost is applied once
  });

  test.each([
    ['type', { type: 'video' }],
    ['tag', { tag: 'sea' }],
    ['nsfw', { nsfw: 'true' }],
    ['sort', { sort: 'date' }],
    ['from', { from: '2020-01-01' }],
    ['community', { community: 'hive-1' }],
  ])('a different %s is a different search', async (_label, extra) => {
    await add('a', 'Ocean waves');
    await search({ q: 'ocean' }).expect(200);
    await col('videos').insertOne(F.legacyVideo({ permlink: 'b', title: 'Ocean storm', tags_v2: ['sea'], community: 'hive-1' }));
    expect((await search({ q: 'ocean', ...extra }).expect(200)).body.results.map((r) => r.permlink)).toContain('b');
  });
});
