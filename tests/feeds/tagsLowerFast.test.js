/**
 * GET /videos/tag/:tag on the FAST path: every embed doc carries the pre-lowercased
 * `hive_tags_lower` (written by the tag backfill / change-stream watcher), so the
 * route matches it directly. The behaviour suite is shared with the regex fallback
 * (tests/feeds/_tagFeedSuite.js).
 */
jest.mock('../../utils/hive', () => require('./_hiveMock').create());

const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const { slimFeed } = require('../../utils/slimFeed');
const F = require('./_fixtures');
const { defineTagFeedSuite } = require('./_tagFeedSuite');

const db = testDb.use();
// Mounted like server.js: slimFeed in front of the tag list route.
const app = buildApp(['/videos/tag', slimFeed], ['/', require('../../routes/videos')]);

beforeEach(async () => {
  F.pinClock();
  await F.resetFeedCaches(db());
});
afterEach(() => jest.useRealTimers());

const withLowerTags = (doc) => (Array.isArray(doc.hive_tags)
  ? { ...doc, hive_tags_lower: doc.hive_tags.map((t) => String(t).toLowerCase()) }
  : doc);

defineTagFeedSuite({ db, app: () => app, prepare: withLowerTags });
