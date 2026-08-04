const express = require('express');
const { hiddenSubset } = require('../utils/hiddenCreators');
const router = express.Router();
const { getDb } = require('../utils/db');
const { attachTopicTags } = require('../utils/topicTag');
const { ObjectId } = require('mongodb');
const { COLLECTION_NAME } = require('../utils/config');
const { BANNED_FILTER } = require('../utils/filters');
const { validateApiKey } = require('../utils/middleware');
const { ENABLE_MONGO_WRITES } = require('../utils/config');

const HIVE_ACCOUNT_RE = /^[a-z][a-z0-9.-]{2,15}$/;

/**
 * Channel trailer — the video that autoplays at the top of a profile's Overview.
 *
 * Stored on the creator's `embed-users` row (the per-creator settings doc) as
 * `channel_trailer: { author, permlink, set_at }`. The frontend ALSO mirrors it
 * into the user's Hive posting_json_metadata, so the choice survives this
 * database; if the two ever disagree, this row wins because it's what the
 * profile reads.
 */
const CREATORS = 'embed-users';

// GET is public — every profile view needs it.
router.get('/user/:username/trailer', async (req, res) => {
  try {
    const username = String(req.params.username || '').trim().toLowerCase();
    if (!HIVE_ACCOUNT_RE.test(username)) return res.status(400).json({ error: 'invalid username' });
    const doc = await getDb().collection(CREATORS).findOne(
      { username },
      { projection: { channel_trailer: 1 } },
    );
    return res.json({ username, trailer: doc?.channel_trailer || null });
  } catch (error) {
    console.error('Error reading channel trailer:', error.message);
    return res.status(500).json({ error: 'Failed to read channel trailer' });
  }
});

// Same app-key auth as the other creator mutations (/video/listing, /video/nsfw).
// `permlink: null` clears it.
router.put('/user/trailer', validateApiKey, async (req, res) => {
  if (!ENABLE_MONGO_WRITES) {
    return res.status(503).json({ success: false, error: 'Writes disabled' });
  }
  try {
    const username = String(req.body?.username || '').trim().toLowerCase();
    const permlink = req.body?.permlink == null ? null : String(req.body.permlink).trim();
    const author = String(req.body?.author || username).trim().toLowerCase();
    if (!HIVE_ACCOUNT_RE.test(username)) {
      return res.status(400).json({ success: false, error: 'invalid username' });
    }

    const db = getDb();
    if (permlink) {
      // The app key is public, so prove the target is actually THIS creator's
      // video before pinning it to their profile. Without this anyone holding
      // the key could point any channel's trailer at any video.
      //
      // ⚠️ Ownership only — NOT publication state. The studio sets the trailer
      // seconds after broadcasting, while the embed doc is still being linked to
      // the Hive post: requiring status:'published' here rejected a legitimate
      // request 12 seconds before the doc settled (badadib, 2026-08-04).
      const [legacy, embed] = await Promise.all([
        db.collection('videos').findOne(
          { owner: username, permlink }, { projection: { _id: 1 } },
        ),
        db.collection('embed-video').findOne(
          {
            $or: [
              { owner: username, permlink },              // asset id
              { owner: username, hive_permlink: permlink },
              { hive_author: author, hive_permlink: permlink },
            ],
          },
          { projection: { _id: 1 } },
        ),
      ]);
      if (!legacy && !embed) {
        return res.status(404).json({ success: false, error: 'No published video of that user matches this permlink' });
      }
    }

    const value = permlink ? { author, permlink, set_at: new Date() } : null;
    await db.collection(CREATORS).updateOne(
      { username },
      value
        ? { $set: { channel_trailer: value }, $setOnInsert: { username } }
        : { $unset: { channel_trailer: '' }, $setOnInsert: { username } },
      { upsert: true },
    );

    console.log(`Channel trailer for ${username} → ${permlink || '(cleared)'}`);
    return res.json({ success: true, username, trailer: value });
  } catch (error) {
    console.error('Error setting channel trailer:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to set channel trailer' });
  }
});

/**
 * GET /user/:username/counts — the stat line under a profile's bio.
 *
 * ⚠️ These queries MIRROR the profile tabs, because a stat that disagrees with
 * the tab under it is worse than no stat:
 *  - videos = the same union `/api/my-videos` totals (legacy `videos` + embed
 *    long-form). @meno is 8 embed + 123 legacy, @badadib the reverse, so
 *    counting one collection understates most creators by an order of magnitude.
 *  - shorts = the same query as `/shorts/:username`, which keys on `embed_url`
 *    + `processed`. Shorts docs carry a NULL `hive_permlink`, so requiring it
 *    (as the video feeds do) reported 2 of @meno's 70.
 *
 * No "member since": the oldest row we hold for @meno is 2025 while the account
 * predates that, so any date here would be the age of our INDEX, not of the
 * creator. Better to omit it than to state it wrongly.
 */
const countsCache = new Map();          // username -> { at, value }
const COUNTS_TTL_MS = 5 * 60 * 1000;    // profiles are hot; these numbers move slowly

