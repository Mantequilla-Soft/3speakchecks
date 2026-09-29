/**
 * Purge view tracking written by headless-browser crawlers that PLAY videos
 * (Reflectionbot, reflection.ai: 62% of view-durations sessions in the week to
 * 2026-09-28). Their sessions inflate `embed-video.views` and, through
 * video-retention, the feed ranking.
 *
 * What it does, for rows whose userAgent matches BOT_UA:
 *   1. `views` (per-event embed view log): back up, delete, and decrement the
 *      matching `embed-video.views` by the number of rows removed (floored at 0).
 *   2. `view-durations` + `view-sessions`: back up and delete.
 *   video-retention needs nothing: retentionWorker recomputes it from the
 *   cleaned collections on its next run.
 *
 * Not touched: ad_impressions / ad_viewer_watch / ad_payouts (the only payout
 * inputs; settled rows there carry payoutId), any row stamped payoutId/settledAt,
 * `view-heatmaps` (left as is on purpose), and legacy `videos.views` (legacy
 * increments have no per-event UA log).
 *
 * Every removed or adjusted doc is copied to `purged_bot_<collection>` with
 * `purgedAt`, so the purge is reversible. Deletes go by the exact _ids that were
 * backed up, so rows written while it runs are left for the next run.
 *
 * Usage:
 *   node scripts/purge-bot-views.js            # dry run (default), report only
 *   node scripts/purge-bot-views.js --apply    # write
 */
const path = require('path');
const { MongoClient } = require('mongodb');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BOT_UA = /reflectionbot/i;
// Belt and braces: payouts settle from ad_impressions and ad_viewer_watch, which
// this script never touches, but a row stamped as settled is never deleted here.
const UNPAID = { payoutId: { $exists: false }, settledAt: { $exists: false } };
const APPLY = process.argv.includes('--apply');

const key = (o, p) => `${o}/${p}`;

async function backup(db, name, docs, purgedAt) {
  if (!docs.length || !APPLY) return;
  const col = db.collection(`purged_bot_${name}`);
  for (let i = 0; i < docs.length; i += 1000) {
    // Re-runs may meet an _id that is already backed up; keep the first copy.
    await col.insertMany(docs.slice(i, i + 1000).map((d) => ({ ...d, purgedAt })), { ordered: false })
      .catch((e) => { if (e.code !== 11000 && !e.writeErrors?.every((w) => w.code === 11000)) throw e; });
  }
}

async function deleteByIds(db, name, docs) {
  if (!docs.length || !APPLY) return 0;
  let n = 0;
  for (let i = 0; i < docs.length; i += 1000) {
    const r = await db.collection(name).deleteMany({ _id: { $in: docs.slice(i, i + 1000).map((d) => d._id) } });
    n += r.deletedCount;
  }
  return n;
}

async function run() {
  const client = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 4 });
  await client.connect();
  const db = client.db(process.env.DATABASE_NAME || 'threespeak');
  const purgedAt = new Date();
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to write)'}  UA=${BOT_UA}`);

  try {
    // ── 1. views + embed-video.views ──
    for (const n of ['views', 'view-durations', 'view-sessions']) {
      const paid = await db.collection(n).countDocuments({ userAgent: BOT_UA, $nor: [UNPAID] });
      console.log(`${n}: ${paid} bot rows carry payoutId/settledAt -> SKIPPED`);
    }
    const views = await db.collection('views').find({ userAgent: BOT_UA, ...UNPAID }).toArray();
    const perVideo = new Map();
    for (const v of views) perVideo.set(key(v.author, v.permlink), (perVideo.get(key(v.author, v.permlink)) || 0) + 1);
    console.log(`views: ${views.length} bot rows over ${perVideo.size} videos`);

    let adjusted = 0, unresolved = 0, removedCount = 0;
    const adjustments = [];
    for (const [k, n] of perVideo) {
      const owner = k.slice(0, k.indexOf('/'));
      const permlink = k.slice(k.indexOf('/') + 1);
      const ev = await db.collection('embed-video').findOne(
        { owner, $or: [{ permlink }, { hive_permlink: permlink }] }, { projection: { views: 1 } });
      if (!ev) { unresolved++; continue; }
      const before = ev.views || 0;
      const after = Math.max(0, before - n);
      removedCount += before - after;
      adjustments.push({ _id: `${ev._id}:${purgedAt.toISOString()}`, embedVideoId: ev._id, owner, permlink, before, after, botViews: n });
      if (APPLY) {
        await db.collection('embed-video').updateOne({ _id: ev._id },
          [{ $set: { views: { $max: [0, { $subtract: [{ $ifNull: ['$views', 0] }, n] }] } } }]);
      }
      adjusted++;
    }
    await backup(db, 'embed_views_adjust', adjustments, purgedAt);
    await backup(db, 'views', views, purgedAt);
    const delViews = await deleteByIds(db, 'views', views);
    console.log(`  embed-video.views: ${adjusted} videos lowered by ${removedCount} in total, ${unresolved} bot-viewed ids not found in embed-video`);
    for (const a of [...adjustments].sort((x, y) => y.botViews - x.botViews).slice(0, 8)) {
      console.log(`    ${a.owner}/${a.permlink}: ${a.before} -> ${a.after}`);
    }

    // ── 2. view-durations + view-sessions ──
    const vd = await db.collection('view-durations').find({ userAgent: BOT_UA, ...UNPAID }).toArray();
    const vs = await db.collection('view-sessions').find({ userAgent: BOT_UA, ...UNPAID }).toArray();
    const affected = new Map();
    for (const r of vd) affected.set(key(r.owner, r.permlink), { owner: r.owner, permlink: r.permlink });
    console.log(`view-durations: ${vd.length} bot rows over ${affected.size} videos; view-sessions: ${vs.length}`);
    await backup(db, 'view_durations', vd, purgedAt);
    await backup(db, 'view_sessions', vs, purgedAt);
    const delVd = await deleteByIds(db, 'view-durations', vd);
    const delVs = await deleteByIds(db, 'view-sessions', vs);

    if (APPLY) console.log(`Deleted: views ${delViews}, view-durations ${delVd}, view-sessions ${delVs}. Backups in purged_bot_*.`);
  } finally {
    await client.close();
  }
}

run().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
