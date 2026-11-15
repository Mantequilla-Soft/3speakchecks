/**
 * RSS Feed Endpoints
 * GET /rss/:username.xml       one feed per channel
 * GET /rss/playlist/:id.xml    one feed per public playlist / album, with the
 *                              episodes of the outside shows it names merged in
 * GET /rss/cover/user/:username.jpg, /rss/cover/playlist/:id.jpg
 *                              square JPEG cover art, behind nginx's /img/c/ cache
 * GET /rss/chapters/:owner/:permlink.json
 *                              an episode's chapters, Podcast Namespace JSON chapters
 * GET /rss/transcript/:owner/:permlink/:lang.srt (.vtt)
 *                              an episode's captions in one language, SRT or WebVTT
 * GET /rss/transcript/:owner/:permlink.txt
 *                              the transcript the audio uploader wrote into the post
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
const { storedPlaylistType, isSeriesPlaylist } = require('../utils/playlistType');
const { parseMeta, seasonEpisodeOf, chaptersOfPost, audiogramOf, transcriptFromBody } = require('../utils/postMeta');
const { liveItemsFor } = require('../utils/liveItems');
const { fetchSubtitleText, CID_RE } = require('./subtitleProxy');
const { RSS_FILES_BASE_URL, RSS_SOUNDBITE_WINDOW_DAYS } = require('../utils/config');
const { playlistFeedRefs, findFeedsFor, threeSpeakRef } = require('../utils/playlistFeeds');
const { renderCover } = require('../utils/podcastCover');
const { createConcurrencyGate } = require('../utils/concurrencyGate');

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

// At most this many feeds build at once, with a short queue behind them (see
// utils/concurrencyGate.js): a podcast-index crawl must never take the whole
// Mongo pool from the rest of the checker. Both feed routes share the one gate.
const feedGate = createConcurrencyGate({
    name: 'rss',
    max: parseInt(process.env.RSS_MAX_CONCURRENT, 10) || 8,
    maxQueue: parseInt(process.env.RSS_MAX_QUEUE, 10) || 32,
    queueTimeoutMs: parseInt(process.env.RSS_QUEUE_TIMEOUT_MS, 10) || 15000,
});

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
        asset: v.permlink,
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
        asset: ev.permlink,
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
        medium: a.category === 'song' || a.category === 'music' ? 'music' : 'podcast',
        owner: a.owner,
        // A few rows store "author/permlink"; the watch link wants the bare permlink
        permlink: String(a.post_permlink || '').split('/').pop() || null,
        title: a.title || a.originalFilename || '',
        description: a.description || '',
        created: a.createdAt,
        duration: Math.round(a.mp3_duration || a.duration || 0),
        isNsfw: !!a.isNsfwContent,
        asset: a.permlink,
        thumb: a.thumbnail_url || `https://images.hive.blog/u/${a.owner}/avatar/large`,
        media: mp3 || original,
        alternates: mp3 && original ? [original] : [],
        hls: null,
    };
}

// Every 3Speak episode is a Hive post, and the post is the record of what the
// creator said about it: chapters, season and episode, the audiogram a Short was
// cut from (utils/postMeta.js). The audio uploader also writes the show notes
// into the post only: the row's `description` has been empty for every upload
// since May 2026, which left those items with nothing but the watch link.
// Cached per post, since a playlist feed can carry 300 of them.
const HIVE_POST_TTL_MS = 60 * 60 * 1000;
const HIVE_POST_CACHE_MAX = 5000;
const hivePostCache = new Map();               // "owner/permlink" -> { at, title, text, chapters, season, episode, transcript, audiogram }

/** A post body as plain show notes: no images, no player link, no markup. */
function showNotesFromBody(body) {
    return String(body || '')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')                       // markdown images
        .replace(/<img[^>]*>/gi, '')
        .replace(/^\s*https?:\/\/audio\.3speak\.tv\/play\S*\s*$/gim, '') // the embedded player
        .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1 $2')                // [text](url) -> text url
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/]]>/g, ']] >')                                   // never close our CDATA
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** What the feeds keep of one post (never the whole body: a transcript can be 40 KB). */
function postFacts(post) {
    const meta = parseMeta(post.json_metadata);
    const { season, episode } = seasonEpisodeOf(meta);
    return {
        title: post.title || '',
        text: showNotesFromBody(post.body),
        // Unfiltered: the duration is the episode's, applied by chaptersFor()
        chapters: chaptersOfPost({ body: post.body, json_metadata: meta }),
        season,
        episode,
        transcript: !!transcriptFromBody(post.body),
        audiogram: audiogramOf(meta),
    };
}

/**
 * The cached facts of these posts ("owner/permlink" keys), reading the missing
 * ones from Hive in batches of 50. A Hive outage leaves them out, never fails.
 */
