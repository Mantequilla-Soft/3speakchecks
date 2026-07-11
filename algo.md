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

---

---

# Discover feed (`GET /feeds/discover`)

An independent ranking whose job is to surface what the popularity signals bury —
and specifically to **keep giving old videos a shot**. It shares the retention
data above but **ignores votes, views and rewards entirely**.

Built by a background worker (`services/discover.js` → `discoverWorker.js`, hourly)
into `discover-pool`; served by `routes/feeds.js` + `utils/discoverPool.js`. The
math lives in `utils/discoverScore.js` (pure, no I/O).

## TLDR

```
base           = freshness × newBoost × reshareBoost × retention    (precomputed hourly)
discover_score = base × interest × jitter                           (per request)
```
then random picks from the lower half are interleaved into every 4th slot.

## The pool (rebuilt hourly)

A union of three sources, deduped by `owner/assetPermlink`:

| Source | What |
|---|---|
| `recent` | everything published in the last `DISCOVER_WINDOW_DAYS` (14) |
| `random` | `DISCOVER_RANDOM_OLD_COUNT` sampled from **all time** out of `subtitles-tags` (≥1 transcription tag). **Re-sampled every run** — this is the engine that bumps old videos |
| `retention` | anything with `view-durations` rows in the last `DISCOVER_RETENTION_ACTIVE_DAYS` (14) — i.e. people are still watching it |

The random sample is **oversampled ~2×**: roughly half of `subtitles-tags` points at
shorts / unlisted / deleted videos that no longer resolve to a published doc, so
2000 sampled ≈ 1000 that actually land. Live pool ≈ 1650 videos, oldest from 2019.

Critically the pool is **never cut by engagement** — unlike trending, whose
`base_score` cut happens before ranking, so a good video with few views can never
even enter its candidate set.

## The five factors

**1. freshness** — half-life decay, floored. Deliberately the **weakest** driver
(~1.77×): fresh uploads matter but must not dominate a discovery feed. It hits the
floor at ~3 days, after which a 4-day-old and a 4-year-old video are equal on age
and are separated only by quality, interest and reshares.
```
freshness = max(0.5 ^ (ageHours / DISCOVER_HALFLIFE_H), DISCOVER_FRESH_FLOOR)
```

**2. newBoost** — a modest lift for really fresh uploads so they get first traction
before any retention data exists. Tapers **linearly** to 1.0 across the grace
window (a hard cliff would drop a video ~43% the minute it crossed the boundary):
```
newBoost = 1 + (DISCOVER_NEW_BOOST − 1) · max(0, 1 − ageHours/DISCOVER_NEW_GRACE_H)
```

**3. reshareBoost** — a reshare is a real curation signal (someone put the video on
their own blog), but it IS a popularity signal, so it's log-damped and hard-capped:
```
reshareBoost = min(1 + W · ln(1 + n), CAP)     n=1 → 1.17, n=5 → 1.45, n=100 → 2.0
```

**4. retention** — `× clamp(1 + W·(relQ−1), MIN, MAX)` from the retention worker.
Here `W = 1.5`, **amplifying** the spread: `relQ` is compressed near 1.0 by the
Bayesian prior (live range ≈ 0.63–1.24), so at `W=1.0` retention would move a video
only ~2× — a rounding error next to the others. At 1.5 the spread is ≈0.44–1.37.
A video with no retention record gets exactly `×1` — never a penalty.

