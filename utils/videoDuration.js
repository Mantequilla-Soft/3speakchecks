/**
 * The real length of an embed video, read from its own HLS manifest.
 *
 * `embed-video.duration` is NOT measured anywhere on our side. It is whatever the
 * uploading client put in the tus metadata (embedvideos src/utils/uploadAuth.ts:
 * `metadata?.duration ? parseFloat(metadata.duration) : null`), and the encoder
 * never fills it in afterwards — so an app that does not send it leaves the field
 * null forever. As of 2026-08-25 that was 1,994 of 8,767 published videos (22.7%):
 * ~100% of everything before March 2026, plus a share that has been climbing back
 * since April (3% → 16%) as third-party and mobile uploaders took more of the
 * volume. By app: 3speak-tv 4%, hive-react-kit 0%, ecency 31%, snapie-mobile 49%,
 * snapie 71%.
 *
 * The manifest always knows, because it IS the media timeline: Σ #EXTINF. That is
 * authoritative rather than an estimate, which is why nothing here ever guesses —
 * an unreadable manifest returns null and the doc is left alone.
 *
 * 🚨 GATEWAY ORDER IS MEASURED, NOT ARBITRARY. BunnyCDN 500s on cold-cache content:
 * on the same random sample it failed 5 of 8 while ipfs.3speak.tv returned all 8,
 * and 8 of 8 again on 2025-12..2026-03 rows. Put bunny first and a backfill looks
 * like the content is gone when it is merely not cached. Bunny stays as a fallback
 * because it is the faster of the two whenever it does have the object.
 */
const GATEWAYS = [
    // Same order as routes/adServe.js, and for the same measured reason: hotipfs-3speak-1
    // only serves what is already in its cache. ipfs-3speak is what play.3speak.tv's own
    // gateway race picks, and ipfs.3speak.tv is the last resort (fine here — no CORS
    // applies to a server-side read — but never usable in a browser-facing playlist).
    'https://ipfs-3speak.b-cdn.net/ipfs',
    'https://ipfs.3speak.tv/ipfs',
    'https://hotipfs-3speak-1.b-cdn.net/ipfs',
];
const FETCH_TIMEOUT_MS = 15000;
// A manifest that sums to more than this is a parse gone wrong, not a long video.
// Written onto the doc it would quietly break every length-targeted ad campaign and
// every duration badge, so it is refused rather than stored.
const MAX_PLAUSIBLE_SECONDS = 24 * 60 * 60;

async function fetchText(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { redirect: 'follow', signal: controller.signal });
        if (!res.ok) return null;
        return await res.text();
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

function sumExtinf(text) {
    const durs = [...text.matchAll(/#EXTINF:\s*([0-9.]+)/g)].map((m) => parseFloat(m[1]));
    if (!durs.length) return null;
    const total = durs.reduce((a, b) => a + b, 0);
    if (!Number.isFinite(total) || total <= 0 || total > MAX_PLAUSIBLE_SECONDS) return null;
    return total;
}

/**
 * Seconds, or null if no gateway could give us a manifest we can read.
 * master playlist → variant playlist → Σ EXTINF.
 */
async function durationFromManifest(manifestCid) {
    if (!manifestCid) return null;
    for (const base of GATEWAYS) {
        const master = await fetchText(`${base}/${manifestCid}/manifest.m3u8`);
        if (!master) continue;

        // A master playlist lists variant playlists; a media playlist has EXTINFs directly.
        const direct = sumExtinf(master);
        if (direct) return direct;

        const variant = master.split('\n').map((l) => l.trim())
            .find((l) => l && !l.startsWith('#') && l.endsWith('.m3u8'));
        if (!variant) continue;

        const media = await fetchText(`${base}/${manifestCid}/${variant}`);
        if (!media) continue;
        const total = sumExtinf(media);
        if (total) return total;
    }
    return null;
}

/**
 * What the rest of the codebase means by "we do not know how long this is".
 * `duration: 0` counts: routes/adServe.js reads it as `Number(v.duration) || null`,
 * so a stored 0 is already indistinguishable from null everywhere it matters.
 */
const UNKNOWN_DURATION = [
    { duration: null },
    { duration: 0 },
    { duration: { $exists: false } },
];

module.exports = { durationFromManifest, sumExtinf, UNKNOWN_DURATION, GATEWAYS, MAX_PLAUSIBLE_SECONDS };
