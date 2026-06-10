const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');
const { ObjectId } = require('mongodb');
const { COLLECTION_NAME } = require('../utils/config');
const { BANNED_FILTER } = require('../utils/filters');

// Read-only premium-status lookup against embed-users. Used by the
// frontend to render a Pro badge next to the user's avatar (nav, bottom
// bar, AuthorBadge under videos). Source of truth is the embed-users
// collection that the premiumSubsSync worker keeps in sync with the
// VSC subscriptions contract; manual upgrades are also honored.
router.get('/premium/:username', async (req, res) => {
    try {
        const db = getDb();
        const { username } = req.params;
        if (!username) return res.status(400).json({ premium: false, error: 'username required' });

        const user = await db
            .collection('embed-users')
            .findOne(
                { username: username.toLowerCase() },
                { projection: { username: 1, premium: 1, premium_source: 1, premium_expires_at: 1, testing_started: 1 } },
            );

        // Cache for 60s on intermediaries — premium status only changes on
        // the next subs-sync tick anyway, so longer caches just spread load.
        res.set('Cache-Control', 'public, max-age=60');
        return res.json({
            username,
            premium: !!(user && user.premium === true),
            premium_source: user?.premium_source ?? null,
            premium_expires_at: user?.premium_expires_at ?? null,
            // testing_started is sticky for life — the frontend uses it to
            // hide the "Try Pro free" button after the user's first claim.
            testing_started: user?.testing_started ?? null,
        });
    } catch (err) {
        console.error('GET /premium error:', err.message);
        return res.status(500).json({ premium: false, error: 'internal' });
    }
});

// List all currently-premium accounts (active 3Speak Pro subscribers +
// manual/trial). Powers the Pro page's subscriber ticker + popup.
router.get('/premium', async (req, res) => {
    try {
        const db = getDb();
        const limit = Math.min(parseInt(req.query.limit, 10) || 1000, 5000);
        const docs = await db
            .collection('embed-users')
            .find(
                { premium: true },
                { projection: { _id: 0, username: 1, premium_source: 1, premium_expires_at: 1 } },
            )
            .sort({ username: 1 })
            .limit(limit)
            .toArray();
        res.set('Cache-Control', 'public, max-age=60');
        return res.json({
            count: docs.length,
            subscribers: docs.map((d) => ({
                username: d.username,
                source: d.premium_source ?? null,
                expires_at: d.premium_expires_at ?? null,
            })),
        });
    } catch (err) {
        console.error('GET /premium (list) error:', err.message);
        return res.status(500).json({ count: 0, subscribers: [], error: 'internal' });
    }
});

router.get('/check/:username', async (req, res) => {
    try {
        const db = getDb();
        const { username } = req.params;

        if (!username) {
            return res.status(400).json({
                error: 'Username is required',
                canPost: false
            });
        }

        // Creator settings (banned / canUpload) live in the contentcreators
        // collection — NOT COLLECTION_NAME (which is the 'videos' collection via
        // env). Querying COLLECTION_NAME here always returned "User not found".
        const collection = db.collection('contentcreators');
        const user = await collection.findOne({ username: username });

        if (!user) {
            return res.json({
                canPost: false,
                reason: 'User not found'
            });
        }

        // Check if user can post (not banned AND can upload)
        const canPost = !user.banned && user.canUpload === true;

        res.json({
            canPost: canPost,
            username: username,
            banned: user.banned,
            canUpload: user.canUpload
        });

    } catch (error) {
        console.error('Error checking user permissions:', error);
        res.status(500).json({
            error: 'Internal server error',
            canPost: false
        });
    }
});

// Endpoint to get hive username from user ID
router.get('/gethive/:user_id', async (req, res) => {
    try {
        const db = getDb();
        const { user_id } = req.params;

        if (!user_id) {
            return res.status(400).json({
                error: 'User ID is required'
            });
        }

        // Step 1: Find user in users collection
        const usersCollection = db.collection('users');
        const user = await usersCollection.findOne({ user_id: user_id });

        if (!user) {
            return res.json('No user ID found');
        }

        if (!user.last_identity) {
            return res.json('No user ID found');
        }

        // Step 2: Find hive account using last_identity
        const hiveAccountsCollection = db.collection('hiveaccounts');

        // Make sure we're using the ObjectId correctly
        let identityId = user.last_identity;
        if (typeof identityId === 'string') {
            identityId = new ObjectId(identityId);
        }

        const hiveAccount = await hiveAccountsCollection.findOne({ _id: identityId });

        if (!hiveAccount || !hiveAccount.account) {
            return res.json('No user ID found');
        }

        // Return just the username
        res.json(hiveAccount.account);

    } catch (error) {
        console.error('Error getting hive username:', error);
        res.status(500).json('No user ID found');
    }
});

