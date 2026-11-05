/**
 * Express 4 does not look at the promise an async route handler returns. When an
 * async handler throws outside its own try/catch, the rejection is never passed to
 * the error middleware: the request hangs, and on Node 15+ the unhandled rejection
 * ends the whole process. One malformed, unauthenticated request was enough to take
 * the checker down (a query like ?username[toString]=x makes String() throw).
 *
 * Requiring this module once, before the routes run, makes every handler's
 * rejected promise go to next(err) like a synchronous throw does (the same thing
 * Express 5 does natively). handleRouteError answers it as a JSON 500.
 */
const Layer = require('express/lib/router/layer');

if (!Layer.prototype.__asyncErrors) {
  const original = Layer.prototype.handle_request;
  Layer.prototype.handle_request = function handleRequest(req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) return original.call(this, req, res, next); // error middleware
    try {
      const out = fn(req, res, next);
      if (out && typeof out.then === 'function') out.then(undefined, (err) => next(err || new Error('Rejected without a reason')));
    } catch (err) {
      next(err);
    }
    return undefined;
  };
  Layer.prototype.__asyncErrors = true;
}

/** The last middleware: any error a route did not answer becomes a JSON 500. */
// eslint-disable-next-line no-unused-vars
function handleRouteError(err, req, res, next) {
  console.error(`[route] ${req.method} ${req.originalUrl.split('?')[0]} failed:`, err && err.stack ? err.stack : err);
  if (res.headersSent) return res.end();
  const status = err && Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  return res.status(status).json({ success: false, error: status === 500 ? 'internal error' : (err.expose && err.message) || 'request failed' });
}

module.exports = { handleRouteError };
