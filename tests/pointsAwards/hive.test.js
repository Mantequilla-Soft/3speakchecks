/**
 * 3Speak Points kinds read from Hive (services/pointsAwards/hive.js): tag, reply,
 * community, followers. HafSQL is a stand-in answering by query; Mongo is this
 * worker's throwaway database.
 */
jest.mock('../../utils/hiddenCreators', () => ({ hiddenListSync: jest.fn(() => []) }));
jest.mock('../../utils/hafsql', () => ({ query: jest.fn() }));
const hafsql = require('../../utils/hafsql');
const testDb = require('../helpers/db');
const h = require('../../services/pointsAwards/hive');
const { ACTIVITY } = require('../../services/pointsAwards/activity');

const db = testDb.use();
const NOW = Date.parse('2026-11-27T12:00:00Z');
const LAUNCH = new Date('2026-11-20T00:00:00Z');
const ctx = (over = {}) => ({ db: db(), now: NOW, launch: LAUNCH, ...over });
const hoursAgo = (h2) => new Date(NOW - h2 * 3600 * 1000);

/** HafSQL answering by which table a query reads; every call is kept. */
function stubHafsql(tables) {
    hafsql.query.mockImplementation(async (sql, params) => {
        if (/from hafsql\.follows order by block_num desc/.test(sql)) return [{ head: 1_000_000 }];
        if (/operation_custom_json_view/.test(sql)) return tables.tags || [];
        if (/from hafsql\.comments/.test(sql)) return tables.replies || [];
        if (/community_subs/.test(sql)) return tables.subs || [];
        if (/count\(\*\)/.test(sql)) return (tables.followers || []).filter((r) => params[0].includes(r.account));
        throw new Error(`unexpected query ${sql}`);
    });
}

describe('tagAwards', () => {
    const op = (voter, j, at = hoursAgo(1)) => ({ auths: [voter], json: JSON.stringify(j), timestamp: at });

    test('signed tags on someone else\'s video, one per voter, post and tag; upload ids become the Hive post', async () => {
        await db().collection('embed-video').insertOne({ owner: 'bob', permlink: 'wmrx5qfa', hive_author: 'bob', hive_permlink: 'my-video' });
        stubHafsql({ tags: [
            op('amy', { author: 'bob', permlink: 'wmrx5qfa', tag: 'Gaming' }),
            op('amy', { author: 'bob', permlink: 'wmrx5qfa', tag: 'gaming' }),          // the same again
            op('amy', { author: 'bob', permlink: 'other-post', tag: 'vlog' }),
            op('bob', { author: 'bob', permlink: 'wmrx5qfa', tag: 'gaming' }),           // own
            op('cy', { author: 'bob', permlink: 'wmrx5qfa', tag: 'not-a-tag' }),
            op('di', { author: 'bob', permlink: 'wmrx5qfa', tag: 'music' }, hoursAgo(80)),
            { auths: ['ed'], json: '{broken', timestamp: hoursAgo(1) },
            op('', { author: 'bob', permlink: 'x', tag: 'music' }),
        ] });
        expect(await h.tagAwards(ctx())).toEqual([
            { id: 'tag:amy:bob/my-video:gaming', user: 'amy', kind: 'tag', ref: 'bob/my-video' },
            { id: 'tag:amy:bob/other-post:vlog', user: 'amy', kind: 'tag', ref: 'bob/other-post' },
        ]);
        // The block window: head minus the window's 72 hours of 3 s blocks.
        const [, params] = hafsql.query.mock.calls.find(([sql]) => /custom_json/.test(sql));
        expect(params).toEqual([1_000_000 - 72 * 1200, 5000]);
    });

    test('the launch narrows the window', async () => {
        stubHafsql({ tags: [{ auths: ['amy'], json: { author: 'bob', permlink: 'p', tag: 'music' }, timestamp: hoursAgo(5) }] });
        expect(await h.tagAwards(ctx({ launch: hoursAgo(2) }))).toEqual([]);
        expect((await h.tagAwards(ctx())).map((a) => a.id)).toEqual(['tag:amy:bob/p:music']);
    });
});

