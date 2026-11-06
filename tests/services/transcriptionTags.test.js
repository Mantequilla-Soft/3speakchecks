/**
 * utils/transcriptionTags.js: the transcription pipeline's tags for a video.
 *
 * `subtitles-tags` is keyed by owner + ASSET permlink; callers speak in HIVE
 * permlinks. For legacy videos the two are the same, for embed videos they are
 * not and `embed-video` maps one to the other. Runs on the real test MongoDB.
 */
const testDb = require('../helpers/db');
const {
  getTranscriptionTags, splitTags, fetchTagsV2Batch, fetchAiFlagsBatch,
} = require('../../utils/transcriptionTags');

const db = testDb.use();
const tags = () => db().collection('subtitles-tags');
const embeds = () => db().collection('embed-video');
const AT = new Date('2026-10-01T00:00:00Z');

describe('splitTags', () => {
  test.each([
    ['Music, Gaming ,,  ART', ['music', 'gaming', 'art']],
    ['', []],
    [null, []],
    [undefined, []],
  ])('%p -> %p', (raw, out) => expect(splitTags(raw)).toEqual(out));
});

describe('getTranscriptionTags', () => {
  test('a legacy video is a direct hit on its own permlink', async () => {
    await tags().insertOne({ author: 'alice', permlink: 'abc123', tags: 'Music, Live', created_at: AT, tags_list_v2: ['Music', ' entertainment '], tag_model_v2: 'm2', tagged_v2_at: AT });
    const out = await getTranscriptionTags(db(), '@Alice ', ' abc123 ');
    expect(out).toEqual({
      tags: ['music', 'live'],
      assetPermlink: 'abc123',
      resolvedVia: 'direct',
      taggedAt: AT,
      tagsV2: ['music', 'entertainment'],
      tagModelV2: 'm2',
      taggedV2At: AT,
      unavailableOnTagging: false,
      aiGenerated: false,
      aiGeneratedEvidence: [],
      aiGeneratedCheckedAt: null,
    });
  });

  test('an embed video is found through its hive permlink -> asset permlink mapping', async () => {
    await embeds().insertOne({ owner: 'alice', permlink: 'asset-9', hive_author: 'alice', hive_permlink: 'my-hive-post' });
    await tags().insertOne({ author: 'alice', permlink: 'asset-9', tags: 'travel', tags_v2: 'travel, nature' });
    const out = await getTranscriptionTags(db(), 'alice', 'my-hive-post');
    expect(out).toMatchObject({ tags: ['travel'], assetPermlink: 'asset-9', resolvedVia: 'embed', tagsV2: ['travel', 'nature'] });
  });

  test('an embed video not tagged yet resolves, with empty tags', async () => {
    await embeds().insertOne({ owner: 'alice', permlink: 'asset-9', hive_author: 'alice', hive_permlink: 'p' });
    expect(await getTranscriptionTags(db(), 'alice', 'p')).toMatchObject({ tags: [], assetPermlink: 'asset-9', resolvedVia: 'embed', tagModelV2: null });
  });

  test('unknown video, or a missing author/permlink, is the empty answer', async () => {
    const empty = { tags: [], assetPermlink: null, resolvedVia: 'none', tagsV2: [], aiGenerated: false };
    expect(await getTranscriptionTags(db(), 'alice', 'nope')).toMatchObject(empty);
    expect(await getTranscriptionTags(db(), '', 'x')).toMatchObject(empty);
    expect(await getTranscriptionTags(db(), 'alice', '  ')).toMatchObject(empty);
  });

  test.each([
    [true, true],
    [false, false],
    ['true', false], // only an explicit boolean true earns the AI badge
    [undefined, false],
  ])('ai_generated_v2 = %p -> aiGenerated %p', async (flag, expected) => {
    await tags().insertOne({ author: 'alice', permlink: 'p', ai_generated_v2: flag, ai_generated_evidence_v2: ['voice'], ai_generated_checked_at: AT });
    const out = await getTranscriptionTags(db(), 'alice', 'p');
    expect(out.aiGenerated).toBe(expected);
    expect(out.aiGeneratedEvidence).toEqual(['voice']);
  });

  test('an empty v2 array means analysed with nothing confident; it wins over the string', async () => {
    await tags().insertOne({ author: 'alice', permlink: 'p', tags_list_v2: [], tags_v2: 'music', tag_model_v2: 'm2', unavailableOnTagging: true });
    const out = await getTranscriptionTags(db(), 'alice', 'p');
    expect(out.tagsV2).toEqual([]);
    expect(out.tagModelV2).toBe('m2');
    expect(out.unavailableOnTagging).toBe(true);
  });
});

