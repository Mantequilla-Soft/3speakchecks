/**
 * "Made from this": what a 3Speak post was made from, read from its own Hive
 * record (body + json_metadata), for routes/derived.js.
 *
 * Every derived post now says so in one place:
 *
 *   json_metadata['3speak'].source = { kind, author, permlink, start?, end? }
 *
 * (3speak.tv src/lib/derived.js writes it). Posts from before that carry only
 * their feature's own marker, which is read the same way:
 *
 *   audiogram     '3speak'.audiogram { author, permlink, start?, duration? }
 *                 a Short cut from an audio episode (the audio editor)
 *   stream_clip   video.streamClip { room, host, offset? }: a clip of a live
 *                 stream; its VOD is the Hive post host/room (hangouts
 *                 lib/streamVodPublish.ts publishes it under the room name)
 *   clip / remix  video.remixChain[0] (nearest first) or video.originalAuthor +
 *                 originalPermlink: a Short made from a video. The creator's own
 *                 video is a clip, anybody else's a remix
 *   narration     '3speak'.tts.source "author/permlink": a written post read out
 *   reaction      a reply tagged `reaction` that carries a video: a reaction to
 *                 its parent, at json_metadata.parentTimestamp when set
 *
 * Nothing on chain checks json_metadata, so every value is validated and a bad
 * one makes the whole source null.
 */

const ACCOUNT_RE = /^[a-z][a-z0-9.-]{2,15}$/;
const PERMLINK_RE = /^[a-z0-9-]{1,255}$/;
const MAX_SECONDS = 24 * 3600;
const MAX_TITLE = 120;

/**
 * Every kind a derived post can be. The ones not written yet are reserved for the
 * features that will write them: recap (a stream's highlight reel), audio_version
 * (a video published again as an audio episode), quote (a quote card from a
 * transcript line), teaser (a Story or Short pointing to a video or premiere).
 */
const KINDS = [
    'audiogram', 'stream_clip', 'clip', 'remix', 'reaction', 'narration',
    'recap', 'audio_version', 'quote', 'teaser',
];

function parseMeta(raw) {
    let meta = raw;
    if (typeof meta === 'string') {
        try { meta = JSON.parse(meta); } catch { return {}; }
    }
    return (meta && typeof meta === 'object' && !Array.isArray(meta)) ? meta : {};
}

const seconds = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= MAX_SECONDS ? Math.round(n * 10) / 10 : null;
};

/** { kind, author, permlink, start?, end? } or null when anything is off. */
function cleanSource({ kind, author, permlink, start, end }) {
    const a = typeof author === 'string' ? author.trim().toLowerCase().replace(/^@/, '') : '';
    const p = typeof permlink === 'string' ? permlink.trim() : '';
    if (!KINDS.includes(kind) || !ACCOUNT_RE.test(a) || !PERMLINK_RE.test(p)) return null;
    const out = { kind, author: a, permlink: p };
    const s = seconds(start);
    const e = seconds(end);
    if (s !== null) out.start = s;
    if (e !== null && (s === null || e > s)) out.end = e;
    return out;
}

/** The snaps containers Shorts reply under (peak.snaps and our own). */
const isContainer = ({ author, permlink }) => author === 'peak.snaps' || /^snap-container-/.test(permlink);

function splitRef(ref) {
    const m = typeof ref === 'string' && ref.match(/^@?([a-z0-9.-]+)\/([a-z0-9-]+)$/);
    return m ? { author: m[1], permlink: m[2] } : null;
}

