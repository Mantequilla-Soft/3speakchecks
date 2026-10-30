/**
 * Outside podcast feeds: the API behind the Podcasts tab on /audio.
 *
 * Reads (no signature, like every per-user read on this service):
 *   GET  /podcasts/config
 *   GET  /podcasts/subscriptions?user=
 *   GET  /podcasts/latest?user=&before=&limit=     newest episodes of everything followed
 *   GET  /podcasts/notifications?user=             new episodes since each follow (bell)
 *   GET  /podcasts/feed/:id?since=&until=&limit=&q=   a show and its newest episodes
 *   GET  /podcasts/feed/:id/older?offset=&since=&until=&q=   the next page of them
 *   GET  /podcasts/episode/:id
 *   GET  /podcasts/episode/:id/notes               full show notes, read from the feed
 *   GET  /podcasts/episode/:id/chapters            chapters (JSON file or inline), see utils/podcastMedia.js
 *   GET  /podcasts/episode/:id/transcript?lang=    a transcript as timed cues
 *   GET  /podcasts/episode/:id/download            the audio through us, with CORS, for saving offline
 *   GET  /podcasts/search?q=&country=              Podcast Index + Apple Podcasts + fyyd, merged
 *   GET  /podcasts/person?q=                       shows a host or guest appears in (Podcast Index)
 *   GET  /podcasts/trending?lang=&cat=             Podcast Index's trending shows
 *   GET  /podcasts/charts?country=&cat=            Apple Podcasts' top charts
 * (directories: utils/podcastDirectories.js)
 *   GET  /podcasts/discover                        most followed + recently followed shows
 *   GET  /podcasts/art/:token/:px.jpg              cover art, see utils/podcastArt.js
 *   GET  /podcasts/progress?user=&ids=|&feed=      how far the user got in episodes
 *   POST /podcasts/progress                        save that (session vouch, below)
 *
 * Writes, signed:
 *   POST /podcasts/subscribe   { user, urls: [..], titles?: [..], private?: [..], signature, timestamp }
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
 *
 * PRIVATE feeds (paid or password-protected: `private: true` on subscribe, or a
 * URL with `user:pass@`) are one row per listener, see services/podcastFeedsWorker.js.
 * Their URL is never returned (`url: ''`, no `keys`), they are in no public list,
 * and reading their episodes (every read below that returns one, chapters,
 * transcripts and downloads included) needs the listener's session vouch as query
 * parameters `vu=&vts=&vsig=` (the one POST /progress takes) and a follow of that
 * feed. Without it a list leaves the feed out and a single read is a 404.
 */
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { ObjectId } = require('mongodb');
const { getDb } = require('../utils/db');
const { verifyHiveAuthority, verifyDelegateVouch } = require('../utils/hiveAuth');
const { SIGNATURE_TIMESTAMP_TOLERANCE_MS, AD_SIGNING_DELEGATES } = require('../utils/config');
const { Transform, pipeline } = require('stream');
const { checkUrl, safeFetch, safeStream, splitCredentials } = require('../utils/safeFetch');
const { urlKey, privateKey } = require('../utils/podcastParse');
const media = require('../utils/podcastMedia');
const { artToken, urlFromToken, renderArt, SIZES } = require('../utils/podcastArt');
const podcastFeeds = require('../services/podcastFeeds');
const directories = require('../utils/podcastDirectories');

const router = express.Router();
const { FEEDS, EPISODES, SUBS, PROGRESS } = podcastFeeds.collections;

const USER_RE = /^~?[a-z0-9][a-z0-9.-]{1,31}$/;
const ID_RE = /^[0-9a-f]{24}$/;
const EPISODE_RE = /^[0-9a-f]{24}:[A-Za-z0-9_-]{16}$/;
const MAX_FEEDS_PER_USER = Math.max(1, parseInt(process.env.PODCAST_MAX_FEEDS_PER_USER, 10) || 150);
const MAX_URLS_PER_CALL = 200;
const NOTIFY_DAYS = 14;


// Must match podcastMessage() in the frontend (src/lib/podcasts.js) and the signer
// in server/index.cjs exactly.
const podcastMessage = (action, user, payload, timestamp) =>
  ['3speak-podcasts', action, user, payload, String(timestamp)].join('|');
const urlsDigest = (urls) => crypto.createHash('sha256').update(urls.join('\n'), 'utf8').digest('hex');

