const { clientIp } = require('../utils/clientIp');

const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });

describe('clientIp', () => {
  test('behind nginx the last forwarded entry (the address nginx saw) is the caller', () => {
    expect(clientIp(req('127.0.0.1', { 'x-forwarded-for': '198.51.100.1, 203.0.113.7' }))).toBe('203.0.113.7');
    expect(clientIp(req('::1', { 'x-forwarded-for': '203.0.113.7' }))).toBe('203.0.113.7');
    expect(clientIp(req('::ffff:127.0.0.1', { 'x-forwarded-for': ' 203.0.113.8 ,' }))).toBe('203.0.113.8');
  });

  test('a connection that does not come from this machine is keyed by its own address', () => {
    expect(clientIp(req('192.0.2.5', { 'x-forwarded-for': '203.0.113.7' }))).toBe('192.0.2.5');
  });

  test('without a usable header the socket address is the key', () => {
    expect(clientIp(req('127.0.0.1'))).toBe('127.0.0.1');
    expect(clientIp(req('127.0.0.1', { 'x-forwarded-for': ' , ' }))).toBe('127.0.0.1');
    expect(clientIp(req('127.0.0.1', { 'x-forwarded-for': ['a', 'b'] }))).toBe('127.0.0.1');
    expect(clientIp({ headers: {}, ip: '192.0.2.9' })).toBe('192.0.2.9');
    expect(clientIp({ headers: {} })).toBe('');
  });
});
