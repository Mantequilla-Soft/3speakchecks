/**
 * 3Speak Points activity (services/pointsAwards/activity.js): named player and
 * listen sessions copied into points-activity, one row per person, item and day.
 * Runs against this worker's throwaway MongoDB.
 */
jest.mock('../../utils/hiddenCreators', () => ({ hiddenListSync: jest.fn(() => []) }));
const testDb = require('../helpers/db');
const { syncActivity, forgetActivity, ensureActivityIndexes, ACTIVITY, _test } = require('../../services/pointsAwards/activity');

const db = testDb.use();
const NOW = Date.parse('2026-11-27T12:00:00Z');
const at = (min) => new Date(NOW - min * 60 * 1000);

const view = (over = {}) => ({
    sid: `s${Math.random()}`, viewer: 'alice', owner: 'bob', permlink: 'abc12345', type: 'embed', source: '3speak', private: false,
    contentMs: 400_000, visibleContentMs: 300_000, coveredBuckets: [0, 1, 2, 3, 4, 5, 6, 7, 8], bucketCount: 10,
    startedAt: at(10), lastBeatAt: at(1), ...over,
});
const listen = (over = {}) => ({
    sid: `l${Math.random()}`, listener: 'carol', owner: 'dave', id: 'aud00001', kind: 'audio', source: '3speak', private: false,
    accumulatedMs: 120_000, coveredBuckets: [0, 1], bucketCount: 100, startedAt: at(5), lastBeatAt: at(1), ...over,
});

// alice opted into viewer rewards, carol into listener rewards (ad_viewer_prefs).
async function seed({ views = [], listens = [], prefs = [
    { _id: 'alice', rewardsEnabled: true },
    { _id: 'carol', listenEnabled: true },
] } = {}) {
    if (prefs.length) await db().collection('ad_viewer_prefs').insertMany(prefs);
    await db().collection('embed-video').insertMany([
        { owner: 'bob', permlink: 'abc12345', hive_author: 'bob', hive_permlink: 'my-video', short: false, status: 'published' },
        { owner: 'bob', permlink: 'short001', hive_author: 'bob', hive_permlink: 'my-short', short: true, status: 'published' },
    ]);
    await db().collection('embed-audio').insertOne({ owner: 'dave', permlink: 'aud00001', post_permlink: 'my-song', status: 'published' });
    if (views.length) await db().collection('view-sessions').insertMany(views);
    if (listens.length) await db().collection('listen-sessions').insertMany(listens);
}

const rows = () => db().collection(ACTIVITY).find({}, { sort: { _id: 1 } }).toArray();

