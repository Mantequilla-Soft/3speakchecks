/**
 * 3Speak Points creating and supporting kinds (services/pointsAwards/content.js):
 * first, referral + invited, storystreak, challenge, remixed, tip. Runs against
 * this worker's throwaway MongoDB; Butter Auth is a stand-in.
 */
jest.mock('../../utils/hiddenCreators', () => ({ hiddenListSync: jest.fn(() => []) }));
const testDb = require('../helpers/db');
const c = require('../../services/pointsAwards/content');

const db = testDb.use();
const NOW = Date.parse('2026-11-27T12:00:00Z');
const LAUNCH = new Date('2026-11-20T00:00:00Z');
const ctx = (over = {}) => ({ db: db(), now: NOW, launch: LAUNCH, firstsSince: LAUNCH, hidden: new Set(), ...over });
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000);
const dayAt = (d, h = 12) => new Date(`2026-11-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00Z`);

let n = 0;
const upload = (owner, over = {}) => {
    n += 1;
    return {
        owner, permlink: `k${n}`, hive_author: owner, hive_permlink: `post-${n}`, status: 'published', processed: true,
        short: false, createdAt: hoursAgo(5), ...over,
    };
};

describe('firstAwards', () => {
    test('first video, Short, story and podcast of accounts new to that type', async () => {
        await db().collection('embed-video').insertMany([
            upload('newbie'),
            upload('newbie', { short: true }),
            upload('newbie', { short: true, story_posted_at: hoursAgo(4) }),
            upload('veteran'),
            upload('veteran', { createdAt: new Date('2026-10-01T00:00:00Z') }),          // an earlier video
            upload('shorty', { short: true }),
            upload('shorty', { createdAt: new Date('2026-10-01T00:00:00Z') }),          // old video, new Short
            upload('oldshort', { short: true }),
            upload('oldshort', { short: true, createdAt: new Date('2026-10-01T00:00:00Z') }), // an earlier Short
            upload('oldstory', { short: true, story_posted_at: hoursAgo(2) }),
            upload('oldstory', { short: true, createdAt: new Date('2026-10-01T00:00:00Z'), story_posted_at: new Date('2026-10-01T00:00:00Z') }),
            upload('failed', { createdAt: new Date('2026-10-01T00:00:00Z'), status: 'failed' }),
            upload('failed'),                                                           // a failed upload never counted
            upload('nohive', { hive_permlink: null }),                                  // not on Hive yet
            upload('draft', { status: 'processing' }),
        ]);
        await db().collection('videos').insertOne({ owner: 'legacyguy', permlink: 'x', status: 'published' });
        await db().collection('embed-video').insertOne(upload('legacyguy'));
        await db().collection('embed-audio').insertMany([
            { owner: 'caster', permlink: 'a1', post_permlink: 'ep-1', category: 'podcast', status: 'published', createdAt: hoursAgo(3) },
            { owner: 'singer', permlink: 'a2', post_permlink: 'song', category: 'song', status: 'published', createdAt: hoursAgo(3) },
            { owner: 'oldcaster', permlink: 'a3', post_permlink: 'ep-2', category: 'podcast', status: 'published', createdAt: hoursAgo(3) },
            { owner: 'oldcaster', permlink: 'a4', post_permlink: 'ep-0', category: 'podcast', status: 'published', createdAt: new Date('2026-09-01T00:00:00Z') },
        ]);
        const out = await c.firstAwards(ctx(), { lookup: async () => new Map() });
        expect(out.map((a) => a.id)).toEqual([
            'first:caster:podcast',
            'first:failed:video',
            'first:newbie:short',
            'first:newbie:story',
            'first:newbie:video',
            'first:shorty:short',
        ]);
        expect(out[0]).toEqual({ id: 'first:caster:podcast', user: 'caster', kind: 'first', ref: 'podcast' });
    });

    test('POINTS_FIRSTS_SINCE: a first before it is not new, the window never reaches back past it', async () => {
        await db().collection('embed-video').insertMany([upload('early', { createdAt: hoursAgo(30) })]);
        expect(await c.firstAwards(ctx({ firstsSince: hoursAgo(10) }), { lookup: async () => new Map() })).toEqual([]);
    });

    test('a newcomer\'s first video pays their link or invite referrer, and them', async () => {
        await db().collection('embed-video').insertMany([upload('ann'), upload('ben'), upload('cat'), upload('dan'), upload('eve', { short: true })]);
        const lookup = jest.fn(async () => new Map([
            ['ann', { referrer: 'ref1', source: 'link' }],
            ['ben', { referrer: 'ref2', source: 'invite' }],
            ['cat', { referrer: 'chatgpt', source: 'typed' }],
            ['dan', { referrer: 'dan', source: 'link' }],
        ]));
        const out = await c.firstAwards(ctx(), { lookup });
        expect(lookup).toHaveBeenCalledWith(['ann', 'ben', 'cat', 'dan']);
        expect(out.filter((a) => a.kind !== 'first')).toEqual([
            { id: 'referral:ann', user: 'ref1', kind: 'referral', ref: 'ann' },
            { id: 'invited:ann', user: 'ann', kind: 'referral', ref: 'ref1' },
            { id: 'referral:ben', user: 'ref2', kind: 'referral', ref: 'ben' },
            { id: 'invited:ben', user: 'ben', kind: 'referral', ref: 'ref2' },
        ]);
    });

    test('without Butter Auth configured nobody is a referrer (the real lookup fails open)', async () => {
        await db().collection('embed-video').insertOne(upload('ann'));
        expect((await c.firstAwards(ctx())).map((a) => a.kind)).toEqual(['first']);
    });
});

