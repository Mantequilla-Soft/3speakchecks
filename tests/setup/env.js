/**
 * Runs before every test file (jest setupFiles), before any app code is loaded.
 *
 * 1. The real `.env` is never read: utils/config.js calls dotenv, which is stubbed
 *    here, and every secret-, key- or endpoint-like variable inherited from the shell
 *    is dropped. A checkout that has a production `.env` next to it (the live box)
 *    therefore runs the tests exactly like a clean clone.
 * 2. Outbound network is refused. Only loopback (the test MongoDB, local stub
 *    servers started by a test) and Unix sockets can be reached, so no test can
 *    reach Hive, Butter Auth, a payment gateway or a webhook, even by mistake.
 * 3. The app points at this worker's own throwaway database (checker_test_<n>).
 */
const net = require('net');
const tls = require('tls');
const { isLoopback, TEST_DB_PREFIX } = require('./safety');

jest.mock('dotenv', () => ({ config: () => ({ parsed: {} }) }));

const REAL_LOOKING = /(KEY|SECRET|WIF|PASS|TOKEN|_URI$|_URL$|_URLS$|HOST$|HOSTS$|WEBHOOK|ENDPOINTS$)/;
for (const name of Object.keys(process.env)) {
  if (name.startsWith('__CHECKER_TEST_')) continue;
  if (REAL_LOOKING.test(name)) delete process.env[name];
}

Object.assign(process.env, {
  NODE_ENV: 'test',
  MONGODB_URI: process.env.__CHECKER_TEST_MONGO_URI || 'mongodb://127.0.0.1:1',
  DATABASE_NAME: `${TEST_DB_PREFIX}${process.env.JEST_WORKER_ID || '1'}`,
  // Known values, so tests can authenticate on purpose.
  API_SECRET_KEY: 'test-api-secret',
  PULSE_API_KEY: 'test-pulse-key',
  AD_ADMIN_SECRET: 'test-ad-admin-secret',
  GDPR_ADMIN_SECRET: 'test-gdpr-admin-secret',
  PUSH_ADMIN_KEY: 'test-push-admin-key',
  STREAM_STATS_SECRET: 'test-stream-stats-secret',
  LISTEN_BEAT_KEY: 'test-listen-beat-key',
  IP_HASH_SECRET: 'test-ip-hash-secret',
  PODCAST_ART_SECRET: 'test-podcast-art-secret',
  UPLOAD_SECRET_TOKEN: 'test-upload-token',
  // Anything that would talk to Hive goes to a closed local port and fails fast.
  HIVE_RPC_ENDPOINTS: 'http://127.0.0.1:9',
});

// ── outbound network guard ────────────────────────────────────────────────────
function targetOf(args) {
  const [a, b] = args;
  if (a && typeof a === 'object') return a.path ? null : (a.host || a.hostname || 'localhost');
  if (typeof a === 'string' && Number.isNaN(Number(a))) return null; // Unix socket path
  return typeof b === 'string' ? b : 'localhost';
}

function guard(original, label) {
  if (original.__testGuard) return original; // core modules are shared by the files of one worker
  const guarded = function guarded(...args) {
    const host = targetOf(args);
    if (host !== null && !isLoopback(host)) {
      throw new Error(`[tests] blocked outbound ${label} connection to "${host}". Stub the call (jest.mock / a local stub server) instead.`);
    }
    return original.apply(this, args);
  };
  guarded.__testGuard = true;
  return guarded;
}

net.connect = guard(net.connect, 'net');
net.createConnection = guard(net.createConnection, 'net');
tls.connect = guard(tls.connect, 'tls');
