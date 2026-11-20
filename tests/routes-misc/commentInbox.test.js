/**
 * Comment inbox (routes/commentInbox.js): the comments addressed to a creator
 * from HafSQL (a stand-in here), each flagged answered / question / first-time /
 * supporter / done, behind the session vouch; done is stored per creator.
 */
jest.mock('../../utils/hiveAuth', () => ({
  verifyHiveAuthority: jest.fn(async () => ({ ok: false })),
  verifyDelegateVouch: jest.fn(async ({ signature }) => ({ ok: signature === 'good' })),
}));
const mockQuery = jest.fn();
jest.mock('../../utils/hafsql', () => ({ query: (...args) => mockQuery(...args) }));
const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');

const db = testDb.use();
const router = require('../../routes/commentInbox');
const app = buildApp(['/', router]);
const { isQuestion, reset } = router._test;

const vouch = (over = {}) => ({ user: 'badadib', signature: 'good', timestamp: Date.now(), ...over });
// One clock reading for the whole file: the route matches a comment's `created`
// against the author's first comment to the millisecond (firstTime), so two
// `at(2)` calls must give the same instant. With Date.now() read per call, a
// millisecond tick between them flipped firstTime and failed main's Tests run
// on 2026-11-20 (and with it the deploy).
const NOW = Date.now();
const at = (h) => new Date(NOW - h * 3600 * 1000);

// What HafSQL answers, by the query asked.
function hafsqlFor({ comments, replies = [], firsts = [], voters = [], roots = [] }) {
  mockQuery.mockImplementation(async (sql) => {
    if (/from hafsql\.follows/.test(sql)) return [{ head: 100000000 }];
    if (/root_author = \$1 and parent_author = \$1/.test(sql)) return comments;
    if (/where author = \$1 and parent_author = any/.test(sql)) return replies;
    if (/min\(created\)/.test(sql)) return firsts;
    if (/operation_vote_view/.test(sql)) return voters;
    if (/where author = \$1 and permlink = any/.test(sql)) return roots;
    throw new Error(`unexpected query ${sql}`);
  });
}

beforeEach(() => { reset(); mockQuery.mockReset(); });

describe('isQuestion', () => {
  test('a question mark in the words, not in a link or code', () => {
    expect(isQuestion('How did you film this?')).toBe(true);
    expect(isQuestion('see https://3speak.tv/watch?v=badadib/x')).toBe(false);
    expect(isQuestion('[link](https://x.y/?a=1) nice')).toBe(false);
    expect(isQuestion('run `a ? b : c`')).toBe(false);
    expect(isQuestion('これは何ですか？')).toBe(true);
  });
});