describe('storyStreakAwards', () => {
    const story = (owner, d, over = {}) => upload(owner, { short: true, story_posted_at: dayAt(d), ...over });
    const nowAt = Date.parse('2026-12-05T12:00:00Z');

    test('every 7th consecutive story day from the launch on; a gap starts over; two stories a day are one day', async () => {
        const rows = [];
        for (let d = 20; d <= 30; d += 1) rows.push(story('runner', d));              // 11 days in a row
        rows.push(story('runner', 30, { story_posted_at: dayAt(30, 23) }));
        for (const d of [1, 2, 3]) rows.push(upload('runner', { short: true, story_posted_at: new Date(`2026-12-0${d}T08:00:00Z`) }));
        for (const d of [24, 25, 26, 28, 29, 30]) rows.push(story('gappy', d));       // never 7
        await db().collection('embed-video').insertMany(rows);
        await db().collection('embed-video').insertOne(upload('gappy', { short: true, story_posted_at: new Date('2026-12-04T08:00:00Z') }));
        const out = await c.storyStreakAwards(ctx({ now: nowAt }));
        // runner: 20..30 Nov + 1..3 Dec = 14 days, 7th = 26 Nov, 14th = 3 Dec.
        expect(out).toEqual([
            { id: 'storystreak:runner:2026-11-26', user: 'runner', kind: 'storystreak' },
            { id: 'storystreak:runner:2026-12-03', user: 'runner', kind: 'storystreak' },
        ]);
    });

    test('days before the launch do not count towards a run; deleted stories do not either', async () => {
        const rows = [];
        for (let d = 17; d <= 25; d += 1) rows.push(story('early', d));               // 6 days from the 20th
        for (let d = 20; d <= 26; d += 1) rows.push(story('del', d, d === 23 ? { status: 'deleted' } : {}));
        await db().collection('embed-video').insertMany(rows);
        expect(await c.storyStreakAwards(ctx({ now: Date.parse('2026-11-26T13:00:00Z') }))).toEqual([]);
    });
});

describe('challengeAwards', () => {
    test('approved entries reviewed in the window, keyed by week and Hive post', async () => {
        await db().collection('shorts_challenge_entries').insertMany([
            { week: '2026-W48', owner: 'amy', permlink: 'k1', hive_author: 'amy', hive_permlink: 'my-short', checked: true, reviewed_at: hoursAgo(2) },
            { week: '2026-W48', owner: 'bo', permlink: 'k2', hive_author: 'bo', hive_permlink: 'nope', checked: false, reviewed_at: hoursAgo(2) },
            { week: '2026-W48', owner: 'cy', permlink: 'k3', checked: false, reviewed_at: null },
            { week: '2026-W47', owner: 'di', permlink: 'k4', checked: true, reviewed_at: hoursAgo(1) },
            { week: '2026-W46', owner: 'ed', permlink: 'k5', hive_author: 'ed', hive_permlink: 'old', checked: true, reviewed_at: hoursAgo(80) },
        ]);
        expect(await c.challengeAwards(ctx())).toEqual([
            { id: 'challenge:2026-W48:amy/my-short', user: 'amy', kind: 'challenge', ref: 'amy/my-short' },
            { id: 'challenge:2026-W47:di/k4', user: 'di', kind: 'challenge', ref: 'di/k4' },
        ]);
    });
});

