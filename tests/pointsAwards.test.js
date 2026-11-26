/**
 * 3Speak Points awards (services/pointsAwards.js): last month's #1 per main
 * leaderboard board and remixes/reactions, sent to the points server. Mongo
 * and the points server are stand-ins.
 */
process.env.POINTS_AWARD_URL = 'https://points.test';
process.env.POINTS_AWARD_SECRET = 'secret-for-tests';
jest.mock('../utils/db', () => ({ getDb: jest.fn() }));
jest.mock('../utils/hiddenCreators', () => ({ hiddenListSync: jest.fn(() => ['hiddenguy']) }));

const { monthlyWinners, remixAwards, previousMonth, runPointsAwards, RANK_METRICS } = require('../services/pointsAwards');

const day = (d) => new Date(`2026-11-${String(d).padStart(2, '0')}T00:00:00Z`);
const row = (user, d, over = {}) => ({ user, date: day(d), ...Object.fromEntries(RANK_METRICS.map((m) => [m, 0])), ...over });

/** A stand-in for the few Mongo calls the service makes. */
function fakeDb({ daily = [], derived = [], log = [] } = {}) {
    const logged = [...log];
    return {
        logged,
        collection(name) {
            if (name === 'leaderboard-daily') {
                return {
                    aggregate: ([{ $match }, { $group }]) => ({
                        toArray: async () => {
                            const inMonth = daily.filter((r) => r.date >= $match.date.$gte && r.date < $match.date.$lt);
                            const by = new Map();
                            for (const r of inMonth) {
                                const g = by.get(r.user) ?? { _id: r.user };
                                for (const [k, op] of Object.entries($group)) {
                                    if (k === '_id') continue;
                                    const v = r[k] || 0;
                                    g[k] = op.$max ? Math.max(g[k] ?? 0, v) : (g[k] ?? 0) + v;
                                }
                                by.set(r.user, g);
                            }
                            return [...by.values()];
                        },
                    }),
                };
            }
            if (name === 'derived-content') {
                return {
                    find: (q) => ({
                        sort: () => ({
                            limit: () => ({
                                toArray: async () => derived.filter((d) => q.kind.$in.includes(d.kind) && d.created >= q.created.$gte),
                            }),
                        }),
                    }),
                };
            }
            if (name === 'points-award-log') {
                return {
                    find: (q) => ({ toArray: async () => logged.filter((l) => q.id.$in.includes(l.id)) }),
                    bulkWrite: async (ops) => { for (const o of ops) logged.push(o.updateOne.update.$setOnInsert); },
                };
            }
            throw new Error(`unexpected collection ${name}`);
        },
    };
}

describe('previousMonth', () => {
    test('the month just ended, from the 2nd on (the rollup finishes its last day)', () => {
        expect(previousMonth(Date.UTC(2026, 11, 1, 23))).toBeNull();
        expect(previousMonth(Date.UTC(2026, 11, 2, 0, 1))).toEqual({ key: '2026-11', start: new Date('2026-11-01T00:00:00Z'), end: new Date('2026-12-01T00:00:00Z') });
        expect(previousMonth(Date.UTC(2027, 0, 5)).key).toBe('2026-12');
    });
});

