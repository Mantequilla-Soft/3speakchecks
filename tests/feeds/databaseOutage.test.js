/**
 * Every feed, search, profile and leaderboard route with the database unreachable.
 *
 * Mongo sits in another datacentre and does go away. The contract: a route either
 * answers a JSON 500 (never an HTML stack page, never a hang), or, where it reads
 * through one of the "stale beats broken" caches, degrades to an EMPTY answer with
 * a 200, so the page renders with a missing rail instead of an error screen.
 *
 * utils/db is replaced by a handle whose every operation throws.
 */
jest.mock('../../utils/db', () => {
  const down = () => { throw new Error('mongo unreachable'); };
  const collection = () => new Proxy({}, { get: () => down });
  return { getDb: () => ({ collection }), connectToMongo: async () => {}, closeMongo: async () => {} };
});
jest.mock('../../utils/hive', () => require('./_hiveMock').create());
jest.mock('../../utils/incubationHosted', () => ({ followingOf: async () => [] }));
jest.mock('../../services/communitySync', () => ({ indexOneCommunity: async () => { throw new Error('mongo unreachable'); } }));

const request = require('supertest');
const { buildApp, apiKeyHeader } = require('../helpers/app');
const hive = require('../../utils/hive');

const app = buildApp(
  ['/feeds', require('../../routes/feeds')],
  ['/feeds', require('../../routes/watchedFeed')],
  ['/search', require('../../routes/search')],
  ['/', require('../../routes/user')],
  ['/', require('../../routes/videos')],
  ['/', require('../../routes/shorts')],
  ['/', require('../../routes/communities')],
  ['/', require('../../routes/leaderboard')],
  ['/', require('../../routes/snaps')],
  ['/', require('../../routes/playlistsFeed')],
  ['/', require('../../routes/stories')],
);

