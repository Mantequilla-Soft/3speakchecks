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
const FETCH_TIMEOUT_MS = 10000;

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
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
  for (const base of GATEWAYS) {
    try {
      const upstream = await fetchWithTimeout(`${base}/${cid}`);
      if (!upstream.ok) { lastStatus = upstream.status; continue; }
      const text = await upstream.text();
      res.set('Cache-Control', 'public, max-age=3600'); // subtitle content is immutable per CID
      return res.type('text/plain; charset=utf-8').send(text);
    } catch (err) {
      lastStatus = err.name === 'AbortError' ? 504 : 502;
    }
  }
  res.status(502).json({ success: false, error: 'no gateway succeeded', lastStatus });
});

module.exports = router;
