const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');
const { nsfwFilterTags, nsfwFilterHiveTags } = require('../utils/filters');
const { HIDDEN_AUTHORS, TRENDING_CANDIDATE_LIMIT, TRENDING_VIEWS_WEIGHT, TRENDING_VOTES_WEIGHT, TRENDING_COMMENTS_WEIGHT, TRENDING_REWARD_WEIGHT, TRENDING_RESHARE_WEIGHT, RESHARE_WEIGHT } = require('../utils/config');
const { fetchHiveRewards, fetchLivePageData } = require('../utils/hive');

// Endpoint to get recommended feed
router.get('/recommended', async (req, res) => {
    try {
        const db = getDb();
        // Extract pagination parameters
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
        const skip = (page - 1) * limit;

        const videosCollection = db.collection('videos');

        // Query for recommended videos
        const query = {
            recommended: true,
            status: 'published',
            owner: { $nin: HIDDEN_AUTHORS },
            ...nsfwFilterTags(req)
        };

        // Get total count for pagination
        const total = await videosCollection.countDocuments(query);
        const totalPages = Math.ceil(total / limit);

        // Fetch videos with pagination, sorted by created descending (newest first)
        const videos = await videosCollection
            .find(query)
            .sort({ created: -1 })
            .skip(skip)
            .limit(limit)
            .toArray();

        // Return response
        res.json({
            success: true,
            feed: 'recommended',
            page: page,
            limit: limit,
            total: total,
            totalPages: totalPages,
            videos: videos
        });

    } catch (error) {
        console.error('Error fetching recommended feed:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Endpoint to get currently-promoted videos (promotedUntil in the future).
// Powers the home "Promoted" section (logged-in) and is mixed into Home Feed
// for logged-out viewers. Sorted by soonest-expiring first so freshly-paid
// promotions rotate through. NSFW/banned/listed filters still apply.
router.get('/promoted', async (req, res) => {
    try {
        const db = getDb();
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 50);
        const embedVideoCollection = db.collection('embed-video');
        const now = new Date();

        const embedVideosRaw = await embedVideoCollection.find({
            status: 'published',
            short: false,
            listed_on_3speak: true,
            promotedUntil: { $gt: now },
            hive_author: { $nin: [null, ...HIDDEN_AUTHORS] },
            hive_permlink: { $ne: null },
            ...nsfwFilterHiveTags(req)
        }).sort({ promotedUntil: 1 }).limit(limit).toArray();

        const videos = embedVideosRaw.map(ev => ({
            owner: ev.owner,
            author: ev.hive_author,
            permlink: ev.hive_permlink,
            title: ev.hive_title || ev.originalFilename || '',
            body: ev.hive_body || '',
            status: 'published',
            created: ev.createdAt,
            created_at: ev.createdAt,
            duration: ev.duration || 0,
            tags: ev.hive_tags || [],
            tags_v2: (ev.hive_tags || []).map(t => t.toLowerCase()),
            images: {
                thumbnail: ev.thumbnail_url || `https://img.3speak.tv/${ev.permlink}/thumbnail.png`,
                poster: ev.thumbnail_url || `https://img.3speak.tv/${ev.permlink}/poster.jpg`
            },
            spkvideo: {
                duration: ev.duration || 0,
                video_v2: ev.permlink,
                play_url: ev.manifest_cid ? `https://ipfs.3speak.tv/ipfs/${ev.manifest_cid}` : null
            },
            promoted: true,
            promotedUntil: ev.promotedUntil,
        }));

        res.json({ success: true, feed: 'promoted', limit, total: videos.length, videos });
    } catch (error) {
        console.error('Error fetching promoted feed:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Endpoint to get new content feed (excludes first uploads)
router.get('/new', async (req, res) => {
    try {
        const db = getDb();
        // Extract pagination parameters
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
        const skip = (page - 1) * limit;

        const videosCollection = db.collection('videos');
        const embedVideoCollection = db.collection('embed-video');

        // Query for new content (exclude first uploads and trending)
        const query = {
            status: 'published',
            owner: { $nin: HIDDEN_AUTHORS },
            firstUpload: { $ne: true },
            trending: { $ne: true },
            publishFailed: { $ne: true },
            ...nsfwFilterTags(req)
        };

        // Fetch legacy and embed videos in parallel
        const [legacyVideos, embedVideosRaw] = await Promise.all([
            videosCollection.find(query).sort({ created: -1 }).limit(limit + skip).toArray(),
            embedVideoCollection.find({
                status: 'published',
                short: false,
                listed_on_3speak: true,
                hive_author: { $nin: [null, ...HIDDEN_AUTHORS] },
                hive_permlink: { $ne: null },
                ...nsfwFilterHiveTags(req)
            }).sort({ createdAt: -1 }).limit(limit + skip).toArray()
        ]);

        // Transform embed videos to match legacy format
        const embedVideos = embedVideosRaw.map(ev => ({
            owner: ev.owner,
            author: ev.hive_author,
            permlink: ev.hive_permlink,
            title: ev.hive_title || ev.originalFilename || '',
            body: ev.hive_body || '',
            status: 'published',
            created: ev.createdAt,
            created_at: ev.createdAt,
            duration: ev.duration || 0,
            tags: ev.hive_tags || [],
            tags_v2: (ev.hive_tags || []).map(t => t.toLowerCase()),
            images: {
                thumbnail: ev.thumbnail_url || `https://img.3speak.tv/${ev.permlink}/thumbnail.png`,
                poster: ev.thumbnail_url || `https://img.3speak.tv/${ev.permlink}/poster.jpg`
            },
            spkvideo: {
                duration: ev.duration || 0,
                video_v2: ev.permlink,
                play_url: ev.manifest_cid ? `https://ipfs.3speak.tv/ipfs/${ev.manifest_cid}` : null
            },
            _source: 'embed',
            _sortDate: new Date(ev.createdAt || 0).getTime()
        }));

        // Add sort dates to legacy videos
        const legacyWithDate = legacyVideos.map(v => ({
            ...v,
            _sortDate: new Date(v.created || v.created_at || 0).getTime()
        }));

        // Deduplicate: remove embed videos that already exist in legacy
        const legacyKeys = new Set(legacyWithDate.map(v => `${v.author || v.owner}/${v.permlink}`));
        const uniqueEmbed = embedVideos.filter(ev => !legacyKeys.has(`${ev.author}/${ev.permlink}`));

        // Merge and sort by date descending
        const allVideos = [...legacyWithDate, ...uniqueEmbed];
        allVideos.sort((a, b) => b._sortDate - a._sortDate);

        const total = allVideos.length;
        const totalPages = Math.ceil(total / limit);
        const videos = allVideos.slice(skip, skip + limit);

        // Clean up internal fields
        videos.forEach(v => { delete v._sortDate; delete v._source; });

        // Return response
        res.json({
            success: true,
            feed: 'new',
            page: page,
            limit: limit,
            total: total,
            totalPages: totalPages,
            videos: videos
        });

    } catch (error) {
        console.error('Error fetching new content feed:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Endpoint to get trending feed
router.get('/trending', async (req, res) => {
    try {
        const db = getDb();
        // Extract pagination parameters
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
        const skip = (page - 1) * limit;

        const videosCollection = db.collection('videos');

        // Query for trending videos
        const query = {
            trending: true,
            status: 'published',
            owner: { $nin: HIDDEN_AUTHORS },
            ...nsfwFilterTags(req)
        };

        // Get total count for pagination
        const total = await videosCollection.countDocuments(query);
        const totalPages = Math.ceil(total / limit);

        // Fetch videos with pagination, sorted by created descending
        const videos = await videosCollection
            .find(query)
            .sort({ created: -1 })
            .skip(skip)
            .limit(limit)
            .toArray();

        // Return response
        res.json({
            success: true,
            feed: 'trending',
            page: page,
            limit: limit,
            total: total,
            totalPages: totalPages,
            videos: videos
        });

    } catch (error) {
        console.error('Error fetching trending feed:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Endpoint to get trending feed sorted by score with reshare influence
router.get('/trendingSorted', async (req, res) => {
    try {
        const db = getDb();
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
        const skip = (page - 1) * limit;

        const videosCollection = db.collection('videos');
        const embedVideoCollection = db.collection('embed-video');
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        // Fetch legacy candidate videos (without reward in base_score — reward will be fetched live from Hive)
        const [legacyCandidates, embedCandidatesRaw] = await Promise.all([
            videosCollection.aggregate([
                {
                    $match: {
                        status: 'published',
                        owner: { $nin: HIDDEN_AUTHORS },
                        publishFailed: { $ne: true },
                        created: { $gte: sevenDaysAgo },
                        ...nsfwFilterTags(req)
                    }
                },
                {
                    $addFields: {
                        base_score: {
                            $add: [
                                { $multiply: [{ $ifNull: ['$views', 0] }, TRENDING_VIEWS_WEIGHT] },
                                { $multiply: [{ $ifNull: ['$stats.num_votes', 0] }, TRENDING_VOTES_WEIGHT] },
                                { $multiply: [{ $ifNull: ['$stats.num_comments', 0] }, TRENDING_COMMENTS_WEIGHT] }
                            ]
                        }
                    }
                },
                { $sort: { base_score: -1 } },
                { $limit: TRENDING_CANDIDATE_LIMIT }
            ]).toArray(),
            // Fetch published embed videos (non-shorts) from last 7 days with Hive links
            embedVideoCollection.find({
                status: 'published',
                short: false,
                listed_on_3speak: true,
                hive_author: { $ne: null },
                hive_permlink: { $ne: null },
                createdAt: { $gte: sevenDaysAgo },
                ...nsfwFilterHiveTags(req)
            }).sort({ createdAt: -1 }).limit(TRENDING_CANDIDATE_LIMIT).toArray()
        ]);

        // Enrich legacy videos with live Hive reward data (stats.total_hive_reward in MongoDB is unreliable)
        const legacyAuthorPerms = legacyCandidates
            .filter(v => (v.author || v.owner) && v.permlink)
            .map(v => ({ author: v.author || v.owner, permlink: v.permlink }));

        // Embed candidates' Hive author/permlink (already on the doc).
        const embedAuthorPerms = embedCandidatesRaw
            .filter(ev => ev.hive_author && ev.hive_permlink)
            .map(ev => ({ author: ev.hive_author, permlink: ev.hive_permlink }));

        // Both Hive-rewards lookups can run in parallel — they don't depend
        // on each other. Combined with the inner batch parallelisation in
        // fetchHiveRewards, this is now ~1 RPC roundtrip instead of ~20.
        const [legacyHiveData, embedHiveData] = await Promise.all([
            legacyAuthorPerms.length > 0 ? fetchHiveRewards(legacyAuthorPerms) : Promise.resolve(new Map()),
            embedAuthorPerms.length > 0 ? fetchHiveRewards(embedAuthorPerms) : Promise.resolve(new Map()),
        ]);

        // Recalculate base_score for legacy videos with live reward data
        for (const video of legacyCandidates) {
            const hiveKey = `${video.author || video.owner}/${video.permlink}`;
            const hive = legacyHiveData.get(hiveKey);
            const liveReward = hive ? (hive.reward || 0) : 0;
            video.base_score = (video.base_score || 0) + liveReward * TRENDING_REWARD_WEIGHT;
        }

        // Transform embed videos into candidate format matching legacy videos
        const embedCandidates = embedCandidatesRaw
            .filter(ev => ev.hive_author && ev.hive_permlink)
            .map(ev => {
                const hiveKey = `${ev.hive_author}/${ev.hive_permlink}`;
                const hive = embedHiveData.get(hiveKey) || { reward: 0, title: '', body: '', tags: [] };
                const base_score = (ev.views || 0) * TRENDING_VIEWS_WEIGHT +
                    (hive.reward || 0) * TRENDING_REWARD_WEIGHT;
                return {
                    owner: ev.owner,
                    author: ev.hive_author,
                    permlink: ev.hive_permlink,
                    title: ev.hive_title || hive.title || '',
                    body: ev.hive_body || hive.body || '',
                    status: 'published',
                    created: ev.createdAt,
                    created_at: ev.createdAt,
                    duration: ev.duration || 0,
                    tags: ev.hive_tags || hive.tags || [],
                    images: {
                        thumbnail: ev.thumbnail_url || `https://img.3speak.tv/${ev.permlink}/thumbnail.png`,
                        poster: ev.thumbnail_url || `https://img.3speak.tv/${ev.permlink}/poster.jpg`
                    },
                    spkvideo: {
                        duration: ev.duration || 0,
                        video_v2: ev.permlink,
                        play_url: ev.manifest_cid ? `https://ipfs.3speak.tv/ipfs/${ev.manifest_cid}` : null
                    },
                    stats: {
                        total_hive_reward: hive.reward || 0,
                        num_votes: 0,
                        num_comments: 0
                    },
                    views: ev.views || 0,
                    base_score,
                    _source: 'embed',
                    _embedPermlink: ev.permlink
                };
            });

        // Deduplicate: remove embed videos that already exist in legacy (by hive author+permlink)
        const legacyKeys = new Set(legacyCandidates.map(v => `${v.author || v.owner}/${v.permlink}`));
        const uniqueEmbedCandidates = embedCandidates.filter(ev => !legacyKeys.has(`${ev.author}/${ev.permlink}`));

        // Merge all candidates
        const candidateVideos = [...legacyCandidates, ...uniqueEmbedCandidates];

        // Look up embed-video records to get Hive permlinks for reshare matching (for legacy videos)
        const embedDocs = legacyCandidates.length > 0
            ? await embedVideoCollection.find(
                { $or: legacyCandidates.map(v => ({ owner: v.owner, permlink: v.permlink })) },
                { projection: { owner: 1, permlink: 1, embed_url: 1 } }
              ).toArray()
            : [];

        // Build map: "owner/shortPermlink" -> hive permlink from embed_url
        const hivePermlinkMap = new Map();
        for (const doc of embedDocs) {
            if (doc.embed_url) {
                const parts = doc.embed_url.replace(/^@/, '').split('/');
                if (parts.length === 2) {
                    hivePermlinkMap.set(`${doc.owner}/${doc.permlink}`, { author: parts[0], permlink: parts[1] });
                }
            }
        }
        // Embed videos already have hive author/permlink directly
        for (const ev of uniqueEmbedCandidates) {
            hivePermlinkMap.set(`${ev.owner}/${ev._embedPermlink || ev.permlink}`, { author: ev.author, permlink: ev.permlink });
        }

        // Fetch reshare counts for all candidates
        const reshareCountMap = new Map();
        const reshareOrConditions = candidateVideos
            .map(v => {
                // For embed candidates, use author/permlink directly (already Hive permlinks)
                if (v._source === 'embed') return { author: v.author, permlink: v.permlink };
                return hivePermlinkMap.get(`${v.owner}/${v.permlink}`);
            })
            .filter(Boolean);

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

        // Compute final trending score including reshares
        for (const video of candidateVideos) {
            let hivePl;
            if (video._source === 'embed') {
                hivePl = { author: video.author, permlink: video.permlink };
            } else {
                hivePl = hivePermlinkMap.get(`${video.owner}/${video.permlink}`);
            }
            const reshareCount = hivePl ? (reshareCountMap.get(`${hivePl.author}/${hivePl.permlink}`) || 0) : 0;
            video.reshare_count = reshareCount;
            video.trending_score = (video.base_score || 0) + reshareCount * TRENDING_RESHARE_WEIGHT;
        }

        // Sort by final score
        candidateVideos.sort((a, b) => b.trending_score - a.trending_score);

        const total = candidateVideos.length;
        const totalPages = Math.ceil(total / limit);
        const videos = candidateVideos.slice(skip, skip + limit);

        // Clean up internal fields
        videos.forEach(v => { delete v._source; delete v._embedPermlink; });

        res.json({
            success: true,
            feed: 'trendingSorted',
            page,
            limit,
            total,
            totalPages,
            videos
        });

    } catch (error) {
        console.error('Error fetching trendingSorted feed:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Endpoint to get first uploads feed
router.get('/firstUploads', async (req, res) => {
    try {
        const db = getDb();
        // Extract pagination parameters
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
        const skip = (page - 1) * limit;

        const videosCollection = db.collection('videos');
        const embedVideoCollection = db.collection('embed-video');

        // Query for first time uploads (exclude trending)
        const query = {
            firstUpload: true,
            status: 'published',
            owner: { $nin: HIDDEN_AUTHORS },
            trending: { $ne: true },
            publishFailed: { $ne: true },
            ...nsfwFilterTags(req)
        };

        // Fetch legacy first uploads and embed videos in parallel
        const [legacyVideos, embedVideosRaw] = await Promise.all([
            videosCollection.find(query).sort({ created: -1 }).limit(limit + skip).toArray(),
            embedVideoCollection.find({
                status: 'published',
                short: false,
                listed_on_3speak: true,
                hive_author: { $ne: null },
                hive_permlink: { $ne: null },
                ...nsfwFilterHiveTags(req)
            }).sort({ createdAt: -1 }).limit(200).toArray()
        ]);

        // For embed videos, check if the owner has NO legacy videos (= first upload on 3speak)
        const embedOwners = [...new Set(embedVideosRaw.map(ev => ev.owner))];
        let ownersWithLegacy = new Set();
        let embedCountByOwner = {};
        if (embedOwners.length > 0) {
            // Check for legacy videos
            const existing = await videosCollection.distinct('owner', { owner: { $in: embedOwners } });
            ownersWithLegacy = new Set(existing);

            // Count total listed embed videos per owner (not just the ones in current query)
            const embedCounts = await embedVideoCollection.aggregate([
                { $match: { owner: { $in: embedOwners }, listed_on_3speak: true } },
                { $group: { _id: '$owner', count: { $sum: 1 } } }
            ]).toArray();
            for (const ec of embedCounts) {
                embedCountByOwner[ec._id] = ec.count;
            }
        }

        // Only include embed video if owner has NO legacy videos AND only 1 embed video total
        const firstEmbedByOwner = new Map();
        for (let i = embedVideosRaw.length - 1; i >= 0; i--) {
            const ev = embedVideosRaw[i];
            if (!ownersWithLegacy.has(ev.owner) && (embedCountByOwner[ev.owner] || 0) <= 1) {
                firstEmbedByOwner.set(ev.owner, ev);
            }
        }

        // Transform first-time embed videos
        const embedVideos = [...firstEmbedByOwner.values()].map(ev => ({
            owner: ev.owner,
            author: ev.hive_author,
            permlink: ev.hive_permlink,
            title: ev.hive_title || ev.originalFilename || '',
            body: ev.hive_body || '',
            status: 'published',
            firstUpload: true,
            created: ev.createdAt,
            created_at: ev.createdAt,
            duration: ev.duration || 0,
            tags: ev.hive_tags || [],
            tags_v2: (ev.hive_tags || []).map(t => t.toLowerCase()),
            images: {
                thumbnail: ev.thumbnail_url || `https://img.3speak.tv/${ev.permlink}/thumbnail.png`,
                poster: ev.thumbnail_url || `https://img.3speak.tv/${ev.permlink}/poster.jpg`
            },
            spkvideo: {
                duration: ev.duration || 0,
                video_v2: ev.permlink,
                play_url: ev.manifest_cid ? `https://ipfs.3speak.tv/ipfs/${ev.manifest_cid}` : null
            },
            _sortDate: new Date(ev.createdAt || 0).getTime()
        }));

        // Add sort dates to legacy videos
        const legacyWithDate = legacyVideos.map(v => ({
            ...v,
            _sortDate: new Date(v.created || v.created_at || 0).getTime()
        }));

        // Deduplicate
        const legacyKeys = new Set(legacyWithDate.map(v => `${v.author || v.owner}/${v.permlink}`));
        const uniqueEmbed = embedVideos.filter(ev => !legacyKeys.has(`${ev.author}/${ev.permlink}`));

        // Merge and sort by date descending
        const allVideos = [...legacyWithDate, ...uniqueEmbed];
        allVideos.sort((a, b) => b._sortDate - a._sortDate);

        const total = allVideos.length;
        const totalPages = Math.ceil(total / limit);
        const videos = allVideos.slice(skip, skip + limit);

        // Clean up internal fields
        videos.forEach(v => { delete v._sortDate; });

        // Return response
        res.json({
            success: true,
            feed: 'firstUploads',
            page: page,
            limit: limit,
            total: total,
            totalPages: totalPages,
            videos: videos
        });

    } catch (error) {
        console.error('Error fetching first uploads feed:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

/* ─── Community feeds ─────────────────────────────────────────────────
 * Replacements for the legacy `${LEGACY}/apiv2/feeds/community/:id/...`
 * endpoints. Same shape as /new and /trending, scoped to one community.
 *
 * `videos.community` is the community id (e.g. "hive-181335") on the legacy
 * indexer. For freshly uploaded embed videos the community id lands in
 * `hive_tags` (as the post's first tag), so we filter on that.
 * ──────────────────────────────────────────────────────────────────── */

// Translate an embed-video doc into the same shape /new / /firstUploads return.
// Mirrors the inline transform those routes already do — kept inline here too
// so it stays trivial to grep for and tweak alongside the others.
function transformEmbedVideoToLegacy(ev) {
    return {
        owner: ev.owner,
        author: ev.hive_author,
        permlink: ev.hive_permlink,
        title: ev.hive_title || ev.originalFilename || '',
        body: ev.hive_body || '',
        status: 'published',
        created: ev.createdAt,
        created_at: ev.createdAt,
        views: ev.views || 0,
        duration: ev.duration || 0,
        tags: ev.hive_tags || [],
        tags_v2: (ev.hive_tags || []).map(t => t.toLowerCase()),
        images: {
            thumbnail: ev.thumbnail_url || `https://img.3speak.tv/${ev.permlink}/thumbnail.png`,
            poster: ev.thumbnail_url || `https://img.3speak.tv/${ev.permlink}/poster.jpg`,
        },
        spkvideo: {
            duration: ev.duration || 0,
            video_v2: ev.permlink,
            play_url: ev.manifest_cid ? `https://ipfs.3speak.tv/ipfs/${ev.manifest_cid}` : null,
        },
        _source: 'embed',
        _sortDate: new Date(ev.createdAt || 0).getTime(),
    };
}

function validateCommunityId(id) {
    return /^hive-\d+$/.test(String(id || '').trim());
}

// An embed video belongs to a community when the Hive post's `category`
// (parent_permlink) is that community — persisted by embedCategorySync. Some
// posting clients also drop the community id into json_metadata tags, so we match
// either source. This goes in a `$or` (its own key) so it never collides with the
// `hive_tags: { $nin: [...] }` that nsfwFilterHiveTags() spreads in for nsfw exclusion.
function communityMatchClause(communityId) {
    return { $or: [{ category: communityId }, { hive_tags: communityId }] };
}

router.get('/community/:id/new', async (req, res) => {
    try {
        const communityId = String(req.params.id || '').trim();
        if (!validateCommunityId(communityId)) {
            return res.status(400).json({ success: false, error: 'community id must look like "hive-<digits>"' });
        }

        const db = getDb();
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
        const skip = (page - 1) * limit;

        const videosCollection = db.collection('videos');
        const embedVideoCollection = db.collection('embed-video');

        const [legacyVideos, embedVideosRaw] = await Promise.all([
            videosCollection.find({
                status: 'published',
                owner: { $nin: HIDDEN_AUTHORS },
                publishFailed: { $ne: true },
                community: communityId,
                ...nsfwFilterTags(req),
            }).sort({ created: -1 }).limit(limit + skip).toArray(),
            embedVideoCollection.find({
                status: 'published',
                short: false,
                listed_on_3speak: true,
                hive_author: { $nin: [null, ...HIDDEN_AUTHORS] },
                hive_permlink: { $ne: null },
                ...nsfwFilterHiveTags(req),
                ...communityMatchClause(communityId),
            }).sort({ createdAt: -1 }).limit(limit + skip).toArray(),
        ]);

        const embedVideos = embedVideosRaw.map(transformEmbedVideoToLegacy);
        const legacyWithDate = legacyVideos.map(v => ({
            ...v,
            _sortDate: new Date(v.created || v.created_at || 0).getTime(),
        }));

        // Dedup: drop embed entries that already exist in the legacy index.
        const legacyKeys = new Set(legacyWithDate.map(v => `${v.author || v.owner}/${v.permlink}`));
        const uniqueEmbed = embedVideos.filter(ev => !legacyKeys.has(`${ev.author}/${ev.permlink}`));

        const allVideos = [...legacyWithDate, ...uniqueEmbed].sort((a, b) => b._sortDate - a._sortDate);
        const total = allVideos.length;
        const totalPages = Math.ceil(total / limit);
        const videos = allVideos.slice(skip, skip + limit);
        videos.forEach(v => { delete v._sortDate; delete v._source; });

        res.json({
            success: true,
            feed: 'community-new',
            community: communityId,
            page, limit, total, totalPages,
            videos,
        });
    } catch (error) {
        console.error('Error fetching community new feed:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

router.get('/community/:id/trending', async (req, res) => {
    try {
        const communityId = String(req.params.id || '').trim();
        if (!validateCommunityId(communityId)) {
            return res.status(400).json({ success: false, error: 'community id must look like "hive-<digits>"' });
        }

        const db = getDb();
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
        const skip = (page - 1) * limit;

        const videosCollection = db.collection('videos');
        const embedVideoCollection = db.collection('embed-video');

        // "Trending" = most-viewed videos in the community *within a recent
        // window* (vs /new which ranks the same recent window by date). The old
        // `trending: true` flag is never set on embed videos, so an embed-based
        // community's trending row was identical to /new. Ranking by `views`
        // (present on both collections) makes it meaningful — but WITHOUT the
        // recency window it surfaced old high-view legacy videos and dropped all
        // recent content, so trending looked disconnected from new. Windowing
        // both collections keeps trending = "recently popular".
        const CANDIDATE_LIMIT = 200;
        const TRENDING_WINDOW_DAYS = 30;
        const windowStart = new Date(Date.now() - TRENDING_WINDOW_DAYS * 24 * 60 * 60 * 1000);

        const [legacyVideos, embedVideosRaw] = await Promise.all([
            videosCollection.find({
                status: 'published',
                owner: { $nin: HIDDEN_AUTHORS },
                publishFailed: { $ne: true },
                community: communityId,
                created: { $gte: windowStart },
                ...nsfwFilterTags(req),
            }).sort({ views: -1 }).limit(CANDIDATE_LIMIT).toArray(),
            embedVideoCollection.find({
                status: 'published',
                short: false,
                listed_on_3speak: true,
                hive_author: { $nin: [null, ...HIDDEN_AUTHORS] },
                hive_permlink: { $ne: null },
                createdAt: { $gte: windowStart },
                ...nsfwFilterHiveTags(req),
                ...communityMatchClause(communityId),
            }).sort({ views: -1 }).limit(CANDIDATE_LIMIT).toArray(),
        ]);

        const embedVideos = embedVideosRaw.map(transformEmbedVideoToLegacy);
        const legacyWithMeta = legacyVideos.map(v => ({
            ...v,
            views: v.views || 0,
            _views: v.views || 0,
            _sortDate: new Date(v.created || v.created_at || 0).getTime(),
        }));
        const embedWithMeta = embedVideos.map(v => ({
            ...v,
            _views: v.views || 0,
            _sortDate: new Date(v.created || v.created_at || 0).getTime(),
        }));

        const legacyKeys = new Set(legacyWithMeta.map(v => `${v.author || v.owner}/${v.permlink}`));
        const uniqueEmbed = embedWithMeta.filter(ev => !legacyKeys.has(`${ev.author}/${ev.permlink}`));

        // Rank by views desc, tie-break by recency.
        const allVideos = [...legacyWithMeta, ...uniqueEmbed].sort(
            (a, b) => (b._views - a._views) || (b._sortDate - a._sortDate)
        );
        const total = allVideos.length;
        const totalPages = Math.ceil(total / limit);
        const videos = allVideos.slice(skip, skip + limit);
        videos.forEach(v => { delete v._views; delete v._sortDate; delete v._source; });

        res.json({
            success: true,
            feed: 'community-trending',
            community: communityId,
            page, limit, total, totalPages,
            videos,
        });
    } catch (error) {
        console.error('Error fetching community trending feed:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

module.exports = router;
