/**
 * Playlist type (video / audio) and audio kind (utils/playlistType.js): what the
 * owner chose, read from the indexer's top-level fields and json_metadata in the
 * encodings it is stored in.
 */
const { Binary } = require('mongodb');
const { categoryToKind, kindFromCategories, storedPlaylistType } = require('../../utils/playlistType');

// The site sends json_metadata as a JSON string; the indexer keeps those bytes.
const jm = (obj) => new Binary(Buffer.from(JSON.stringify(JSON.stringify(obj))));

describe('categoryToKind / kindFromCategories', () => {
  test.each([
    ['song', 'music'], ['music', 'music'], ['voice_message', 'voice'],
    ['podcast', 'podcast'], ['interview', 'podcast'], ['audiobook', 'podcast'], [undefined, 'sounds'],
  ])('%s is %s', (category, kind) => {
    expect(categoryToKind(category)).toBe(kind);
  });

  test('most common kind wins, ties go to the earlier kind', () => {
    expect(kindFromCategories(['song', 'song', 'podcast'])).toBe('music');
    expect(kindFromCategories(['song', 'podcast'])).toBe('podcast');
    expect(kindFromCategories([])).toBeNull();
  });
});

describe('storedPlaylistType', () => {
  test('the indexer default `video` alone is no choice', () => {
    expect(storedPlaylistType({ type: 'video' })).toEqual({ type: null, kind: null });
    expect(storedPlaylistType({ type: 'video', json_metadata: jm({ tags: ['x'] }) })).toEqual({ type: null, kind: null });
  });

  test('top-level audio and kind', () => {
    expect(storedPlaylistType({ type: 'audio', audio_kind: 'music' })).toEqual({ type: 'audio', kind: 'music' });
    expect(storedPlaylistType({ type: 'video', audio_kind: 'voice' })).toEqual({ type: 'audio', kind: 'voice' });
  });

  test('json_metadata as the indexer stores it', () => {
    expect(storedPlaylistType({ type: 'video', json_metadata: jm({ type: 'audio', album: {} }) })).toEqual({ type: 'audio', kind: null });
    expect(storedPlaylistType({ type: 'video', json_metadata: jm({ type: 'video' }) })).toEqual({ type: 'video', kind: null });
    expect(storedPlaylistType({ json_metadata: jm({ type: 'audio', audio_kind: 'sounds' }) })).toEqual({ type: 'audio', kind: 'sounds' });
  });

  test('an unknown kind is ignored', () => {
    expect(storedPlaylistType({ type: 'audio', audio_kind: 'opera' })).toEqual({ type: 'audio', kind: null });
  });
});
