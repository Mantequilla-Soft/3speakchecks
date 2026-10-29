/**
 * Outside podcast feeds: the API behind the Podcasts tab on /audio.
 *
 * Reads (no signature, like every per-user read on this service):
 *   GET  /podcasts/config
 *   GET  /podcasts/subscriptions?user=
 *   GET  /podcasts/latest?user=&before=&limit=     newest episodes of everything followed
 *   GET  /podcasts/notifications?user=             new episodes since each follow (bell)
 *   GET  /podcasts/feed/:id                        a show and its stored episodes
 *   GET  /podcasts/feed/:id/older?offset=          past the 50 we keep, read live
 *   GET  /podcasts/episode/:id
 *   GET  /podcasts/search?q=                       Podcast Index, when a key is set
 *
 * Writes, signed:
 *   POST /podcasts/subscribe   { user, urls: [..], titles?: [..], signature, timestamp }
 *   POST /podcasts/unsubscribe { user, feed_id, signature, timestamp }
 *   POST /podcasts/notify      { user, feed_id, notify, signature, timestamp }
 *
 * Proof of who is asking, either:
 * - a VOUCH from our own API (`<action>-vouch`, signed by @threespeak's posting key
 *   for the session it verified: Butter Auth, HiveSigner, wallet login, and warm-up
 *   users as `~handle`), see /api/podcasts/signature in the frontend server; or
 * - the user's own posting authority over `<action>` (Keychain & co. signing it).
 * utils/hiveAuth.js keeps vouches for reads. Podcast subscriptions are the one
 * place a vouch may also write, on purpose: they are 3Speak's own off-chain list,
 * never a Hive operation and never money, and requiring a posting grant would lock
 * out most listeners.
 *
 * No notification rows: the bell is computed from podcast_subs.added_at and each
 * episode's first_seen_at, and the "seen" mark lives in the browser.
 */
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { ObjectId } = require('mongodb');
const { getDb } = require('../utils/db');
const { verifyHiveAuthority, verifyDelegateVouch } = require('../utils/hiveAuth');
const { SIGNATURE_TIMESTAMP_TOLERANCE_MS, AD_SIGNING_DELEGATES } = require('../utils/config');
const { checkUrl } = require('../utils/safeFetch');
const { urlKey } = require('../utils/podcastParse');
const podcastFeeds = require('../services/podcastFeeds');

const router = express.Router();
const { FEEDS, EPISODES, SUBS } = podcastFeeds.collections;

const USER_RE = /^~?[a-z0-9][a-z0-9.-]{1,31}$/;
const ID_RE = /^[0-9a-f]{24}$/;
const EPISODE_RE = /^[0-9a-f]{24}:[A-Za-z0-9_-]{16}$/;
const MAX_FEEDS_PER_USER = Math.max(1, parseInt(process.env.PODCAST_MAX_FEEDS_PER_USER, 10) || 150);
const MAX_URLS_PER_CALL = 200;
const NOTIFY_DAYS = 14;

const PI_KEY = process.env.PODCASTINDEX_API_KEY || '';
const PI_SECRET = process.env.PODCASTINDEX_API_SECRET || '';

// Must match podcastMessage() in the frontend (src/lib/podcasts.js) and the signer
// in server/index.cjs exactly.
const podcastMessage = (action, user, payload, timestamp) =>
  ['3speak-podcasts', action, user, payload, String(timestamp)].join('|');
const urlsDigest = (urls) => crypto.createHash('sha256').update(urls.join('\n'), 'utf8').digest('hex');

const userOf = (v) => String(v || '').trim().toLowerCase().replace(/^@/, '');

async function proveUser(b, action, payload) {
  const user = userOf(b.user);
  if (!USER_RE.test(user)) return { error: [400, 'invalid user'] };
  const signature = typeof b.signature === 'string' ? b.signature.slice(0, 200) : '';
  const timestamp = parseInt(b.timestamp, 10);
  if (!signature || !Number.isFinite(timestamp)) {
    return { error: [401, 'Signature required'], expected_message: podcastMessage(action, user, payload, '<ms>') };
  }
  if (Math.abs(Date.now() - timestamp) > SIGNATURE_TIMESTAMP_TOLERANCE_MS) return { error: [401, 'timestamp out of tolerance'] };
  try {
    const v = await verifyDelegateVouch({ message: podcastMessage(`${action}-vouch`, user, payload, timestamp), signature, delegates: AD_SIGNING_DELEGATES });
    if (v.ok) return { user };
  } catch (_) { /* not a vouch */ }
  if (!user.startsWith('~')) {
    try {
      const v = await verifyHiveAuthority({ message: podcastMessage(action, user, payload, timestamp), signature, username: user, allowedDelegates: AD_SIGNING_DELEGATES });
      if (v.ok) return { user };
    } catch (_) { /* unknown account or bad signature */ }
  }
  return { error: [401, 'Invalid signature'] };
}

