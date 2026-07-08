const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');
const { nsfwFilter, nsfwFilterTags, nsfwFilterHiveTags, BANNED_FILTER } = require('../utils/filters');
const { getFollowingList, hiveRpcBatch } = require('../utils/hive');
const { getCachedViews, setCachedViews } = require('../utils/cache');
const { validateApiKey } = require('../utils/middleware');
const { ENABLE_MONGO_WRITES, RETENTION_FOLLOW_HALFLIFE_H } = require('../utils/config');
const { rankFeed } = require('../utils/feedRank');

// Cache whether hive_tags_lower has been backfilled
// Once true it stays true. If false, re-check periodically so a backfill
// or the change-stream watcher can flip it without requiring a restart.
let _hasHiveTagsLower = false;
let _lastCheckedAt = 0;
const RECHECK_INTERVAL_MS = 60_000;
async function hasHiveTagsLower(embedCollection) {
    if (_hasHiveTagsLower) return true;
    const now = Date.now();
    if (now - _lastCheckedAt < RECHECK_INTERVAL_MS) return false;
    _lastCheckedAt = now;
    const missing = await embedCollection.findOne(
        { hive_tags: { $exists: true }, hive_tags_lower: { $exists: false } },
        { projection: { _id: 1 } }
    );
    _hasHiveTagsLower = !missing;
    return _hasHiveTagsLower;
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildEmbedTagMatch(tagLower, useLowerField) {
    return useLowerField
        ? { hive_tags_lower: tagLower }
        : { hive_tags: { $elemMatch: { $regex: new RegExp(`^${escapeRegex(tagLower)}$`, 'i') } } };
}

// Combines nsfwFilterHiveTags + tag match into a single filter.
// When both use the hive_tags key (regex fallback path), merges via $and
// to avoid the tag match overwriting the NSFW exclusion.
function buildEmbedFilter(req, tagLower, useLowerField) {
    const nsfw = nsfwFilterHiveTags(req);
    const tagMatch = buildEmbedTagMatch(tagLower, useLowerField);

    if (!useLowerField && nsfw.hive_tags) {
        const { hive_tags: nsfwHiveTags, ...rest } = nsfw;
        return { ...rest, $and: [{ hive_tags: nsfwHiveTags }, tagMatch] };
    }
    return { ...nsfw, ...tagMatch };
}

// Endpoint to get videos by tag
router.get('/videos/tag/:tag', async (req, res) => {
    const db = getDb();
    try {
        const { tag } = req.params;

        if (!tag) {
            return res.status(400).json({
                error: 'Tag is required'
            });
        }

        // Extract pagination parameters
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
        const skip = (page - 1) * limit;

        // Type filter: 'videos', 'shorts', or undefined (all)
        const type = req.query.type;

        // Since filter: unix timestamp (seconds) — only return content created after this
        const sinceParam = parseInt(req.query.since) || 0;
        const sinceDate = sinceParam ? new Date(sinceParam * 1000) : null;

        // Query the videos collection
        const videosCollection = db.collection('videos');

        // Build query — special case for "mantecurated" tag
        let videos, total;
        if (tag.toLowerCase() === 'mantecurated') {
            const legacyQuery = { mantecurated: true, status: 'published', ...nsfwFilter(req) };
            const embedQuery = { mantecurated: true, status: 'published', ...nsfwFilterHiveTags(req) };
            if (sinceDate) {
                legacyQuery.created = { $gte: sinceDate };
                embedQuery.createdAt = { $gte: sinceDate };
            }

            if (type === 'videos') embedQuery.short = false;
            else if (type === 'shorts') embedQuery.short = true;

            const fetchLegacy = type !== 'shorts'
                ? videosCollection.find(legacyQuery).sort({ created: -1 }).toArray()
                : Promise.resolve([]);
            const fetchEmbed = type !== 'videos'
                ? db.collection('embed-video').find(embedQuery).sort({ createdAt: -1 }).toArray()
                : Promise.resolve([]);

            const [legacyVideos, embedVideosRaw] = await Promise.all([fetchLegacy, fetchEmbed]);
            const normalized = embedVideosRaw.map(ev => ({
                owner: ev.owner,
                author: ev.hive_author || ev.owner,
                permlink: ev.hive_permlink || ev.permlink,
                title: ev.hive_title || ev.embed_title || ev.originalFilename || '',
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
                short: !!ev.short,
                _source: 'embed',
            }));
            const merged = [...legacyVideos, ...normalized].sort((a, b) => new Date(b.created) - new Date(a.created));
            total = merged.length;
            videos = merged.slice(skip, skip + limit);
        } else {
            const tagLower = tag.toLowerCase();
            const embedCollection = db.collection('embed-video');

            // Build tag match for embed-video — prefer pre-lowercased field, fall back to regex
            // After running backfill-hive-tags-lower.js the fast path will be used
            const useLower = await hasHiveTagsLower(embedCollection);
            const embedTagMatch = buildEmbedTagMatch(tagLower, useLower);

            // "snaps" is a synonym for shorts — match all shorts regardless of tags
            const isSnapsTag = tagLower === 'snaps';
            const shortsTagMatch = isSnapsTag ? {} : embedTagMatch;

            // Normalize embed-video docs to match legacy format
            const normalizeEmbed = (ev) => ({
                owner: ev.owner,
                author: ev.hive_author || ev.owner,
                permlink: ev.hive_permlink || ev.permlink,
                title: ev.hive_title || ev.embed_title || ev.originalFilename || '',
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
                short: !!ev.short,
                _source: 'embed',
            });

            if (type === 'videos') {
                // Videos only: use DB-level pagination on legacy, small embed set
                const legacyQuery = { tags_v2: tagLower, status: 'published', ...nsfwFilter(req) };
                const embedQuery = { short: false, listed_on_3speak: true, status: 'published', ...buildEmbedFilter(req, tagLower, useLower) };
                if (sinceDate) { legacyQuery.created = { $gte: sinceDate }; embedQuery.createdAt = { $gte: sinceDate }; }

                const [legacyCount, embedDocs] = await Promise.all([
                    videosCollection.countDocuments(legacyQuery),
                    embedCollection.find(embedQuery).sort({ createdAt: -1 }).limit(skip + limit).toArray(),
                ]);

                const normalizedEmbed = embedDocs.map(normalizeEmbed);
                const legacyDocs = await videosCollection.find(legacyQuery).sort({ created: -1 }).limit(skip + limit).toArray();
                const legacyMapped = legacyDocs.map(v => ({ ...v, short: false }));

                // Deduplicate
                const legacyKeys = new Set(legacyMapped.map(v => `${v.author || v.owner}/${v.permlink}`));
                const uniqueEmbed = normalizedEmbed.filter(v => !legacyKeys.has(`${v.author}/${v.permlink}`));

                // Merge, sort, paginate
                const merged = [...legacyMapped, ...uniqueEmbed].sort((a, b) => new Date(b.created) - new Date(a.created));
                total = legacyCount + uniqueEmbed.length;
                videos = merged.slice(skip, skip + limit);

            } else if (type === 'shorts') {
                // Shorts only: DB-level pagination on embed-video
                const shortsNsfw = nsfwFilterHiveTags(req);
                const query = isSnapsTag
                    ? { short: true, status: 'published', ...shortsNsfw }
                    : { short: true, status: 'published', ...buildEmbedFilter(req, tagLower, useLower) };
                if (sinceDate) query.createdAt = { $gte: sinceDate };

                total = await embedCollection.countDocuments(query);
                const docs = await embedCollection.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray();
                videos = docs.map(normalizeEmbed);

            } else {
                // No type specified — default to videos behaviour
                const legacyQuery = { tags_v2: tagLower, status: 'published', ...nsfwFilter(req) };
                const embedQuery = { short: false, listed_on_3speak: true, status: 'published', ...buildEmbedFilter(req, tagLower, useLower) };
                if (sinceDate) { legacyQuery.created = { $gte: sinceDate }; embedQuery.createdAt = { $gte: sinceDate }; }

                const [legacyCount, embedDocs] = await Promise.all([
                    videosCollection.countDocuments(legacyQuery),
                    embedCollection.find(embedQuery).sort({ createdAt: -1 }).limit(skip + limit).toArray(),
                ]);

                const normalizedEmbed = embedDocs.map(normalizeEmbed);
                const legacyDocs = await videosCollection.find(legacyQuery).sort({ created: -1 }).limit(skip + limit).toArray();
                const legacyMapped = legacyDocs.map(v => ({ ...v, short: false }));

                const legacyKeys = new Set(legacyMapped.map(v => `${v.author || v.owner}/${v.permlink}`));
                const uniqueEmbed = normalizedEmbed.filter(v => !legacyKeys.has(`${v.author}/${v.permlink}`));

                const merged = [...legacyMapped, ...uniqueEmbed].sort((a, b) => new Date(b.created) - new Date(a.created));
                total = legacyCount + uniqueEmbed.length;
                videos = merged.slice(skip, skip + limit);
            }
        }

        const totalPages = Math.ceil(total / limit);

        // Return response
        res.json({
            tag: tag,
            page: page,
            limit: limit,
            total: total,
            totalPages: totalPages,
            videos: videos
        });

    } catch (error) {
        console.error('Error fetching videos by tag:', error);
        res.status(500).json({
            error: 'Internal server error'
        });
    }
});

// Lightweight endpoint: counts only (no document bodies)
router.get('/videos/tag/:tag/counts', async (req, res) => {
    const db = getDb();
    try {
        const { tag } = req.params;
        if (!tag) return res.status(400).json({ error: 'Tag is required' });

        const tagLower = tag.toLowerCase();
        const sinceParam = parseInt(req.query.since) || 0;
        const sinceDate = sinceParam ? new Date(sinceParam * 1000) : null;

        const videosCollection = db.collection('videos');
        const embedCollection = db.collection('embed-video');

        if (tagLower === 'mantecurated') {
            const legacyQuery = { mantecurated: true, status: 'published', ...nsfwFilter(req) };
            const embedBaseQuery = { mantecurated: true, status: 'published', ...nsfwFilterHiveTags(req) };
            if (sinceDate) {
                legacyQuery.created = { $gte: sinceDate };
                embedBaseQuery.createdAt = { $gte: sinceDate };
            }
            const [legacyCount, embedVideoCount, embedShortCount] = await Promise.all([
                videosCollection.countDocuments(legacyQuery),
                embedCollection.countDocuments({ ...embedBaseQuery, short: false }),
                embedCollection.countDocuments({ ...embedBaseQuery, short: true }),
            ]);
            return res.json({
                tag,
                videos: legacyCount + embedVideoCount,
                shorts: embedShortCount,
                total: legacyCount + embedVideoCount + embedShortCount,
            });
        }

        const useLower = await hasHiveTagsLower(embedCollection);
        const embedTagMatch = buildEmbedTagMatch(tagLower, useLower);
        const isSnapsTag = tagLower === 'snaps';

        const legacyQuery = { tags_v2: tagLower, status: 'published', ...nsfwFilter(req) };
        const embedVideoQuery = { short: false, listed_on_3speak: true, status: 'published', ...buildEmbedFilter(req, tagLower, useLower) };
        const shortsQuery = isSnapsTag
            ? { short: true, status: 'published', ...nsfwFilterHiveTags(req) }
            : { short: true, status: 'published', ...buildEmbedFilter(req, tagLower, useLower) };
        if (sinceDate) {
            legacyQuery.created = { $gte: sinceDate };
            embedVideoQuery.createdAt = { $gte: sinceDate };
            shortsQuery.createdAt = { $gte: sinceDate };
        }

        const [legacyCount, embedVideoCount, shortsCount] = await Promise.all([
            videosCollection.countDocuments(legacyQuery),
            embedCollection.countDocuments(embedVideoQuery),
            embedCollection.countDocuments(shortsQuery),
        ]);

        res.json({
            tag,
            videos: legacyCount + embedVideoCount,
            shorts: shortsCount,
            total: legacyCount + embedVideoCount + shortsCount,
        });
    } catch (error) {
        console.error('Error fetching tag counts:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Endpoint to get personalized feed based on following list
router.get('/feed/:username', async (req, res) => {
    const db = getDb();
    try {
        const { username } = req.params;

        if (!username) {
            return res.status(400).json({
                error: 'Username is required'
            });
        }

        // Extract pagination parameters
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
        const skip = (page - 1) * limit;

        // Get following list from Hive API
        const followingList = await getFollowingList(username);

        const videosCollection = db.collection('videos');
        const embedVideoCollection = db.collection('embed-video');

        // Build queries for both collections. Only TOP-LEVEL content: legacy
        // `videos` are top-level by nature; embed videos are filtered with
        // `short: false` so shorts are excluded.
        let legacyQuery, embedQuery, feedType;
        if (followingList && followingList.length > 0) {
            legacyQuery = { owner: { $in: followingList }, status: 'published', ...nsfwFilterTags(req) };
            embedQuery = {
                hive_author: { $in: followingList },
                status: 'published',
                short: false,
                listed_on_3speak: true,
                hive_permlink: { $ne: null },
                ...nsfwFilterHiveTags(req)
            };
            feedType = 'personalized';
            console.log(`Fetching feed for ${username}: ${followingList.length} following`);
        } else {
            // Fallback: all published top-level content (no following list)
            legacyQuery = { status: 'published', ...nsfwFilterTags(req) };
            embedQuery = {
                status: 'published',
                short: false,
                listed_on_3speak: true,
                hive_author: { $ne: null },
                hive_permlink: { $ne: null },
                ...nsfwFilterHiveTags(req)
            };
            feedType = 'all';
            console.log(`Feed fallback for ${username}: showing all videos (no following list)`);
        }

        // Fetch legacy + embed videos in parallel (over-fetch, merge, paginate).
        const [legacyVideos, embedVideosRaw] = await Promise.all([
            videosCollection.find(legacyQuery).sort({ created: -1 }).limit(limit + skip).toArray(),
            embedVideoCollection.find(embedQuery).sort({ createdAt: -1 }).limit(limit + skip).toArray()
        ]);

        // Transform embed videos to the legacy shape (same mapping the other feeds use).
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
            _embedPermlink: ev.permlink,   // asset id — retention/view-durations key
            _sortDate: new Date(ev.createdAt || 0).getTime()
        }));

        const legacyWithDate = legacyVideos.map(v => ({
            ...v,
            _sortDate: new Date(v.created || v.created_at || 0).getTime()
        }));

        // Dedup embeds that already exist as legacy docs.
        const legacyKeys = new Set(legacyWithDate.map(v => `${v.author || v.owner}/${v.permlink}`));
        const uniqueEmbed = embedVideos.filter(ev => !legacyKeys.has(`${ev.author}/${ev.permlink}`));

        // Merge, then rank. Base rank = recency decay (half-life
        // RETENTION_FOLLOW_HALFLIFE_H) so the follow feed stays newest-first;
        // retention then multiplies it as a bounded nudge, so a slightly older
        // video with strong retention can edge above a brand-new one but recency
        // still dominates. See algo.md.
        const allVideos = [...legacyWithDate, ...uniqueEmbed];
        const nowMs = Date.now();
        const halfLifeMs = Math.max(1, RETENTION_FOLLOW_HALFLIFE_H) * 3600 * 1000;
        for (const v of allVideos) {
            const ageMs = Math.max(0, nowMs - (v._sortDate || 0));
            // Floor > 0 so a missing/epoch _sortDate can't zero the score (which
            // would make the interest/retention multipliers no-ops).
            v._rankScore = Math.max(1e-6, Math.pow(0.5, ageMs / halfLifeMs));
        }
        // Interest boost → retention → sort → hide-seen (?currentuser=), on the
        // recency-decayed base score. Shared with the discovery feeds so the follow
        // feed re-ranks by the same signals when interests / hide-watched are on.
        const visibleVideos = await rankFeed(db, req, allVideos, { scoreField: '_rankScore' });

        const total = visibleVideos.length;
        const totalPages = Math.ceil(total / limit);
        const videos = visibleVideos.slice(skip, skip + limit);
        videos.forEach(v => { delete v._sortDate; delete v._source; delete v._rankScore; delete v._embedPermlink; delete v.retention_mult; delete v.retention_relq; delete v.interest_match; });

        // Return response
        res.json({
            username: username,
            feedType: feedType,
            following: followingList ? followingList.length : 0,
            page: page,
            limit: limit,
            total: total,
            totalPages: totalPages,
            videos: videos
        });

    } catch (error) {
        console.error('Error fetching feed:', error);
        res.status(500).json({
            error: 'Internal server error'
        });
    }
});

// Resolve the "reusable" flag for an embed video from the Hive post's
// json_metadata — embed-video docs don't store it. Cached 30min so this stays a
// fast lookup and we don't fire a Hive RPC on every video view.
const _reusableCache = new Map();
const REUSABLE_TTL = 30 * 60 * 1000;
async function resolveEmbedReusable(hiveAuthor, hivePermlink) {
    const key = `${hiveAuthor}/${hivePermlink}`;
    const hit = _reusableCache.get(key);
    if (hit && Date.now() - hit.ts < REUSABLE_TTL) return hit.value;
    let reusable = false;
    try {
        const [r] = await hiveRpcBatch([{ jsonrpc: '2.0', id: 1, method: 'condenser_api.get_content', params: [hiveAuthor, hivePermlink] }]);
        const post = r && r.result;
        if (post && post.json_metadata) {
            const md = JSON.parse(post.json_metadata);
            reusable = !!((md && md.video && md.video.reusable) || (md && md.reusable));
        }
    } catch { /* default false */ }
    _reusableCache.set(key, { value: reusable, ts: Date.now() });
    return reusable;
}

// Endpoint to get video details (reusable flag) from MongoDB.
// Resolves legacy `videos` AND `embed-video`, by 3speak/asset permlink or Hive
// permlink (via embed_url). For embed videos `reusable` lives in the Hive post.
router.get('/api/video/:owner/:permlink', async (req, res) => {
    const db = getDb();
    try {
        const { owner, permlink } = req.params;
        const videosCollection = db.collection('videos');

        // Legacy `videos`: direct (3speak permlink) then embed_url (Hive permlink)
        let video = await videosCollection.findOne(
            { owner, permlink },
            { projection: { reusable: 1, _id: 0 } }
        );
        if (!video) {
            video = await videosCollection.findOne(
                { owner, embed_url: { $regex: `@${owner}/${permlink}$` } },
                { projection: { reusable: 1, _id: 0 } }
            );
        }
        if (video) {
            return res.json({ success: true, reusable: video.reusable || false });
        }

        // embed-video: match by asset permlink, then by embed_url (Hive permlink).
        const embedCollection = db.collection('embed-video');
        const embed = await embedCollection.findOne(
            { owner, permlink },
            { projection: { embed_url: 1, _id: 0 } }
        ) || await embedCollection.findOne(
            { owner, embed_url: { $regex: `@${owner}/${permlink}$` } },
            { projection: { embed_url: 1, _id: 0 } }
        );

        if (!embed) {
            return res.status(404).json({ success: false, error: 'Video not found' });
        }

        // Derive the Hive author/permlink from embed_url ("@author/permlink"); the
        // request params may already be the Hive permlink, so fall back to those.
        let hiveAuthor = owner;
        let hivePermlink = permlink;
        if (embed.embed_url) {
            const parts = embed.embed_url.replace(/^@/, '').split('/');
            if (parts.length === 2) { hiveAuthor = parts[0]; hivePermlink = parts[1]; }
        }
        const reusable = await resolveEmbedReusable(hiveAuthor, hivePermlink);
        return res.json({ success: true, reusable });
    } catch (error) {
        console.error('Error fetching video details:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// PATCH endpoint to set reusable flag on a video
// Protected by UPLOAD_SECRET_TOKEN (same token the frontend uses for uploads)
router.patch('/api/video/:owner/:permlink/reusable', async (req, res) => {
    const db = getDb();
    try {
        // Validate token
        const authHeader = req.headers.authorization;
        const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
        const UPLOAD_SECRET_TOKEN = process.env.UPLOAD_SECRET_TOKEN;

        if (!UPLOAD_SECRET_TOKEN || token !== UPLOAD_SECRET_TOKEN) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }

        const { owner, permlink } = req.params;
        const { reusable } = req.body;

        if (typeof reusable !== 'boolean') {
            return res.status(400).json({ success: false, error: 'reusable must be a boolean' });
        }

        const videosCollection = db.collection('videos');
        const result = await videosCollection.updateOne(
            { owner, permlink },
            { $set: { reusable } }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({ success: false, error: 'Video not found' });
        }

        console.log(`[PATCH reusable] ${owner}/${permlink} → reusable=${reusable}`);
        res.json({ success: true, reusable });
    } catch (error) {
        console.error('Error updating reusable flag:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Endpoint to get batch video view counts
router.post('/views', async (req, res) => {
    const db = getDb();
    try {
        const { videos } = req.body;

        // Validate request body
        if (!videos || !Array.isArray(videos)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid request body',
                message: 'videos array is required'
            });
        }

        // Check array length limit
        if (videos.length > 50) {
            return res.status(400).json({
                success: false,
                error: 'Too many videos',
                message: 'Maximum 50 videos per request'
            });
        }

        // Validate each video has required fields
        for (const video of videos) {
            if (!video.author || !video.permlink) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid request body',
                    message: 'Each video must have author and permlink'
                });
            }
        }

        const results = {};
        const videosCollection = db.collection('videos');

        // Fetch all in parallel from MongoDB
        await Promise.all(
            videos.map(async ({ author, permlink }) => {
                const key = `${author}/${permlink}`;

                // Check cache first
                const cachedViews = getCachedViews(key);
                if (cachedViews !== null) {
                    results[key] = cachedViews;
                    return;
                }

                try {
                    // Query MongoDB directly for view count
                    const video = await videosCollection.findOne(
                        { owner: author, permlink: permlink },
                        { projection: { views: 1 } }
                    );

                    if (video) {
                        const views = video.views ?? 0;
                        results[key] = views;
                        setCachedViews(key, views);
                    } else {
                        // Embed videos aren't in the legacy `videos` collection — their
                        // view count lives in `embed-video`, keyed by hive author/permlink.
                        const embed = await db.collection('embed-video').findOne(
                            { hive_author: author, hive_permlink: permlink },
                            { projection: { views: 1 } }
                        );
                        if (embed) {
                            const views = embed.views ?? 0;
                            results[key] = views;
                            setCachedViews(key, views);
                        } else {
                            results[key] = null;
                        }
                    }
                } catch (err) {
                    console.error(`Error fetching views for ${key}:`, err.message);
                    results[key] = null;
                }
            })
        );

        res.json({ success: true, data: results });

    } catch (error) {
        console.error('Error fetching view counts:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: 'Failed to fetch view counts'
        });
    }
});

// Endpoint to update video thumbnail
router.put('/video/thumbnail', validateApiKey, async (req, res) => {
    const db = getDb();
    if (!ENABLE_MONGO_WRITES) {
        return res.status(503).json({
            success: false,
            error: 'Writes disabled',
            message: 'MongoDB writes are currently disabled (ENABLE_MONGO_WRITES=false)'
        });
    }
    try {
        const { owner, permlink, thumbnail } = req.body;

        // Validate required fields
        if (!owner || !permlink || !thumbnail) {
            return res.status(400).json({
                success: false,
                error: 'Invalid request',
                message: 'owner, permlink, and thumbnail are required'
            });
        }

        // Validate thumbnail format (basic validation)
        const isValidThumbnail =
            thumbnail.startsWith('ipfs://') ||
            thumbnail.startsWith('http://') ||
            thumbnail.startsWith('https://');

        if (!isValidThumbnail) {
            return res.status(400).json({
                success: false,
                error: 'Invalid thumbnail',
                message: 'Thumbnail must be a valid URL or IPFS CID (starting with ipfs://, http://, or https://)'
            });
        }

        // A video can live in `videos` (legacy uploads) and/or `embed-video`
        // (embed-pipeline uploads). Read paths differ per collection:
        //   videos:      reads `thumbnail` (some also `thumbnail_url`)
        //   embed-video: reads `thumbnail_url`
        // So update whichever exist, on the right field(s). Only 404 if the
        // video is in neither.
        const now = new Date();
        const videosCollection = db.collection('videos');
        const embedVideoCollection = db.collection('embed-video');
        const embedAudioCollection = db.collection('embed-audio');

        const [videoDoc, embedDoc, audioDoc] = await Promise.all([
            videosCollection.findOne({ owner, permlink }),
            embedVideoCollection.findOne({
                $or: [
                    { owner, permlink },
                    { hive_author: owner, hive_permlink: permlink },
                ],
            }),
            // audio is matched on its own permlink OR its linked Hive post
            embedAudioCollection.findOne({
                $or: [
                    { owner, permlink },
                    { owner, post_permlink: permlink },
                ],
            }),
        ]);

        if (!videoDoc && !embedDoc && !audioDoc) {
            return res.status(404).json({
                success: false,
                error: 'Video not found',
                message: `No video or audio found for owner: ${owner}, permlink: ${permlink}`
            });
        }

        const updated = [];
        if (videoDoc) {
            await videosCollection.updateOne(
                { owner, permlink },
                // set both fields so every read path reflects it
                { $set: { thumbnail, thumbnail_url: thumbnail, thumbnail_updated_at: now } }
            );
            updated.push('videos');
        }
        if (embedDoc) {
            await embedVideoCollection.updateOne(
                { _id: embedDoc._id },
                { $set: { thumbnail_url: thumbnail, thumbnail_updated_at: now } }
            );
            updated.push('embed-video');
        }
        if (audioDoc) {
            await embedAudioCollection.updateOne(
                { _id: audioDoc._id },
                { $set: { thumbnail_url: thumbnail, thumbnail_updated_at: now } }
            );
            updated.push('embed-audio');
        }

        // Log the update for audit purposes
        console.log(`Thumbnail updated for ${owner}/${permlink} in [${updated.join(', ')}] to: ${thumbnail}`);

        // Return success response
        res.json({
            success: true,
            message: 'Thumbnail updated successfully',
            data: {
                owner: owner,
                permlink: permlink,
                thumbnail: thumbnail,
                collections: updated,
                updated_at: now.toISOString()
            }
        });

    } catch (error) {
        console.error('Error updating thumbnail:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: 'Failed to update thumbnail'
        });
    }
});

// Endpoint to list / unlist a video — sets `listed_on_3speak`, which every feed
// query filters on, so an unlisted video disappears from the UI feeds/search
// while staying playable by direct link. Same app-key auth as /video/thumbnail.
router.put('/video/listing', validateApiKey, async (req, res) => {
    const db = getDb();
    if (!ENABLE_MONGO_WRITES) {
        return res.status(503).json({ success: false, error: 'Writes disabled', message: 'MongoDB writes are currently disabled' });
    }
    try {
        const { owner, permlink, listed } = req.body;
        if (!owner || !permlink || typeof listed !== 'boolean') {
            return res.status(400).json({ success: false, error: 'Invalid request', message: 'owner, permlink and a boolean `listed` are required' });
        }

        const now = new Date();
        const videosCollection = db.collection('videos');
        const embedVideoCollection = db.collection('embed-video');
        const [videoDoc, embedDoc] = await Promise.all([
            videosCollection.findOne({ owner, permlink }),
            embedVideoCollection.findOne({ $or: [{ owner, permlink }, { hive_author: owner, hive_permlink: permlink }] }),
        ]);

        if (!videoDoc && !embedDoc) {
            return res.status(404).json({ success: false, error: 'Video not found', message: `No video found for owner: ${owner}, permlink: ${permlink}` });
        }

        const updated = [];
        if (videoDoc) {
            await videosCollection.updateOne({ owner, permlink }, { $set: { listed_on_3speak: listed, listing_updated_at: now } });
            updated.push('videos');
        }
        if (embedDoc) {
            await embedVideoCollection.updateOne({ _id: embedDoc._id }, { $set: { listed_on_3speak: listed, listing_updated_at: now } });
            updated.push('embed-video');
        }

        console.log(`Listing set to ${listed} for ${owner}/${permlink} in [${updated.join(', ')}]`);
        res.json({ success: true, message: 'Listing updated', data: { owner, permlink, listed, collections: updated } });
    } catch (error) {
        console.error('Error updating listing:', error);
        res.status(500).json({ success: false, error: 'Internal server error', message: 'Failed to update listing' });
    }
});

// Endpoint to mark a video NSFW (or clear it) — sets `isNsfwContent`, which the
// nsfw filters exclude from feeds/search unless ?nsfw=true. The canonical signal
// is the Hive `nsfw` tag (synced into hive_tags); this gives an immediate effect
// before the Hive→Mongo sync catches up. Same app-key auth as /video/thumbnail.
router.put('/video/nsfw', validateApiKey, async (req, res) => {
    const db = getDb();
    if (!ENABLE_MONGO_WRITES) {
        return res.status(503).json({ success: false, error: 'Writes disabled', message: 'MongoDB writes are currently disabled' });
    }
    try {
        const { owner, permlink, nsfw } = req.body;
        if (!owner || !permlink || typeof nsfw !== 'boolean') {
            return res.status(400).json({ success: false, error: 'Invalid request', message: 'owner, permlink and a boolean `nsfw` are required' });
        }

        const now = new Date();
        const videosCollection = db.collection('videos');
        const embedVideoCollection = db.collection('embed-video');
        const [videoDoc, embedDoc] = await Promise.all([
            videosCollection.findOne({ owner, permlink }),
            embedVideoCollection.findOne({ $or: [{ owner, permlink }, { hive_author: owner, hive_permlink: permlink }] }),
        ]);

        if (!videoDoc && !embedDoc) {
            return res.status(404).json({ success: false, error: 'Video not found', message: `No video found for owner: ${owner}, permlink: ${permlink}` });
        }

        const updated = [];
        if (videoDoc) {
            await videosCollection.updateOne({ owner, permlink }, { $set: { isNsfwContent: nsfw, nsfw_updated_at: now } });
            updated.push('videos');
        }
        if (embedDoc) {
            await embedVideoCollection.updateOne({ _id: embedDoc._id }, { $set: { isNsfwContent: nsfw, nsfw_updated_at: now } });
            updated.push('embed-video');
        }

        console.log(`NSFW set to ${nsfw} for ${owner}/${permlink} in [${updated.join(', ')}]`);
        res.json({ success: true, message: 'NSFW flag updated', data: { owner, permlink, nsfw, collections: updated } });
    } catch (error) {
        console.error('Error updating NSFW flag:', error);
        res.status(500).json({ success: false, error: 'Internal server error', message: 'Failed to update NSFW flag' });
    }
});

// Endpoint to get extended video details by author/permlink
router.get('/videodetails/:author/:permlink', async (req, res) => {
    const db = getDb();
    try {
        const { author, permlink } = req.params;

        if (!author || !permlink) {
            return res.status(400).json({ error: 'Author and permlink are required' });
        }

        const video = await db.collection('videos').findOne(
            { owner: author, permlink, ...BANNED_FILTER }
        ) || await db.collection('embed-video').findOne(
            {
                $or: [
                    { owner: author, permlink },
                    { hive_author: author, hive_permlink: permlink },
                ],
                ...BANNED_FILTER,
            }
        );

        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }

        // Default mantecurated to false if not set
        if (video.mantecurated === undefined) {
            video.mantecurated = false;
        }

        res.json(video);

    } catch (error) {
        console.error('Error fetching video details:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
