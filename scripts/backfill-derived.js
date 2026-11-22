#!/usr/bin/env node
/**
 * Fills the "made from this" index (utils/derivedStore.js) for posts published
 * before 3speak.tv registered them: every Hive post behind an embed-video
 * (videos, Shorts, reactions) and an embed-audio (narrations) row, read from
 * Hive and kept when its json_metadata names a source (utils/derivedSource.js).
 * Adds rows, and drops the rows of posts that no longer name a source; safe
 * to run again.
 *
 *   node scripts/backfill-derived.js [--days 400] [--dry-run]
 */
require('dotenv').config({ quiet: true });
const { connectToMongo, getDb, closeMongo } = require('../utils/db');
const { hiveRpcBatch } = require('../utils/hive');
const { saveDerived, rowFor, COLLECTION } = require('../utils/derivedStore');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const DAYS = parseInt(value('days', '400'), 10) || 400;
const DRY = flag('dry-run');
const BATCH = 20;
const PAUSE_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function posts(db) {
    const since = new Date(Date.now() - DAYS * 864e5);
    const seen = new Set();
    const out = [];
    const add = (a, p) => {
        if (!a || !p) return;
        const k = `${a}/${p}`;
        if (!seen.has(k)) { seen.add(k); out.push([a, p]); }
    };
    const videos = db.collection('embed-video').find(
        { hive_permlink: { $nin: [null, ''] }, createdAt: { $gte: since } },
        { projection: { owner: 1, hive_author: 1, hive_permlink: 1 } },
    );
    for await (const v of videos) add(v.hive_author || v.owner, v.hive_permlink);
    const audio = db.collection('embed-audio').find(
        { post_permlink: { $nin: [null, ''] } },
        { projection: { owner: 1, post_author: 1, post_permlink: 1 } },
    );
    for await (const a of audio) add(a.post_author || a.owner, a.post_permlink);
    return out;
}

(async () => {
    await connectToMongo();
    const db = getDb();
    const list = await posts(db);
    console.log(`[backfill-derived] ${list.length} posts to read (${DAYS} days)${DRY ? ', dry run' : ''}`);
    const kinds = {};
    let found = 0;
    let removed = 0;
    for (let i = 0; i < list.length; i += BATCH) {
        const chunk = list.slice(i, i + BATCH);
        let results = [];
        try {
            results = await hiveRpcBatch(chunk.map(([a, p], id) => ({
                jsonrpc: '2.0', id, method: 'condenser_api.get_content', params: [a, p],
            })));
        } catch (err) {
            console.error(`[backfill-derived] batch at ${i} failed: ${err.message}`);
            await sleep(2000);
            continue;
        }
        const stale = [];
        for (const r of results || []) {
            const post = r?.result;
            if (!post?.author) continue;
            const row = rowFor(post);
            if (!row) { stale.push({ author: post.author, permlink: post.permlink }); continue; }
            found += 1;
            kinds[row.kind] = (kinds[row.kind] || 0) + 1;
            if (!DRY) await saveDerived(db, post);
        }
        // A row from an earlier run whose post no longer names a source (edited,
        // or a rule here got stricter) goes.
        if (stale.length && !DRY) {
            const gone = await db.collection(COLLECTION).deleteMany({ $or: stale });
            removed += gone.deletedCount || 0;
        }
        if ((i / BATCH) % 25 === 0) console.log(`[backfill-derived] ${Math.min(i + BATCH, list.length)}/${list.length}, ${found} derived`);
        await sleep(PAUSE_MS);
    }
    console.log(`[backfill-derived] done: ${found} derived posts, ${removed} stale rows removed`, kinds);
    await closeMongo();
})().catch((err) => {
    console.error('[backfill-derived] failed:', err.message);
    process.exit(1);
});
