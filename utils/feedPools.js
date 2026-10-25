/**
 * Viewer-independent candidate pools for the heaviest public feeds:
 * /feeds/trendingSorted, /feeds/new and /shortssorted.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Measured 2026-10-25 from the checker box (Mongo primary at 127ms, see
 * utils/feedCache.js): these routes rebuilt the same candidate set on every request
 * (trendingSorted, new) or on every sorted-list cache miss (shortssorted), and that
 * set IS the expensive part. Full embed-video docs over the far link cost 0.75-1.1s,
 * and the Hive reward lookups 3-8.6s when their own cache is cold. None of it depends
 * on who is asking. Only the nsfw switch changes it, plus the window for shorts.
 *
 * So each set is built once per variant through utils/feedCache.js (stale-while-
 * revalidate, one in-flight load per key), and every per-viewer step (dismissals,
 * watched, interests, follow / premium / retention boosts, pagination) still runs
 * per request. startFeedPoolWarmer() builds the default variants on boot and keeps
 * them fresh, so no viewer pays for a cold pool.
 *
 * ── Rules for callers ────────────────────────────────────────────────────────
 * - Pools are SHARED between requests. Never mutate a pool item: take a shallow
 *   copy (`{ ...v }`) per request. Every ranking helper and the response middleware
 *   (slimFeed, videoStats) only set top-level fields, so a shallow copy is enough.
 * - Hidden creators change live, so callers filter them again per request. The pool
 *   query excludes the ones hidden at load time, matching the old per-request query.
 * - Everything else in the queries (unpublished, unavailable, author opt-out, nsfw
 *   tags) is as old as the pool: its TTL plus one refresh.
 */
const { getCached } = require('./feedCache');
const { feedAgeMatch } = require('./feedAge');
const { unavailableMatch } = require('./unavailable');
const { hiddenFromFeedMatch } = require('./hiddenFromFeed');
const { nsfwFilterTags, nsfwFilterHiveTags } = require('./filters');
const { hiddenListSync } = require('./hiddenCreators');
const { fetchHiveRewards, reputationCache } = require('./hive');
const {
    HIDDEN_AUTHORS, TRENDING_CANDIDATE_LIMIT,
    TRENDING_VIEWS_WEIGHT, TRENDING_VOTES_WEIGHT, TRENDING_COMMENTS_WEIGHT, TRENDING_REWARD_WEIGHT,
    SHORTS_WINDOW_DAYS,
    TRENDING_POOL_CACHE_MS, NEW_POOL_CACHE_MS, NEW_POOL_SIZE, SHORTS_POOL_CACHE_MS,
} = require('./config');

// The nsfw helpers take a request; these stand in for "nsfw off" / "nsfw on".
const NSFW_REQ = {
    off: { query: {}, headers: {} },
    on: { query: { nsfw: 'true' }, headers: {} },
};
const nsfwReq = (allowed) => (allowed ? NSFW_REQ.on : NSFW_REQ.off);
const nsfwTag = (allowed) => (allowed ? 'nsfw' : 'sfw');

// ─── /feeds/trendingSorted ──────────────────────────────────────────────────

/**
 * Trending candidates with live Hive rewards folded into `base_score`, each paired
 * with its HIVE identity (what reshares / playlist saves / viewer tags are keyed by).
 * Returns [{ video, hive: { author, permlink } }].
 */
