/**
 * Backfill embed-video.thumbnail_url from the Hive post.
 *
 * The upstream publisher writes the thumbnail into the post's json_metadata but
 * doesn't copy it onto our doc, so the feeds fall back to
 * img.3speak.tv/<permlink>/thumbnail.png — which doesn't resolve for these
 * assets, leaving a blank card. The real URL is already on chain; this reads it
 * back. Additive only: it never overwrites a thumbnail we already have.
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');

const APPLY = process.argv.includes('--apply');
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1] || 500);
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPost(author, permlink) {
  const r = await fetch('https://api.hive.blog', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'condenser_api.get_content', params: [author, permlink], id: 1 }),
  }).then((x) => x.json()).catch(() => null);
  return r?.result?.author ? r.result : null;
}

function thumbFrom(post) {
  let meta = {};
  try { meta = JSON.parse(post.json_metadata || '{}') || {}; } catch { return null; }
  const fromMap = (meta.video?.info?.sourceMap || []).find((s) => s?.type === 'thumbnail')?.url;
  const fromImage = Array.isArray(meta.image) ? meta.image[0] : (typeof meta.image === 'string' ? meta.image : null);
  const url = fromMap || fromImage || null;
  return typeof url === 'string' && /^https?:\/\//.test(url) ? url : null;
}

(async () => {
  const c = new MongoClient(process.env.MONGODB_URI); await c.connect();
  const ev = c.db(process.env.DATABASE_NAME || 'threespeak').collection('embed-video');

  const query = {
    status: 'published',
    hive_permlink: { $ne: null },
    hive_author: { $ne: null },
    $or: [{ thumbnail_url: null }, { thumbnail_url: '' }, { thumbnail_url: { $exists: false } }],
    ...(ONLY ? { hive_permlink: ONLY } : {}),
  };

  const docs = await ev.find(query).sort({ createdAt: -1 }).limit(LIMIT).toArray();
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — candidates: ${docs.length}\n`);

  let found = 0, missing = 0, updated = 0;
  for (const d of docs) {
    const post = await getPost(d.hive_author, d.hive_permlink);
    const url = post ? thumbFrom(post) : null;
    if (!url) { missing += 1; continue; }
    found += 1;
    if (docs.length <= 12 || found <= 5) console.log(`  ${d.hive_author}/${d.hive_permlink} → ${url.slice(0, 78)}`);
    if (APPLY) {
      await ev.updateOne({ _id: d._id }, { $set: { thumbnail_url: url, thumbnail_backfilled_at: new Date() } });
      updated += 1;
    }
    await sleep(120);   // gentle on the RPC
  }
  console.log(`\nthumbnail found on chain: ${found}   none there either: ${missing}   written: ${updated}`);
  await c.close();
})();