// Every write is a database write; this keeps one account from making it a hobby.
const recent = new Map();
function tooMany(user, max = 60) {
  const now = Date.now();
  const list = (recent.get(user) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (list.length >= max) return true;
  list.push(now);
  recent.set(user, list);
  if (recent.size > 5000) recent.delete(recent.keys().next().value);
  return false;
}

function presentFeed(f, extra = {}) {
  if (!f) return null;
  const out = {
    id: f._id.toHexString(),
    url: f.url,
    title: f.title || '',
    author: f.author || '',
    image: f.image || '',
    status: f.status,
    last_episode_at: f.last_episode_at || null,
    ...extra,
  };
  for (const k of ['link', 'description', 'language', 'categories', 'explicit', 'funding', 'value', 'error', 'item_count']) {
    if (f[k] !== undefined && f[k] !== null && f[k] !== '') out[k] = f[k];
  }
  return out;
}

function presentEpisode(e) {
  const out = {
    id: e._id,
    feed_id: typeof e.feed_id === 'string' ? e.feed_id : e.feed_id.toHexString(),
    title: e.title || '',
    audio_url: e.audio_url,
    mime: e.mime || '',
    published_at: e.published_at || null,
  };
  for (const k of ['bytes', 'duration', 'summary', 'image', 'link', 'value']) if (e[k]) out[k] = e[k];
  return out;
}

// Just enough of a show to draw an episode row and its tip button.
const FEED_CARD = { title: 1, author: 1, image: 1, value: 1, funding: 1, url: 1, status: 1 };
const feedCard = (f) => presentFeed(f);

function disabled(res) {
  return res.status(503).json({ success: false, error: 'podcasts are switched off', code: 'disabled' });
}

// ─── Reads ────────────────────────────────────────────────────────────────────

router.get('/config', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ success: true, enabled: podcastFeeds.enabled(), search: !!(PI_KEY && PI_SECRET), max_feeds: MAX_FEEDS_PER_USER });
});

router.get('/subscriptions', async (req, res) => {
  const user = userOf(req.query.user);
  if (!USER_RE.test(user)) return res.status(400).json({ success: false, error: 'invalid user' });
  try {
    const db = getDb();
    const subs = await db.collection(SUBS).find({ user }).toArray();
    const feeds = subs.length
      ? await db.collection(FEEDS).find({ _id: { $in: subs.map((s) => s.feed_id) } }).toArray()
      : [];
    const byId = new Map(feeds.map((f) => [f._id.toHexString(), f]));
    const list = subs.map((s) => {
      const f = byId.get(s.feed_id.toHexString());
      return f ? { ...presentFeed(f), notify: s.notify !== false, added_at: s.added_at } : null;
    }).filter(Boolean).sort((a, b) => (a.title || a.url).localeCompare(b.title || b.url));
    res.json({ success: true, subscriptions: list });
  } catch (err) {
    console.error('[podcasts] subscriptions:', err.message);
    res.status(500).json({ success: false, error: 'could not load subscriptions' });
  }
});

router.get('/latest', async (req, res) => {
  const user = userOf(req.query.user);
  if (!USER_RE.test(user)) return res.status(400).json({ success: false, error: 'invalid user' });
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 30));
  const before = req.query.before ? new Date(String(req.query.before)) : null;
  try {
    const db = getDb();
    const subs = await db.collection(SUBS).find({ user }, { projection: { feed_id: 1 } }).toArray();
    if (!subs.length) return res.json({ success: true, episodes: [], feeds: {} });
    const q = { feed_id: { $in: subs.map((s) => s.feed_id) } };
    if (before && !Number.isNaN(before.getTime())) q.published_at = { $lt: before };
    const eps = await db.collection(EPISODES).find(q).sort({ published_at: -1 }).limit(limit).toArray();
    const ids = [...new Set(eps.map((e) => e.feed_id.toHexString()))].map((h) => new ObjectId(h));
    const feeds = ids.length ? await db.collection(FEEDS).find({ _id: { $in: ids } }, { projection: FEED_CARD }).toArray() : [];
    res.json({
      success: true,
      episodes: eps.map(presentEpisode),
      feeds: Object.fromEntries(feeds.map((f) => [f._id.toHexString(), feedCard(f)])),
    });
  } catch (err) {
    console.error('[podcasts] latest:', err.message);
    res.status(500).json({ success: false, error: 'could not load episodes' });
  }
});