describe('fetchTagsV2Batch', () => {
  test('one query for the batch, keyed author/permlink, empty lists left out', async () => {
    await tags().insertMany([
      { author: 'alice', permlink: 'a', tags_list_v2: ['music', '', null] },
      { author: 'bob', permlink: 'b', tags_v2: 'Gaming,Comedy' },
      { author: 'carol', permlink: 'c', tags_list_v2: [] },
    ]);
    const spy = jest.spyOn(db().collection('subtitles-tags').constructor.prototype, 'find');
    const map = await fetchTagsV2Batch(db(), [
      { author: 'Alice', permlink: 'a' }, { author: 'alice', permlink: 'a' }, { author: 'bob', permlink: 'b' },
      { author: 'carol', permlink: 'c' }, { author: 'dave', permlink: 'd' }, null, { author: 'x' },
    ]);
    expect(Object.fromEntries(map)).toEqual({ 'alice/a': ['music'], 'bob/b': ['gaming', 'comedy'] });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].$or).toHaveLength(4); // the duplicate alice/a asked once
  });

  test('no usable keys asks nothing', async () => {
    expect((await fetchTagsV2Batch(db(), [])).size).toBe(0);
    expect((await fetchTagsV2Batch(db(), undefined)).size).toBe(0);
  });
});

describe('fetchAiFlagsBatch', () => {
  beforeEach(async () => {
    await embeds().insertMany([
      { owner: 'alice', permlink: 'asset-1', hive_author: 'alice', hive_permlink: 'hive-1' },
      { owner: 'bob', permlink: 'asset-2', hive_author: 'bob', hive_permlink: 'hive-2' },
      { hive_author: 'eve', hive_permlink: 'broken' }, // no asset pair: ignored
    ]);
    await tags().insertMany([
      { author: 'alice', permlink: 'asset-1', ai_generated_v2: true },
      { author: 'bob', permlink: 'asset-2', ai_generated_v2: false },
      { author: 'carol', permlink: 'legacy', ai_generated_v2: true },
      { author: 'dave', permlink: 'unchecked' },
    ]);
  });

  test('a flagged video is reported under the spelling the caller used, by either pair', async () => {
    const out = await fetchAiFlagsBatch(db(), [
      { author: '@Alice', permlink: 'hive-1' },   // hive pair of an embed
      { author: 'alice', permlink: 'asset-1' },   // asset pair of the same embed (shorts rails)
      { author: 'bob', permlink: 'hive-2' },      // checked, not AI
      { author: 'carol', permlink: 'legacy' },    // legacy: hive pair == asset pair
      { author: 'dave', permlink: 'unchecked' },  // never checked: not AI
      { author: 'eve', permlink: 'broken' },
    ]);
    expect(out.sort()).toEqual(['alice/asset-1', 'alice/hive-1', 'carol/legacy']);
  });

  test('empty or junk keys ask nothing', async () => {
    expect(await fetchAiFlagsBatch(db(), [null, { author: ' ', permlink: 'x' }, { permlink: 'y' }])).toEqual([]);
    expect(await fetchAiFlagsBatch(db())).toEqual([]);
  });
});
