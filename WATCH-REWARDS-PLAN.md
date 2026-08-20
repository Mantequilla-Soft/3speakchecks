# Viewer watch-time rewards — plan (NOT built)

Status: **design only, deliberately parked.** Nothing here ships until the watch
data has been observed for a while under the honest-counting rules that landed
2026-08-20. Written 2026-08-20.

## The idea

A weekly pot split among viewers by honest watch time. "Get paid to watch" is
the one hook a Hive-native platform can offer that YouTube structurally cannot,
and it targets the hardest audience to move: someone who already has a video
site open.

## Why it is parked

Until 2026-08-20 watch time counted a tab you had switched away from. Any reward
attached to that number would have paid people for leaving a tab open, which is
both the cheapest possible farm and the worst possible signal. The gate now says:

- watch page, video under 20 minutes: hidden tab does not count
- watch page, video 20 minutes or longer: hidden tab still counts (podcasts and
  long talks are listened to that way on purpose)
- shorts: hidden tab does not count
- audio player: unchanged, background listening is the product

Before any money is attached we want to see, from real data:

1. How much total watch time the gate removed. A big drop means a lot of what we
   were measuring was never attention.
2. Whether the long-form exception is being used as a loophole. Watch the ratio
   of hidden-tab seconds on 20-minutes-plus videos per account. A normal listener
   and a parked tab look different across a week.
3. The per-account distribution. If the top accounts are already implausible
   before rewards exist, they will be worse after.

## Data we have

- `view-durations` on the player backend: watched seconds, percentage of
  duration, timeline bucket coverage, max position, average playback rate, per
  session, bound to the viewer IP and the video.
- Sessions are server-measured: `/api/watch/start` opens one and every
  `/api/watch/beat` credits only the wall-clock gap the server itself measures,
  capped at `MAX_BEAT_CREDIT_MS` (8s). A single forged request cannot claim a
  large span.
- The leaderboard aggregates `video_watch_secs` / `short_watch_secs` per window.

## What is missing

- **Sessions are keyed to an IP, not a Hive account.** Rewards need an account.
  `/api/watch/start` would have to accept a signed identity, and unauthenticated
  watching should keep working exactly as it does now, simply earning nothing.
- **No per-account daily totals.** The leaderboard aggregates per creator
  (whose videos were watched), not per viewer (who did the watching).
- **No payout rail.** Decide between a Hive transfer per period, a claim button,
  or points redeemable for something on-platform.

## Anti-abuse, if it is built

The rules matter more than the pot:

- Require a signed-in Hive account with a minimum age and reputation. New free
  accounts are the farm.
- Cap credit per video per account per day, and cap total daily credit. The cap
  is what makes farming unprofitable rather than merely detectable.
- Require timeline coverage, not just elapsed time: `coveredBuckets` already
  records which parts of the video were actually traversed. A session that sat
  at 0:03 for an hour covers one bucket and should earn nothing.
- Ignore self-watching (viewer is the uploader) and reciprocal rings (two
  accounts whose watch time is almost entirely each other's).
- Rate-limit by IP hash as a second axis, windowed, so one machine running ten
  accounts is visible.
- Publish the rules. A transparent cap is less attractive to farm than a secret
  one people probe.

## Suggested shape for v1

- Weekly, fixed pot, announced in advance.
- Split by *capped* watch seconds, not raw, so the tail earns something and the
  top cannot run away with it.
- A visible "eligible seconds this week" counter on the profile, so people can
  see the cap working rather than guessing why they earned less than they
  watched.
- Start small enough that farming it costs more than it returns.

## Open questions for the owner

- Where does the pot come from — Pro subscriptions, ad or promotion revenue, or
  a fixed treasury commitment?
- Should audio listening count? Background listening is legitimate there, which
  also makes it the easiest surface to farm.
- Is this per-viewer only, or does the creator whose video was watched share in
  it? The second version aligns incentives better but doubles the cost.