/** What `post` (a condenser get_content result, or the same fields) was made from, or null. */
function derivedSourceOf(post) {
    if (!post || typeof post !== 'object') return null;
    const meta = parseMeta(post.json_metadata);
    const ns = meta['3speak'] && typeof meta['3speak'] === 'object' ? meta['3speak'] : {};
    const video = meta.video && typeof meta.video === 'object' ? meta.video : {};
    const self = String(post.author || '').toLowerCase();

    let source = null;
    if (ns.source && typeof ns.source === 'object') {
        source = cleanSource(ns.source);
    } else if (ns.audiogram && typeof ns.audiogram === 'object') {
        const start = seconds(ns.audiogram.start);
        const len = seconds(ns.audiogram.duration);
        source = cleanSource({
            kind: 'audiogram', author: ns.audiogram.author, permlink: ns.audiogram.permlink,
            start, end: start !== null && len ? start + len : null,
        });
    } else if (video.streamClip && typeof video.streamClip === 'object') {
        source = cleanSource({
            kind: 'stream_clip', author: video.streamClip.host, permlink: video.streamClip.room,
            start: video.streamClip.offset,
        });
    } else if ((Array.isArray(video.remixChain) && video.remixChain[0]) || video.originalAuthor) {
        const near = Array.isArray(video.remixChain) && video.remixChain[0] && typeof video.remixChain[0] === 'object'
            ? video.remixChain[0]
            : { author: video.originalAuthor, permlink: video.originalPermlink };
        const author = String(near.author || '').toLowerCase();
        source = cleanSource({ kind: author && author === self ? 'clip' : 'remix', author, permlink: near.permlink });
    } else if (ns.tts && typeof ns.tts === 'object' && splitRef(ns.tts.source)) {
        source = cleanSource({ kind: 'narration', ...splitRef(ns.tts.source) });
    } else if (post.parent_author && Array.isArray(meta.tags) && meta.tags.includes('reaction') && (video.url || video.info)) {
        source = cleanSource({
            kind: 'reaction', author: post.parent_author, permlink: post.parent_permlink,
            start: meta.parentTimestamp,
        });
    }
    if (!source) return null;
    // A snaps container is where Shorts are posted, never what one is made from
    // (a reaction posted as a Short replies under it).
    if (isContainer(source)) return null;
    // Made from itself is no link at all.
    if (source.author === self && source.permlink === post.permlink) return null;
    return source;
}

/** What the derived post is, for the card: 'short' | 'video' | 'audio' | 'post'. */
function mediaOf(post) {
    const meta = parseMeta(post?.json_metadata);
    const tags = Array.isArray(meta.tags) ? meta.tags : [];
    const oa = meta['threespeak.video'];
    if (meta.audio || meta['threespeak.audio']) return 'audio';
    if (oa?.surface === 'shorts' || tags.includes('hive-181335')) return 'short';
    if (meta.video?.url || meta.video?.info) return 'video';
    return 'post';
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** The card's title: the video's own, the post's, else the first text line of the body. */
function titleOf(post) {
    const meta = parseMeta(post?.json_metadata);
    const own = meta.video?.info?.title || meta.audio?.title || post?.title;
    if (typeof own === 'string' && own.trim()) return clip(own.trim(), MAX_TITLE);
    const line = String(post?.body || '').split('\n')
        .map((l) => l.replace(/^#+\s*/, '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').trim())
        .find((l) => l && !/^https?:\/\//.test(l) && !/^[-*_]{3,}$/.test(l));
    return line ? clip(line, MAX_TITLE) : '';
}

function thumbnailOf(post) {
    const meta = parseMeta(post?.json_metadata);
    const pick = [
        Array.isArray(meta.image) ? meta.image[0] : null,
        meta.video?.thumbnail,
        meta.audio?.cover,
        meta.audio?.thumbnail,
    ].find((u) => typeof u === 'string' && /^https:\/\//.test(u));
    return pick ? pick.slice(0, 1000) : null;
}

function durationOf(post) {
    const meta = parseMeta(post?.json_metadata);
    return seconds(meta.video?.info?.duration) || seconds(meta['threespeak.video']?.duration)
        || seconds(meta['threespeak.audio']?.duration) || seconds(meta.audio?.duration) || null;
}

module.exports = {
    KINDS, ACCOUNT_RE, PERMLINK_RE,
    derivedSourceOf, mediaOf, titleOf, thumbnailOf, durationOf, parseMeta,
};
