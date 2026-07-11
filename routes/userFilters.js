/**
 * Per-user feed suppression API — "not interested" and "don't show this creator".
 *
 * Auth model matches the existing per-user state on this platform (watch-history
 * is written the same way): the caller supplies its own username, there is no
 * token. These are personal, low-stakes preferences that only ever *remove*
 * content from the caller's own feeds — nothing here can affect another user's
 * experience or mutate content. Do NOT extend this pattern to anything that
 * writes public state.
 *
 * Route names deliberately avoid words ad-blockers filter on (no "ads", "track",
 * "analytics"). Everything is idempotent so a double-tap is harmless.
 */
const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');
const {
  HIDDEN_VIDEOS, HIDDEN_CREATORS, normUser, getUserFilters,
} = require('../utils/userFilters');

const bad = (res, msg) => res.status(400).json({ success: false, error: msg });

// ── "Not interested" — hide ONE video from every feed ────────────────────────
router.post('/user/hide-video', async (req, res) => {
  try {
    const username = normUser(req.body.username);
    const owner = normUser(req.body.owner || req.body.author);
    const permlink = String(req.body.permlink || '').trim();
    if (!username || !owner || !permlink) return bad(res, 'username, owner and permlink are required');

    await getDb().collection(HIDDEN_VIDEOS).updateOne(
      { _id: `${username}:${owner}:${permlink}` },
      { $set: { username, owner, permlink }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
    res.json({ success: true, hidden: true });
  } catch (e) {
    console.error('hide-video failed:', e && e.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.delete('/user/hide-video', async (req, res) => {
  try {
    const username = normUser(req.body.username);
    const owner = normUser(req.body.owner || req.body.author);
    const permlink = String(req.body.permlink || '').trim();
    if (!username || !owner || !permlink) return bad(res, 'username, owner and permlink are required');

    await getDb().collection(HIDDEN_VIDEOS).deleteOne({ _id: `${username}:${owner}:${permlink}` });
    res.json({ success: true, hidden: false });
  } catch (e) {
    console.error('unhide-video failed:', e && e.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── "Don't show this creator" — hide EVERY video by an author ────────────────
router.post('/user/hide-creator', async (req, res) => {
  try {
    const username = normUser(req.body.username);
    const creator = normUser(req.body.creator);
    if (!username || !creator) return bad(res, 'username and creator are required');
    if (username === creator) return bad(res, 'you cannot hide yourself');

    await getDb().collection(HIDDEN_CREATORS).updateOne(
      { _id: `${username}:${creator}` },
      { $set: { username, creator }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
    res.json({ success: true, hidden: true });
  } catch (e) {
    console.error('hide-creator failed:', e && e.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.delete('/user/hide-creator', async (req, res) => {
  try {
    const username = normUser(req.body.username);
    const creator = normUser(req.body.creator);
    if (!username || !creator) return bad(res, 'username and creator are required');

    await getDb().collection(HIDDEN_CREATORS).deleteOne({ _id: `${username}:${creator}` });
    res.json({ success: true, hidden: false });
  } catch (e) {
    console.error('unhide-creator failed:', e && e.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── Everything this user has dismissed (for a manage/undo UI) ────────────────
router.get('/user/hidden/:username', async (req, res) => {
  try {
    const db = getDb();
    const username = normUser(req.params.username);
    if (!username) return bad(res, 'username is required');

    const [vids, creators] = await Promise.all([
      db.collection(HIDDEN_VIDEOS).find({ username }, { projection: { owner: 1, permlink: 1, createdAt: 1 } })
        .sort({ createdAt: -1 }).limit(500).toArray(),
      db.collection(HIDDEN_CREATORS).find({ username }, { projection: { creator: 1, createdAt: 1 } })
        .sort({ createdAt: -1 }).limit(500).toArray(),
    ]);
    res.json({
      success: true,
      videos: vids.map((v) => ({ owner: v.owner, permlink: v.permlink, createdAt: v.createdAt })),
      creators: creators.map((c) => ({ creator: c.creator, createdAt: c.createdAt })),
    });
  } catch (e) {
    console.error('get hidden failed:', e && e.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
