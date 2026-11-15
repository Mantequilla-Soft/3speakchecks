/**
 * Boosts: the memo format (utils/boosts.js), the boost wall with its transfer
 * scan (routes/boosts.js), and streamed sats added up per day
 * (services/lightningSupports.js recordStream). Stand-in Mongo and Hive.
 */
jest.mock('../utils/db', () => ({ getDb: jest.fn() }));
jest.mock('../utils/hive', () => ({ transfersSince: jest.fn(async () => []), hiveRpcBatch: jest.fn(async () => [{ result: { base: '0.250 HBD', quote: '1.000 HIVE' } }]), historySince: jest.fn() }));
jest.mock('../utils/hiddenCreators', () => ({ isHiddenSync: jest.fn(() => false), hiddenListSync: jest.fn(() => []) }));
const express = require('express');
const request = require('supertest');
const { getDb } = require('../utils/db');
const { transfersSince } = require('../utils/hive');
const { boostKind, wallMessage, linkedPosts, streamKey } = require('../utils/boosts');
const router = require('../routes/boosts');
const { recordStream } = require('../services/lightningSupports')._test;

describe('memo format', () => {
  const memo = 'Great one! https://3speak.tv/watch?v=badadib/vid #boost';
  it('tells boosts and streams apart', () => {
    expect(boostKind(memo)).toBe('boost');
    expect(boostKind('https://3speak.tv/audio/badadib/song #stream')).toBe('stream');
    expect(boostKind('thanks https://3speak.tv/watch?v=badadib/vid')).toBeNull();
    expect(boostKind('#boosted')).toBeNull();
  });
  it('keeps only the sender\'s words', () => {
    expect(wallMessage(memo)).toBe('Great one!');
    expect(wallMessage('badadib | https://3speak.tv/audio/badadib/song #boost')).toBe('badadib |');
    expect(wallMessage('https://3speak.tv/watch?v=badadib/vid #boost')).toBeNull();
  });
  it('finds the linked posts in every link form', () => {
    expect(linkedPosts('a https://3speak.tv/shorts?v=badadib/abc b https://3speak.tv/@badadib/vid')).toEqual([['badadib', 'abc'], ['badadib', 'vid']]);
  });
  it('one stream row per listener, post and day', () => {
    expect(streamKey({ author: 'badadib', permlink: 'song', tipper: null, at: Date.parse('2026-11-15T10:00:00Z') })).toBe('stream:2026-11-15:badadib/song:anon');
  });
});

// A supports collection with just what these files use.
function fakeColl(rows) {
  const match = (d, q) => Object.entries(q).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('$in' in v) return v.in === undefined && v.$in.includes(d[k]);
      if ('$ne' in v) return Array.isArray(d[k]) ? !d[k].includes(v.$ne) : d[k] !== v.$ne;
    }
    return d[k] === v;
  });
  return {
    rows,
    createIndex: async () => 'ok',
    find: (q) => {
      let out = rows.filter((d) => match(d, q));
      const cur = { sort: () => { out = [...out].sort((a, b) => b.tippedAt - a.tippedAt); return cur; }, limit: (n) => { out = out.slice(0, n); return cur; }, toArray: async () => out };
      return cur;
    },
    aggregate: (pipe) => ({
      toArray: async () => {
        const list = rows.filter((d) => match(d, pipe[0].$match));
        if (!list.length) return [];
        return [{ hbd: list.reduce((n, r) => n + (r.hbd_value || 0), 0), sats: list.reduce((n, r) => n + (r.currency === 'SATS' ? r.amount : 0), 0), count: list.length, boosts: list.filter((r) => r.boost).length }];
      },
    }),
    insertOne: async (doc) => {
      if (rows.some((r) => r.trx_id === doc.trx_id)) { const e = new Error('dup'); e.code = 11000; throw e; }
      rows.push(doc);
    },
    updateOne: async (q, u, { upsert }) => {
      const doc = rows.find((d) => match(d, q));
      if (doc) {
        for (const [k, v] of Object.entries(u.$inc || {})) doc[k] = (doc[k] || 0) + v;
        for (const [k, v] of Object.entries(u.$push || {})) doc[k] = [...(doc[k] || []), ...v.$each];
        for (const [k, v] of Object.entries(u.$max || {})) if (!(doc[k] >= v)) doc[k] = v;
        return;
      }
      if (rows.some((r) => r.trx_id === q.trx_id)) { const e = new Error('dup'); e.code = 11000; throw e; }
      if (!upsert) return;
      rows.push({ trx_id: q.trx_id, ...u.$setOnInsert, ...u.$inc, ...u.$max, stream_trx: [...u.$push.stream_trx.$each] });
    },
  };
}

