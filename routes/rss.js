/**
 * RSS Feed Endpoint
 * GET /rss/:username.xml
 *
 * Generates a valid RSS 2.0 / Podcast Namespace feed for a 3Speak channel.
 * Ported from the legacy frontend's helper/rss.js & routes/index.js.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NGINX PROXY SNIPPET (apply on the 3speak.tv server):
 *
 *   location ~ ^/rss/(.+\.xml)$ {
 *       proxy_pass http://127.0.0.1:<CHECKER_SERVER_PORT>/rss/$1;
 *       proxy_set_header Host $host;
 *       proxy_set_header X-Real-IP $remote_addr;
 *   }
 *
 * Replace <CHECKER_SERVER_PORT> with the port the checker-server runs on.
 * Add this block BEFORE any SPA catch-all location block.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');
const router = express.Router();
const generateXML = require('xml');
const { getDb } = require('../utils/db');
const { hiveRpcBatch } = require('../utils/hive');

// ─── Config ──────────────────────────────────────────────────────────────────
const PAGE_DOMAIN = process.env.RSS_FEED_BASE_URL || 'https://3speak.tv';
const PAGE_PROTOCOL = PAGE_DOMAIN.startsWith('https') ? 'https' : 'http';
const DOMAIN_NO_PROTO = PAGE_DOMAIN.replace(/^https?:\/\//, '');

const VIDEO_CDN = (process.env.VIDEO_CDN_DOMAIN || 'https://threespeakvideo.b-cdn.net').replace(/\/$/, '');
const BUNNY_IPFS_CDN = (process.env.BUNNY_IPFS_CDN || 'https://4everland.io').replace(/\/$/, '');
const IMAGE_CDN = (process.env.IMAGE_CDN_DOMAIN || 'https://images.3speak.tv').replace(/\/$/, '');
// Audio uploads are a single file on IPFS, which is exactly what a podcast
// client wants. Embed-pipeline video is HLS, which most of them can't play —
// see buildItem for how each is offered.
const AUDIO_CDN = (process.env.RSS_AUDIO_CDN || 'https://hotipfs-3speak-1.b-cdn.net/ipfs').replace(/\/$/, '');
const HLS_GATEWAY = (process.env.RSS_HLS_GATEWAY || 'https://ipfs.3speak.tv/ipfs').replace(/\/$/, '');

// Podcast clients key playback off the enclosure's MIME type.
const AUDIO_MIME = {
    mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4',
    aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg',
    opus: 'audio/opus', wav: 'audio/wav', flac: 'audio/flac', webm: 'audio/webm',
};

// How many episodes a feed carries, across all three sources combined.
const FEED_LIMIT = parseInt(process.env.RSS_FEED_LIMIT, 10) || 30;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build the thumbnail URL for a video (mirroring legacy processFeed).
 */
function getThumbnailUrl(video) {
    let baseUrl;
    if (video.upload_type === 'ipfs') {
        baseUrl = `${BUNNY_IPFS_CDN}/ipfs/${(video.thumbnail || '').replace('ipfs://', '')}/`;
    } else if (video.thumbnail && video.thumbnail.includes('ipfs://')) {
        baseUrl = `${BUNNY_IPFS_CDN}/ipfs/${video.thumbnail.replace('ipfs://', '')}/`;
    } else {
        baseUrl = `${IMAGE_CDN}/${video.permlink}/thumbnails/default.png`;
    }

    // Use hive.blog image proxy for resizing
    let b64;
    try {
        b64 = Buffer.from(baseUrl).toString('base64url');
    } catch {
        b64 = Buffer.from(baseUrl).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    }
    const thumbUrl = `https://images.hive.blog/p/${b64}?format=jpeg&mode=cover&width=340&height=191`;
    return { baseThumbUrl: baseUrl, thumbUrl };
}

/**
 * Resolve the playback/download URL for a video file.
 */
