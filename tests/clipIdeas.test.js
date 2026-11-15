/**
 * Shorts from this video: utils/clipIdeas.js scores clip ranges from replays,
 * timestamped comments, chat and the transcript, and routes/clipIdeas.js serves
 * them to the video's owner only. Mongo, Hive, IPFS and the vouch check are
 * stand-ins; nothing leaves the process.
 */
jest.mock('../utils/db', () => ({ getDb: jest.fn() }));
jest.mock('../utils/hiveAuth', () => ({
  verifyHiveAuthority: jest.fn(async () => ({ ok: false })),
  verifyDelegateVouch: jest.fn(async ({ signature }) => ({ ok: signature === 'good' })),
}));
jest.mock('../utils/hive', () => ({ hiveRpcCall: jest.fn(async () => []) }));
jest.mock('../utils/commentMutes', () => ({ getMutedSet: jest.fn(async () => new Set(['ai-agent-hunter'])) }));
jest.mock('../routes/subtitleProxy', () => ({
  fetchSubtitleText: jest.fn(async () => ({ status: 404 })),
  CID_RE: /^[a-zA-Z0-9]{40,80}$/,
}));

const express = require('express');
const request = require('supertest');
const { getDb } = require('../utils/db');
const { hiveRpcCall } = require('../utils/hive');
const { fetchSubtitleText } = require('../routes/subtitleProxy');
const { buildClipIdeas, _test: u } = require('../utils/clipIdeas');
const router = require('../routes/clipIdeas');

const CID = 'Qm' + 'a'.repeat(44);
const clock = (s) => {
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(Math.floor(s % 60)).padStart(2, '0');
  return `${h}:${m}:${sec},000`;
};
const srt = (cues) => cues.map(([a, b, text], i) => `${i + 1}\n${clock(a)} --> ${clock(b)}\n${text}`).join('\n\n');

// A 10 minute video watched start to end by 20 sessions, with the 4:00 to 4:24
// stretch (buckets 40..43 of 100) watched three times as much as the rest.
function replayData({ sessions = 20, hot = [40, 41, 42, 43] } = {}) {
  const buckets = new Array(100).fill(sessions * 2);
  for (const i of hot) buckets[i] = sessions * 6;
  return {
    heatmap: { owner: 'badadib', permlink: 'abc123', duration: 600, bucketCount: 100, buckets, sessions },
    rows: Array.from({ length: sessions }, () => ({ startPosition: 0, maxPosition: 600, lastPosition: 600 })),
  };
}

