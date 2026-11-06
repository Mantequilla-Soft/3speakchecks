/**
 * One throwaway MongoDB for the whole run.
 *
 * TEST_MONGODB_URI points the suite at a database you started yourself (CI uses a
 * service container). Without it, mongodb-memory-server starts a private mongod on
 * a random local port. Either way the address must be on this machine: the suite
 * drops databases, so it refuses to run against anything else.
 */
const { MongoMemoryServer } = require('mongodb-memory-server');
const { assertLocalMongo } = require('./safety');

module.exports = async function globalSetup() {
  let uri = process.env.TEST_MONGODB_URI;
  if (!uri) {
    const server = await MongoMemoryServer.create({ binary: { version: process.env.TEST_MONGODB_VERSION || '7.0.24' } });
    globalThis.__CHECKER_MONGOD__ = server;
    uri = server.getUri();
  }
  assertLocalMongo(uri);
  process.env.__CHECKER_TEST_MONGO_URI = uri;
};
