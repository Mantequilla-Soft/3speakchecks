/**
 * "Made from this": utils/derivedSource.js reads what a post was made from (the
 * new '3speak'.source and every older marker), utils/derivedStore.js keeps the
 * rows, routes/derived.js registers and lists them. Mongo and Hive are stand-ins.
 */
jest.mock('../utils/db', () => ({ getDb: jest.fn() }));
jest.mock('../utils/hive', () => ({ hiveRpcBatch: jest.fn() }));
jest.mock('../utils/hiddenCreators', () => ({ hiddenListSync: jest.fn(() => ['hiddenguy']) }));

const express = require('express');
const request = require('supertest');
const { getDb } = require('../utils/db');
const { hiveRpcBatch } = require('../utils/hive');
const { derivedSourceOf, mediaOf, titleOf, thumbnailOf, durationOf } = require('../utils/derivedSource');
const { rowFor, _resetIndexed } = require('../utils/derivedStore');
const router = require('../routes/derived');

const post = (over = {}, meta = {}) => ({
    author: 'alice', permlink: 'my-post', parent_author: '', parent_permlink: 'hive-181335',
    title: '', body: '', created: '2026-11-20T10:00:00', json_metadata: JSON.stringify(meta), ...over,
});

describe('derivedSourceOf', () => {
    test('the new source field wins over older markers', () => {
        const p = post({}, { '3speak': { source: { kind: 'recap', author: 'Bob', permlink: 'room-1', start: 12.34, end: 70 }, audiogram: { author: 'x', permlink: 'y' } } });
        expect(derivedSourceOf(p)).toEqual({ kind: 'recap', author: 'bob', permlink: 'room-1', start: 12.3, end: 70 });
    });

    test('audiogram: the episode, and which piece of it', () => {
        const p = post({}, { '3speak': { audiogram: { author: 'bob', permlink: 'ep-5', start: 60, duration: 30 } } });
        expect(derivedSourceOf(p)).toEqual({ kind: 'audiogram', author: 'bob', permlink: 'ep-5', start: 60, end: 90 });
    });

    test('stream clip: the VOD is host/room', () => {
        const p = post({}, { video: { url: 'u', streamClip: { room: 'bob-abc123', host: 'bob', clipper: 'alice', offset: 300 } } });
        expect(derivedSourceOf(p)).toEqual({ kind: 'stream_clip', author: 'bob', permlink: 'bob-abc123', start: 300 });
    });

    test('the host\'s recap of a stream names its VOD as a recap', () => {
        const p = post({}, { video: { url: 'u', streamClip: { room: 'bob-abc123', host: 'bob', clipper: null, offset: 60, recap: true } } });
        expect(derivedSourceOf(p)).toEqual({ kind: 'recap', author: 'bob', permlink: 'bob-abc123', start: 60 });
    });

    test('a Short from your own video is a clip, from someone else\'s a remix', () => {
        const own = post({}, { video: { url: 'u', originalAuthor: 'alice', originalPermlink: 'long-one' } });
        const other = post({}, { video: { url: 'u', originalAuthor: 'bob', originalPermlink: 'long-one' } });
        expect(derivedSourceOf(own)).toEqual({ kind: 'clip', author: 'alice', permlink: 'long-one' });
        expect(derivedSourceOf(other)).toEqual({ kind: 'remix', author: 'bob', permlink: 'long-one' });
    });

    test('a remix chain names the nearest source first', () => {
        const p = post({}, { video: { url: 'u', originalAuthor: 'carol', originalPermlink: 'orig', remixChain: [{ author: 'bob', permlink: 'mid' }, { author: 'carol', permlink: 'orig' }] } });
        expect(derivedSourceOf(p)).toEqual({ kind: 'remix', author: 'bob', permlink: 'mid' });
    });

    test('narration: the written post it reads out', () => {
        const p = post({}, { audio: {}, '3speak': { tts: { engine: 'piper', voice: 'x', source: 'alice/my-blog' } } });
        expect(derivedSourceOf(p)).toEqual({ kind: 'narration', author: 'alice', permlink: 'my-blog' });
    });

    test('reaction: a reply tagged reaction with a video, at its timestamp', () => {
        const p = post({ parent_author: 'bob', parent_permlink: 'the-video' }, { tags: ['3speak', 'reaction'], parentTimestamp: 42, video: { url: 'u' } });
        expect(derivedSourceOf(p)).toEqual({ kind: 'reaction', author: 'bob', permlink: 'the-video', start: 42 });
        const plain = post({ parent_author: 'bob', parent_permlink: 'the-video' }, { tags: ['3speak'] });
        expect(derivedSourceOf(plain)).toBeNull();
    });

    test('bad values make it null', () => {
        expect(derivedSourceOf(post({}, { '3speak': { source: { kind: 'nope', author: 'bob', permlink: 'p' } } }))).toBeNull();
        expect(derivedSourceOf(post({}, { '3speak': { source: { kind: 'clip', author: 'B@D', permlink: 'p' } } }))).toBeNull();
        expect(derivedSourceOf(post({}, { '3speak': { source: { kind: 'clip', author: 'bob', permlink: 'Not Valid' } } }))).toBeNull();
        expect(derivedSourceOf(post({ json_metadata: '{broken' }))).toBeNull();
        expect(derivedSourceOf(null)).toBeNull();
    });

    test('times out of range are dropped, an end before the start too', () => {
        const p = post({}, { '3speak': { source: { kind: 'clip', author: 'bob', permlink: 'p', start: 50, end: 20 } } });
        expect(derivedSourceOf(p)).toEqual({ kind: 'clip', author: 'bob', permlink: 'p', start: 50 });
        const q = post({}, { '3speak': { source: { kind: 'clip', author: 'bob', permlink: 'p', start: -1, end: 1e9 } } });
        expect(derivedSourceOf(q)).toEqual({ kind: 'clip', author: 'bob', permlink: 'p' });
    });

    test('a snaps container is never a source (reactions posted as Shorts reply under it)', () => {
        const p = post({ parent_author: 'peak.snaps', parent_permlink: 'snap-container-1790333280' }, { tags: ['3speak', 'reaction'], video: { url: 'u' } });
        expect(derivedSourceOf(p)).toBeNull();
        expect(derivedSourceOf(post({}, { '3speak': { source: { kind: 'clip', author: 'threespeak', permlink: 'snap-container-1' } } }))).toBeNull();
    });

    test('made from itself is no source', () => {
        expect(derivedSourceOf(post({}, { '3speak': { source: { kind: 'clip', author: 'alice', permlink: 'my-post' } } }))).toBeNull();
    });
});

