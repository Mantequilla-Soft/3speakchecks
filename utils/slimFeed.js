/**
 * Strip card-irrelevant heavy fields from FEED LIST responses.
 *
 * A feed card renders title / thumbnail / author / duration / stats — it never
 * reads the post body. But we were serialising the ENTIRE post article for every
 * item: on a 50-item /feeds/trendingSorted response, `body` + `description` were
 * ~250KB of a 292KB payload (79%). Even after nginx's brotli that response was
 * 94KB; without those fields it's 9KB — a ~90% cut over the wire, and ~86% less
 * JSON to serialise.
 *
 * Safe because nothing downstream reads them from a feed: the watch page fetches
 * `body` from HIVE directly (condenser_api.get_content in lib/videoData.js), not
 * from the checker. Verified no card/feed component reads .body or .description.
 *
 * Done at res.json() time rather than as a Mongo projection so it covers every
 * feed route from ONE place and can't break a hand-tuned query. (A projection
 * would additionally cut Mongo→app transfer; the DB is local, so that's minor.)
 *
 * IMPORTANT: mount this ONLY on list routes. Single-video DETAIL routes
 * (/videodetails, /api/video) legitimately return a body — see server.js.
 */
const HEAVY_FIELDS = ['body', 'description', 'hive_body'];

// SHORTS are the exception: they render `hive_body` as the visible CAPTION under
// the video (see fetchShortsWithDetails → `caption: bodyToPlaintext(s.hive_body)`).
// Stripping it there blanks every short's description, so the shorts routes must
// keep it. `body`/`description` don't exist on shorts docs, so this is otherwise
// the same saving.
const SHORTS_HEAVY_FIELDS = ['body', 'description'];

// Response keys that hold an array of videos across the various feed shapes.
const LIST_KEYS = ['videos', 'items', 'results', 'shorts', 'trends', 'data'];

function slimVideo(v, fields) {
  if (!v || typeof v !== 'object') return v;
  let copy = null;
  for (const f of fields) {
    if (f in v) {
      copy = copy || { ...v };
      delete copy[f];
    }
  }
  return copy || v; // untouched objects are passed through by reference
}

/** Build the middleware for a specific set of fields to drop. */
function makeSlimFeed(fields = HEAVY_FIELDS) {
  return function slim(req, res, next) {
    const originalJson = res.json.bind(res);
    res.json = (payload) => {
      try {
        if (payload && typeof payload === 'object') {
          if (Array.isArray(payload)) {
            payload = payload.map((v) => slimVideo(v, fields));
          } else {
            for (const key of LIST_KEYS) {
              if (Array.isArray(payload[key])) {
                payload[key] = payload[key].map((v) => slimVideo(v, fields));
              }
            }
          }
        }
      } catch {
        /* never let slimming break a response */
      }
      return originalJson(payload);
    };
    next();
  };
}

const slimFeed = makeSlimFeed();

module.exports = { slimFeed, makeSlimFeed, HEAVY_FIELDS, SHORTS_HEAVY_FIELDS };