describe('utils/clipIdeas', () => {
  test('parses clocks and rejects nonsense', () => {
    expect(u.parseClock('1:23')).toBe(83);
    expect(u.parseClock('01:02:03')).toBe(3723);
    expect(u.parseClock('1:75')).toBeNull();
    expect(u.parseClock('soon')).toBeNull();
  });

  test('a reply becomes a moment from parentTimestamp, else from a time in the text', () => {
    expect(u.momentOfReply({ author: 'fan', body: 'nice', json_metadata: JSON.stringify({ parentTimestamp: 42 }) }, 600))
      .toEqual({ t: 42, author: 'fan', kind: 'comment' });
    expect(u.momentOfReply({ author: 'fan', body: 'the part at 4:12 is great', json_metadata: '{}' }, 600))
      .toEqual({ t: 252, author: 'fan', kind: 'comment' });
    // A time past the end, or none at all, points nowhere.
    expect(u.momentOfReply({ author: 'fan', body: 'see 59:00', json_metadata: '{}' }, 600)).toBeNull();
    expect(u.momentOfReply({ author: 'fan', body: 'great video', json_metadata: '{}' }, 600)).toBeNull();
    // Our own "said at ... during the live stream" suffix marks stream chat.
    const chat = { author: 'fan', body: 'wow\n<br><sup>said at [02:00](https://3speak.tv/watch?v=badadib/x) during the live stream</sup>', json_metadata: { parentTimestamp: 120 } };
    expect(u.momentOfReply(chat, 600)).toEqual({ t: 120, author: 'fan', kind: 'chat' });
  });

  test('subtitles parse (SRT and VTT) and join into sentences', () => {
    const cues = u.parseSubtitles(srt([[1, 3, 'Hello there, this is'], [3, 5, 'my channel. Why do 9 of 10 people fail?']]));
    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual({ start: 1, end: 3, text: 'Hello there, this is' });
    const vtt = u.parseSubtitles('WEBVTT\n\n00:00:01.500 --> 00:00:02.000\n<b>Hi</b>');
    expect(vtt).toEqual([{ start: 1.5, end: 2, text: 'Hi' }]);
    const s = u.sentencesFrom(cues);
    expect(s.map((x) => x.text)).toEqual(['Hello there, this is my channel.', 'Why do 9 of 10 people fail?']);
    expect(s[0].start).toBe(1);
  });

  test('quotable sentences score for numbers, questions and strong words', () => {
    expect(u.scoreSentence({ start: 0, end: 4, text: 'Why do 9 of 10 people never finish their first video?' })).toBeGreaterThanOrEqual(3);
    expect(u.scoreSentence({ start: 0, end: 4, text: 'so yeah and then we went there' })).toBe(0);
    expect(u.scoreSentence({ start: 0, end: 4, text: 'Hi.' })).toBe(0);
  });

  test('replay lift finds the rewatched stretch, not the intro everyone starts with', () => {
    const { heatmap, rows } = replayData();
    // Every session starts at 0, so the raw heatmap would make the start look hot.
    heatmap.buckets[0] = 60;
    rows.forEach((r, i) => { if (i % 2) r.maxPosition = 300; });
    const sig = u.replayLift({ heatmap, rows, duration: 600 });
    expect(sig).not.toBeNull();
    const peaks = u.replayCandidates(sig);
    expect(peaks.length).toBeGreaterThanOrEqual(1);
    expect(peaks[0].start).toBeCloseTo(240, 0);
    expect(peaks[0].end).toBeCloseTo(264, 0);
    expect(peaks[0].reason.kind).toBe('replay');
  });

  test('too few sessions: no replay signal', () => {
    const { heatmap, rows } = replayData({ sessions: 3 });
    expect(u.replayLift({ heatmap, rows, duration: 600, minSessions: 5 })).toBeNull();
  });

  test('comments group by moment and count distinct people', () => {
    const c = u.commentCandidates([
      { t: 100, author: 'fan', kind: 'comment' },
      { t: 110, author: 'fan2', kind: 'comment' },
      { t: 112, author: 'fan', kind: 'comment' },
      { t: 400, author: 'fan3', kind: 'comment' },
    ]);
    expect(c).toHaveLength(2);
    expect(c[0].reason).toEqual({ kind: 'comments', count: 2 });
    expect(c[0].start).toBe(85);
    expect(c[1].reason.count).toBe(1);
  });

  test('a chat spike stands out against the average slot', () => {
    const lines = [];
    for (let i = 0; i < 12; i += 1) lines.push({ t: 300 + i, author: `fan${i}`, kind: 'chat' });
    lines.push({ t: 20, author: 'fan', kind: 'chat' }, { t: 500, author: 'fan', kind: 'chat' });
    const c = u.chatCandidates(lines, 600);
    expect(c).toHaveLength(1);
    expect(c[0].reason).toEqual({ kind: 'chat', count: 12 });
    expect(c[0].start).toBe(280);
    expect(u.chatCandidates(lines.slice(0, 3), 600)).toEqual([]);
  });

  test('ranges are padded to 30 s, cut to 60 s, kept inside the video', () => {
    expect(u.fitRange(100, 104, 600)).toEqual({ start: 87, end: 117 });
    const long = u.fitRange(100, 200, 600);
    expect(long.end - long.start).toBe(60);
    expect(u.fitRange(-10, 5, 600)).toEqual({ start: 0, end: 30 });
    expect(u.fitRange(590, 600, 600)).toEqual({ start: 570, end: 600 });
  });

  test('signals merge: a replayed, commented, quotable range ranks first with every reason', () => {
    const { heatmap, rows } = replayData();
    const replies = [
      { author: 'fan', body: 'this part!', json_metadata: { parentTimestamp: 250 } },
      { author: 'fan2', body: 'haha at 4:15', json_metadata: '{}' },
      { author: 'fan3', body: 'and 8:00 too', json_metadata: '{}' },
    ];
    const subtitles = srt([
      [10, 14, 'Welcome back to the channel everyone.'],
      [244, 249, 'Why do 9 out of 10 people never finish their first video?'],
      [249, 255, 'It is the biggest mistake and the fix is simple.'],
    ]);
    const out = buildClipIdeas({ duration: 600, heatmap, rows, replies, subtitles });
    expect(out.signals).toEqual({ replay: true, comments: 3, chat: 0, transcript: true });
    const [first] = out.suggestions;
    expect(first.score).toBe(100);
    expect(first.reasons.map((r) => r.kind)).toEqual(['replay', 'comments', 'quote']);
    expect(first.reasons[1].count).toBe(2);
    expect(first.start).toBeLessThanOrEqual(244);
    expect(first.end).toBeGreaterThanOrEqual(255);
    for (const s of out.suggestions) {
      expect(s.end - s.start).toBeGreaterThanOrEqual(15);
      expect(s.end - s.start).toBeLessThanOrEqual(60);
      expect(s.start).toBeGreaterThanOrEqual(0);
      expect(s.end).toBeLessThanOrEqual(600);
    }
    // The 8:00 comment is its own, weaker suggestion.
    expect(out.suggestions.some((s) => s.start <= 480 && s.end >= 480 && s.reasons[0].kind === 'comments')).toBe(true);
  });

  test('premiere chat counts as chat', () => {
    const premiereChat = Array.from({ length: 10 }, (_, i) => ({ user: `fan${i}`, offset: 200 + i }));
    const out = buildClipIdeas({ duration: 600, premiereChat });
    expect(out.signals.chat).toBe(10);
    expect(out.suggestions[0].reasons).toEqual([{ kind: 'chat', count: 10 }]);
  });

  test('a video too short for a clip, or with no data, has no suggestions', () => {
    expect(buildClipIdeas({ duration: 20 }).suggestions).toEqual([]);
    expect(buildClipIdeas({ duration: 600 })).toEqual({
      suggestions: [], signals: { replay: false, comments: 0, chat: 0, transcript: false },
    });
  });
});