describe('syncActivity', () => {
    test('a named watch session becomes a row with the Hive post, on-screen seconds and coverage', async () => {
        await seed({ views: [view()] });
        expect(await syncActivity({ db: db(), since: at(60), now: NOW })).toEqual({ sessions: 1, written: 1 });
        const [r] = await rows();
        expect(r).toMatchObject({
            _id: 'watch|alice|bob/abc12345|2026-11-27', kind: 'watch', user: 'alice', item: 'bob/abc12345', post: 'bob/my-video',
            owner: 'bob', short: false, day: '2026-11-27', secs: 300, pct: 90,
        });
        expect(r.firstAt).toEqual(at(10));
        expect(r.expires_at).toEqual(new Date(NOW + 30 * 86400 * 1000));
    });

    test('legacy videos keep their key as the post; Shorts are flagged; unknown uploads have no post', async () => {
        await seed({ views: [
            view({ type: 'legacy', owner: 'erin', permlink: 'old-post' }),
            view({ permlink: 'short001' }),
            view({ permlink: 'zzzz9999' }),
        ] });
        await syncActivity({ db: db(), since: at(60), now: NOW });
        const r = await rows();
        expect(r.map((x) => [x.item, x.post || null, x.short])).toEqual([
            ['bob/short001', 'bob/my-short', true],
            ['bob/zzzz9999', null, false],
            ['erin/old-post', 'erin/old-post', false],
        ]);
    });

    test('own videos, private mode, live streams, anonymous and stale sessions are not stored', async () => {
        await seed({ views: [
            view({ viewer: 'bob' }),
            view({ private: true }),
            view({ type: 'live' }),
            view({ viewer: null }),
            view({ lastBeatAt: at(120) }),
            view({ visibleContentMs: 0, contentMs: 0 }),
        ] });
        expect(await syncActivity({ db: db(), since: at(60), now: NOW })).toEqual({ sessions: 1, written: 0 });
        expect(await rows()).toEqual([]);
    });

    test('several sessions of one video on one day keep the best, not the sum', async () => {
        await seed({ views: [view({ visibleContentMs: 100_000, coveredBuckets: [0], startedAt: at(30) }), view({ visibleContentMs: 250_000, coveredBuckets: [0, 1, 2] })] });
        await syncActivity({ db: db(), since: at(60), now: NOW });
        await syncActivity({ db: db(), since: at(60), now: NOW });
        const r = await rows();
        expect(r).toHaveLength(1);
        expect(r[0]).toMatchObject({ secs: 250, pct: 30 });
        expect(r[0].firstAt).toEqual(at(30));
    });

    test('a session is dated by the UTC day it started', async () => {
        await seed({ views: [view({ startedAt: new Date('2026-11-26T23:58:00Z') })] });
        await syncActivity({ db: db(), since: at(60), now: NOW });
        expect((await rows())[0].day).toBe('2026-11-26');
    });

    test('vouched 3speak.tv listens of 3Speak audio count wall-clock seconds; podcasts, embeds and own audio do not', async () => {
        await seed({ listens: [
            listen(),
            listen({ listener: 'dave' }),
            listen({ kind: 'podcast', id: 'feed:ep' }),
            listen({ source: 'embed' }),
            listen({ listener: null }),
        ] });
        expect(await syncActivity({ db: db(), since: at(60), now: NOW })).toEqual({ sessions: 1, written: 1 });
        const [r] = await rows();
        expect(r).toMatchObject({ kind: 'listen', user: 'carol', item: 'dave/aud00001', post: 'dave/my-song', secs: 120, pct: 2 });
    });

    test('only people who opted in are stored: viewer rewards for watching, listener rewards for listening', async () => {
        await seed({
            views: [view({ viewer: 'frank' }), view({ viewer: 'gina' }), view({ viewer: 'carol' })],
            listens: [listen({ listener: 'gina' }), listen({ listener: 'alice' })],
            prefs: [
                { _id: 'alice', rewardsEnabled: true },              // watching only
                { _id: 'carol', listenEnabled: true },               // listening only
                { _id: 'gina', rewardsEnabled: false, listenEnabled: false },
            ],
        });
        expect(await syncActivity({ db: db(), since: at(60), now: NOW })).toEqual({ sessions: 0, written: 0 });
        expect(await rows()).toEqual([]);
    });

    test('forgetActivity deletes one kind of one person', async () => {
        await seed({ views: [view(), view({ viewer: 'carol' })], listens: [listen()], prefs: [
            { _id: 'alice', rewardsEnabled: true },
            { _id: 'carol', rewardsEnabled: true, listenEnabled: true },
        ] });
        await syncActivity({ db: db(), since: at(60), now: NOW });
        expect(await forgetActivity(db(), 'carol', 'listen')).toBe(1);
        expect((await rows()).map((r) => `${r.kind}|${r.user}`)).toEqual(['watch|alice', 'watch|carol']);
    });

    test('nothing is written with Mongo writes off', async () => {
        await jest.isolateModulesAsync(async () => {
            process.env.ENABLE_MONGO_WRITES = 'false';
            const { syncActivity: off } = require('../../services/pointsAwards/activity');
            expect(await off({ db: db(), since: at(60), now: NOW })).toEqual({ sessions: 0, written: 0 });
            delete process.env.ENABLE_MONGO_WRITES;
        });
    });

    test('indexes', async () => {
        await ensureActivityIndexes(db());
        const names = (await db().collection(ACTIVITY).indexes()).map((i) => i.name);
        expect(names).toEqual(expect.arrayContaining(['activity_day', 'activity_at', 'activity_post', 'activity_item', 'activity_user', 'activity_ttl']));
    });
});

describe('coverage', () => {
    test('distinct buckets over the bucket count, capped at 100, 0 without a count', () => {
        expect(_test.coverage({ coveredBuckets: [1, 1, 2], bucketCount: 4 })).toBe(50);
        expect(_test.coverage({ coveredBuckets: [0, 1, 2, 3, 4], bucketCount: 4 })).toBe(100);
        expect(_test.coverage({ coveredBuckets: [1] })).toBe(0);
        expect(_test.coverage({ bucketCount: 10 })).toBe(0);
    });
});
