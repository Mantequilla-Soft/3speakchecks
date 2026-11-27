/**
 * The 3Speak Points sender (services/pointsAwards.js) with every finder, against
 * this worker's throwaway MongoDB: the launch date, blocked accounts, a failing
 * finder, batches of 200, units, the log. HafSQL and the points server are stand-ins.
 */
process.env.POINTS_AWARD_URL = 'https://points.test';
process.env.POINTS_AWARD_SECRET = 'secret-for-tests';
jest.mock('../../utils/hiddenCreators', () => ({ hiddenListSync: jest.fn(() => ['hiddenguy']) }));
jest.mock('../../utils/hafsql', () => ({
    query: jest.fn(async (sql) => (/order by block_num desc limit 1/.test(sql) ? [{ head: 1 }] : [])),
}));
const testDb = require('../helpers/db');
const svc = require('../../services/pointsAwards');

const db = testDb.use();
const NOW = Date.parse('2026-11-27T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000);

/** A points server that pays everything once and says `already` after. */
function pointsServer() {
    const paid = new Set();
    const calls = [];
    const fetchImpl = jest.fn(async (url, init) => {
        const { awards } = JSON.parse(init.body);
        calls.push(awards);
        return {
            ok: true,
            json: async () => ({ results: awards.map((a) => (paid.has(a.id) ? { id: a.id, awarded: false, reason: 'already' } : (paid.add(a.id), { id: a.id, awarded: true }))) }),
        };
    });
    return { fetchImpl, calls };
}

describe('launchDate', () => {
    test('unset: the UTC day of the first run, stored, and kept by later runs', async () => {
        expect(await svc.launchDate(db(), NOW)).toEqual(new Date('2026-11-27T00:00:00Z'));
        expect(await svc.launchDate(db(), NOW + 5 * 86400 * 1000)).toEqual(new Date('2026-11-27T00:00:00Z'));
        expect(await db().collection('points-award-state').countDocuments({ _id: 'launch' })).toBe(1);
    });

    test('POINTS_AWARDS_SINCE wins and nothing is stored', async () => {
        await jest.isolateModulesAsync(async () => {
            process.env.POINTS_AWARDS_SINCE = '2026-11-01';
            const iso = require('../../services/pointsAwards');
            expect(await iso.launchDate(db(), NOW)).toEqual(new Date('2026-11-01T00:00:00Z'));
            delete process.env.POINTS_AWARDS_SINCE;
        });
        expect(await db().collection('points-award-state').countDocuments({})).toBe(0);
    });
});

describe('withoutBlocked', () => {
    test('hidden creators and banned accounts get nothing', async () => {
        await db().collection('contentcreators').insertMany([{ username: 'banned1', banned: true }, { username: 'fine', banned: false }]);
        const awards = ['fine', 'banned1', 'hiddenguy', 'newcomer'].map((user) => ({ id: `x:${user}`, user, kind: 'tag' }));
        expect((await svc.withoutBlocked(db(), awards, new Set(['hiddenguy']))).map((a) => a.user)).toEqual(['fine', 'newcomer']);
        expect(await svc.withoutBlocked(db(), [], new Set())).toEqual([]);
    });
});

describe('findAwards', () => {
    test('a failing finder is logged and skipped; an id found twice is sent once; rows without id or user are dropped', async () => {
        const err = jest.spyOn(console, 'error').mockImplementation(() => {});
        const out = await svc.findAwards({}, [
            ['one', async () => [{ id: 'a', user: 'u', kind: 'tag' }, { id: 'b', user: '', kind: 'tag' }, null]],
            ['boom', async () => { throw new Error('hafsql down'); }],
            ['two', async () => [{ id: 'a', user: 'u', kind: 'tag' }, { id: 'c', user: 'v', kind: 'tag' }]],
            ['none', () => null],
        ]);
        expect(out.map((a) => a.id)).toEqual(['a', 'c']);
        expect(err).toHaveBeenCalledWith('[pointsAwards] boom failed:', 'hafsql down');
    });

    test('every kind has a finder', () => {
        expect(svc.FINDERS.map(([label]) => label)).toEqual([
            'rank', 'remix', 'daily', 'finish', 'reach', 'playlist', 'premiere', 'first', 'storystreak',
            'challenge', 'remixed', 'tip', 'tag', 'reply', 'community', 'followers',
        ]);
    });
});

describe('runPointsAwards', () => {
    test('batches of 200 with units, logs final answers, sends nothing twice, nothing from before the launch', async () => {
        jest.spyOn(console, 'log').mockImplementation(() => {});
        await db().collection('points-award-state').insertOne({ _id: 'launch', since: new Date('2026-11-25T00:00:00Z') });
        const tips = [];
        for (let i = 0; i < 450; i += 1) {
            tips.push({ trx_id: `t${String(i).padStart(3, '0')}`, tipper: 'fan', author: 'maker', currency: 'HBD', hbd_value: 1.5, tippedAt: hoursAgo(1) });
        }
        tips.push({ trx_id: 'before-launch', tipper: 'fan', author: 'maker', currency: 'HBD', hbd_value: 1, tippedAt: new Date('2026-11-24T23:00:00Z') });
        tips.push({ trx_id: 'to-hidden', tipper: 'hiddenguy', author: 'maker', currency: 'HBD', hbd_value: 1, tippedAt: hoursAgo(1) });
        await db().collection('supports').insertMany(tips);
        await db().collection('shorts_challenge_entries').insertOne({
            week: '2026-W48', owner: 'amy', permlink: 'k', hive_author: 'amy', hive_permlink: 'p', checked: true, reviewed_at: hoursAgo(1),
        });

        const server = pointsServer();
        expect(await svc.runPointsAwards({ now: NOW, db: db(), fetchImpl: server.fetchImpl })).toEqual({ sent: 451, awarded: 451 });
        expect(server.calls.map((c) => c.length)).toEqual([200, 200, 51]);
        const [url, init] = server.fetchImpl.mock.calls[0];
        expect(url).toBe('https://points.test/points/awards');
        expect(init.headers['x-points-award-secret']).toBe('secret-for-tests');
        const all = server.calls.flat();
        expect(all.find((a) => a.id === 'tip:t000')).toEqual({ id: 'tip:t000', user: 'fan', kind: 'tip', ref: 'maker', units: 1500 });
        expect(all.find((a) => a.kind === 'challenge')).toEqual({ id: 'challenge:2026-W48:amy/p', user: 'amy', kind: 'challenge', ref: 'amy/p' });
        expect(all.some((a) => a.id === 'tip:before-launch' || a.id === 'tip:to-hidden')).toBe(false);
        expect(await db().collection('points-award-log').countDocuments({ result: 'awarded' })).toBe(451);

        // The next run finds the same awards and sends none of them.
        expect(await svc.runPointsAwards({ now: NOW + 3600 * 1000, db: db(), fetchImpl: server.fetchImpl })).toEqual({ sent: 0, awarded: 0 });
        expect(server.calls).toHaveLength(3);
    });
});