/* ── the route ─────────────────────────────────────────────────────────── */

function matches(doc, q) {
  return Object.entries(q).every(([k, v]) => {
    if (k === '$or') return v.some((alt) => matches(doc, alt));
    const d = doc[k];
    if (v && typeof v === 'object') {
      return Object.entries(v).every(([op, x]) => {
        if (op === '$in') return x.some((y) => String(y) === String(d));
        if (op === '$exists') return (d !== undefined) === x;
        throw new Error(`unsupported ${op}`);
      });
    }
    return String(d) === String(v);
  });
}

let DATA;
function fakeDb() {
  const col = (name) => {
    const rows = () => (DATA[name] = DATA[name] || []);
    return {
      findOne: async (q) => rows().find((d) => matches(d, q)) || null,
      find: (q) => {
        let out = rows().filter((d) => matches(d, q));
        const cur = { limit: (n) => { out = out.slice(0, n); return cur; }, toArray: async () => out };
        return cur;
      },
    };
  };
  return { collection: col };
}

function app() {
  const a = express();
  a.use('/', router);
  return a;
}
const vouch = { user: 'badadib', signature: 'good', timestamp: Date.now() };

beforeEach(() => {
  router._test.reset();
  const { heatmap, rows } = replayData();
  DATA = {
    'embed-video': [
      { owner: 'badadib', permlink: 'abc123', hive_permlink: 'my-long-video', duration: 600 },
      { owner: 'badadib', permlink: 'short1', duration: 40, short: true },
    ],
    'view-heatmaps': [heatmap],
    'view-durations': rows.map((r) => ({ ...r, owner: 'badadib', permlink: 'abc123' })),
    premiere_chat: [],
    subtitles: [{ author: 'badadib', permlink: 'my-long-video', subtitles: { en: CID } }],
  };
  getDb.mockReturnValue(fakeDb());
  hiveRpcCall.mockReset();
  hiveRpcCall.mockResolvedValue([
    { author: 'fan', body: 'this!', json_metadata: JSON.stringify({ parentTimestamp: 250 }) },
    { author: 'badadib', body: 'thanks, see 4:10', json_metadata: '{}' },
    { author: 'ai-agent-hunter', body: 'bot at 4:10', json_metadata: '{}' },
  ]);
  fetchSubtitleText.mockReset();
  fetchSubtitleText.mockResolvedValue({ text: srt([[244, 249, 'Why do 9 out of 10 people never finish their first video?']]) });
});

