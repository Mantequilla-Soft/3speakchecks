/**
 * GET /videos/tag/:tag on the REGEX FALLBACK: while any embed doc still lacks
 * `hive_tags_lower`, the route matches `hive_tags` with an anchored,
 * case-insensitive regex. That puts the tag match and the NSFW exclusion on the
 * same key, which the route must combine with $and. Same behaviour suite as the
 * fast path (tests/feeds/_tagFeedSuite.js).
 */
jest.mock('../../utils/hive', () => require('./_hiveMock').create());

const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const { slimFeed } = require('../../utils/slimFeed');
const F = require('./_fixtures');
const { defineTagFeedSuite } = require('./_tagFeedSuite');

const db = testDb.use();
const app = buildApp(['/videos/tag', slimFeed], ['/', require('../../routes/videos')]);

beforeEach(async () => {
  F.pinClock();
  await F.resetFeedCaches(db());
  // One doc that has not been backfilled keeps the route on the fallback. A draft,
  // so it never shows in a feed itself.
  await db().collection('embed-video').insertOne({ owner: 'canary', permlink: 'canary', status: 'draft', hive_tags: ['canary'] });
});
afterEach(() => jest.useRealTimers());

const withoutLowerTags = ({ hive_tags_lower: _drop, ...doc }) => doc;

defineTagFeedSuite({ db, app: () => app, prepare: withoutLowerTags });
