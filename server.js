const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const { PORT, TRENDING_INTERVAL_MIN, COMMUNITY_SYNC_DELAY_H, COMMUNITY_SYNC_INTERVAL_H, PROFILE_SYNC_DELAY_H, PROFILE_SYNC_INTERVAL_H, THUMBNAIL_SYNC_ENABLED, THUMBNAIL_SYNC_INTERVAL_MIN, AD_INVENTORY_ENABLED, AD_INVENTORY_INTERVAL_H } = require('./utils/config');
const { connectToMongo, getDb } = require('./utils/db');
const { calculateAndFlagTrendingVideos } = require('./services/trending');
const { syncHiveCommunities } = require('./services/communitySync');
const { syncHiveProfiles } = require('./services/profileSync');
const { denormalizeCommunityTitles } = require('./services/communityDenorm');
const { startTagSyncWatcher } = require('./services/tagSync');
const { syncAudioHiveLinks } = require('./services/audioHiveSync');
const { syncEmbedCategories } = require('./services/embedCategorySync');
const { syncThumbnails } = require('./services/thumbnailSync');
const { syncPremiumFromSubs } = require('./services/premiumSubsSync');
const { schedule: scheduleCollectSubs } = require('./services/collectSubscriptions');
const { schedule: scheduleVerifiedFollow } = require('./services/verifiedFollow');
const { schedule: scheduleAudioPayouts } = require('./services/audioPayouts');
const { schedule: scheduleListenConsolidation } = require('./services/listenConsolidation');
const { schedule: scheduleScheduledPosts } = require('./services/scheduledPosts');
const { schedule: scheduleWatchRetention } = require('./services/watchRetention');
const { scheduleRetention } = require('./services/retention');
const adInventory = require('./services/adInventory');
const adPayouts = require('./services/adPayouts');
const adCreativeSync = require('./services/adCreativeSync');
const { scheduleDiscover } = require('./services/discover');
const { scheduleCommentCounts } = require('./services/commentCounts');

// Routes
const healthRoutes = require('./routes/health');
const searchRoutes = require('./routes/search');
const userRoutes = require('./routes/user');
const videosRoutes = require('./routes/videos');
const shortsRoutes = require('./routes/shorts');
const audioRoutes = require('./routes/audio');
const feedsRoutes = require('./routes/feeds');
const rssRoutes = require('./routes/rss');
const pushRoutes = require('./routes/push');
const pushNotify = require('./services/pushNotify');
const pushHive = require('./services/pushHive');
const webPush = require('./utils/webPush');
const verifyRoutes = require('./routes/verify');
const scheduledPostsRoutes = require('./routes/scheduledPosts');
const communitiesRoutes = require('./routes/communities');
const promoteRoutes = require('./routes/promote');
const analyticsRoutes = require('./routes/analytics');
const userFiltersRoutes = require('./routes/userFilters');
const viewerTagsRoutes = require('./routes/viewerTags');
const leaderboardRoutes = require('./routes/leaderboard');
const gdprRoutes = require('./routes/gdpr');
const gdprAdminRoutes = require('./routes/gdprAdmin');
const snapsRoutes = require('./routes/snaps');
const playlistsFeedRoutes = require('./routes/playlistsFeed');
const reviewsRoutes = require('./routes/reviews');
const reportsRoutes = require('./routes/reports');
const streamStatsRoutes = require('./routes/streamStats');
const subtitleProxyRoutes = require('./routes/subtitleProxy');
const advertiseRoutes = require('./routes/advertise');
const adCampaignRoutes = require('./routes/adCampaigns');
const adServeRoutes = require('./routes/adServe');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files (XSL stylesheet for RSS feed viewer, etc.)
app.use(express.static('public'));


// Drop the full post `body`/`description` from feed LIST responses — cards never
// read them and they were ~79% of the payload (94KB → 9KB brotli on a 50-item
// feed). Mounted per-path, NOT globally: single-video detail routes
// (/videodetails, /api/video) must keep returning a body. See utils/slimFeed.js.
const { slimFeed, makeSlimFeed, SHORTS_HEAVY_FIELDS } = require('./utils/slimFeed');
app.use('/feeds', slimFeed);                       // every /feeds/* route is a list
app.use(['/feed', '/videos/tag'], slimFeed);       // list routes inside the videos router
// Shorts keep `hive_body` — it's their visible caption, not dead weight.
app.use(['/shorts', '/shortssorted'], makeSlimFeed(SHORTS_HEAVY_FIELDS));