// Endpoint to get job ID from owner and permlink
router.get('/getjobid/:owner/:permlink', async (req, res) => {
    try {
        const db = getDb();
        const { owner, permlink } = req.params;

        if (!owner || !permlink) {
            return res.status(400).json({
                error: 'Owner and permlink are required'
            });
        }

        // Query the videos collection
        const videosCollection = db.collection('videos');
        const video = await videosCollection.findOne({
            owner: owner,
            permlink: permlink
        });

        if (!video) {
            return res.json({
                error: 'Video not found'
            });
        }

        if (!video.job_id) {
            return res.json({
                error: 'Video not found'
            });
        }

        // Return job ID with context
        res.json({
            jobId: video.job_id,
            owner: owner,
            permlink: permlink
        });

    } catch (error) {
        console.error('Error getting job ID:', error);
        res.status(500).json({
            error: 'Video not found'
        });
    }
});

// Endpoint to get user's videos
router.get('/api/my-videos', async (req, res) => {
    try {
        const db = getDb();
        // Extract query parameters
        const limit = Math.min(parseInt(req.query.limit) || 20, 100);
        const offset = parseInt(req.query.offset) || 0;
        const statusFilter = req.query.status || 'all';
        const username = req.query.username;

        if (!username) {
            return res.status(400).json({
                success: false,
                error: 'Username is required'
            });
        }

        // Build query for videos collection (legacy uploads)
        const videosCollection = db.collection('videos');
        const query = { owner: username, publishFailed: { $ne: true }, ...BANNED_FILTER };
        if (statusFilter !== 'all') {
            query.status = statusFilter;
        }

        // Build query for embed-video collection (embed uploads, non-shorts only)
        const embedVideoCollection = db.collection('embed-video');
        const embedQuery = { owner: username, short: false, listed_on_3speak: true, ...BANNED_FILTER };
        if (statusFilter !== 'all') {
            embedQuery.status = statusFilter;
        }

        // Fetch both in parallel
        const [videosData, embedVideosData] = await Promise.all([
            videosCollection.find(query).sort({ created: -1, _id: -1 }).toArray(),
            embedVideoCollection.find(embedQuery).sort({ createdAt: -1, _id: -1 }).toArray()
        ]);

        // Transform legacy videos
        const legacyVideos = videosData.map(video => {
            const videoId = video.permlink || video.video_id || video._id?.toString();
            return {
                video_id: videoId,
                owner: video.owner,
                author: video.author || video.owner,
                permlink: video.permlink || videoId,
                title: video.title || '',
                body: video.body || video.description || '',
                status: video.status || 'draft',
                publish_type: video.publish_type || (video.status === 'scheduled' ? 'schedule' : 'immediate'),
                publish_data: video.publish_data || (video.scheduled_at ? { scheduled_at: video.scheduled_at } : null),
                created_at: video.created || video.created_at || video.createdAt || new Date().toISOString(),
                updated_at: video.updated_at || video.updatedAt || video.created || new Date().toISOString(),
                duration: video.duration || video.spkvideo?.duration || 0,
                tags: video.tags || [],
                images: {
                    thumbnail: video.thumbnail || video.images?.thumbnail || `https://img.3speak.tv/${videoId}/thumbnail.png`,
                    poster: video.poster || video.images?.poster || `https://img.3speak.tv/${videoId}/poster.jpg`
                },
                spkvideo: {
                    duration: video.duration || video.spkvideo?.duration || 0,
                    video_v2: videoId
                },
                _sortDate: new Date(video.created || video.created_at || video.createdAt || 0).getTime()
            };
        });

        // Transform embed videos to match same format
        const embedVideos = embedVideosData
            .filter(ev => ev.hive_author && ev.hive_permlink) // only show linked ones
            .map(ev => {
                return {
                    video_id: ev.permlink,
                    owner: ev.owner,
                    author: ev.hive_author || ev.owner,
                    permlink: ev.hive_permlink || ev.permlink,
                    title: ev.hive_title || ev.originalFilename || '',
                    body: ev.hive_body || '',
                    status: ev.status === 'published' ? 'published' : ev.status === 'processing' ? 'encoding' : ev.status,
                    publish_type: 'immediate',
                    publish_data: null,
                    created_at: ev.createdAt || new Date().toISOString(),
                    updated_at: ev.updatedAt || ev.createdAt || new Date().toISOString(),
                    duration: ev.duration || 0,
                    tags: ev.hive_tags || [],
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
                };
            });

        // Merge and sort by date descending
        const allVideos = [...legacyVideos, ...embedVideos];
        allVideos.sort((a, b) => b._sortDate - a._sortDate);

        const total = allVideos.length;
        const paginatedVideos = allVideos.slice(offset, offset + limit);

        // Clean up internal sort field
        paginatedVideos.forEach(v => { delete v._sortDate; delete v._source; });

        // Return response
        res.json({
            success: true,
            data: {
                total,
                limit,
                offset,
                videos: paginatedVideos
            }
        });

    } catch (error) {
        console.error('Error fetching user videos:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch videos'
        });
    }
});

module.exports = router;