async function loadTrendingPool(db, nsfwAllowed) {
    const req = nsfwReq(nsfwAllowed);
    const videosCollection = db.collection('videos');
    const embedVideoCollection = db.collection('embed-video');
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Fetch legacy candidate videos (without reward in base_score — reward will be fetched live from Hive)
    const [legacyCandidates, embedCandidatesRaw] = await Promise.all([
        videosCollection.aggregate([
            {
                $match: {
                    status: 'published',
                    owner: { $nin: [...HIDDEN_AUTHORS, ...hiddenListSync()] },
                    publishFailed: { $ne: true },
                    created: { $gte: sevenDaysAgo },
                    // hiddenFromFeed = author opt-out. unavailableMatch mirrors the
                    // embed candidate query below (it was missing on the legacy side
                    // — pre-existing gap). The 7-day window already covers feedAge.
                    ...unavailableMatch(), ...hiddenFromFeedMatch(),
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
            ...feedAgeMatch('createdAt'), ...unavailableMatch(), ...hiddenFromFeedMatch(),
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

    // The HIVE identity of a candidate. Legacy videos post under their own
    // owner/permlink, so that's the fallback when there's no embed doc to map through.
    const hiveKeyOf = (v) => (v._source === 'embed'
        ? { author: v.author, permlink: v.permlink }
        : (hivePermlinkMap.get(`${v.owner}/${v.permlink}`) || { author: v.owner, permlink: v.permlink }));

    return [...legacyCandidates, ...uniqueEmbedCandidates].map((video) => ({ video, hive: hiveKeyOf(video) }));
}

function getTrendingPool(db, nsfwAllowed) {
    return getCached(`pool:trendingSorted:${nsfwTag(nsfwAllowed)}`, TRENDING_POOL_CACHE_MS,
        () => loadTrendingPool(db, nsfwAllowed), []);
}

// ─── /feeds/new ─────────────────────────────────────────────────────────────

/**
 * The newest `n` legacy videos and the newest `n` embed videos, both already in the
 * legacy card shape with a `_sortDate`. Returns { legacy, embed }, each newest first.
 */
async function loadNewSources(db, nsfwAllowed, n) {
    const req = nsfwReq(nsfwAllowed);
    const hidden = [...HIDDEN_AUTHORS, ...hiddenListSync()];

    // Query for new content (exclude first uploads and trending)
    const query = {
        ...feedAgeMatch('created'), ...unavailableMatch(), ...hiddenFromFeedMatch(),
        status: 'published',
        owner: { $nin: hidden },
        firstUpload: { $ne: true },
        trending: { $ne: true },
        publishFailed: { $ne: true },
        ...nsfwFilterTags(req)
    };

    // Fetch legacy and embed videos in parallel
    const [legacyVideos, embedVideosRaw] = await Promise.all([
        db.collection('videos').find(query).sort({ created: -1 }).limit(n).toArray(),
        db.collection('embed-video').find({
            ...feedAgeMatch('createdAt'), ...unavailableMatch(), ...hiddenFromFeedMatch(),
            status: 'published',
            short: false,
            listed_on_3speak: true,
            hive_author: { $nin: [null, ...hidden] },
            hive_permlink: { $ne: null },
            ...nsfwFilterHiveTags(req)
        }).sort({ createdAt: -1 }).limit(n).toArray()
    ]);

    // Transform embed videos to match legacy format
    const embed = embedVideosRaw.map(ev => ({
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
    const legacy = legacyVideos.map(v => ({
        ...v,
        _sortDate: new Date(v.created || v.created_at || 0).getTime()
    }));

    return { legacy, embed };
}

/**
 * The first `n` of each source, as the old per-request query (`.limit(n)`) returned
 * them. Served from the pool when it can answer exactly, from Mongo otherwise.
 * The returned arrays may hold pool items: copy before mutating.
 */
function getNewPool(db, nsfwAllowed) {
    return getCached(`pool:new:${nsfwTag(nsfwAllowed)}`, NEW_POOL_CACHE_MS,
        () => loadNewSources(db, nsfwAllowed, NEW_POOL_SIZE), null);
}

async function getNewSources(db, nsfwAllowed, n) {
    if (n <= NEW_POOL_SIZE) {
        const pool = await getNewPool(db, nsfwAllowed);
        if (pool) {
            const hidden = new Set(hiddenListSync());
            const legacy = pool.legacy.filter((v) => !hidden.has(v.owner));
            const embed = pool.embed.filter((v) => !hidden.has(v.author));
            // A FULL pool may have been cut off by its limit; if a newly hidden creator
            // left it short of `n`, the items that should follow aren't in it. Ask Mongo.
            const cutShort = (all, kept) => all.length >= NEW_POOL_SIZE && kept.length < n;
            if (!cutShort(pool.legacy, legacy) && !cutShort(pool.embed, embed)) {
                return { legacy: legacy.slice(0, n), embed: embed.slice(0, n) };
            }
        }
    }
    return loadNewSources(db, nsfwAllowed, n);
}

// ─── /shortssorted ──────────────────────────────────────────────────────────

/**
 * Every published short inside the window, newest first, with its Hive content data
 * attached. NOT deduplicated and NOT app-filtered: the route does both per request,
 * in the old order (app filter, then dedup, then the reputation drop), so the result
 * is exactly what the old per-miss query produced. `lowRep` holds the shorts whose
 * author was at reputation <= 15 when the pool loaded.
 * Returns { shorts, lowRep: Set }.
 */
async function loadShortsPool(db, windowDays, nsfwAllowed) {
    const windowStart = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    const query = {
        short: true,
        status: 'published',
        processed: true,
        listed_on_3speak: { $ne: false }, // hide unlisted shorts (matches the video feeds)
        embed_url: { $exists: true, $ne: null },
        createdAt: { $gte: windowStart },
        owner: { $nin: [...HIDDEN_AUTHORS, ...hiddenListSync()] },
        // The main /shortssorted feed. hiddenFromFeed = the author's opt-out;
        // unavailableMatch was missing here (the two simpler shorts endpoints in
        // routes/shorts.js both carry it), a pre-existing gap, added for consistency.
        ...unavailableMatch(), ...hiddenFromFeedMatch(),
        ...nsfwFilterHiveTags(nsfwReq(nsfwAllowed))
    };

    // Projected to the fields the pipeline reads: the window is weeks of shorts and
    // the full docs carry a lot this route never looks at. (hive_* are filled from
    // Hive below.)
    const shorts = await db.collection('embed-video')
        .find(query, {
            projection: {
                owner: 1, author: 1, permlink: 1, embed_url: 1, thumbnail_url: 1,
                embed_title: 1, frontend_app: 1, createdAt: 1, views: 1,
            },
        })
        .sort({ createdAt: -1 })
        .toArray();

    // Fetch Hive content data via RPC (extract author/permlink from embed_url "@author/permlink")
    const authorPerms = shorts
        .filter(s => s.embed_url)
        .map(s => {
            const parts = s.embed_url.replace(/^@/, '').split('/');
            return { author: parts[0], permlink: parts[1] };
        });
    // Fetch reward values for sorting (cached 15min)
    const hiveRewards = await fetchHiveRewards(authorPerms);

    // Attach reward + content data to each short and flag low-reputation authors
    const lowRep = new Set();
    for (const short of shorts) {
        if (short.embed_url) {
            const parts = short.embed_url.replace(/^@/, '').split('/');
            const hiveData = hiveRewards.get(`${parts[0]}/${parts[1]}`) || { reward: 0, title: '', body: '', tags: [] };
            short.hive_reward = hiveData.reward;
            short.hive_title = hiveData.title;
            short.hive_body = hiveData.body;
            short.hive_tags = hiveData.tags;
            short.hive_sound = hiveData.sound || null;
            // Authors with reputation <= 15 (spam/low-quality) are dropped by the route
            const cachedRep = reputationCache.get(parts[0]);
            if (cachedRep && cachedRep.reputation <= 15) lowRep.add(short);
        } else {
            short.hive_reward = 0;
            short.hive_title = '';
            short.hive_body = '';
            short.hive_tags = [];
        }
    }

    return { shorts, lowRep };
}

function getShortsPool(db, windowDays, nsfwAllowed) {
    return getCached(`pool:shorts:${windowDays}:${nsfwTag(nsfwAllowed)}`, SHORTS_POOL_CACHE_MS,
        () => loadShortsPool(db, windowDays, nsfwAllowed), { shorts: [], lowRep: new Set() });
}

// ─── Warmer ─────────────────────────────────────────────────────────────────

/**
 * Build the default (nsfw off, main shorts window) pools now, then keep touching them
 * at half their TTL so a stale one refreshes in the background with no viewer
 * waiting on it. Other variants (nsfw on, the longer follow window) warm on first use
 * and are kept fresh by the stale-while-revalidate reads that follow.
 * Call once, after Mongo is connected.
 */
let warming = false;
function startFeedPoolWarmer(getDb) {
    if (warming) return;
    warming = true;
    const every = (ms, fn) => {
        const run = () => Promise.resolve().then(fn).catch((e) => console.warn('[feedPools] warm failed:', e && e.message));
        run();
        const t = setInterval(run, Math.max(5000, Math.floor(ms / 2)));
        if (t.unref) t.unref(); // don't keep the process alive for this
    };
    every(TRENDING_POOL_CACHE_MS, () => getTrendingPool(getDb(), false));
    every(NEW_POOL_CACHE_MS, () => getNewPool(getDb(), false));
    every(SHORTS_POOL_CACHE_MS, () => getShortsPool(getDb(), SHORTS_WINDOW_DAYS, false));
}

module.exports = {
    getTrendingPool, getNewSources, getShortsPool, startFeedPoolWarmer,
    // exported for tests
    loadTrendingPool, loadNewSources, loadShortsPool,
};
