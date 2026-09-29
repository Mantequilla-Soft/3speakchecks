/**
 * Serve an ad segment from our own origin when the gateway holding it cannot be
 * redirected to.
 *
 * The measured ad segments (/m/:sid/a, /b, /am<n>) normally go out as a 302 to the
 * CDN. A browser follows a cross-origin redirect with `Origin: null`, which only the
 * Bunny zones accept. When both Bunny zones are suspended (it happens: 2026-09-08,
 * 2026-09-29) the segment urls resolve to ipfs.3speak.tv, which answers only named
 * pages, so the 302 fails CORS and the ad never plays. Relayed, the bytes come from
 * checker.3speak.tv itself, which sends CORS for every page.
 *
 * Creatives are few and their segments small (a few MB per spot), so each segment is
 * fetched ONCE and kept in the ad-burn cache directory. That directory is swept by
 * size in services/adBurner.js, which counts these `.ts` files too, so the relay can
 * never grow the disk on its own.
 *
 * Returns a local file path, or null when the bytes could not be had from any gateway;
 * the caller then falls back to the redirect, which is what happened before this existed.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { CACHE_DIR } = require('./adBurner');
const { gatewaySiblings, urlsHealthFirst, markGatewayDown } = require('../utils/adGateways');

const RELAY_TIMEOUT_MS = parseInt(process.env.AD_RELAY_TIMEOUT_MS, 10) || 15000;
const RELAY_MAX_BYTES = 30 * 1024 * 1024;   // an HLS segment is a few MB; anything this big is not one
const inflight = new Map();

async function fetchToFile(url, dest) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), RELAY_TIMEOUT_MS);
  try {
    const r = await fetch(url, { redirect: 'follow', signal: ac.signal });
    if (r.status === 403) markGatewayDown(url);
    if (!r.ok) throw new Error(`status ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > RELAY_MAX_BYTES) throw new Error(`bad size ${buf.length}`);
    await fsp.writeFile(dest, buf);
  } finally {
    clearTimeout(timer);
  }
}

async function relayedSegment(url) {
  const key = crypto.createHash('sha256').update(`relay\n${url}`).digest('hex');
  const out = path.join(CACHE_DIR, `relay-${key}.ts`);
  try {
    if (fs.statSync(out).size > 0) {
      const now = new Date();
      fsp.utimes(out, now, now).catch(() => {});   // the sweep evicts by atime
      return out;
    }
  } catch { /* not cached yet */ }

  if (inflight.has(key)) return inflight.get(key);
  const work = (async () => {
    await fsp.mkdir(CACHE_DIR, { recursive: true });
    // Dot-prefixed while writing, so the sweep and a concurrent reader never see a
    // half-written file under the real name.
    const tmp = path.join(CACHE_DIR, `.relay-${key}.${process.pid}.tmp`);
    for (const candidate of urlsHealthFirst([url, ...gatewaySiblings(url)])) {
      try {
        await fetchToFile(candidate, tmp);
        await fsp.rename(tmp, out);
        return out;
      } catch { /* next gateway */ }
    }
    await fsp.unlink(tmp).catch(() => {});
    return null;
  })().finally(() => inflight.delete(key));
  inflight.set(key, work);
  return work;
}

module.exports = { relayedSegment };
