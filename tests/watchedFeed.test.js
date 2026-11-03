/**
 * The /watched feed: audio listens get their own tab. The playlists service
 * stores only `short`, so audio rows are recognised by matching embed-audio and
 * flagged once; they leave the Videos tab and come back as embed-audio docs.
 */
const express = require('express');
const request = require('supertest');

const store = {};
const get = (o, k) => o[k];
function matches(doc, q) {
  return Object.entries(q || {}).every(([k, cond]) => {
    if (k === '$or') return cond.some((c) => matches(doc, c));
    const v = get(doc, k);
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      return Object.entries(cond).every(([op, x]) => {
        if (op === '$in') return x.includes(v);
        if (op === '$ne') return v !== x;
        if (op === '$exists') return (v !== undefined) === x;
        if (op === '$gte') return v >= x;
        return false;
      });
    }
    return v === cond;
  });
}
function cursor(list) {
  let l = [...list];
  const c = {
    sort(spec) { const [[k, d]] = Object.entries(spec); l.sort((a, b) => (a[k] > b[k] ? 1 : -1) * d); return c; },
    skip(n) { l = l.slice(n); return c; },
    limit(n) { l = l.slice(0, n); return c; },
    toArray: async () => l,
  };
  return c;
}
const coll = (name) => {
  store[name] = store[name] || [];
  const rows = store[name];
  return {
    find: (q) => cursor(rows.filter((d) => matches(d, q))),
    countDocuments: async (q) => rows.filter((d) => matches(d, q)).length,
    bulkWrite: async (ops) => {
      for (const { updateOne: u } of ops) {
        const d = rows.find((r) => matches(r, u.filter));
        if (d) Object.assign(d, u.update.$set);
      }
    },
  };
};
jest.mock('../utils/db', () => ({ getDb: () => ({ collection: coll }) }));
jest.mock('../utils/config', () => ({ ENABLE_MONGO_WRITES: true }));

const router = require('../routes/watchedFeed');
const app = express();
app.use('/feeds', router);

const at = (s) => new Date(Date.UTC(2026, 10, 2, 0, 0, s));
beforeEach(() => {
  store.watch_history = [
    { _id: 1, username: 'alice', author: 'bob', permlink: 'vid1', last_watched_at: at(1) },
    { _id: 2, username: 'alice', author: 'carol', permlink: 'aud1', last_watched_at: at(2) },
    { _id: 3, username: 'alice', author: 'dave', permlink: 'hive-post-of-aud2', last_watched_at: at(3) },
  ];
  store['embed-video'] = [{ owner: 'bob', permlink: 'vid1', hive_permlink: 'vid1-hive', hive_title: 'A video', short: false }];
  store.videos = [];
  store['embed-audio'] = [
    { _id: 'a1', owner: 'carol', permlink: 'aud1', title: 'Track one', status: 'published' },
    { _id: 'a2', owner: 'dave', permlink: 'aud2', post_permlink: 'hive-post-of-aud2', title: 'Track two', status: 'published' },
  ];
});

describe('GET /feeds/watched/:username', () => {
  it('splits audio into its own tab and counts it', async () => {
    const res = await request(app).get('/feeds/watched/alice?type=videos');
    expect(res.body.counts).toEqual({ videos: 1, shorts: 0, audio: 2 });
    expect(res.body.videos.map((v) => v.permlink)).toEqual(['vid1-hive']);
    expect(store.watch_history.map((r) => r.audio)).toEqual([false, true, true]);
  });

  it('returns audio entries as embed-audio docs, by asset or Hive post permlink', async () => {
    const res = await request(app).get('/feeds/watched/alice?type=audio');
    expect(res.body.total).toBe(2);
    expect(res.body.videos.map((v) => [v.title, v._audio, v._historyKey])).toEqual([
      ['Track two', true, 'dave/hive-post-of-aud2'],
      ['Track one', true, 'carol/aud1'],
    ]);
  });
});
