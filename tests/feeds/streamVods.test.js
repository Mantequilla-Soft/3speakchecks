/**
 * /feeds/stream-vods: the newest stream recording of each creator, newest first
 * (the Home activity panel's Live tab while nobody is live).
 */
jest.mock('../../utils/hive', () => require('./_hiveMock').create());

const request = require('supertest');
const testDb = require('../helpers/db');
const { buildApp } = require('../helpers/app');
const F = require('./_fixtures');

const db = testDb.use();
const app = buildApp(['/feeds', require('../../routes/feeds')]);
const get = (query = {}) => request(app).get('/feeds/stream-vods').query(query);
const embeds = () => db().collection('embed-video');
const vod = (over) => F.embedVideo({ frontend_app: '3speak-hangouts', ...over });

beforeEach(async () => {
  F.pinClock();
  await F.resetFeedCaches(db());
});
afterEach(() => jest.useRealTimers());

test('one recording per creator, the newest, newest creator first', async () => {
  await embeds().insertMany([
    vod({ owner: 'ann', permlink: 'ann-old', createdAt: F.hoursAgo(30) }),
    vod({ owner: 'ann', permlink: 'ann-new', createdAt: F.hoursAgo(2) }),
    vod({ owner: 'bob', permlink: 'bob-1', createdAt: F.hoursAgo(5) }),
    F.embedVideo({ owner: 'cat', permlink: 'cat-legacy', is_openpod_stream: true, createdAt: F.hoursAgo(8) }),
    F.embedVideo({ owner: 'dan', permlink: 'dan-file', originalFilename: 'stream-room-12s.mp4', createdAt: F.hoursAgo(9) }),
  ]);

  const res = await get().expect(200);

  expect(res.body).toMatchObject({ success: true, feed: 'stream-vods', limit: 8 });
  expect(F.permlinks(res.body.videos)).toEqual(['hive-ann-new', 'hive-bob-1', 'hive-cat-legacy', 'hive-dan-file']);
  expect(res.body.videos[0]).toMatchObject({ author: 'ann', streamVod: true, title: 'Title ann-new' });
});

test('leaves out ordinary uploads, shorts, drafts, nsfw, unlisted, hidden and excluded hosts', async () => {
  await embeds().insertMany([
    F.embedVideo({ owner: 'plain', permlink: 'plain-upload' }),
    vod({ owner: 'shorty', permlink: 's', short: true }),
    vod({ owner: 'drafty', permlink: 'd', status: 'encoding' }),
    vod({ owner: 'naughty', permlink: 'n', hive_tags: ['nsfw'] }),
    vod({ owner: 'quiet', permlink: 'q', listed_on_3speak: false }),
    vod({ owner: 'gone', permlink: 'g', unavailable: true }),
    vod({ owner: 'badadib', permlink: 'house' }),
    vod({ owner: 'ancient', permlink: 'a', createdAt: F.daysAgo(400) }),
    vod({ owner: 'kept', permlink: 'k' }),
  ]);

  const res = await get().expect(200);

  expect(F.permlinks(res.body.videos)).toEqual(['hive-k']);
});

test('honours ?limit, creators hidden since the cache loaded, and the viewer\'s dismissals', async () => {
  await embeds().insertMany(['a', 'b', 'c', 'd'].map((o, i) => vod({ owner: o, permlink: `p-${o}`, createdAt: F.hoursAgo(i + 1) })));

  expect(F.permlinks((await get({ limit: 2 }).expect(200)).body.videos)).toEqual(['hive-p-a', 'hive-p-b']);

  await F.hideCreator(db(), 'a');
  await F.dismissCreator(db(), 'viewer', 'b');
  const res = await get({ currentuser: 'viewer', hidewatched: '0' }).expect(200);

  expect(F.permlinks(res.body.videos)).toEqual(['hive-p-c', 'hive-p-d']);
});