const clientIpOf = (req) => String(req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0] || req.ip || '').trim();
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
function tooManyIn(map, user, max) {
  const now = Date.now();
  const list = (map.get(user) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (list.length >= max) return true;
  list.push(now);
  map.set(user, list);
  if (map.size > 5000) map.delete(map.keys().next().value);
  return false;
}
const recent = new Map();
const tooMany = (user, max = 60) => tooManyIn(recent, user, max);

// ─── Private feeds ────────────────────────────────────────────────────────────

// A checked vouch is remembered until it runs out: the episode list, the player
// and the progress bars all send the same one, many times a minute.
const readers = new Map(); // `user|ts|sig` → valid until
async function readerOf(req) {
  const q = req.query || {};
  if (!q.vu || !q.vsig || !q.vts) return null;
  const user = userOf(q.vu);
  const key = `${user}|${String(q.vts).slice(0, 20)}|${String(q.vsig).slice(0, 200)}`;
  const until = readers.get(key);
  if (until && until > Date.now()) return user;
  const ok = await proveProgressUser({ user: q.vu, signature: String(q.vsig), timestamp: q.vts });
  if (!ok) return null;
  readers.set(key, parseInt(q.vts, 10) + PROGRESS_VOUCH_MAX_AGE_MS);
  if (readers.size > 2000) readers.delete(readers.keys().next().value);
  return ok;
}

const hexOf = (id) => (typeof id === 'string' ? id : id.toHexString());

/** May this request read a feed (or one of its episodes)? A private one: only a vouched follower. */
async function mayRead(req, isPrivate, feedId) {
  if (!isPrivate) return true;
  const reader = await readerOf(req);
  if (!reader) return false;
  return !!(await getDb().collection(SUBS).findOne({ _id: `${reader}|${hexOf(feedId)}` }, { projection: { _id: 1 } }));
}

/**
 * The feeds of `user`'s follows that this request may see: all of them when it
 * carries that user's vouch, else all but the private ones. (Following is proven
 * by the follow rows themselves.)
 */
async function visibleFeedIds(req, user, ids) {
  if (!ids.length) return ids;
  const priv = await getDb().collection(FEEDS).find({ _id: { $in: ids }, private: true }, { projection: { _id: 1 } }).toArray();
  if (!priv.length || (await readerOf(req)) === user) return ids;
  const hidden = new Set(priv.map((f) => f._id.toHexString()));
  return ids.filter((id) => !hidden.has(hexOf(id)));
}

/**
 * The Basic auth of a private feed, for a URL on that feed's own host (its audio,
 * chapters, transcripts often sit behind the same password). '' otherwise.
 */
async function privateAuth(ep, url) {
  if (!ep.private) return '';
  const feed = await getDb().collection(FEEDS).findOne({ _id: ep.feed_id }, { projection: { url: 1 } });
  if (!feed) return '';
  const { url: bare, auth } = splitCredentials(feed.url);
  try { return auth && new URL(bare).origin === new URL(url).origin ? auth : ''; } catch (_) { return ''; }
}

// A stream with no end time that started this long ago is over, whatever the
// feed still says (an unchanged feed is not read again).
const LIVE_STALE_MS = 24 * 3600 * 1000;

/** The show's live items that are still upcoming or running. */
function liveNow(list, now = Date.now()) {
  return (Array.isArray(list) ? list : []).filter((l) => {
    const end = l.end ? new Date(l.end).getTime() : 0;
    const start = l.start ? new Date(l.start).getTime() : 0;
    if (end) return end > now;
    return !start || now - start < LIVE_STALE_MS;
  }).map((l) => {
    const out = { id: l.id, title: l.title || '', status: l.status, start: l.start || null, url: l.url, mime: l.mime || '' };
    if (l.end) out.end = l.end;
    if (l.link) out.link = l.link;
    return out;
  });
}

function presentFeed(f, extra = {}) {
  if (!f) return null;
  const out = {
    id: f._id.toHexString(),
    // A private feed's URL holds the listener's password or token: never sent.
    url: f.private ? '' : f.url,
    title: f.title || '',
    author: f.author || '',
    image: f.image || '',
    status: f.status,
    last_episode_at: f.last_episode_at || null,
    ...extra,
  };
  const art = artToken(f.image);
  if (art) out.art = art;
  for (const k of ['link', 'description', 'language', 'categories', 'explicit', 'funding', 'value', 'error', 'item_count']) {
    if (f[k] !== undefined && f[k] !== null && f[k] !== '') out[k] = f[k];
  }
  if (Array.isArray(f.persons) && f.persons.length) out.persons = f.persons;
  const live = liveNow(f.live);
  if (live.length) out.live = live;
  if (f.private) out.private = true;
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
  for (const k of ['bytes', 'duration', 'summary', 'image', 'link', 'value', 'episode_type', 'persons', 'soundbites', 'video']) if (e[k]) out[k] = e[k];
  if (e.image) out.art = artToken(e.image);
  for (const k of ['season', 'episode']) if (typeof e[k] === 'number') out[k] = e[k];
  // Only that there are chapters and which transcript languages: the files'
  // addresses stay here, the player asks /episode/:id/chapters and /transcript.
  if (e.chapters || e.chapters_url) out.chapters = true;
  if (Array.isArray(e.transcripts) && e.transcripts.length) out.transcripts = e.transcripts.map((t) => ({ lang: t.lang, type: t.type }));
  if (e.private) out.private = true;
  return out;
}

// Lists never need the inline chapters (only that there are some, `chapters`).
const EPISODE_LIST = { chapters_inline: 0 };

/**
 * Shows without cover art of their own get the art of their newest stored episode
 * that has some, right when they are listed (the parser does the same on a show's
 * next full read, utils/podcastParse.js). Changes the docs in place, never Mongo.
 */
async function fillMissingArt(feedDocs) {
  const missing = feedDocs.filter((f) => f && f._id && !f.image);
  if (!missing.length) return feedDocs;
  const rows = await getDb().collection(EPISODES).aggregate([
    { $match: { feed_id: { $in: missing.map((f) => f._id) }, image: { $exists: true } } },
    { $sort: { published_at: -1 } },
    { $group: { _id: '$feed_id', image: { $first: '$image' } } },
  ]).toArray();
  const byId = new Map(rows.map((r) => [String(r._id), r.image]));
  for (const f of missing) {
    const image = byId.get(String(f._id));
    if (image) f.image = image;
  }
  return feedDocs;
}

// Just enough of a show to draw an episode row and its tip button.
const FEED_CARD = { title: 1, author: 1, image: 1, value: 1, funding: 1, url: 1, status: 1, link: 1, private: 1 };
const feedCard = (f) => presentFeed(f);

function disabled(res) {
  return res.status(503).json({ success: false, error: 'podcasts are switched off', code: 'disabled' });
}

// ─── Reads ────────────────────────────────────────────────────────────────────

router.get('/config', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  // Search and charts need no key (Apple, fyyd); people and trending are Podcast Index only.
  const pi = directories.piEnabled();
  res.json({
    success: true, enabled: podcastFeeds.enabled(), search: true, charts: true, person: pi, trending: pi,
    chart_countries: directories.CHART_COUNTRIES, max_feeds: MAX_FEEDS_PER_USER,
  });
});

