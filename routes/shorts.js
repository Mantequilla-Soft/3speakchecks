const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');
const { feedAgeMatch } = require('../utils/feedAge');
const { nsfwFilterHiveTags } = require('../utils/filters');
const { HIDDEN_AUTHORS, SHORT_SORT_INTERVAL, REWARD_WEIGHT, RESHARE_WEIGHT, ENABLE_MONGO_WRITES } = require('../utils/config');
const { fetchHiveRewards, fetchLivePageData, fetchFollowerCounts, hiveReputationToScore, mulberry32, getFollowingList, reputationCache } = require('../utils/hive');
const { sortedShortsCache, SORTED_SHORTS_CACHE_TTL, getCachedViews, setCachedViews } = require('../utils/cache');
const { INTEREST_MULTIPLIER, parseInterests, fetchTranscriptionTags, normalizeTags, tagsMatchInterests } = require('../utils/interests');
const { getUserFilters, applyUserFilters } = require('../utils/userFilters');
const { wantsHideWatched } = require('../utils/feedRank');
const { getWinners } = require('../utils/effectiveTags');
const { applyRetention } = require('../utils/retentionRank');

// Endpoint to get shorts feed (original)
router.get('/shorts', async (req, res) => {
    try {
        const db = getDb();
        // Extract pagination parameters
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
        const skip = (page - 1) * limit;
        const appFilter = req.query.app; // optional frontend_app filter

        // Query the embed-video collection
        const embedVideoCollection = db.collection('embed-video');

        // Build query for published shorts from last 7 days
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const query = {
            short: true,
            status: 'published',
            processed: true,
            listed_on_3speak: { $ne: false }, // hide unlisted shorts (matches the video feeds)
            embed_url: { $exists: true, $ne: null },
            createdAt: { $gte: sevenDaysAgo },
            owner: { $nin: HIDDEN_AUTHORS },
            ...nsfwFilterHiveTags(req)
        };

        // Add optional app filter
        if (appFilter) {
            query.frontend_app = appFilter;
            console.log(`Fetching shorts for app: ${appFilter}`);
        }

        // Fetch recent shorts (last 7 days) sorted by newest first
        const shortsData = await embedVideoCollection
            .find(query)
            .sort({ createdAt: -1 })
            .toArray();

        // Deduplicate: Keep only the most recent short for each user+thumbnail combination
        const seenVideos = new Map();
        const deduplicatedShorts = [];

        for (const short of shortsData) {
            const dedupeKey = `${short.owner}|${short.thumbnail_url || 'no-thumb'}`;
            if (!seenVideos.has(dedupeKey) || !short.thumbnail_url) {
                seenVideos.set(dedupeKey, short);
                deduplicatedShorts.push(short);
            }
        }

        // Randomize the order using Fisher-Yates shuffle
        for (let i = deduplicatedShorts.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [deduplicatedShorts[i], deduplicatedShorts[j]] = [deduplicatedShorts[j], deduplicatedShorts[i]];
        }

        // Apply pagination to randomized results
        const paginatedShorts = deduplicatedShorts.slice(skip, skip + limit);

        // Get view counts with caching
        const shorts = await Promise.all(
            paginatedShorts.map(async (short) => {
                const key = `${short.owner}/${short.permlink}`;
                let views = getCachedViews(key);
                if (views === null) {
                    views = short.views ?? 0;
                    setCachedViews(key, views);
                }
                return {
                    owner: short.owner,
                    permlink: short.permlink,
                    frontend_app: short.frontend_app,
                    views: views,
                    createdAt: short.createdAt,
                    thumbnail_url: short.thumbnail_url,
                    embed_url: short.embed_url,
                    embed_title: short.embed_title,
                    // false only when explicitly unlisted; lets the owner's profile badge it.
                    listed_on_3speak: short.listed_on_3speak !== false,
                    unlisted: short.listed_on_3speak === false
                };
            })
        );

        const total = deduplicatedShorts.length;
        const totalPages = Math.ceil(total / limit);

        res.json({
            success: true,
            page: page,
            limit: limit,
            total: total,
            totalPages: totalPages,
            app: appFilter || 'all',
            shorts: shorts
        });

    } catch (error) {
        console.error('Error fetching shorts:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Endpoint to get shorts "stories" — creators with unseen shorts in the past 7 days, grouped by creator
// Returns a list of creators with their unseen short count, plus whether the current user posted a short recently
router.get('/shorts/stories', async (req, res) => {
    try {
        const db = getDb();
        const currentuser = req.query.currentuser; // optional: logged-in user
        const appFilter = req.query.app; // optional frontend_app filter

        const embedVideoCollection = db.collection('embed-video');

        // Fetch published shorts from last 7 days
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const query = {
            short: true,
            status: 'published',
            processed: true,
            listed_on_3speak: { $ne: false }, // hide unlisted shorts (matches the video feeds)
            embed_url: { $exists: true, $ne: null },
            createdAt: { $gte: sevenDaysAgo },
            owner: { $nin: HIDDEN_AUTHORS },
            ...nsfwFilterHiveTags(req)
        };

        if (appFilter) {
            query.frontend_app = appFilter;
        }

        const shortsData = await embedVideoCollection
            .find(query)
            .sort({ createdAt: -1 })
            .toArray();

        // Deduplicate: keep only the most recent short per owner+thumbnail
        const seenVideos = new Map();
        const deduplicatedShorts = [];
        for (const short of shortsData) {
            const dedupeKey = `${short.owner}|${short.thumbnail_url || 'no-thumb'}`;
            if (!seenVideos.has(dedupeKey) || !short.thumbnail_url) {
                seenVideos.set(dedupeKey, short);
                deduplicatedShorts.push(short);
            }
        }

        // Filter out low-reputation authors (reuse cached reputation data)
        const filteredShorts = deduplicatedShorts.filter(short => {
            if (short.embed_url) {
                const parts = short.embed_url.replace(/^@/, '').split('/');
                const cachedRep = reputationCache.get(parts[0]);
                if (cachedRep && cachedRep.reputation <= 15) return false;
            }
            return true;
        });

        const getHivePermlink = (s) => {
            if (s.embed_url) {
                const parts = s.embed_url.replace(/^@/, '').split('/');
                if (parts.length === 2) return parts[1];
            }
            return s.permlink;
        };

        // Drop dismissed shorts / dismissed creators — ALWAYS, they aren't a toggle.
        let unwatchedShorts = filteredShorts;
        if (currentuser) {
            const uf = await getUserFilters(db, currentuser);
            unwatchedShorts = applyUserFilters(unwatchedShorts, uf,
                (s) => ({ owner: s.owner, permlink: getHivePermlink(s) }));
        }

        // Then hide already-watched, but ONLY when that preference is on. The
        // frontend now always sends ?currentuser= (so dismissals apply), so this
        // must key off ?hidewatched= rather than the mere presence of currentuser.
        if (currentuser && wantsHideWatched(req)) {
            const watchHistoryCollection = db.collection('watch_history');
            const idsToCheck = unwatchedShorts.map(s => `${currentuser}:${s.owner}:${getHivePermlink(s)}`);
            const watchedEntries = await watchHistoryCollection
                .find({ _id: { $in: idsToCheck } }, { projection: { _id: 1 } })
                .toArray();
            const watchedSet = new Set(watchedEntries.map(w => w._id));
            unwatchedShorts = unwatchedShorts.filter(s => !watchedSet.has(`${currentuser}:${s.owner}:${getHivePermlink(s)}`));
        }

        // Group by creator and count unseen shorts
        const creatorMap = new Map();
        for (const short of unwatchedShorts) {
            if (!creatorMap.has(short.owner)) {
                creatorMap.set(short.owner, { username: short.owner, unseen_count: 0 });
            }
            creatorMap.get(short.owner).unseen_count++;
        }

        // Sort creators by unseen_count descending
        const creators = [...creatorMap.values()].sort((a, b) => b.unseen_count - a.unseen_count);

        // Check if currentuser has posted a short in the last 7 days + get following list
        let currentUserHasShort = false;
        if (currentuser) {
            const [userShort, followingList] = await Promise.all([
                embedVideoCollection.findOne({
                    short: true,
                    status: 'published',
                    owner: currentuser,
                    createdAt: { $gte: sevenDaysAgo }
                }),
                getFollowingList(currentuser)
            ]);
            currentUserHasShort = !!userShort;

            // Mark each creator with followed status
            const followingSet = new Set(followingList || []);
            for (const creator of creators) {
                creator.followed = followingSet.has(creator.username);
            }
        }

        res.json({
            success: true,
            currentUserHasShort,
            creators
        });

    } catch (error) {
        console.error('Error fetching shorts stories:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Endpoint to get all shorts by a specific user, sorted by date descending
// Same response shape as /shortssorted but no weighted scoring, no time window, no dedup
router.get('/shorts/:username', async (req, res) => {
    try {
        const db = getDb();
        const { username } = req.params;
        if (!username || username.length < 1 || username.length > 50) {
            return res.status(400).json({ success: false, error: 'Invalid username' });
        }

        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
        const skip = (page - 1) * limit;

        const embedVideoCollection = db.collection('embed-video');

        // On the owner's own profile the client passes include_unlisted so their
        // unlisted shorts still appear (badged) and can be re-listed. Every other
        // surface keeps the default unlisted-hidden filter.
        const includeUnlisted = req.query.include_unlisted === '1' || req.query.include_unlisted === 'true';

        // Count total shorts for this user
        const query = {
            short: true,
            status: 'published',
            processed: true,
            embed_url: { $exists: true, $ne: null },
            owner: username,
            ...nsfwFilterHiveTags(req)
        };
        if (!includeUnlisted) {
            query.listed_on_3speak = { $ne: false }; // hide unlisted shorts (matches the video feeds)
        }

        const [total, shortsData] = await Promise.all([
            embedVideoCollection.countDocuments(query),
            embedVideoCollection
                .find(query)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .toArray()
        ]);

        const totalPages = Math.ceil(total / limit);

        if (shortsData.length === 0) {
            return res.json({
                success: true,
                page,
                limit,
                total,
                totalPages,
                shorts: []
            });
        }

        // Extract author/permlink pairs from embed_url
        const authorPerms = shortsData
            .filter(s => s.embed_url)
            .map(s => {
                const parts = s.embed_url.replace(/^@/, '').split('/');
                return { author: parts[0], permlink: parts[1] };
            });

        // Fetch Hive rewards (for title, body, tags) and live data + followers in parallel
        const uniqueAuthors = [...new Set(authorPerms.map(ap => ap.author))];
        const [hiveRewards, liveData, followerCounts] = await Promise.all([
            fetchHiveRewards(authorPerms),
            fetchLivePageData(authorPerms),
            fetchFollowerCounts(uniqueAuthors)
        ]);

        // Assemble response
        const shorts = await Promise.all(
            shortsData.map(async (short) => {
                const viewKey = `${short.owner}/${short.permlink}`;
                let views = getCachedViews(viewKey);
                if (views === null) {
                    views = short.views ?? 0;
                    setCachedViews(viewKey, views);
                }

                const embedParts = short.embed_url ? short.embed_url.replace(/^@/, '').split('/') : null;
                const rewardData = embedParts ? (hiveRewards.get(`${embedParts[0]}/${embedParts[1]}`) || { reward: 0, title: '', body: '', tags: [] }) : { reward: 0, title: '', body: '', tags: [] };
                const live = embedParts ? (liveData.get(`${embedParts[0]}/${embedParts[1]}`) || { reward: 0, votes: 0, comments: 0, author_reputation: 25 }) : { reward: 0, votes: 0, comments: 0, author_reputation: 25 };
                const followers = embedParts ? (followerCounts.get(embedParts[0]) || 0) : 0;

                return {
                    owner: short.owner,
                    permlink: short.permlink,
                    frontend_app: short.frontend_app,
                    views: views,
                    hive_reward: live.reward || rewardData.reward,
                    hive_title: rewardData.title || short.embed_title || '',
                    hive_body: rewardData.body || '',
                    hive_tags: rewardData.tags || [],
                    hive_votes: live.votes,
                    hive_comments: live.comments,
                    hive_author_reputation: live.author_reputation,
                    hive_followers: followers,
                    createdAt: short.createdAt,
                    thumbnail_url: short.thumbnail_url,
                    embed_url: short.embed_url,
                    embed_title: short.embed_title,
                    // false only when explicitly unlisted; lets the owner's profile badge it.
                    listed_on_3speak: short.listed_on_3speak !== false,
                    unlisted: short.listed_on_3speak === false
                };
            })
        );

        res.json({
            success: true,
            page,
            limit,
            total,
            totalPages,
            shorts
        });

    } catch (error) {
        console.error('Error fetching user shorts:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Endpoint to get sorted shorts feed with reward-weighted bucket sorting
router.get('/shortssorted', async (req, res) => {
    try {
        const db = getDb();
        // Extract pagination parameters
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
        const skip = (page - 1) * limit;
        const appFilter = req.query.app; // optional frontend_app filter
        const currentuser = req.query.currentuser; // optional: filter out shorts this user already watched
        // Seed for deterministic shuffle. When the client doesn't supply one
        // we bucket by 5-minute window — same seed for everyone inside the
        // window so the sorted-list cache actually hits (was a fresh random
        // per request → cache miss every call, the full pipeline re-ran).
        const SEED_BUCKET_MS = 5 * 60 * 1000;
        const seed = req.query.seed
            ? parseInt(req.query.seed)
            : Math.floor(Date.now() / SEED_BUCKET_MS);

        // Interest weighting inputs. The token goes into the cache key so each
        // distinct interest set gets its own cached ordering (and no-interest
        // callers keep the legacy 'none' ordering — backwards compatible).
        const interestSet = parseInterests(req);
        const interestsToken = interestSet.size ? [...interestSet].sort().join(',') : 'none';

        // "My interests" feed (?onlyinterests=1): HARD-filter to shorts whose winning
        // topic is one of the caller's interests, instead of merely boosting them the
        // way Discover does. Retention still re-ranks whatever survives the filter.
        // With no interests supplied there's nothing to filter on, so it's a no-op.
        const onlyInterests = req.query.onlyinterests === '1' || req.query.onlyinterests === 'true';

        const getHivePermlink = (s) => {
            if (s.embed_url) {
                const parts = s.embed_url.replace(/^@/, '').split('/');
                if (parts.length === 2) return parts[1];
            }
            return s.permlink;
        };
        const hideWatched = !!currentuser && wantsHideWatched(req);

        // Check sorted list cache. Keyed by seed+app+interests+mode, PLUS the user and
        // the hide-watched flag — because the already-watched filter is now baked INTO
        // the cached list (see below), so one user's list must never be served to
        // another. The client's seed is stable for their session, so this is one entry
        // per user-session, not per request.
        const cacheKey = [
            seed,
            appFilter || 'all',
            interestsToken,
            onlyInterests ? 'only' : 'boost',
            hideWatched ? `hw:${currentuser}` : 'all',
        ].join('|');
        let sortedShorts;
        const cached = sortedShortsCache.get(cacheKey);

        if (cached && Date.now() - cached.timestamp < SORTED_SHORTS_CACHE_TTL) {
            sortedShorts = cached.list;
        } else {
            // Full pipeline: MongoDB query → dedup → rewards → filter → score → sort

            // Query the embed-video collection
            const embedVideoCollection = db.collection('embed-video');

            // Build query for published shorts from last 14 days
            const fourteenDaysAgo = new Date();
            fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

            const query = {
                short: true,
                status: 'published',
                processed: true,
                listed_on_3speak: { $ne: false }, // hide unlisted shorts (matches the video feeds)
                embed_url: { $exists: true, $ne: null },
                createdAt: { $gte: fourteenDaysAgo },
                owner: { $nin: HIDDEN_AUTHORS },
                ...nsfwFilterHiveTags(req)
            };

            // Add optional app filter
            if (appFilter) {
                query.frontend_app = appFilter;
                console.log(`Fetching sorted shorts for app: ${appFilter}`);
            }

            // Fetch recent shorts sorted by newest first
            const shortsData = await embedVideoCollection
                .find(query)
                .sort({ createdAt: -1 })
                .toArray();

            // Deduplicate: Keep only the most recent short for each user+thumbnail combination
            const seenVideos = new Map();
            const deduplicatedShorts = [];

            for (const short of shortsData) {
                const dedupeKey = `${short.owner}|${short.thumbnail_url || 'no-thumb'}`;
                if (!seenVideos.has(dedupeKey) || !short.thumbnail_url) {
                    seenVideos.set(dedupeKey, short);
                    deduplicatedShorts.push(short);
                }
            }

            // Fetch Hive content data via RPC (extract author/permlink from embed_url "@author/permlink")
            const authorPerms = deduplicatedShorts
                .filter(s => s.embed_url)
                .map(s => {
                    const parts = s.embed_url.replace(/^@/, '').split('/');
                    return { author: parts[0], permlink: parts[1] };
                });
            // Fetch reward values for sorting (cached 15min)
            const hiveRewards = await fetchHiveRewards(authorPerms);

            // Attach reward + content data to each short and filter out low-reputation authors
            const filteredShorts = [];
            for (const short of deduplicatedShorts) {
                if (short.embed_url) {
                    const parts = short.embed_url.replace(/^@/, '').split('/');
                    const hiveData = hiveRewards.get(`${parts[0]}/${parts[1]}`) || { reward: 0, title: '', body: '', tags: [] };
                    short.hive_reward = hiveData.reward;
                    short.hive_title = hiveData.title;
                    short.hive_body = hiveData.body;
                    short.hive_tags = hiveData.tags;
                    // Filter out authors with reputation <= 15 (spam/low-quality)
                    const cachedRep = reputationCache.get(parts[0]);
                    if (cachedRep && cachedRep.reputation <= 15) continue;
                } else {
                    short.hive_reward = 0;
                    short.hive_title = '';
                    short.hive_body = '';
                    short.hive_tags = [];
                }
                filteredShorts.push(short);
            }

            // Fetch reshare counts for all filtered shorts in one aggregation query
            const reshareCountMap = new Map();
            const reshareOrConditions = filteredShorts
                .filter(s => s.embed_url)
                .map(s => {
                    const parts = s.embed_url.replace(/^@/, '').split('/');
                    return { author: parts[0], permlink: parts[1] };
                });

            if (reshareOrConditions.length > 0) {
                const resharesCollection = db.collection('reshares');
                const reshareCounts = await resharesCollection.aggregate([
                    { $match: { $or: reshareOrConditions } },
                    { $group: { _id: { author: "$author", permlink: "$permlink" }, count: { $sum: 1 } } }
                ]).toArray();
                for (const rc of reshareCounts) {
                    reshareCountMap.set(`${rc._id.author}/${rc._id.permlink}`, rc.count);
                }
            }

            // Attach reshare counts to shorts
            for (const short of filteredShorts) {
                if (short.embed_url) {
                    const parts = short.embed_url.replace(/^@/, '').split('/');
                    short.reshare_count = reshareCountMap.get(`${parts[0]}/${parts[1]}`) || 0;
                } else {
                    short.reshare_count = 0;
                }
            }

            // Weighted random score sorting
            // sort_score = recencyBonus + reward * REWARD_WEIGHT + reshares * RESHARE_WEIGHT + random * remainder
            const rng = mulberry32(seed);
            const now = new Date();
            const intervalMs = SHORT_SORT_INTERVAL * 24 * 60 * 60 * 1000;
            const randomWeight = Math.max(0, 1 - REWARD_WEIGHT - RESHARE_WEIGHT);

            // Find max reward and max reshares for normalization
            const maxReward = Math.max(...filteredShorts.map(s => s.hive_reward || 0), 0.001);
            const maxReshares = Math.max(...filteredShorts.map(s => s.reshare_count || 0), 1);

            // Interest weighting (WINNER-ONLY): resolve each short's single winning
            // topic (viewer votes + auto tags) so we can boost shorts whose winner
            // matches the caller's interests.
            let shortWinners = new Map();
            if (interestSet.size) {
                const autoKey = (s) => ({ author: s.owner, permlink: s.permlink });
                const hiveKey = (s) => {
                    let hp = s.permlink;
                    if (s.embed_url) {
                        const parts = s.embed_url.replace(/^@/, '').split('/');
                        if (parts.length === 2) hp = parts[1];
                    }
                    return { author: s.owner, permlink: hp };
                };
                shortWinners = await getWinners(db, filteredShorts, autoKey, hiveKey);
            }

            // "My interests" mode: keep ONLY shorts whose winning topic is an interest.
            // (Discover keeps everything and merely multiplies matches by
            // INTEREST_MULTIPLIER below.) A short with no resolved winning topic can't
            // be matched to an interest, so it is excluded here by design.
            let candidateShorts = filteredShorts;
            if (onlyInterests && interestSet.size) {
                candidateShorts = filteredShorts.filter((s) => {
                    const winner = shortWinners.get(s);
                    return !!winner && interestSet.has(winner);
                });
            }

            // Assign weighted sort scores
            for (const short of candidateShorts) {
                const normalizedReward = (short.hive_reward || 0) / maxReward;
                const normalizedReshares = (short.reshare_count || 0) / maxReshares;
                const randomComponent = rng();
                // Time bucket bonus: 4 recent buckets (0-8 days) + 1 big bucket (8-14 days)
                const age = now - new Date(short.createdAt);
                const recentBuckets = Math.ceil(8 / SHORT_SORT_INTERVAL); // 4 buckets for first 8 days
                const totalBuckets = recentBuckets + 1; // +1 for the big older bucket
                let bucketIndex = Math.floor(age / intervalMs);
                if (bucketIndex >= recentBuckets) bucketIndex = recentBuckets; // collapse everything 8+ days into one bucket
                const recencyBonus = (totalBuckets - bucketIndex) / totalBuckets; // 1.0 for newest, decreasing

                short.sort_score = recencyBonus + normalizedReward * REWARD_WEIGHT + normalizedReshares * RESHARE_WEIGHT + randomComponent * randomWeight;

                // Boost shorts whose single winning topic matches the interests.
                if (interestSet.size) {
                    const winner = shortWinners.get(short);
                    if (winner) short.winner_tag = winner;
                    if (winner && interestSet.has(winner)) short.sort_score *= INTEREST_MULTIPLIER;
                }
            }

            // Retention re-rank (bounded multiplier from the cached video-retention;
            // shorts key by owner/permlink = the asset id, same as view-durations).
            await applyRetention(db, candidateShorts, { scoreField: 'sort_score' });

            // Sort by score descending
            const scoreSorted = [...candidateShorts].sort((a, b) => b.sort_score - a.sort_score);

            // Remove consecutive shorts by the same author (keep first, skip until a different author appears)
            sortedShorts = [];
            let lastOwner = null;
            for (const short of scoreSorted) {
                if (short.owner !== lastOwner) {
                    // Store identifiers + content data for the cache
                    sortedShorts.push({
                        owner: short.owner,
                        permlink: short.permlink,
                        embed_url: short.embed_url,
                        thumbnail_url: short.thumbnail_url,
                        embed_title: short.embed_title,
                        frontend_app: short.frontend_app,
                        createdAt: short.createdAt,
                        views: short.views,
                        hive_title: short.hive_title || '',
                        hive_body: short.hive_body || '',
                        hive_tags: short.hive_tags || [],
                        reshare_count: short.reshare_count || 0
                    });
                    lastOwner = short.owner;
                }
            }

            // FREEZE the already-watched filter into the cached list.
            //
            // This must NOT be re-evaluated per request. The user watches shorts AS
            // they swipe, so a live filter shrinks the list underneath them: page 2 is
            // fetched with skip=(page-1)*limit against a list that is now shorter, so
            // it lands PAST shorts they never saw. The feed "jumps over" one, and
            // swiping back shows that skipped short instead of the real previous one.
            //
            // Frozen here, the list a user pages through stays put for their session
            // (the cache key includes the user and their seed, which is now stable per
            // page load): shorts watched in EARLIER sessions stay hidden, while ones
            // watched right now keep their slot — so swiping back works.
            if (hideWatched) {
                const watchHistoryCollection = db.collection('watch_history');
                const idsToCheck = sortedShorts.map(s => `${currentuser}:${s.owner}:${getHivePermlink(s)}`);
                const watchedEntries = await watchHistoryCollection
                    .find({ _id: { $in: idsToCheck } }, { projection: { _id: 1 } })
                    .toArray();
                const watchedSet = new Set(watchedEntries.map(w => w._id));
                sortedShorts = sortedShorts.filter(
                    (s) => !watchedSet.has(`${currentuser}:${s.owner}:${getHivePermlink(s)}`)
                );
            }

            // Cache the sorted list (evict expired entries if cache grows too large)
            if (sortedShortsCache.size >= 100) {
                const now = Date.now();
                for (const [k, v] of sortedShortsCache) {
                    if (now - v.timestamp >= SORTED_SHORTS_CACHE_TTL) sortedShortsCache.delete(k);
                }
            }
            sortedShortsCache.set(cacheKey, { list: sortedShorts, timestamp: Date.now() });
        }

        // Dismissed shorts / dismissed creators stay LIVE (not frozen): they're an
        // explicit user action and should take effect immediately. Unlike the watched
        // filter they don't change while the user is scrolling, so they remove the same
        // items from every page — a constant offset, not drift.
        if (currentuser) {
            const uf = await getUserFilters(db, currentuser);
            sortedShorts = applyUserFilters(sortedShorts, uf,
                (s) => ({ owner: s.owner, permlink: getHivePermlink(s) }));
        }

        // Apply pagination to sorted results
        const paginatedShorts = sortedShorts.slice(skip, skip + limit);

        // Fetch all display data for this page only (live from RPC, no post-level cache)
        const pageAuthorPerms = paginatedShorts
            .filter(s => s.embed_url)
            .map(s => {
                const parts = s.embed_url.replace(/^@/, '').split('/');
                return { author: parts[0], permlink: parts[1] };
            });
        const pageUniqueAuthors = [...new Set(pageAuthorPerms.map(ap => ap.author))];
        const [liveData, followerCounts] = await Promise.all([
            fetchLivePageData(pageAuthorPerms),
            fetchFollowerCounts(pageUniqueAuthors)
        ]);

        // Get view counts with caching
        const shorts = await Promise.all(
            paginatedShorts.map(async (short) => {
                const key = `${short.owner}/${short.permlink}`;
                let views = getCachedViews(key);
                if (views === null) {
                    views = short.views ?? 0;
                    setCachedViews(key, views);
                }
                const embedParts = short.embed_url ? short.embed_url.replace(/^@/, '').split('/') : null;
                const data = embedParts ? (liveData.get(`${embedParts[0]}/${embedParts[1]}`) || { reward: 0, votes: 0, comments: 0, author_reputation: 25 }) : { reward: 0, votes: 0, comments: 0, author_reputation: 25 };
                const followers = embedParts ? (followerCounts.get(embedParts[0]) || 0) : 0;
                return {
                    owner: short.owner,
                    permlink: short.permlink,
                    frontend_app: short.frontend_app,
                    views: views,
                    hive_reward: data.reward,
                    hive_title: short.hive_title || '',
                    hive_body: short.hive_body || '',
                    hive_tags: short.hive_tags || [],
                    hive_votes: data.votes,
                    hive_comments: data.comments,
                    hive_author_reputation: data.author_reputation,
                    hive_followers: followers,
                    reshare_count: short.reshare_count || 0,
                    createdAt: short.createdAt,
                    thumbnail_url: short.thumbnail_url,
                    embed_url: short.embed_url,
                    embed_title: short.embed_title,
                    // false only when explicitly unlisted; lets the owner's profile badge it.
                    listed_on_3speak: short.listed_on_3speak !== false,
                    unlisted: short.listed_on_3speak === false
                };
            })
        );

        const total = sortedShorts.length;
        const totalPages = Math.ceil(total / limit);

        // Return response
        res.json({
            success: true,
            seed: seed,
            page: page,
            limit: limit,
            total: total,
            totalPages: totalPages,
            app: appFilter || 'all',
            shorts: shorts
        });

    } catch (error) {
        console.error('Error fetching sorted shorts:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

module.exports = router;
