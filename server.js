const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const { PORT, TRENDING_INTERVAL_MIN, COMMUNITY_SYNC_DELAY_H, COMMUNITY_SYNC_INTERVAL_H, PROFILE_SYNC_DELAY_H, PROFILE_SYNC_INTERVAL_H } = require('./utils/config');
const { connectToMongo } = require('./utils/db');
const { calculateAndFlagTrendingVideos } = require('./services/trending');
const { syncHiveCommunities } = require('./services/communitySync');
const { syncHiveProfiles } = require('./services/profileSync');
const { denormalizeCommunityTitles } = require('./services/communityDenorm');
const { startTagSyncWatcher } = require('./services/tagSync');
const { syncAudioHiveLinks } = require('./services/audioHiveSync');
const { syncEmbedCategories } = require('./services/embedCategorySync');
const { syncPremiumFromSubs } = require('./services/premiumSubsSync');
const { schedule: scheduleCollectSubs } = require('./services/collectSubscriptions');
const { schedule: scheduleAudioPayouts } = require('./services/audioPayouts');
const { schedule: scheduleListenConsolidation } = require('./services/listenConsolidation');
const { schedule: scheduleScheduledPosts } = require('./services/scheduledPosts');
const { schedule: scheduleWatchRetention } = require('./services/watchRetention');
const { scheduleRetention } = require('./services/retention');
const { scheduleDiscover } = require('./services/discover');

// Routes
const healthRoutes = require('./routes/health');
const searchRoutes = require('./routes/search');
const userRoutes = require('./routes/user');
const videosRoutes = require('./routes/videos');
const shortsRoutes = require('./routes/shorts');
const audioRoutes = require('./routes/audio');
const feedsRoutes = require('./routes/feeds');
const rssRoutes = require('./routes/rss');
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
app.use('/', gdprAdminRoutes);
app.use('/', userFiltersRoutes);
app.use('/', viewerTagsRoutes);
app.use('/', leaderboardRoutes);

// Track whether heavy sync tasks are running
let syncRunning = false;

// Start server
async function startServer() {
    await connectToMongo();

    // Warm the hidden-creators set on boot so the very first feed/search/watch
    // request is already filtered (the sync accessors otherwise warm lazily on the
    // first hit, leaving a sub-second fail-open window after a restart).
    require('./utils/hiddenCreators').getHiddenSet().catch(() => {});

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

    // Discover pool: union recent + a fresh random slice of the transcription-tagged
    // back catalogue + still-watched videos, precomputing each one's base score.
    scheduleDiscover();

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
