# Retention Ranking

How 3Speak turns **how much people actually watch** into a ranking signal that
feeds into the discovery feeds — alongside the interests a user picks and their
watch history.

---

## TL;DR (the simple version)

Every few minutes a background job looks at how people watched each video and
gives it a **quality score**. The idea is dead simple:

> **Videos that people actually watch through get shown more. Videos people click
> off get shown less.**

To be fair about it, we do four sensible things:

1. **We measure real watching, not clicks.** Every video gets a score from how far
   people got through it — how much of it they watched, whether they finished,
   whether they made it past the intro, and whether any moments got rewatched.
2. **We compare like-for-like.** A 30-second clip will always be "watched to the
   end" more than a 25-minute documentary. So a video is only ever compared to
   **other videos of a similar length**, never across the board.
3. **We don't trust tiny numbers.** One person watching one video to 100% doesn't
   make it great. A video needs a decent number of **different viewers** before we
   trust its score; until then it sits at "average" and rides the normal signals.
4. **It only nudges, never takes over.** Retention *tilts* the existing ranking up
   or down within sensible limits — it doesn't throw away views, votes, freshness
   or the interests you picked.

The result is one number per video, ~**1.0 = average for its length**, higher =
better. Feeds multiply their existing score by it (capped), so good-retention
videos rise and click-bait sinks — gradually and safely.

It runs **every 5 minutes in a separate thread** so it never slows down the site,
and it reads from a small **pre-computed table** so feeds stay fast.

---

## The full version (the calculation)

### What we track (per watch session)

