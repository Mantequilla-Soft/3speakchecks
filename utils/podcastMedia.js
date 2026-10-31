/**
 * Chapters and transcripts of outside podcast episodes, in the one shape the
 * player reads (routes/podcasts.js /episode/:id/chapters and /transcript).
 *
 * Chapters come as a Podcasting 2.0 JSON file (podcast:chapters) or inline in
 * the feed (Podlove Simple Chapters, utils/podcastParse.js). Transcripts come as
 * WebVTT, SRT, Podcasting 2.0 JSON or HTML / plain text, whatever the show uses.
 * https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/examples/chapters/jsonChapters.md
 * https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/examples/transcripts/transcripts.md
 *
 * Everything here is pure: no network, no Mongo.
 */
const { decodeEntities, timeOf } = require('./podcastParse');

const MAX_CHAPTERS = 500;
const MAX_CUES = 20000;
const MAX_CUE_TEXT = 1000;

const round3 = (n) => Math.round(n * 1000) / 1000;

function httpUrl(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!/^https?:\/\//i.test(s) || s.length > 2000) return '';
  try { return new URL(s).toString(); } catch (_) { return ''; }
}

const oneLine = (v, max) => {
  const s = decodeEntities(String(v == null ? '' : v)).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
};

// ─── Chapters ─────────────────────────────────────────────────────────────────

/**
 * A chapters list (the JSON file's `chapters`, or the inline ones) → sorted
 * [{ start, end?, title, img?, url? }] in seconds. `toc: false` entries are
 * markers for apps, not chapters, and are left out.
 */
function normaliseChapters(input) {
  const list = Array.isArray(input) ? input : (input && Array.isArray(input.chapters) ? input.chapters : []);
  const out = [];
  for (const c of list.slice(0, MAX_CHAPTERS * 2)) {
    if (!c || typeof c !== 'object' || c.toc === false) continue;
    const start = Number(c.startTime ?? c.start);
    if (!Number.isFinite(start) || start < 0) continue;
    const ch = { start: round3(start), title: oneLine(c.title, 200) };
    const end = Number(c.endTime ?? c.end);
    if (Number.isFinite(end) && end > start) ch.end = round3(end);
    const img = httpUrl(c.img);
    if (img) ch.img = img;
    const url = httpUrl(c.url);
    if (url) ch.url = url;
    out.push(ch);
  }
  return out.sort((a, b) => a.start - b.start).slice(0, MAX_CHAPTERS);
}

/** A chapters file's body (JSON) → chapters, or [] when it is not one. */
function chaptersFromBody(body) {
  try { return normaliseChapters(JSON.parse(String(body).replace(/^﻿/, ''))); } catch (_) { return []; }
}

// ─── Transcripts ──────────────────────────────────────────────────────────────

/** "01:02:03.500", "02:03,5", "62:03.000" → seconds; NaN when it is none of those. */
function cueTime(s) {
  return timeOf(String(s || '').trim().replace(',', '.'));
}

// Line breaks and block ends become spaces; inline tags (<b>, <i>, VTT's <v> and
// <c>, cue timestamps) just go, so "Hello <b>there</b>." stays "Hello there.".
const stripTags = (s) => decodeEntities(String(s)
  .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, ' ')
  .replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

/**
 * WebVTT and SRT: blocks separated by a blank line, each with a timing line
 * ("00:00:01.000 --> 00:00:04.000", SRT with a comma) and its text. A VTT voice
 * tag (<v Speaker>) names who speaks.
 */
function parseTimedText(body) {
  const cues = [];
  const blocks = String(body).replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const [a, b] = lines[at].split('-->');
    const start = cueTime(a);
    const end = cueTime(String(b || '').trim().split(/\s+/)[0]);
    if (!Number.isFinite(start)) continue;
    const raw = lines.slice(at + 1).join(' ');
    const voice = raw.match(/<v(?:\.[^\s>]*)?\s+([^>]+)>/);
    const textOut = stripTags(raw);
    if (!textOut) continue;
    const cue = { start: round3(start), end: round3(Number.isFinite(end) && end >= start ? end : start), text: textOut.slice(0, MAX_CUE_TEXT) };
    if (voice) cue.speaker = oneLine(voice[1], 80);
    cues.push(cue);
    if (cues.length >= MAX_CUES) break;
  }
  return cues;
}

