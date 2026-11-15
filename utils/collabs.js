/**
 * Collab posts (routes/collabs.js): what the feeds need from the `collabs`
 * collection. One row per (post, collaborator):
 *
 *   _id           '<author>/<permlink>|<collaborator>'   (Hive author and permlink)
 *   author, permlink, collaborator, title, weight (beneficiary, 1/100 %)
 *   status        'pending' | 'accepted' | 'declined'
 *   created_at, responded_at
 *
 * Only ACCEPTED rows put a post on the collaborator's channel and in their
 * followers' feeds, and only they make a card say "badadib with x".
 */
const { COLLABS_COLLECTION } = require('./config');

const MAX_COLLABORATORS = 3;
const col = (db) => db.collection(COLLABS_COLLECTION);

let indexed = false;
async function ensureIndexes(db) {
  if (indexed) return;
  indexed = true;
  try {
    await col(db).createIndex({ collaborator: 1, status: 1, created_at: -1 });
    await col(db).createIndex({ author: 1, permlink: 1 });
  } catch (err) {
    indexed = false;
    console.error('[collabs] index setup failed:', err && err.message);
  }
}

/** Accepted collab posts of any of `accounts`: [{ author, permlink, collaborator }]. */
async function acceptedPostsOf(db, accounts, { since = null, limit = 500 } = {}) {
  const list = (accounts || []).filter(Boolean);
  if (!list.length) return [];
  const q = { collaborator: list.length === 1 ? list[0] : { $in: list }, status: 'accepted' };
  if (since) q.created_at = { $gte: since };
  return col(db).find(q, { projection: { author: 1, permlink: 1, collaborator: 1 } })
    .sort({ created_at: -1 }).limit(limit).toArray();
}

/** Map '<author>/<permlink>' -> [accepted collaborators], for the keys given. */
async function collaboratorsByKey(db, keys) {
  const pairs = [...new Set(keys)].map((k) => {
    const i = k.indexOf('/');
    return i > 0 ? { author: k.slice(0, i), permlink: k.slice(i + 1) } : null;
  }).filter(Boolean);
  const out = new Map();
  if (!pairs.length) return out;
  const rows = await col(db).find({ status: 'accepted', $or: pairs }, { projection: { author: 1, permlink: 1, collaborator: 1 } }).toArray();
  for (const r of rows) {
    const k = `${r.author}/${r.permlink}`;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r.collaborator);
  }
  for (const v of out.values()) v.sort();
  return out;
}

/** Stamp `collaborators: [...]` on list items that have accepted ones. Never throws. */
async function attachCollaborators(db, items, keyOf = (v) => `${v.author || v.owner}/${v.permlink}`) {
  if (!items || !items.length) return items;
  try {
    const map = await collaboratorsByKey(db, items.map(keyOf));
    if (map.size) for (const v of items) { const c = map.get(keyOf(v)); if (c) v.collaborators = c; }
  } catch (err) {
    console.error('[collabs] attach failed:', err && err.message);
  }
  return items;
}

module.exports = { MAX_COLLABORATORS, ensureIndexes, acceptedPostsOf, collaboratorsByKey, attachCollaborators };
