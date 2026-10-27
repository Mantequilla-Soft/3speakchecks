/**
 * Author-controlled "hide from feeds" flag.
 *
 * A creator can set `hiddenFromFeed: true` on one of their videos (on `videos` or
 * `embed-video` — same field name on both). Such a video is dropped from EVERY
 * discovery / aggregation surface — home, trending, discover, interests, shorts,
 * search, the follow feed, tag feeds, related, first-uploads and the community
 * feeds — but is otherwise fully intact: the Hive post stands, the watch page still
 * resolves and plays, and it STILL appears on the author's own profile/channel
 * (`/api/my-videos`) for everyone who visits it.
 *
 * ── How this differs from the neighbours ─────────────────────────────────────────
 *  - `unavailable` (utils/unavailable.js): the media is GONE — hidden everywhere,
 *    including the profile, because the card would play nothing.
 *  - `listed_on_3speak: false` ("unlisted"): hidden from feeds AND from anyone else's
 *    view of the profile — only the OWNER sees it (badged) on their own channel.
 *  - `hiddenFromFeed: true`: hidden from feeds, but PUBLIC on the channel. "Don't
 *    push this into discovery, but keep it on my page." That public-on-profile part
 *    is what makes it distinct from unlisted — so the profile endpoint deliberately
 *    does NOT apply this filter.
 *
 * Env: HIDE_FROM_FEED_ENABLED (default true; set false to make the filter a no-op
 * everywhere without a code change).
 */
const HIDE_FROM_FEED_ENABLED =
  String(process.env.HIDE_FROM_FEED_ENABLED ?? 'true').toLowerCase() !== 'false';

/**
 * Mongo condition to spread into a feed query, exactly like unavailableMatch:
 *   { status: 'published', ...feedAgeMatch('created'), ...unavailableMatch(), ...hiddenFromFeedMatch() }
 * `$ne: true` (not `false`) so the overwhelming majority of docs — which have no
 * such field at all — still match. Returns {} when disabled, so it's always safe
 * to spread. The field name is identical on `videos` and `embed-video`, so no
 * per-collection field argument is needed (unlike feedAgeMatch).
 */
function hiddenFromFeedMatch() {
  return {
    ...(HIDE_FROM_FEED_ENABLED ? { hiddenFromFeed: { $ne: true } } : {}),
    ...liveStoryMatch(),
  };
}

/**
 * 24h stories (routes/stories.js) are shorts like any other while they are live,
 * so they show in the shorts feeds; once `story_expires_at` has passed they are
 * gone from 3Speak, so every feed that hides opted-out videos drops them too.
 * Only stories carry the field, and `$not: {$lte}` matches a missing one, so
 * every other doc passes. Not behind HIDE_FROM_FEED_ENABLED: expiry is not an
 * author preference that can be switched off.
 */
function liveStoryMatch() {
  return { story_expires_at: { $not: { $lte: new Date() } } };
}

/** In-memory twin of liveStoryMatch, for docs out of a cache that may be minutes old. */
function isExpiredStory(doc) {
  return !!doc && doc.story === true && !!doc.story_expires_at
    && new Date(doc.story_expires_at).getTime() <= Date.now();
}

/** In-memory equivalent, for filtering an already-fetched doc (e.g. in hydrate()). */
function isHiddenFromFeed(doc) {
  return (HIDE_FROM_FEED_ENABLED && !!doc && doc.hiddenFromFeed === true) || isExpiredStory(doc);
}

module.exports = { HIDE_FROM_FEED_ENABLED, hiddenFromFeedMatch, isHiddenFromFeed, isExpiredStory };
