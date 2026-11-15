/**
 * Shorts from a long video, picked by real viewers: clip ranges (15 to 60 s by
 * default) suggested from data only 3Speak has. Pure functions, no I/O; the route
 * (routes/clipIdeas.js) gathers the inputs and caches the answer.
 *
 * The four signals, each turned into candidate ranges with a weight:
 *
 *   replay    the "most replayed" heatmap (view-heatmaps: 100 buckets, a bucket
 *             counted every time playback crossed it) divided by how many watch
 *             sessions reached that bucket at all (view-durations: start to the
 *             furthest position). A bucket watched more per arriving viewer than
 *             the video's typical bucket is being rewatched, which the raw
 *             heatmap cannot say on its own: its first buckets are always the
 *             tallest because every session starts there. Anonymous aggregates
 *             only, as the player stores them.
 *   comments  comments pinned to a moment (the watch page's `parentTimestamp`, or
 *             a time like 1:23 written in the text), grouped when close together
 *             and counted by distinct commenters.
 *   chat      lines of a live stream's chat (mirrored to Hive as timecoded
 *             comments that say "during the live stream") and of a premiere's
 *             chat (premiere_chat `offset`), binned into 30 s slots; a slot well
 *             above the average one "lit up".
 *   quote     transcript sentences that read well on their own: with a number, a
 *             question, a strong word, said fast, of a sensible length.
 *
 * Candidates that overlap merge: their weights add up and their reasons are
 * listed together, so a range that is replayed AND commented on AND quotable
 * ranks first.
 */

const DEFAULTS = Object.freeze({
  minLen: 15,       // shortest suggestion, seconds
  maxLen: 60,       // longest suggestion, seconds
  targetLen: 30,    // a range shorter than this is padded to it
  max: 5,           // suggestions returned
  minSessions: 5,   // watch sessions needed before the replay signal says anything
});

const round1 = (n) => Math.round(n * 10) / 10;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return 0;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/* ── timestamps ─────────────────────────────────────────────────────────── */

/** "1:23" / "01:02:03" to seconds, or null. */
function parseClock(str) {
  const m = /^(?:(\d{1,2}):)?(\d{1,3}):(\d{2})$/.exec(String(str || '').trim());
  if (!m) return null;
  const s = Number(m[3]);
  if (s >= 60) return null;
  return (Number(m[1] || 0) * 3600) + Number(m[2]) * 60 + s;
}

// The suffix the watch page and the stream chat append to a timecoded comment:
// ours, not the commenter's words.
const OUR_SUFFIX = /<br>\s*<sup>(?:replied to|said at)[\s\S]*?<\/sup>\s*$/i;
const LIVE_CHAT = /<sup>said at [^<]*during the live stream<\/sup>/i;
const CLOCK_IN_TEXT = /(?:^|[^\d:])((?:\d{1,2}:)?\d{1,3}:\d{2})(?![\d:])/;

/**
 * One Hive reply as a moment: { t, author, kind: 'comment' | 'chat' }, or null
 * when it points nowhere in the video. `parentTimestamp` (seconds, set by the
 * watch page and the stream chat) wins over a time typed in the text.
 */
function momentOfReply(reply, duration) {
  if (!reply || typeof reply !== 'object') return null;
  let meta = reply.json_metadata;
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch (_) { meta = {}; }
  }
  meta = meta && typeof meta === 'object' ? meta : {};
  const body = String(reply.body || '');
  const kind = LIVE_CHAT.test(body) ? 'chat' : 'comment';
  let t = Number.isFinite(meta.parentTimestamp) ? meta.parentTimestamp : null;
  if (t == null) {
    const text = body.replace(OUR_SUFFIX, '').replace(/https?:\/\/\S+/g, ' ');
    const m = CLOCK_IN_TEXT.exec(text);
    if (m) t = parseClock(m[1]);
  }
  if (t == null || t < 0 || (duration > 0 && t > duration)) return null;
  return { t, author: String(reply.author || '').toLowerCase(), kind };
}

/* ── transcripts ────────────────────────────────────────────────────────── */

const CUE_TIME = /(\d{1,2}:)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}:)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
const cueSec = (h, m, s, ms) => (Number(String(h || '0').replace(':', '')) * 3600) + Number(m) * 60 + Number(s) + Number(String(ms).padEnd(3, '0')) / 1000;

