/**
 * Sends "someone you follow posted" push notifications.
 *
 * Runs on the main thread like adInventory (it is a couple of indexed finds and
 * an outbound HTTPS call per subscriber, not a scan), on an interval.
 *
 * The window is stored, not assumed: `push-state` keeps the timestamp of the
 * last pass so a restart or a slow run can't double-send or skip a gap. The
 * very first pass looks back FIRST_RUN_MIN only — waking up after a deploy and
 * announcing everything published since the beginning of time would be the
 * single worst first impression a notification feature could make.
 */
const { getDb } = require('../utils/db');
const { getFollowingList } = require('../utils/hive');
const push = require('../utils/webPush');

const STATE_COLLECTION = 'push-state';
const STATE_ID = 'new-uploads';

const FIRST_RUN_MIN = 15;
// One person publishing a back catalogue should not cost a follower fifty
// buzzes. Anything past this is simply not announced.
const MAX_PER_SUBSCRIBER = 3;
const CANDIDATE_LIMIT = 50;

// Following lists change rarely and cost a Hive call each; one hour is plenty
// fresh for "did this person follow that creator".
const FOLLOW_TTL_MS = 60 * 60 * 1000;
const followCache = new Map();

async function followingOf(username) {
  const hit = followCache.get(username);
  if (hit && Date.now() - hit.at < FOLLOW_TTL_MS) return hit.set;
  let list = [];
  try {
    list = (await getFollowingList(username)) || [];
  } catch (err) {
    console.warn(`[push] following lookup failed for ${username}: ${err.message}`);
    // Reuse a stale list rather than silently notifying nobody.
    if (hit) return hit.set;
  }
  const set = new Set(list.map((u) => String(u).toLowerCase()));
  followCache.set(username, { set, at: Date.now() });
  return set;
}

function fromEmbed(ev, kind) {
  return {
    kind,
    author: String(ev.hive_author || '').toLowerCase(),
    permlink: ev.hive_permlink,
    title: ev.hive_title || ev.originalFilename || (kind === 'shorts' ? 'New short' : 'New video'),
    at: ev.createdAt,
  };
}

function fromAudio(a) {
  return {
    kind: 'audio',
    author: String(a.owner || '').toLowerCase(),
    permlink: a.post_permlink,
    title: a.title || a.originalFilename || 'New audio',
    at: a.createdAt,
  };
}

// What the notification says, per kind.
const HEADLINE = {
  videos: (a) => `@${a} posted a new video`,
  shorts: (a) => `@${a} posted a new short`,
  audio: (a) => `@${a} posted new audio`,
};

function fromLegacy(v) {
  return {
    kind: 'videos',
    author: String(v.owner || '').toLowerCase(),
    permlink: v.permlink,
    title: v.title || 'New video',
    at: v.created,
  };
}

async function runOnce() {
  if (!push.isConfigured()) return { skipped: 'not configured' };
  const db = getDb();
  const state = db.collection(STATE_COLLECTION);

  const prev = await state.findOne({ _id: STATE_ID });
  const since = prev && prev.lastAt
    ? new Date(prev.lastAt)
    : new Date(Date.now() - FIRST_RUN_MIN * 60 * 1000);
  const now = new Date();

  const embedBase = {
    status: 'published',
    listed_on_3speak: true,
    hive_permlink: { $ne: null },
    createdAt: { $gt: since, $lte: now },
  };
  const [videoRaw, shortRaw, legacyRaw, audioRaw] = await Promise.all([
    db.collection('embed-video').find({ ...embedBase, short: false })
      .sort({ createdAt: 1 }).limit(CANDIDATE_LIMIT).toArray(),
    db.collection('embed-video').find({ ...embedBase, short: true })
      .sort({ createdAt: 1 }).limit(CANDIDATE_LIMIT).toArray(),
    db.collection('videos').find({
      status: 'published',
      created: { $gt: since, $lte: now },
    }).sort({ created: 1 }).limit(CANDIDATE_LIMIT).toArray(),
    db.collection('embed-audio').find({
      post_permlink: { $ne: null },
      createdAt: { $gt: since, $lte: now },
    }).sort({ createdAt: 1 }).limit(CANDIDATE_LIMIT).toArray(),
  ]);

  const items = [
    ...videoRaw.map((v) => fromEmbed(v, 'videos')),
    ...shortRaw.map((v) => fromEmbed(v, 'shorts')),
    ...legacyRaw.map(fromLegacy),
    ...audioRaw.map(fromAudio),
  ].filter((i) => i.author && i.permlink);

  let sent = 0;
  if (items.length) {
    const subscribers = await push.listSubscribers();
    for (const username of subscribers) {
      const [following, prefs] = await Promise.all([followingOf(username), push.getPrefs(username)]);
      const theirs = items
        .filter((i) => prefs[i.kind] !== false && following.has(i.author))
        .slice(0, MAX_PER_SUBSCRIBER);
      for (const item of theirs) {
        const res = await push.sendToUser(username, {
          title: (HEADLINE[item.kind] || HEADLINE.videos)(item.author),
          body: item.title,
          url: item.kind === 'shorts'
            ? `/shorts?v=${item.author}/${item.permlink}`
            : `/watch?v=${item.author}/${item.permlink}`,
          // Same video never buzzes twice on one device, even if a later pass
          // somehow sees it again.
          tag: `${item.kind}:${item.author}/${item.permlink}`,
        });
        sent += res.sent;
      }
    }
  }

  // Advance the window even when nothing was sent, or a quiet hour would make
  // the next pass re-examine an ever-growing span.
  await state.updateOne({ _id: STATE_ID }, { $set: { lastAt: now } }, { upsert: true });
  if (items.length || sent) console.log(`[push] ${items.length} new video(s), ${sent} notification(s) sent`);
  return { candidates: items.length, sent };
}

module.exports = { runOnce };
