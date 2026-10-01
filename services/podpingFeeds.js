/**
 * Podping: tell podcast apps when a channel's RSS feed gains an episode.
 *
 * Every PODPING_INTERVAL_MIN (default 5) it looks for items that became part of a
 * channel feed (routes/rss.js) in the last PODPING_WINDOW_H hours, and asks the
 * local podping-hivepinger (PODPING_URL, e.g. http://127.0.0.1:1820) to ping
 * `${PODPING_FEED_BASE}/rss/<owner>.xml`. Hivepinger signs the custom_json as
 * @podping.spk, which the feeds already name in <podcast:podping>. Podcast Index
 * and Podcasting 2.0 apps watch the chain and re-fetch the feed within seconds,
 * instead of polling it.
 *
 * Why a poller and not a hook in the publish path: an embed video is linked to its
 * Hive post by the external embed indexer most of the time, not by this service
 * (see videoHiveSync.js), so there is no single place here that sees a publish.
 * Reading the same conditions the feed uses means a ping goes out exactly when the
 * feed changes, whoever did the linking.
 *
 * Each item is pinged ONCE, remembered in `podping_sent` (TTL'd after the window).
 * An item is remembered only after hivepinger accepted it, so an outage of the
 * pinger is retried on the next run. Hivepinger also dedups per URL on its side.
 *
 * Idle until hivepinger is up: each run first asks its /health, and while that
 * fails (no posting key yet, so podping-hivepinger.service never started it, or
 * the container is down) the run does nothing and logs nothing. Set
 * PODPING_ENABLED=false to switch the job off entirely.
 *
 * Windows are `_id` ranges (ObjectId carries the upload time, and _id is always
 * indexed). A video linked to Hive more than PODPING_WINDOW_H after its upload is
 * not pinged; the feed still has it, apps just learn of it on their next poll.
 */
const { ObjectId } = require('mongodb');
const { getDb } = require('../utils/db');
const { ENABLE_MONGO_WRITES } = require('../utils/config');

const PODPING_URL = (process.env.PODPING_URL || 'http://127.0.0.1:1820').replace(/\/$/, '');
const FEED_BASE = (process.env.PODPING_FEED_BASE || 'https://3speak.tv').replace(/\/$/, '');
const WINDOW_H = Math.max(1, parseInt(process.env.PODPING_WINDOW_H, 10) || 48);
const INTERVAL_MIN = Math.max(1, parseInt(process.env.PODPING_INTERVAL_MIN, 10) || 5);
// Every 3Speak feed declares <podcast:medium>video</podcast:medium> at channel level,
// audio included, and the ping's medium must match the feed's.
const MEDIUM = 'video';
const REQUEST_TIMEOUT_MS = 10000;
const SENT_COLLECTION = 'podping_sent';

let running = false;
let indexed = false;
let pingerUp = null;   // last /health outcome, so a change is logged once, not every run

function enabled() {
    return String(process.env.PODPING_ENABLED || 'true').toLowerCase() !== 'false';
}

// hivepinger answers /health with a non-2xx while its key is missing or invalid.
async function pingerHealthy() {
    let ok = false;
    try {
        const res = await fetch(`${PODPING_URL}/health`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        ok = res.ok;
    } catch { /* not running: the normal state until the posting key is installed */ }
    if (pingerUp !== null && ok !== pingerUp) {
        console.log(`[podping] hivepinger at ${PODPING_URL} is ${ok ? 'up, pinging resumes' : 'down, pings paused'}`);
    }
    pingerUp = ok;
    return ok;
}

// Same item conditions as routes/rss.js, so a ping means the feed really changed.
async function newFeedItems(db) {
    const since = ObjectId.createFromTime(Math.floor((Date.now() - WINDOW_H * 3600 * 1000) / 1000));
    const [embed, audio] = await Promise.all([
        db.collection('embed-video').find({
            _id: { $gte: since },
            status: 'published',
            short: false,
            listed_on_3speak: true,
            hive_permlink: { $ne: null },
        }, { projection: { hive_author: 1, hive_permlink: 1 } }).toArray(),
        db.collection('embed-audio').find({
            _id: { $gte: since },
            post_permlink: { $ne: null },
        }, { projection: { owner: 1, post_permlink: 1 } }).toArray(),
    ]);
    return [
        ...embed.map((v) => ({ owner: v.hive_author, key: `v:${v.hive_author}/${v.hive_permlink}` })),
        ...audio.map((a) => ({ owner: a.owner, key: `a:${a.owner}/${a.post_permlink}` })),
    ].filter((it) => it.owner && /^[a-z0-9.-]{3,16}$/.test(it.owner));
}

async function ping(owner) {
    const feed = `${FEED_BASE}/rss/${owner}.xml`;
    const qs = new URLSearchParams({ url: feed, reason: 'update', medium: MEDIUM });
    const res = await fetch(`${PODPING_URL}/podping/?${qs}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`hivepinger ${res.status}`);
    return feed;
}

async function runOnce() {
    if (!enabled() || running) return;
    running = true;
    try {
        if (!(await pingerHealthy())) return;
        const db = getDb();
        const sentCol = db.collection(SENT_COLLECTION);
        if (!indexed && ENABLE_MONGO_WRITES) {
            await sentCol.createIndex({ sentAt: 1 }, { expireAfterSeconds: (WINDOW_H + 24) * 3600 });
            indexed = true;
        }

        const items = await newFeedItems(db);
        if (!items.length) return;
        const sent = new Set((await sentCol.find(
            { _id: { $in: items.map((it) => it.key) } }, { projection: { _id: 1 } },
        ).toArray()).map((d) => d._id));
        const pending = items.filter((it) => !sent.has(it.key));
        if (!pending.length) return;

        // A banned or hidden channel serves an empty feed; don't announce it.
        const owners = [...new Set(pending.map((it) => it.owner))];
        const blocked = new Set((await db.collection('contentcreators').find(
            { username: { $in: owners }, $or: [{ banned: true }, { hidden: true }] },
            { projection: { username: 1 } },
        ).toArray()).map((c) => c.username));

        let pinged = 0; let failed = 0;
        for (const owner of owners) {
            const keys = pending.filter((it) => it.owner === owner).map((it) => it.key);
            if (!blocked.has(owner)) {
                try {
                    await ping(owner);
                    pinged++;
                } catch (e) {
                    failed++;
                    console.warn(`[podping] ${owner}: ${e.message}`);
                    continue;   // not remembered, so the next run retries it
                }
            }
            if (ENABLE_MONGO_WRITES) {
                await sentCol.bulkWrite(keys.map((k) => ({
                    updateOne: { filter: { _id: k }, update: { $setOnInsert: { owner, sentAt: new Date() } }, upsert: true },
                })), { ordered: false });
            }
        }
        console.log(`[podping] ${pending.length} new feed item(s): pinged ${pinged} feed(s), failed ${failed}, skipped ${blocked.size} banned/hidden${ENABLE_MONGO_WRITES ? '' : ' [WRITES DISABLED]'}`);
    } catch (e) {
        console.error('[podping] run:', e.message);
    } finally {
        running = false;
    }
}

module.exports = { runOnce, enabled, INTERVAL_MIN };