function getVideoPlayUrl(video) {
    if (video.filename && video.filename.startsWith('ipfs://')) {
        return `${BUNNY_IPFS_CDN}/ipfs/${video.filename.replace('ipfs://', '')}`;
    }
    if (video.podcast_transfered) {
        return `https://s3.us-west-1.wasabisys.com/podcast-data/${video.permlink}/main.mp4`;
    }
    return `${VIDEO_CDN}/${video.filename}`;
}

/**
 * One episode shape, whatever collection it came from. `media` is a file a
 * podcast client can download and play; `hls` is a stream only the Podcasting
 * 2.0 clients understand. An item may have either, both, or (for older embed
 * uploads with no progressive file) only the stream.
 */
function fromLegacyVideo(v) {
    return {
        kind: 'video',
        owner: v.owner,
        permlink: v.permlink,
        title: v.title || '',
        description: v.description || '',
        created: v.created,
        duration: v.duration || 0,
        isNsfw: !!v.isNsfwContent,
        thumb: getThumbnailUrl(v).baseThumbUrl,
        media: { url: getVideoPlayUrl(v), type: 'video/mp4', length: parseInt(v.size) || 0 },
        hls: null,
    };
}

// Everything published through the embed pipeline since 2026 lives here. The
// feeds read only the legacy `videos` collection before this, which is why they
// went quiet mid-year while the channels kept uploading.
function fromEmbedVideo(ev) {
    return {
        kind: 'video',
        owner: ev.hive_author || ev.owner,
        permlink: ev.hive_permlink,
        title: ev.hive_title || ev.originalFilename || '',
        description: ev.hive_body || '',
        created: ev.createdAt,
        duration: ev.duration || 0,
        isNsfw: !!ev.isNsfwContent,
        thumb: ev.thumbnail_url || `${IMAGE_CDN}/${ev.permlink}/thumbnails/default.png`,
        media: null,                                   // HLS only, no single file
        hls: ev.manifest_cid ? `${HLS_GATEWAY}/${ev.manifest_cid}` : null,
    };
}

// The one content type that is a podcast episode in the literal sense: a single
// audio file, already on a CDN, with a real MIME type.
function fromAudio(a) {
    const fmt = String(a.format || '').toLowerCase();
    return {
        kind: 'audio',
        owner: a.owner,
        permlink: a.post_permlink,
        title: a.title || a.originalFilename || '',
        description: a.description || '',
        created: a.createdAt,
        duration: Math.round(a.duration || 0),
        isNsfw: !!a.isNsfwContent,
        thumb: a.thumbnail_url || `https://images.hive.blog/u/${a.owner}/avatar/large`,
        media: a.audio_cid
            ? { url: `${AUDIO_CDN}/${a.audio_cid}`, type: AUDIO_MIME[fmt] || 'audio/mpeg', length: parseInt(a.size) || 0 }
            : null,
        hls: null,
    };
}