router.get('/subscriptions', async (req, res) => {
  const user = userOf(req.query.user);
  if (!USER_RE.test(user)) return res.status(400).json({ success: false, error: 'invalid user' });
  try {
    const db = getDb();
    const subs = await db.collection(SUBS).find({ user }).toArray();
    const all = subs.length
      ? await db.collection(FEEDS).find({ _id: { $in: subs.map((s) => s.feed_id) } }).toArray()
      : [];
    // Private feeds only with this user's vouch.
    const vouched = all.some((f) => f.private) && (await readerOf(req)) === user;
    const feeds = await fillMissingArt(all.filter((f) => !f.private || vouched));
    const byId = new Map(feeds.map((f) => [f._id.toHexString(), f]));
    const list = subs.map((s) => {
      const f = byId.get(s.feed_id.toHexString());
      if (!f) return null;
      // keys: every address this feed is known under (it moved, or two URLs were
      // one feed), so a directory listing it under another one shows it as followed.
      // None for a private feed: its key is the listener's own, not an address.
      const keys = f.private ? [] : [f.url_key, ...(f.alt_keys || [])].filter(Boolean);
      return { ...presentFeed(f), keys, notify: s.notify !== false, added_at: s.added_at };
    }).filter(Boolean).sort((a, b) => (a.title || a.url || a.id).localeCompare(b.title || b.url || b.id));
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
    const feedIds = await visibleFeedIds(req, user, subs.map((s) => s.feed_id));
    if (!feedIds.length) return res.json({ success: true, episodes: [], feeds: {} });
    const q = { feed_id: { $in: feedIds } };
    if (before && !Number.isNaN(before.getTime())) q.published_at = { $lt: before };
    const eps = await db.collection(EPISODES).find(q, { projection: EPISODE_LIST }).sort({ published_at: -1 }).limit(limit).toArray();
    const ids = [...new Set(eps.map((e) => e.feed_id.toHexString()))].map((h) => new ObjectId(h));
    const feeds = ids.length ? await fillMissingArt(await db.collection(FEEDS).find({ _id: { $in: ids } }, { projection: FEED_CARD }).toArray()) : [];
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
    const feedIds = await visibleFeedIds(req, user, subs.map((s) => s.feed_id));
    if (!feedIds.length) return res.json({ success: true, episodes: [], feeds: {} });
    const since = new Date(Date.now() - NOTIFY_DAYS * 24 * 3600 * 1000);
    const addedAt = new Map(subs.map((s) => [s.feed_id.toHexString(), s.added_at]));
    const eps = (await db.collection(EPISODES)
      .find({ feed_id: { $in: feedIds }, first_seen_at: { $gt: since } }, { projection: EPISODE_LIST })
      .sort({ first_seen_at: -1 }).limit(60).toArray())
      // Only what arrived after this person followed the show.
      .filter((e) => e.first_seen_at > (addedAt.get(e.feed_id.toHexString()) || since))
      .slice(0, 30);
    const ids = [...new Set(eps.map((e) => e.feed_id.toHexString()))].map((h) => new ObjectId(h));
    const feeds = ids.length ? await fillMissingArt(await db.collection(FEEDS).find({ _id: { $in: ids } }, { projection: FEED_CARD }).toArray()) : [];
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

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every episode is stored, so a show pages straight from Mongo, newest first.
// `since` / `until` (ISO dates, either may be left out) are the show page's date
// filter, presets and custom range alike. `q`: only episodes whose title or
// summary contains it (any case). One show is a few thousand rows at most, read
// through the feed_id index, so no text index is needed.
function episodePage(req) {
  const _id = new ObjectId(req.params.id);
  const q = { feed_id: _id };
  const since = req.query.since ? new Date(String(req.query.since)) : null;
  const until = req.query.until ? new Date(String(req.query.until)) : null;
  const range = {};
  if (since && !Number.isNaN(since.getTime())) range.$gte = since;
  if (until && !Number.isNaN(until.getTime())) range.$lte = until;
  if (Object.keys(range).length) q.published_at = range;
  const text = String(req.query.q || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (text) {
    const re = new RegExp(escapeRegex(text), 'i');
    q.$or = [{ title: re }, { summary: re }];
  }
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  return { _id, q, limit, offset };
}

router.get('/feed/:id', async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(400).json({ success: false, error: 'invalid id' });
  try {
    const db = getDb();
    const { _id, q, limit } = episodePage(req);
    const feed = await db.collection(FEEDS).findOne({ _id });
    if (!feed || !(await mayRead(req, feed.private, _id))) return res.status(404).json({ success: false, error: 'not found' });
    await fillMissingArt([feed]);
    const [eps, total] = await Promise.all([
      db.collection(EPISODES).find(q, { projection: EPISODE_LIST }).sort({ published_at: -1 }).limit(limit).toArray(),
      db.collection(EPISODES).countDocuments(q),
    ]);
    res.json({
      success: true,
      feed: presentFeed(feed, { subscribers: feed.subscribers || 0 }),
      episodes: eps.map(presentEpisode),
      total,
      older_available: total > eps.length,
    });
  } catch (err) {
    console.error('[podcasts] feed:', err.message);
    res.status(500).json({ success: false, error: 'could not load the show' });
  }
});

router.get('/feed/:id/older', async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(400).json({ success: false, error: 'invalid id' });
  try {
    const { _id, q, limit, offset } = episodePage(req);
    const feed = await getDb().collection(FEEDS).findOne({ _id }, { projection: { private: 1 } });
    if (feed && !(await mayRead(req, feed.private, _id))) return res.status(404).json({ success: false, error: 'not found' });
    const col = getDb().collection(EPISODES);
    const [eps, total] = await Promise.all([
      col.find(q, { projection: EPISODE_LIST }).sort({ published_at: -1 }).skip(offset).limit(limit).toArray(),
      col.countDocuments(q),
    ]);
    res.json({ success: true, episodes: eps.map(presentEpisode), total, next_offset: offset + eps.length });
  } catch (err) {
    console.error('[podcasts] older:', err.message);
    res.status(500).json({ success: false, error: 'could not load episodes' });
  }
});

router.get('/episode/:id', async (req, res) => {
  const id = String(req.params.id);
  if (!EPISODE_RE.test(id)) return res.status(400).json({ success: false, error: 'invalid id' });
  try {
    const db = getDb();
    const ep = await db.collection(EPISODES).findOne({ _id: id }, { projection: EPISODE_LIST });
    if (!ep || !(await mayRead(req, ep.private, ep.feed_id))) return res.status(404).json({ success: false, error: 'not found' });
    const feed = await db.collection(FEEDS).findOne({ _id: ep.feed_id }, { projection: FEED_CARD });
    if (feed) await fillMissingArt([feed]);
    res.json({ success: true, episode: presentEpisode(ep), feed: feedCard(feed) });
  } catch (err) {
    console.error('[podcasts] episode:', err.message);
    res.status(500).json({ success: false, error: 'could not load the episode' });
  }
});

// The full show notes (HTML as the feed has it; the page sanitises it). Not kept
// in Mongo, the worker reads them from the feed and caches them for a while.
const notesLimiter = rateLimit({
  // Per listener: the checker does not trust nginx as a proxy, so the default
  // key (req.ip) is nginx itself and the limit would be shared by everybody.
  keyGenerator: (req) => rateLimit.ipKeyGenerator(clientIpOf(req)), validate: { xForwardedForHeader: false, ip: false },
  windowMs: 60 * 1000, max: 60, standardHeaders: false, legacyHeaders: false,
  message: { success: false, error: 'Too many requests' },
});

router.get('/episode/:id/notes', notesLimiter, async (req, res) => {
  const id = String(req.params.id);
  if (!EPISODE_RE.test(id)) return res.status(400).json({ success: false, error: 'invalid id' });
  if (!podcastFeeds.enabled()) return disabled(res);
  const ep = await readableEpisode(req, res, {});
  if (!ep) return;
  const r = await podcastFeeds.ask('notes', { feed_id: id.slice(0, 24), episode_id: id }, 40000);
  if (!r.ok) return res.status(r.code === 'not_found' ? 404 : 502).json({ success: false, error: 'could not read the show notes', code: r.code });
  res.set('Cache-Control', ep.private ? 'private, max-age=900' : 'public, max-age=900');
  res.json({ success: true, html: r.html });
});
// ─── Chapters, transcripts, downloads ─────────────────────────────────────────

/**
 * The episode a request names, when it may read it; else the answer is sent
 * (400 for a bad id, 404 for a missing or private one) and this is null.
 */
async function readableEpisode(req, res, projection) {
  const id = String(req.params.id);
  if (!EPISODE_RE.test(id)) { res.status(400).json({ success: false, error: 'invalid id' }); return null; }
  try {
    const ep = await getDb().collection(EPISODES).findOne({ _id: id }, { projection: { ...projection, feed_id: 1, private: 1 } });
    if (ep && await mayRead(req, ep.private, ep.feed_id)) return ep;
    res.status(404).json({ success: false, error: 'not found' });
  } catch (err) {
    console.error('[podcasts] episode read:', err.message);
    res.status(500).json({ success: false, error: 'could not load the episode' });
  }
  return null;
}

// Chapter and transcript files from the podcast's host. Small, fetched once and
// then answered from memory (utils/podcastMedia.js makeCache) for a few hours.
const MEDIA_TTL = 6 * 3600 * 1000;
const MEDIA_MISS_TTL = 10 * 60 * 1000;
const CHAPTERS_MAX_BYTES = 1024 * 1024;
// A word-by-word JSON transcript of a three-hour show is a few MB.
const TRANSCRIPT_MAX_BYTES = 8 * 1024 * 1024;
const mediaCache = media.makeCache();
const mediaLoading = new Map();

const mediaLimiter = rateLimit({
  // Per listener: the checker does not trust nginx as a proxy, so the default
  // key (req.ip) is nginx itself and the limit would be shared by everybody.
  keyGenerator: (req) => rateLimit.ipKeyGenerator(clientIpOf(req)), validate: { xForwardedForHeader: false, ip: false },
  windowMs: 60 * 1000, max: 60, standardHeaders: false, legacyHeaders: false,
  message: { success: false, error: 'Too many requests' },
});

/**
 * `load()` once per key: from the cache, or shared with a request already
 * loading it. A failure is remembered (as null) for MEDIA_MISS_TTL.
 */
async function cachedMedia(key, load) {
  const hit = mediaCache.get(key);
  if (hit !== undefined) return hit;
  if (mediaLoading.has(key)) return mediaLoading.get(key);
  const p = (async () => {
    try {
      const value = await load();
      mediaCache.set(key, value, value && value.length ? MEDIA_TTL : MEDIA_MISS_TTL);
      return value;
    } catch (err) {
      mediaCache.set(key, null, MEDIA_MISS_TTL);
      return null;
    } finally {
      mediaLoading.delete(key);
    }
  })();
  mediaLoading.set(key, p);
  return p;
}

async function remoteText(ep, url, maxBytes) {
  const res = await safeFetch(url, {
    timeoutMs: 12000, maxBytes, auth: await privateAuth(ep, url),
    headers: { Accept: 'application/json, text/vtt, application/x-subrip, text/html;q=0.8, text/plain;q=0.8, */*;q=0.5' },
  });
  return res.body.toString('utf8');
}

const mediaCacheHeader = (ep) => (ep.private ? 'private, max-age=3600' : 'public, max-age=3600');

router.get('/episode/:id/chapters', mediaLimiter, async (req, res) => {
  const ep = await readableEpisode(req, res, { chapters_url: 1, chapters_inline: 1 });
  if (!ep) return;
  let chapters = [];
  if (Array.isArray(ep.chapters_inline) && ep.chapters_inline.length) {
    chapters = media.normaliseChapters(ep.chapters_inline);
  } else if (ep.chapters_url) {
    chapters = (await cachedMedia(`ch:${ep._id}:${ep.chapters_url}`,
      async () => media.chaptersFromBody(await remoteText(ep, ep.chapters_url, CHAPTERS_MAX_BYTES)))) || [];
  }
  if (!chapters.length) return res.status(404).json({ success: false, error: 'no_chapters' });
  res.set('Cache-Control', mediaCacheHeader(ep));
  res.json({ success: true, chapters });
});

router.get('/episode/:id/transcript', mediaLimiter, async (req, res) => {
  const ep = await readableEpisode(req, res, { transcripts: 1 });
  if (!ep) return;
  const list = Array.isArray(ep.transcripts) ? ep.transcripts : [];
  const lang = String(req.query.lang || '').trim().toLowerCase().slice(0, 12);
  let showLang = '';
  if (!lang && list.length > 1) {
    const feed = await getDb().collection(FEEDS).findOne({ _id: ep.feed_id }, { projection: { language: 1 } }).catch(() => null);
    showLang = (feed && feed.language) || '';
  }
  // The best format of that language first; a file that fails, the next one.
  for (const t of media.pickTranscripts(list, lang, showLang).slice(0, 3)) {
    const cues = await cachedMedia(`tr:${ep._id}:${t.url}`,
      async () => media.parseTranscript(await remoteText(ep, t.url, TRANSCRIPT_MAX_BYTES), t.type));
    if (cues && cues.length) {
      res.set('Cache-Control', mediaCacheHeader(ep));
      return res.json({ success: true, lang: t.lang, languages: media.transcriptLanguages(list), cues });
    }
  }
  res.status(404).json({ success: false, error: 'no_transcript' });
});

// The episode's audio passed through, for saving it offline when its host does
// not allow cross-site reads (most do not send CORS headers). Only the episode's
// own audio_url, fetched like a feed (utils/safeFetch.js safeStream, every hop
// checked), never buffered, capped at PODCAST_DOWNLOAD_MAX_MB. A Range is passed
// on, so a download can resume and a player can seek.
const DOWNLOAD_MAX_BYTES = Math.max(1, parseInt(process.env.PODCAST_DOWNLOAD_MAX_MB, 10) || 400) * 1024 * 1024;
const DOWNLOADS_AT_ONCE = 24;
let downloadsOpen = 0;
const RANGE_RE = /^bytes=(\d*)-(\d*)$/;
// A range from somewhere in the middle continues a download (or is a seek), it
// does not start one: those have their own, wider limit.
const continuesDownload = (req) => {
  const m = RANGE_RE.exec(String(req.headers.range || ''));
  return !!m && m[1] !== '' && m[1] !== '0';
};
const downloadLimiter = (max, skip) => rateLimit({
  keyGenerator: (req) => rateLimit.ipKeyGenerator(clientIpOf(req)), validate: { xForwardedForHeader: false, ip: false },
  windowMs: 60 * 60 * 1000, max, skip, standardHeaders: false, legacyHeaders: false,
  message: { success: false, error: 'Too many downloads, try again later' },
});
const downloadStarts = downloadLimiter(12, continuesDownload);
const downloadRanges = downloadLimiter(600, (req) => !continuesDownload(req));

/** What the file is served as: audio or video only, never something a browser would render as a page. */
function downloadType(upstream, stored) {
  const t = String(upstream || '').split(';')[0].trim().toLowerCase();
  if (/^(audio|video)\/[a-z0-9.+-]{1,40}$/.test(t)) return t;
  const s = String(stored || '').toLowerCase();
  return /^(audio|video)\/[a-z0-9.+-]{1,40}$/.test(s) ? s : 'application/octet-stream';
}

function downloadName(url, title) {
  let base = '';
  try { base = decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch (_) { /* odd URL */ }
  const ext = (base.match(/\.(mp3|m4a|m4b|aac|ogg|oga|opus|wav|flac|mp4|m4v|webm)$/i) || [''])[0].toLowerCase() || '.mp3';
  const name = String(title || base.replace(/\.[^.]*$/, '') || 'episode').replace(/[^A-Za-z0-9._ -]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'episode';
  return `${name}${ext}`;
}

router.get('/episode/:id/download', downloadStarts, downloadRanges, async (req, res) => {
  const ep = await readableEpisode(req, res, { audio_url: 1, mime: 1, title: 1 });
  if (!ep) return;
  if (downloadsOpen >= DOWNLOADS_AT_ONCE) return res.status(503).json({ success: false, error: 'busy, try again in a minute', code: 'busy' });
  downloadsOpen += 1;
  let released = false;
  const release = () => { if (!released) { released = true; downloadsOpen -= 1; } };
  let closed = false;
  res.on('close', () => { closed = true; release(); });

  const headers = {};
  const range = String(req.headers.range || '');
  if (RANGE_RE.test(range) && range !== 'bytes=-') headers.Range = range;
  let up;
  try {
    up = await safeStream(ep.audio_url, { headers, auth: await privateAuth(ep, ep.audio_url) });
  } catch (err) {
    release();
    if (closed) return;
    if (err && err.code === 'http_416') return res.status(416).json({ success: false, error: 'range not satisfiable' });
    return res.status(502).json({ success: false, error: 'the podcast host did not deliver the file', code: String((err && err.code) || 'error').slice(0, 40) });
  }
  if (closed) { up.abort(); return; }
  const length = parseInt(up.headers['content-length'], 10);
  const contentRange = String(up.headers['content-range'] || '');
  const whole = up.status === 206 ? parseInt((contentRange.match(/\/(\d+)\s*$/) || [])[1], 10) : length;
  if (Number.isFinite(whole) && whole > DOWNLOAD_MAX_BYTES) {
    up.abort();
    release();
    return res.status(413).json({ success: false, error: 'the file is too large', max_mb: Math.round(DOWNLOAD_MAX_BYTES / 1048576) });
  }
  res.status(up.status === 206 ? 206 : 200);
  res.set('Content-Type', downloadType(up.headers['content-type'], ep.mime));
  if (Number.isFinite(length) && length >= 0) res.set('Content-Length', String(length));
  if (up.status === 206 && contentRange) res.set('Content-Range', contentRange.slice(0, 100));
  if (up.status === 206 || String(up.headers['accept-ranges'] || '').toLowerCase() === 'bytes') res.set('Accept-Ranges', 'bytes');
  res.set('Content-Disposition', `attachment; filename="${downloadName(up.url, ep.title)}"`);
  // CORS itself is app-wide (server.js, cors()); these let the page read the sizes.
  res.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Disposition');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "default-src 'none'; sandbox");
  res.set('Cache-Control', 'private, no-store');
  // nginx would otherwise spool the whole file to disk before sending it on.
  res.set('X-Accel-Buffering', 'no');
  if (req.method === 'HEAD') { up.abort(); release(); return res.end(); }
  // The size cap also for a host that sends no length (or a wrong one).
  let sent = 0;
  const cap = new Transform({
    transform(chunk, _enc, cb) {
      sent += chunk.length;
      if (sent > DOWNLOAD_MAX_BYTES) return cb(Object.assign(new Error('too large'), { code: 'too_large' }));
      return cb(null, chunk);
    },
  });
  pipeline(up.stream, cap, res, (err) => {
    if (err) up.abort();
    release();
  });
});


// ─── Search and trending (Podcast Index) ──────────────────────────────────────

const searchLimiter = rateLimit({
  // Per listener: the checker does not trust nginx as a proxy, so the default
  // key (req.ip) is nginx itself and the limit would be shared by everybody.
  keyGenerator: (req) => rateLimit.ipKeyGenerator(clientIpOf(req)), validate: { xForwardedForHeader: false, ip: false },
  windowMs: 60 * 1000, max: 30, standardHeaders: false, legacyHeaders: false,
  message: { success: false, error: 'Too many requests' },
});

const { piGet, piShow } = directories;

/**
 * The shows a person search found, from its episodes: one entry per show, most
 * matching episodes first, with how many matched and the newest one's title.
 */
function showsFromEpisodes(items, max = 20) {
  const byFeed = new Map();
  for (const it of items || []) {
    if (!it || !it.feedUrl) continue;
    const key = it.feedId || it.feedUrl;
    let show = byFeed.get(key);
    if (!show) {
      show = {
        ...piShow({ title: it.feedTitle, author: it.feedAuthor, url: it.feedUrl, image: it.feedImage }),
        matches: 0, sample: '', sample_at: 0,
      };
      byFeed.set(key, show);
    }
    show.matches += 1;
    const at = Number(it.datePublished) || 0;
    if (!show.sample || at > show.sample_at) {
      show.sample = String(it.title || '').slice(0, 200);
      show.sample_at = at;
    }
  }
  return [...byFeed.values()]
    .sort((a, b) => b.matches - a.matches || b.sample_at - a.sample_at)
    .slice(0, max)
    .map(({ sample_at: at, ...show }) => ({ ...show, last_episode_at: at ? new Date(at * 1000) : null }));
}

// Podcast Index matches a language code exactly, and feeds name theirs as they
// please ("en", "en-us", "en-GB"...), so a two-letter code is asked for with its
// common regional forms too. Its match ignores case.
const LANG_VARIANTS = {
  en: ['en', 'en-us', 'en-gb', 'en-au', 'en-ca', 'en-in'],
  es: ['es', 'es-es', 'es-mx', 'es-us', 'es-419', 'es-ar', 'es-co'],
  pt: ['pt', 'pt-br', 'pt-pt'],
  de: ['de', 'de-de', 'de-at', 'de-ch'],
  fr: ['fr', 'fr-fr', 'fr-ca', 'fr-be', 'fr-ch'],
  zh: ['zh', 'zh-cn', 'zh-tw', 'zh-hk', 'zh-hans', 'zh-hant'],
  nl: ['nl', 'nl-nl', 'nl-be'],
  it: ['it', 'it-it'],
  ru: ['ru', 'ru-ru'],
  ja: ['ja', 'ja-jp'],
  ko: ['ko', 'ko-kr'],
  id: ['id', 'id-id', 'in'],
  fil: ['fil', 'tl', 'fil-ph', 'tl-ph'],
};
const LANG_RE = /^[a-z]{2,3}$/;
const langParam = (lang) => (LANG_VARIANTS[lang] || [lang, `${lang}-${lang}`]).join(',');

// The top-level categories (Apple's, which Podcast Index uses too). Only these
// are passed on, by name.
const CATEGORIES = [
  'Arts', 'Business', 'Comedy', 'Education', 'Fiction', 'Government', 'Health', 'History', 'Kids',
  'Leisure', 'Music', 'News', 'Religion', 'Science', 'Society', 'Sports', 'Technology', 'True Crime', 'TV',
];

const searchCache = new Map();
/** A Podcast Index answer from memory when it is younger than `ttl`, else fetched and kept. */
async function cached(key, ttl, load) {
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.results;
  const results = await load();
  searchCache.set(key, { at: Date.now(), results });
  if (searchCache.size > 500) searchCache.delete(searchCache.keys().next().value);
  return results;
}

const COUNTRY_RE = /^[a-z]{2}$/;
const searchOff = (res) => res.status(503).json({ success: false, error: 'search is not configured', code: 'search_disabled' });
const usable = (f) => f && f.url && !f.dead;

router.get('/search', searchLimiter, async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (q.length < 2) return res.json({ success: true, results: [] });
  // Apple's search is per storefront; the listener's chart country picks it.
  const country = COUNTRY_RE.test(String(req.query.country || '')) ? String(req.query.country) : 'us';
  try {
    const results = await cached(`term:${country}:${q.toLowerCase()}`, 10 * 60 * 1000, () => directories.searchAll(q, { country }));
    res.json({ success: true, results });
  } catch (err) {
    console.warn('[podcasts] search:', err.message);
    res.status(502).json({ success: false, error: 'search failed' });
  }
});

router.get('/person', searchLimiter, async (req, res) => {
  if (!directories.piEnabled()) return searchOff(res);
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (q.length < 2) return res.json({ success: true, results: [] });
  try {
    const results = await cached(`person:${q.toLowerCase()}`, 10 * 60 * 1000, async () => {
      const data = await piGet(`search/byperson?q=${encodeURIComponent(q)}&max=100`);
      return showsFromEpisodes(data.items);
    });
    res.json({ success: true, results });
  } catch (err) {
    console.warn('[podcasts] person search:', err.message);
    res.status(502).json({ success: false, error: 'search failed' });
  }
});

router.get('/trending', searchLimiter, async (req, res) => {
  if (!directories.piEnabled()) return searchOff(res);
  const lang = String(req.query.lang || '').toLowerCase();
  const cat = CATEGORIES.find((c) => c.toLowerCase() === String(req.query.cat || '').toLowerCase()) || '';
  if (lang && !LANG_RE.test(lang)) return res.status(400).json({ success: false, error: 'bad language' });
  try {
    const results = await cached(`trending:${lang}:${cat}`, 30 * 60 * 1000, async () => {
      const params = new URLSearchParams({ max: '40' });
      if (lang) params.set('lang', langParam(lang));
      if (cat) params.set('cat', cat);
      const data = await piGet(`podcasts/trending?${params}`);
      return (data.feeds || []).filter(usable).slice(0, 24).map(piShow);
    });
    res.json({ success: true, results, categories: CATEGORIES });
  } catch (err) {
    console.warn('[podcasts] trending:', err.message);
    res.status(502).json({ success: false, error: 'trending failed' });
  }
});

router.get('/charts', searchLimiter, async (req, res) => {
  const country = String(req.query.country || 'us').toLowerCase();
  if (!directories.CHART_COUNTRIES.includes(country)) return res.status(400).json({ success: false, error: 'unknown country' });
  const cat = CATEGORIES.find((c) => c.toLowerCase() === String(req.query.cat || '').toLowerCase()) || '';
  try {
    const results = await cached(`charts:${country}:${cat}`, 60 * 60 * 1000, () => directories.appleChart(country, cat));
    res.json({ success: true, results });
  } catch (err) {
    console.warn('[podcasts] charts:', err.message);
    res.status(502).json({ success: false, error: 'charts failed' });
  }
});

// ─── Discover ─────────────────────────────────────────────────────────────────

// What everyone on 3Speak follows: the ten most followed shows, and the shows
// someone followed most recently. Same for every visitor, so cached briefly.
let discoverCache = null;
const DISCOVER_CARD = { ...FEED_CARD, subscribers: 1, last_followed_at: 1, categories: 1 };

router.get('/discover', async (req, res) => {
  try {
    if (!discoverCache || Date.now() - discoverCache.at > 60 * 1000) {
      const col = getDb().collection(FEEDS);
      // Never a private feed: it is one listener's, and its title alone may say too much.
      const base = { subscribers: { $gt: 0 }, status: 'ok', private: { $ne: true } };
      const [top, recent] = await Promise.all([
        col.find(base, { projection: DISCOVER_CARD }).sort({ subscribers: -1, last_followed_at: -1 }).limit(10).toArray(),
        col.find({ ...base, last_followed_at: { $exists: true } }, { projection: DISCOVER_CARD }).sort({ last_followed_at: -1 }).limit(12).toArray(),
      ]);
      await fillMissingArt([...top, ...recent]);
      const card = (f) => presentFeed(f, { subscribers: f.subscribers || 0 });
      discoverCache = { at: Date.now(), body: { success: true, top: top.map(card), recent: recent.map(card) } };
    }
    res.set('Cache-Control', 'public, max-age=60');
    res.json(discoverCache.body);
  } catch (err) {
    console.error('[podcasts] discover:', err.message);
    res.status(500).json({ success: false, error: 'could not load podcasts' });
  }
});

// ─── Cover art ────────────────────────────────────────────────────────────────

router.get('/art/:token/:px.jpg', async (req, res) => {
  const px = parseInt(req.params.px, 10);
  const url = urlFromToken(req.params.token);
  if (!url || !SIZES.has(px)) return res.status(404).end();
  try {
    const jpeg = await renderArt(url, px);
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=604800, immutable');
    res.send(jpeg);
  } catch (err) {
    // The page shows its own podcast placeholder for a missing cover.
    res.set('Cache-Control', 'public, max-age=600');
    res.status(404).end();
  }
});

// ─── Listening progress ──────────────────────────────────────────────────────
// One small row per user and episode they played (`<user>|<episodeId>`: pos, dur,
// done), dropped 180 days after the last listen (TTL on `at`). The player saves
// every ~20 s, so this can't ask the wallet each time: the page holds one vouch
// from our API (`progress-vouch` over "session") for up to a day and reuses it.
// A stolen one could only move that person's progress bars.

const PROGRESS_VOUCH_MAX_AGE_MS = 24 * 3600 * 1000;
const progressBrake = new Map();

async function proveProgressUser(b) {
  const user = userOf(b.user);
  if (!USER_RE.test(user)) return null;
  const signature = typeof b.signature === 'string' ? b.signature.slice(0, 200) : '';
  const timestamp = parseInt(b.timestamp, 10);
  if (!signature || !Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > PROGRESS_VOUCH_MAX_AGE_MS) return null;
  try {
    const v = await verifyDelegateVouch({ message: podcastMessage('progress-vouch', user, 'session', timestamp), signature, delegates: AD_SIGNING_DELEGATES });
    return v.ok ? user : null;
  } catch (_) {
    return null;
  }
}

const presentProgress = (rows) => Object.fromEntries(rows.map((r) => [r.ep, { pos: r.pos, dur: r.dur, done: !!r.done }]));

router.get('/progress', async (req, res) => {
  const user = userOf(req.query.user);
  if (!USER_RE.test(user)) return res.status(400).json({ success: false, error: 'invalid user' });
  const q = { user };
  if (req.query.feed) {
    if (!ID_RE.test(String(req.query.feed))) return res.status(400).json({ success: false, error: 'invalid feed' });
    q.feed_id = new ObjectId(String(req.query.feed));
  } else {
    const ids = String(req.query.ids || '').split(',').filter((id) => EPISODE_RE.test(id)).slice(0, 150);
    if (!ids.length) return res.json({ success: true, progress: {} });
    q._id = { $in: ids.map((id) => `${user}|${id}`) };
  }
  try {
    const rows = await getDb().collection(PROGRESS).find(q, { projection: { ep: 1, pos: 1, dur: 1, done: 1 } }).limit(3000).toArray();
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, progress: presentProgress(rows) });
  } catch (err) {
    console.error('[podcasts] progress read:', err.message);
    res.status(500).json({ success: false, error: 'could not load progress' });
  }
});

router.post('/progress', express.json({ limit: '8kb' }), async (req, res) => {
  const b = req.body || {};
  const user = await proveProgressUser(b);
  if (!user) return res.status(401).json({ success: false, error: 'Invalid signature' });
  const items = (Array.isArray(b.items) ? b.items : []).slice(0, 20).filter((it) => it && EPISODE_RE.test(String(it.id)));
  if (!items.length) return res.status(400).json({ success: false, error: 'no items' });
  if (tooManyIn(progressBrake, user, 720)) return res.status(429).json({ success: false, error: 'too many updates' });
  const now = new Date();
  const ops = items.map((it) => {
    const dur = Math.max(0, Math.min(86400, Math.round(Number(it.dur) || 0)));
    const pos = Math.max(0, Math.min(dur || 86400, Math.round(Number(it.pos) || 0)));
    // Finished: the last 5 %, or the last 30 s (outros and ads).
    const done = dur > 0 && (pos >= dur * 0.95 || dur - pos <= 30);
    const id = String(it.id);
    return {
      updateOne: {
        filter: { _id: `${user}|${id}` },
        // `done` only ever goes from false to true: playing a finished episode
        // again from the start keeps it marked as listened.
        update: { $set: { user, ep: id, feed_id: new ObjectId(id.slice(0, 24)), pos, dur, at: now }, $max: { done } },
        upsert: true,
      },
    };
  });
  try {
    await getDb().collection(PROGRESS).bulkWrite(ops, { ordered: false });
    res.json({ success: true });
  } catch (err) {
    console.error('[podcasts] progress write:', err.message);
    res.status(500).json({ success: false, error: 'could not save progress' });
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
  const privateFlags = Array.isArray(b.private) ? b.private : [];
  const db = getDb();
  const feeds = db.collection(FEEDS);
  const subs = db.collection(SUBS);
  let room = MAX_FEEDS_PER_USER - await subs.countDocuments({ user });
  const results = [];
  const single = urls.length === 1;

  for (let i = 0; i < urls.length; i += 1) {
    // A private feed (marked so, or with a password in it): the listener's own row,
    // fetched with their credentials, never looked up in a directory, and its
    // password never echoed back.
    const bare = splitCredentials(urls[i]);
    const isPrivate = privateFlags[i] === true || privateFlags[i] === 'true' || !!bare.auth;
    const out = { url: isPrivate ? bare.url : urls[i] };
    results.push(out);
    let url = urls[i];
    if (!isPrivate) {
      // A link from Apple Podcasts, Overcast, fyyd... names its feed; Spotify & co. have none.
      const resolved = await directories.resolveLink(urls[i]);
      if (resolved.code) { Object.assign(out, resolved); continue; }
      url = resolved.url;
      if (resolved.via) out.resolved_url = url;
    }
    try {
      checkUrl(isPrivate ? bare.url : url);
    } catch (err) {
      out.code = err.code || 'bad_url';
      continue;
    }
    const owner = internalOwner(urlKey(isPrivate ? bare.url : url));
    if (owner) { out.code = 'internal_feed'; out.owner = owner; continue; }
    const key = isPrivate ? privateKey(user, url) : urlKey(url);
    if (isPrivate) out.private = true;

    let feed = await feeds.findOne(
      isPrivate ? { url_key: key } : { $or: [{ url_key: key }, { alt_keys: key }], private: { $ne: true } },
      { projection: { _id: 1, status: 1, last_ok_at: 1, url: 1 } },
    );
    if (feed && isPrivate && feed.url !== url) {
      // Same feed, new password or token: keep the new one and read it again soon.
      await feeds.updateOne({ _id: feed._id }, { $set: { url, next_poll_at: new Date() } });
    }
    if (feed) {
      const already = await subs.findOne({ _id: `${user}|${feed._id.toHexString()}` }, { projection: { _id: 1 } });
      if (already) { out.ok = true; out.already = true; out.feed_id = feed._id.toHexString(); continue; }
    }
    if (room <= 0) { out.code = 'limit'; continue; }

    if (single && (!feed || !feed.last_ok_at)) {
      // One URL: fetch it now, so the person learns right away whether it is a podcast.
      let r = await podcastFeeds.ask('probe', isPrivate ? { url, private: true, owner: user } : { url }, 35000);
      // A show's website rather than its feed: try the feed the page announces.
      if (!isPrivate && !r.ok && (r.code === 'not_a_podcast' || r.code === 'parse_error')) {
        const found = await directories.discoverFeed(url);
        if (found && urlKey(found) !== key && internalOwner(urlKey(found))) {
          r = { ok: false, code: 'internal_feed' };
        } else if (found && urlKey(found) !== key) {
          const known = await feeds.findOne({ $or: [{ url_key: urlKey(found) }, { alt_keys: urlKey(found) }] }, { projection: { _id: 1, last_ok_at: 1 } });
          r = known && known.last_ok_at ? { ok: true, feed_id: known._id.toHexString() } : await podcastFeeds.ask('probe', { url: found }, 35000);
          if (r.ok) out.resolved_url = found;
        }
      }
      if (!r.ok) { out.code = r.code || 'error'; continue; }
      feed = { _id: new ObjectId(r.feed_id) };
    } else if (!feed) {
      // A batch (OPML): the worker reads them over the next minutes.
      const title = String(titles[i] || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      const doc = { url, url_key: key, alt_keys: [], status: 'pending', subscribers: 0, error_count: 0, created_at: new Date(), next_poll_at: new Date() };
      if (isPrivate) Object.assign(doc, { private: true, owner: user });
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
      await feeds.updateOne({ _id: feed._id }, { $inc: { subscribers: 1 }, $set: { last_followed_at: new Date() }, $unset: { orphaned_at: '' } });
      discoverCache = null;
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
module.exports._test = { podcastMessage, urlsDigest, internalOwner, presentEpisode, presentFeed, liveNow, showsFromEpisodes, langParam, escapeRegex, downloadType, downloadName, continuesDownload };
