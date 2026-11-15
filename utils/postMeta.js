/**
 * What a 3Speak post's own record (its Hive body and json_metadata) says about
 * the episode it is, for the podcast feeds (routes/rss.js) and the audio index
 * (services/audioHiveSync.js):
 *
 *   chapters        json_metadata.video.chapters / .audio.chapters (the
 *                   timeline editor, utils/videoTimeline.js on 3speak.tv), else
 *                   a list of at least three timestamped lines in the body
 *                   ("0:00 Intro"), the way the audio editor writes them and
 *                   YouTube reads them
 *   season/episode  json_metadata.audio.season/.episode (audio uploads) or
 *                   json_metadata.video.season/.episode (video uploads)
 *   audiogram       json_metadata['3speak'].audiogram on a Short made from an
 *                   audiogram: the episode it is a piece of, and which piece
 *   transcript      a "**Transcript**" block in the body (the audio uploader's
 *                   Make a transcript, src/utils/transcribe.js); the heading is
 *                   written in the uploader's language, so every one is known
 *
 * Mirrors the 3speak.tv readers (src/utils/timestamps.js parseChapters,
 * src/utils/videoTimeline.js, src/utils/episodeNumbers.js). Nothing on chain
 * checks json_metadata, so everything is validated and bad values dropped.
 */

const MAX_CHAPTERS = 100;
const MAX_TITLE = 100;
const MAX_SECONDS = 24 * 3600;
const MIN_BODY_CHAPTERS = 3;
const MIN_META_CHAPTERS = 2;
const MIN_CHAPTER_SECONDS = 3;
const MAX_SEASON = 9999;
const MAX_EPISODE = 99999;

// src/locales/*/audio.json upload.transcript.heading, every language the site has.
const TRANSCRIPT_HEADINGS = [
    'Transcript', 'Transkript', 'Transcripción', 'Transcription', 'Transcrição', 'Trascrizione',
    'Transkrypcja', 'Transkrip', 'Döküm', 'Nakala', 'Bản chép lời', 'Расшифровка', 'Розшифровка',
    'ट्रांसक्रिप्ट', 'ট্রান্সক্রিপ্ট', 'คำถอดเสียง', '文字稿', '文字起こし', '스크립트',
];

/** json_metadata as an object, whatever shape the post carried it in. */
function parseMeta(raw) {
    if (raw && typeof raw === 'object') return Array.isArray(raw) ? {} : raw;
    if (typeof raw !== 'string' || !raw) return {};
    try {
        let v = JSON.parse(raw);
        if (typeof v === 'string') v = JSON.parse(v);
        return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
        return {};
    }
}

/** One line of plain text, at most `max` characters. */
function cleanTitle(v, max = MAX_TITLE) {
    if (typeof v !== 'string') return '';
    // eslint-disable-next-line no-control-regex
    const s = v.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
    const chars = Array.from(s);
    return chars.length > max ? chars.slice(0, max).join('').trim() : s;
}

/** A whole number in [min, max], or null. Accepts numeric strings ("5"). */
function wholeIn(value, min, max) {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) return null;
    return n;
}

/** { season, episode } from the post's metadata (either may be null). */
function seasonEpisodeOf(meta) {
    const m = parseMeta(meta);
    for (const block of [m.audio, m.video]) {
        if (!block || typeof block !== 'object') continue;
        const season = wholeIn(block.season, 1, MAX_SEASON);
        const episode = wholeIn(block.episode, 1, MAX_EPISODE);
        if (season != null || episode != null) return { season, episode };
    }
    return { season: null, episode: null };
}

/** Chapters stored in the metadata: [{ start, title }], in order, or []. */
function metaChapters(meta, duration) {
    const m = parseMeta(meta);
    const total = Number(duration) || 0;
    for (const block of [m.video, m.audio]) {
        const raw = block && Array.isArray(block.chapters) ? block.chapters : null;
        if (!raw) continue;
        const out = [];
        for (const c of raw) {
            if (!c || typeof c !== 'object') continue;
            const start = Number(c.start);
            if (!Number.isFinite(start) || start < 0 || start > MAX_SECONDS) continue;
            if (total > 0 && start >= total) continue;
            if (out.length && Math.floor(start) <= out[out.length - 1].start) continue;
            out.push({ start: Math.floor(start), title: cleanTitle(c.title) });
            if (out.length >= MAX_CHAPTERS) break;
        }
        if (out.length >= MIN_META_CHAPTERS) return out;
    }
    return [];
}

