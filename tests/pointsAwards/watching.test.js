/**
 * 3Speak Points watch and listen kinds (services/pointsAwards/watching.js), from
 * points-activity rows in this worker's throwaway MongoDB.
 */
process.env.REACH_MIN_VIEWERS = '3';
jest.mock('../../utils/hiddenCreators', () => ({ hiddenListSync: jest.fn(() => []) }));
const testDb = require('../helpers/db');
const { ACTIVITY } = require('../../services/pointsAwards/activity');
const w = require('../../services/pointsAwards/watching');

const db = testDb.use();
const NOW = Date.parse('2026-11-27T12:00:00Z');
const LAUNCH = new Date('2026-11-20T00:00:00Z');
const ctx = (over = {}) => ({ db: db(), now: NOW, launch: LAUNCH, ...over });
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000);

let n = 0;
const act = (over = {}) => {
    n += 1;
    const user = over.user || 'alice';
    return {
        _id: `row${n}`, kind: 'watch', user, item: `bob/item${n}`, post: `bob/post${n}`, owner: 'bob', short: false,
        day: '2026-11-27', secs: 60, pct: 50, firstAt: hoursAgo(2), at: hoursAgo(1), ...over,
    };
};
const insert = (rows) => db().collection(ACTIVITY).insertMany(rows);

describe('dailyAwards', () => {
    test('first5 once 5 minutes are watched today or yesterday; listening does not count for it', async () => {
        await insert([
            act({ secs: 200 }), act({ secs: 100 }),                                  // alice today: 300
            act({ user: 'bob2', secs: 299 }),                                        // just short
            act({ user: 'carl', kind: 'listen', secs: 900 }),                         // listening
            act({ user: 'dina', day: '2026-11-26', secs: 400 }),                      // yesterday
        ]);
        const out = (await w.dailyAwards(ctx())).filter((a) => a.kind === 'first5');
        expect(out).toEqual([
            { id: 'first5:alice:2026-11-27', user: 'alice', kind: 'first5' },
            { id: 'first5:dina:2026-11-26', user: 'dina', kind: 'first5' },
        ]);
    });

    test('vodtime and listen: whole minutes of a finished day, 3 hours after midnight, never today', async () => {
        await insert([
            act({ day: '2026-11-26', secs: 130 }), act({ day: '2026-11-26', secs: 60 }),   // 190 s = 3 min
            act({ day: '2026-11-27', secs: 600 }),                                         // today: not yet
            act({ user: 'carl', kind: 'listen', day: '2026-11-25', secs: 61 }),            // 1 min
            act({ user: 'dina', kind: 'listen', day: '2026-11-25', secs: 59 }),            // under a minute
        ]);
        const out = (await w.dailyAwards(ctx())).filter((a) => a.kind !== 'first5');
        expect(out).toEqual([
            { id: 'listen:carl:2026-11-25', user: 'carl', kind: 'listen', units: 1 },
            { id: 'vodtime:alice:2026-11-26', user: 'alice', kind: 'vodtime', units: 3 },
        ]);
        // At 02:59 the day before is not final yet.
        const early = await w.dailyAwards(ctx({ now: Date.parse('2026-11-27T02:59:00Z') }));
        expect(early.filter((a) => a.kind !== 'first5').map((a) => a.id)).toEqual(['listen:carl:2026-11-25']);
    });

    test('nothing for days before the launch, and only the last three finished days', async () => {
        await insert([act({ day: '2026-11-26', secs: 600 }), act({ day: '2026-11-23', secs: 600 })]);
        expect((await w.dailyAwards(ctx({ launch: new Date('2026-11-27T00:00:00Z') }))).map((a) => a.id)).toEqual([]);
        expect((await w.dailyAwards(ctx())).map((a) => a.id)).toEqual(['first5:alice:2026-11-26', 'vodtime:alice:2026-11-26']);
    });
});

describe('finishAwards', () => {
    test('a video seen 90%+ in the window; not a Short, not 89%, not before the window or launch', async () => {
        await insert([
            act({ pct: 90, post: 'bob/done' }),
            act({ pct: 89.9, post: 'bob/almost' }),
            act({ pct: 100, short: true, post: 'bob/short' }),
            act({ pct: 100, post: 'bob/old', at: hoursAgo(73) }),
            act({ pct: 100, post: null }),
        ]);
        expect(await w.finishAwards(ctx())).toEqual([{ id: 'finish:alice:bob/done', user: 'alice', kind: 'finish', ref: 'bob/done' }]);
        expect(await w.finishAwards(ctx({ launch: new Date(NOW) }))).toEqual([]);
    });
});

