/**
 * The real app database layer (utils/db.js) against this worker's throwaway
 * MongoDB. Use it for anything that queries or aggregates: a hand-written fake
 * cannot tell you whether a pipeline actually works.
 *
 *   const testDb = require('./helpers/db');
 *   const db = testDb.use();          // in a describe or at file top level
 *   test('...', async () => { await db().collection('x').insertOne({}) });
 *
 * use() connects once per file through connectToMongo (so the app's own indexes are
 * built, exactly like on boot), empties every collection before each test, and drops
 * the database after the file. Every drop is refused unless the database is a
 * checker_test_* one on a local mongod (tests/setup/safety.js).
 */
const { MongoClient } = require('mongodb');
const { assertLocalMongo, assertTestDbName } = require('../setup/safety');

let client;
let database;

async function open() {
  if (database) return database;
  const { MONGODB_URI, DATABASE_NAME } = require('../../utils/config');
  assertLocalMongo(MONGODB_URI);
  assertTestDbName(DATABASE_NAME);
  client = new MongoClient(MONGODB_URI);
  await client.connect();
  database = client.db(DATABASE_NAME);
  await database.dropDatabase(); // whatever an earlier file on this worker left
  await require('../../utils/db').connectToMongo();
  return database;
}

async function clear() {
  if (!database) return;
  const cols = await database.listCollections({}, { nameOnly: true }).toArray();
  await Promise.all(cols
    .filter((c) => !c.name.startsWith('system.'))
    .map((c) => database.collection(c.name).deleteMany({})));
}

async function close() {
  if (!database) return;
  assertTestDbName(database.databaseName);
  await require('../../utils/db').closeMongo();
  await database.dropDatabase();
  await client.close();
  database = undefined;
  client = undefined;
}

/** Wire the database into the current file. Returns a getter for the Db. */
function use({ clearEach = true } = {}) {
  beforeAll(open, 60000);
  if (clearEach) beforeEach(clear);
  afterAll(close);
  return () => database;
}

module.exports = { use, open, clear, close };
