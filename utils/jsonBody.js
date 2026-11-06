/**
 * The app-wide JSON body parser (express.json() at its default 100 kB limit).
 *
 * A few routes take larger bodies and mount their own express.json({ limit })
 * for it. A global parser that runs first answers 413 before the route's own
 * parser is reached (once a body is parsed, later parsers skip it), so those
 * routes never got their limit: captions of a long video, for one, could not be
 * saved. The global parser leaves exactly these routes to their own parser.
 */
const express = require('express');

// POST paths (as mounted in server.js) whose router parses its own, larger body.
const OWN_PARSER = new Set([
  '/subtitles/edit',          // routes/subtitleEdit.js, 2 MB
  '/scheduled-posts/create',  // routes/scheduledPosts.js, 2 MB
  '/podcasts/subscribe',      // routes/podcasts.js, 256 kB
]);

const defaultJson = express.json();

function jsonBody(req, res, next) {
  if (req.method === 'POST' && OWN_PARSER.has(req.path)) return next();
  return defaultJson(req, res, next);
}

module.exports = { jsonBody, OWN_PARSER };