describe('reachAwards', () => {
    const video = (permlink, createdAt, over = {}) => ({
        owner: 'bob', permlink: `k-${permlink}`, hive_author: 'bob', hive_permlink: permlink, status: 'published', processed: true, createdAt, ...over,
    });

    test('REACH_MIN_VIEWERS distinct signed-in watchers within 7 days of publishing, to the creator', async () => {
        const published = new Date(NOW - 5 * 86400 * 1000);
        await db().collection('embed-video').insertMany([
            video('hit', published),
            video('few', published),
            video('late', new Date(NOW - 7.5 * 86400 * 1000)),
            video('before-launch', new Date('2026-11-19T00:00:00Z')),
        ]);
        await insert([
            act({ user: 'u1', post: 'bob/hit' }), act({ user: 'u1', post: 'bob/hit', day: '2026-11-26' }), act({ user: 'u2', post: 'bob/hit' }),
            act({ user: 'u3', post: 'bob/hit' }), act({ user: 'bob', post: 'bob/hit' }),
            act({ user: 'u1', post: 'bob/few' }), act({ user: 'u2', post: 'bob/few' }), act({ user: 'u3', post: 'bob/few', secs: 5 }),
            // After day 7 of 'late' only u3 watched: two in time is not enough.
            act({ user: 'u1', post: 'bob/late', firstAt: hoursAgo(100) }), act({ user: 'u2', post: 'bob/late', firstAt: hoursAgo(100) }),
            act({ user: 'u3', post: 'bob/late', firstAt: hoursAgo(1) }),
            act({ user: 'u1', post: 'bob/before-launch' }), act({ user: 'u2', post: 'bob/before-launch' }), act({ user: 'u3', post: 'bob/before-launch' }),
        ]);
        expect(await w.reachAwards(ctx())).toEqual([{ id: 'reach:bob/hit', user: 'bob', kind: 'reach', ref: 'bob/hit' }]);
    });

    test('no recent videos: nothing to look up', async () => {
        expect(await w.reachAwards(ctx())).toEqual([]);
    });
});

describe('playlistAwards', () => {
    const playlist = (id, owner, posts, access = 'public') => ({
        _id: id, owner, access, items: posts.map((p, i) => ({ author: p.split('/')[0], permlink: p.split('/')[1], position: i })),
    });

    test('someone else\'s public playlist of 3+ items, every item 90%+ (by post or by player key)', async () => {
        await db().collection('playlists').insertMany([
            playlist('pl-done', 'zed', ['bob/a', 'bob/b', 'carl/c']),
            playlist('pl-missing', 'zed', ['bob/a', 'bob/b', 'bob/never']),
            playlist('pl-own', 'alice', ['bob/a', 'bob/b', 'carl/c']),
            playlist('pl-two', 'zed', ['bob/a', 'bob/b']),
            playlist('pl-private', 'zed', ['bob/a', 'bob/b', 'carl/c'], 'private'),
        ]);
        await insert([
            act({ post: 'bob/a', pct: 95 }),
            act({ post: 'bob/b', pct: 90, at: hoursAgo(200) }),                       // older, still kept
            act({ kind: 'listen', post: null, item: 'carl/c', pct: 100 }),           // matched by player key
            act({ post: 'bob/never', pct: 50 }),
        ]);
        expect(await w.playlistAwards(ctx())).toEqual([{ id: 'playlist:alice:pl-done', user: 'alice', kind: 'playlist', ref: 'pl-done' }]);
    });

    test('nobody finished anything lately: nothing', async () => {
        await insert([act({ post: 'bob/a', pct: 95, at: hoursAgo(100) })]);
        expect(await w.playlistAwards(ctx())).toEqual([]);
    });
});

describe('premiereAwards', () => {
    const start = new Date(NOW - 3600 * 1000);
    const premiere = (over = {}) => ({
        owner: 'bob', permlink: 'prem', embedPermlink: 'prem1234', premiere: true, status: 'posted',
        scheduledOn: start, postedAt: new Date(start.getTime() - 5 * 60 * 1000), ...over,
    });

    test('watchers within the first 10 minutes (by post or player key), not the creator; premheld when it went out on time', async () => {
        const { insertedId } = await db().collection('scheduled-posts').insertOne(premiere());
        await db().collection('scheduled-posts').insertMany([
            premiere({ permlink: 'late', embedPermlink: 'late1234', postedAt: new Date(start.getTime() + 16 * 60 * 1000) }),
            premiere({ permlink: 'cancel', status: 'cancelled' }),
            premiere({ permlink: 'plain', premiere: false }),
        ]);
        const min = (m) => new Date(start.getTime() + m * 60 * 1000);
        await insert([
            act({ user: 'u1', post: 'bob/prem', firstAt: min(2), at: min(30) }),
            act({ user: 'u2', post: null, item: 'bob/prem1234', firstAt: min(10), at: min(12) }),
            act({ user: 'u3', post: 'bob/prem', firstAt: min(11), at: min(20) }),            // too late
            act({ user: 'u4', post: 'bob/prem', firstAt: min(-20), at: min(-15) }),          // left before it began
            act({ user: 'bob', post: 'bob/prem', firstAt: min(0), at: min(5) }),
        ]);
        const out = await w.premiereAwards(ctx());
        expect(out).toEqual([
            { id: `premheld:${insertedId}`, user: 'bob', kind: 'premheld', ref: 'bob/prem' },
            { id: 'premiere:u1:bob/prem', user: 'u1', kind: 'premiere', ref: 'bob/prem' },
            { id: 'premiere:u2:bob/prem', user: 'u2', kind: 'premiere', ref: 'bob/prem' },
        ]);
    });

    test('a premiere still to come or before the launch counts for nothing', async () => {
        await db().collection('scheduled-posts').insertMany([
            premiere({ scheduledOn: new Date(NOW + 3600 * 1000) }),
            premiere({ permlink: 'old', scheduledOn: new Date('2026-11-19T00:00:00Z') }),
        ]);
        expect(await w.premiereAwards(ctx())).toEqual([]);
    });
});
