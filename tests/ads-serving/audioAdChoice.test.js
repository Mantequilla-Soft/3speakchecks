/**
 * utils/audioAdChoice.js: the uploader's "Ads on this audio" switch, read off the
 * track's Hive post. It overrides the account setting for that one track in either
 * direction, and only ever for audio the post's own author owns.
 */
const fx = require('./_fixtures');

fx.useAdEnv();
jest.mock('../../utils/hive', () => ({ ...jest.requireActual('../../utils/hive'), hiveRpcBatch: jest.fn() }));
const { hiveRpcBatch } = require('../../utils/hive');
const testDb = require('../helpers/db');
const { applyAudioAdChoice, syncAudioAdChoiceFromChain, audioAdChoice, audioAdsIn } = require('../../utils/audioAdChoice');

const db = testDb.use();
fx.freezeTime();
beforeEach(async () => {
  hiveRpcBatch.mockReset();
  await db().collection('embed-audio').insertOne({ owner: 'creator1', permlink: 'track-1', post_permlink: 'my-song' });
});

const choices = () => db().collection('ad_audio_choices');
const meta = (audioAds) => JSON.stringify({ '3speak': { audioAds } });

describe('audioAdsIn', () => {
  test.each([
    [{ '3speak': { audioAds: true } }, true],
    [{ '3speak': { audioAds: false } }, false],
    [{ '3speak': { audioAds: 'false' } }, null],
    [{ '3speak': 'x' }, null],
    [{}, null],
    [null, null],
  ])('%j -> %p', (m, want) => expect(audioAdsIn(m)).toBe(want));
});

describe('applyAudioAdChoice', () => {
  test.each([[true], [false]])('a choice of %p is mirrored under the embed asset, not the post', async (choice) => {
    await expect(applyAudioAdChoice('@Creator1', 'my-song', meta(choice)))
      .resolves.toEqual({ owner: 'creator1', permlink: 'track-1', audioAds: choice });
    expect(await choices().findOne({ _id: 'creator1/track-1' })).toMatchObject({
      ads: choice, hiveAuthor: 'creator1', hivePermlink: 'my-song', updatedAt: new Date(fx.NOW),
    });
    await expect(audioAdChoice('creator1', 'track-1')).resolves.toBe(choice);
  });

  test('a post without the key goes back to following the account', async () => {
    await applyAudioAdChoice('creator1', 'my-song', meta(false));
    await expect(applyAudioAdChoice('creator1', 'my-song', '{}')).resolves.toMatchObject({ audioAds: null });
    expect(await choices().countDocuments()).toBe(0);
    await expect(audioAdChoice('creator1', 'track-1')).resolves.toBeNull();
  });

  test('a post not yet linked to its audio asks to be retried', async () => {
    await expect(applyAudioAdChoice('creator1', 'unlinked-post', meta(false))).resolves.toEqual({ notFound: true });
  });

  test('a post by someone else cannot set the choice on this creator\'s audio', async () => {
    await expect(applyAudioAdChoice('intruder', 'my-song', meta(false))).resolves.toEqual({ notFound: true });
    expect(await choices().countDocuments()).toBe(0);
  });

  test('metadata that is not JSON is read as no choice', async () => {
    await expect(applyAudioAdChoice('creator1', 'my-song', '{oops')).resolves.toMatchObject({ audioAds: null });
  });
});

describe('syncAudioAdChoiceFromChain', () => {
  test('reads the post and mirrors it', async () => {
    hiveRpcBatch.mockResolvedValue([{ result: { author: 'creator1', permlink: 'my-song', json_metadata: meta(true) } }]);
    await expect(syncAudioAdChoiceFromChain('creator1', 'my-song')).resolves.toMatchObject({ audioAds: true });
  });

  test.each([
    ['no node answered', [], null],
    ['the post does not exist', [{ error: { message: 'does not exist' } }], { notFound: true }],
    ['another node error', [{ error: { code: -32000 } }], null],
    ['an empty stub', [{ result: { author: '', permlink: '' } }], { notFound: true }],
  ])('%s', async (_label, answer, want) => {
    hiveRpcBatch.mockResolvedValue(answer);
    await expect(syncAudioAdChoiceFromChain('creator1', 'my-song')).resolves.toEqual(want);
  });
});

describe('audioAdChoice: the serve-path read', () => {
  test('nothing asked, or a row without a boolean, means follow the account', async () => {
    await choices().insertOne({ _id: 'creator1/odd', ads: 'yes' });
    await expect(audioAdChoice('', 'track-1')).resolves.toBeNull();
    await expect(audioAdChoice('creator1', '')).resolves.toBeNull();
    await expect(audioAdChoice('creator1', 'odd')).resolves.toBeNull();
  });
});
