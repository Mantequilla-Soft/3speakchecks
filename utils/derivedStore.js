/**
 * The "made from this" index (Mongo `derived-content`): one row per derived Hive
 * post, keyed by that post, pointing at the post it was made from. Written by
 * POST /derived/register (routes/derived.js) and scripts/backfill-derived.js,
 * both from the post's own Hive record (utils/derivedSource.js), so a row only
 * ever repeats what the derived post already says on chain.
 *
 *   { author, permlink,                   the derived post
 *     source_author, source_permlink,     what it was made from
 *     kind, start?, end?,                 how (utils/derivedSource.js KINDS)
 *     media, title, thumbnail, duration,  for the card
 *     expires_at?,                        a 24h Story's end (then it leaves the list)
 *     created, updated_at }
 */
const {
    derivedSourceOf, mediaOf, titleOf, thumbnailOf, durationOf, parseMeta,
} = require('./derivedSource');

const COLLECTION = 'derived-content';
const col = (db) => db.collection(COLLECTION);

let indexed = false;
async function ensureIndexes(db) {
    if (indexed) return;
    indexed = true;
    try {
        await col(db).createIndex({ author: 1, permlink: 1 }, { unique: true, name: 'derived_post' });
        await col(db).createIndex({ source_author: 1, source_permlink: 1, created: -1 }, { name: 'derived_by_source' });
    } catch (err) {
        indexed = false;
        console.error('[derived] index setup failed:', err && err.message);
    }
}

const STORY_TTL_MS = (parseFloat(process.env.STORY_TTL_HOURS) || 24) * 60 * 60 * 1000;
const isStory = (post) => parseMeta(post?.json_metadata)?.['3speak']?.story === true;

// Hive dates come without a zone and are UTC.
const hiveDate = (s) => {
    const d = new Date(/Z$|[+-]\d\d:?\d\d$/.test(s || '') ? s : `${s}Z`);
    return Number.isNaN(d.getTime()) ? new Date() : d;
};

/** The row for a get_content result, or null when the post names no source. */
function rowFor(post) {
    const source = derivedSourceOf(post);
    if (!source) return null;
    return {
        author: String(post.author).toLowerCase(),
        permlink: post.permlink,
        source_author: source.author,
        source_permlink: source.permlink,
        kind: source.kind,
        ...(source.start !== undefined ? { start: source.start } : {}),
        ...(source.end !== undefined ? { end: source.end } : {}),
        media: mediaOf(post),
        title: titleOf(post),
        thumbnail: thumbnailOf(post),
        duration: durationOf(post),
        created: hiveDate(post.created),
        // A 24h Story (a teaser) leaves the list when it expires (routes/stories.js TTL).
        ...(isStory(post) ? { expires_at: new Date(hiveDate(post.created).getTime() + STORY_TTL_MS) } : {}),
    };
}

/**
 * Writes (or drops) the row for `post`. Returns { row } when it names a source,
 * { removed: true } when it no longer does and had a row, else { row: null }.
 */
async function saveDerived(db, post) {
    await ensureIndexes(db);
    const row = rowFor(post);
    const key = { author: String(post.author).toLowerCase(), permlink: post.permlink };
    if (!row) {
        const r = await col(db).deleteOne(key);
        return r.deletedCount ? { removed: true, row: null } : { row: null };
    }
    // start/end/expires_at can go away on an edit: unset what the new row leaves out.
    const unset = {};
    for (const f of ['start', 'end', 'expires_at']) if (row[f] === undefined) unset[f] = '';
    await col(db).updateOne(key, {
        $set: { ...row, updated_at: new Date() },
        ...(Object.keys(unset).length ? { $unset: unset } : {}),
    }, { upsert: true });
    return { row };
}

/**
 * Rows made from source_author/source_permlink, newest first. `by` keeps one
 * creator's, `media` one kind of post; `order: 'start'` sorts by where in the
 * source each piece starts (then oldest first), for "Part 2 of 4" of the Shorts
 * a creator cut from one video or episode.
 */
async function listDerived(db, sourceAuthor, sourcePermlink, { limit = 24, exclude = [], by = null, media = null, order = 'new' } = {}) {
    await ensureIndexes(db);
    const match = {
        source_author: sourceAuthor,
        source_permlink: sourcePermlink,
        ...(by ? { author: by } : (exclude.length ? { author: { $nin: exclude } } : {})),
        ...(media ? { media } : {}),
        // Expired Stories out; everything else has no expires_at.
        expires_at: { $not: { $lte: new Date() } },
    };
    const [items, counts] = await Promise.all([
        col(db).find(match, { projection: { _id: 0, updated_at: 0 } }).sort({ created: -1 }).limit(limit).toArray(),
        col(db).aggregate([{ $match: match }, { $group: { _id: '$kind', n: { $sum: 1 } } }]).toArray(),
    ]);
    if (order === 'start') {
        const at = (r) => (Number.isFinite(r.start) ? r.start : Infinity);
        items.sort((a, b) => at(a) - at(b) || new Date(a.created) - new Date(b.created));
    }
    const byKind = {};
    let total = 0;
    for (const c of counts) { byKind[c._id] = c.n; total += c.n; }
    return { items, counts: byKind, total };
}

module.exports = { COLLECTION, ensureIndexes, rowFor, saveDerived, listDerived, _resetIndexed: () => { indexed = false; } };