router.get('/user/:username/counts', async (req, res) => {
  try {
    const username = String(req.params.username || '').trim().toLowerCase();
    if (!HIVE_ACCOUNT_RE.test(username)) {
      return res.status(400).json({ error: 'invalid username' });
    }

    const cached = countsCache.get(username);
    if (cached && Date.now() - cached.at < COUNTS_TTL_MS) return res.json(cached.value);

    const db = getDb();
    const embedVideoCollection = db.collection('embed-video');
    const sumOf = (field) => ({ $sum: { $ifNull: [`$${field}`, 0] } });
    const tally = (col, match) => col.aggregate([
      { $match: match },
      { $group: { _id: null, n: { $sum: 1 }, views: sumOf('views') } },
    ]).toArray().then((r) => r[0] || { n: 0, views: 0 });

    const [embedVideos, embedShorts, legacyVideos] = await Promise.all([
      // long-form embed uploads — /api/my-videos also drops rows with no Hive
      // link, since those have nothing to open.
      tally(embedVideoCollection, {
        owner: username, status: 'published', short: false, listed_on_3speak: true,
        hive_author: { $ne: null }, hive_permlink: { $ne: null }, ...BANNED_FILTER,
      }),
      // shorts — as /shorts/:username counts them (embed_url, NOT hive_permlink)
      tally(embedVideoCollection, {
        owner: username, status: 'published', short: true, processed: true,
        embed_url: { $exists: true, $ne: null }, listed_on_3speak: { $ne: false },
      }),
      // legacy — /api/my-videos also excludes failed publishes
      tally(db.collection('videos'), {
        owner: username, status: 'published', publishFailed: { $ne: true }, ...BANNED_FILTER,
      }),
    ]);

    const value = {
      username,
      videos: embedVideos.n + legacyVideos.n,
      shorts: embedShorts.n,
      views: embedVideos.views + embedShorts.views + legacyVideos.views,
    };

    countsCache.set(username, { at: Date.now(), value });
    return res.json(value);
  } catch (error) {
    console.error('Error building user counts:', error.message);
    return res.status(500).json({ error: 'Failed to fetch user counts' });
  }
});

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

// POST /check-hidden  body: { usernames: [...] } → { hidden: [...] }
// Bulk visibility check for the frontend: given the comment authors on a page, which
// are hidden creators (so the client can drop their comments). Read-only, unauth —
// mirrors GET /check. Capped to keep a single request cheap.
router.post('/check-hidden', async (req, res) => {
    try {
        const raw = Array.isArray(req.body?.usernames) ? req.body.usernames : [];
        if (raw.length === 0) return res.json({ hidden: [] });
        const names = raw.slice(0, 500).map((u) => String(u || '').toLowerCase());
        const hidden = await hiddenSubset(getDb(), names);
        res.json({ hidden });
    } catch (error) {
        console.error('check-hidden error:', error);
        res.status(500).json({ hidden: [] }); // fail-open: hide nothing rather than break comments
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
        // When the owner views their OWN profile the frontend sets this so
        // unlisted videos still appear (badged) and can be re-listed. Every
        // other surface keeps the default listed_on_3speak:true filter.
        const includeUnlisted = req.query.include_unlisted === '1' || req.query.include_unlisted === 'true';
        // `openpod=1` narrows to OpenPods stream recordings (the VOD published
        // when a live session ends). Matched either by the flag we stamp at
        // publish time, or by the recorder's `stream-<room>-<n>s.<ext>`
        // filename so sessions recorded before the flag existed still show up.
        const openpodOnly = req.query.openpod === '1' || req.query.openpod === 'true';

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
        const embedQuery = { owner: username, short: false, ...BANNED_FILTER };
        if (!includeUnlisted) {
            embedQuery.listed_on_3speak = true;
        }
        if (statusFilter !== 'all') {
            embedQuery.status = statusFilter;
        }
        if (openpodOnly) {
            embedQuery.$or = [
                { is_openpod_stream: true },
                { originalFilename: { $regex: '^stream-' } },
            ];
        }

        // Fetch both in parallel
        const [videosData, embedVideosData] = await Promise.all([
            openpodOnly
                ? Promise.resolve([])
                : videosCollection.find(query).sort({ created: -1, _id: -1 }).toArray(),
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
                    // false only when explicitly unlisted; lets the owner's profile badge it.
                    listed_on_3speak: ev.listed_on_3speak !== false,
                    unlisted: ev.listed_on_3speak === false,
                    // NSFW = explicit doc flag OR the Hive `nsfw` tag.
                    isNsfwContent: ev.isNsfwContent === true || (Array.isArray(ev.hive_tags) && ev.hive_tags.some(t => String(t).toLowerCase() === 'nsfw')),
                    promotedUntil: ev.promotedUntil || null,
                    // OpenPods stream recording (flagged at publish time, or
                    // recognised by the recorder's stream-<room>-<n>s filename).
                    isOpenpodStream: ev.is_openpod_stream === true
                        || /^stream-/.test(String(ev.originalFilename || '')),
                    openpodRoom: ev.openpod_room || null,
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

        // Display topic, same as the feeds — the profile grid uses Card3 too.
        // `video_id` is the ASSET permlink (auto tags) for both legacy and embed
        // rows, while `permlink` is the HIVE permlink (viewer tags).
        await attachTopicTags(
            db,
            paginatedVideos,
            (v) => ({ author: v.owner, permlink: v.video_id }),
            (v) => ({ author: v.author || v.owner, permlink: v.permlink }),
        );

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
