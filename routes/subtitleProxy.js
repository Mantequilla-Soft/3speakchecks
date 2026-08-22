/**
 * Same-origin proxy for subtitle (SRT) content pinned on our own IPFS gateways.
 *
 * The player fetches subtitle CIDs client-side from hotipfs-3speak-1.b-cdn.net,
 * falling back to ipfs.3speak.tv when the CDN 500s ("block was not found
 * locally" — content not yet propagated to that specific hot node). That
 * fallback is itself defeated in every real browser: ipfs.3speak.tv sends
 * `access-control-allow-origin` TWICE on every response (confirmed via curl -D
 * and a live browser fetch — curl doesn't enforce CORS so it doesn't surface
 * this, but Chrome/Firefox reject a response with more than one ACAO value
 * outright, "Failed to fetch"). That's a gateway-side bug outside this repo.
 *
 * Routing the fallback through our OWN backend sidesteps it entirely: this
 * server fetches the CID (no CORS involved server-to-server) and re-serves it
 * with a single, correct ACAO header via the app's normal cors() middleware.
 */
const express = require('express');
const router = express.Router();

// Bare CIDv0 (Qm...) or CIDv1 (b...) — no path segments, no traversal surface.
const CID_RE = /^[a-zA-Z0-9]{40,80}$/;

const GATEWAYS = [
  'https://hotipfs-3speak-1.b-cdn.net/ipfs',
  'https://ipfs.3speak.tv/ipfs',
];
const FETCH_TIMEOUT_MS = 4000;

// Last resort: the IPFS node this service runs beside. Subtitles are written by
// our own pipeline, so the ingest node holds them even when the hot CDN hasn't
// pinned them yet and the public gateway is unreachable — which as of
// 2026-08-20 is EVERY subtitle file, taking captions down with it. `cat` on the
// local API needs no CORS and no propagation.
const LOCAL_IPFS_API = (process.env.IPFS_API_URL || 'http://127.0.0.1:5001').replace(/\/$/, '');

async function fetchWithTimeout(url, method = 'GET') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { method, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// GET /subtitle-proxy/:cid — text/plain passthrough of the SRT file at that CID.
router.get('/subtitle-proxy/:cid', async (req, res) => {
  const { cid } = req.params;
  if (!CID_RE.test(cid)) {
    return res.status(400).json({ success: false, error: 'invalid cid' });
  }

  let lastStatus = null;
  const send = (text) => {
    res.set('Cache-Control', 'public, max-age=3600'); // subtitle content is immutable per CID
    return res.type('text/plain; charset=utf-8').send(text);
  };

  // The node next door FIRST. Subtitles are written by our own pipeline, so the
  // ingest node this service runs beside already holds them: it answers in
  // single-digit milliseconds, needs no CORS and needs no propagation. The
  // gateways are the fallback, not the other way round — trying them first cost
  // 8s per request, because the hot CDN 500s for un-pinned content and
  // ipfs.3speak.tv then hangs to the timeout before the local node ever gets
  // asked. That latency is what kept the transcript out of the prerendered page
  // for crawlers, which give up long before 8s.
  try {
    const local = await fetchWithTimeout(`${LOCAL_IPFS_API}/api/v0/cat?arg=${encodeURIComponent(cid)}`, 'POST');
    if (local.ok) return send(await local.text());
    lastStatus = local.status;
  } catch (err) {
    lastStatus = err.name === 'AbortError' ? 504 : 502;
  }

  for (const base of GATEWAYS) {
    try {
      const upstream = await fetchWithTimeout(`${base}/${cid}`);
      if (!upstream.ok) { lastStatus = upstream.status; continue; }
      return send(await upstream.text());
    } catch (err) {
      lastStatus = err.name === 'AbortError' ? 504 : 502;
    }
  }

  res.status(502).json({ success: false, error: 'no gateway succeeded', lastStatus });
});

module.exports = router;
