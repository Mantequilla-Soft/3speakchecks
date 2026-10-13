/**
 * RSS Feed Endpoints
 * GET /rss/:username.xml       one feed per channel
 * GET /rss/playlist/:id.xml    one feed per public playlist / album
 * GET /rss/cover/user/:username.jpg, /rss/cover/playlist/:id.jpg
 *                              square JPEG cover art, behind nginx's /img/c/ cache
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

const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const generateXML = require('xml');
const { getDb } = require('../utils/db');
const { hiveRpcBatch } = require('../utils/hive');
const { decodePlaylistMeta } = require('../utils/playlistMeta');
const { renderCover } = require('../utils/podcastCover');

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
// A playlist feed is the whole series (someone subscribing to a 30-day
// challenge wants every day), so it carries far more than a channel feed.
const PLAYLIST_FEED_LIMIT = parseInt(process.env.RSS_PLAYLIST_FEED_LIMIT, 10) || 300;

// Feed covers go through nginx's image cache (snippets/3speak-img.conf,
// /img/c/ -> /rss/cover/ here), which keeps each rendered JPEG on disk.
const COVER_BASE = (process.env.RSS_COVER_BASE_URL || `${PAGE_PROTOCOL}://${DOMAIN_NO_PROTO}/img/c`).replace(/\/$/, '');

// Podcast namespace: <podcast:guid> is a UUIDv5 of the feed URL (no scheme,
// no trailing slash) under this namespace, so it survives a host move.
const PODCAST_GUID_NAMESPACE = 'ead4c236-bf58-58c6-a2c6-a6b28d128cb6';

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
        alternates: [],
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
        alternates: [],
        hls: ev.manifest_cid ? `${HLS_GATEWAY}/${ev.manifest_cid}` : null,
    };
}

// The one content type that is a podcast episode in the literal sense: a single
// audio file, already on a CDN, with a real MIME type.
//
// Browser recordings are WebM, which Apple Podcasts and most classic apps
// refuse. The audio service adds an MP3 companion (mp3_cid) for those; when it
// exists the MP3 is the enclosure and the original rides along as an alternate.
function fromAudio(a) {
    const fmt = String(a.format || '').toLowerCase();
    const original = a.audio_cid
        ? { url: `${AUDIO_CDN}/${a.audio_cid}`, type: AUDIO_MIME[fmt] || 'audio/mpeg', length: parseInt(a.size) || 0 }
        : null;
    const mp3 = a.mp3_cid
        ? { url: `${AUDIO_CDN}/${a.mp3_cid}`, type: 'audio/mpeg', length: parseInt(a.mp3_size) || 0 }
        : null;
    return {
        kind: 'audio',
        medium: a.category === 'song' ? 'music' : 'podcast',
        owner: a.owner,
        // A few rows store "author/permlink"; the watch link wants the bare permlink
        permlink: String(a.post_permlink || '').split('/').pop() || null,
        title: a.title || a.originalFilename || '',
        description: a.description || '',
        created: a.createdAt,
        duration: Math.round(a.mp3_duration || a.duration || 0),
        isNsfw: !!a.isNsfwContent,
        thumb: a.thumbnail_url || `https://images.hive.blog/u/${a.owner}/avatar/large`,
        media: mp3 || original,
        alternates: mp3 && original ? [original] : [],
        hls: null,
    };
}

/** RFC 4122 UUIDv5 (SHA-1, name-based). */
function uuidv5(name, namespace) {
    const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
    const hash = crypto.createHash('sha1').update(Buffer.concat([ns, Buffer.from(name, 'utf8')])).digest();
    hash[6] = (hash[6] & 0x0f) | 0x50;
    hash[8] = (hash[8] & 0x3f) | 0x80;
    const h = hash.subarray(0, 16).toString('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
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
 * Both value blocks (Lightning keysend + HBD transfer) paying `account`.
 * Used at channel level, and per item in a playlist feed for episodes by
 * someone other than the playlist owner, so their tips go to them.
 */
function valueBlocks(account, displayName) {
    return [
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
                                name: displayName,
                                address: '0266ad2656c7a19a219d37e82b280046660f4d7f3ae0c00b64a1629de4ea567668',
                                customKey: '818818',
                                customValue: account,
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
                                address: account,
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
        }
    ];
}

/**
 * Build a single <item> element for one episode. `feedOwner` is the account
 * the channel-level value block pays; an episode by anyone else (only possible
 * in a playlist feed) gets its own author and value block.
 */
function buildItem(video, itunesAuthor, feedOwner) {
    const foreign = feedOwner && video.owner !== feedOwner;
    const itemAuthor = foreign ? video.owner : itunesAuthor;
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
    const alternate = (video.alternates || []).map(alt => ({
        'podcast:alternateEnclosure': [
            { _attr: { type: alt.type, length: alt.length || 0 } },
            { 'podcast:source': { _attr: { uri: alt.url } } },
        ],
    }));
    if (video.hls) {
        alternate.push({
            'podcast:alternateEnclosure': [
                { _attr: { type: 'application/x-mpegURL', default: media ? 'false' : 'true' } },
                { 'podcast:source': { _attr: { uri: video.hls } } },
            ],
        });
    }

    return {
        item: [
            { title: { _cdata: video.title || '' } },
            { 'itunes:author': { _cdata: itemAuthor } },
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
            { 'podcast:medium': video.medium || video.kind },
            ...(video.duration > 0 ? [{ 'itunes:duration': hms(video.duration) }] : []),
            ...enclosure,
            ...alternate,
            ...(foreign ? valueBlocks(video.owner, video.owner) : [])
        ]
    };
}

/**
 * Build the full RSS XML string for a channel, or for a playlist when
 * `feedPath` / `pageLink` / `medium` are given (podcastSettings then carries
 * the playlist's title, description and cover).
 */
function buildFeed({ username, videos, itunesAuthor, podcastSettings, feedPath, pageLink, coverUrl, medium = 'video' }) {
    const feedUrl = `${DOMAIN_NO_PROTO}/${feedPath || `rss/${username}.xml`}`;
    const selfUrl = `${PAGE_PROTOCOL}://${feedUrl}`;
    const link = pageLink || `${PAGE_PROTOCOL}://${DOMAIN_NO_PROTO}/user/${username}`;

    // Channel metadata — podcastSettings can override defaults
    const podcast_title = podcastSettings?.podcast_title || `${username} 3Speak Podcast`;
    const podcast_description =
        podcastSettings?.podcast_description ||
        `Listen and watch the latest videos from ${username}. Hosted by 3Speak.tv. The free speech video platform on the HIVE blockchain.`;
    // coverUrl is the square JPEG Apple Podcasts insists on (see /rss/cover)
    const podcast_image =
        coverUrl ||
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
                    { link },
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
                    // Only on playlist feeds: channel feeds are already listed in
                    // Podcast Index without one, and a guid must never change.
                    ...(feedPath ? [{ 'podcast:guid': uuidv5(feedUrl, PODCAST_GUID_NAMESPACE) }] : []),
                    { 'podcast:hiveAccname': username },
                    { 'podcast:medium': medium },
                    {
                        image: [
                            { url: podcast_image },
                            { title: podcast_title },
                            { link }
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
                    ...valueBlocks(username, itunesAuthor),
                    // Append video items below
                    ...videos.map(v => buildItem(v, itunesAuthor, username))
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

// ─── Shared lookups ──────────────────────────────────────────────────────────

/**
 * Same Hive post in both video collections (an embed upload can leave a legacy
 * row too): keep one, preferring the embed row's newer fields. Newest first.
 */
function mergeEpisodes({ embedRaw, legacyRaw, audioRaw }, limit) {
    const seen = new Set();
    return [
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
        .slice(0, limit);
}

/** Display name from the Hive profile, falling back to the account name. */
async function fetchItunesAuthor(username) {
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
            return meta?.profile?.name || username;
        }
    } catch (err) {
        console.warn(`[RSS] Could not fetch Hive profile for ${username}:`, err.message);
    }
    return username;
}

/** Optional podcast settings (custom title, image, categories etc.) */
async function fetchPodcastSettings(db, username) {
    try {
        return await db.collection('podcastsettings').findOne({ podcast_owner: username });
    } catch {
        // Collection may not exist; fall back to defaults silently
        return null;
    }
}

/** Minimal valid feed for the "nothing to show" cases. */
function emptyFeed(title, link, description) {
    const esc = (t) => String(t).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    return (
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<rss version="2.0"><channel>' +
        `<title>${esc(title)}</title>` +
        `<link>${link}</link>` +
        `<description>${esc(description)}</description>` +
        '</channel></rss>'
    );
}

/** The image a channel cover is rendered from. */
function channelCoverSource(username, podcastSettings) {
    return podcastSettings?.podcast_image || `https://images.hive.blog/u/${username}/avatar/large`;
}

/** The image a playlist cover is rendered from. */
function playlistCoverSource(playlist) {
    const album = decodePlaylistMeta(playlist.metadata)?.album || {};
    return playlist.thumbnail || album.thumbnail || `https://images.hive.blog/u/${playlist.owner}/avatar/large`;
}

/**
 * Send the rendered cover, or redirect to the original if it can't be
 * rendered (host not allowed, source gone, ffmpeg failed) so a feed never
 * shows a broken image. nginx caches either answer; the redirect only briefly.
 */
async function sendCover(res, sourceUrl, label) {
    try {
        const jpeg = await renderCover(sourceUrl);
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.send(jpeg);
    } catch (err) {
        console.warn(`[RSS] Cover for ${label} not rendered (${err.message}), redirecting to source`);
        res.setHeader('Cache-Control', 'public, max-age=300');
        return res.redirect(302, sourceUrl);
    }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

router.get('/cover/user/:username.jpg', async (req, res) => {
    const { username } = req.params;
    if (!username || !/^[a-z0-9.-]{3,16}$/.test(username)) {
        return res.status(400).send('Invalid username');
    }
    try {
        const settings = await fetchPodcastSettings(getDb(), username);
        return await sendCover(res, channelCoverSource(username, settings), `@${username}`);
    } catch (err) {
        console.error(`[RSS] Cover error for @${username}:`, err);
        return res.status(500).send('Internal server error');
    }
});

router.get('/cover/playlist/:id.jpg', async (req, res) => {
    const { id } = req.params;
    if (!id || !/^[a-zA-Z0-9-]{8,64}$/.test(id)) {
        return res.status(400).send('Invalid playlist id');
    }
    try {
        const playlist = await getDb().collection('playlists').findOne({ _id: id });
        if (!playlist || playlist.access !== 'public' || !playlist.owner) {
            return res.status(404).send('Not found');
        }
        return await sendCover(res, playlistCoverSource(playlist), `playlist ${id}`);
    } catch (err) {
        console.error(`[RSS] Cover error for playlist ${id}:`, err);
        return res.status(500).send('Internal server error');
    }
});

/**
 * GET /rss/playlist/:id.xml
 *
 * One feed per public playlist or album, so listeners can follow a single
 * series (a daily show, a 30-day challenge) without the rest of the channel.
 * Episodes by other creators keep their own author and value block.
 */
router.get('/playlist/:id.xml', async (req, res) => {
    const db = getDb();
    const { id } = req.params;

    if (!id || !/^[a-zA-Z0-9-]{8,64}$/.test(id)) {
        return res.status(400).send('Invalid playlist id');
    }

    const pageLink = `${PAGE_PROTOCOL}://${DOMAIN_NO_PROTO}/playlist/${id}`;
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');

    try {
        const playlist = await db.collection('playlists').findOne({ _id: id });
        // Private playlists (and Watch Later) never get a feed
        if (!playlist || playlist.access !== 'public' || !playlist.owner) {
            return res.status(404).send(emptyFeed('Playlist not found', pageLink, 'This playlist does not exist or is private.'));
        }

        const owner = playlist.owner;
        const title = playlist.name || `${owner} playlist`;

        const refs = (playlist.items || [])
            .filter((i) => i && i.author && i.permlink)
            .slice(0, 1000);

        // Banned or hidden creators drop out: the owner takes the whole feed
        // with them, anyone else just loses their episodes.
        const authors = [...new Set([owner, ...refs.map((i) => i.author)])];
        const blocked = new Set(
            (await db.collection('contentcreators')
                .find({ username: { $in: authors }, $or: [{ banned: true }, { hidden: true }] })
                .project({ username: 1 }).toArray()
            ).map((c) => c.username)
        );
        if (blocked.has(owner)) {
            return res.send(emptyFeed(title, pageLink, 'Playlist unavailable.'));
        }
        const live = refs.filter((i) => !blocked.has(i.author));

        let episodes = [];
        if (live.length > 0) {
            const [legacyRaw, embedRaw, audioRaw] = await Promise.all([
                db.collection('videos')
                    .find({ status: 'published', $or: live.map((i) => ({ owner: i.author, permlink: i.permlink })) })
                    .toArray(),
                db.collection('embed-video')
                    .find({ status: 'published', $or: live.map((i) => ({ hive_author: i.author, hive_permlink: i.permlink })) })
                    .toArray(),
                db.collection('embed-audio')
                    .find({
                        status: 'published',
                        $or: live.map((i) => ({ owner: i.author, post_permlink: { $in: [i.permlink, `${i.author}/${i.permlink}`] } })),
                    })
                    .toArray(),
            ]);
            episodes = mergeEpisodes({ embedRaw, legacyRaw, audioRaw }, PLAYLIST_FEED_LIMIT);
        }

        const [itunesAuthor, ownerSettings] = await Promise.all([
            fetchItunesAuthor(owner),
            fetchPodcastSettings(db, owner),
        ]);

        const album = decodePlaylistMeta(playlist.metadata)?.album || {};
        const podcastSettings = {
            podcast_title: title,
            podcast_description: album.description ||
                `${title} by ${itunesAuthor}. Hosted by 3Speak.tv. The free speech video platform on the HIVE blockchain.`,
            podcast_image: playlistCoverSource(playlist),
            podcast_languages: ownerSettings?.podcast_languages,
            podcast_language: ownerSettings?.podcast_language,
            podcast_categories: ownerSettings?.podcast_categories,
        };

        const allAudio = episodes.length > 0 && episodes.every((e) => e.kind === 'audio');
        const allMusic = allAudio && episodes.every((e) => e.medium === 'music');

        res.setHeader('Cache-Control', 'public, max-age=600'); // 10 min cache
        res.send(buildFeed({
            username: owner,
            videos: episodes,
            itunesAuthor,
            podcastSettings,
            feedPath: `rss/playlist/${id}.xml`,
            pageLink,
            coverUrl: `${COVER_BASE}/playlist/${id}.jpg`,
            medium: allMusic ? 'music' : allAudio ? 'podcast' : 'video',
        }));
    } catch (err) {
        console.error(`[RSS] Error generating playlist feed ${id}:`, err);
        res.status(500).send('<?xml version="1.0" encoding="UTF-8"?><error>Internal server error</error>');
    }
});

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

        const videos = mergeEpisodes({ embedRaw, legacyRaw, audioRaw }, FEED_LIMIT);

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

        const itunesAuthor = await fetchItunesAuthor(username);
        const podcastSettings = await fetchPodcastSettings(db, username);

        const feedXml = buildFeed({
            username, videos, itunesAuthor, podcastSettings,
            coverUrl: `${COVER_BASE}/user/${username}.jpg`,
        });

        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=600'); // 10 min cache
        res.send(feedXml);

    } catch (err) {
        console.error(`[RSS] Error generating feed for ${username}:`, err);
        res.status(500).send('<?xml version="1.0" encoding="UTF-8"?><error>Internal server error</error>');
    }
});

module.exports = router;