router.get('/notifications', async (req, res) => {
  const user = userOf(req.query.user);
  if (!USER_RE.test(user)) return res.status(400).json({ success: false, error: 'invalid user' });
  try {
    const db = getDb();
    const subs = await db.collection(SUBS).find({ user, notify: { $ne: false } }, { projection: { feed_id: 1, added_at: 1 } }).toArray();
    if (!subs.length) return res.json({ success: true, episodes: [], feeds: {} });
    const since = new Date(Date.now() - NOTIFY_DAYS * 24 * 3600 * 1000);
    const addedAt = new Map(subs.map((s) => [s.feed_id.toHexString(), s.added_at]));
    const eps = (await db.collection(EPISODES)
      .find({ feed_id: { $in: subs.map((s) => s.feed_id) }, first_seen_at: { $gt: since } })
      .sort({ first_seen_at: -1 }).limit(60).toArray())
      // Only what arrived after this person followed the show.
      .filter((e) => e.first_seen_at > (addedAt.get(e.feed_id.toHexString()) || since))
      .slice(0, 30);
    const ids = [...new Set(eps.map((e) => e.feed_id.toHexString()))].map((h) => new ObjectId(h));
    const feeds = ids.length ? await db.collection(FEEDS).find({ _id: { $in: ids } }, { projection: FEED_CARD }).toArray() : [];
    res.json({
      success: true,
      episodes: eps.map((e) => ({ ...presentEpisode(e), first_seen_at: e.first_seen_at })),
      feeds: Object.fromEntries(feeds.map((f) => [f._id.toHexString(), feedCard(f)])),
    });
  } catch (err) {
    console.error('[podcasts] notifications:', err.message);
    res.status(500).json({ success: false, error: 'could not load notifications' });
  }
});

router.get('/feed/:id', async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(400).json({ success: false, error: 'invalid id' });
  try {
    const db = getDb();
    const _id = new ObjectId(req.params.id);
    const feed = await db.collection(FEEDS).findOne({ _id });
    if (!feed) return res.status(404).json({ success: false, error: 'not found' });
    const eps = await db.collection(EPISODES).find({ feed_id: _id }).sort({ published_at: -1 }).limit(50).toArray();
    res.json({
      success: true,
      feed: presentFeed(feed, { subscribers: feed.subscribers || 0 }),
      episodes: eps.map(presentEpisode),
      older_available: (feed.item_count || 0) > eps.length,
    });
  } catch (err) {
    console.error('[podcasts] feed:', err.message);
    res.status(500).json({ success: false, error: 'could not load the show' });
  }
});

router.get('/feed/:id/older', async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(400).json({ success: false, error: 'invalid id' });
  if (!podcastFeeds.enabled()) return disabled(res);
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const r = await podcastFeeds.ask('older', { feed_id: req.params.id, offset, limit: 50 }, 40000);
  if (!r.ok) return res.status(r.code === 'not_found' ? 404 : 502).json({ success: false, error: 'could not read the feed', code: r.code });
  res.json({ success: true, episodes: r.episodes.map(presentEpisode), total: r.total, next_offset: offset + r.episodes.length });
});

router.get('/episode/:id', async (req, res) => {
  const id = String(req.params.id);
  if (!EPISODE_RE.test(id)) return res.status(400).json({ success: false, error: 'invalid id' });
  try {
    const db = getDb();
    const ep = await db.collection(EPISODES).findOne({ _id: id });
    if (!ep) return res.status(404).json({ success: false, error: 'not found' });
    const feed = await db.collection(FEEDS).findOne({ _id: ep.feed_id }, { projection: FEED_CARD });
    res.json({ success: true, episode: presentEpisode(ep), feed: feedCard(feed) });
  } catch (err) {
    console.error('[podcasts] episode:', err.message);
    res.status(500).json({ success: false, error: 'could not load the episode' });
  }
});

