/**
 * Viewer-supplied video tags ("viewer-tag") — crowd-sourced topic labels a user
 * assigns from the vote dialog, alongside their Hive vote.
 *
 * The decision is ALSO written on-chain as a `3speak-viewer-tag` custom_json in
 * the same transaction as the vote; this Mongo copy is the queryable mirror the
 * ranking/tagger work reads (reading it back off-chain per video would be slow).
 *
 * Auth model matches the platform's other per-user state (watch-history,
 * hide-creator): the caller supplies its own username, no token — this only
 * records a personal, low-stakes label and can't affect anyone else's experience.
 * The on-chain custom_json is the authoritative, signed record; this endpoint is
 * a convenience index, so the trust bar is intentionally low.
 *
 * One tag per (voter, video): re-voting with a new tag overwrites the old one.
 */
const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');
const { normalizeInterestTag, INTEREST_TAGS } = require('../utils/interestTags');
const { getTranscriptionTags } = require('../utils/transcriptionTags');

const COLLECTION = 'viewer-tags';
const TAG_FIELD = 'viewer-tag';

// Each transcription (auto) tag counts as one 100%-strength upvote when tallied
// against viewer votes — vote weights are on the 0–10000 scale, 10000 = 100%.
const AUTO_TAG_WEIGHT = 10000;

const norm = (s) => String(s || '').trim().toLowerCase().replace(/^@/, '');

// POST /viewer-tag — record (or update) this viewer's tag for a video.
router.post('/viewer-tag', async (req, res) => {
  try {
    const voter = norm(req.body.username || req.body.voter);
    const author = norm(req.body.author || req.body.owner);
    const permlink = String(req.body.permlink || '').trim();
    const tag = normalizeInterestTag(req.body.tag);
    const weight = Number.isFinite(+req.body.weight) ? +req.body.weight : null;

    if (!voter || !author || !permlink) {
      return res.status(400).json({ success: false, error: 'username, author and permlink are required' });
    }
    if (!tag) {
      return res.status(400).json({ success: false, error: 'tag must be one of the interest taxonomy', allowed: INTEREST_TAGS });
    }

    await getDb().collection(COLLECTION).updateOne(
      { _id: `${voter}:${author}:${permlink}` },
      {
        $set: {
          voter, author, permlink,
          [TAG_FIELD]: tag,
          weight,
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );
    res.json({ success: true, [TAG_FIELD]: tag });
  } catch (e) {
    console.error('viewer-tag write failed:', e && e.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /viewer-tag/mine/:username/:author/:permlink — has this user already tagged
// this video? Used to enforce the one-shot tag-only path after the vote window
// closes ("only if they never added a tag").
router.get('/viewer-tag/mine/:username/:author/:permlink', async (req, res) => {
  try {
    const voter = norm(req.params.username);
    const author = norm(req.params.author);
    const permlink = String(req.params.permlink || '').trim();
    if (!voter || !author || !permlink) {
      return res.status(400).json({ success: false, error: 'username, author and permlink are required' });
    }
    const doc = await getDb().collection(COLLECTION)
      .findOne({ _id: `${voter}:${author}:${permlink}` }, { projection: { [TAG_FIELD]: 1 } });
    res.json({ success: true, tagged: !!doc, tag: doc ? doc[TAG_FIELD] : null });
  } catch (e) {
    console.error('viewer-tag mine failed:', e && e.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /viewer-tags/:author/:permlink — combined tag consensus for one video.
//
// Merges two sources into a single weighted tally:
//   - viewer votes   — each contributes its own vote weight (0–10000) to its tag
//   - transcription  — each auto-tag contributes AUTO_TAG_WEIGHT (a 100% upvote)
//
// Each tag's `pct` is its share of the TOTAL combined weight. The WINNER is the
// highest combined weight (ties → voter count → tag name, deterministic). `auto`
// flags tags the transcription pipeline assigned; `count` is the human voter count.
router.get('/viewer-tags/:author/:permlink', async (req, res) => {
  try {
    const db = getDb();
    const author = norm(req.params.author);
    const permlink = String(req.params.permlink || '').trim();
    if (!author || !permlink) {
      return res.status(400).json({ success: false, error: 'author and permlink are required' });
    }

    const [voteRows, auto] = await Promise.all([
      db.collection(COLLECTION).aggregate([
        { $match: { author, permlink } },
        {
          $group: {
            _id: `$${TAG_FIELD}`,
            // A missing/blank weight shouldn't zero out a genuine vote.
            weight: { $sum: { $max: [{ $abs: { $ifNull: ['$weight', 1] } }, 1] } },
            count: { $sum: 1 },
            // Who tagged it (for the hover/pinned voters list).
            voters: { $push: { voter: '$voter', weight: { $max: [{ $abs: { $ifNull: ['$weight', 1] } }, 1] } } },
          },
        },
      ]).toArray(),
      getTranscriptionTags(db, author, permlink),
    ]);

    // Cap the per-tag voter list so the response stays small; heaviest first.
    const topVoters = (arr) => (arr || [])
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 60);

    // Merge into one map: tag -> { weight, count(voters), auto, voters }
    const byTag = new Map();
    for (const r of voteRows) {
      byTag.set(r._id, { tag: r._id, weight: r.weight, count: r.count, auto: false, voters: topVoters(r.voters) });
    }
    for (const tag of auto.tags || []) {
      const cur = byTag.get(tag) || { tag, weight: 0, count: 0, auto: false, voters: [] };
      cur.weight += AUTO_TAG_WEIGHT;
      cur.auto = true;
      byTag.set(tag, cur);
    }

    const totalWeight = [...byTag.values()].reduce((a, c) => a + c.weight, 0) || 1;
    const counts = [...byTag.values()]
      .map((c) => ({ ...c, pct: Math.round((c.weight / totalWeight) * 1000) / 10 }))
      .sort((a, b) => (b.weight - a.weight) || (b.count - a.count) || a.tag.localeCompare(b.tag));

    res.json({
      success: true,
      author,
      permlink,
      total: voteRows.reduce((a, c) => a + c.count, 0), // human voters
      totalWeight,
      autoTags: auto.tags || [],
      winner: counts[0]?.tag || null,
      counts, // [{ tag, weight, count, auto, pct }]
    });
  } catch (e) {
    console.error('viewer-tags read failed:', e && e.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
