/**
 * The caller's address, for per-client throttles. Never stored, never returned.
 *
 * nginx is the only proxy in front of the checker (nginx/*.conf and the live
 * vhosts): it sets `X-Forwarded-For $proxy_add_x_forwarded_for`, which keeps
 * whatever the client sent and APPENDS the address nginx saw. So only the LAST
 * entry is trustworthy; the first one is whatever the client chose to send, and
 * keying on it let a client pick a fresh throttle key for every request.
 *
 * The header is only believed when the connection itself comes from this machine
 * (nginx). A request that reaches the port directly is keyed by its own socket
 * address, whatever headers it carries.
 *
 * Behind Cloudflare (prod-checker.okinoko.io) the address nginx saw is a Cloudflare
 * edge, so callers there share an edge's budget. The browser app posts reviews and
 * reports to checker.3speak.tv, which is not behind Cloudflare.
 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function socketAddress(req) {
  return (req.socket && req.socket.remoteAddress) || req.ip || '';
}

function clientIp(req) {
  const peer = socketAddress(req);
  if (!LOOPBACK.has(peer)) return peer;
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    const parts = xff.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return peer;
}

module.exports = { clientIp };