describe('card fields', () => {
    test('media', () => {
        expect(mediaOf(post({}, { audio: {} }))).toBe('audio');
        expect(mediaOf(post({}, { 'threespeak.video': { surface: 'shorts' }, video: { url: 'u' } }))).toBe('short');
        expect(mediaOf(post({}, { tags: ['hive-181335'], video: { url: 'u' } }))).toBe('short');
        expect(mediaOf(post({}, { video: { url: 'u' } }))).toBe('video');
        expect(mediaOf(post({}, {}))).toBe('post');
    });

    test('title: own title, else the first text line of the body', () => {
        expect(titleOf(post({}, { video: { info: { title: 'The clip' } } }))).toBe('The clip');
        expect(titleOf(post({ body: 'https://play.3speak.tv/embed?v=a/b\n\n## A [great](https://x) bit\n\nmore' }))).toBe('A great bit');
        expect(titleOf(post({ title: 'x'.repeat(300) })).length).toBe(120);
    });

    test('thumbnail and duration', () => {
        expect(thumbnailOf(post({}, { image: ['https://img/1.jpg'] }))).toBe('https://img/1.jpg');
        expect(thumbnailOf(post({}, { image: ['http://insecure'], video: { thumbnail: 'https://img/2.jpg' } }))).toBe('https://img/2.jpg');
        expect(thumbnailOf(post({}, {}))).toBeNull();
        expect(durationOf(post({}, { video: { info: { duration: 31.25 } } }))).toBe(31.3);
        expect(durationOf(post({}, { 'threespeak.audio': { duration: 600 } }))).toBe(600);
    });

    test('rowFor', () => {
        const row = rowFor(post({}, { '3speak': { audiogram: { author: 'bob', permlink: 'ep', start: 0, duration: 20 } }, video: { url: 'u', info: { title: 'Bit', duration: 20 } }, tags: ['hive-181335'] }));
        expect(row).toMatchObject({ author: 'alice', permlink: 'my-post', source_author: 'bob', source_permlink: 'ep', kind: 'audiogram', start: 0, end: 20, media: 'short', title: 'Bit', duration: 20 });
        expect(row.created.toISOString()).toBe('2026-11-20T10:00:00.000Z');
        expect(rowFor(post({}, {}))).toBeNull();
    });
});

