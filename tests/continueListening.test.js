/**
 * POST /podcasts/progress/recent: the audio page's "Continue listening". Mongo and
 * the vouch check are stand-ins; nothing leaves the process.
 */
jest.mock('../utils/db', () => ({ getDb: jest.fn() }));
jest.mock('../utils/hiveAuth', () => ({
  verifyHiveAuthority: jest.fn(async () => ({ ok: false })),
  verifyDelegateVouch: jest.fn(async ({ signature }) => ({ ok: signature === 'good' })),
}));
const express = require('express');
const request = require('supertest');
const { ObjectId } = require('mongodb');
const { getDb } = require('../utils/db');
const router = require('../routes/podcasts');

const FEED = new ObjectId();
const PRIV = new ObjectId();
const TRACK = new ObjectId();
const GONE = new ObjectId();
const ep = (feed, n) => `${feed.toHexString()}:${String(n).padStart(16, 'a')}`;
const at = (n) => new Date(Date.UTC(2026, 10, n));

const DATA = {
  podcast_progress: [
    { user: 'alice', ep: ep(FEED, 1), pos: 600, dur: 1800, at: at(5) },
    { user: 'alice', ep: TRACK.toHexString(), pos: 90, dur: 240, at: at(4) },
    { user: 'alice', ep: ep(PRIV, 2), pos: 300, dur: 1200, at: at(6) },
    { user: 'alice', ep: GONE.toHexString(), pos: 50, dur: 200, at: at(7) },
    { user: 'alice', ep: ep(FEED, 3), pos: 5, dur: 1800, at: at(8) },
    { user: 'alice', ep: ep(FEED, 4), pos: 1790, dur: 1800, done: true, at: at(9) },
    { user: 'bob', ep: ep(FEED, 5), pos: 100, dur: 1800, at: at(9) },
  ],
  podcast_episodes: [
    { _id: ep(FEED, 1), feed_id: FEED, title: 'One', audio_url: 'https://cdn.example.com/1.mp3' },
    { _id: ep(PRIV, 2), feed_id: PRIV, title: 'Secret', audio_url: 'https://cdn.example.com/2.mp3', private: true },
  ],
  podcast_feeds: [
    { _id: FEED, title: 'Show', image: 'https://cdn.example.com/c.jpg', url: 'https://example.com/feed', status: 'ok' },
    { _id: PRIV, title: 'Private show', image: 'https://cdn.example.com/p.jpg', url: 'https://u:p@example.com/feed', status: 'ok', private: true },
  ],
  podcast_subs: [],
  'embed-audio': [{ _id: TRACK, owner: 'badadib', permlink: 'abc', title: 'A track', status: 'published' }],
};

// Just enough of find / sort / limit / toArray for the queries this route makes.
const matches = (doc, q) => Object.entries(q).every(([k, v]) => {
  const d = doc[k];
  if (v && typeof v === 'object' && !(v instanceof ObjectId) && !(v instanceof Date)) {
    if ('$in' in v) return v.$in.some((x) => String(x) === String(d));
    if ('$ne' in v) return d !== v.$ne;
    if ('$gte' in v) return d >= v.$gte;
  }
  return String(d) === String(v);
});
function fakeDb() {
  return {
    collection: (name) => ({
      find: (q) => {
        let rows = (DATA[name] || []).filter((d) => matches(d, q));
        const cur = {
          sort: (s) => { const [[k, dir]] = Object.entries(s); rows = [...rows].sort((a, b) => (a[k] - b[k]) * dir); return cur; },
          limit: (n) => { rows = rows.slice(0, n); return cur; },
          toArray: async () => rows,
        };
        return cur;
      },
      aggregate: () => ({ toArray: async () => [] }),
    }),
  };
}

const app = express().use('/podcasts', router);
const ask = (body) => request(app).post('/podcasts/progress/recent').send(body);

beforeEach(() => {
  getDb.mockReturnValue(fakeDb());
  DATA.podcast_subs = [];
});

describe('continue listening', () => {
  test('needs the session vouch', async () => {
    expect((await ask({ user: 'alice', signature: 'bad', timestamp: Date.now() })).status).toBe(401);
    expect((await ask({ user: 'alice' })).status).toBe(401);
  });

  test('unfinished episodes and tracks, newest first; samples, finished, gone and other people left out', async () => {
    const res = await ask({ user: 'alice', signature: 'good', timestamp: Date.now() });
    expect(res.status).toBe(200);
    expect(res.body.items.map((i) => [i.kind, i.id])).toEqual([
      ['episode', ep(FEED, 1)],
      ['track', TRACK.toHexString()],
    ]);
    const [first, second] = res.body.items;
    expect(first).toMatchObject({ pos: 600, dur: 1800, episode: { title: 'One' }, feed: { title: 'Show' } });
    expect(second.track).toMatchObject({ owner: 'badadib', permlink: 'abc' });
  });

  test("a private show's episode only while the listener follows it, and its feed URL never goes out", async () => {
    DATA.podcast_subs = [{ _id: `alice|${PRIV.toHexString()}` }];
    const res = await ask({ user: 'alice', signature: 'good', timestamp: Date.now() });
    expect(res.body.items[0]).toMatchObject({ kind: 'episode', id: ep(PRIV, 2), feed: { private: true, url: '' } });
  });
});