describe('replyAwards', () => {
    const reply = (creator, commenter, comment, root) => ({ creator, commenter, comment, root_permlink: root });

    test('a creator answering a comment under their 3Speak video pays the commenter; bots and other posts do not', async () => {
        await db().collection('embed-video').insertOne({ owner: 'bob', permlink: 'k1', hive_author: 'bob', hive_permlink: 'my-video' });
        stubHafsql({ replies: [
            reply('bob', 'amy', 're-amy-1', 'my-video'),
            reply('bob', 'amy', 're-amy-1', 'my-video'),
            reply('bob', 'hivebuzz', 're-buzz', 'my-video'),
            reply('bob', 'cy', 're-cy', 'a-blog-post'),
            reply('bob', 'bob', 'own', 'my-video'),
        ] });
        expect(await h.replyAwards(ctx())).toEqual([{ id: 'reply:amy/re-amy-1', user: 'amy', kind: 'reply', ref: 'bob' }]);
        const [, params] = hafsql.query.mock.calls.find(([sql]) => /hafsql\.comments/.test(sql));
        expect(params).toEqual([hoursAgo(72), 5000]);
    });

    test('no replies: nothing else is read', async () => {
        stubHafsql({});
        expect(await h.replyAwards(ctx())).toEqual([]);
    });
});

describe('communityAwards', () => {
    test('subscriptions by 3Speak creators and recent viewers only', async () => {
        await db().collection('contentcreators').insertOne({ username: 'maker' });
        await db().collection(ACTIVITY).insertOne({ _id: 'x', kind: 'watch', user: 'watcher' });
        stubHafsql({ subs: [
            { account_name: 'maker', community_name: 'hive-181335' },
            { account_name: 'watcher', community_name: 'hive-100421' },
            { account_name: 'stranger', community_name: 'hive-181335' },
            { account_name: 'maker', community_name: 'not-a-community' },
        ] });
        expect(await h.communityAwards(ctx())).toEqual([
            { id: 'community:maker:hive-181335', user: 'maker', kind: 'community', ref: 'hive-181335' },
            { id: 'community:watcher:hive-100421', user: 'watcher', kind: 'community', ref: 'hive-100421' },
        ]);
    });

    test('nothing in the window: no Mongo lookups needed', async () => {
        stubHafsql({});
        expect(await h.communityAwards(ctx())).toEqual([]);
    });
});

describe('followerAwards', () => {
    const creator = (owner) => ({ owner, permlink: `k-${owner}`, status: 'published', processed: true, createdAt: hoursAgo(24) });

    test('first look stores the count; later runs pay every milestone passed since, once a day', async () => {
        await db().collection('embed-video').insertMany([creator('grower'), creator('jumper'), creator('steady')]);
        stubHafsql({ followers: [{ account: 'grower', n: 9 }, { account: 'jumper', n: 5 }, { account: 'steady', n: 150 }] });
        expect(await h.followerAwards(ctx())).toEqual([]);
        const base = await db().collection(h.FOLLOWER_BASE).find({}, { sort: { _id: 1 } }).toArray();
        expect(base.map((b) => [b._id, b.base])).toEqual([['grower', 9], ['jumper', 5], ['steady', 150]]);

        // Same day: not looked at again.
        hafsql.query.mockClear();
        expect(await h.followerAwards(ctx({ now: NOW + 3600 * 1000 }))).toEqual([]);
        expect(hafsql.query).not.toHaveBeenCalled();

        // Next day: grower passed 10, jumper passed 10 and 100, steady passed nothing new.
        stubHafsql({ followers: [{ account: 'grower', n: 10 }, { account: 'jumper', n: 120 }, { account: 'steady', n: 160 }] });
        const next = NOW + 86400 * 1000;
        expect(await h.followerAwards(ctx({ now: next }))).toEqual([
            { id: 'followers:grower:10', user: 'grower', kind: 'followers', ref: '10' },
            { id: 'followers:jumper:10', user: 'jumper', kind: 'followers', ref: '10' },
            { id: 'followers:jumper:100', user: 'jumper', kind: 'followers', ref: '100' },
        ]);
    });

    test('an account no longer publishing keeps being looked at once it has a base', async () => {
        await db().collection(h.FOLLOWER_BASE).insertOne({ _id: 'quiet', base: 990 });
        stubHafsql({ followers: [{ account: 'quiet', n: 1001 }] });
        expect((await h.followerAwards(ctx())).map((a) => a.id)).toEqual(['followers:quiet:1000']);
    });

    test('nothing at all with Mongo writes off (no base can be stored)', async () => {
        await jest.isolateModulesAsync(async () => {
            process.env.ENABLE_MONGO_WRITES = 'false';
            const off = require('../../services/pointsAwards/hive');
            expect(await off.followerAwards(ctx())).toEqual([]);
            delete process.env.ENABLE_MONGO_WRITES;
        });
    });
});