// A Mongo collection as far as derivedStore uses it.
function fakeCollection() {
    const rows = [];
    const matches = (r, q) => Object.entries(q).every(([k, v]) => {
        if (v && v.$nin) return !v.$nin.includes(r[k]);
        if (v && v.$not && v.$not.$lte) return !(r[k] !== undefined && r[k] <= v.$not.$lte);
        return r[k] === v;
    });
    return {
        rows,
        createIndex: jest.fn(async () => 'ok'),
        deleteOne: jest.fn(async (q) => {
            const i = rows.findIndex((r) => matches(r, q));
            if (i >= 0) rows.splice(i, 1);
            return { deletedCount: i >= 0 ? 1 : 0 };
        }),
        updateOne: jest.fn(async (q, u) => {
            let r = rows.find((x) => matches(x, q));
            if (!r) { r = { ...q }; rows.push(r); }
            Object.assign(r, u.$set);
            for (const k of Object.keys(u.$unset || {})) delete r[k];
            return {};
        }),
        find: jest.fn((q) => {
            let out = rows.filter((r) => matches(r, q));
            const cur = {
                sort: () => { out = [...out].sort((a, b) => b.created - a.created); return cur; },
                limit: (n) => { out = out.slice(0, n); return cur; },
                toArray: async () => out.map(({ updated_at, ...r }) => r),
            };
            return cur;
        }),
        aggregate: jest.fn(([{ $match }]) => ({
            toArray: async () => {
                const n = {};
                for (const r of rows.filter((x) => matches(x, $match))) n[r.kind] = (n[r.kind] || 0) + 1;
                return Object.entries(n).map(([_id, c]) => ({ _id, n: c }));
            },
        })),
    };
}