describe('monthlyWinners', () => {
    const month = { key: '2026-11', start: new Date('2026-11-01T00:00:00Z'), end: new Date('2026-12-01T00:00:00Z') };

    test('sums the month per user, max for peak viewers; ties go to the name, like the boards', async () => {
        const db = fakeDb({ daily: [
            row('alice', 3, { video_uploads: 2, stream_peak_viewers: 10 }),
            row('alice', 4, { video_uploads: 1, stream_peak_viewers: 5 }),
            row('bob', 5, { video_uploads: 3, stream_peak_viewers: 12 }),
            row('carol', 6, { short_uploads: 4 }),
            row('aaron', 7, { short_uploads: 4 }),
            row('dave', 1, { tags_given: 9 }),
        ] });
        const out = await monthlyWinners(db, month);
        expect(out).toEqual([
            { id: 'rank:2026-11:video_uploads', user: 'alice', kind: 'rank' },
            { id: 'rank:2026-11:short_uploads', user: 'aaron', kind: 'rank' },
            { id: 'rank:2026-11:tags_given', user: 'dave', kind: 'rank' },
            { id: 'rank:2026-11:stream_peak_viewers', user: 'bob', kind: 'rank' },
        ]);
    });

    test('an excluded or hidden account never places; an empty board has no winner', async () => {
        const db = fakeDb({ daily: [row('spammer', 3, { streams: 50 }), row('alice', 3, { streams: 1 }), row('bob', 3, {})] });
        const out = await monthlyWinners(db, month, new Set(['spammer']));
        expect(out).toEqual([{ id: 'rank:2026-11:streams', user: 'alice', kind: 'rank' }]);
    });

    test('rows outside the month do not count', async () => {
        const db = fakeDb({ daily: [row('alice', 30, { video_uploads: 1 }), { ...row('bob', 1, { video_uploads: 5 }), date: new Date('2026-12-01T00:00:00Z') }] });
        expect((await monthlyWinners(db, month)).map((a) => a.user)).toEqual(['alice']);
    });
});

describe('remixAwards', () => {
    test('remixes and reactions of someone else\'s post, to the maker, with the source as ref', async () => {
        const now = Date.parse('2026-11-26T12:00:00Z');
        const recent = new Date(now - 3600_000);
        const db = fakeDb({ derived: [
            { kind: 'remix', author: 'alice', permlink: 'r1', source_author: 'bob', source_permlink: 'v1', created: recent },
            { kind: 'reaction', author: 'carol', permlink: 'r2', source_author: 'bob', source_permlink: 'v1', created: recent },
            { kind: 'remix', author: 'bob', permlink: 'r3', source_author: 'bob', source_permlink: 'v2', created: recent },
            { kind: 'remix', author: 'hiddenguy', permlink: 'r4', source_author: 'bob', source_permlink: 'v1', created: recent },
            { kind: 'clip', author: 'dave', permlink: 'c1', source_author: 'bob', source_permlink: 'v1', created: recent },
            { kind: 'remix', author: 'erin', permlink: 'old', source_author: 'bob', source_permlink: 'v1', created: new Date(now - 100 * 3600_000) },
        ] });
        expect(await remixAwards(db, now, new Set(['hiddenguy']))).toEqual([
            { id: 'remix:alice/r1', user: 'alice', kind: 'remix', ref: 'bob/v1' },
            { id: 'remix:carol/r2', user: 'carol', kind: 'remix', ref: 'bob/v1' },
        ]);
    });
});

describe('runPointsAwards', () => {
    test('sends what has no final answer yet with the secret, and logs the final answers', async () => {
        const now = Date.parse('2026-12-03T12:00:00Z');
        const db = fakeDb({
            daily: [row('alice', 10, { video_uploads: 1 })],
            derived: [
                { kind: 'remix', author: 'carol', permlink: 'r1', source_author: 'bob', source_permlink: 'v1', created: new Date(now - 3600_000) },
                { kind: 'remix', author: 'carol', permlink: 'r0', source_author: 'bob', source_permlink: 'v0', created: new Date(now - 3600_000) },
            ],
            log: [{ id: 'remix:carol/r0', result: 'awarded' }],
        });
        const fetchImpl = jest.fn(async (url, init) => {
            const { awards } = JSON.parse(init.body);
            return {
                ok: true,
                json: async () => ({ results: awards.map((a) => (a.kind === 'rank' ? { id: a.id, awarded: true, points: 100 } : { id: a.id, awarded: false, reason: 'error' })) }),
            };
        });
        const out = await runPointsAwards({ now, db, fetchImpl });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe('https://points.test/points/awards');
        expect(init.headers['x-points-award-secret']).toBe('secret-for-tests');
        expect(JSON.parse(init.body).awards.map((a) => a.id)).toEqual(['rank:2026-11:video_uploads', 'remix:carol/r1']);
        expect(out).toEqual({ sent: 2, awarded: 1 });
        // 'error' is not final: sent again next run. 'awarded' is.
        expect(db.logged.map((l) => l.id)).toEqual(['remix:carol/r0', 'rank:2026-11:video_uploads']);
    });

    test('the points server failing throws (the next run tries again)', async () => {
        const db = fakeDb({ daily: [row('alice', 10, { video_uploads: 1 })] });
        await expect(runPointsAwards({ now: Date.parse('2026-12-03T12:00:00Z'), db, fetchImpl: async () => ({ ok: false, status: 502 }) }))
            .rejects.toThrow('502');
    });
});

