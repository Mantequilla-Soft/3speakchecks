/**
 * The safety rails of the suite itself (tests/setup): if one of these fails, no
 * other result can be trusted, because a test might have touched something real.
 */
const { assertLocalMongo, assertTestDbName, isLoopback } = require('../setup/safety');

describe('the test environment', () => {
  test('never inherits a real secret: known test values only', () => {
    expect(process.env.API_SECRET_KEY).toBe('test-api-secret');
    expect(process.env.AD_PAYOUT_ACTIVE_KEY).toBeUndefined();
    expect(process.env.THREESPEAK_POSTING_KEY).toBeUndefined();
    expect(process.env.HAFSQL_PASSWORD).toBeUndefined();
    expect(process.env.BUTRAUTH_CLIENT_SECRET).toBeUndefined();
  });

  test('loads no .env: the config sees the test database, not the real one', () => {
    const cfg = require('../../utils/config');
    expect(cfg.DATABASE_NAME).toMatch(/^checker_test_\d+$/);
    assertLocalMongo(cfg.MONGODB_URI);
  });

  test('refuses outbound connections to anything but this machine', async () => {
    await expect(fetch('https://api.hive.blog')).rejects.toThrow();
    const net = require('net');
    expect(() => net.connect(443, 'example.com')).toThrow(/blocked outbound/);
    expect(() => require('tls').connect({ host: 'api.hive.blog', port: 443 })).toThrow(/blocked outbound/);
  });

  test('still allows loopback, for the test database and local stub servers', async () => {
    const http = require('http');
    const server = http.createServer((_req, res) => res.end('ok')).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
      expect(await res.text()).toBe('ok');
    } finally {
      server.close();
    }
  });
});

describe('safety helpers', () => {
  test('a remote or hosted MongoDB is refused', () => {
    expect(() => assertLocalMongo('mongodb://db.example.com:27017')).toThrow(/non-local/);
    expect(() => assertLocalMongo('mongodb://127.0.0.1:1,10.0.0.5:27017/?replicaSet=rs')).toThrow(/10\.0\.0\.5/);
    expect(() => assertLocalMongo('mongodb+srv://cluster.example.net')).toThrow(/hosted/);
    expect(() => assertLocalMongo('mongodb://user:pw@localhost:27017/db')).not.toThrow();
  });

  test('only checker_test_* databases may be dropped', () => {
    expect(() => assertTestDbName('threespeak')).toThrow();
    expect(() => assertTestDbName('checker_test_3')).not.toThrow();
  });

  test('loopback detection', () => {
    for (const h of ['localhost', '127.0.0.1', '127.0.1.1', '::1']) expect(isLoopback(h)).toBe(true);
    for (const h of ['10.0.0.1', 'api.hive.blog', '', undefined]) expect(isLoopback(h)).toBe(false);
  });
});
