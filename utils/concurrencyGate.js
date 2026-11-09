/**
 * Caps how many requests of one kind run at the same time.
 *
 * Built for the podcast feeds (routes/rss.js): each feed is several MongoDB reads,
 * and podcast-index crawlers ask for thousands of different feeds a minute (all
 * 3Speak channels, one after the other). With nothing in the way they took every
 * connection in the shared Mongo pool, and EVERY other checker request (home
 * feeds, the Spotlight) queued behind them until MongoWaitQueueTimeoutError.
 *
 * `max` requests run; up to `maxQueue` more wait for a free slot (in arrival
 * order) for at most `queueTimeoutMs`. Anything beyond that gets 503 with
 * Retry-After, which feed crawlers honour. A slot is given back when the
 * response finishes OR the client goes away, exactly once.
 */
function createConcurrencyGate({ max, maxQueue, queueTimeoutMs, retryAfterSec = 30, name = 'gate' }) {
  let running = 0;
  const waiting = [];   // { grant, timer }

  const reject = (res, why) => {
    if (res.headersSent) return;
    res.setHeader('Retry-After', String(retryAfterSec));
    res.status(503).type('text/plain').send(`Busy (${name}: ${why}), try again later`);
  };

  const release = () => {
    const next = waiting.shift();
    if (next) {
      clearTimeout(next.timer);
      next.grant();            // the slot passes straight on: `running` stays the same
    } else {
      running -= 1;
    }
  };

  const middleware = (req, res, next) => {
    const start = () => {
      let done = false;
      const free = () => { if (!done) { done = true; release(); } };
      res.once('finish', free);
      res.once('close', free);
      next();
    };

    if (running < max) {
      running += 1;
      return start();
    }
    if (waiting.length >= maxQueue) return reject(res, 'queue full');

    const entry = { grant: start, timer: null };
    entry.timer = setTimeout(() => {
      const at = waiting.indexOf(entry);
      if (at !== -1) waiting.splice(at, 1);
      reject(res, 'waited too long');
    }, queueTimeoutMs);
    // A client that leaves while still waiting gives up its place in the queue.
    res.once('close', () => {
      const at = waiting.indexOf(entry);
      if (at !== -1) { waiting.splice(at, 1); clearTimeout(entry.timer); }
    });
    waiting.push(entry);
    return undefined;
  };

  middleware.stats = () => ({ running, waiting: waiting.length });
  return middleware;
}

module.exports = { createConcurrencyGate };