// Stamp payout/vote/comment counts onto feed list items from our own `video-stats`
// cache, so browsers no longer fetch them from Hive per card. No-op unless
// VIDEO_STATS_ENABLED. Same list paths as slimFeed above.
const { videoStatsMiddleware, scheduleVideoStats } = require('./services/videoStats');
app.use('/feeds', videoStatsMiddleware);
app.use(['/feed', '/videos/tag'], videoStatsMiddleware);

// Mount routes
app.use('/', healthRoutes);
app.use('/search', searchRoutes);
app.use('/', userRoutes);
app.use('/', videosRoutes);
app.use('/', promoteRoutes);
app.use('/', shortsRoutes);
app.use('/audio', audioRoutes);
app.use('/feeds', feedsRoutes);
app.use('/rss', rssRoutes);
app.use('/verify', verifyRoutes);
app.use('/scheduled-posts', scheduledPostsRoutes);
app.use('/', communitiesRoutes);
app.use('/', analyticsRoutes);
app.use('/', gdprRoutes);
app.use('/gdpr-admin', gdprAdminRoutes);
app.use('/', userFiltersRoutes);
app.use('/', viewerTagsRoutes);
app.use('/', leaderboardRoutes);
app.use('/', snapsRoutes);
app.use('/', playlistsFeedRoutes);
app.use('/', reviewsRoutes);
app.use('/', reportsRoutes);
// Mounted BEFORE streamStatsRoutes: that router's auth gate (routes/streamStats.js)
// is registered with router.use() and no path, so it unconditionally 401s every
// request that reaches it — including ones meant for routes mounted after it.
// Ordering this route first sidesteps that instead of touching streamStats.js.
app.use('/', subtitleProxyRoutes);
app.use('/advertise', advertiseRoutes);   // same reason as above: must precede streamStatsRoutes
app.use('/advertise', adCampaignRoutes);  // booking + payment, same mount, same ordering rule
// Ad SERVING lives at /m, deliberately not under /advertise: every URL the browser
// fetches during playback has to be indistinguishable from ordinary streaming, and
// a path containing "advertise" is the easiest possible thing for a filter list to
// match. See the header of routes/adServe.js.
app.use('/m', adServeRoutes);
app.use('/push', pushRoutes);             // same ordering rule as above
app.use('/', streamStatsRoutes);

// Track whether heavy sync tasks are running
let syncRunning = false;

