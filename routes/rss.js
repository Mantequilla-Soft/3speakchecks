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
 * Build a single <item> element for one video.
 */
function buildItem(video, itunesAuthor) {
    const videoPlayUrl = getVideoPlayUrl(video);
    const { baseThumbUrl } = getThumbnailUrl(video);
    const watchLink = `${PAGE_PROTOCOL}://${DOMAIN_NO_PROTO}/watch?v=${video.owner}/${video.permlink}`;
    const hiveDomain = 'hive.blog';

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
            { 'itunes:explicit': video.isNsfwContent ? 'yes' : 'clean' },
            { 'itunes:image': { _attr: { href: baseThumbUrl } } },
            {
                'enclosure': {
                    _attr: {
                        url: videoPlayUrl,
                        length: parseInt(video.size) || 0,
                        type: 'video/mp4'
                    }
                }
            }
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

        // Fetch up to 15 most recent published videos for the channel
        const videos = await videosCollection
            .find({ owner: username, status: 'published' })
            .sort({ created: -1 })
            .limit(15)
            .toArray();

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