describe('POST /creator-stats/clip-ideas', () => {
  test('needs a good vouch', async () => {
    const r = await request(app()).post('/creator-stats/clip-ideas').send({ ...vouch, signature: 'bad', permlink: 'abc123' });
    expect(r.status).toBe(401);
  });

  test('the owner gets ranked suggestions; own comments and muted bots are left out', async () => {
    const r = await request(app()).post('/creator-stats/clip-ideas').send({ ...vouch, permlink: 'my-long-video', lang: 'en' });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.permlink).toBe('abc123');
    expect(r.body.duration).toBe(600);
    expect(r.body.signals).toEqual({ replay: true, comments: 1, chat: 0, transcript: true });
    expect(r.body.suggestions[0].reasons.map((x) => x.kind)).toEqual(['replay', 'comments', 'quote']);
    expect(hiveRpcCall).toHaveBeenCalledWith('condenser_api.get_content_replies', ['badadib', 'my-long-video']);
    expect(fetchSubtitleText).toHaveBeenCalledWith(CID);
    expect(r.headers['cache-control']).toBe('no-store');
  });

  test('someone else asking about the video gets 404', async () => {
    const r = await request(app()).post('/creator-stats/clip-ideas').send({ ...vouch, user: 'fan', permlink: 'abc123' });
    expect(r.status).toBe(404);
  });

  test('a Short gets no suggestions and asks nobody', async () => {
    const r = await request(app()).post('/creator-stats/clip-ideas').send({ ...vouch, permlink: 'short1' });
    expect(r.status).toBe(200);
    expect(r.body.short).toBe(true);
    expect(r.body.suggestions).toEqual([]);
    expect(hiveRpcCall).not.toHaveBeenCalled();
  });

  test('Hive and IPFS failing still answers from the replays', async () => {
    hiveRpcCall.mockRejectedValue(new Error('down'));
    fetchSubtitleText.mockRejectedValue(new Error('slow'));
    const r = await request(app()).post('/creator-stats/clip-ideas').send({ ...vouch, permlink: 'abc123' });
    expect(r.status).toBe(200);
    expect(r.body.signals).toEqual({ replay: true, comments: 0, chat: 0, transcript: false });
    expect(r.body.suggestions[0].reasons).toEqual([expect.objectContaining({ kind: 'replay' })]);
  });

  test('an answer is cached per video', async () => {
    await request(app()).post('/creator-stats/clip-ideas').send({ ...vouch, permlink: 'abc123' });
    await request(app()).post('/creator-stats/clip-ideas').send({ ...vouch, permlink: 'abc123' });
    expect(hiveRpcCall).toHaveBeenCalledTimes(1);
  });

  test('a bad permlink is refused', async () => {
    const r = await request(app()).post('/creator-stats/clip-ideas').send({ ...vouch, permlink: '../x' });
    expect(r.status).toBe(400);
  });
});

test('server.js mounts clip ideas before the streamStats catch-all 401', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  const at = src.indexOf("require('./routes/clipIdeas')");
  expect(at).toBeGreaterThan(0);
  expect(at).toBeLessThan(src.indexOf("app.use('/', streamStatsRoutes)"));
});
