const express = require('express');
const router = express.Router();
const os = require('os');
const { getDb } = require('../utils/db');
const { CHECKER_INSTANCE, BACKGROUND_JOBS } = require('../utils/config');

// ── Liveness probe for the frontend maintenance gate ─────────────────────────
// The web app hits /healthz on load and shows its maintenance takeover when this
// reports the platform is down. Kept cheap: the Mongo ping result is cached for a
// few seconds so a burst of page-loads can't itself add DB load, and the ping is
// raced against a short timeout so the endpoint stays fast even when the cluster
// is hanging. Always returns HTTP 200 with an `ok` boolean, so the client can
// distinguish "reachable but unhealthy" (ok:false → maintenance) from
// "unreachable" (network error → client fails open and shows the app anyway).
const HEALTH_CACHE_MS = 8000;
const HEALTH_PING_TIMEOUT_MS = 1500;
let healthCache = { ts: 0, ok: true, mongo: 'unknown' };

// Only an OUTAGE takes the site down, not a blip. One failed ping used to flip every
// page load to the maintenance screen: on 2026-09-29 a ~30s network drop to the Mongo
// primary blanked 3speak.tv for everyone loading in that window, while the database
// itself never went down. Now a failure starts a streak, and ok:false is reported only
// once the streak has lasted HEALTH_DOWN_AFTER_MS AND seen HEALTH_DOWN_MIN_FAILS failed
// pings. Until then the answer is ok:true with mongo:'degraded', so monitoring still
// sees it. Any successful ping ends the streak.
const HEALTH_DOWN_AFTER_MS = parseInt(process.env.HEALTH_DOWN_AFTER_MS, 10) || 30000;
const HEALTH_DOWN_MIN_FAILS = parseInt(process.env.HEALTH_DOWN_MIN_FAILS, 10) || 3;
let failStreak = { since: 0, count: 0 };

async function pingMongo() {
    const db = getDb(); // throws if we never connected
    let timer;
    try {
        await Promise.race([
            db.command({ ping: 1 }),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('ping timeout')), HEALTH_PING_TIMEOUT_MS);
            }),
        ]);
    } finally {
        clearTimeout(timer); // /health/latency pings on every call: no timer left per request
    }
}

router.get('/healthz', async (req, res) => {
    // Manual override: ops flip MAINTENANCE_MODE=true to force the maintenance
    // screen for everyone without a frontend redeploy (e.g. planned work).
    const maintenance = String(process.env.MAINTENANCE_MODE || '').toLowerCase() === 'true';
    if (maintenance) {
        return res.json({ ok: false, maintenance: true, mongo: 'n/a', ts: Date.now() });
    }

    const now = Date.now();
    if (now - healthCache.ts < HEALTH_CACHE_MS) {
        return res.json({
            ok: healthCache.ok,
            maintenance: false,
            mongo: healthCache.mongo,
            cached: true,
            ts: healthCache.ts,
        });
    }

    let ok = true;
    let mongo = 'up';
    try {
        await pingMongo();
        failStreak = { since: 0, count: 0 };
    } catch (_) {
        if (!failStreak.count) failStreak.since = now;
        failStreak.count += 1;
        const sustained = failStreak.count >= HEALTH_DOWN_MIN_FAILS
            && now - failStreak.since >= HEALTH_DOWN_AFTER_MS;
        ok = !sustained;
        mongo = sustained ? 'down' : 'degraded';
    }
    healthCache = { ts: now, ok, mongo };
    res.json({ ok, maintenance: false, mongo, cached: false, ts: now });
});

// ── Instance latency, for the frontend's checker pick ────────────────────────
// With several checker instances on one Mongo (checker.3speak.tv,
// checker-us.3speak.tv, ...) the frontend races this route to pick the fastest one
// for the viewer. The browser's round trip is only half the cost: every feed makes
// several Mongo round trips from the instance, so an instance close to the viewer
// but far from the database can still be the slower one. So this does ONE real
// Mongo round trip (`ping`, reads nothing) before answering and reports it as db_ms;
// the request time already holds one trip, db_ms lets the client weigh the rest.
// Never cached (that would hide the trip it exists to measure). 503 when the
// database is unreachable, so the client picks another instance.
router.get('/health/latency', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('Timing-Allow-Origin', '*');
    const instance = CHECKER_INSTANCE || os.hostname();
    const started = process.hrtime.bigint();
    try {
        await pingMongo();
        const dbMs = Number(process.hrtime.bigint() - started) / 1e6;
        res.json({ ok: true, instance, primary: BACKGROUND_JOBS, db_ms: Math.round(dbMs * 10) / 10 });
    } catch (_) {
        res.status(503).json({ ok: false, instance, primary: BACKGROUND_JOBS, error: 'database unreachable' });
    }
});

router.get('/', (req, res) => {
    res.json({
        message: 'Pancreas API is running',
        version: '1.3.0',
        endpoints: {
            check: '/check/:username',
            gethive: '/gethive/:user_id',
            getjobid: '/getjobid/:owner/:permlink',
            views: 'POST /views',
            myVideos: 'GET /api/my-videos?username={username}',
            videosByTag: 'GET /videos/tag/:tag?page={page}&limit={limit}',
            feed: 'GET /feed/:username?page={page}&limit={limit}',
            shorts: 'GET /shorts?page={page}&limit={limit}&app={frontend_app}',
            shortsSorted: 'GET /shortssorted?page={page}&limit={limit}&app={frontend_app}&seed={seed}&currentuser={username}',
            shortsStories: 'GET /shorts/stories?currentuser={username}&app={frontend_app}',
            updateThumbnail: 'PUT /video/thumbnail (Protected - requires API key)',
            feedRecommended: 'GET /feeds/recommended?page={page}&limit={limit}',
            feedNew: 'GET /feeds/new?page={page}&limit={limit}',
            feedTrending: 'GET /feeds/trending?page={page}&limit={limit}',
            feedFirstUploads: 'GET /feeds/firstUploads?page={page}&limit={limit}',
            search: 'GET /search?q={query}&page={page}&limit={limit}&type={video|short|audio|community|all}&nsfw={true|false}'
        }
    });
});

module.exports = router;
