/**
 * Guards that keep the suite away from anything real. Shared by globalSetup, the
 * per-file environment and the database helper.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

const isLoopback = (host) => {
  const h = String(host || '').toLowerCase();
  return LOOPBACK.has(h) || h.startsWith('127.');
};

function hostsOf(uri) {
  const m = String(uri).match(/^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/);
  if (!m) throw new Error('TEST_MONGODB_URI is not a mongodb:// address');
  if (uri.startsWith('mongodb+srv://')) throw new Error('mongodb+srv:// is a hosted cluster; the tests only run against a local mongod');
  return m[1].split(',').map((hp) => hp.replace(/:\d+$/, ''));
}

function assertLocalMongo(uri) {
  const bad = hostsOf(uri).filter((h) => !isLoopback(h));
  if (bad.length) {
    throw new Error(`Refusing to run the tests against a non-local MongoDB (${bad.join(', ')}). They drop databases.`);
  }
}

// Test databases are named checker_test_<worker>; anything else is not ours to drop.
const TEST_DB_PREFIX = 'checker_test_';
function assertTestDbName(name) {
  if (!String(name).startsWith(TEST_DB_PREFIX)) {
    throw new Error(`Refusing to touch database "${name}": test databases start with ${TEST_DB_PREFIX}`);
  }
}

module.exports = { isLoopback, assertLocalMongo, assertTestDbName, TEST_DB_PREFIX };
