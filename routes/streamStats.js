// Foundation write-endpoints for live-stream leaderboard stats (OpenPods / livestreaming).
//
// Called by the 3Speak BACKGROUND SERVICE, never a browser — every route is gated by
// a shared secret in `Authorization: Bearer <STREAM_STATS_SECRET>` (or `X-Api-Key`),
// compared in constant time, FAIL-CLOSED (503 if the secret is unset).
//
// This only CAPTURES data; the leaderboard calculation is built later on top of it.
//   stream-stats  — one doc per stream (_id = streamId): peak/total viewers + duration.
//   stream-boosts — one doc per boost message: sender + the stream it belongs to.
//
// streamId = a stable id the caller supplies per stream session (e.g. the LiveKit room
// sid). roomName + host are stored alongside for the eventual per-creator aggregation.
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getDb } = require('../utils/db');

const SECRET = process.env.STREAM_STATS_SECRET || '';

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ab, bb); } catch { return false; }
}

// Gate EVERY route in this router with the shared secret.
router.use((req, res, next) => {
  if (!SECRET) return res.status(503).json({ error: 'stream-stats disabled (no STREAM_STATS_SECRET set)' });
  const hdr = req.get('authorization') || '';
  const bearer = hdr.startsWith('Bearer ') ? hdr.slice(7).trim() : '';
  const provided = bearer || req.get('x-api-key') || '';
  if (!provided || !timingSafeEqual(provided, SECRET)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  return next();
});

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

// Resolve the stream key + shared metadata from the body.
function streamKey(b) {
  return {
    streamId: str(b.streamId, 128) || str(b.roomName, 128), // fall back to roomName
    roomName: str(b.roomName, 128) || null,
    host: str(b.host, 32).toLowerCase() || null,
  };
}

// Fields stamped on every upsert (identity + freshness).
function baseSet({ roomName, host }) {
  const set = { updatedAt: new Date() };
  if (roomName) set.roomName = roomName;
  if (host) set.host = host;
  return set;
}

// POST /stream-stats/viewer — call ONCE per new viewer that shows up (bumps totalViewers).
router.post('/stream-stats/viewer', async (req, res) => {
  try {
    const b = req.body || {};
    const { streamId, roomName, host } = streamKey(b);
    if (!streamId) return res.status(400).json({ error: 'streamId (or roomName) is required' });
    await getDb().collection('stream-stats').updateOne(
      { _id: streamId },
      {
        $setOnInsert: { startedAt: new Date(), peakViewers: 0 },
        $set: baseSet({ roomName, host }),
        $inc: { totalViewers: 1 },
        $currentDate: { lastViewerAt: true },
      },
      { upsert: true },
    );
    res.status(201).json({ ok: true });
  } catch (e) {
    console.error('POST /stream-stats/viewer failed:', e.message);
    res.status(500).json({ error: 'failed to record viewer' });
  }
});

// POST /stream-stats/peak — call when a new concurrent-viewer peak is reached (keeps the max).
router.post('/stream-stats/peak', async (req, res) => {
  try {
    const b = req.body || {};
    const { streamId, roomName, host } = streamKey(b);
    const peak = num(b.peak);
    if (!streamId) return res.status(400).json({ error: 'streamId (or roomName) is required' });
    if (peak == null || peak < 0) return res.status(400).json({ error: 'peak (non-negative number) is required' });
    await getDb().collection('stream-stats').updateOne(
      { _id: streamId },
      {
        $setOnInsert: { startedAt: new Date(), totalViewers: 0 },
        $set: baseSet({ roomName, host }),
        $max: { peakViewers: Math.round(peak) },
      },
      { upsert: true },
    );
    res.status(201).json({ ok: true });
  } catch (e) {
    console.error('POST /stream-stats/peak failed:', e.message);
    res.status(500).json({ error: 'failed to record peak' });
  }
});

// POST /stream-stats/end — call when the stream ends; records endedAt + durationSec.
// Pass durationSec explicitly, or startedAt, or rely on the stored startedAt.
router.post('/stream-stats/end', async (req, res) => {
  try {
    const b = req.body || {};
    const { streamId, roomName, host } = streamKey(b);
    if (!streamId) return res.status(400).json({ error: 'streamId (or roomName) is required' });
    const endedAt = b.endedAt ? new Date(b.endedAt) : new Date();
    if (isNaN(endedAt.getTime())) return res.status(400).json({ error: 'endedAt is invalid' });
    const set = { ...baseSet({ roomName, host }), endedAt };
    if (b.startedAt) {
      const s = new Date(b.startedAt);
      if (!isNaN(s.getTime())) set.startedAt = s;
    }
    let durationSec = num(b.durationSec);
    if (durationSec == null) {
      // Compute from the given or stored startedAt.
      const existing = set.startedAt ? null
        : await getDb().collection('stream-stats').findOne({ _id: streamId }, { projection: { startedAt: 1 } });
      const startedAt = set.startedAt || (existing && existing.startedAt);
      if (startedAt) durationSec = Math.max(0, Math.round((endedAt - new Date(startedAt)) / 1000));
    }
    if (durationSec != null) set.durationSec = Math.max(0, Math.round(durationSec));
    // startedAt goes in $set when provided, else fall back on insert — never both
    // (Mongo rejects the same field in $set and $setOnInsert).
    const onInsert = { peakViewers: 0, totalViewers: 0 };
    if (!set.startedAt) onInsert.startedAt = endedAt;
    await getDb().collection('stream-stats').updateOne(
      { _id: streamId },
      { $setOnInsert: onInsert, $set: set },
      { upsert: true },
    );
    res.status(201).json({ ok: true, durationSec: set.durationSec ?? null });
  } catch (e) {
    console.error('POST /stream-stats/end failed:', e.message);
    res.status(500).json({ error: 'failed to record stream end' });
  }
});

// POST /stream-stats/boost — log a boost message (sender + the stream it belongs to).
router.post('/stream-stats/boost', async (req, res) => {
  try {
    const b = req.body || {};
    const { streamId, roomName, host } = streamKey(b);
    const sender = str(b.sender, 32).toLowerCase();
    if (!streamId) return res.status(400).json({ error: 'streamId (or roomName) is required' });
    if (!sender) return res.status(400).json({ error: 'sender is required' });
    await getDb().collection('stream-boosts').insertOne({
      streamId,
      roomName,
      host,
      sender,
      message: str(b.message, 2000) || null,
      amount: num(b.amount),
      createdAt: new Date(),
    });
    res.status(201).json({ ok: true });
  } catch (e) {
    console.error('POST /stream-stats/boost failed:', e.message);
    res.status(500).json({ error: 'failed to log boost' });
  }
});

// GET /stream-stats/:streamId — read a stream's aggregate back (caller / debugging).
router.get('/stream-stats/:streamId', async (req, res) => {
  try {
    const streamId = str(req.params.streamId, 128);
    if (!streamId) return res.status(400).json({ error: 'streamId is required' });
    const doc = await getDb().collection('stream-stats').findOne({ _id: streamId });
    if (!doc) return res.status(404).json({ error: 'not found' });
    const boostCount = await getDb().collection('stream-boosts').countDocuments({ streamId });
    res.json({ ...doc, boostCount });
  } catch (e) {
    console.error('GET /stream-stats/:streamId failed:', e.message);
    res.status(500).json({ error: 'failed' });
  }
});

module.exports = router;