// ─── Search (Podcast Index) ───────────────────────────────────────────────────

const searchLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30, standardHeaders: false, legacyHeaders: false,
  message: { success: false, error: 'Too many requests' },
});
const searchCache = new Map();

router.get('/search', searchLimiter, async (req, res) => {
  if (!PI_KEY || !PI_SECRET) return res.status(503).json({ success: false, error: 'search is not configured', code: 'search_disabled' });
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (q.length < 2) return res.json({ success: true, results: [] });
  const key = q.toLowerCase();
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return res.json({ success: true, results: hit.results });
  try {
    const date = String(Math.floor(Date.now() / 1000));
    const auth = crypto.createHash('sha1').update(PI_KEY + PI_SECRET + date).digest('hex');
    const r = await fetch(`https://api.podcastindex.org/api/1.0/search/byterm?q=${encodeURIComponent(q)}&max=20`, {
      headers: { 'User-Agent': '3SpeakPodcastBot/1.0', 'X-Auth-Key': PI_KEY, 'X-Auth-Date': date, Authorization: auth },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`podcastindex ${r.status}`);
    const data = await r.json();
    const results = (data.feeds || []).filter((f) => f.url && !f.dead).slice(0, 20).map((f) => ({
      title: String(f.title || '').slice(0, 200),
      author: String(f.author || f.ownerName || '').slice(0, 120),
      url: f.url,
      image: f.artwork || f.image || '',
      episodes: f.episodeCount || 0,
      last_episode_at: f.newestItemPubdate ? new Date(f.newestItemPubdate * 1000) : null,
      value: !!f.value,
    }));
    searchCache.set(key, { at: Date.now(), results });
    if (searchCache.size > 300) searchCache.delete(searchCache.keys().next().value);
    res.json({ success: true, results });
  } catch (err) {
    console.warn('[podcasts] search:', err.message);
    res.status(502).json({ success: false, error: 'search failed' });
  }
});

// ─── Writes ───────────────────────────────────────────────────────────────────

/** 3Speak's own channel feeds belong in the 3Speak tab, not here. */
function internalOwner(key) {
  const m = key.match(/^(?:[a-z0-9-]+\.)?3speak\.tv\/rss\/([a-z0-9.-]+)\.xml$/);
  return m ? m[1] : null;
}

router.post('/subscribe', express.json({ limit: '256kb' }), async (req, res) => {
  if (!podcastFeeds.enabled()) return disabled(res);
  const b = req.body || {};
  const urls = Array.isArray(b.urls) ? b.urls.map((u) => String(u || '').trim()).filter(Boolean) : [];
  if (!urls.length || urls.length > MAX_URLS_PER_CALL || urls.some((u) => u.length > 2000)) {
    return res.status(400).json({ success: false, error: 'urls must be 1-200 URLs' });
  }
  const proof = await proveUser(b, 'subscribe', urlsDigest(urls));
  if (proof.error) return res.status(proof.error[0]).json({ success: false, error: proof.error[1], expected_message: proof.expected_message });
  const { user } = proof;
  if (tooMany(user)) return res.status(429).json({ success: false, error: 'too many changes, try again later' });

  const titles = Array.isArray(b.titles) ? b.titles : [];
  const db = getDb();
  const feeds = db.collection(FEEDS);
  const subs = db.collection(SUBS);
  let room = MAX_FEEDS_PER_USER - await subs.countDocuments({ user });
  const results = [];
  const single = urls.length === 1;

  for (let i = 0; i < urls.length; i += 1) {
    const url = urls[i];
    const out = { url };
    results.push(out);
    try {
      checkUrl(url);
    } catch (err) {
      out.code = err.code || 'bad_url';
      continue;
    }
    const key = urlKey(url);
    const owner = internalOwner(key);
    if (owner) { out.code = 'internal_feed'; out.owner = owner; continue; }

    let feed = await feeds.findOne({ $or: [{ url_key: key }, { alt_keys: key }] }, { projection: { _id: 1, status: 1, last_ok_at: 1 } });
    if (feed) {
      const already = await subs.findOne({ _id: `${user}|${feed._id.toHexString()}` }, { projection: { _id: 1 } });
      if (already) { out.ok = true; out.already = true; out.feed_id = feed._id.toHexString(); continue; }
    }
    if (room <= 0) { out.code = 'limit'; continue; }

    if (single && (!feed || !feed.last_ok_at)) {
      // One URL: fetch it now, so the person learns right away whether it is a podcast.
      const r = await podcastFeeds.ask('probe', { url }, 35000);
      if (!r.ok) { out.code = r.code || 'error'; continue; }
      feed = { _id: new ObjectId(r.feed_id) };
    } else if (!feed) {
      // A batch (OPML): the worker reads them over the next minutes.
      const title = String(titles[i] || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      const doc = { url, url_key: key, alt_keys: [], status: 'pending', subscribers: 0, error_count: 0, created_at: new Date(), next_poll_at: new Date() };
      if (title) doc.title = title;
      try {
        feed = { _id: (await feeds.insertOne(doc)).insertedId };
      } catch (err) {
        if (err && err.code === 11000) feed = await feeds.findOne({ url_key: key }, { projection: { _id: 1 } });
        else throw err;
      }
    }

    const feedHex = feed._id.toHexString();
    const up = await subs.updateOne(
      { _id: `${user}|${feedHex}` },
      { $setOnInsert: { user, feed_id: feed._id, added_at: new Date(), notify: true } },
      { upsert: true },
    );
    if (up.upsertedCount) {
      room -= 1;
      await feeds.updateOne({ _id: feed._id }, { $inc: { subscribers: 1 }, $unset: { orphaned_at: '' } });
      await feeds.updateOne({ _id: feed._id, added_by: { $exists: false } }, { $set: { added_by: user } });
    }
    out.ok = true;
    out.feed_id = feedHex;
    if (!up.upsertedCount) out.already = true;
  }
  const added = results.filter((r) => r.ok && !r.already).length;
  if (added) console.log(`[podcasts] ${user} followed ${added} feed(s)`);
  res.json({ success: results.some((r) => r.ok), results });
});

router.post('/unsubscribe', express.json({ limit: '4kb' }), async (req, res) => {
  const b = req.body || {};
  const feedId = String(b.feed_id || '');
  if (!ID_RE.test(feedId)) return res.status(400).json({ success: false, error: 'invalid feed_id' });
  const proof = await proveUser(b, 'unsubscribe', feedId);
  if (proof.error) return res.status(proof.error[0]).json({ success: false, error: proof.error[1], expected_message: proof.expected_message });
  if (tooMany(proof.user)) return res.status(429).json({ success: false, error: 'too many changes, try again later' });
  try {
    const db = getDb();
    const del = await db.collection(SUBS).deleteOne({ _id: `${proof.user}|${feedId}` });
    if (del.deletedCount) {
      const _id = new ObjectId(feedId);
      await db.collection(FEEDS).updateOne({ _id }, { $inc: { subscribers: -1 } });
      // The last listener left: the feed and its episodes go after a grace week
      // (services/podcastFeeds.js gc), unless someone follows it again.
      await db.collection(FEEDS).updateOne({ _id, subscribers: { $lte: 0 } }, { $set: { orphaned_at: new Date() } });
    }
    res.json({ success: true, removed: !!del.deletedCount });
  } catch (err) {
    console.error('[podcasts] unsubscribe:', err.message);
    res.status(500).json({ success: false, error: 'could not unfollow' });
  }
});

router.post('/notify', express.json({ limit: '4kb' }), async (req, res) => {
  const b = req.body || {};
  const feedId = String(b.feed_id || '');
  if (!ID_RE.test(feedId) || typeof b.notify !== 'boolean') return res.status(400).json({ success: false, error: 'invalid feed_id or notify' });
  const proof = await proveUser(b, 'notify', `${feedId}:${b.notify ? 'on' : 'off'}`);
  if (proof.error) return res.status(proof.error[0]).json({ success: false, error: proof.error[1], expected_message: proof.expected_message });
  if (tooMany(proof.user)) return res.status(429).json({ success: false, error: 'too many changes, try again later' });
  try {
    const r = await getDb().collection(SUBS).updateOne({ _id: `${proof.user}|${feedId}` }, { $set: { notify: b.notify } });
    if (!r.matchedCount) return res.status(404).json({ success: false, error: 'not following this show' });
    res.json({ success: true, notify: b.notify });
  } catch (err) {
    console.error('[podcasts] notify:', err.message);
    res.status(500).json({ success: false, error: 'could not save' });
  }
});

module.exports = router;
module.exports._test = { podcastMessage, urlsDigest, internalOwner, presentEpisode };
