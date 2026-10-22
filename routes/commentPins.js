/**
 * A video's author pinning comments to the top of their own video's thread.
 *
 * The pins live on the video row itself, as `pinned_comments: [<comment permlink>]`,
 * on whichever of `videos` (legacy) / `embed-video` holds the video, so
 * /videodetails returns them with everything else and the watch page needs no
 * extra request to show them.
 *
 * Proof of authorship is the caption-edit shape (routes/subtitleEdit.js): a
 * signature over a message WE build from the request, accepted from the author's
 * own posting key or from a posting-authority delegate we sign with
 * (@threespeak, for HiveSigner / Butter Auth sessions that hold no key in the
 * browser). The comment and the action are in the message, so a signature made
 * to pin one comment cannot be replayed to unpin it, or to pin another.
 */
const express = require('express');
const { getDb } = require('../utils/db');
const { verifyHiveAuthority } = require('../utils/hiveAuth');
const { SIGNATURE_TIMESTAMP_TOLERANCE_MS, AD_SIGNING_DELEGATES } = require('../utils/config');

const router = express.Router();

const ACCOUNT_RE = /^[a-z][a-z0-9.-]{2,15}$/;
const PERMLINK_RE = /^[a-z0-9-]{1,255}$/;
const MAX_PINS = 3;

// Must match pinMessage() in the frontend (src/lib/commentPins.js) and the
// signer in server/index.cjs exactly.
const pinMessage = (author, permlink, comment, action, timestamp) =>
  ['3speak-comments', action, author, permlink, comment, String(timestamp)].join('|');

// Same rows /videodetails resolves (routes/videos.js), so a pin always lands on
// the document the watch page reads back.
const videoFilters = (author, permlink) => [
  ['videos', { owner: author, permlink }],
  ['embed-video', { $or: [{ owner: author, permlink }, { hive_author: author, hive_permlink: permlink }] }],
];

// A small per-author brake: every call is a database write.
const recent = new Map();
function tooMany(author) {
  const now = Date.now();
  const list = (recent.get(author) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (list.length >= 120) return true;
  list.push(now);
  recent.set(author, list);
  return false;
}

// POST /comments/pin — { author, permlink, comment, pinned: bool, signature, timestamp }
router.post('/comments/pin', express.json({ limit: '8kb' }), async (req, res) => {
  const b = req.body || {};
  const author = String(b.author || '').toLowerCase();
  const permlink = String(b.permlink || '');
  const comment = String(b.comment || '');
  const action = b.pinned === true ? 'pin' : b.pinned === false ? 'unpin' : '';
  if (!ACCOUNT_RE.test(author) || !PERMLINK_RE.test(permlink) || !PERMLINK_RE.test(comment) || !action) {
    return res.status(400).json({ success: false, error: 'invalid author, permlink, comment or action' });
  }

  const signature = typeof b.signature === 'string' ? b.signature.slice(0, 200) : '';
  const timestamp = parseInt(b.timestamp, 10);
  if (!signature || !Number.isFinite(timestamp)) {
    return res.status(401).json({
      success: false,
      error: 'Signature required',
      expected_message: pinMessage(author, permlink, comment, action, '<ms>'),
    });
  }
  if (Math.abs(Date.now() - timestamp) > SIGNATURE_TIMESTAMP_TOLERANCE_MS) {
    return res.status(401).json({ success: false, error: 'timestamp out of tolerance' });
  }

  let verdict = { ok: false, signer: null };
  try {
    verdict = await verifyHiveAuthority({
      message: pinMessage(author, permlink, comment, action, timestamp),
      signature,
      username: author,
      allowedDelegates: AD_SIGNING_DELEGATES,
    });
  } catch (err) {
    if (err && err.code === 'HIVE_ACCOUNT_NOT_FOUND') {
      return res.status(404).json({ success: false, error: 'Hive account not found' });
    }
  }
  if (!verdict.ok) return res.status(401).json({ success: false, error: 'Invalid signature' });

  if (tooMany(author)) return res.status(429).json({ success: false, error: 'too many changes, try again later' });

  try {
    const db = getDb();
    let pinned = null;
    for (const [name, filter] of videoFilters(author, permlink)) {
      const col = db.collection(name);
      const doc = await col.findOne(filter, { projection: { pinned_comments: 1 } });
      if (!doc) continue;
      const current = Array.isArray(doc.pinned_comments) ? doc.pinned_comments.filter((p) => p !== comment) : [];
      // Newest pin first; the oldest falls off past the cap.
      const next = action === 'pin' ? [comment, ...current].slice(0, MAX_PINS) : current;
      // Nothing pinned any more: drop the field, so the row is as it was.
      await col.updateOne({ _id: doc._id }, next.length
        ? { $set: { pinned_comments: next } }
        : { $unset: { pinned_comments: '' } });
      pinned = next;
    }
    if (!pinned) return res.status(404).json({ success: false, error: 'Video not found' });
    res.json({ success: true, pinned_comments: pinned });
  } catch (err) {
    console.error('[comment-pin]', author, permlink, comment, err.message);
    res.status(502).json({ success: false, error: 'could not save the pin' });
  }
});

module.exports = router;
module.exports._test = { pinMessage, MAX_PINS };
