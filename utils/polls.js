/**
 * Polls on community snaps. A poll IS a snap (routes/snaps.js): the snap's body
 * is the question, and the author's signed json_metadata carries
 *
 *   poll: { options: ['Yes', 'No', ...], ends_at: '<ISO date>' | null }
 *
 * 2 to 4 options of at most 80 characters, distinct; an optional end at most
 * POLL_MAX_DAYS after the post. Anything else and the snap is a plain snap.
 * Read from OUR chain fetch, so nobody can attach a poll to someone else's snap.
 */
const POLL_MIN_OPTIONS = 2;
const POLL_MAX_OPTIONS = 4;
const POLL_OPTION_MAX_LEN = 80;
const POLL_MAX_DAYS = 30;

function parsePoll(meta, created = new Date()) {
  const p = meta && meta.poll;
  if (!p || typeof p !== 'object' || !Array.isArray(p.options)) return null;
  const options = p.options
    .map((o) => (typeof o === 'string' ? o.replace(/\s+/g, ' ').trim().slice(0, POLL_OPTION_MAX_LEN) : ''))
    .filter(Boolean);
  if (options.length < POLL_MIN_OPTIONS || options.length > POLL_MAX_OPTIONS) return null;
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) return null;
  let endsAt = null;
  if (p.ends_at) {
    const d = new Date(p.ends_at);
    const start = new Date(created).getTime();
    if (Number.isFinite(d.getTime()) && d.getTime() > start && d.getTime() <= start + POLL_MAX_DAYS * 86400000) endsAt = d;
  }
  return { options, ends_at: endsAt };
}

const isClosed = (poll, now = Date.now()) => !!(poll && poll.ends_at && new Date(poll.ends_at).getTime() <= now);

module.exports = { parsePoll, isClosed, POLL_MIN_OPTIONS, POLL_MAX_OPTIONS, POLL_OPTION_MAX_LEN, POLL_MAX_DAYS };
