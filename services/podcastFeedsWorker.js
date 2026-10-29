/**
 * Outside podcast feeds: the fetching and parsing half, in a WORKER THREAD.
 *
 * Long-lived, unlike the discover/retention workers: it keeps one Mongo client and
 * answers messages from services/podcastFeeds.js (main thread):
 *
 *   { id, type: 'tick' }                  poll every feed that is due
 *   { id, type: 'probe', url }            someone added a URL: fetch it now, store it
 *   { id, type: 'notes', feed_id, episode_id }  an episode's full show notes (not stored)
 *
 * and replies { id, ok, ... }. Parsing a big feed is synchronous CPU work, which is
 * why none of this happens on the thread that answers HTTP requests.
 *
 * Every episode is kept (up to MAX_ALL_ITEMS per show). A new feed is read in
 * full; after that a poll reads only the newest items to find new episodes, and
 * at most once a day (FULL_EVERY) a changed feed is read in full again, which is
 * also when episodes the host removed are dropped.
 *
 * What a poll costs Mongo: nothing when the host answers 304 or the body hash is
 * unchanged, apart from the schedule fields on the feed row. MongoDB treats an
 * update that sets the same values as a no-op.
 */
const crypto = require('crypto');
const { parentPort } = require('worker_threads');
const { MongoClient } = require('mongodb');
const { MONGODB_URI, DATABASE_NAME } = require('../utils/config');
const { safeFetch } = require('../utils/safeFetch');
const { parseFeed, urlKey, episodeId, notesByGuid } = require('../utils/podcastParse');
const { ObjectId } = require('mongodb');

const FEEDS = 'podcast_feeds';
const EPISODES = 'podcast_episodes';
const SUBS = 'podcast_subs';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const TICK_BATCH = Math.max(1, parseInt(process.env.PODCAST_TICK_BATCH, 10) || 60);
const CONCURRENCY = Math.max(1, parseInt(process.env.PODCAST_FETCH_CONCURRENCY, 10) || 6);
const PER_HOST = 2;
// Only a handful of brand-new, recent episodes in one poll is "new episodes". More
// than that is a host re-issuing guids or a back catalogue appearing at once; those
// are stored quietly instead of buzzing every subscriber.
const NOTIFY_MAX_NEW = 5;
const NOTIFY_MAX_AGE = 7 * DAY;
const FULL_EVERY = DAY;

let client;
let db;

async function connect() {
  if (db) return db;
  client = new MongoClient(MONGODB_URI, { maxPoolSize: 5 });
  await client.connect();
  db = client.db(DATABASE_NAME);
  return db;
}

const jitter = (ms) => Math.round(ms * (0.9 + Math.random() * 0.2));

// Every followed feed is looked at every PODCAST_POLL_MIN minutes (30 by default).
// A conditional GET makes an unchanged feed a 304 or a hash match: no Mongo writes.
const POLL_MS = Math.max(5, parseInt(process.env.PODCAST_POLL_MIN, 10) || 30) * MIN;
function pollInterval() {
  return POLL_MS;
}

function backoff(errorCount) {
  return Math.min(DAY, 15 * MIN * 2 ** Math.max(0, errorCount - 1));
}

const SHOW_FIELDS = ['title', 'author', 'image', 'link', 'description', 'language', 'categories', 'explicit', 'podcast_guid', 'medium', 'funding', 'value'];

function showSet(show) {
  const set = {};
  const unset = {};
  for (const k of SHOW_FIELDS) {
    const v = show[k];
    const empty = v == null || v === '' || v === false || (Array.isArray(v) && !v.length);
    if (empty) unset[k] = ''; else set[k] = v;
  }
  return { set, unset };
}