async function hivePosts(keys) {
    const now = Date.now();
    const missing = [...new Set(keys)].filter((k) => !(now - (hivePostCache.get(k)?.at || 0) < HIVE_POST_TTL_MS));
    for (let i = 0; i < missing.length; i += 50) {
        const chunk = missing.slice(i, i + 50);
        try {
            const results = await hiveRpcBatch(chunk.map((k, n) => ({
                jsonrpc: '2.0', id: n, method: 'condenser_api.get_content', params: k.split('/'),
            })));
            for (const r of results || []) {
                const key = chunk[r?.id];
                const post = r?.result;
                if (!key || !post || !post.author) continue;
                hivePostCache.set(key, { at: now, ...postFacts(post) });
            }
        } catch (err) {
            console.warn('[RSS] Could not read Hive posts for show notes:', err.message);
        }
    }
    while (hivePostCache.size > HIVE_POST_CACHE_MAX) hivePostCache.delete(hivePostCache.keys().next().value);
    const out = new Map();
    for (const k of keys) if (hivePostCache.has(k)) out.set(k, hivePostCache.get(k));
    return out;
}

/** An episode's chapters inside its duration, or [] when fewer than two remain. */
function chaptersFor(chapters, duration) {
    const d = Number(duration) || 0;
    const list = (chapters || []).filter((c) => !(d > 0) || c.start < d);
    return list.length >= 2 ? list : [];
}

/**
 * Each 3Speak episode gets what its post says (chapters, season, episode, a
 * transcript block); audio episodes without a stored description also get the
 * post's title and body as their notes. Mutates and returns `episodes`.
 */
async function withHivePosts(episodes) {
    const own = episodes.filter((e) => !e.outside && e.owner && e.permlink);
    const posts = await hivePosts(own.map((e) => `${e.owner}/${e.permlink}`));
    for (const e of own) {
        const post = posts.get(`${e.owner}/${e.permlink}`);
        if (!post) continue;
        if (e.kind === 'audio' && !e.description) {
            if (post.title) e.title = post.title;
            if (post.text) e.description = post.text.replace(/\n/g, '<br>');
        }
        e.chapters = chaptersFor(post.chapters, e.duration);
        if (post.season != null) e.season = post.season;
        if (post.episode != null) e.episode = post.episode;
        e.hasBodyTranscript = post.transcript;
    }
    return episodes;
}

// ─── Podcasting 2.0 extras: transcripts, soundbites, people, funding ─────────

const MAX_TRANSCRIPT_LANGS = 6;
const MAX_SOUNDBITES = 5;
const EPISODE_LINK_RE = /3speak\.tv\/audio\/([a-z0-9.-]{3,16})\/([a-z0-9-]{1,255})/;

const filesUrl = (path) => `${RSS_FILES_BASE_URL}/${path}`;
const avatarOf = (account) => `https://images.hive.blog/u/${account}/avatar/large`;
const channelLink = (account) => `${PAGE_PROTOCOL}://${DOMAIN_NO_PROTO}/user/${account}`;

/**
 * Captions per episode from the `subtitles` collection ({ author, permlink,
 * subtitles: { <lang>: <cid> } }), filed under the Hive permlink or the upload's
 * own one. Sets `e.captionLangs` (sorted, at most six).
 */
async function withCaptions(db, episodes) {
    const own = episodes.filter((e) => !e.outside && e.owner && e.permlink);
    if (!own.length) return episodes;
    const docs = await db.collection('subtitles')
        .find({ $or: own.map((e) => ({ author: e.owner, permlink: { $in: [...new Set([e.permlink, e.asset].filter(Boolean))] } })) })
        .project({ author: 1, permlink: 1, subtitles: 1 })
        .toArray();
    const byKey = new Map();
    for (const d of docs) {
        const langs = Object.entries(d.subtitles || {})
            .filter(([lang, cid]) => /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(lang) && typeof cid === 'string' && CID_RE.test(cid))
            .map(([lang]) => lang);
        if (langs.length) byKey.set(`${d.author}/${d.permlink}`, langs);
    }
    for (const e of own) {
        const langs = byKey.get(`${e.owner}/${e.permlink}`) || byKey.get(`${e.owner}/${e.asset}`);
        if (langs) e.captionLangs = [...new Set(langs)].sort().slice(0, MAX_TRANSCRIPT_LANGS);
    }
    return episodes;
}

/**
 * Soundbites: the Shorts made from an audiogram of an audio episode (the audio
 * editor posts them with the episode, src/utils/audiogramShorts.js on 3speak.tv).
 * A Short's body links its episode (/audio/<owner>/<permlink>), and its post's
 * json_metadata['3speak'].audiogram says which piece it is; only a Short that
 * records its start time becomes a soundbite. Sets `e.soundbites`.
 */