let logged;
beforeEach(() => {
  hive.__reset();
  hive.__state.following.set('viewer', ['someone']);
  logged = jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

function send(method, path, { body, auth } = {}) {
  let r = request(app)[method](path).timeout(5000);
  if (auth === 'api') r = r.set(apiKeyHeader());
  if (auth === 'upload') r = r.set('Authorization', `Bearer ${process.env.UPLOAD_SECRET_TOKEN}`);
  return body ? r.send(body) : r;
}

describe('routes that answer a JSON 500', () => {
  test.each([
    ['get', '/feeds/related/alice/post'],
    ['get', '/feeds/recommended'],
    ['get', '/feeds/promoted'],
    ['get', '/feeds/new'],
    ['get', '/feeds/trending'],
    ['get', '/feeds/firstUploads'],
    ['get', '/feeds/new-from-following?currentuser=viewer'],
    ['get', '/feeds/suggested-creators?interests=music'],
    ['get', '/feeds/creator-gated/alice'],
    ['get', '/feeds/community/hive-123/new'],
    ['get', '/feeds/community/hive-123/trending'],
    ['get', '/feeds/community/hive-123/top'],
    ['get', '/feeds/watched/viewer'],
    ['get', '/search?q=volcano'],
    ['get', '/search/suggest?q=volcano'],
    ['get', '/videos/tag/music'],
    ['get', '/videos/tag/music/counts'],
    ['get', '/feed/viewer'],
    ['get', '/api/video/alice/post'],
    ['patch', '/api/video/alice/post/reusable', { body: { reusable: true }, auth: 'upload' }],
    ['put', '/video/thumbnail', { body: { owner: 'a', permlink: 'b', thumbnail: 'https://t' }, auth: 'api' }],
    ['put', '/video/openpod', { body: { owner: 'a', permlink: 'b' }, auth: 'api' }],
    ['put', '/video/listing', { body: { owner: 'a', permlink: 'b', listed: true }, auth: 'api' }],
    ['put', '/video/nsfw', { body: { owner: 'a', permlink: 'b', nsfw: true }, auth: 'api' }],
    ['post', '/video/reinstate', { body: { owner: 'a', permlink: 'b' }, auth: 'api' }],
    ['get', '/videodetails/alice/post'],
    ['get', '/transcription-tags/alice/post'],
    ['post', '/transcription-tags/ai-batch', { body: { keys: ['alice/post'] } }],
    ['post', '/video/report-unavailable', { body: { author: 'alice', permlink: 'post' } }],
    ['get', '/video/unavailable-stats', { silent: true }],   // answers 500 without logging
    ['get', '/shorts'],
    ['get', '/shorts/stories'],
    ['get', '/shorts/alice'],
    ['get', '/user/alice/trailer'],
    ['put', '/user/trailer', { body: { username: 'alice', permlink: null }, auth: 'api' }],
    ['get', '/user/alice/counts'],
    ['post', '/users/counts', { body: { usernames: ['alice'] } }],
    ['get', '/premium/alice'],
    ['get', '/premium'],
    ['get', '/check/alice'],
    ['get', '/gethive/u1'],
    ['get', '/getjobid/alice/post'],
    ['get', '/api/my-videos?username=alice'],
    ['get', '/stories'],
    ['get', '/stories/following?currentuser=viewer'],
    ['get', '/stories/streak/alice'],
    ['get', '/stories/seen?author=alice&permlink=post'],
    ['get', '/leaderboard/topics'],
    ['get', '/leaderboard/topic?topic=music'],
    ['get', '/community/hive-123'],
    ['post', '/community/created', { body: { name: 'hive-123456' } }],
    ['get', '/snaps/alice'],
    ['get', '/snaps/community/hive-1'],
    ['post', '/snaps/interaction', { body: { user: 'viewer', author: 'a', permlink: 'b' } }],
  ])('%s %s', async (method, path, opts = {}) => {   // a default, so Jest never reads `opts` as done()
    const res = await send(method, path, opts).expect(500);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    if (!opts.silent) expect(logged).toHaveBeenCalled();
  });

  test('POST /stories/register, once the post checks out', async () => {
    hive.__state.rpc.push([{ result: {
      author: 'meno', permlink: 'p', created: '2026-11-01T10:00:00', body: 'clip',
      json_metadata: JSON.stringify({ '3speak': { story: true }, video: { info: { author: 'meno', permlink: 'clip' } } }),
    } }]);
    await send('post', '/stories/register', { body: { author: 'meno', permlink: 'p' } }).expect(500);
  });

  // The four snap hide routes call the async setHide() without a try/catch
  // (routes/snaps.js:328-347). On Express 4 a rejected handler promise is never
  // passed to the error middleware, so a database failure leaves the request
  // hanging until the client gives up, plus an unhandled rejection in the process.
  test('POST /snaps/hide never answers when the database fails', async () => {
    await send('post', '/snaps/hide', { body: { user: 'viewer', author: 'a', permlink: 'b' } }).timeout(1000).expect(500);
  });
});

describe('routes that fail open to an empty answer', () => {
  test.each([
    ['/feeds/discover', (b) => expect(b).toMatchObject({ total: 0, videos: [] })],
    ['/feeds/interests?interests=music', (b) => expect(b).toMatchObject({ total: 0, videos: [] })],
    ['/feeds/trendingSorted', (b) => expect(b).toMatchObject({ total: 0, videos: [] })],
    ['/feeds/communities/activity', (b) => expect(b.communities).toEqual({})],
    ['/shortssorted', (b) => expect(b).toMatchObject({ total: 0, shorts: [] })],
    ['/leaderboard', (b) => expect(b).toMatchObject({ total: 0, entries: [] })],
    ['/leaderboard/summary', (b) => expect(b.boards.video_uploads.entries).toEqual([])],
    ['/leaderboard/user/alice', (b) => expect(b.found).toBe(false)],
    ['/leaderboard/badges/alice', (b) => expect(b.badges).toEqual([])],
    ['/communities/search?q=gaming', (b) => expect(b.communities).toEqual([])],
    ['/snaps-feed', (b) => expect(b.snaps).toEqual([])],
    ['/playlists-feed', (b) => expect(b.playlists).toEqual([])],
  ])('GET %s', async (path, check) => {
    const res = await send('get', path).expect(200);
    check(res.body);
  });

  test('POST /views reports an unreadable count as null', async () => {
    const res = await send('post', '/views', { body: { videos: [{ author: 'a', permlink: 'outage-b' }] } }).expect(200);
    expect(res.body.data).toEqual({ 'a/outage-b': null });
  });

  test('POST /check-hidden hides nobody rather than breaking comments', async () => {
    expect((await send('post', '/check-hidden', { body: { usernames: ['alice'] } }).expect(200)).body).toEqual({ hidden: [] });
  });
});
