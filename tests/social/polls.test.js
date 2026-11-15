/**
 * Polls on community snaps: the poll is parsed from the snap's own json_metadata
 * when it is indexed (routes/snaps.js, utils/polls.js) and fixed from then on;
 * votes (routes/polls.js) are one per account with the session vouch, can move
 * until the poll ends, and the tallies are public. The vouch check and the Hive
 * read are stand-ins; Mongo is the test database.
 */
jest.mock('../../utils/hiveAuth', () => ({
  verifyHiveAuthority: jest.fn(async () => ({ ok: false })),
  verifyDelegateVouch: jest.fn(async ({ signature }) => ({ ok: signature === 'good' })),
}));
jest.mock('../../utils/hive', () => require('../feeds/_hiveMock').create());

const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const { fakeHiveChain } = require('../helpers/hive');
const { parsePoll, isClosed } = require('../../utils/polls');

const db = testDb.use();
const app = buildApp(['/', require('../../routes/snaps')], ['/', require('../../routes/polls')]);
const vouch = (user) => ({ user, signature: 'good', timestamp: Date.now() });
const DAY = 86400000;

const pollSnap = (permlink, poll, over = {}) => ({
  _id: `badadib/${permlink}`, owner: 'badadib', permlink, body: 'Which topic next?', created: new Date(), poll, ...over,
});

describe('parsePoll', () => {
  const created = new Date('2026-11-15T10:00:00Z');
  test('2 to 4 distinct options, trimmed, and an end within 30 days', () => {
    expect(parsePoll({ poll: { options: [' Yes ', 'No'], ends_at: '2026-11-16T10:00:00Z' } }, created))
      .toEqual({ options: ['Yes', 'No'], ends_at: new Date('2026-11-16T10:00:00Z') });
    expect(parsePoll({ poll: { options: ['a', 'b'], ends_at: '2027-01-01T00:00:00Z' } }, created).ends_at).toBeNull();
    expect(parsePoll({ poll: { options: ['a', 'b'], ends_at: '2026-11-01T00:00:00Z' } }, created).ends_at).toBeNull();
  });
  test.each([
    ['one option', { options: ['a'] }],
    ['five options', { options: ['a', 'b', 'c', 'd', 'e'] }],
    ['duplicates', { options: ['Yes', 'yes'] }],
    ['no options', {}],
  ])('%s is not a poll', (_l, poll) => {
    expect(parsePoll({ poll }, created)).toBeNull();
  });
  test('isClosed', () => {
    expect(isClosed({ ends_at: new Date(Date.now() - 1000) })).toBe(true);
    expect(isClosed({ ends_at: null })).toBe(false);
  });
});

describe('indexing a poll snap', () => {
  const chainPost = (meta) => ({
    author: 'badadib', permlink: 'poll-1', title: '', body: 'Which topic next?', created: '2026-11-15T10:00:00',
    parent_author: 'peak.snaps', parent_permlink: 'c', json_metadata: JSON.stringify({ app: '3speak/snap', tags: ['community'], ...meta }),
  });

  test('the poll is stored on first index and an edit cannot change it', async () => {
    let meta = { poll: { options: ['Music', 'Code'] } };
    fakeHiveChain([], { get_content: () => chainPost(meta) });
    const res = await request(app).post('/snaps').send({ author: 'badadib', permlink: 'poll-1' }).expect(200);
    expect(res.body.snap.poll).toEqual({ options: ['Music', 'Code'], ends_at: null });

    meta = { poll: { options: ['Something', 'Else'] } };
    await request(app).post('/snaps').send({ author: 'badadib', permlink: 'poll-1' }).expect(200);
    expect((await db().collection('community-snaps').findOne({ _id: 'badadib/poll-1' })).poll.options).toEqual(['Music', 'Code']);
  });
});

describe('voting', () => {
  beforeEach(async () => {
    await db().collection('community-snaps').insertMany([
      pollSnap('open', { options: ['Music', 'Code', 'Art'], ends_at: null }),
      pollSnap('closed', { options: ['A', 'B'], ends_at: new Date(Date.now() - DAY) }),
      { _id: 'badadib/plain', owner: 'badadib', permlink: 'plain', body: 'no poll', created: new Date() },
    ]);
  });
  const vote = (user, permlink, choice, extra = {}) => request(app).post('/polls/vote').send({ ...vouch(user), author: 'badadib', permlink, choice, ...extra });

  test('one vote per account, the last one counts', async () => {
    await vote('fan', 'open', 0).expect(200);
    await vote('other', 'open', 1).expect(200);
    const res = await vote('fan', 'open', 1).expect(200);
    expect(res.body.result).toEqual({ counts: [0, 2, 0], total: 2, closed: false, ends_at: null, mine: 1 });
    expect(await db().collection('poll_votes').countDocuments()).toBe(2);
  });

  test('refused: bad vouch, no poll, bad choice, closed poll', async () => {
    await vote('fan', 'open', 0, { signature: 'bad' }).expect(401);
    await vote('fan', 'plain', 0).expect(404);
    await vote('fan', 'open', 3).expect(400);
    await vote('fan', 'open', 'x').expect(400);
    await vote('fan', 'closed', 0).expect(409);
  });

  test('results: public counts, the caller\'s own choice only with a vouch', async () => {
    await vote('fan', 'open', 2).expect(200);
    const keys = ['badadib/open', 'badadib/closed', 'badadib/plain', 'not a key'];
    let res = await request(app).post('/polls/results').send({ keys }).expect(200);
    expect(res.body.results).toEqual({
      'badadib/open': { counts: [0, 0, 1], total: 1, closed: false, ends_at: null },
      'badadib/closed': expect.objectContaining({ counts: [0, 0], total: 0, closed: true }),
    });
    res = await request(app).post('/polls/results').send({ keys, ...vouch('fan') }).expect(200);
    expect(res.body.results['badadib/open'].mine).toBe(2);
    expect(res.body.results['badadib/closed'].mine).toBeNull();
  });

  test('creator stats: the creator\'s polls with tallies', async () => {
    await vote('fan', 'open', 1).expect(200);
    const res = await request(app).get('/polls/creator/badadib').expect(200);
    expect(res.body.polls.map((p) => [p.permlink, p.total, p.closed])).toEqual(expect.arrayContaining([['open', 1, false], ['closed', 0, true]]));
    expect(res.body.polls).toHaveLength(2);
    expect(res.body.polls.find((p) => p.permlink === 'open')).toMatchObject({ question: 'Which topic next?', options: ['Music', 'Code', 'Art'], counts: [0, 1, 0] });
    await request(app).get('/polls/creator/Not Valid').expect(400);
  });
});