/** hh:mm:ss for <itunes:duration>. */
function hms(totalSeconds) {
    const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/**
 * Build a single <item> element for one episode.
 */
function buildItem(video, itunesAuthor) {
    const baseThumbUrl = video.thumb;
    const watchLink = `${PAGE_PROTOCOL}://${DOMAIN_NO_PROTO}/watch?v=${video.owner}/${video.permlink}`;
    const hiveDomain = 'hive.blog';

    // A stream-only episode still belongs in the feed: RSS readers link it, and
    // Podcasting 2.0 clients can play the alternateEnclosure. Emitting an
    // <enclosure> pointing at an .m3u8 instead would hand every classic client a
    // download it cannot play.
    const media = video.media;
    const enclosure = media
        ? [{ enclosure: { _attr: { url: media.url, length: media.length || 0, type: media.type } } }]
        : [];
    const alternate = video.hls
        ? [{
            'podcast:alternateEnclosure': [
                { _attr: { type: 'application/x-mpegURL', default: media ? 'false' : 'true' } },
                { 'podcast:source': { _attr: { uri: video.hls } } },
            ],
        }]
        : [];

    return {
        item: [
            { title: { _cdata: video.title || '' } },
            { 'itunes:author': { _cdata: itunesAuthor } },
            { 'itunes:episodeType': 'full' },
            { link: watchLink },
            { pubDate: new Date(video.created).toUTCString() },
            { 'dc:creator': video.owner },
            {
                guid: [
                    { _attr: { isPermaLink: 'false' } },
                    `${hiveDomain}/@${video.owner}/${video.permlink}`
                ]
            },
            {
                description: {
                    _cdata: `${watchLink} <br> ${video.description || ''}`
                }
            },
            {
                image: {
                    _attr: {
                        url: baseThumbUrl,
                        title: `${video.title || ''} image`
                    }
                }
            },
            { 'itunes:explicit': video.isNsfw ? 'yes' : 'clean' },
            { 'itunes:image': { _attr: { href: baseThumbUrl } } },
            { 'podcast:medium': video.kind === 'audio' ? 'music' : 'video' },
            ...(video.duration > 0 ? [{ 'itunes:duration': hms(video.duration) }] : []),
            ...enclosure,
            ...alternate
        ]
    };
}

/**
 * Build the full RSS XML string for a channel.
 */
function buildFeed({ username, videos, itunesAuthor, podcastSettings }) {
    const feedUrl = `${DOMAIN_NO_PROTO}/rss/${username}.xml`;
    const selfUrl = `${PAGE_PROTOCOL}://${feedUrl}`;

    // Channel metadata — podcastSettings can override defaults
    const podcast_title = podcastSettings?.podcast_title || `${username} 3Speak Podcast`;
    const podcast_description =
        podcastSettings?.podcast_description ||
        `Listen and watch the latest videos from ${username}. Hosted by 3Speak.tv. The free speech video platform on the HIVE blockchain.`;
    const podcast_image =
        podcastSettings?.podcast_image ||
        `https://images.hive.blog/u/${username}/avatar/large`;
    const podcast_language =
        (podcastSettings?.podcast_languages && podcastSettings.podcast_languages[0]) ||
        podcastSettings?.podcast_language ||
        'en';
    const podcast_categories = podcastSettings?.podcast_categories || [];

    const xml = {
        rss: [
            {
                _attr: {
                    'xmlns:dc': 'http://purl.org/dc/elements/1.1/',
                    'xmlns:content': 'http://purl.org/rss/1.0/modules/content/',
                    'xmlns:atom': 'http://www.w3.org/2005/Atom',
                    version: '2.0',
                    'xmlns:podcast': 'https://podcastindex.org/namespace/1.0',
                    'xmlns:wfw': 'http://wellformedweb.org/CommentAPI/',
                    'xmlns:sy': 'http://purl.org/rss/1.0/modules/syndication/',
                    'xmlns:slash': 'http://purl.org/rss/1.0/modules/slash/',
                    'xmlns:itunes': 'http://www.itunes.com/dtds/podcast-1.0.dtd',
                    'xmlns:googleplay': 'http://www.google.com/schemas/play-podcasts/1.0',
                    'xmlns:georss': 'http://www.georss.org/georss',
                    'xmlns:geo': 'http://www.w3.org/2003/01/geo/wgs84_pos#'
                }
            },
            {
                channel: [
                    { title: { _cdata: podcast_title } },
                    { 'itunes:author': { _cdata: itunesAuthor } },
                    {
                        'itunes:owner': [
                            { 'itunes:name': itunesAuthor },
                            { 'itunes:email': `${username}@3speak.v4v.app` }
                        ]
                    },
                    { 'itunes:explicit': 'clean' },
                    { description: { _cdata: podcast_description } },
                    { link: `${PAGE_PROTOCOL}://${DOMAIN_NO_PROTO}/user/${username}` },
                    // WebSub hub for instant ping propagation
                    {
                        'atom:link': {
                            _attr: {
                                rel: 'hub',
                                href: 'https://hub.livewire.io/'
                            }
                        }
                    },
                    // Self-referential link (required by RSS spec)
                    {
                        'atom:link': {
                            _attr: {
                                href: selfUrl,
                                rel: 'self',
                                type: 'application/rss+xml'
                            }
                        }
                    },
                    { 'podcast:hiveAccname': username },
                    { 'podcast:medium': 'video' },
                    {
                        image: [
                            { url: podcast_image },
                            { title: podcast_title },
                            { link: `${PAGE_PROTOCOL}://${DOMAIN_NO_PROTO}/user/${username}` }
                        ]
                    },
                    { 'itunes:image': { _attr: { href: podcast_image } } },
                    // Podping hive accounts for instant podcast update notifications
                    { 'podcast:podping': { _attr: { hiveAccount: 'podping.spk' } } },
                    { 'podcast:podping': { _attr: { hiveAccount: 'podping.bol' } } },
                    { generator: `${PAGE_PROTOCOL}://${DOMAIN_NO_PROTO}` },
                    { lastBuildDate: new Date().toUTCString() },
                    { copyright: { _cdata: `2021 ${itunesAuthor}` } },
                    { language: podcast_language },
                    { ttl: '60' },
                    // iTunes categories (from podcast settings if available)
                    ...podcast_categories.map(category => ({
                        'itunes:category': { _attr: { text: category } }
                    })),
                    // Value 4 Value — Lightning (keysend)
                    {
                        'podcast:value': [
                            {
                                _attr: {
                                    type: 'lightning',
                                    method: 'keysend',
                                    suggested: '0.00000050000'
                                }
                            },
                            {
                                'podcast:valueRecipient': [
                                    {
                                        _attr: {
                                            name: itunesAuthor,
                                            address: '0266ad2656c7a19a219d37e82b280046660f4d7f3ae0c00b64a1629de4ea567668',
                                            customKey: '818818',
                                            customValue: username,
                                            type: 'node',
                                            split: '99'
                                        }
                                    }
                                ]
                            },
                            {
                                'podcast:valueRecipient': [
                                    {
                                        _attr: {
                                            name: 'PodcastIndex',
                                            address: '03ae9f91a0cb8ff43840e3c322c4c61f019d8c1c3cea15a25cfc425ac605e61a4a',
                                            type: 'node',
                                            fee: 'True',
                                            split: '1'
                                        }
                                    }
                                ]
                            }
                        ]
                    },
                    // Value 4 Value — HBD (Hive transfer)
                    {
                        'podcast:value': [
                            {
                                _attr: {
                                    type: 'HBD',
                                    method: 'transfer',
                                    suggested: '0.05'
                                }
                            },
                            {
                                'podcast:valueRecipient': [
                                    {
                                        _attr: {
                                            name: 'podcaster',
                                            type: 'account',
                                            address: username,
                                            split: '98'
                                        }
                                    }
                                ]
                            },
                            {
                                'podcast:valueRecipient': [
                                    {
                                        _attr: {
                                            name: 'host',
                                            type: 'account',
                                            address: 'threespeak',
                                            split: '1'
                                        }
                                    }
                                ]
                            },
                            {
                                'podcast:valueRecipient': [
                                    {
                                        _attr: {
                                            name: 'podcastindex',
                                            type: 'account',
                                            address: 'podcastindex',
                                            split: '1'
                                        }
                                    }
                                ]
                            }
                        ]
                    },
                    // Append video items below
                    ...videos.map(v => buildItem(v, itunesAuthor))
                ]
            }
        ]
    };

    return (
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<?xml-stylesheet type="text/xsl" href="/rss/feed-stylesheet.xsl"?>' +
        generateXML(xml)
    );
}

// ─── Route ───────────────────────────────────────────────────────────────────

/**
 * GET /rss/:username.xml
 *
 * Returns a Podcast 2.0-compatible RSS feed for the given 3Speak channel.
 * If the user is banned or has no published videos, returns an empty feed.
 */
router.get('/:username.xml', async (req, res) => {
    const db = getDb();
    const { username } = req.params;

    if (!username || !/^[a-zA-Z0-9._-]+$/.test(username)) {
        return res.status(400).send('Invalid username');
    }

    try {
        const videosCollection = db.collection('videos');
        const creatorsCollection = db.collection('contentcreators');
        const settingsCollection = db.collection('podcastsettings');

        // A channel's published work lives in three collections now: the legacy
        // `videos`, everything uploaded through the embed pipeline, and audio.
        // Read all three and merge by date — reading only the first is what left
        // these feeds frozen at whenever a creator last used the old uploader.
        const [legacyRaw, embedRaw, audioRaw] = await Promise.all([
            videosCollection
                .find({ owner: username, status: 'published' })
                .sort({ created: -1 }).limit(FEED_LIMIT).toArray(),
            db.collection('embed-video')
                .find({
                    hive_author: username,
                    status: 'published',
                    short: false,                       // a short is not an episode
                    listed_on_3speak: true,
                    hive_permlink: { $ne: null },
                })
                .sort({ createdAt: -1 }).limit(FEED_LIMIT).toArray(),
            db.collection('embed-audio')
                .find({ owner: username, post_permlink: { $ne: null } })
                .sort({ createdAt: -1 }).limit(FEED_LIMIT).toArray(),
        ]);

        // Same Hive post in both video collections (an embed upload can leave a
        // legacy row too) — keep one, preferring the embed row's newer fields.
        const seen = new Set();
        const videos = [
            ...embedRaw.map(fromEmbedVideo),
            ...legacyRaw.map(fromLegacyVideo),
            ...audioRaw.map(fromAudio),
        ]
            .filter((v) => {
                if (!v.permlink || !v.owner) return false;
                const key = `${v.owner}/${v.permlink}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            })
            .sort((a, b) => new Date(b.created) - new Date(a.created))
            .slice(0, FEED_LIMIT);

        if (videos.length === 0) {
            // No published videos — return a minimal valid empty feed
            res.setHeader('Content-Type', 'application/xml; charset=utf-8');
            res.setHeader('Cache-Control', 'public, max-age=600');
            return res.send(
                '<?xml version="1.0" encoding="UTF-8"?>' +
                '<rss version="2.0"><channel>' +
                `<title>${username} 3Speak Podcast</title>` +
                `<link>${PAGE_PROTOCOL}://${DOMAIN_NO_PROTO}/user/${username}</link>` +
                '<description>No published videos found.</description>' +
                '</channel></rss>'
            );
        }

        // Check if author is banned or hidden — either takes the channel off the feed.
        const creator = await creatorsCollection.findOne({ username });
        if (creator && (creator.banned === true || creator.hidden === true)) {
            res.setHeader('Content-Type', 'application/xml; charset=utf-8');
            return res.send(
                '<?xml version="1.0" encoding="UTF-8"?>' +
                '<rss version="2.0"><channel>' +
                `<title>${username} 3Speak Podcast</title>` +
                `<link>${PAGE_PROTOCOL}://${DOMAIN_NO_PROTO}/user/${username}</link>` +
                '<description>Channel unavailable.</description>' +
                '</channel></rss>'
            );
        }

        // Fetch Hive profile for display name
        let itunesAuthor = username;
        try {
            const hiveResult = await hiveRpcBatch([{
                jsonrpc: '2.0',
                id: 1,
                method: 'condenser_api.get_accounts',
                params: [[username]]
            }]);
            const account = hiveResult?.[0]?.result?.[0];
            if (account) {
                const meta = JSON.parse(account.posting_json_metadata || account.json_metadata || '{}');
                itunesAuthor = meta?.profile?.name || username;
            }
        } catch (err) {
            console.warn(`[RSS] Could not fetch Hive profile for ${username}:`, err.message);
        }

        // Fetch optional podcast settings (custom title, image, categories etc.)
        let podcastSettings = null;
        try {
            podcastSettings = await settingsCollection.findOne({ podcast_owner: username });
        } catch {
            // Collection may not exist; fall back to defaults silently
        }

        const feedXml = buildFeed({ username, videos, itunesAuthor, podcastSettings });

        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=600'); // 10 min cache
        res.send(feedXml);

    } catch (err) {
        console.error(`[RSS] Error generating feed for ${username}:`, err);
        res.status(500).send('<?xml version="1.0" encoding="UTF-8"?><error>Internal server error</error>');
    }
});

module.exports = router;