describe('remixedAwards', () => {
    test('to the original creator, never for a self-remix or a hidden remixer, clips do not count', async () => {
        await db().collection('derived-content').insertMany([
            { kind: 'remix', author: 'rem', permlink: 'r1', source_author: 'orig', source_permlink: 'v1', created: hoursAgo(1) },
            { kind: 'reaction', author: 'rea', permlink: 'r2', source_author: 'orig', source_permlink: 'v1', created: hoursAgo(1) },
            { kind: 'remix', author: 'orig', permlink: 'r3', source_author: 'orig', source_permlink: 'v2', created: hoursAgo(1) },
            { kind: 'remix', author: 'spam', permlink: 'r4', source_author: 'orig', source_permlink: 'v1', created: hoursAgo(1) },
            { kind: 'clip', author: 'clp', permlink: 'r5', source_author: 'orig', source_permlink: 'v1', created: hoursAgo(1) },
            { kind: 'remix', author: 'old', permlink: 'r6', source_author: 'orig', source_permlink: 'v1', created: hoursAgo(100) },
        ]);
        expect(await c.remixedAwards(ctx({ hidden: new Set(['spam']) }))).toEqual([
            { id: 'remixed:rem/r1', user: 'orig', kind: 'remixed', ref: 'orig/v1' },
            { id: 'remixed:rea/r2', user: 'orig', kind: 'remixed', ref: 'orig/v1' },
        ]);
    });
});

describe('tipAwards', () => {
    const tip = (over) => ({ trx_id: `t${Math.random()}`, tipper: 'fan', author: 'maker', tippedAt: hoursAgo(1), ...over });

    test('to the tipper in milli-HBD: HBD value for Hive tips, sats at POINTS_SATS_PER_HBD', async () => {
        await db().collection('supports').insertMany([
            tip({ trx_id: 'hbd', currency: 'HBD', amount: 2.5, hbd_value: 2.5 }),
            tip({ trx_id: 'hive', currency: 'HIVE', amount: 10, hbd_value: 0.234567 }),
            tip({ trx_id: 'sats', currency: 'SATS', amount: 1500, hbd_value: 0 }),
        ]);
        expect(c.SATS_PER_HBD).toBe(1000);
        expect(await c.tipAwards(ctx())).toEqual([
            { id: 'tip:hbd', user: 'fan', kind: 'tip', ref: 'maker', units: 2500 },
            { id: 'tip:hive', user: 'fan', kind: 'tip', ref: 'maker', units: 235 },
            { id: 'tip:sats', user: 'fan', kind: 'tip', ref: 'maker', units: 1500 },
        ]);
    });

    test('no award for dust, yourself, an unknown tipper, before the window, or a streaming day still running', async () => {
        await db().collection('supports').insertMany([
            tip({ trx_id: 'dust', currency: 'HIVE', hbd_value: 0.099 }),
            tip({ trx_id: 'self', currency: 'HBD', hbd_value: 5, tipper: 'maker' }),
            tip({ trx_id: 'anon', currency: 'SATS', amount: 5000, tipper: null }),
            tip({ trx_id: 'old', currency: 'HBD', hbd_value: 5, tippedAt: hoursAgo(80) }),
            tip({ trx_id: 'stream:2026-11-27:maker/p:fan', currency: 'SATS', amount: 900, stream: true }),
            tip({ trx_id: 'stream:2026-11-26:maker/p:fan', currency: 'SATS', amount: 900, stream: true, tippedAt: hoursAgo(20) }),
        ]);
        expect((await c.tipAwards(ctx())).map((a) => [a.id, a.units])).toEqual([['tip:stream:2026-11-26:maker/p:fan', 900]]);
    });

    test('tipMilliHbd', () => {
        expect(c.tipMilliHbd({ currency: 'HBD', hbd_value: 0.0004 })).toBe(0);
        expect(c.tipMilliHbd({ currency: 'SATS', amount: 'x' })).toBe(0);
        expect(c.tipMilliHbd({})).toBe(0);
    });
});