describe('schedule', () => {
    afterEach(() => { jest.useRealTimers(); });

    test('off without the URL and secret: no timers, a run does nothing', () => {
        jest.isolateModules(() => {
            const saved = process.env.POINTS_AWARD_URL;
            delete process.env.POINTS_AWARD_URL;
            const log = jest.spyOn(console, 'log').mockImplementation(() => {});
            const svc = require('../services/pointsAwards');
            const timer = jest.spyOn(global, 'setTimeout');
            svc.schedule();
            expect(timer).not.toHaveBeenCalled();
            expect(log.mock.calls[0][0]).toMatch(/disabled/);
            process.env.POINTS_AWARD_URL = saved;
            return expect(svc.runPointsAwards({ db: fakeDb() })).resolves.toEqual({ sent: 0, awarded: 0 });
        });
    });

    test('on: indexes once, then a run on every tick; a failing run is logged, not thrown', async () => {
        jest.useFakeTimers({ now: Date.parse('2026-12-03T12:00:00Z') });
        const { getDb } = require('../utils/db');
        const indexes = [];
        const db = fakeDb({ daily: [row('alice', 10, { video_uploads: 1 })] });
        const base = db.collection.bind(db);
        db.collection = (name) => (name === 'points-award-log'
            ? { ...base(name), createIndex: async (spec, opts) => { indexes.push(opts.name); } }
            : base(name));
        getDb.mockReturnValue(db);
        global.fetch = jest.fn(async () => ({ ok: false, status: 503 }));
        const log = jest.spyOn(console, 'log').mockImplementation(() => {});
        const err = jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.isolateModules(() => { require('../services/pointsAwards').schedule(); });
        expect(log.mock.calls[0][0]).toMatch(/scheduled every 60min/);
        await jest.advanceTimersByTimeAsync(9 * 60 * 1000);
        await jest.advanceTimersByTimeAsync(60 * 60 * 1000);
        expect(indexes).toEqual(['award_id', 'award_ttl']);
        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(err.mock.calls[0][0]).toMatch(/run failed/);
        delete global.fetch;
    });

    test('an index failure is logged and tried again next tick', async () => {
        jest.useFakeTimers({ now: Date.parse('2026-12-01T12:00:00Z') });
        const { getDb } = require('../utils/db');
        let tries = 0;
        const db = fakeDb();
        const base = db.collection.bind(db);
        db.collection = (name) => (name === 'points-award-log'
            ? { ...base(name), createIndex: async () => { tries += 1; throw new Error('no'); } }
            : base(name));
        getDb.mockReturnValue(db);
        jest.spyOn(console, 'log').mockImplementation(() => {});
        const err = jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.isolateModules(() => { require('../services/pointsAwards').schedule(); });
        await jest.advanceTimersByTimeAsync(9 * 60 * 1000);
        await jest.advanceTimersByTimeAsync(60 * 60 * 1000);
        expect(tries).toBe(2);
        expect(err.mock.calls[0][0]).toMatch(/index setup failed/);
    });

    test('a points server answer without results counts nothing', async () => {
        const db = fakeDb({ daily: [row('alice', 10, { video_uploads: 1 })] });
        const out = await runPointsAwards({ now: Date.parse('2026-12-03T12:00:00Z'), db, fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
        expect(out).toEqual({ sent: 1, awarded: 0 });
        expect(db.logged).toEqual([]);
    });
});
