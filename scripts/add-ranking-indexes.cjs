/**
 * One-off: create the indexes the ranking / feed-personalization lookups need, so
 * they stop being collection scans on the shared Mongo. Idempotent + background —
 * safe to run any time Mongo is reachable (e.g. right after a Mongo recovery,
 * without restarting the checker).
 *
 *   node scripts/add-ranking-indexes.cjs
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');

const WANTED = [
  ['subtitles-tags', { author: 1, permlink: 1 }],   // interest-boost fetchTranscriptionTags $or
  ['view-durations', { owner: 1, permlink: 1 }],     // retention aggregation group key
  ['view-durations', { updatedAt: 1 }],              // retention window match + cleanup
  ['view-heatmaps', { owner: 1, permlink: 1 }],       // heatmap read
  ['video-retention', { runAt: 1 }],                  // retention worker housekeeping delete
];

(async () => {
  const c = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 2, serverSelectionTimeoutMS: 10000 });
  await c.connect();
  const db = c.db(process.env.DATABASE_NAME);
  for (const [coll, key] of WANTED) {
    try {
      const name = await db.collection(coll).createIndex(key, { background: true });
      console.log(`  ✓ ${coll}  ${JSON.stringify(key)}  → ${name}`);
    } catch (e) {
      console.log(`  ✗ ${coll}  ${JSON.stringify(key)}  → ${e.message}`);
    }
  }
  await c.close();
  console.log('done');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