// A JSON transcript is often one segment per word or two. They are merged into
// sentence-sized cues: same speaker, no long pause, until a sentence ends and the
// cue is long enough to read, or it gets too long.
const MERGE_MIN_CHARS = 40;
const MERGE_MAX_CHARS = 300;
const MERGE_MAX_SPAN = 30;
const MERGE_MAX_GAP = 2;

function parseJsonTranscript(data) {
  const segments = Array.isArray(data) ? data : (data && Array.isArray(data.segments) ? data.segments : []);
  const cues = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.text) cues.push({ ...cur, text: cur.text.slice(0, MAX_CUE_TEXT) });
    cur = null;
  };
  for (const s of segments) {
    if (cues.length >= MAX_CUES) break;
    if (!s || typeof s !== 'object') continue;
    const start = Number(s.startTime);
    let end = Number(s.endTime);
    const body = oneLine(s.body, MAX_CUE_TEXT);
    if (!Number.isFinite(start) || start < 0 || !body) continue;
    if (!Number.isFinite(end) || end < start) end = start;
    const speaker = s.speaker ? oneLine(s.speaker, 80) : '';
    if (cur && ((cur.speaker || '') !== speaker || start - cur.end > MERGE_MAX_GAP
      || cur.text.length + body.length > MERGE_MAX_CHARS || end - cur.start > MERGE_MAX_SPAN)) flush();
    if (!cur) {
      cur = { start: round3(start), end: round3(end), text: body };
      if (speaker) cur.speaker = speaker;
    } else {
      // Punctuation glues to the word before it.
      cur.text = /^[,.;:!?)\]]/.test(body) ? `${cur.text}${body}` : `${cur.text} ${body}`;
      cur.end = round3(Math.max(cur.end, end));
    }
    if (/[.!?…]["')\]]?$/.test(cur.text) && cur.text.length >= MERGE_MIN_CHARS) flush();
  }
  flush();
  return cues;
}

/**
 * HTML transcripts. The Podcasting 2.0 form names speakers and times:
 *   <cite>Kevin:</cite> <time>0:00</time> <p>Hello...</p>
 * Without <time> tags it is just text: one cue per paragraph, start and end 0.
 */
function parseHtmlTranscript(body) {
  const html = String(body).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
  const cues = [];
  if (/<time\b/i.test(html)) {
    let speaker = '';
    let start = NaN;
    const re = /<(cite|time|p)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let m;
    while ((m = re.exec(html)) && cues.length < MAX_CUES) {
      const tag = m[1].toLowerCase();
      const inner = stripTags(m[2]);
      if (tag === 'cite') speaker = inner.replace(/:\s*$/, '').slice(0, 80);
      else if (tag === 'time') start = cueTime(inner);
      else if (inner) {
        const cue = { start: Number.isFinite(start) ? round3(start) : 0, end: 0, text: inner.slice(0, MAX_CUE_TEXT) };
        if (speaker) cue.speaker = speaker;
        cues.push(cue);
      }
    }
    // A cue ends where the next one starts.
    for (let i = 0; i < cues.length; i += 1) cues[i].end = i + 1 < cues.length ? Math.max(cues[i].start, cues[i + 1].start) : cues[i].start;
    if (cues.length) return cues;
  }
  return parsePlainText(html.replace(/<\/p>|<br\s*\/?>\s*<br\s*\/?>/gi, '\n\n'));
}

function parsePlainText(body) {
  return String(body).replace(/\r\n?/g, '\n').split(/\n\s*\n/)
    .map(stripTags).filter(Boolean).slice(0, MAX_CUES)
    .map((t) => ({ start: 0, end: 0, text: t.slice(0, MAX_CUE_TEXT) }));
}

