/**
 * Global age bound for feed content.
 *
 * A large share of very old legacy videos no longer resolve (dead thumbnail hosts,
 * unpinned/garbage-collected IPFS content), so surfacing them in feeds just shows
 * broken cards. We exclude anything older than FEED_MAX_AGE_YEARS from the feeds.
 *
 * Env: FEED_MAX_AGE_YEARS  (default 6; set to 0 — or anything <= 0 — to DISABLE
 * the cutoff entirely and go back to serving the full archive).
 *
 * The cutoff is computed per call, so it's a rolling window — a long-running
 * process never holds a stale boundary.
 *
 * Date fields differ per collection: legacy `videos` uses `created`, `embed-video`
 * uses `createdAt`, and the precomputed `discover-pool` uses `created`. All three
 * are stored as BSON Dates, so a Date comparison is correct for each.
 */
const FEED_MAX_AGE_YEARS = Number(
  process.env.FEED_MAX_AGE_YEARS !== undefined ? process.env.FEED_MAX_AGE_YEARS : 6
);

/** The oldest `created` date still allowed in a feed, or null when disabled. */
function feedAgeCutoff() {
  if (!Number.isFinite(FEED_MAX_AGE_YEARS) || FEED_MAX_AGE_YEARS <= 0) return null;
  const d = new Date();
  d.setFullYear(d.getFullYear() - FEED_MAX_AGE_YEARS);
  return d;
}

/**
 * Mongo condition to spread into a feed query, e.g.
 *   { status: 'published', ...feedAgeMatch('created') }
 * Returns {} when the cutoff is disabled, so it's always safe to spread.
 */
function feedAgeMatch(field = 'created') {
  const cutoff = feedAgeCutoff();
  return cutoff ? { [field]: { $gte: cutoff } } : {};
}

/** In-memory equivalent, for filtering already-fetched docs. */
function withinFeedAge(created) {
  const cutoff = feedAgeCutoff();
  if (!cutoff) return true;
  const t = created ? new Date(created).getTime() : NaN;
  return Number.isNaN(t) ? true : t >= cutoff.getTime(); // undated → keep
}

module.exports = { FEED_MAX_AGE_YEARS, feedAgeCutoff, feedAgeMatch, withinFeedAge };
