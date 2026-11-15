/**
 * Save the screenshot attached to a feedback review (POST /reviews) to a file.
 * Screenshots stay private in Mongo `review_screenshots`; this is how to look.
 *
 * Usage:  node scripts/review-screenshot.js <reviewId> [outDir]
 *         node scripts/review-screenshot.js --list      (latest 20 reviews that have one)
 */
const fs = require('fs');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

async function main() {
  const [arg, outDir = '.'] = process.argv.slice(2);
  if (!arg) {
    console.error('Usage: node scripts/review-screenshot.js <reviewId> [outDir] | --list');
    process.exit(2);
  }
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  try {
    const db = client.db(process.env.DATABASE_NAME || 'threespeak');
    if (arg === '--list') {
      const rows = await db.collection('reviews')
        .find({ screenshot: { $ne: null } }, { projection: { area: 1, username: 1, stars: 1, path: 1, created_at: 1, 'screenshot.bytes': 1 } })
        .sort({ created_at: -1 }).limit(20).toArray();
      for (const r of rows) {
        console.log(`${r._id}  ${r.created_at.toISOString()}  ${r.stars}*  ${r.area}  ${r.username || '(anonymous)'}  ${r.path || ''}  ${Math.round(r.screenshot.bytes / 1024)} kB`);
      }
      if (!rows.length) console.log('No reviews with a screenshot yet.');
      return;
    }
    if (!ObjectId.isValid(arg)) throw new Error(`not a review id: ${arg}`);
    const shot = await db.collection('review_screenshots').findOne({ review_id: new ObjectId(arg) });
    if (!shot) throw new Error(`review ${arg} has no screenshot`);
    const file = path.join(outDir, `review-${arg}.${EXT[shot.mime] || 'bin'}`);
    fs.writeFileSync(file, shot.data.buffer);
    console.log(`Saved ${file} (${Math.round(shot.bytes / 1024)} kB)`);
  } finally {
    await client.close();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