async function withSoundbites(db, episodes) {
    const audio = episodes.filter((e) => !e.outside && e.kind === 'audio' && e.owner && e.permlink);
    if (!audio.length) return episodes;
    const byKey = new Map(audio.map((e) => [`${e.owner}/${e.permlink}`, e]));
    const oldest = Math.min(...audio.map((e) => new Date(e.created).getTime()).filter(Number.isFinite));
    if (!Number.isFinite(oldest)) return episodes;
    const windowMs = RSS_SOUNDBITE_WINDOW_DAYS * 24 * 3600 * 1000;
    const shorts = await db.collection('embed-video')
        .find({
            hive_author: { $in: [...new Set(audio.map((e) => e.owner))] },
            short: true,
            status: 'published',
            hive_permlink: { $ne: null },
            createdAt: { $gte: new Date(oldest - 3600 * 1000) },
            hive_body: { $regex: '3speak\\.tv/audio/' },
        })
        .project({ hive_author: 1, hive_permlink: 1, hive_body: 1, hive_title: 1, createdAt: 1 })
        .sort({ createdAt: 1 })
        .limit(300)
        .toArray();
    const candidates = [];
    for (const sh of shorts) {
        const m = EPISODE_LINK_RE.exec(String(sh.hive_body || ''));
        const ep = m && byKey.get(`${m[1]}/${m[2]}`);
        if (!ep || ep.owner !== sh.hive_author) continue;
        const after = new Date(sh.createdAt).getTime() - new Date(ep.created).getTime();
        if (!(after > -3600 * 1000 && after < windowMs)) continue;
        candidates.push({ sh, ep });
    }
    if (!candidates.length) return episodes;
    const posts = await hivePosts(candidates.map(({ sh }) => `${sh.hive_author}/${sh.hive_permlink}`));
    for (const { sh, ep } of candidates) {
        const post = posts.get(`${sh.hive_author}/${sh.hive_permlink}`);
        const piece = post && post.audiogram;
        if (!piece || piece.author !== ep.owner || piece.permlink !== ep.permlink) continue;
        if (piece.start == null || piece.duration == null) continue;
        if (ep.duration > 0 && piece.start >= ep.duration) continue;
        ep.soundbites = ep.soundbites || [];
        if (ep.soundbites.length >= MAX_SOUNDBITES) continue;
        ep.soundbites.push({ start: piece.start, duration: piece.duration, title: (post.title || sh.hive_title || '').slice(0, 128) });
    }
    return episodes;
}

/** Captions and soundbites, for the feeds (the share card does not need them). */
async function withFeedExtras(db, episodes) {
    try {
        await withCaptions(db, episodes);
    } catch (err) {
        console.warn('[RSS] Captions not read:', err.message);
    }
    try {
        await withSoundbites(db, episodes);
    } catch (err) {
        console.warn('[RSS] Soundbites not read:', err.message);
    }
    return episodes;
}

/** <podcast:person>: a creator as the host, with their avatar and channel. */
function personTag(account, name, role = 'host') {
    return {
        'podcast:person': [
            { _attr: { role, img: avatarOf(account), href: channelLink(account) } },
            name || account,
        ],
    };
}

/** <podcast:funding>: where to support the channel. Spec: text up to 128 characters. */
function fundingTag(account) {
    return {
        'podcast:funding': [
            { _attr: { url: channelLink(account) } },
            `Support @${account} on 3Speak`.slice(0, 128),
        ],
    };
}

/** The Podcasting 2.0 tags of one 3Speak episode. */
function episodeExtras(video) {
    const out = [];
    if (video.season != null) out.push({ 'itunes:season': video.season }, { 'podcast:season': video.season });
    if (video.episode != null) out.push({ 'itunes:episode': video.episode }, { 'podcast:episode': video.episode });
    const key = `${encodeURIComponent(video.owner)}/${encodeURIComponent(video.permlink)}`;
    if (video.chapters && video.chapters.length >= 2) {
        out.push({ 'podcast:chapters': { _attr: { url: filesUrl(`chapters/${key}.json`), type: 'application/json+chapters' } } });
    }
    for (const lang of video.captionLangs || []) {
        out.push({ 'podcast:transcript': { _attr: { url: filesUrl(`transcript/${key}/${lang}.vtt`), type: 'text/vtt', language: lang, rel: 'captions' } } });
        out.push({ 'podcast:transcript': { _attr: { url: filesUrl(`transcript/${key}/${lang}.srt`), type: 'application/x-subrip', language: lang, rel: 'captions' } } });
    }
    if (video.hasBodyTranscript) {
        out.push({ 'podcast:transcript': { _attr: { url: filesUrl(`transcript/${key}.txt`), type: 'text/plain' } } });
    }
    for (const sb of video.soundbites || []) {
        out.push({
            'podcast:soundbite': [
                { _attr: { startTime: sb.start.toFixed(1), duration: sb.duration.toFixed(1) } },
                ...(sb.title ? [sb.title] : []),
            ],
        });
    }
    return out;
}

/**
 * <podcast:liveItem> for each of the channel's streams (utils/liveItems.js). The
 * live server has no public HLS for a stream, so the enclosure is the watch page
 * (text/html) and <podcast:contentLink> names it; apps that cannot play a page
 * open the link.
 */