describe('recordStream', () => {
  it('adds a listener\'s streamed sats into one row a day, each credit once', async () => {
    const coll = fakeColl([]);
    const credit = (trx, sats, ts) => ({ trx_id: trx, to: 'badadib', permlink: 'song', sats, timestamp: ts, block: 1 });
    expect(await recordStream(coll, credit('t1', 10, '2026-11-15T10:00:00'), null, 'audio')).toBe(true);
    expect(await recordStream(coll, credit('t2', 10, '2026-11-15T10:01:00'), null, 'audio')).toBe(true);
    expect(await recordStream(coll, credit('t2', 10, '2026-11-15T10:01:00'), null, 'audio')).toBe(false);
    expect(await recordStream(coll, credit('t3', 10, '2026-11-16T00:00:10'), null, 'audio')).toBe(true);
    expect(coll.rows).toHaveLength(2);
    expect(coll.rows[0]).toMatchObject({ trx_id: 'stream:2026-11-15:badadib/song:anon', amount: 20, currency: 'SATS', stream: true, tipper: null, author: 'badadib', permlink: 'song' });
    expect(coll.rows[0].stream_trx).toEqual(['t1', 't2']);
  });
});

describe('GET /boosts/:author/:permlink', () => {
  let coll; let app;
  const content = { 'embed-video': [{ owner: 'badadib', permlink: 'asset1', hive_author: 'badadib', hive_permlink: 'vid' }] };
  beforeEach(() => {
    jest.clearAllMocks();
    router._test.lastScan.clear();
    coll = fakeColl([
      { trx_id: 'a', tipper: 'fan', author: 'badadib', permlink: 'vid', amount: 1, currency: 'HBD', hbd_value: 1, memo: 'Love it https://3speak.tv/watch?v=badadib/vid #boost', boost: true, tippedAt: new Date('2026-11-15T09:00:00Z') },
      { trx_id: 'b', tipper: null, author: 'badadib', permlink: 'asset1', amount: 120, currency: 'SATS', hbd_value: 0, via: 'lightning', stream: true, memo: null, tippedAt: new Date('2026-11-15T10:00:00Z') },
      { trx_id: 'c', tipper: 'fan', author: 'badadib', permlink: 'vid', amount: 5, currency: 'HBD', hbd_value: 5, memo: 'hidden', hidden: true, tippedAt: new Date('2026-11-15T11:00:00Z') },
      { trx_id: 'd', tipper: 'fan', author: 'badadib', permlink: 'other', amount: 5, currency: 'HBD', hbd_value: 5, tippedAt: new Date('2026-11-15T11:00:00Z') },
    ]);
    getDb.mockReturnValue({
      collection: (n) => (n === 'supports' ? coll : { findOne: async (q) => (n === 'embed-video' && q.$or.some((o) => o.permlink === 'vid' || o.hive_permlink === 'vid') ? content['embed-video'][0] : null) }),
    });
    app = express();
    app.use('/', router);
  });

  it('lists the post\'s visible tips under every permlink it has, with messages', async () => {
    const res = await request(app).get('/boosts/badadib/vid');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total_hbd: 1, total_sats: 120, count: 2, boosts: 1 });
    expect(res.body.items).toEqual([
      expect.objectContaining({ tipper: null, amount: 120, currency: 'SATS', stream: true, boost: false, via: 'lightning', message: null }),
      expect.objectContaining({ tipper: 'fan', amount: 1, currency: 'HBD', boost: true, stream: false, message: 'Love it' }),
    ]);
  });

  it('records a boost sent from another wallet, found in the creator\'s transfers', async () => {
    transfersSince.mockResolvedValueOnce([
      [1, { trx_id: 'x1', block: 9, timestamp: '2026-11-15T08:00:00', op: ['transfer', { from: 'fan', to: 'badadib', amount: '4.000 HIVE', memo: 'From Ecency https://3speak.tv/watch?v=badadib/vid #boost' }] }],
      [2, { trx_id: 'x2', block: 9, timestamp: '2026-11-15T08:00:00', op: ['transfer', { from: 'fan', to: 'badadib', amount: '1.000 HIVE', memo: 'no tag https://3speak.tv/watch?v=badadib/vid' }] }],
      [3, { trx_id: 'x3', block: 9, timestamp: '2026-11-15T08:00:00', op: ['transfer', { from: 'badadib', to: 'fan', amount: '1.000 HIVE', memo: 'https://3speak.tv/watch?v=badadib/vid #boost' }] }],
      [4, { trx_id: 'a', block: 9, timestamp: '2026-11-15T09:00:00', op: ['transfer', { from: 'fan', to: 'badadib', amount: '1.000 HBD', memo: 'Love it https://3speak.tv/watch?v=badadib/vid #boost' }] }],
    ]);
    const res = await request(app).get('/boosts/badadib/vid');
    expect(res.body.count).toBe(3);
    const added = coll.rows.find((r) => r.trx_id === 'x1');
    expect(added).toMatchObject({ tipper: 'fan', author: 'badadib', permlink: 'vid', amount: 4, currency: 'HIVE', hbd_value: 1, boost: true, found_by: 'scan' });
    // The scan runs at most every few minutes per creator.
    await request(app).get('/boosts/badadib/vid');
    expect(transfersSince).toHaveBeenCalledTimes(1);
  });

  it('an unknown post has an empty wall, a bad one is refused', async () => {
    expect((await request(app).get('/boosts/badadib/nothing')).body).toMatchObject({ count: 0, items: [] });
    expect((await request(app).get('/boosts/x/vid')).status).toBe(400);
  });
});
