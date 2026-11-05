/**
 * utils/videoAdOptOut.js: a creator turns ads (or only rolls) off on ONE video by
 * writing `json_metadata["3speak"].ads|rolls = false` into its Hive post. The mirror
 * copies what the chain says and nothing else, and a post may only speak for an
 * asset its own author owns.
 */
const fx = require('./_fixtures');

fx.useAdEnv();
jest.mock('../../utils/hive', () => ({ ...jest.requireActual('../../utils/hive'), hiveRpcBatch: jest.fn() }));
const { hiveRpcBatch } = require('../../utils/hive');
const testDb = require('../helpers/db');
const {
  applyVideoAdFlag, syncVideoAdFlagFromChain, videoAdMode, videoOptedOut, adsOffIn, adModeIn,
} = require('../../utils/videoAdOptOut');
const { AD_VIDEO_OPTOUTS_COLLECTION } = require('../../utils/config');

const db = testDb.use();
fx.freezeTime();
beforeEach(() => hiveRpcBatch.mockReset());

const mirror = () => db().collection(AD_VIDEO_OPTOUTS_COLLECTION);
const post = (author, permlink, meta) => ({ result: { author, permlink, json_metadata: JSON.stringify(meta) } });

describe('reading the choice out of a post', () => {
  test.each([
    ['ads off', { '3speak': { ads: false } }, 'off'],
    ['rolls off', { '3speak': { rolls: false } }, 'no-rolls'],
    ['ads off wins over rolls off', { '3speak': { ads: false, rolls: false } }, 'off'],
    ['only a literal false counts', { '3speak': { ads: 'false', rolls: 0 } }, null],
    ['no 3speak block', { app: 'peakd' }, null],
    ['a malformed 3speak block', { '3speak': 'nope' }, null],
    ['nothing at all', null, null],
  ])('%s -> %p', (_label, meta, mode) => {
    expect(adModeIn(meta)).toBe(mode);
    expect(adsOffIn(meta)).toBe(mode === 'off');
  });
});

describe('applyVideoAdFlag: mirroring one post', () => {
  test('ads off is stored against the embed asset, with who said so', async () => {
    const out = await applyVideoAdFlag('@Creator1', 'hive-post', JSON.stringify({ '3speak': { ads: false } }));
    expect(out).toEqual({ owner: 'creator1', permlink: 'hive-post', adsEnabled: false, rollsEnabled: false, adMode: 'off' });
    expect(await mirror().findOne({ _id: 'creator1/hive-post' })).toMatchObject({
      mode: 'off', hiveAuthor: 'creator1', hivePermlink: 'hive-post', updatedAt: new Date(fx.NOW),
    });
  });

  test('the asset named in video.info is the one mirrored, not the post permlink', async () => {
    const meta = { video: { info: { author: 'creator1', permlink: 'asset-9' } }, '3speak': { rolls: false } };
    const out = await applyVideoAdFlag('creator1', 'my-post', meta);
    expect(out).toMatchObject({ permlink: 'asset-9', adsEnabled: true, rollsEnabled: false, adMode: 'no-rolls' });
    await expect(videoAdMode('creator1', 'asset-9')).resolves.toBe('no-rolls');
  });

  test('a post without the flag turns ads back on by deleting the exception', async () => {
    await applyVideoAdFlag('creator1', 'p1', { '3speak': { ads: false } });
    const out = await applyVideoAdFlag('creator1', 'p1', '{}');
    expect(out).toMatchObject({ adsEnabled: true, rollsEnabled: true, adMode: 'on' });
    expect(await mirror().countDocuments()).toBe(0);
  });

  test('a remix pointing at somebody else\'s upload cannot switch ads off on it', async () => {
    const meta = { video: { info: { author: 'original', permlink: 'their-video' } }, '3speak': { ads: false } };
    await expect(applyVideoAdFlag('remixer', 'remix-post', meta)).resolves.toEqual({ refused: 'not_asset_owner' });
    expect(await mirror().countDocuments()).toBe(0);
  });

  test('an asset name that is not a plain id is refused', async () => {
    const meta = { video: { info: { author: 'creator1', permlink: '../../etc' } } };
    await expect(applyVideoAdFlag('creator1', 'p', meta)).resolves.toEqual({ refused: 'bad_asset' });
  });

  test('unreadable metadata is the default: ads on', async () => {
    await expect(applyVideoAdFlag('creator1', 'p2', '{not json')).resolves.toMatchObject({ adMode: 'on' });
  });
});

describe('syncVideoAdFlagFromChain', () => {
  test('reads the post off the chain and mirrors it', async () => {
    hiveRpcBatch.mockResolvedValue([post('creator1', 'p1', { '3speak': { ads: false } })]);
    await expect(syncVideoAdFlagFromChain('Creator1', 'p1')).resolves.toMatchObject({ adMode: 'off' });
    expect(hiveRpcBatch.mock.calls[0][0][0]).toMatchObject({ method: 'condenser_api.get_content', params: ['creator1', 'p1'] });
    await expect(videoOptedOut('creator1', 'p1')).resolves.toBe(true);
  });

  test.each([
    ['no node answered', [], null],
    ['the node says the post does not exist', [{ error: { message: 'Post does not exist' } }], { notFound: true }],
    ['any other node error', [{ error: { message: 'rate limited' } }], null],
    ['an older node answers with a zeroed stub', [{ result: { author: '', permlink: '' } }], { notFound: true }],
    ['a different post came back', [post('someone', 'p1', {})], { notFound: true }],
  ])('%s', async (_label, answer, want) => {
    hiveRpcBatch.mockResolvedValue(answer);
    await expect(syncVideoAdFlagFromChain('creator1', 'p1')).resolves.toEqual(want);
  });
});

describe('videoAdMode: the serve-path point read', () => {
  test.each([
    ['no owner', '', 'p', null],
    ['no permlink', 'creator1', '', null],
    ['no row', 'creator1', 'none', null],
  ])('%s -> null', async (_label, owner, permlink) => {
    await expect(videoAdMode(owner, permlink)).resolves.toBeNull();
  });

  test('a row from before modes existed is an opt-out', async () => {
    await mirror().insertOne({ _id: 'creator1/old', owner: 'creator1', permlink: 'old' });
    await expect(videoAdMode('creator1', 'old')).resolves.toBe('off');
  });
});

describe('the index on the mirror', () => {
  test('is created on first write, and a failure is logged and retried next time', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    let fail = true;
    const coll = {
      createIndex: jest.fn(async () => { if (fail) throw new Error('not primary'); }),
      deleteOne: jest.fn(async () => ({})),
    };
    const mod = fx.loadIsolated('../../utils/videoAdOptOut', {
      mocks: { '../../utils/db': () => ({ getDb: () => ({ collection: () => coll }) }) },
    });
    await mod.applyVideoAdFlag('creator1', 'p', {});
    expect(err).toHaveBeenCalledWith('[video-ad-optout] index creation failed:', 'not primary');
    fail = false;
    await mod.applyVideoAdFlag('creator1', 'p', {});
    await mod.applyVideoAdFlag('creator1', 'p', {});
    expect(coll.createIndex).toHaveBeenCalledTimes(2);
  });
});