// Start server
async function startServer() {
    await connectToMongo();

    // Warm the hidden-creators set on boot so the very first feed/search/watch
    // request is already filtered (the sync accessors otherwise warm lazily on the
    // first hit, leaving a sub-second fail-open window after a restart).
    require('./utils/hiddenCreators').getHiddenSet().catch(() => {});

    // GDPR request retention. A closed request still holds the requester's email +
    // message. We keep it a short window after fulfilment (audit / appeal) then
    // delete it — otherwise, for someone whose data we just ERASED, we'd be sitting
    // on their contact details again. Daily at 04:45.
    const GDPR_REQUEST_RETENTION_DAYS = parseInt(process.env.GDPR_REQUEST_RETENTION_DAYS, 10) || 30;
    const purgeClosedGdprRequests = async () => {
        try {
            const cutoff = new Date(Date.now() - GDPR_REQUEST_RETENTION_DAYS * 24 * 60 * 60 * 1000);
            const res = await getDb().collection('gdpr-requests')
                .deleteMany({ status: 'done', closedAt: { $lt: cutoff } });
            if (res.deletedCount) console.log(`[gdpr] purged ${res.deletedCount} closed request(s) older than ${GDPR_REQUEST_RETENTION_DAYS}d`);
        } catch (e) {
            console.error('[gdpr] closed-request retention cleanup failed:', e.message);
        }
    };
    purgeClosedGdprRequests(); // once on boot, then daily
    cron.schedule('45 4 * * *', purgeClosedGdprRequests);
    console.log(`GDPR closed-request retention: delete ${GDPR_REQUEST_RETENTION_DAYS}d after close (daily 04:45)`);

    // Start change stream watcher to keep hive_tags_lower in sync
    startTagSyncWatcher();

    // Initialize trending videos on startup
    console.log('Initializing trending videos...');
    await calculateAndFlagTrendingVideos();

    // Schedule trending calculation (skip if a sync is running)
    cron.schedule(`*/${TRENDING_INTERVAL_MIN} * * * *`, () => {
        if (syncRunning) {
            console.log('Skipping trending calculation — sync in progress');
            return;
        }
        console.log('Running scheduled trending calculation...');
        calculateAndFlagTrendingVideos();
    });
    console.log(`Trending calculation scheduled every ${TRENDING_INTERVAL_MIN} minutes`);

    // Sync communities (delayed after startup, then on interval)
    const commDelayMs = COMMUNITY_SYNC_DELAY_H * 60 * 60 * 1000;
    const commIntervalMs = COMMUNITY_SYNC_INTERVAL_H * 60 * 60 * 1000;
    setTimeout(() => {
        const runCommunitySync = async () => {
            syncRunning = true;
            console.log('Running community sync...');
            try {
                await syncHiveCommunities();
                await denormalizeCommunityTitles();
            } catch (err) {
                console.error('Community sync error:', err);
            } finally {
                syncRunning = false;
            }
        };
        runCommunitySync();
        setInterval(runCommunitySync, commIntervalMs);
    }, commDelayMs);
    console.log(`Community sync scheduled every ${COMMUNITY_SYNC_INTERVAL_H}h (first run in ${COMMUNITY_SYNC_DELAY_H}h)`);

    // Sync profiles (delayed after startup, then on interval)
    const profDelayMs = PROFILE_SYNC_DELAY_H * 60 * 60 * 1000;
    const profIntervalMs = PROFILE_SYNC_INTERVAL_H * 60 * 60 * 1000;
    setTimeout(() => {
        const runProfileSync = async () => {
            syncRunning = true;
            console.log('Running profile sync...');
            try {
                await syncHiveProfiles();
            } catch (err) {
                console.error('Profile sync error:', err);
            } finally {
                syncRunning = false;
            }
        };
        runProfileSync();
        setInterval(runProfileSync, profIntervalMs);
    }, profDelayMs);
    console.log(`Profile sync scheduled every ${PROFILE_SYNC_INTERVAL_H}h (first run in ${PROFILE_SYNC_DELAY_H}h)`);

    // Sync audio → Hive post links (delayed 2min, then every 30min)
    setTimeout(() => {
        syncAudioHiveLinks().catch(err => console.error('Audio Hive sync error:', err));
        setInterval(() => {
            if (syncRunning) return;
            syncAudioHiveLinks().catch(err => console.error('Audio Hive sync error:', err));
        }, 30 * 60 * 1000);
    }, 2 * 60 * 1000);
    console.log('Audio-Hive link sync scheduled every 30min (first run in 2min)');

    // Resolve & persist the Hive community (category) on embed-video docs so
    // /feeds/community/* can filter reliably (first run in 1min, then every 15min).
    setTimeout(() => {
        syncEmbedCategories().catch(err => console.error('Embed category sync error:', err));
        setInterval(() => {
            if (syncRunning) return;
            syncEmbedCategories().catch(err => console.error('Embed category sync error:', err));
        }, 15 * 60 * 1000);
    }, 60 * 1000);
    console.log('Embed category sync scheduled every 15min (first run in 1min)');

    // Backfill thumbnail_url from the Hive post for docs the upstream publisher
    // left empty (livestream VODs, third-party embed-API uploads) — without it
    // the card falls back to a constructed img.3speak.tv URL that 404s.
    if (THUMBNAIL_SYNC_ENABLED) {
        const thumbIntervalMs = THUMBNAIL_SYNC_INTERVAL_MIN * 60 * 1000;
        setTimeout(() => {
            syncThumbnails().catch(err => console.error('Thumbnail sync error:', err));
            setInterval(() => {
                if (syncRunning) return;
                syncThumbnails().catch(err => console.error('Thumbnail sync error:', err));
            }, thumbIntervalMs);
        }, 90 * 1000);
        console.log(`Thumbnail sync scheduled every ${THUMBNAIL_SYNC_INTERVAL_MIN}min (first run in 90s)`);
    }

    // Sync VSC subscription status → embed-users.premium. Runs on a
    // tight 60s cadence so the 1-day pass expires within ±1min of its
    // 24h window. Source of truth is the Okinoko Hasura indexer; worker
    // only touches rows tagged premium_source='subs' on demote so
    // manual upgrades stay sticky.
    setTimeout(() => {
        syncPremiumFromSubs().catch(err => console.error('Premium subs sync error:', err));
        setInterval(() => {
            syncPremiumFromSubs().catch(err => console.error('Premium subs sync error:', err));
        }, 60 * 1000);
    }, 30 * 1000);
    console.log('Premium subs sync scheduled every 60s (first run in 30s)');

    // Periodic collect_subscriptions for the Pro contract. Self-gated on
    // env (THREESPEAK_PRO_USERNAME + THREESPEAK_PRO_POSTING_KEY); no-op
    // and logs "disabled" when credentials aren't configured.
    scheduleCollectSubs();

    // Verified-badge auto-follow: @VERIFIED_BADGE_ACCOUNT follows every
    // contentcreators.verified creator it isn't already following. Self-gated on
    // env (account + posting key); logs "disabled" when credentials aren't set.
    scheduleVerifiedFollow();

    // Pay-per-listen weekly payout (period ends Sun 00:00 UTC, checked every
    // 12h with catch-up). Runs in DRY RUN until PPL_PAYOUT_ACTIVE_KEY is set.
    scheduleAudioPayouts();
    scheduleScheduledPosts();

    // Consolidate audio-listen-log rows older than 5 months: fold their counts
    // into embed-audio (archivedListens) then delete them. Keeps unpaid payable
    // rows. Set LISTEN_CONSOLIDATE_DRY_RUN=true to preview without deleting.
    scheduleListenConsolidation();

    // Delete watch-time records (view-durations/heatmaps/sessions) for videos
    // whose post date is older than 3 months (WATCH_RETENTION_DAYS).
    scheduleWatchRetention();

    // Retention ranking: score every video from its watch-duration data in a
    // worker thread every RETENTION_INTERVAL_MIN; feeds multiply their score by it.
    scheduleRetention();

    // "Someone you follow posted" push notifications. Cheap (two indexed finds
    // plus one HTTPS call per subscriber with a match), so it runs on the main
    // thread. Silent no-op until VAPID keys are configured.
    if (pushNotify && webPush.isConfigured()) {
        const pushIntervalMs = Math.max(1, parseInt(process.env.PUSH_INTERVAL_MIN, 10) || 3) * 60 * 1000;
        webPush.ensureIndexes().catch((e) => console.warn('[push] index setup:', e.message));
        setTimeout(() => {
            pushNotify.runOnce().catch((e) => console.error('[push] first run:', e.message));
            setInterval(() => pushNotify.runOnce().catch((e) => console.error('[push] run:', e.message)), pushIntervalMs);
            // Hive's own notifications (replies, mentions, follows…). Separate
            // interval: this one costs a Hive call per subscriber, so it runs
            // less often than the upload check, which is two indexed finds.
            const hiveIntervalMs = Math.max(1, parseInt(process.env.PUSH_HIVE_INTERVAL_MIN, 10) || 5) * 60 * 1000;
            pushHive.runOnce().catch((e) => console.error('[push] hive first run:', e.message));
            setInterval(() => pushHive.runOnce().catch((e) => console.error('[push] hive run:', e.message)), hiveIntervalMs);
        }, 90 * 1000);   // after boot, so it never competes with the first feed requests
        console.log(`Push notifications scheduled every ${pushIntervalMs / 60000} min`);
    } else {
        console.log('Push notifications disabled (no VAPID keys)');
    }

    // Ad inventory forecast. Reads only aggregate watch data and writes one cached
    // document; cheap enough to run on the main thread, unlike the retention worker.
    if (AD_INVENTORY_ENABLED) {
        const adIntervalMs = Math.max(1, AD_INVENTORY_INTERVAL_H) * 60 * 60 * 1000;
        setTimeout(() => {
            adInventory.runOnce();
            setInterval(() => adInventory.runOnce(), adIntervalMs);
        }, 2 * 60 * 1000);   // 2 min after boot, so it never competes with the first feed requests
        console.log(`Ad inventory forecast scheduled every ${AD_INVENTORY_INTERVAL_H}h (first run in 2 min)`);
    } else {
        console.log('Ad inventory forecast disabled (AD_INVENTORY_ENABLED=false)');
    }

    adPayouts.schedule();
    adCreativeSync.schedule();

    // Discover pool: union recent + a fresh random slice of the transcription-tagged
    // back catalogue + still-watched videos, precomputing each one's base score.
    scheduleDiscover();

    // Comment counts: fetch top-level comment counts (Hive) for recent videos and
    // stamp them into video-comment-counts, so the feeds can apply a comment boost
    // cheaply. In-process (network I/O, not CPU) — see services/commentCounts.js.
    scheduleCommentCounts();

    // Feed card stats (payout/votes/comments): drain the lazily-built refresh queue
    // from Hive into `video-stats`. Populated by what the feeds actually serve —
    // see services/videoStats.js. No-op unless VIDEO_STATS_ENABLED.
    scheduleVideoStats();

    app.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
        console.log(`Health check: http://localhost:${PORT}`);
        console.log(`Check user: http://localhost:${PORT}/check/{username}`);
    });
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down gracefully...');
    process.exit(0);
});

startServer().catch(console.error);
