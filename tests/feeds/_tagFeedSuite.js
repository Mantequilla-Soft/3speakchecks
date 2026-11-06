/**
 * The behaviour of GET /videos/tag/:tag and /videos/tag/:tag/counts, written once
 * and run on BOTH of the route's embed query paths:
 *
 *   - the fast path, once every embed doc carries the pre-lowercased
 *     `hive_tags_lower` (tagsLowerFast.test.js), and
 *   - the regex fallback used while that backfill is incomplete, where the tag
 *     match and the NSFW exclusion both target `hive_tags` and must be combined
 *     with $and rather than overwrite each other (tagsRegexFallback.test.js).
 *
 * `prepare(doc)` shapes every embed doc for the path under test.
 */
const request = require('supertest');
const F = require('./_fixtures');

function defineTagFeedSuite({ db, app, prepare }) {
  const get = (tag, query = {}) => request(app()).get(`/videos/tag/${encodeURIComponent(tag)}`).query(query);
  const counts = (tag, query = {}) => request(app()).get(`/videos/tag/${encodeURIComponent(tag)}/counts`).query(query);
  const addEmbeds = (...docs) => db().collection('embed-video').insertMany(docs.map(prepare));
  const addLegacy = (...docs) => db().collection('videos').insertMany(docs);

  describe('matching', () => {
    test('a tag matches legacy tags_v2 and embed Hive tags, case-insensitively and exactly', async () => {
      await addLegacy(F.legacyVideo({ permlink: 'legacy-music', tags_v2: ['music'] }));
      await addEmbeds(
        F.embedVideo({ permlink: 'embed-music', hive_tags: ['Music', 'live'] }),
        F.embedVideo({ permlink: 'embed-musical', hive_tags: ['musical'] }),
      );

      const res = await get('MUSIC').expect(200);

      expect(res.body).toMatchObject({ tag: 'MUSIC', page: 1, limit: 20, total: 2, totalPages: 1 });
      expect(F.permlinks(res.body.videos).sort()).toEqual(['hive-embed-music', 'legacy-music']);
    });

    test('regex characters in a tag are matched literally', async () => {
      await addEmbeds(F.embedVideo({ permlink: 'cpp', hive_tags: ['C++'] }), F.embedVideo({ permlink: 'c', hive_tags: ['c'] }));
      const res = await get('c++').expect(200);
      expect(F.permlinks(res.body.videos)).toEqual(['hive-cpp']);
    });

    test('cards are list cards: the post body is stripped by slimFeed', async () => {
      await addEmbeds(F.embedVideo({ permlink: 'with-body', hive_tags: ['art'], hive_body: 'x'.repeat(5000) }));
      const [card] = (await get('art').expect(200)).body.videos;
      expect(card).not.toHaveProperty('body');
      expect(card).toMatchObject({ short: false, title: 'Title with-body' });
    });
  });

  describe('type', () => {
    beforeEach(async () => {
      await addLegacy(F.legacyVideo({ permlink: 'l', tags_v2: ['art'] }));
      await addEmbeds(
        F.embedVideo({ permlink: 'long', hive_tags: ['art'] }),
        F.shortVideo({ permlink: 'clip', hive_tags: ['art'] }),
        F.shortVideo({ permlink: 'other-clip', hive_tags: ['food'] }),
      );
    });

    test.each([
      [undefined, ['hive-long', 'l']],
      ['videos', ['hive-long', 'l']],
      ['shorts', ['clip']],   // a short with no hive_permlink keeps its asset id
    ])('type=%s', async (type, expected) => {
      const res = await get('art', type ? { type } : {}).expect(200);
      expect(F.permlinks(res.body.videos).sort()).toEqual(expected);
    });

    test('"snaps" with type=shorts is every short, whatever its tags', async () => {
      const res = await get('snaps', { type: 'shorts' }).expect(200);
      expect(F.permlinks(res.body.videos).sort()).toEqual(['clip', 'other-clip']);
      expect(res.body.videos.every((v) => v.short === true)).toBe(true);
    });
  });

  describe('what a tag feed never shows', () => {
    test('NSFW-tagged embed videos unless opted in (the two hive_tags conditions must both hold)', async () => {
      await addEmbeds(
        F.embedVideo({ permlink: 'clean', hive_tags: ['travel'] }),
        F.embedVideo({ permlink: 'nsfw', hive_tags: ['travel', 'nsfw'] }),
      );
      expect(F.permlinks((await get('travel').expect(200)).body.videos)).toEqual(['hive-clean']);
      expect((await get('travel', { nsfw: 'true' }).expect(200)).body.total).toBe(2);
    });

    test.each([
      ['unlisted', { listed_on_3speak: false }],
      ['unpublished', { status: 'encoding' }],
      ['flagged NSFW', { isNsfwContent: true }],
      ['banned', { banned: true }],
      ['unavailable', { unavailable: true }],
      ['hidden from feeds', { hiddenFromFeed: true }],
      ['by a moderation-hidden creator', { owner: 'hush', hive_author: 'hush' }],
    ])('an embed video that is %s', async (_label, over) => {
      await F.hideCreator(db(), 'hush');
      await addEmbeds(F.embedVideo({ permlink: 'ok', hive_tags: ['pets'] }), F.embedVideo({ permlink: 'no', hive_tags: ['pets'], ...over }));
      expect(F.permlinks((await get('pets').expect(200)).body.videos)).toEqual(['hive-ok']);
    });

    test('a legacy video by a moderation-hidden creator', async () => {
      await F.hideCreator(db(), 'hush');
      await addLegacy(F.legacyVideo({ owner: 'hush', permlink: 'h', tags_v2: ['pets'] }), F.legacyVideo({ permlink: 'v', tags_v2: ['pets'] }));
      expect(F.permlinks((await get('pets').expect(200)).body.videos)).toEqual(['v']);
    });

    // Every shorts surface hides an unlisted short (`listed_on_3speak: { $ne: false }`:
    // /shorts, /shortssorted, /shorts/stories, /shorts/:username). The tag feed's
    // shorts query has no listing clause at all (routes/videos.js:219-221), so an
    // unlisted short shows up under its tags, and is counted by /counts (:312-314).
    test('an UNLISTED short is not listed in the tag feed\'s shorts tab, nor counted', async () => {
      await addEmbeds(
        F.shortVideo({ permlink: 'listed', hive_tags: ['pets'] }),
        F.shortVideo({ permlink: 'unlisted', hive_tags: ['pets'], listed_on_3speak: false }),
      );
      expect(F.permlinks((await get('pets', { type: 'shorts' }).expect(200)).body.videos)).toEqual(['listed']);
      expect((await counts('pets').expect(200)).body.shorts).toBe(1);
    });
  });

  describe('filters, order and pages', () => {
    test('since= keeps only content created after the unix timestamp', async () => {
      await addLegacy(F.legacyVideo({ permlink: 'l-old', tags_v2: ['diy'], created: F.daysAgo(10) }));
      await addEmbeds(
        F.embedVideo({ permlink: 'e-new', hive_tags: ['diy'], createdAt: F.hoursAgo(2) }),
        F.embedVideo({ permlink: 'e-old', hive_tags: ['diy'], createdAt: F.daysAgo(10) }),
        F.shortVideo({ permlink: 's-old', hive_tags: ['diy'], createdAt: F.daysAgo(10) }),
      );
      const since = Math.floor(F.daysAgo(1).getTime() / 1000);

      expect(F.permlinks((await get('diy', { since }).expect(200)).body.videos)).toEqual(['hive-e-new']);
      expect((await get('diy', { since, type: 'shorts' }).expect(200)).body.videos).toEqual([]);
      expect((await counts('diy', { since }).expect(200)).body).toEqual({ tag: 'diy', videos: 1, shorts: 0, total: 1 });
    });

    test('newest first across both collections, paginated', async () => {
      await addLegacy(F.legacyVideo({ permlink: 'l2', tags_v2: ['news'], created: F.hoursAgo(2) }));
      await addEmbeds(
        F.embedVideo({ permlink: 'e1', hive_tags: ['news'], createdAt: F.hoursAgo(1) }),
        F.embedVideo({ permlink: 'e3', hive_tags: ['news'], createdAt: F.hoursAgo(3) }),
      );

      const all = await get('news').expect(200);
      const p2 = await get('news', { limit: 1, page: 2, type: 'videos' }).expect(200);

      expect(F.permlinks(all.body.videos)).toEqual(['hive-e1', 'l2', 'hive-e3']);
      expect(p2.body).toMatchObject({ page: 2, limit: 1 });
      expect(F.permlinks(p2.body.videos)).toEqual(['l2']);
    });

    test('a short page of shorts is paginated in Mongo with an exact total', async () => {
      await addEmbeds(...[1, 2, 3].map((i) => F.shortVideo({ permlink: `s${i}`, hive_tags: ['fun'], createdAt: F.hoursAgo(i) })));
      const res = await get('fun', { type: 'shorts', limit: 2, page: 2 }).expect(200);
      expect(res.body).toMatchObject({ total: 3, totalPages: 2 });
      expect(F.permlinks(res.body.videos)).toEqual(['s3']);
    });

    test('the viewer\'s dismissals and watched videos are removed', async () => {
      await addEmbeds(
        F.embedVideo({ owner: 'muted', permlink: 'm', hive_tags: ['art'] }),
        F.embedVideo({ owner: 'seen', permlink: 's', hive_tags: ['art'] }),
        F.embedVideo({ owner: 'fresh', permlink: 'f', hive_tags: ['art'] }),
      );
      await F.dismissCreator(db(), 'viewer', 'muted');
      await db().collection('watch_history').insertOne(F.watched('viewer', 'seen', 'hive-s'));

      const res = await get('art', { currentuser: 'viewer' }).expect(200);

      expect(F.permlinks(res.body.videos)).toEqual(['hive-f']);
      expect(res.body.videos[0]).not.toHaveProperty('_rankScore');
    });
  });

  describe('mantecurated', () => {
    beforeEach(async () => {
      await addLegacy(F.legacyVideo({ permlink: 'l-curated', mantecurated: true, created: F.hoursAgo(3) }), F.legacyVideo({ permlink: 'l-plain' }));
      await addEmbeds(
        F.embedVideo({ permlink: 'e-curated', mantecurated: true, createdAt: F.hoursAgo(1) }),
        F.shortVideo({ permlink: 's-curated', mantecurated: true, createdAt: F.hoursAgo(2) }),
      );
    });

    test.each([
      [undefined, ['hive-e-curated', 's-curated', 'l-curated']],
      ['shorts', ['s-curated']],
    ])('the curated pick, type=%s', async (type, expected) => {
      const res = await get('ManteCurated', type ? { type } : {}).expect(200);
      expect(F.permlinks(res.body.videos)).toEqual(expected);
    });

    // type=videos sets `embedQuery.short = false` (routes/videos.js:114) and then
    // never runs the embed query: `fetchEmbed = type !== 'videos' ? ... : []`
    // (:120-122). So the Videos tab of the curated pick drops every curated embed
    // video and shows legacy uploads only.
    test('type=videos keeps the curated EMBED videos', async () => {
      const res = await get('mantecurated', { type: 'videos' }).expect(200);
      expect(F.permlinks(res.body.videos)).toEqual(['hive-e-curated', 'l-curated']);
    });

    test('since= applies to the curated pick too', async () => {
      const since = Math.floor(F.hoursAgo(2.5).getTime() / 1000);
      expect((await get('mantecurated', { since }).expect(200)).body.total).toBe(2);
    });

    test('counts split videos and shorts', async () => {
      expect((await counts('mantecurated').expect(200)).body).toEqual({ tag: 'mantecurated', videos: 2, shorts: 1, total: 3 });
      const since = Math.floor(F.hoursAgo(1.5).getTime() / 1000);
      expect((await counts('mantecurated', { since }).expect(200)).body).toEqual({ tag: 'mantecurated', videos: 1, shorts: 0, total: 1 });
    });
  });

  describe('/counts', () => {
    test('counts videos (both collections) and shorts for a tag', async () => {
      await addLegacy(F.legacyVideo({ permlink: 'l', tags_v2: ['gaming'] }));
      await addEmbeds(
        F.embedVideo({ permlink: 'e', hive_tags: ['Gaming'] }),
        F.shortVideo({ permlink: 's1', hive_tags: ['gaming'] }),
        F.shortVideo({ permlink: 's2', hive_tags: ['gaming', 'nsfw'] }),
      );
      expect((await counts('gaming').expect(200)).body).toEqual({ tag: 'gaming', videos: 2, shorts: 1, total: 3 });
      expect((await counts('gaming', { nsfw: 'true' }).expect(200)).body.shorts).toBe(2);
    });

    test('"snaps" counts every short', async () => {
      await addEmbeds(F.shortVideo({ permlink: 'a', hive_tags: ['x'] }), F.shortVideo({ permlink: 'b' }));
      expect((await counts('snaps').expect(200)).body).toMatchObject({ shorts: 2, videos: 0 });
    });
  });
}

module.exports = { defineTagFeedSuite };