describe('POST /creator-inbox', () => {
  test('without a good vouch: 401, and HafSQL is not asked', async () => {
    await request(app).post('/creator-inbox').send(vouch({ signature: 'bad' })).expect(401);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('every comment with its flags; bots left out', async () => {
    hafsqlFor({
      comments: [
        { author: 'fan', permlink: 're-1', parent_permlink: 'post-a', root_permlink: 'post-a', body: 'What camera is this?', created: at(1) },
        { author: 'newbie', permlink: 're-2', parent_permlink: 'my-reply', root_permlink: 'post-a', body: 'Thanks!', created: at(2) },
        { author: 'hivebuzz', permlink: 're-3', parent_permlink: 'post-a', root_permlink: 'post-a', body: 'Badge!', created: at(3) },
        { author: 'tipper', permlink: 're-4', parent_permlink: 'post-b', root_permlink: 'post-b', body: 'Great', created: at(4) },
      ],
      replies: [{ parent_author: 'newbie', parent_permlink: 're-2' }],
      firsts: [{ author: 'fan', first: at(500) }, { author: 'newbie', first: at(2) }, { author: 'tipper', first: at(4) }],
      voters: [{ voter: 'fan' }],
      roots: [{ permlink: 'post-a', title: 'My first video' }, { permlink: 'post-b', title: 'Second' }],
    });
    await db().collection('supports').insertOne({ tipper: 'tipper', author: 'badadib', permlink: 'post-b', hbd_value: 1 });

    const { body } = await request(app).post('/creator-inbox').send(vouch()).expect(200);
    expect(body.items.map((i) => i.author)).toEqual(['fan', 'newbie', 'tipper']);
    const [fan, newbie, tipper] = body.items;
    expect(fan).toMatchObject({ question: true, answered: false, firstTime: false, supporter: true, onPost: true, rootTitle: 'My first video', done: false });
    expect(newbie).toMatchObject({ question: false, answered: true, firstTime: true, supporter: false, onPost: false });
    expect(tipper).toMatchObject({ supporter: true, firstTime: true, rootPermlink: 'post-b' });
  });

  test('accounts on the comment mutelist (repo list + comment_mutes) are left out, in the query too', async () => {
    require('../../utils/commentMutes')._test.reset();
    await db().collection('comment_mutes').insertOne({ _id: 'spambot', reason: 'bot', at: new Date() });
    hafsqlFor({
      comments: [
        { author: 'fan', permlink: 're-1', parent_permlink: 'p', root_permlink: 'p', body: 'hi', created: at(1) },
        { author: 'ai-agent-hunter', permlink: 're-2', parent_permlink: 'p', root_permlink: 'p', body: 'beep', created: at(2) },
        { author: 'spambot', permlink: 're-3', parent_permlink: 'p', root_permlink: 'p', body: 'buy', created: at(3) },
      ],
      firsts: [{ author: 'fan', first: at(1) }],
    });
    const { body } = await request(app).post('/creator-inbox').send(vouch()).expect(200);
    expect(body.items.map((i) => i.author)).toEqual(['fan']);
    const [sql, params] = mockQuery.mock.calls.find(([q]) => /root_author = \$1 and parent_author = \$1/.test(q));
    expect(sql).toMatch(/not \(author = any\(\$4\)\)/);
    expect(params[3]).toEqual(expect.arrayContaining(['hivebuzz', 'ai-agent-hunter', 'spambot']));
    require('../../utils/commentMutes')._test.reset();
  });

  test('done is kept per creator and comes back on the list; undone removes it', async () => {
    hafsqlFor({ comments: [{ author: 'fan', permlink: 're-1', parent_permlink: 'p', root_permlink: 'p', body: 'hi', created: at(1) }] });
    await request(app).post('/creator-inbox/done').send({ ...vouch(), author: 'fan', permlink: 're-1' }).expect(200);
    expect(await db().collection('comment_inbox_done').find({}).project({ _id: 0, at: 0 }).toArray())
      .toEqual([{ user: 'badadib', author: 'fan', permlink: 're-1' }]);
    let r = await request(app).post('/creator-inbox').send(vouch()).expect(200);
    expect(r.body.items[0].done).toBe(true);
    // Someone else's done list is their own.
    r = await request(app).post('/creator-inbox').send(vouch({ user: 'fan' })).expect(200);
    expect(r.body.items[0].done).toBe(false);

    await request(app).post('/creator-inbox/done').send({ ...vouch(), author: 'fan', permlink: 're-1', done: false }).expect(200);
    expect(await db().collection('comment_inbox_done').countDocuments()).toBe(0);
  });

  test('a bad comment name is refused; HafSQL down is a 503', async () => {
    await request(app).post('/creator-inbox/done').send({ ...vouch(), author: 'X Y', permlink: 're-1' }).expect(400);
    mockQuery.mockRejectedValue(new Error('down'));
    await request(app).post('/creator-inbox').send(vouch()).expect(503);
  });

  test('no comments: an empty list without the follow-up queries', async () => {
    hafsqlFor({ comments: [] });
    const { body } = await request(app).post('/creator-inbox').send(vouch()).expect(200);
    expect(body.items).toEqual([]);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});