/** What kind of transcript a body is, by its declared type and, failing that, a look at it. */
function transcriptKind(body, type) {
  const t = String(type || '').toLowerCase();
  const head = String(body).replace(/^﻿/, '').trimStart().slice(0, 200);
  if (t.includes('json') || /^[[{]/.test(head)) return 'json';
  if (t.includes('vtt') || /^WEBVTT/.test(head)) return 'vtt';
  if (t.includes('srt') || t.includes('subrip') || /^\d+\s*\n\s*\d{1,2}:\d{2}:\d{2}[,.]\d+\s*-->/.test(head.replace(/\r/g, ''))) return 'srt';
  if (t.includes('html') || /^<(!doctype|html|body|p|div|cite|time)\b/i.test(head)) return 'html';
  return 'text';
}

/** A transcript file's body → cues [{ start, end, text, speaker? }]. */
function parseTranscript(body, type) {
  const kind = transcriptKind(body, type);
  if (kind === 'json') {
    try { return parseJsonTranscript(JSON.parse(String(body).replace(/^﻿/, ''))); } catch (_) { return []; }
  }
  if (kind === 'vtt' || kind === 'srt') return parseTimedText(body);
  if (kind === 'html') return parseHtmlTranscript(body);
  return parsePlainText(body);
}

// How well a format reads in the player: timed, with speakers, beats the rest.
// VTT first: sentence-sized cues and speaker names as written (JSON files often
// carry speaker slugs and one segment per word).
const TYPE_RANK = ['vtt', 'json', 'srt', 'html', 'text'];
const typeRank = (type) => {
  const t = String(type || '').toLowerCase();
  const kind = t.includes('json') ? 'json' : t.includes('vtt') ? 'vtt' : (t.includes('srt') || t.includes('subrip')) ? 'srt' : t.includes('html') ? 'html' : 'text';
  return TYPE_RANK.indexOf(kind);
};

const baseLang = (l) => String(l || '').toLowerCase().split(/[-_]/)[0];

/**
 * The transcripts to try for a language, best first: that language (or its base,
 * "en" for "en-us"), else the show's, else whatever there is.
 */
function pickTranscripts(list, lang, showLang) {
  const all = (list || []).filter((t) => t && t.url);
  const want = baseLang(lang);
  const show = baseLang(showLang);
  const of = (l) => all.filter((t) => baseLang(t.lang) === l);
  const chosen = (want && of(want).length ? of(want) : (show && of(show).length ? of(show) : all));
  return [...chosen].sort((a, b) => typeRank(a.type) - typeRank(b.type));
}

/** The languages on offer, each once. */
const transcriptLanguages = (list) => [...new Set((list || []).map((t) => t.lang).filter(Boolean))];

// ─── A small cache ───────────────────────────────────────────────────────────

/**
 * In-memory LRU with a size budget, for parsed chapters and transcripts: an
 * episode being played asks once, then everyone listening to it is answered from
 * here. Misses (a host that failed) are kept briefly too, so a broken file is not
 * fetched again on every request.
 */
function makeCache({ maxEntries = 200, maxBytes = 24 * 1024 * 1024 } = {}) {
  const map = new Map(); // key → { at, ttl, value, size }
  let bytes = 0;
  const drop = (key) => {
    const hit = map.get(key);
    if (!hit) return;
    bytes -= hit.size;
    map.delete(key);
  };
  return {
    get(key) {
      const hit = map.get(key);
      if (!hit) return undefined;
      if (Date.now() - hit.at > hit.ttl) { drop(key); return undefined; }
      map.delete(key);
      map.set(key, hit);
      return hit.value;
    },
    set(key, value, ttl) {
      drop(key);
      const size = Buffer.byteLength(JSON.stringify(value) || '');
      if (size > maxBytes / 4) return;
      map.set(key, { at: Date.now(), ttl, value, size });
      bytes += size;
      while (map.size > maxEntries || bytes > maxBytes) drop(map.keys().next().value);
    },
    get size() { return map.size; },
  };
}

module.exports = {
  normaliseChapters, chaptersFromBody, parseTranscript, transcriptKind, pickTranscripts, transcriptLanguages, makeCache,
  _test: { parseTimedText, parseJsonTranscript, parseHtmlTranscript, parsePlainText, cueTime },
};
