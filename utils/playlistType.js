/**
 * What a playlist is: `video` or `audio`, and for audio one of AUDIO_KINDS.
 * Mirrors 3speak.tv src/lib/playlistType.js.
 *
 * The playlists indexer keeps a top-level `type` and `audio_kind`, but every
 * playlist made before owners could pick a type was stored as `video` by
 * default, so a top-level `video` alone says nothing. The site also writes the
 * choice into `json_metadata.type` / `.audio_kind`; only those, or a top-level
 * `audio` / `audio_kind`, count as the owner's choice. With none, callers work
 * it out from the items.
 */
const { decodePlaylistMeta } = require('./playlistMeta');

const AUDIO_KINDS = ['podcast', 'music', 'voice', 'sounds'];
const isKind = (k) => AUDIO_KINDS.includes(k);

/** An audio upload's category as a playlist kind. */
function categoryToKind(category) {
    switch (category) {
        case 'song':
        case 'music':
            return 'music';
        case 'voice_message':
        case 'voice':
            return 'voice';
        case 'podcast':
        case 'interview':
        case 'audiobook':
            return 'podcast';
        default:
            return 'sounds';
    }
}

/** The most common kind among audio categories (ties to the earlier kind), or null. */
function kindFromCategories(categories) {
    const counts = new Map();
    for (const c of categories) {
        const k = categoryToKind(c);
        counts.set(k, (counts.get(k) || 0) + 1);
    }
    let best = null;
    for (const k of AUDIO_KINDS) {
        if ((counts.get(k) || 0) > (best ? counts.get(best) : 0)) best = k;
    }
    return best;
}

/** json_metadata as an object: the site sends it as a JSON string, which the indexer stores encoded once more. */
function decodeJsonMeta(m) {
    let v = decodePlaylistMeta(m);
    if (typeof v === 'string') {
        try { v = JSON.parse(v); } catch { return {}; }
    }
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

/** The type and kind the owner chose, or nulls when they never chose one. */
function storedPlaylistType(playlist) {
    if (!playlist) return { type: null, kind: null };
    const jm = decodeJsonMeta(playlist.json_metadata);
    const kind = isKind(playlist.audio_kind) ? playlist.audio_kind : isKind(jm.audio_kind) ? jm.audio_kind : null;
    let type = null;
    if (jm.type === 'video' || jm.type === 'audio') type = jm.type;
    else if (playlist.type === 'audio' || kind) type = 'audio';
    return { type, kind: type === 'audio' ? kind : null };
}

module.exports = { AUDIO_KINDS, categoryToKind, kindFromCategories, decodeJsonMeta, storedPlaylistType };
