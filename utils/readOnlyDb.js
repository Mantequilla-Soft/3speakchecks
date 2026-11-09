/**
 * A database handle that can read but never write: every write is RECORDED and
 * answered as if it worked, and nothing reaches MongoDB.
 *
 * For asking "what would this job do?" against live data, scripts/emulate-payout.cjs
 * first of all. That script used to run the real settlement on the real database and
 * then undo what it wrote, which is only as safe as the undo list is complete. It was
 * not: settlement also stamps `payoutId` on viewer and listener rows, the undo never
 * restored those, and one run against production would have marked real people's
 * watching settled without paying them. Restoring by delete-and-reinsert also raced
 * the real payout job. A handle that cannot write makes both mistakes impossible.
 *
 * 🚨 READS ARE AN ALLOW-LIST. Anything not listed below throws, so a write method
 * this file does not know about (or a new one added to the driver) fails loudly
 * instead of quietly reaching production.
 *
 * ⚠️ A read never sees the recorded writes. Settlement does not read back what it
 * wrote within a run, so this does not change its answer; code that does would need
 * an overlay, not this.
 */
const READS = new Set([
  'find', 'findOne', 'countDocuments', 'estimatedDocumentCount', 'distinct', 'aggregate',
  'indexes', 'listIndexes', 'indexExists', 'indexInformation',
]);
// Answered like the driver would, so callers carry on. Never forwarded.
const WRITES = {
  insertOne: () => ({ acknowledged: true, insertedId: null }),
  insertMany: (docs) => ({ acknowledged: true, insertedCount: Array.isArray(docs) ? docs.length : 0, insertedIds: {} }),
  updateOne: () => ({ acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 }),
  updateMany: () => ({ acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 }),
  replaceOne: () => ({ acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 }),
  deleteOne: () => ({ acknowledged: true, deletedCount: 0 }),
  deleteMany: () => ({ acknowledged: true, deletedCount: 0 }),
  bulkWrite: () => ({ acknowledged: true }),
  findOneAndUpdate: () => null,
  findOneAndReplace: () => null,
  findOneAndDelete: () => null,
  createIndex: () => 'not-created',
  createIndexes: () => [],
  dropIndex: () => ({ ok: 1 }),
  dropIndexes: () => ({ ok: 1 }),
  drop: () => true,
  rename: () => null,
};

/**
 * Wrap a driver `Db`. Returns `{ db, writes }`: `db` to hand to the code under
 * test, `writes` the list of what it tried, as `{ collection, op, args }`.
 */
function readOnlyDb(realDb) {
  const writes = [];
  const collection = (name, ...rest) => {
    const real = realDb.collection(name, ...rest);
    return new Proxy(real, {
      get(target, prop) {
        if (typeof prop !== 'string') return target[prop];
        if (prop === 'collectionName' || prop === 'namespace' || prop === 'dbName') return target[prop];
        if (READS.has(prop)) return (...args) => target[prop](...args);
        if (Object.prototype.hasOwnProperty.call(WRITES, prop)) {
          return async (...args) => {
            writes.push({ collection: name, op: prop, args });
            return WRITES[prop](...args);
          };
        }
        throw new Error(`readOnlyDb: ${name}.${prop}() is not a known read, refused`);
      },
    });
  };
  const db = new Proxy(realDb, {
    get(target, prop) {
      if (prop === 'collection') return collection;
      if (prop === 'databaseName') return target.databaseName;
      throw new Error(`readOnlyDb: db.${String(prop)} is not allowed`);
    },
  });
  return { db, writes };
}

module.exports = { readOnlyDb };