**5. interest** — `× DISCOVER_INTEREST_MULTIPLIER` (2.5, vs the global 2.0) when
the video's merged own+transcription tags match `?interests=`. Applied per request
(it's user-specific), against the `tags` array baked into each pool doc.

Plus **jitter** — seeded `× [1−J, 1+J]` (J = 0.15) so the row breathes between loads.

## Driver strength (the point of the tuning)

```
retention 3.1x  >  interest 2.5x  >  reshares 2.0x  >  freshness 1.77x
```
Freshness is intentionally last. A great old video **can** outrank a fresh one:
`OLD + match + retention 1.244 + 3 reshares = 2.99` beats `fresh 0h + match = 2.88`.

## Exploration slots

After sorting and hide-watched, `interleaveExploration()` takes every
`DISCOVER_EXPLORE_EVERY`-th (4th → 25% of the page) slot from a **seeded shuffle of
the lower half** of the ranking; the rest come from the top half in score order.
Every item appears exactly once — no dupes, no drops — so `total` and pagination
stay correct.

## Determinism

All randomness comes from `mulberry32(seed)`, where `seed` is `?seed=` or, as a
fallback, a 5-minute time bucket. Same seed → same ordering, which is what keeps
pagination stable (an unseeded shuffle would duplicate/skip videos between page 1
and 2). The response echoes `seed` so a client can pin it across pages.

**The frontend now always sends a seed** (`utils/feedSeed.js`): ONE value per page
load, shared by discover / interests / trending / shorts. It is deliberately module
state — it survives SPA navigation (so the order is stable as the user moves around
the app) and is regenerated only by a real browser refresh (or an explicit
pull-to-refresh). It is NOT sessionStorage, which would survive a reload and so
never change.

Before that, the feeds sent no seed at all and fell back to the 5-minute bucket,
which reshuffled the feed under the user every 5 minutes even if they never touched
anything. The bucket now only applies to callers that supply no seed.

## Performance

The pool (~1650 small docs) is held in-process behind a `DISCOVER_POOL_CACHE_MS`
TTL, and only the requested page is hydrated into full video docs. A request costs
one `watch_history` lookup + one hydration query — no aggregation, no Hive RPC.
Live: **~0.12s** vs trendingSorted's ~1.5s.

## Debugging

`?debug=1` preserves `discover_score`, `base`, `age_hours`, `freshness`,
`new_boost`, `reshare_boost`, `reshares`, `retention_mult`, `retention_relq`,
`interest_match` and `pool_src` in the response (stripped otherwise).

## Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `DISCOVER_ENABLED` | true | master switch for the pool worker |
| `DISCOVER_INTERVAL_MIN` | 60 | pool rebuild cadence |
| `DISCOVER_POOL_COLLECTION` | `discover-pool` | where the worker writes |
| `DISCOVER_POOL_CACHE_MS` | 300000 | in-process pool cache TTL |
| `DISCOVER_WINDOW_DAYS` | 14 | recent-source window |
| `DISCOVER_CANDIDATE_LIMIT` | 400 | per-collection cap on the recent source |
| `DISCOVER_RANDOM_OLD_COUNT` | 2000 | all-time random sample (≈1000 land) |
| `DISCOVER_RETENTION_ACTIVE_DAYS` | 14 | "still being watched" window |
| `DISCOVER_POOL_LIMIT` | 4000 | hard cap on pool size |
| `DISCOVER_HALFLIFE_H` | 72 | freshness half-life (hours) |
| `DISCOVER_FRESH_FLOOR` | 0.65 | minimum freshness (keeps old competitive) |
| `DISCOVER_NEW_GRACE_H` | 12 | "really fresh" window |
| `DISCOVER_NEW_BOOST` | 1.15 | lift at age 0, tapering to 1.0 |
| `DISCOVER_INTEREST_MULTIPLIER` | 2.5 | interest-match multiplier |
| `DISCOVER_RETENTION_WEIGHT` | 1.5 | amplifies the relQ spread |
| `DISCOVER_RETENTION_MIN_MULT` | 0.4 | retention lower bound |
| `DISCOVER_RETENTION_MAX_MULT` | 2.5 | retention upper bound |
| `DISCOVER_RESHARE_WEIGHT` | 0.25 | log-damped reshare weight |
| `DISCOVER_RESHARE_MAX_BOOST` | 2.0 | reshare cap |
| `DISCOVER_JITTER` | 0.15 | ±15% seeded per-video jitter |
| `DISCOVER_EXPLORE_EVERY` | 4 | every Nth slot = random pick (25%) |

---

# Age cutoff (`FEED_MAX_AGE_YEARS`)

A large share of very old legacy videos no longer resolve (dead thumbnail hosts,
unpinned/GC'd IPFS content), so surfacing them just renders broken cards. Every
feed therefore excludes anything older than `FEED_MAX_AGE_YEARS` (default **6**;
set to **0** to disable and serve the full archive).

- Helper: `utils/feedAge.js` → `feedAgeMatch(field)` returns a Mongo `$gte`
  condition (or `{}` when disabled), safe to spread into any query.
- Date fields differ per collection: legacy `videos` = `created`, `embed-video` =
  `createdAt`, `discover-pool` = `created`. All are BSON **Dates** — comparing
  against an ISO *string* silently matches zero documents.
- Applied in `utils/discoverPool.js` (the central one for discover / interests /
  trendingSorted / shortssorted) plus `routes/{feeds,videos,search,shorts}.js`.
- **The spread is injected FIRST in each query object, on purpose.** Several blocks
  carry a stricter explicit `created` window (7-day trending, 30-day community
  trending); placing the spread last would clobber those with the looser 6-year
  bound.
- Scope is **listings only**. A direct single-video lookup is deliberately NOT
  bounded, so an old video still plays if you open its link — it just isn't listed.

As of 2026-07: ~32k of ~387k legacy videos are >6y old; `embed-video` has none.

---

# Shorts (`GET /shortssorted`)

Same ranking ingredients as the video feeds (recency bucket + reward + reshares +
seeded random, then the retention re-rank), with two behaviours worth spelling out.

## `?onlyinterests=1` — the "My interests" feed

Discover *boosts* shorts whose winning topic is one of the caller's interests
(`INTEREST_MULTIPLIER`). `onlyinterests=1` instead **hard-filters** to them: a short
with no resolved winning topic cannot be matched to an interest and is excluded by
design. Retention still re-ranks whatever survives.

This feed is often short — a single topic simply doesn't have many recent shorts
(e.g. `art` alone yields ~8) — so the client falls back to Discover when the viewer
swipes past the last one.

## The already-watched filter is FROZEN into the cached list

This is a contract, not an implementation detail. `hidewatched` must **not** be
re-evaluated per request: the viewer watches shorts *as they swipe*, so a live
filter shrinks the list underneath them, and `skip = (page-1)*limit` then lands past
shorts they never saw. The feed "jumps over" a short, and swiping back shows that
skipped one instead of the real previous short.

So the watched filter is applied once, inside the cached computation, and the cache
key includes the user and their (now per-session) seed. The list a viewer pages
through therefore stays put: shorts watched in *earlier* sessions stay hidden, while
ones watched *right now* keep their slot, so back-swipe works.

Dismissals ("not interested" / hidden creator) stay **live** — they're an explicit
action that should apply immediately, and unlike watching they don't change while
the user is scrolling, so they remove the same items from every page (a constant
offset, not drift).

---

# Feed payloads (`utils/slimFeed.js`)

Not ranking, but it lives on the same routes. Feed cards never read the post body,
yet we serialised the entire article for every item — ~79% of a 50-item response
(292KB raw → 42KB; ~94KB → ~9KB compressed).

`slimFeed` strips `body` / `description` / `hive_body` at `res.json()` time. Two
traps:

- **Mount it on LIST routes only.** `/videodetails` and `/api/video` legitimately
  return a body, and the videos router is mounted at `/`.
- **Shorts keep `hive_body`** — it IS their visible caption, so stripping it blanks
  every short's description.

---

# Interests feed (`GET /feeds/interests`) — its own stratified pool

**Why it isn't just the discover feed with a filter.** It used to be
(`/feeds/discover?interestsOnly=1`), and that starved it. The discover pool is a
~2.7k **uniform** sample of a ~104k tagged catalogue, so its topic mix simply
mirrors the catalogue. Filtering that down to one topic left almost nothing —
`science` surfaced **29** of its 785 videos, i.e. a single page, and paging
produced no more. Growing the discover pool wouldn't fix it either: a uniform
sample scales every topic proportionally, so niche topics stay niche.

The `interest-pool` is **stratified**: the worker samples up to
`INTEREST_POOL_PER_TAG` (default 800) videos for **each** topic, so every topic has
depth regardless of how rare it is in the catalogue.

| topic | discover-pool (old) | interest-pool (new) |
|---|---|---|
| science | 29 → 1 page | 744 → 25 pages |
| health | 33 → 2 pages | 731 → 25 pages |
| art | 119 → 4 pages | 892 → 30 pages |
| music | 878 → 30 pages | 1589 → 53 pages |

Notes:

- The topic-sampled candidates are written with `src: 'topic'` and are deliberately
  **excluded from the discover pool**, so the discover feed's composition is exactly
  what it was.
- Only entries with a resolved `winnerTag` land in the interest pool — an untagged
  video can never match an interest, so it would be dead weight.
- `subtitles-tags.tags` is a single **normalised topic string** (not an array), so
  the per-topic `$match` is an exact equality.
- `tutorial` is not a transcription tag, so it gets no stratified sample; its
  entries come only from viewer tags. That's a real ceiling, not a bug.
- Request-time work is tiny: the pool is cached in-process, `base` already carries
  freshness × newBoost × reshareBoost × retention, and every candidate matches by
  definition — so there's no interest multiplier, just seeded jitter and the shared
  user filters (dismissals + hide-watched).

Config: `INTEREST_POOL_COLLECTION` (`interest-pool`), `INTEREST_POOL_PER_TAG` (800),
`INTEREST_POOL_LIMIT` (20000).