/** Write a parsed feed's episodes; returns the ones that count as new for notifications. */
async function writeEpisodes(feed, episodes, { firstFetch, prune }) {
  const feedHex = feed._id.toHexString();
  const col = db.collection(EPISODES);
  const rows = episodes.map((e) => ({ ...e, _id: episodeId(feedHex, e.guid) }));
  if (!rows.length) return [];
  const ids = rows.map((r) => r._id);
  const known = new Set((await col.find({ _id: { $in: ids } }, { projection: { _id: 1 } }).toArray()).map((d) => d._id));
  const fresh = rows.filter((r) => !known.has(r._id));
  const now = new Date();
  const recent = fresh.filter((r) => r.published_at && now - r.published_at < NOTIFY_MAX_AGE);
  const announce = !firstFetch && fresh.length <= NOTIFY_MAX_NEW ? recent : [];
  const announced = new Set(announce.map((r) => r._id));

  const ops = rows.map((r) => {
    const { _id, guid, ...fields } = r;
    // Seen "now" only for what we announce; everything else is dated by its own
    // pubDate, so it can never show up as a new-episode notification later.
    const firstSeen = announced.has(_id) ? now : (r.published_at && r.published_at < now ? r.published_at : now);
    const unset = {};
    for (const k of ['bytes', 'duration', 'summary', 'image', 'link', 'value']) if (!(k in fields)) unset[k] = '';
    const update = { $set: { ...fields, feed_id: feed._id }, $setOnInsert: { first_seen_at: firstSeen } };
    if (Object.keys(unset).length) update.$unset = unset;
    return { updateOne: { filter: { _id }, update, upsert: true } };
  });
  for (let i = 0; i < ops.length; i += 500) await col.bulkWrite(ops.slice(i, i + 500), { ordered: false });
  // Only a read of the whole feed knows what the host removed.
  if (prune) await col.deleteMany({ feed_id: feed._id, _id: { $nin: ids } });
  return announce.map((r) => ({ id: r._id, title: r.title }));
}

/** Fold a duplicate feed row into the one we keep: subscriptions move, the rest goes. */
async function mergeInto(dup, keep) {
  const subs = await db.collection(SUBS).find({ feed_id: dup._id }).toArray();
  let moved = 0;
  for (const s of subs) {
    const res = await db.collection(SUBS).updateOne(
      { _id: `${s.user}|${keep._id.toHexString()}` },
      { $setOnInsert: { user: s.user, feed_id: keep._id, added_at: s.added_at, notify: s.notify !== false } },
      { upsert: true },
    );
    if (res.upsertedCount) moved += 1;
  }
  await db.collection(SUBS).deleteMany({ feed_id: dup._id });
  await db.collection(EPISODES).deleteMany({ feed_id: dup._id });
  await db.collection(FEEDS).deleteOne({ _id: dup._id });
  await db.collection(FEEDS).updateOne(
    { _id: keep._id },
    { $inc: { subscribers: moved }, $addToSet: { alt_keys: { $each: [dup.url_key, ...(dup.alt_keys || [])].filter(Boolean) } }, $unset: { orphaned_at: '' } },
  );
  return keep._id;
}

/** Another feed row that is really this show (same final URL or same podcast:guid)? */
async function findTwin(feed, key, guid) {
  const or = [{ url_key: key }, { alt_keys: key }];
  if (guid) or.push({ podcast_guid: guid });
  return db.collection(FEEDS).findOne({ _id: { $ne: feed._id }, $or: or });
}

/**
 * Fetch, parse and store one feed.
 * @returns {{feed_id, status, error?, announce?: [{id,title}], merged?: ObjectId}}
 */
