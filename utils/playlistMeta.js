/**
 * Playlist `metadata` arrives from the indexer as BSON Binary, a Buffer, raw
 * JSON or base64-encoded JSON depending on which client wrote it. Albums keep
 * their extras under `.album` (thumbnail, description, credits, label, ...).
 */
function decodePlaylistMeta(m) {
    try {
        if (!m) return null;
        if (typeof m === 'object' && m._bsontype === 'Binary') return JSON.parse(m.buffer.toString('utf8'));
        if (Buffer.isBuffer(m)) return JSON.parse(m.toString('utf8'));
        if (typeof m === 'string') {
            // Could be raw JSON or base64-encoded JSON.
            try { return JSON.parse(m); } catch { return JSON.parse(Buffer.from(m, 'base64').toString('utf8')); }
        }
        if (typeof m === 'object') return m;
    } catch { /* ignore */ }
    return null;
}

module.exports = { decodePlaylistMeta };