function liveItemTags(username, itunesAuthor, items) {
    return (items || []).map((it) => {
        // An audio room (Record as podcast) lives at /openpods/<room>.
        const page = it.kind === 'audio' ? 'openpods' : 'watch';
        const link = it.room && it.status !== 'pending'
            ? `${PAGE_PROTOCOL}://${DOMAIN_NO_PROTO}/${page}/${encodeURIComponent(it.room)}`
            : channelLink(username);
        const attr = { status: it.status, start: it.start };
        if (it.end) attr.end = it.end;
        return {
            'podcast:liveItem': [
                { _attr: attr },
                { title: { _cdata: it.title || `${itunesAuthor} live on 3Speak` } },
                { description: { _cdata: it.description || it.title || `${itunesAuthor} live on 3Speak` } },
                { link },
                { guid: [{ _attr: { isPermaLink: 'false' } }, `${DOMAIN_NO_PROTO}/live/${username}/${it.id}`] },
                { 'itunes:author': { _cdata: itunesAuthor } },
                ...(it.thumb && /^https:\/\//.test(it.thumb) ? [{ 'itunes:image': { _attr: { href: it.thumb } } }] : []),
                personTag(username, itunesAuthor),
                { enclosure: { _attr: { url: link, length: 0, type: 'text/html' } } },
                { 'podcast:contentLink': [{ _attr: { href: link } }, it.kind === 'audio' ? 'Listen on 3Speak' : 'Watch on 3Speak'] },
            ],
        };
    });
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
function buildItem(video, itunesAuthor, feedOwner, everyItemPays = false) {
    if (video.outside) return buildOutsideItem(video);
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
            // The notes alone: apps show the description's opening lines, and the
            // watch link is already the item's <link>. Link only when there are none.
            { description: { _cdata: video.description || watchLink } },
            {
                image: {
                    _attr: {
                        url: baseThumbUrl,
                        title: `${video.title || ''} image`
                    }
                }
            },
            { 'itunes:explicit': video.isNsfw ? 'yes' : 'clean' },
            // Square JPEG for Apple (16:9 thumbnails are fitted, not cropped);
            // the plain <image> above keeps the original.
            { 'itunes:image': { _attr: { href: episodeCoverLink(video) || baseThumbUrl } } },
            { 'podcast:medium': video.medium || video.kind },
            ...(video.duration > 0 ? [{ 'itunes:duration': hms(video.duration) }] : []),
            ...enclosure,
            ...alternate,
            ...episodeExtras(video),
            // Someone else's episode in a playlist feed: they are its host.
            ...(foreign ? [personTag(video.owner, video.owner)] : []),
            ...(foreign || everyItemPays ? valueBlocks(video.owner, foreign ? video.owner : itunesAuthor) : [])
        ]
    };
}

/** An outside show's Lightning value block (utils/podcastParse.js valueOf) as XML. */
function outsideValueBlock(value) {
    if (!value || !Array.isArray(value.recipients) || !value.recipients.length) return [];
    const attr = { type: 'lightning', method: value.method || 'keysend' };
    if (value.suggested) attr.suggested = String(value.suggested);
    return [{
        'podcast:value': [
            { _attr: attr },
            ...value.recipients.map((r) => {
                const a = { name: r.name || '', type: r.type, address: r.address, split: String(r.split) };
                if (r.customKey) a.customKey = r.customKey;
                if (r.customValue) a.customValue = r.customValue;
                if (r.fee) a.fee = 'true';
                return { 'podcast:valueRecipient': { _attr: a } };
            }),
        ],
    }];
}

/**
 * An episode of an outside show in a playlist feed: passed on as its own feed has
 * it (guid, file, link) with the show's value block, so a boost goes to that show.
 * Without one it has none: the playlist feed then carries no channel-level block
 * either (buildFeed `everyItemPays`), so the item never inherits the owner's.
 */
function buildOutsideItem(ep) {
    return {
        item: [
            { title: { _cdata: ep.title || '' } },
            { 'itunes:author': { _cdata: ep.author || '' } },
            { 'itunes:episodeType': 'full' },
            ...(ep.link ? [{ link: ep.link }] : []),
            { pubDate: new Date(ep.created).toUTCString() },
            { guid: [{ _attr: { isPermaLink: 'false' } }, ep.guid] },
            { description: { _cdata: ep.description || ep.title || '' } },
            ...(ep.thumb ? [{ 'itunes:image': { _attr: { href: ep.thumb } } }] : []),
            ...(ep.duration > 0 ? [{ 'itunes:duration': hms(ep.duration) }] : []),
            { enclosure: { _attr: { url: ep.media.url, length: ep.media.length || 0, type: ep.media.type } } },
            ...outsideValueBlock(ep.value),
        ]
    };
}

/**
 * Build the full RSS XML string for a channel, or for a playlist when
 * `feedPath` / `pageLink` / `medium` are given (podcastSettings then carries
 * the playlist's title, description and cover).
 */