async function pollFeed(feed, { force = false } = {}) {
  const now = new Date();
  const firstFetch = feed.status === 'pending' || !feed.last_ok_at;
  const headers = {};
  if (!force && !firstFetch) {
    if (feed.etag) headers['If-None-Match'] = feed.etag;
    if (feed.last_modified) headers['If-Modified-Since'] = feed.last_modified;
  }
  const col = db.collection(FEEDS);
  try {
    const res = await safeFetch(feed.url, { headers });
    if (res.status === 304) {
      await col.updateOne({ _id: feed._id }, {
        $set: { status: 'ok', last_fetch_at: now, last_ok_at: now, error_count: 0, next_poll_at: new Date(Date.now() + jitter(pollInterval())) },
        $unset: { error: '' },
      });
      return { feed_id: feed._id, status: 'unchanged' };
    }
    const hash = crypto.createHash('sha1').update(res.body).digest('base64url');
    const cond = {};
    if (res.headers.etag) cond.etag = String(res.headers.etag).slice(0, 200);
    if (res.headers['last-modified']) cond.last_modified = String(res.headers['last-modified']).slice(0, 100);
    if (!force && !firstFetch && hash === feed.body_hash) {
      await col.updateOne({ _id: feed._id }, {
        $set: { ...cond, status: 'ok', last_fetch_at: now, last_ok_at: now, error_count: 0, next_poll_at: new Date(Date.now() + jitter(pollInterval())) },
        $unset: { error: '' },
      });
      return { feed_id: feed._id, status: 'unchanged' };
    }

    const full = force || firstFetch || !feed.last_full_at || Date.now() - new Date(feed.last_full_at).getTime() > FULL_EVERY;
    const { show, episodes, itemCount, complete } = parseFeed(res.body.toString('utf8'), { all: full });
    if (!episodes.length) {
      const e = new Error('no playable episodes');
      e.code = 'no_episodes';
      throw e;
    }

    // Same show under another row (an OPML import of a URL that redirects to one we
    // already have, or the same podcast:guid): keep the older row.
    const finalKey = urlKey(res.url);
    const twin = await findTwin(feed, finalKey, show.podcast_guid);
    if (twin) {
      await mergeInto(feed, twin);
      return { feed_id: twin._id, status: 'merged', merged: twin._id };
    }

    const set = { ...showSet(show).set, ...cond, body_hash: hash, item_count: itemCount, status: 'ok', last_fetch_at: now, last_ok_at: now, error_count: 0 };
    if (full) set.last_full_at = now;
    const unset = { ...showSet(show).unset, error: '' };
    const addKeys = [];
    // The feed really moved (all redirects permanent, or itunes:new-feed-url).
    if (res.permanent && finalKey && finalKey !== feed.url_key) {
      set.url = res.url;
      set.url_key = finalKey;
      addKeys.push(feed.url_key);
    } else if (show.new_feed_url && urlKey(show.new_feed_url) && urlKey(show.new_feed_url) !== feed.url_key) {
      const nk = urlKey(show.new_feed_url);
      if (!(await col.findOne({ $or: [{ url_key: nk }, { alt_keys: nk }] }, { projection: { _id: 1 } }))) {
        set.url = show.new_feed_url;
        set.url_key = nk;
        addKeys.push(feed.url_key);
      }
    }
    const newest = episodes.find((e) => e.published_at);
    if (newest) set.last_episode_at = newest.published_at;
    set.next_poll_at = new Date(Date.now() + jitter(pollInterval()));

    const announce = await writeEpisodes(feed, episodes, { firstFetch, prune: full && complete });
    const update = { $set: set, $unset: unset };
    if (addKeys.length) update.$addToSet = { alt_keys: { $each: addKeys } };
    try {
      await col.updateOne({ _id: feed._id }, update);
    } catch (err) {
      // Lost a race for the new url_key: keep the old URL, the twin check merges next time.
      if (err && err.code === 11000) {
        delete set.url; delete set.url_key; delete update.$addToSet;
        await col.updateOne({ _id: feed._id }, update);
      } else throw err;
    }
    return { feed_id: feed._id, status: 'ok', announce, title: show.title, image: show.image };
  } catch (err) {
    const code = String((err && err.code) || 'error').slice(0, 40);
    const errorCount = (feed.error_count || 0) + 1;
    // A feed that worked keeps showing as fine through a blip; three misses in a row
    // and the list says so.
    const status = feed.status === 'ok' && errorCount < 3 ? 'ok' : 'error';
    await col.updateOne({ _id: feed._id }, {
      $set: { status, error: code, error_count: errorCount, last_fetch_at: now, next_poll_at: new Date(Date.now() + jitter(backoff(errorCount))) },
    });
    return { feed_id: feed._id, status: 'error', error: code };
  }
}

const hostOf = (url) => { try { return new URL(url).hostname; } catch (_) { return ''; } };

async function tick() {
  await connect();
  const due = await db.collection(FEEDS)
    .find({ next_poll_at: { $lte: new Date() }, subscribers: { $gt: 0 } })
    .sort({ next_poll_at: 1 }).limit(TICK_BATCH).toArray();
  // At most PER_HOST feeds per host per tick: an OPML full of anchor.fm shows
  // should not look like an attack on anchor.fm. The rest stay due for next tick.
  const perHost = new Map();
  const batch = due.filter((f) => {
    const h = hostOf(f.url);
    const n = perHost.get(h) || 0;
    perHost.set(h, n + 1);
    return n < PER_HOST;
  });
  const results = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batch.length) }, async () => {
    while (i < batch.length) {
      const feed = batch[i++];
      // Read in full, skipping the 304 / hash shortcut, while the show has no cover
      // yet (it may take its newest episode's art, utils/podcastParse.js) or was
      // never read in full (added while only the newest 50 were kept).
      results.push(await pollFeed(feed, { force: feed.status === 'ok' && (!feed.image || !feed.last_full_at) }));
    }
  }));
  const announce = results
    .filter((r) => r.announce && r.announce.length)
    .map((r) => ({ feed_id: r.feed_id.toHexString(), title: r.title, image: r.image, episodes: r.announce }));
  return {
    polled: results.length,
    changed: results.filter((r) => r.status === 'ok').length,
    errors: results.filter((r) => r.status === 'error').length,
    announce,
  };
}