The player writes one row per viewing session into `view-durations` (server-measured,
HMAC-bound, so watch time can't be forged), plus a per-video `view-heatmaps`
aggregate:

| Field | Meaning |
|---|---|
| `watchedPct` | **Unique** % of the timeline actually seen (replays don't inflate it; skips don't count it) |
| `maxPosition` | Furthest point reached (drop-off / did they get past the intro) |
| `contentSeconds` | Seconds of content consumed, **speed-corrected** (2× playback still counts real content) |
| `videoDuration` | Length of the video |
| `ip` | Used only to count **distinct viewers** (confidence), never shown |
| `updatedAt` | Row age — old rows age out (see *Retention window*) |
| `buckets[]` (heatmaps) | Per-position coverage → the "most replayed" curve |

### Step 1 — per-video aggregate (`view-durations` → Mongo aggregation)

Grouping by `owner/permlink` (dropping junk sessions shorter than
`RETENTION_MIN_SESSION_SECONDS`):

- `viewers` = count of **distinct IPs** (not sessions)
- `avgPct` = mean `watchedPct`
- `completionRate` = fraction of sessions with `watchedPct ≥ RETENTION_COMPLETION_PCT` (default 70)
- `hookRate` = fraction of sessions with `maxPosition / videoDuration ≥ RETENTION_HOOK_FRAC` (default 0.15 — got past the first 15%)
- `avgContentSeconds` = mean speed-corrected watch time
- `duration` = the video length

And from `view-heatmaps`:

- `replayIntensity` = `max(bucket) / mean(non-zero buckets)` — ~1.0 for a flat
  "watched once" curve, higher when specific moments are rewatched.

### Step 2 — raw quality ∈ [0, 1]

A weighted blend of the four normalized signals (weights renormalized to sum to 1):

```
raw = ( Wpct·(avgPct/100)
      + Wcompletion·completionRate
      + Whook·hookRate
      + Wreplay·clamp((replayIntensity − 1) / 2, 0, 1) ) / (Wpct+Wcompletion+Whook+Wreplay)
```

Defaults: `Wpct=0.5, Wcompletion=0.3, Whook=0.2, Wreplay=0.1`.

### Step 3 — Bayesian shrinkage (confidence)

With few viewers we don't trust `raw`, so we pull it toward the **global mean `C`**
(the average `raw` across all videos this run). `M` is the prior strength
(`RETENTION_BAYES_M`, default 30 ≈ "worth ~30 viewers of doubt"):

```
q = (viewers·raw + M·C) / (viewers + M)
```

A brand-new video (viewers→0) ⇒ `q ≈ C` ⇒ neutral. A video with thousands of
viewers ⇒ `q ≈ raw`. This is the classic *"how not to sort by average rating"* fix
and it doubles as **cold-start handling**: low-data videos are neither buried nor
boosted.

### Step 4 — length normalization

Retention % is heavily length-biased, so we only compare within a **duration band**:

| Band | Length |
|---|---|
| `xs` | < 1 min |
| `s` | 1–5 min |
| `m` | 5–20 min |
| `l` | 20–60 min |
| `xl` | 60 min+ |

We compute the mean `q` per band, then:

```
relQ = clamp( q / bandMean_q , 0.2 , 3 )
```

`relQ ≈ 1.0` means "typical for a video of this length"; `> 1` better, `< 1` worse.
**`relQ` is the stored score** (`video-retention.score`).

### Step 5 — the bounded feed multiplier

Feeds multiply their existing score by:

```
mult = clamp( 1 + RETENTION_WEIGHT·(relQ − 1) , RETENTION_MIN_MULT , RETENTION_MAX_MULT )
```

Defaults: `WEIGHT=0.6`, `MIN_MULT=0.5`, `MAX_MULT=2`. So an average video (`relQ=1`)
is unchanged (`×1`); a great one is boosted up to `×2`; a poor one damped to `×0.5`.
Bounded on purpose — retention **tilts** the ranking, it never dominates it.

### Where it's applied

The multiplier is folded into every feed that already uses **interests and/or
watch-history** — retention is the shared quality layer on top of them:

| Feed | Route | Existing signal | Retention applied to |
|---|---|---|---|
| Home / Trending | `GET /feeds/trendingSorted` | views·votes·comments·reward·reshares × interests | `trending_score` |
| Shorts | `GET /shortssorted` | recency·reward·reshares·random × interests | `sort_score` |
| Follow feed | `GET /feed/:username` | recency (chronological) + hide-watched | recency-decayed `_rankScore` (recency stays dominant via `RETENTION_FOLLOW_HALFLIFE_H`) |

At request time this is a single **indexed `_id: {$in}` lookup** into the
pre-computed `video-retention` table — no aggregation on the hot path. If a video
has no record yet (or the table is empty), its multiplier is exactly `1`, so feeds
are unchanged. Fully backwards compatible.

### Performance

- The whole aggregation + scoring runs in a **worker thread** (`services/retentionWorker.js`)
  with its own Mongo connection, so it never blocks the event loop serving users.
- It runs **every `RETENTION_INTERVAL_MIN` minutes** (default **5**), overlap-guarded.
- Results are cached in `video-retention` (`_id = owner/permlink`), read by feeds
  with one indexed batch lookup.

### Retention window & row aging

The watch-retention cleanup deletes individual `view-durations` **rows** once the
**row itself** is older than `WATCH_RETENTION_DAYS` (default 90) — not by the
video's post date. So an old video that gets watched again keeps its fresh rows and
**re-enters the ranking**; only stale watch data ages out. The scorer likewise only
looks at rows within `RETENTION_WINDOW_DAYS`, so the score always reflects *recent*
behaviour.

### Anti-gaming

- Watch time is **server-measured** (HMAC session token bound to `sid.owner.permlink.ip`,
  per-beat wall-clock credit capped) — it can't be forged in a single request.
- Confidence counts **distinct IPs**, not sessions, so hammering from one machine
  doesn't move the score.
- Junk/1-beat sessions (`contentSeconds < RETENTION_MIN_SESSION_SECONDS`) are dropped.
- Bayesian shrinkage means a handful of planted views barely move `q`.

### Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `RETENTION_ENABLED` | `true` | master switch |
| `RETENTION_INTERVAL_MIN` | `5` | how often the worker runs |
| `RETENTION_WINDOW_DAYS` | `90` | how far back the scorer looks |
| `RETENTION_MIN_SESSION_SECONDS` | `2` | drop junk sessions below this |
| `RETENTION_COMPLETION_PCT` | `70` | `watchedPct` ≥ this = "finished" |
| `RETENTION_HOOK_FRAC` | `0.15` | got past this fraction = "hooked" |
| `RETENTION_BAYES_M` | `30` | prior strength (higher = more cautious) |
| `RETENTION_W_PCT / _COMPLETION / _HOOK / _REPLAY` | `0.5 / 0.3 / 0.2 / 0.1` | raw-quality weights |
| `RETENTION_WEIGHT` | `0.6` | how hard retention tilts a feed |
| `RETENTION_MIN_MULT / _MAX_MULT` | `0.5 / 2` | multiplier clamp |
| `RETENTION_FOLLOW_HALFLIFE_H` | `168` | recency half-life for the follow feed |

Set `RETENTION_WEIGHT=0` (or `RETENTION_ENABLED=false`) to make the whole thing a
no-op instantly, without a code change.

### Future extensions (not built yet)

- **Interest-conditioned retention** — a video's retention *among users who picked
  that interest*, so interest feeds reward "actually satisfies fans of X", not just
  "tagged X".
- **Per-user affinity** — "you finish this creator's videos" → boost them for you.
- **Creator reputation** — a channel's average retention helps its brand-new
  uploads (which have no data yet) beat the cold-start.
- **Exploration slots** — reserve a fraction of feed positions for under-measured
  videos so ranking doesn't calcify around whatever surfaced first.
- **CTR / impressions** — deliberately *not* used: 3Speak content is embedded on
  other Hive frontends we can't measure impressions on, so a click-through rate
  computed only from our own surface would be misleading.