function buildFeed({ username, videos, itunesAuthor, podcastSettings, feedPath, pageLink, coverUrl, medium = 'video', everyItemPays = false, liveItems = [] }) {
    const feedUrl = `${DOMAIN_NO_PROTO}/${feedPath || `rss/${username}.xml`}`;
    const selfUrl = `${PAGE_PROTOCOL}://${feedUrl}`;
    const link = pageLink || `${PAGE_PROTOCOL}://${DOMAIN_NO_PROTO}/user/${username}`;

    // Channel metadata — podcastSettings can override defaults
    const podcast_title = podcastSettings?.podcast_title || `${username} 3Speak Podcast`;
    const podcast_description =
        podcastSettings?.podcast_description ||
        `Listen and watch the latest videos from ${username}. Hosted by 3Speak.tv, the free speech video platform.`;
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
                    // The channel (or playlist owner) as the host, and where to support them.
                    personTag(username, itunesAuthor),
                    fundingTag(username),
                    // A playlist with outside shows in it: each item names who it pays.
                    ...(everyItemPays ? [] : valueBlocks(username, itunesAuthor)),
                    // The channel's streams: live now, coming up, just ended
                    ...liveItemTags(username, itunesAuthor, liveItems),
                    // Append video items below
                    ...videos.map(v => buildItem(v, itunesAuthor, username, everyItemPays))
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

/**
 * Cover URL for a feed. The ?v= tag is a hash of the source image, so a new
 * cover is a new URL for Cloudflare and podcast apps (nginx caches by path
 * only, so made-up tags can't trigger extra renders).
 */
function coverLink(kind, key, sourceUrl) {
    const v = crypto.createHash('sha1').update(String(sourceUrl)).digest('hex').slice(0, 8);
    return `${COVER_BASE}/${kind}/${encodeURIComponent(key)}.jpg?v=${v}`;
}

/** Episode art link for one item, or null when it has no thumbnail. */
function episodeCoverLink(video) {
    if (!video.thumb || !video.owner || !video.permlink) return null;
    const v = crypto.createHash('sha1').update(String(video.thumb)).digest('hex').slice(0, 8);
    return `${COVER_BASE}/episode/${encodeURIComponent(video.owner)}/${encodeURIComponent(video.permlink)}.jpg?v=${v}`;
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
async function sendCover(res, sourceUrl, label, fit = 'crop') {
    try {
        const jpeg = await renderCover(sourceUrl, { fit });
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

/** One episode by its Hive post, from the same three collections the feeds read, or null. */
async function findEpisode(db, owner, permlink, { publishedAudioOnly = false } = {}) {
    const [audio, embed, legacy] = await Promise.all([
        db.collection('embed-audio').findOne({
            owner, post_permlink: { $in: [permlink, `${owner}/${permlink}`] }, ...(publishedAudioOnly ? { status: 'published' } : {}),
        }),
        db.collection('embed-video').findOne({ hive_author: owner, hive_permlink: permlink, status: 'published' }),
        db.collection('videos').findOne({ owner, permlink, status: 'published' }),
    ]);
    return (embed && fromEmbedVideo(embed)) || (legacy && fromLegacyVideo(legacy)) || (audio && fromAudio(audio)) || null;
}

/** A banned or hidden creator's episode files are as gone as their feed. */
async function creatorBlocked(db, owner) {
    const c = await db.collection('contentcreators').findOne({ username: owner, $or: [{ banned: true }, { hidden: true }] }, { projection: { _id: 1 } });
    return !!c;
}

const OWNER_RE = /^[a-z0-9.-]{3,16}$/;
const PERMLINK_RE = /^[a-z0-9-]{1,255}$/;

/**
 * GET /rss/chapters/:owner/:permlink.json
 *
 * The episode's chapters in the Podcast Namespace JSON chapters format
 * (version 1.2.0, startTime in seconds), what <podcast:chapters> links. From
 * the post: the timeline's chapters, else the timestamped list in its text.
 */
router.get('/chapters/:owner/:permlink.json', async (req, res) => {
    const { owner, permlink } = req.params;
    if (!OWNER_RE.test(owner) || !PERMLINK_RE.test(permlink)) return res.status(400).json({ error: 'Invalid episode' });
    try {
        const db = getDb();
        const episode = await findEpisode(db, owner, permlink, { publishedAudioOnly: true });
        if (!episode || await creatorBlocked(db, owner)) return res.status(404).json({ error: 'Not found' });
        const post = (await hivePosts([`${owner}/${permlink}`])).get(`${owner}/${permlink}`);
        const chapters = chaptersFor(post && post.chapters, episode.duration);
        if (!chapters.length) return res.status(404).json({ error: 'No chapters' });
        res.setHeader('Content-Type', 'application/json+chapters; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        return res.send(JSON.stringify({
            version: '1.2.0',
            ...(post.title ? { title: post.title } : {}),
            chapters: chapters.map((c) => ({ startTime: c.start, title: c.title || `${Math.floor(c.start / 60)}:${String(c.start % 60).padStart(2, '0')}` })),
        }));
    } catch (err) {
        console.error(`[RSS] Chapters error for ${owner}/${permlink}:`, err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

/** SRT as WebVTT: a header, and a dot before the milliseconds. */
function srtToVtt(srt) {
    const body = String(srt || '').replace(/\r\n?/g, '\n')
        .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
        .trim();
    return `WEBVTT\n\n${body}\n`;
}

/**
 * GET /rss/transcript/:owner/:permlink/:lang.srt and .vtt
 *
 * The episode's captions in one language (the `subtitles` collection, filed
 * under the Hive permlink or the upload's own), as SRT or converted to WebVTT.
 */
async function sendCaptions(req, res, format) {
    const { owner, permlink, lang } = req.params;
    if (!OWNER_RE.test(owner) || !PERMLINK_RE.test(permlink) || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(lang)) {
        return res.status(400).send('Invalid transcript');
    }
    try {
        const db = getDb();
        const episode = await findEpisode(db, owner, permlink, { publishedAudioOnly: true });
        if (!episode || await creatorBlocked(db, owner)) return res.status(404).send('Not found');
        const doc = await db.collection('subtitles').findOne(
            { author: owner, permlink: { $in: [...new Set([permlink, episode.asset].filter(Boolean))] }, [`subtitles.${lang}`]: { $type: 'string' } },
            { projection: { subtitles: 1 } },
        );
        const cid = doc && doc.subtitles && doc.subtitles[lang];
        if (!cid || !CID_RE.test(cid)) return res.status(404).send('Not found');
        const got = await fetchSubtitleText(cid);
        if (got.text == null) return res.status(502).send('Transcript not reachable');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        if (format === 'vtt') return res.type('text/vtt; charset=utf-8').send(srtToVtt(got.text));
        return res.type('application/x-subrip; charset=utf-8').send(got.text);
    } catch (err) {
        console.error(`[RSS] Transcript error for ${owner}/${permlink}/${lang}:`, err);
        return res.status(500).send('Internal server error');
    }
}
router.get('/transcript/:owner/:permlink/:lang.srt', (req, res) => sendCaptions(req, res, 'srt'));
router.get('/transcript/:owner/:permlink/:lang.vtt', (req, res) => sendCaptions(req, res, 'vtt'));

/**
 * GET /rss/transcript/:owner/:permlink.txt
 *
 * The transcript the audio uploader put into the post ("Make a transcript"),
 * as plain text. Read from Hive each time (cached by nginx and apps), since a
 * transcript is far too big for the feeds' post cache.
 */
router.get('/transcript/:owner/:permlink.txt', async (req, res) => {
    const { owner, permlink } = req.params;
    if (!OWNER_RE.test(owner) || !PERMLINK_RE.test(permlink)) return res.status(400).send('Invalid transcript');
    try {
        const db = getDb();
        const episode = await findEpisode(db, owner, permlink, { publishedAudioOnly: true });
        if (!episode || await creatorBlocked(db, owner)) return res.status(404).send('Not found');
        const [r] = await hiveRpcBatch([{ jsonrpc: '2.0', id: 0, method: 'condenser_api.get_content', params: [owner, permlink] }]);
        const text = transcriptFromBody(r && r.result && r.result.body);
        if (!text) return res.status(404).send('Not found');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        return res.type('text/plain; charset=utf-8').send(`${text.replace(/\*\*/g, '')}\n`);
    } catch (err) {
        console.error(`[RSS] Transcript error for ${owner}/${permlink}:`, err);
        return res.status(500).send('Internal server error');
    }
});

// Episode art: resolved from the post itself (never from a URL in the
// request), across the same three collections the feeds read.
router.get('/cover/episode/:owner/:permlink.jpg', async (req, res) => {
    const { owner, permlink } = req.params;
    if (!/^[a-z0-9.-]{3,16}$/.test(owner) || !/^[a-z0-9-]{1,255}$/.test(permlink)) {
        return res.status(400).send('Invalid episode');
    }
    try {
        const episode = await findEpisode(getDb(), owner, permlink);
        if (!episode || !episode.thumb) return res.status(404).send('Not found');
        return await sendCover(res, episode.thumb, `episode ${owner}/${permlink}`, 'fit');
    } catch (err) {
        console.error(`[RSS] Cover error for episode ${owner}/${permlink}:`, err);
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
 * A public playlist with its items resolved to episodes, for the feed and the
 * share card alike.
 *
 * Null when it does not exist or is private (Watch Later included): neither a
 * feed nor a link preview may show it. `blocked` when its owner is banned or
 * hidden, who takes the whole playlist with them; anyone else just loses their
 * own items (`live` is what is left).
 */
async function loadPublicPlaylist(db, id) {
    const playlist = await db.collection('playlists').findOne({ _id: id });
    if (!playlist || playlist.access !== 'public' || !playlist.owner) return null;

    const owner = playlist.owner;
    const refs = (playlist.items || [])
        .filter((i) => i && i.author && i.permlink)
        .slice(0, 1000);

    const authors = [...new Set([owner, ...refs.map((i) => i.author)])];
    const blocked = new Set(
        (await db.collection('contentcreators')
            .find({ username: { $in: authors }, $or: [{ banned: true }, { hidden: true }] })
            .project({ username: 1 }).toArray()
        ).map((c) => c.username)
    );
    if (blocked.has(owner)) return { playlist, blocked: true, live: [], episodes: [] };
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
        episodes = await withHivePosts(mergeEpisodes({ embedRaw, legacyRaw, audioRaw }, PLAYLIST_FEED_LIMIT));
    }
    return { playlist, blocked: false, live, episodes };
}

/**
 * The newest episodes of the outside shows a playlist names (utils/playlistFeeds.js),
 * shaped like the 3Speak episodes so they merge by date. `outside` marks them for
 * buildItem; `ref` is the 3Speak post one links to, when it does.
 */
async function loadOutsideEpisodes(db, playlist, limit) {
    const refs = playlistFeedRefs(playlist);
    if (!refs.length) return [];
    const byKey = await findFeedsFor(db, refs, { title: 1, author: 1, image: 1, link: 1, value: 1 });
    const feeds = new Map([...byKey.values()].map((f) => [f._id.toHexString(), f]));
    if (!feeds.size) return [];
    const rows = await db.collection('podcast_episodes')
        .find({ feed_id: { $in: [...feeds.values()].map((f) => f._id) }, published_at: { $type: 'date' }, private: { $ne: true } },
            { projection: { chapters_inline: 0, persons: 0, soundbites: 0, transcripts: 0 } })
        .sort({ published_at: -1 }).limit(limit).toArray();
    return rows.map((e) => {
        const feed = feeds.get(e.feed_id.toHexString()) || {};
        return {
            outside: true,
            kind: 'audio',
            medium: 'podcast',
            title: e.title || '',
            author: feed.author || feed.title || '',
            description: e.summary || '',
            created: e.published_at,
            duration: Math.round(e.duration || 0),
            thumb: e.image || feed.image || '',
            link: e.link || feed.link || '',
            guid: e.guid || e.audio_url,
            media: { url: e.audio_url, type: e.mime || 'audio/mpeg', length: e.bytes || 0 },
            value: e.value || feed.value || null,
            ref: threeSpeakRef(e.link),
        };
    });
}

/** The playlist's own episodes and its outside shows' ones, newest first; a 3Speak post only once. */
function mergeOutside(episodes, outside, limit) {
    if (!outside.length) return episodes;
    const have = new Set(episodes.map((e) => `${e.owner}/${e.permlink}`));
    return [...episodes, ...outside.filter((e) => !e.ref || !have.has(e.ref))]
        .sort((a, b) => new Date(b.created) - new Date(a.created))
        .slice(0, limit);
}

/**
 * Episode numbers for a playlist whose order is the order of its parts: a
 * series (a numbered set of Shorts or videos) or a music album. The first item
 * is episode 1. An episode whose own post names its number keeps it, and a
 * playlist in no particular order (a channel's picks, a daily show added newest
 * first) gets no numbers at all. Mutates `episodes`.
 */
function numberByPosition(playlist, refs, episodes) {
    const stored = storedPlaylistType(playlist);
    if (!isSeriesPlaylist(playlist) && stored.kind !== 'music') return episodes;
    const order = [...refs].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const rank = new Map(order.map((r, i) => [`${r.author}/${r.permlink}`, i + 1]));
    for (const e of episodes) {
        if (e.outside || e.episode != null) continue;
        const n = rank.get(`${e.owner}/${e.permlink}`);
        if (n) e.episode = n;
    }
    return episodes;
}

/**
 * The feed's medium: the type the owner picked (utils/playlistType.js), else
 * worked out from what the episodes are. Voice notes and other sounds go out
 * as `podcast`, the nearest medium the podcast namespace has.
 */
function playlistMedium(episodes, playlist) {
    const allAudio = episodes.length > 0 && episodes.every((e) => e.kind === 'audio');
    const allMusic = allAudio && episodes.every((e) => e.medium === 'music');
    const stored = storedPlaylistType(playlist);
    if (stored.type === 'video') return 'video';
    if (stored.type === 'audio') {
        if (stored.kind) return stored.kind === 'music' ? 'music' : 'podcast';
        return allMusic ? 'music' : 'podcast';
    }
    return allMusic ? 'music' : allAudio ? 'podcast' : 'video';
}

/**
 * GET /rss/playlist/:id/card.json
 *
 * What a link preview needs: name, owner, description, cover and the first
 * 20 items in the playlist's own order. The OG prerender (3speak.tv's server/og-server.cjs) builds the
 * Discord / X / WhatsApp card for /playlist/:id from this. It lives here
 * because the playlists API the site reads does not pass covers or album
 * details through; this collection is the one place that has them.
 *
 * Cover: the playlist's own, else the thumbnail of the item ADDED most
 * recently. That changes as the playlist grows, which is intended: the card
 * shows what is new in it.
 */
router.get('/playlist/:id/card.json', async (req, res) => {
    const { id } = req.params;
    if (!id || !/^[a-zA-Z0-9-]{8,64}$/.test(id)) {
        return res.status(400).json({ error: 'Invalid playlist id' });
    }
    try {
        const loaded = await loadPublicPlaylist(getDb(), id);
        if (!loaded || loaded.blocked) return res.status(404).json({ error: 'Playlist not found' });
        const { playlist, live, episodes } = loaded;

        const album = decodePlaylistMeta(playlist.metadata)?.album || {};
        const byKey = new Map(episodes.map((e) => [`${e.owner}/${e.permlink}`, e]));
        // added_at is unix seconds from the indexer and a Date from older writers.
        const addedMs = (i) => {
            const t = i.added_at;
            if (typeof t === 'number') return t < 1e12 ? t * 1000 : t;
            return Date.parse(t) || 0;
        };
        const newestFirst = [...live]
            .sort((a, b) => addedMs(b) - addedMs(a))
            .map((i) => ({ ref: i, ep: byKey.get(`${i.author}/${i.permlink}`) }))
            .filter((x) => x.ep);

        const latestWithThumb = newestFirst.find((x) => x.ep.thumb && !x.ep.isNsfw);
        // Listed in the playlist's own order, as the page shows it (an album's
        // track order matters); only the cover goes by when items were added.
        const inOrder = [...newestFirst].sort((a, b) => (a.ref.position ?? 0) - (b.ref.position ?? 0));
        const own = playlist.thumbnail || album.thumbnail || null;

        res.setHeader('Cache-Control', 'public, max-age=300');
        return res.json({
            id,
            name: playlist.name || `${playlist.owner} playlist`,
            owner: playlist.owner,
            medium: playlistMedium(episodes, playlist),
            description: album.description || null,
            album: (album.musicStyle || album.year || album.label || album.credits)
                ? {
                    musicStyle: album.musicStyle || null,
                    year: album.year || null,
                    label: album.label || null,
                    credits: album.credits || null,
                }
                : null,
            cover: own || (latestWithThumb && latestWithThumb.ep.thumb) || null,
            coverFrom: own ? 'playlist' : latestWithThumb ? 'latest-item' : null,
            itemCount: newestFirst.length,
            updatedAt: playlist.updated_at || null,
            items: inOrder.slice(0, 20).map(({ ref, ep }) => ({
                position: ref.position ?? null,
                author: ref.author,
                permlink: ref.permlink,
                kind: ep.kind,
                title: ep.title,
                duration: ep.duration || 0,
                thumb: ep.isNsfw ? null : (ep.thumb || null),
                addedAt: new Date(addedMs(ref)).toISOString(),
            })),
        });
    } catch (err) {
        console.error(`[RSS] Error building playlist card ${id}:`, err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /rss/playlist/:id.xml
 *
 * One feed per public playlist or album, so listeners can follow a single
 * series (a daily show, a 30-day challenge) without the rest of the channel.
 * Episodes by other creators keep their own author and value block.
 */
router.get('/playlist/:id.xml', feedGate, async (req, res) => {
    const db = getDb();
    const { id } = req.params;

    if (!id || !/^[a-zA-Z0-9-]{8,64}$/.test(id)) {
        return res.status(400).send('Invalid playlist id');
    }

    const pageLink = `${PAGE_PROTOCOL}://${DOMAIN_NO_PROTO}/playlist/${id}`;
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');

    try {
        const loaded = await loadPublicPlaylist(db, id);
        // Private playlists (and Watch Later) never get a feed
        if (!loaded) {
            return res.status(404).send(emptyFeed('Playlist not found', pageLink, 'This playlist does not exist or is private.'));
        }
        const { playlist } = loaded;
        const owner = playlist.owner;
        const title = playlist.name || `${owner} playlist`;

        // Banned or hidden creators drop out: the owner takes the whole feed
        // with them, anyone else just loses their episodes.
        if (loaded.blocked) {
            return res.send(emptyFeed(title, pageLink, 'Playlist unavailable.'));
        }

        const [itunesAuthor, ownerSettings, outside] = await Promise.all([
            fetchItunesAuthor(owner),
            fetchPodcastSettings(db, owner),
            loadOutsideEpisodes(db, playlist, PLAYLIST_FEED_LIMIT),
        ]);
        const episodes = mergeOutside(loaded.episodes, outside, PLAYLIST_FEED_LIMIT);
        numberByPosition(playlist, loaded.live, episodes);
        await withFeedExtras(db, episodes);

        const album = decodePlaylistMeta(playlist.metadata)?.album || {};
        const podcastSettings = {
            podcast_title: title,
            podcast_description: album.description ||
                `${title} by ${itunesAuthor}. Hosted by 3Speak.tv, the free speech video platform.`,
            podcast_image: playlistCoverSource(playlist),
            podcast_languages: ownerSettings?.podcast_languages,
            podcast_language: ownerSettings?.podcast_language,
            podcast_categories: ownerSettings?.podcast_categories,
        };

        res.setHeader('Cache-Control', 'public, max-age=600'); // 10 min cache
        res.send(buildFeed({
            username: owner,
            videos: episodes,
            itunesAuthor,
            podcastSettings,
            feedPath: `rss/playlist/${id}.xml`,
            pageLink,
            coverUrl: coverLink('playlist', id, playlistCoverSource(playlist)),
            medium: playlistMedium(episodes, playlist),
            everyItemPays: outside.length > 0,
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
router.get('/:username.xml', feedGate, async (req, res) => {
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
                // Published only, like the playlist feed and GET /audio: a deleted
                // or failed upload is not an episode.
                .find({ owner: username, status: 'published', post_permlink: { $ne: null } })
                .sort({ createdAt: -1 }).limit(FEED_LIMIT).toArray(),
        ]);

        const videos = await withHivePosts(mergeEpisodes({ embedRaw, legacyRaw, audioRaw }, FEED_LIMIT));

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

        const [itunesAuthor, podcastSettings, liveItems] = await Promise.all([
            fetchItunesAuthor(username),
            fetchPodcastSettings(db, username),
            liveItemsFor(username).catch(() => []),
            withFeedExtras(db, videos),
        ]);

        const feedXml = buildFeed({
            username, videos, itunesAuthor, podcastSettings, liveItems,
            coverUrl: coverLink('user', username, channelCoverSource(username, podcastSettings)),
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
// Tests only: forget the cached Hive posts.
module.exports._clearPostCache = () => hivePostCache.clear();