// "1:02:03", "12:40", "0:00"
const STAMP = '((?:\\d{1,2}:)?\\d{1,2}:\\d{2})';
const BULLET_RE = /^(?:[-*+•▶►▸→]\s*|\d{1,3}[.)]\s+)?/;
const SEP_RE = /^[\s\-–—:|·.)\]]+|[\s\-–—:|·.([]+$/g;

function toSeconds(stamp) {
    const parts = stamp.split(':').map(Number);
    if (parts.some((p) => !Number.isFinite(p))) return null;
    const [h, m, s] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
    if (m > 59 && parts.length === 3) return null;
    if (s > 59) return null;
    return h * 3600 + m * 60 + s;
}

/** A body line as plain text: markdown links to their text, no emphasis, no HTML. */
function plainLine(raw) {
    return String(raw)
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/<[^>]+>/g, '')
        .replace(/[*_`#>]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function chapterFromLine(raw) {
    const line = plainLine(raw).replace(BULLET_RE, '');
    if (!line) return null;
    let m = new RegExp(`^\\(?\\[?${STAMP}\\]?\\)?(.*)$`).exec(line);
    if (m) {
        const start = toSeconds(m[1]);
        return start == null ? null : { start, title: m[2].replace(SEP_RE, '').trim() };
    }
    m = new RegExp(`^(.*?)\\(?\\[?${STAMP}\\]?\\)?$`).exec(line);
    if (m && m[1].trim()) {
        const start = toSeconds(m[2]);
        return start == null ? null : { start, title: m[1].replace(SEP_RE, '').trim() };
    }
    return null;
}

/**
 * Chapters from the body: the longest run of at least three consecutive
 * timestamped lines in ascending order (blank lines do not break a run). Times
 * past a known duration are dropped; a list that does not start at 0:00 gets an
 * untitled first chapter; chapters under 3 seconds merge into the one before.
 */
function bodyChapters(body, duration) {
    if (!body) return [];
    const total = Number(duration) || 0;
    const lines = String(body).replace(/<br\s*\/?>/gi, '\n').split(/\r?\n/);
    let best = [];
    let run = [];
    const flush = () => { if (run.length > best.length) best = run; run = []; };
    for (const raw of lines) {
        if (!raw.trim()) continue;
        const ch = chapterFromLine(raw);
        if (!ch) { flush(); continue; }
        if (run.length && ch.start <= run[run.length - 1].start) flush();
        run.push(ch);
    }
    flush();
    const inside = total > 0 ? best.filter((c) => c.start < total) : best;
    if (inside.length < MIN_BODY_CHAPTERS) return [];
    if (inside[0].start > 0) inside.unshift({ start: 0, title: '' });
    const merged = [];
    for (let i = 0; i < inside.length; i += 1) {
        const c = inside[i];
        const end = i + 1 < inside.length ? inside[i + 1].start : (total || Infinity);
        const prev = merged[merged.length - 1];
        if (prev && end - c.start < MIN_CHAPTER_SECONDS) continue;
        merged.push({ start: c.start, title: cleanTitle(c.title) });
        if (merged.length >= MAX_CHAPTERS) break;
    }
    return merged.length >= 2 ? merged : [];
}

/** The post's chapters, [{ start, title }] in whole seconds: metadata first, then the body. */
function chaptersOfPost({ body, json_metadata: meta, duration } = {}) {
    const fromMeta = metaChapters(meta, duration);
    return fromMeta.length ? fromMeta : bodyChapters(body, duration);
}

/** The episode a Short was cut from, and the piece: { author, permlink, start, duration } (start/duration may be null). */
function audiogramOf(meta) {
    const a = parseMeta(meta)?.['3speak']?.audiogram;
    if (!a || typeof a !== 'object') return null;
    const author = typeof a.author === 'string' && /^[a-z][a-z0-9.-]{2,15}$/.test(a.author) ? a.author : null;
    const permlink = typeof a.permlink === 'string' && /^[a-z0-9-]{1,255}$/.test(a.permlink) ? a.permlink : null;
    if (!author || !permlink) return null;
    const start = Number(a.start);
    const duration = Number(a.duration);
    return {
        author,
        permlink,
        start: Number.isFinite(start) && start >= 0 && start <= MAX_SECONDS ? Math.round(start * 10) / 10 : null,
        duration: Number.isFinite(duration) && duration > 0 && duration <= 600 ? Math.round(duration * 10) / 10 : null,
    };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HEADING_RE = new RegExp(`^\\s*\\*\\*(?:${TRANSCRIPT_HEADINGS.map(escapeRe).join('|')})\\*\\*\\s*$`, 'm');

/** The text of a "**Transcript**" block in the body (to the end, or a --- rule), or ''. */
function transcriptFromBody(body) {
    const text = String(body || '');
    const m = HEADING_RE.exec(text);
    if (!m) return '';
    let rest = text.slice(m.index + m[0].length);
    const rule = /^\s*(?:---|\*\*\*)\s*$/m.exec(rest);
    if (rule) rest = rest.slice(0, rule.index);
    return rest
        .replace(/<[^>]+>/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

module.exports = {
    parseMeta,
    seasonEpisodeOf,
    chaptersOfPost,
    metaChapters,
    bodyChapters,
    audiogramOf,
    transcriptFromBody,
    TRANSCRIPT_HEADINGS,
};