/** A user added a URL we did not have: create the row and fetch it right away. */
async function probe(url) {
  await connect();
  const key = urlKey(url);
  const col = db.collection(FEEDS);
  let feed = await col.findOne({ $or: [{ url_key: key }, { alt_keys: key }] });
  if (feed && feed.status !== 'pending' && feed.last_ok_at) return { feed_id: feed._id.toHexString(), existed: true };
  if (!feed) {
    const doc = { url, url_key: key, alt_keys: [], status: 'pending', subscribers: 0, error_count: 0, created_at: new Date(), next_poll_at: new Date() };
    try {
      const ins = await col.insertOne(doc);
      feed = { ...doc, _id: ins.insertedId };
    } catch (err) {
      if (err && err.code === 11000) feed = await col.findOne({ url_key: key });
      else throw err;
    }
  }
  const r = await pollFeed(feed, { force: true });
  if (r.status === 'error') {
    // Nobody subscribed to it, and it does not work: don't keep the row around.
    const fresh = await col.findOne({ _id: feed._id }, { projection: { subscribers: 1, last_ok_at: 1 } });
    if (fresh && !fresh.subscribers && !fresh.last_ok_at) {
      await col.deleteOne({ _id: feed._id });
      await db.collection(EPISODES).deleteMany({ feed_id: feed._id });
    }
    return { error: r.error };
  }
  return { feed_id: (r.merged || feed._id).toHexString(), existed: !!r.merged };
}

// Show notes per feed, read on demand: an episode page asks for one, the next
// episode of the same show is then answered from here. A few shows, a short while.
const NOTES_TTL = 15 * MIN;
const NOTES_FEEDS = 4;
const notesCache = new Map(); // feedId → { at, byId: Map(episodeId → html) }

async function notes(feedId, epId) {
  await connect();
  let hit = notesCache.get(feedId);
  if (!hit || Date.now() - hit.at > NOTES_TTL) {
    const feed = await db.collection(FEEDS).findOne({ _id: new ObjectId(feedId) }, { projection: { url: 1 } });
    if (!feed) return { error: 'not_found' };
    const res = await safeFetch(feed.url, { timeoutMs: 25000, maxBytes: 32 * 1024 * 1024 });
    const byId = new Map();
    for (const [guid, html] of notesByGuid(res.body.toString('utf8'))) byId.set(episodeId(feedId, guid), html);
    hit = { at: Date.now(), byId };
    notesCache.delete(feedId);
    notesCache.set(feedId, hit);
    while (notesCache.size > NOTES_FEEDS) notesCache.delete(notesCache.keys().next().value);
  }
  return { html: hit.byId.get(epId) || '' };
}

let ticking = false;
// Required by the tests outside a worker, where there is no parent to talk to.
if (parentPort) parentPort.on('message', async (msg) => {
  const reply = (body) => parentPort.postMessage({ id: msg.id, ...body });
  try {
    if (msg.type === 'tick') {
      if (ticking) return reply({ ok: true, skipped: true });
      ticking = true;
      try { reply({ ok: true, ...(await tick()) }); } finally { ticking = false; }
    } else if (msg.type === 'probe') {
      const r = await probe(msg.url);
      reply(r.error ? { ok: false, code: r.error } : { ok: true, ...r });
    } else if (msg.type === 'notes') {
      const r = await notes(String(msg.feed_id), String(msg.episode_id));
      reply(r.error ? { ok: false, code: r.error } : { ok: true, ...r });
    } else {
      reply({ ok: false, code: 'unknown_message' });
    }
  } catch (err) {
    reply({ ok: false, code: String((err && err.code) || 'error').slice(0, 40), error: String((err && err.message) || err).slice(0, 200) });
  }
});

module.exports = { _test: { pollInterval, backoff, showSet } };