describe('routes', () => {
    let coll;
    let app;
    beforeEach(() => {
        coll = fakeCollection();
        getDb.mockReturnValue({ collection: () => coll });
        _resetIndexed();
        router._cache.clear();
        hiveRpcBatch.mockReset();
        app = express();
        app.use(router);
    });

    const hiveReturns = (p) => hiveRpcBatch.mockResolvedValueOnce([{ result: p }]);
    const clipOf = (author, permlink, created) => post({ author, permlink, created }, { video: { url: 'u', info: { title: `${permlink} title` }, originalAuthor: 'bob', originalPermlink: 'long' } });

    test('register indexes the post and the source lists it', async () => {
        hiveReturns(clipOf('alice', 'clip-1', '2026-11-20T10:00:00'));
        const r = await request(app).post('/derived/register').send({ author: 'alice', permlink: 'clip-1' });
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ success: true, derived: { kind: 'remix', source: 'bob/long' } });
        expect(coll.createIndex).toHaveBeenCalledTimes(2);

        const g = await request(app).get('/derived/bob/long');
        expect(g.status).toBe(200);
        expect(g.body.total).toBe(1);
        expect(g.body.counts).toEqual({ remix: 1 });
        expect(g.body.items[0]).toMatchObject({ author: 'alice', permlink: 'clip-1', kind: 'remix', media: 'video', title: 'clip-1 title' });
    });

    test('newest first, hidden creators left out, limit kept', async () => {
        coll.rows.push(
            { ...rowFor(clipOf('alice', 'old', '2026-11-01T00:00:00')) },
            { ...rowFor(clipOf('carol', 'new', '2026-11-21T00:00:00')) },
            { ...rowFor(clipOf('hiddenguy', 'spam', '2026-11-22T00:00:00')) },
        );
        const g = await request(app).get('/derived/bob/long?limit=1');
        expect(g.body.items.map((i) => i.permlink)).toEqual(['new']);
        expect(g.body.total).toBe(2);
    });

    test('one creator\'s Shorts of a source, in the order of the source (a virtual series)', async () => {
        const piece = (author, permlink, start, created, media = 'short') => ({ author, permlink, source_author: 'bob', source_permlink: 'ep', kind: 'audiogram', media, created: new Date(created), ...(start !== null ? { start } : {}) });
        coll.rows.push(
            piece('bob', 'third', 600, '2026-11-01'),
            piece('bob', 'first', 10, '2026-11-03'),
            piece('bob', 'unplaced', null, '2026-11-02'),
            piece('bob', 'second', 300, '2026-11-04'),
            piece('carol', 'not-hers', 5, '2026-11-05'),
            piece('bob', 'a-video', 1, '2026-11-06', 'video'),
        );
        const g = await request(app).get('/derived/bob/ep?by=bob&media=short&order=start');
        expect(g.body.items.map((i) => i.permlink)).toEqual(['first', 'second', 'third', 'unplaced']);
        const all = await request(app).get('/derived/bob/ep');
        expect(all.body.total).toBe(6);
        const junk = await request(app).get('/derived/bob/ep?by=NOT VALID&media=weird&order=x');
        expect(junk.body.total).toBe(6);
    });

    test('a teaser Story leaves the list when its 24 hours are over', async () => {
        const story = (permlink, created) => post({ permlink, created }, { video: { url: 'u' }, 'threespeak.video': { surface: 'shorts' }, '3speak': { story: true, source: { kind: 'teaser', author: 'bob', permlink: 'long' } } });
        const fresh = rowFor(story('fresh', new Date(Date.now() - 3600e3).toISOString().slice(0, 19)));
        const old = rowFor(story('old', new Date(Date.now() - 30 * 3600e3).toISOString().slice(0, 19)));
        expect(fresh.expires_at).toBeInstanceOf(Date);
        coll.rows.push(fresh, old);
        const g = await request(app).get('/derived/bob/long');
        expect(g.body.items.map((i) => i.permlink)).toEqual(['fresh']);
        expect(g.body.counts).toEqual({ teaser: 1 });
    });

    test('a register drops the cached list of its source', async () => {
        const first = await request(app).get('/derived/bob/long');
        expect(first.body.total).toBe(0);
        hiveReturns(clipOf('alice', 'clip-1', '2026-11-20T10:00:00'));
        await request(app).post('/derived/register').send({ author: 'alice', permlink: 'clip-1' });
        const again = await request(app).get('/derived/bob/long');
        expect(again.body.total).toBe(1);
    });

    test('an edit that drops the source drops the row', async () => {
        hiveReturns(clipOf('alice', 'clip-1', '2026-11-20T10:00:00'));
        await request(app).post('/derived/register').send({ author: 'alice', permlink: 'clip-1' });
        hiveReturns(post({ permlink: 'clip-1' }, { video: { url: 'u' } }));
        const r = await request(app).post('/derived/register').send({ author: 'alice', permlink: 'clip-1' });
        expect(r.body).toEqual({ success: true, removed: true });
        expect(coll.rows).toHaveLength(0);
    });

    test('bad input, a post not readable yet, one naming no source, a wrong author', async () => {
        expect((await request(app).post('/derived/register').send({ author: 'X!', permlink: 'p' })).status).toBe(400);
        expect((await request(app).get('/derived/bob/Bad Permlink')).status).toBe(400);

        hiveReturns({ author: '', permlink: '' });
        const missing = await request(app).post('/derived/register').send({ author: 'alice', permlink: 'p' });
        expect(missing.status).toBe(404);
        expect(missing.body.retry).toBe(true);

        hiveReturns(post({ permlink: 'p' }, {}));
        expect((await request(app).post('/derived/register').send({ author: 'alice', permlink: 'p' })).status).toBe(400);

        hiveReturns(post({ author: 'mallory', permlink: 'p' }, {}));
        expect((await request(app).post('/derived/register').send({ author: 'alice', permlink: 'p' })).status).toBe(400);
    });

    test('Hive failing is a 500, not a crash', async () => {
        hiveRpcBatch.mockRejectedValueOnce(new Error('all nodes down'));
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        expect((await request(app).post('/derived/register').send({ author: 'alice', permlink: 'p' })).status).toBe(500);
        spy.mockRestore();
    });
});