/** SRT or WebVTT text to cues [{ start, end, text }], in order. */
function parseSubtitles(raw) {
  const cues = [];
  const blocks = String(raw || '').replace(/\r/g, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => CUE_TIME.test(l));
    if (i < 0) continue;
    const m = CUE_TIME.exec(lines[i]);
    const start = cueSec(m[1], m[2], m[3], m[4]);
    const end = cueSec(m[5], m[6], m[7], m[8]);
    const text = lines.slice(i + 1).join(' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!text || !(end > start)) continue;
    cues.push({ start, end, text });
  }
  return cues.sort((a, b) => a.start - b.start);
}

const SENTENCE_END = /[.!?。！？؟]["')\]]*$/;

/** Cues joined into sentences [{ start, end, text }] (a sentence may span cues). */
function sentencesFrom(cues) {
  const out = [];
  let cur = null;
  for (const c of cues) {
    // Split a cue at its own sentence ends, sharing its time out by length.
    const parts = c.text.split(/(?<=[.!?。！？؟])\s+/).filter(Boolean);
    const total = parts.reduce((n, p) => n + p.length, 0) || 1;
    let at = c.start;
    for (const p of parts) {
      const span = (c.end - c.start) * (p.length / total);
      if (!cur) cur = { start: at, end: at + span, text: p };
      else { cur.end = at + span; cur.text += ` ${p}`; }
      at += span;
      if (SENTENCE_END.test(p) || cur.end - cur.start > 25) { out.push(cur); cur = null; }
    }
  }
  if (cur) out.push(cur);
  return out;
}

// Words that make a line worth quoting. English only; numbers, questions and
// pace work in every language.
const STRONG = /\b(never|always|best|worst|secret|mistake|biggest|most|everyone|nobody|nothing|everything|love|hate|amazing|incredible|insane|crazy|important|truth|wrong|right now|must|stop|first|last|only|free|million|billion|thousand|why|how|wow)\b/i;

/** How quotable a sentence is (0 = not at all), and why. */
function scoreSentence(s) {
  const words = s.text.split(/\s+/).filter(Boolean).length;
  const secs = Math.max(0.5, s.end - s.start);
  if (words < 6 || words > 40 || secs > 25) return 0;
  let score = 0;
  if (/\d/.test(s.text)) score += 1;
  if (/[?？؟]/.test(s.text)) score += 1;
  if (/!/.test(s.text)) score += 0.5;
  if (STRONG.test(s.text)) score += 1;
  if (words / secs >= 3.2) score += 0.5;
  return score;
}

/* ── the replay signal ──────────────────────────────────────────────────── */

/**
 * Per bucket, how much more each arriving viewer watched it than the video's
 * typical bucket (0 = typical, 0.5 = half as much again). Null when there is too
 * little data. `rows` are view-durations rows (startPosition, maxPosition,
 * lastPosition); `heatmap` is the view-heatmaps doc.
 */
function replayLift({ heatmap, rows, duration, minSessions = DEFAULTS.minSessions }) {
  if (!heatmap || !Array.isArray(heatmap.buckets) || !heatmap.buckets.length) return null;
  if (!Array.isArray(rows) || rows.length < minSessions) return null;
  const n = heatmap.buckets.length;
  const axis = Number(heatmap.duration) > 0 ? Number(heatmap.duration) : duration;
  if (!(axis > 0)) return null;
  const reach = new Array(n).fill(0);
  for (const r of rows) {
    const a = Math.max(0, Number(r.startPosition) || 0);
    const b = Math.max(a, Number(r.maxPosition) || 0, Number(r.lastPosition) || 0);
    const b0 = Math.min(n - 1, Math.floor((a / axis) * n));
    const b1 = Math.min(n - 1, Math.floor((b / axis) * n));
    for (let i = b0; i <= b1; i += 1) reach[i] += 1;
  }
  // A bucket only a couple of sessions reached says nothing.
  const minReach = Math.max(3, Math.ceil(rows.length * 0.05));
  const raw = heatmap.buckets.map((h, i) => (reach[i] >= minReach ? (Number(h) || 0) / reach[i] : null));
  const typical = median(raw.filter((x) => x != null && x > 0));
  if (!(typical > 0)) return null;
  return {
    bucketSec: axis / n,
    reach,
    lift: raw.map((x) => (x == null ? 0 : Math.max(0, x / typical - 1))),
  };
}

/** The rewatched stretches as candidate ranges. */
function replayCandidates(sig, { maxPeaks = 4, minLift = 0.25 } = {}) {
  if (!sig) return [];
  const { lift, bucketSec, reach } = sig;
  const order = lift.map((v, i) => ({ v, i })).filter((p) => p.v >= minLift).sort((a, b) => b.v - a.v);
  const taken = new Array(lift.length).fill(false);
  const out = [];
  for (const p of order) {
    if (out.length >= maxPeaks) break;
    if (taken[p.i]) continue;
    let i0 = p.i;
    let i1 = p.i;
    const floor = Math.max(0.1, p.v * 0.5);
    while (i0 > 0 && !taken[i0 - 1] && lift[i0 - 1] >= floor) i0 -= 1;
    while (i1 < lift.length - 1 && !taken[i1 + 1] && lift[i1 + 1] >= floor) i1 += 1;
    for (let i = Math.max(0, i0 - 1); i <= Math.min(lift.length - 1, i1 + 1); i += 1) taken[i] = true;
    // Few sessions behind a peak: a weaker claim.
    const sample = Math.min(1, (reach[p.i] || 0) / 10);
    out.push({
      start: i0 * bucketSec,
      end: (i1 + 1) * bucketSec,
      weight: (2 + 2 * Math.min(1, p.v)) * (0.5 + 0.5 * sample),
      reason: { kind: 'replay', lift: round1(p.v) },
    });
  }
  return out;
}

/* ── comments and chat ──────────────────────────────────────────────────── */

/** Timestamped comments close together, as candidate ranges. */
function commentCandidates(moments, { gap = 20 } = {}) {
  const list = moments.filter((m) => m.kind === 'comment').sort((a, b) => a.t - b.t);
  const groups = [];
  for (const m of list) {
    const g = groups[groups.length - 1];
    if (g && m.t - g.first <= gap) { g.last = m.t; g.authors.add(m.author); } else {
      groups.push({ first: m.t, last: m.t, authors: new Set([m.author]) });
    }
  }
  return groups.map((g) => {
    const count = g.authors.size;
    // People comment on what they just saw: the range starts before the time.
    return {
      start: g.first - 15,
      end: g.last + 10,
      weight: Math.min(6, 1.5 * count),
      reason: { kind: 'comments', count },
    };
  });
}

/** Chat slots far busier than the average one, as candidate ranges. */
function chatCandidates(moments, duration, { bin = 30, minTotal = 5, maxSpikes = 3 } = {}) {
  const lines = moments.filter((m) => m.kind === 'chat');
  if (lines.length < minTotal || !(duration > 0)) return [];
  const bins = new Array(Math.max(1, Math.ceil(duration / bin))).fill(0);
  for (const m of lines) bins[Math.min(bins.length - 1, Math.floor(m.t / bin))] += 1;
  const mean = lines.length / bins.length;
  return bins
    .map((count, i) => ({ count, i }))
    .filter((b) => b.count >= 3 && b.count >= 2 * mean)
    .sort((a, b) => b.count - a.count)
    .slice(0, maxSpikes)
    .map((b) => ({
      // Chat reacts after the moment: start earlier than the slot.
      start: b.i * bin - 20,
      end: (b.i + 1) * bin + 5,
      weight: 1 + Math.min(3, b.count / Math.max(mean, 1)),
      reason: { kind: 'chat', count: b.count },
    }));
}

/** The most quotable sentences, as candidate ranges. */
function quoteCandidates(sentences, { max = 3, minScore = 2 } = {}) {
  return sentences
    .map((s) => ({ s, score: scoreSentence(s) }))
    .filter((x) => x.score >= minScore)
    .sort((a, b) => b.score - a.score || a.s.start - b.s.start)
    .slice(0, max)
    .map(({ s, score }) => ({
      start: s.start - 1,
      end: s.end + 2,
      weight: score * 0.75,
      reason: { kind: 'quote', text: s.text.length > 160 ? `${s.text.slice(0, 157)}...` : s.text },
    }));
}

/* ── ranges ─────────────────────────────────────────────────────────────── */

/** A range padded or cut to the allowed length, inside the video. */
function fitRange(start, end, duration, o = DEFAULTS) {
  let a = Math.max(0, start);
  let b = Math.min(duration, Math.max(end, a));
  const want = clamp(b - a, Math.min(o.targetLen, duration), o.maxLen);
  const mid = (a + b) / 2;
  a = mid - want / 2;
  b = mid + want / 2;
  if (a < 0) { b -= a; a = 0; }
  if (b > duration) { a -= b - duration; b = duration; }
  a = Math.max(0, a);
  return { start: a, end: b };
}

/** Start and end moved to the nearest sentence edges, when one is close. */
function snapToSentences(range, sentences, duration, o = DEFAULTS) {
  if (!sentences.length) return range;
  let { start, end } = range;
  const s = sentences.filter((x) => x.start >= start - 5 && x.start <= start + 3)
    .sort((x, y) => Math.abs(x.start - start) - Math.abs(y.start - start))[0];
  if (s) start = s.start;
  const e = sentences.filter((x) => x.end >= end - 3 && x.end <= end + 5)
    .sort((x, y) => Math.abs(x.end - end) - Math.abs(y.end - end))[0];
  if (e && e.end - start >= o.minLen && e.end - start <= o.maxLen) end = e.end;
  if (end - start < o.minLen || end - start > o.maxLen) return range;
  return { start: Math.max(0, start), end: Math.min(duration, end) };
}

const overlap = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

/** Merge one reason into a list: one per kind, the larger count kept. */
function addReason(reasons, r) {
  const same = reasons.find((x) => x.kind === r.kind);
  if (!same) { reasons.push({ ...r }); return; }
  if (r.count != null) same.count = Math.max(same.count || 0, r.count);
  if (r.lift != null) same.lift = Math.max(same.lift || 0, r.lift);
  if (r.text && !same.text) same.text = r.text;
}

const REASON_ORDER = ['replay', 'comments', 'chat', 'quote'];

/**
 * Everything together: { suggestions: [{ start, end, score, reasons }], signals }.
 * `score` is 0..100 relative to the best suggestion.
 */
function buildClipIdeas({ duration, heatmap = null, rows = [], replies = [], premiereChat = [], subtitles = '', opts = {} }) {
  const o = { ...DEFAULTS, ...opts };
  const D = Number(duration) || 0;
  const signals = { replay: false, comments: 0, chat: 0, transcript: false };
  if (!(D >= o.minLen * 2)) return { suggestions: [], signals };

  const moments = [];
  for (const r of replies) {
    const m = momentOfReply(r, D);
    if (m) moments.push(m);
  }
  for (const c of premiereChat) {
    const t = Number(c && c.offset);
    if (Number.isFinite(t) && t >= 0 && t <= D) moments.push({ t, author: String(c.user || '').toLowerCase(), kind: 'chat' });
  }
  const sentences = subtitles ? sentencesFrom(parseSubtitles(subtitles)) : [];

  const lift = replayLift({ heatmap, rows, duration: D, minSessions: o.minSessions });
  const candidates = [
    ...replayCandidates(lift),
    ...commentCandidates(moments),
    ...chatCandidates(moments, D),
    ...quoteCandidates(sentences),
  ];
  signals.replay = !!lift;
  signals.comments = moments.filter((m) => m.kind === 'comment').length;
  signals.chat = moments.filter((m) => m.kind === 'chat').length;
  signals.transcript = sentences.length > 0;

  const picks = [];
  for (const c of candidates.sort((a, b) => b.weight - a.weight)) {
    const range = snapToSentences(fitRange(c.start, c.end, D, o), sentences, D, o);
    const hit = picks.find((p) => overlap(p, range) >= 0.4 * Math.min(p.end - p.start, range.end - range.start));
    if (hit) {
      hit.weight += c.weight;
      addReason(hit.reasons, c.reason);
      const uStart = Math.min(hit.start, range.start);
      const uEnd = Math.max(hit.end, range.end);
      if (uEnd - uStart <= o.maxLen) { hit.start = uStart; hit.end = uEnd; }
      continue;
    }
    picks.push({ ...range, weight: c.weight, reasons: [{ ...c.reason }] });
  }

  const top = picks.sort((a, b) => b.weight - a.weight).slice(0, o.max);
  const best = top.length ? top[0].weight : 1;
  const suggestions = top.map((p) => {
    const start = Math.floor(p.start);
    const end = Math.min(Math.floor(D), start + o.maxLen, Math.max(start + o.minLen, Math.ceil(p.end)));
    return {
      start,
      end,
      score: Math.round((p.weight / best) * 100),
      reasons: p.reasons.sort((a, b) => REASON_ORDER.indexOf(a.kind) - REASON_ORDER.indexOf(b.kind)),
    };
  });
  return { suggestions, signals };
}

module.exports = {
  DEFAULTS,
  buildClipIdeas,
  _test: {
    parseClock, momentOfReply, parseSubtitles, sentencesFrom, scoreSentence,
    replayLift, replayCandidates, commentCandidates, chatCandidates, quoteCandidates,
    fitRange, snapToSentences, median,
  },
};
