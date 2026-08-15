const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');
const { feedAgeMatch } = require('../utils/feedAge');
const { unavailableMatch } = require('../utils/unavailable');
const { hiddenFromFeedMatch } = require('../utils/hiddenFromFeed');
const { nsfwFilter, nsfwFilterTags, nsfwFilterHiveTags } = require('../utils/filters');
const { hiddenListSync } = require('../utils/hiddenCreators');

// Helper: highlight matched terms in a string
function highlightMatches(text, terms) {
    if (!text || !terms.length) return text;
    const escaped = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const regex = new RegExp(`(${escaped.join('|')})`, 'gi');
    return text.replace(regex, '<mark>$1</mark>');
}

// GET /search/suggest — lightweight autocomplete
router.get('/suggest', async (req, res) => {
    try {
        const db = getDb();
        const q = (req.query.q || '').trim();
        if (!q || q.length < 2) {
            return res.json({ success: true, suggestions: [] });
        }

        const escapedQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const prefixRegex = { $regex: `^${escapedQ}`, $options: 'i' };
        const containsRegex = { $regex: escapedQ, $options: 'i' };

        const [titles, embedTitles, usernames, tags, embedTags, communities, playlists] = await Promise.all([
            db.collection('videos').find(
                { title: containsRegex, status: 'published', publishFailed: { $ne: true } },
                { projection: { title: 1, author: 1, owner: 1, permlink: 1, _id: 0 } }
            ).limit(5).toArray(),
            // Embed videos that have already been broadcast to Hive should also surface
            // in the type-ahead — the regular `videos` index lags the embed service.
            db.collection('embed-video').find(
                {
                    hive_title: containsRegex,
                    status: 'published',
                    hive_author: { $type: 'string', $nin: hiddenListSync() },
                    hive_permlink: { $type: 'string' },
                },
                { projection: { hive_title: 1, hive_author: 1, owner: 1, hive_permlink: 1, _id: 0 } }
            ).limit(5).toArray(),
            db.collection('hiveprofiles').find(
                { username: { $nin: hiddenListSync() }, $or: [{ username: prefixRegex }, { display_name: containsRegex }] },
                { projection: { username: 1, display_name: 1, profile_image: 1, _id: 0 } }
            ).limit(5).toArray(),
            db.collection('videos').find(
                { tags_v2: containsRegex, status: 'published', publishFailed: { $ne: true } },
                { projection: { tags_v2: 1, _id: 0 } }
            ).limit(50).toArray().then(docs => {
                const re = new RegExp(escapedQ, 'i');
                const seen = new Set();
                const result = [];
                for (const d of docs) {
                    if (!Array.isArray(d.tags_v2)) continue;
                    for (const raw of d.tags_v2) {
                        if (typeof raw !== 'string') continue;
                        const t = raw.trim().replace(/^#/, '');
                        if (t && re.test(t) && !seen.has(t.toLowerCase())) {
                            seen.add(t.toLowerCase());
                            result.push(t);
                            if (result.length >= 5) return result;
                        }
                    }
                }
                return result;
            }),
            // Same tag scan against freshly-uploaded embed videos (hive_tags).
            db.collection('embed-video').find(
                {
                    hive_tags: containsRegex,
                    status: 'published',
                    hive_author: { $type: 'string' },
                },
                { projection: { hive_tags: 1, _id: 0 } }
            ).limit(50).toArray().then(docs => {
                const re = new RegExp(escapedQ, 'i');
                const seen = new Set();
                const result = [];
                for (const d of docs) {
                    if (!Array.isArray(d.hive_tags)) continue;
                    for (const raw of d.hive_tags) {
                        if (typeof raw !== 'string') continue;
                        const t = raw.trim().replace(/^#/, '');
                        if (t && re.test(t) && !seen.has(t.toLowerCase())) {
                            seen.add(t.toLowerCase());
                            result.push(t);
                            if (result.length >= 5) return result;
                        }
                    }
                }
                return result;
            }),
            db.collection('hivecommunities').find(
                { $or: [{ name: prefixRegex }, { title: containsRegex }] },
                { projection: { name: 1, title: 1, about: 1, subscribers: 1, num_authors: 1, _id: 0 } }
            ).sort({ subscribers: -1 }).limit(5).toArray(),
            db.collection('playlists').aggregate([
                { $match: { access: 'public', name: { $ne: 'Watch Later' }, $or: [{ name: containsRegex }, { tags: containsRegex }] } },
                { $project: { _id: 1, name: 1, owner: 1, video_count: { $cond: { if: { $isArray: '$items' }, then: { $size: '$items' }, else: 0 } } } },
                { $limit: 5 },
            ]).toArray()
        ]);

        // Merge title matches from videos + embed-video, deduped by author/permlink
        // so the same Hive post doesn't appear twice when the indexer has caught up.
        const titleSeen = new Set();
        const allTitles = [];
        for (const d of titles) {
            const k = `${d.author || d.owner || ''}/${d.permlink || ''}`;
            if (titleSeen.has(k)) continue;
            titleSeen.add(k);
            allTitles.push({ type: 'title', text: d.title, author: d.author || d.owner || '', permlink: d.permlink || '' });
            if (allTitles.length >= 5) break;
        }
        for (const d of embedTitles) {
            if (allTitles.length >= 5) break;
            const k = `${d.hive_author || ''}/${d.hive_permlink || ''}`;
            if (titleSeen.has(k)) continue;
            titleSeen.add(k);
            allTitles.push({ type: 'title', text: d.hive_title, author: d.hive_author || '', permlink: d.hive_permlink || '' });
        }

        // Merge tag matches from videos + embed-video, dedup case-insensitively, cap 5.
        const tagSeen = new Set(tags.map(t => t.toLowerCase()));
        const mergedTags = [...tags];
        for (const t of embedTags) {
            if (mergedTags.length >= 5) break;
            if (tagSeen.has(t.toLowerCase())) continue;
            tagSeen.add(t.toLowerCase());
            mergedTags.push(t);
        }

        const suggestions = [
            ...allTitles,
            ...usernames.map(d => ({ type: 'user', username: d.username, display_name: d.display_name || '', profile_image: d.profile_image || '' })),
            ...mergedTags.map(t => ({ type: 'tag', text: t })),
            ...communities.map(d => ({ type: 'community', name: d.name, title: d.title || '', about: d.about || '', subscribers: d.subscribers || 0, num_authors: d.num_authors || 0 })),
            ...playlists.map(d => ({ type: 'playlist', id: d._id, name: d.name || '', owner: d.owner || '', video_count: d.video_count || 0 }))
        ];

        res.json({ success: true, query: q, suggestions });
    } catch (error) {
        console.error('Suggest error:', error);
        res.status(500).json({ success: false, error: 'Suggestion failed' });
    }
});

// GET /search — full-text search
router.get('/', async (req, res) => {
    try {
        const db = getDb();
        const q = (req.query.q || '').trim();
        if (!q) {
            return res.status(400).json({ success: false, error: 'Query parameter "q" is required' });
        }

        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
        const typeParam = req.query.type || 'all';
        const typeSet = typeParam === 'all' ? null : new Set(typeParam.split(',').map(t => t.trim()));
        const wantType = (k) => !typeSet || typeSet.has(k);
        const sort = req.query.sort === 'date' ? 'date' : 'relevance';

        // Optional filters
        const tagFilter = req.query.tag ? req.query.tag.trim().toLowerCase() : null;
        const fromDate = req.query.from ? new Date(req.query.from) : null;
        const toDate = req.query.to ? new Date(req.query.to) : null;
        const communityFilter = req.query.community ? req.query.community.trim() : null;
        const highlight = req.query.highlight !== 'false';

        // Build date filter for MongoDB
        const dateFilter = {};
        if (fromDate && !isNaN(fromDate)) dateFilter.$gte = fromDate;
        if (toDate && !isNaN(toDate)) dateFilter.$lte = toDate;
        const hasDateFilter = Object.keys(dateFilter).length > 0;

        // Search terms for highlighting
        const searchTerms = q.split(/\s+/).filter(t => t.length > 0 && !t.startsWith('-') && !t.startsWith('"'));

        const textQuery = { $text: { $search: q } };
        const scoreSort = { score: { $meta: 'textScore' } };
        const maxPerCollection = Math.max(limit * page * 3, 100);

        const searches = [];

        // Helper: build extra filters for videos collection
        function videoExtraFilters() {
            const extra = {};
            if (tagFilter) extra.tags_v2 = tagFilter;
            if (hasDateFilter) extra.created = dateFilter;
            if (communityFilter) extra.community = communityFilter;
            return extra;
        }

        // Helper: build extra filters for embed-video collection
        function embedExtraFilters() {
            const extra = {};
            if (tagFilter) extra.hive_tags = tagFilter;
            if (hasDateFilter) extra.createdAt = dateFilter;
            if (communityFilter) extra.community = communityFilter;
            return extra;
        }

        // Helper: build extra filters for embed-audio collection
        function audioExtraFilters() {
            const extra = {};
            if (hasDateFilter) extra.createdAt = dateFilter;
            return extra;
        }

        // Videos (non-embed, legacy)
        if (wantType('video')) {
            searches.push(
                db.collection('videos').find({
                    ...feedAgeMatch('created'), ...unavailableMatch(), ...hiddenFromFeedMatch(),
                    ...textQuery,
                    status: 'published',
                    publishFailed: { $ne: true },
                    owner: { $nin: hiddenListSync() },
                    ...nsfwFilterTags(req),
                    ...videoExtraFilters()
                }, { projection: { score: { $meta: 'textScore' }, owner: 1, author: 1, permlink: 1, title: 1, created: 1, created_at: 1, createdAt: 1, duration: 1, tags_v2: 1, thumbnail: 1, images: 1, views: 1 } })
                .sort(scoreSort).limit(maxPerCollection).toArray()
                .then(docs => docs.map(d => ({
                    type: 'video',
                    owner: d.owner,
                    author: d.author || d.owner,
                    permlink: d.permlink,
                    title: d.title || '',
                    created_at: d.created || d.created_at || d.createdAt,
                    duration: d.duration || 0,
                    tags: d.tags_v2 || [],
                    images: {
                        thumbnail: d.thumbnail || d.images?.thumbnail || `https://img.3speak.tv/${d.permlink}/thumbnail.png`,
                        poster: d.images?.poster || `https://img.3speak.tv/${d.permlink}/poster.jpg`
                    },
                    views: d.views || 0,
                    score: d.score
                })))
            );
        }

        // Embed videos (non-shorts)
        if (wantType('video')) {
            searches.push(
                db.collection('embed-video').find({
                    ...feedAgeMatch('createdAt'), ...unavailableMatch(), ...hiddenFromFeedMatch(),
                    ...textQuery,
                    status: 'published',
                    short: false,
                    listed_on_3speak: true,
                    hive_author: { $ne: null, $nin: hiddenListSync() },
                    hive_permlink: { $ne: null },
                    ...nsfwFilterHiveTags(req),
                    ...embedExtraFilters()
                }, { projection: { score: { $meta: 'textScore' }, owner: 1, hive_author: 1, hive_permlink: 1, permlink: 1, hive_title: 1, originalFilename: 1, createdAt: 1, duration: 1, hive_tags: 1, thumbnail_url: 1, views: 1, gated: 1 } })
                .sort(scoreSort).limit(maxPerCollection).toArray()
                .then(docs => docs.map(d => ({
                    type: 'video',
                    owner: d.owner,
                    author: d.hive_author || d.owner,
                    permlink: d.hive_permlink || d.permlink,
                    title: d.hive_title || d.originalFilename || '',
                    created_at: d.createdAt,
                    duration: d.duration || 0,
                    tags: d.hive_tags || [],
                    images: {
                        thumbnail: d.thumbnail_url || `https://img.3speak.tv/${d.permlink}/thumbnail.png`,
                        poster: d.thumbnail_url || `https://img.3speak.tv/${d.permlink}/poster.jpg`
                    },
                    views: d.views || 0,
                    score: d.score
                })))
            );
        }

        // Shorts (embed-video with short: true)
        if (wantType('short')) {
            searches.push(
                db.collection('embed-video').find({
                    ...feedAgeMatch('createdAt'), ...unavailableMatch(), ...hiddenFromFeedMatch(),
                    ...textQuery,
                    status: 'published',
                    short: true,
                    processed: true,
                    embed_url: { $exists: true, $ne: null },
                    hive_author: { $nin: hiddenListSync() },
                    ...nsfwFilterHiveTags(req),
                    ...embedExtraFilters()
                }, { projection: { score: { $meta: 'textScore' }, owner: 1, hive_author: 1, permlink: 1, hive_title: 1, embed_title: 1, originalFilename: 1, createdAt: 1, duration: 1, hive_tags: 1, thumbnail_url: 1, embed_url: 1, views: 1, short: 1, gated: 1 } })
                .sort(scoreSort).limit(maxPerCollection).toArray()
                .then(docs => docs.map(d => ({
                    type: 'short',
                    owner: d.owner,
                    author: d.hive_author || d.owner,
                    permlink: d.permlink,
                    title: d.hive_title || d.embed_title || d.originalFilename || '',
                    created_at: d.createdAt,
                    duration: d.duration || 0,
                    tags: d.hive_tags || [],
                    images: {
                        thumbnail: d.thumbnail_url || `https://img.3speak.tv/${d.permlink}/thumbnail.png`,
                        poster: d.thumbnail_url || `https://img.3speak.tv/${d.permlink}/poster.jpg`
                    },
                    embed_url: d.embed_url,
                    views: d.views || 0,
                    score: d.score
                })))
            );
        }

        // Audio
        if (wantType('audio')) {
            searches.push(
                db.collection('embed-audio').find({
                    ...textQuery,
                    owner: { $nin: hiddenListSync() },
                    ...nsfwFilter(req),
                    ...audioExtraFilters()
                }, { projection: { score: { $meta: 'textScore' }, owner: 1, permlink: 1, title: 1, originalFilename: 1, createdAt: 1, duration: 1, tags: 1 } })
                .sort(scoreSort).limit(maxPerCollection).toArray()
                .then(docs => docs.map(d => ({
                    type: 'audio',
                    owner: d.owner,
                    permlink: d.permlink,
                    title: d.title || d.originalFilename || '',
                    created_at: d.createdAt,
                    duration: d.duration || 0,
                    tags: d.tags ? (Array.isArray(d.tags) ? d.tags : d.tags.split(',').map(t => t.trim())) : [],
                    score: d.score
                })))
            );
        }

        // Communities
        if (wantType('community')) {
            searches.push(
                db.collection('hivecommunities').find(
                    textQuery,
                    { projection: { score: { $meta: 'textScore' }, name: 1, title: 1, about: 1, description: 1, subscribers: 1, num_authors: 1 } }
                )
                .sort(scoreSort).limit(maxPerCollection).toArray()
                .then(docs => docs.map(d => ({
                    type: 'community',
                    name: d.name,
                    title: d.title || '',
                    about: d.about || '',
                    description: d.description || '',
                    subscribers: d.subscribers || 0,
                    num_authors: d.num_authors || 0,
                    score: d.score
                })))
            );
        }

        // User profiles
        if (wantType('user')) {
            searches.push(
                db.collection('hiveprofiles').find(
                    { ...textQuery, username: { $nin: hiddenListSync() } },
                    { projection: { score: { $meta: 'textScore' }, username: 1, display_name: 1, about: 1, location: 1, profile_image: 1, cover_image: 1 } }
                )
                .sort(scoreSort).limit(maxPerCollection).toArray()
                .then(docs => docs.map(d => ({
                    type: 'user',
                    username: d.username,
                    display_name: d.display_name || '',
                    about: d.about || '',
                    location: d.location || '',
                    profile_image: d.profile_image || '',
                    cover_image: d.cover_image || '',
                    score: d.score
                })))
            );
        }

        // Public playlists (excluding Watch Later)
        if (wantType('playlist')) {
            const escapedQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const playlistRegex = { $regex: escapedQ, $options: 'i' };
            searches.push(
                db.collection('playlists').aggregate([
                    { $match: { access: 'public', name: { $ne: 'Watch Later' }, $or: [{ name: playlistRegex }, { tags: playlistRegex }] } },
                    { $project: { _id: 1, name: 1, owner: 1, thumbnail: 1, tags: 1, created_at: 1, video_count: { $cond: { if: { $isArray: '$items' }, then: { $size: '$items' }, else: 0 } } } },
                    { $sort: { created_at: -1 } },
                    { $limit: maxPerCollection },
                ]).toArray()
                .then(docs => docs.map(d => ({
                    type: 'playlist',
                    id: d._id,
                    name: d.name || '',
                    owner: d.owner || '',
                    thumbnail: d.thumbnail || '',
                    tags: d.tags || [],
                    video_count: d.video_count || 0,
                    created_at: d.created_at,
                    score: 1
                })))
            );
        }

        // Subtitle-tags join: find videos matching by AI-generated tags
        if (wantType('video') || wantType('short')) {
            const escapedQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            searches.push(
                db.collection('subtitles-tags').find({
                    tags: { $regex: escapedQ, $options: 'i' }
                }).limit(100).toArray()
                .then(async (tagDocs) => {
                    if (tagDocs.length === 0) return [];

                    const lookups = tagDocs.map(t => ({ owner: t.author, permlink: t.permlink }));

                    const [vids, embeds] = await Promise.all([
                        db.collection('videos').find({
                            ...feedAgeMatch('created'), ...unavailableMatch(), ...hiddenFromFeedMatch(),
                            $or: lookups,
                            status: 'published',
                            publishFailed: { $ne: true },
                            owner: { $nin: hiddenListSync() },
                            ...nsfwFilterTags(req)
                        }, { projection: { owner: 1, author: 1, permlink: 1, title: 1, created: 1, created_at: 1, createdAt: 1, duration: 1, tags_v2: 1, thumbnail: 1, images: 1, views: 1 } }).limit(50).toArray(),
                        db.collection('embed-video').find({
                            ...feedAgeMatch('createdAt'), ...unavailableMatch(), ...hiddenFromFeedMatch(),
                            $or: lookups.map(l => ({ owner: l.owner, permlink: l.permlink })),
                            status: 'published',
                            hive_author: { $nin: hiddenListSync() },
                            ...nsfwFilterHiveTags(req)
                        }, { projection: { owner: 1, hive_author: 1, hive_permlink: 1, permlink: 1, hive_title: 1, embed_title: 1, originalFilename: 1, createdAt: 1, duration: 1, hive_tags: 1, thumbnail_url: 1, embed_url: 1, views: 1, short: 1, gated: 1 } }).limit(50).toArray()
                    ]);

                    const results = [];
                    for (const d of vids) {
                        results.push({
                            type: 'video',
                            owner: d.owner,
                            author: d.author || d.owner,
                            permlink: d.permlink,
                            title: d.title || '',
                            created_at: d.created || d.created_at || d.createdAt,
                            duration: d.duration || 0,
                            tags: d.tags_v2 || d.tags || [],
                            images: {
                                thumbnail: d.thumbnail || d.images?.thumbnail || `https://img.3speak.tv/${d.permlink}/thumbnail.png`,
                                poster: d.images?.poster || `https://img.3speak.tv/${d.permlink}/poster.jpg`
                            },
                            views: d.views || 0,
                            score: 0.5
                        });
                    }
                    for (const d of embeds) {
                        results.push({
                            type: d.short ? 'short' : 'video',
                            owner: d.owner,
                            author: d.hive_author || d.owner,
                            permlink: d.short ? d.permlink : (d.hive_permlink || d.permlink),
                            title: d.hive_title || d.embed_title || d.originalFilename || '',
                            created_at: d.createdAt,
                            duration: d.duration || 0,
                            tags: d.hive_tags || [],
                            images: {
                                thumbnail: d.thumbnail_url || `https://img.3speak.tv/${d.permlink}/thumbnail.png`,
                                poster: d.thumbnail_url || `https://img.3speak.tv/${d.permlink}/poster.jpg`
                            },
                            views: d.views || 0,
                            score: 0.5
                        });
                    }
                    return results;
                })
            );
        }

        // Execute all searches in parallel
        const allResults = (await Promise.all(searches)).flat();

        // Apply score modifiers
        const now = Date.now();
        for (const r of allResults) {
            // Recency boost (sort=date)
            if (sort === 'date' && r.created_at) {
                const ageInDays = (now - new Date(r.created_at).getTime()) / (1000 * 60 * 60 * 24);
                r.score = r.score * Math.max(0.3, 3 - (ageInDays / 30));
            }
            // Popularity boost: views give a mild multiplier (log scale, max ~1.5x)
            if (r.views > 0) {
                r.score = r.score * (1 + Math.min(Math.log10(r.views) / 10, 0.5));
            }
        }

        // Filter by date range (client-side for subtitle-tag results that bypass mongo date filter)
        let filtered = allResults;
        if (hasDateFilter) {
            filtered = allResults.filter(r => {
                if (!r.created_at) return r.type === 'community' || r.type === 'user';
                const d = new Date(r.created_at);
                if (fromDate && !isNaN(fromDate) && d < fromDate) return false;
                if (toDate && !isNaN(toDate) && d > toDate) return false;
                return true;
            });
        }

        // Filter by tag (client-side for subtitle-tag results)
        if (tagFilter) {
            filtered = filtered.filter(r => {
                if (r.type === 'community' || r.type === 'user') return true;
                if (!r.tags) return false;
                return r.tags.some(t => (typeof t === 'string' ? t.toLowerCase() : '') === tagFilter);
            });
        }

        // Deduplicate by type-specific key (text search results take priority via score sort)
        const seen = new Set();
        const deduped = [];
        filtered.sort((a, b) => b.score - a.score);
        for (const r of filtered) {
            let key;
            if (r.type === 'user') key = `user:${r.username}`;
            else if (r.type === 'community') key = `community:${r.name}`;
            else if (r.type === 'playlist') key = `playlist:${r.id}`;
            else key = `${r.type}:${r.owner}:${r.permlink}`;
            if (!seen.has(key)) {
                seen.add(key);
                deduped.push(r);
            }
        }

        // Apply highlighting
        if (highlight && searchTerms.length > 0) {
            for (const r of deduped) {
                if (r.title !== undefined) r.title_highlighted = highlightMatches(r.title, searchTerms);
                if (r.name !== undefined) r.name_highlighted = highlightMatches(r.name, searchTerms);
                if (r.about !== undefined) r.about_highlighted = highlightMatches(r.about, searchTerms);
                if (r.display_name !== undefined) r.display_name_highlighted = highlightMatches(r.display_name, searchTerms);
            }
        }

        const total = deduped.length;
        const totalPages = Math.ceil(total / limit);
        const skip = (page - 1) * limit;
        const paged = deduped.slice(skip, skip + limit);

        res.json({
            success: true,
            query: q,
            sort,
            filters: {
                type: typeParam,
                tag: tagFilter || undefined,
                from: fromDate && !isNaN(fromDate) ? fromDate.toISOString() : undefined,
                to: toDate && !isNaN(toDate) ? toDate.toISOString() : undefined,
                community: communityFilter || undefined
            },
            page,
            limit,
            total,
            totalPages,
            results: paged
        });
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ success: false, error: 'Search failed' });
    }
});

module.exports = router;
