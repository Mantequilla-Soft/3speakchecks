/**
 * Continue watching: services/viewerProgress.js copies opted-in viewers' player
 * sessions into viewer_progress, and routes/continueWatching.js lists and hides
 * them. Mongo and the vouch check are stand-ins; nothing leaves the process.
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
const { syncViewerProgress } = require('../services/viewerProgress');
const router = require('../routes/continueWatching');

const min = (n) => new Date(Date.now() - n * 60 * 1000);

// Just enough of a query language for the filters these two files use.
function matches(doc, q) {
  return Object.entries(q).every(([k, v]) => {
    if (k === '$or') return v.some((alt) => matches(doc, alt));
    const d = doc[k];
    if (v && typeof v === 'object' && !(v instanceof ObjectId) && !(v instanceof Date)) {
      return Object.entries(v).every(([op, x]) => {
        if (op === '$in') return x.some((y) => String(y) === String(d));
        if (op === '$ne') return d !== x;
        if (op === '$gte') return d >= x;
        if (op === '$lte') return d <= x;
        if (op === '$lt') return d < x;
        if (op === '$exists') return (d !== undefined) === x;
        if (op === '$type') return typeof d === x;
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
    const apply = (doc, u) => {
      Object.assign(doc, u.$set || {});
      for (const k of Object.keys(u.$unset || {})) delete doc[k];
    };
    return {
      createIndex: async () => 'ok',
      findOne: async (q) => rows().find((d) => matches(d, q)) || null,
      find: (q) => {
        let out = rows().filter((d) => matches(d, q));
        const cur = {
          sort: (s) => { const [[k, dir]] = Object.entries(s); out = [...out].sort((a, b) => (a[k] - b[k]) * dir); return cur; },
          limit: (n) => { out = out.slice(0, n); return cur; },
          toArray: async () => out,
        };
        return cur;
      },
      updateOne: async (q, u) => {
        const doc = rows().find((d) => matches(d, q));
        if (!doc) return { matchedCount: 0 };
        apply(doc, u);
        return { matchedCount: 1 };
      },
      deleteMany: async (q) => {
        const before = rows().length;
        DATA[name] = rows().filter((d) => !matches(d, q));
        return { deletedCount: before - DATA[name].length };
      },
      // updateOne + upsert, with the unique (viewer, owner, permlink) key.
      bulkWrite: async (ops) => {
        const writeErrors = [];
        for (const { updateOne: { filter, update } } of ops) {
          const doc = rows().find((d) => matches(d, filter));
          if (doc) { apply(doc, update); continue; }
          const { viewer, owner, permlink } = filter;
          if (rows().some((d) => d.viewer === viewer && d.owner === owner && d.permlink === permlink)) {
            writeErrors.push({ code: 11000 });
            continue;
          }
          const fresh = { viewer, owner, permlink, ...(update.$setOnInsert || {}) };
          apply(fresh, update);
          rows().push(fresh);
        }
        if (writeErrors.length) throw Object.assign(new Error('E11000'), { writeErrors });
      },
    };
  };
  return { collection: col };
}

const session = (over) => ({
  owner: 'badadib', permlink: 'vid1', type: 'embed', source: '3speak', viewer: 'alice',
  heatmapDuration: 600, lastPosition: 120, startedAt: min(30), lastBeatAt: min(10), private: false, ...over,
});

beforeEach(() => {
  DATA = {
    ad_viewer_prefs: [{ _id: 'alice', rewardsEnabled: true }, { _id: 'bob', rewardsEnabled: false }],
    'view-sessions': [],
    viewer_progress: [],
    'embed-video': [],
    videos: [],
  };
  getDb.mockReturnValue(fakeDb());
});

describe('syncViewerProgress', () => {
  test('copies an opted-in viewer\'s session with its playhead and share', async () => {
    DATA['view-sessions'].push(session());
    const r = await syncViewerProgress({ since: min(60) });
    expect(r.written).toBe(1);
    expect(DATA.viewer_progress).toEqual([expect.objectContaining({
      viewer: 'alice', owner: 'badadib', permlink: 'vid1', type: 'embed', position: 120, duration: 600, pct: 20,
    })]);
  });

  test('nobody who has not opted in, no anonymous, private, live or beat-less sessions', async () => {
    DATA['view-sessions'].push(
      session({ viewer: 'bob' }),
      session({ viewer: 'carol' }),
      session({ viewer: null }),
      session({ private: true }),
      session({ type: 'live' }),
      session({ permlink: 'nobeat', lastBeatAt: min(30) }),
    );
    await syncViewerProgress({ since: min(60) });
    expect(DATA.viewer_progress).toEqual([]);
  });

  test('the later heartbeat wins, whichever order the sessions come in', async () => {
    DATA['view-sessions'].push(session({ lastPosition: 300, lastBeatAt: min(5) }), session({ lastPosition: 60, lastBeatAt: min(20) }));
    await syncViewerProgress({ since: min(60) });
    expect(DATA.viewer_progress).toHaveLength(1);
    expect(DATA.viewer_progress[0].position).toBe(300);

    // A newer session moves it, an older one never does.
    DATA['view-sessions'] = [session({ lastPosition: 400, lastBeatAt: min(1) })];
    await syncViewerProgress({ since: min(60) });
    expect(DATA.viewer_progress[0].position).toBe(400);
  });

  test('a hidden row stays hidden when the video is watched again', async () => {
    DATA.viewer_progress.push({ viewer: 'alice', owner: 'badadib', permlink: 'vid1', position: 10, duration: 600, pct: 1.7, at: min(50), hidden: true });
    DATA['view-sessions'].push(session());
    await syncViewerProgress({ since: min(60) });
    expect(DATA.viewer_progress[0]).toEqual(expect.objectContaining({ position: 120, hidden: true }));
  });
});

const app = express().use('/feeds', router);
const list = (body = { user: 'alice', signature: 'good', timestamp: Date.now() }) => request(app).post('/feeds/continue-watching').send(body);
const hide = (body) => request(app).post('/feeds/continue-watching/hide').send({ user: 'alice', signature: 'good', timestamp: Date.now(), ...body });
const ev = (permlink, over) => ({ _id: new ObjectId(), owner: 'badadib', permlink, hive_author: 'badadib', hive_permlink: `hive-${permlink}`, hive_title: permlink, status: 'published', duration: 600, ...over });
const row = (permlink, pct, at, over) => ({ viewer: 'alice', owner: 'badadib', permlink, type: 'embed', position: pct * 6, duration: 600, pct, at: min(at), ...over });

describe('POST /feeds/continue-watching', () => {
  test('a bad or stale vouch is refused', async () => {
    expect((await list({ user: 'alice', signature: 'bad', timestamp: Date.now() })).status).toBe(401);
    expect((await list({ user: 'alice', signature: 'good', timestamp: Date.now() - 2 * 86400 * 1000 })).status).toBe(401);
  });

  test('not opted into viewer rewards: enabled false, nothing listed', async () => {
    const res = await list({ user: 'bob', signature: 'good', timestamp: Date.now() });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, enabled: false, videos: [] });
  });

  test('only 10 % to 75 %, not hidden, newest first, with the progress and the hide key', async () => {
    DATA['embed-video'].push(ev('a'), ev('b'), ev('low'), ev('high'), ev('hid'), ev('edge10'), ev('edge75'));
    DATA.viewer_progress.push(
      row('a', 40, 30), row('b', 20, 5), row('low', 9.9, 1), row('high', 75.1, 1), row('hid', 50, 1, { hidden: true }),
      row('edge10', 10, 40), row('edge75', 75, 50), row('a', 40, 1, { viewer: 'bob' }),
    );
    const res = await list();
    expect(res.body.enabled).toBe(true);
    expect(res.body.videos.map((v) => v.permlink)).toEqual(['hive-b', 'hive-a', 'hive-edge10', 'hive-edge75']);
    expect(res.body.videos[0]).toEqual(expect.objectContaining({
      author: 'badadib', _progressKey: 'badadib/b', progress: expect.objectContaining({ position: 120, duration: 600, pct: 20 }),
    }));
  });

  test('shorts, unpublished, expired stories and vanished videos are left out; legacy uploads come from videos', async () => {
    DATA['embed-video'].push(
      ev('short', { short: true }),
      ev('gone', { status: 'deleted' }),
      ev('story', { story: true, story_expires_at: min(1) }),
    );
    DATA.videos.push({ _id: new ObjectId(), owner: 'badadib', permlink: 'old', title: 'Old one', status: 'published' });
    DATA.viewer_progress.push(row('short', 30, 1), row('gone', 30, 2), row('story', 30, 3), row('missing', 30, 4), row('old', 30, 5, { type: 'legacy' }));
    const res = await list();
    expect(res.body.videos).toEqual([expect.objectContaining({ permlink: 'old', author: 'badadib', title: 'Old one', _progressKey: 'badadib/old' })]);
  });

  test('a video left minutes ago is listed before the background sync runs', async () => {
    DATA['embed-video'].push(ev('vid1'));
    DATA['view-sessions'].push(session({ lastPosition: 240 }));
    const res = await list();
    expect(res.body.videos.map((v) => v._progressKey)).toEqual(['badadib/vid1']);
    expect(res.body.videos[0].progress.pct).toBe(40);
  });
});

describe('POST /feeds/continue-watching/hide', () => {
  test('hides, and Undo brings it back', async () => {
    DATA['embed-video'].push(ev('a'));
    DATA.viewer_progress.push(row('a', 40, 3));
    expect((await hide({ owner: 'badadib', permlink: 'a' })).body).toEqual({ success: true, found: true });
    expect((await list()).body.videos).toEqual([]);
    await hide({ owner: 'badadib', permlink: 'a', hidden: false });
    expect((await list()).body.videos).toHaveLength(1);
  });

  test('only the caller\'s own row, and only with a good vouch', async () => {
    DATA.viewer_progress.push(row('a', 40, 3, { viewer: 'bob' }));
    expect((await hide({ owner: 'badadib', permlink: 'a' })).body.found).toBe(false);
    expect(DATA.viewer_progress[0].hidden).toBeUndefined();
    expect((await hide({ owner: 'badadib', permlink: 'a', signature: 'bad' })).status).toBe(401);
    expect((await hide({ owner: 'Bad Owner!', permlink: 'a' })).status).toBe(400);
  });
});
