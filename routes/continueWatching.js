const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');
const {
  AD_VIEWER_PREFS_COLLECTION, VIEWER_PROGRESS_COLLECTION, CONTINUE_WATCHING_MIN_PCT, CONTINUE_WATCHING_MAX_PCT,
} = require('../utils/config');
const { proveProgressUser } = require('../utils/progressVouch');
const { syncViewerProgress } = require('../services/viewerProgress');
const { embedCard } = require('./watchedFeed');

/* ────────────────────────────────────────────────────────────────────
 * POST /feeds/continue-watching       { user, signature, timestamp }
 * POST /feeds/continue-watching/hide  { user, signature, timestamp, owner, permlink, hidden? }
 *
 * The home page's Continue watching strip: videos the viewer left between
 * CONTINUE_WATCHING_MIN_PCT and _MAX_PCT, newest first, as feed cards with
 * `progress: { position, duration, pct, at }` and `_progressKey` (what hide takes).
 *
 * Only for viewers opted into viewer rewards, the consent that lets us keep a name
 * with what they watch (services/viewerProgress.js). Anyone else gets
 * `enabled: false` and the page shows no strip at all. Their own viewing, so both
 * take the progress vouch (utils/progressVouch.js) in a POST body, never a URL.
 *
 * Hide takes it off the strip until Undo (`hidden: false`). Watching it again
 * does not bring it back, as on Continue listening.
 * ──────────────────────────────────────────────────────────────────── */

const MAX_ITEMS = 12;
// The player's sessions for this viewer from the last few hours are copied first,
// so a video left a minute ago is there without waiting for the background sync.
const FRESH_MS = 6 * 3600 * 1000;

const hideBrake = new Map();
function tooManyHides(user) {
  const now = Date.now();
  const list = (hideBrake.get(user) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (list.length >= 300) return true;
  list.push(now);
  hideBrake.set(user, list);
  if (hideBrake.size > 5000) hideBrake.delete(hideBrake.keys().next().value);
  return false;
}

async function optedIn(db, user) {
  const p = await db.collection(AD_VIEWER_PREFS_COLLECTION).findOne({ _id: user }, { projection: { rewardsEnabled: 1 } });
  return !!p && p.rewardsEnabled === true;
}

router.post('/continue-watching', express.json({ limit: '2kb' }), async (req, res) => {
  const user = await proveProgressUser(req.body || {});
  if (!user) return res.status(401).json({ success: false, error: 'Invalid signature' });
  res.set('Cache-Control', 'no-store');
  try {
    const db = getDb();
    if (!(await optedIn(db, user))) return res.json({ success: true, enabled: false, videos: [] });

    await syncViewerProgress({ viewer: user, since: new Date(Date.now() - FRESH_MS) }).catch((err) => {
      console.error('[continue-watching] fresh sync failed:', err && err.message);
    });

    const rows = await db.collection(VIEWER_PROGRESS_COLLECTION)
      .find({
        viewer: user,
        hidden: { $ne: true },
        pct: { $gte: CONTINUE_WATCHING_MIN_PCT, $lte: CONTINUE_WATCHING_MAX_PCT },
      }, { projection: { owner: 1, permlink: 1, type: 1, position: 1, duration: 1, pct: 1, at: 1 } })
      .sort({ at: -1 })
      .limit(MAX_ITEMS * 3)
      .toArray();

    // The player keys new uploads by their asset id and old ones by the legacy
    // permlink, so each type is looked up where it lives.
    const embedRows = rows.filter((r) => r.type !== 'legacy');
    const legacyRows = rows.filter((r) => r.type === 'legacy');
    const [embeds, legacies] = await Promise.all([
      embedRows.length
        ? db.collection('embed-video').find({ status: 'published', $or: embedRows.map((r) => ({ owner: r.owner, permlink: r.permlink })) }).toArray()
        : [],
      legacyRows.length
        ? db.collection('videos').find({ status: 'published', $or: legacyRows.map((r) => ({ owner: r.owner, permlink: r.permlink })) }).toArray()
        : [],
    ]);
    const embedBy = new Map(embeds.map((ev) => [`${ev.owner}/${ev.permlink}`, ev]));
    const legacyBy = new Map(legacies.map((v) => [`${v.owner}/${v.permlink}`, v]));

    const now = new Date();
    const videos = [];
    for (const r of rows) {
      if (videos.length >= MAX_ITEMS) break;
      const key = `${r.owner}/${r.permlink}`;
      let card = null;
      if (r.type === 'legacy') {
        const v = legacyBy.get(key);
        if (v) card = { ...v, _id: String(v._id), author: v.author || v.owner };
      } else {
        const ev = embedBy.get(key);
        // Shorts loop, so there is no "where you left it"; an expired story is gone.
        if (!ev || ev.short === true) continue;
        if (ev.story === true && ev.story_expires_at && new Date(ev.story_expires_at) <= now) continue;
        card = embedCard(ev);
      }
      if (!card) continue;
      videos.push({
        ...card,
        _progressKey: key,
        progress: { position: r.position, duration: r.duration, pct: r.pct, at: r.at },
      });
    }
    res.json({ success: true, enabled: true, videos });
  } catch (err) {
    console.error('[continue-watching] list failed:', err && err.message);
    res.status(500).json({ success: false, error: 'could not load' });
  }
});

router.post('/continue-watching/hide', express.json({ limit: '2kb' }), async (req, res) => {
  const b = req.body || {};
  const user = await proveProgressUser(b);
  if (!user) return res.status(401).json({ success: false, error: 'Invalid signature' });
  const owner = String(b.owner || '').trim().toLowerCase();
  const permlink = String(b.permlink || '').trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,31}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,256}$/.test(permlink)) {
    return res.status(400).json({ success: false, error: 'invalid video' });
  }
  if (tooManyHides(user)) return res.status(429).json({ success: false, error: 'too many updates' });
  try {
    const update = b.hidden === false ? { $unset: { hidden: '' } } : { $set: { hidden: true } };
    const r = await getDb().collection(VIEWER_PROGRESS_COLLECTION).updateOne({ viewer: user, owner, permlink }, update);
    res.json({ success: true, found: r.matchedCount > 0 });
  } catch (err) {
    console.error('[continue-watching] hide failed:', err && err.message);
    res.status(500).json({ success: false, error: 'could not save' });
  }
});

module.exports = router;
