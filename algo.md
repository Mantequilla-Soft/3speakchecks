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

To be fair about it, we do five sensible things:

1. **We measure real watching, not clicks.** Every video gets a score from how far
   people got through it — how much of it they watched, whether they finished,
   whether they made it past the intro, and whether any moments got rewatched.
2. **Watching half of something still counts.** Not finishing a video isn't the same
   as bouncing off it. A video that holds people to the halfway mark scores between
   a bounce and a finish, instead of being lumped in with the bounces.
3. **We compare like-for-like.** A 30-second clip will always be "watched to the
   end" more than a 25-minute documentary. So a video is only ever compared to
   **other videos of a similar length**, never across the board.
4. **Being watched can never hurt you.** Pushing a video *down* needs real evidence —
   several different viewers, and a score clearly below its peers. Until then the
   score can only lift it. Otherwise a video with one curious viewer would rank below
   a video nobody has ever opened, which is exactly backwards (and is precisely what
   the ranking used to do — see *Why a demotion needs evidence*).
5. **It only nudges, never takes over.** Retention *tilts* the existing ranking up
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
- `engagedRate` = fraction of sessions with `watchedPct ≥ RETENTION_ENGAGED_PCT` (default 30 — *watched a meaningful chunk*, see below)
- `hookRate` = fraction of sessions with `maxPosition / videoDuration ≥ RETENTION_HOOK_FRAC` (default 0.15 — got past the first 15%)
- `avgContentSeconds` = mean speed-corrected watch time
- `duration` = the video length

And from `view-heatmaps`:

- `replayIntensity` = `max(bucket) / mean(non-zero buckets)` — ~1.0 for a flat
  "watched once" curve, higher when specific moments are rewatched.

### Step 2 — raw quality ∈ [0, 1]

A weighted blend of the five normalized signals (weights renormalized to sum to 1):

```
raw = ( Wpct·(avgPct/100)
      + Wcompletion·completionRate
      + Wengaged·engagedRate
      + Whook·hookRate
      + Wreplay·clamp((replayIntensity − 1) / 2, 0, 1) ) / ΣW
```

Defaults: `Wpct=0.5, Wcompletion=0.3, Wengaged=0.25, Whook=0.2, Wreplay=0.1`.

#### Partial watch time is a signal, not a failed completion

`engagedRate` is the low bar (30%), and it exists because the high bar was throwing
away real evidence.

In an ideal world a half-watched video isn't "good", and we shouldn't pretend it is.
But 70% is a hard line, and on the live data the sessions landing between 30% and 70%
— **13% of all sessions** — counted for nothing except their contribution to `avgPct`.
The watch distribution is sharply bimodal (25% of sessions bounce under 5%, 32% finish
above 90%), so the middle is exactly where the *discriminating* evidence lives, and it
was the part we scored as a failure.

With a dataset this thin we would rather credit partial watch time as value than demand
a completion rate almost nothing clears. Laddering the two bars means a video that holds
people halfway scores *between* a bounce and a finish — which is precisely what it is.
A video people actually finish still beats it, because `completionRate` is still there
and still weighted higher.

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

**Upside** — ungated. A video people watch through is boosted from its first viewer:

```
mult = clamp( 1 + RETENTION_WEIGHT·(relQ − 1) , RETENTION_MIN_MULT , RETENTION_MAX_MULT )
```

Defaults: `WEIGHT=0.6`, `MIN_MULT=0.5`, `MAX_MULT=2`. So an average video (`relQ=1`)
is unchanged (`×1`) and a great one is boosted up to `×2`. Bounded on purpose —
retention **tilts** the ranking, it never dominates it.

**Downside** — gated on evidence. See below; this is the part that was wrong.

### Why a demotion needs evidence

The demotion side used to be the mirror image of the boost, and that quietly inverted
the whole signal.

`relQ` is `q` divided by the **mean `q` of its duration band** — and that mean is dragged
upward by the handful of genuinely great videos in the band. So *the typical video lands
a little under 1.0*. Meanwhile a video with **no watch data at all** gets a multiplier of
exactly `×1`, because we have nothing to say about it.

Put those together and the ranking said: **a video that one person watched to 90% ranks
below an identical video nobody has ever opened.** Having a little data was a net penalty.
Measured on the live table when this was found:

| | |
|---|---|
| scored videos | 1044 |
| demoted below `×1` | **650 (62%)** |
| …of which had ≤1 distinct viewer | **633** |
| videos with >30 viewers | 3 |

So the downside is now gated twice, and both gates only touch `relQ < 1`:

```
confidence = clamp( (viewers − PENALTY_MIN_VIEWERS) / (PENALTY_FULL_VIEWERS − PENALTY_MIN_VIEWERS), 0, 1 )
shortfall  = max( 0, (1 − relQ) − PENALTY_DEADBAND )
mult       = clamp( 1 − RETENTION_WEIGHT · confidence · shortfall, MIN_MULT, MAX_MULT )
```

- `PENALTY_MIN_VIEWERS` (3) is a **hard floor, not the start of a ramp**. At or below it,
  confidence is exactly `0` and retention can only *boost*. One person bouncing off a
  video is not a verdict. (A soft ramp from zero was tried first and still cost a
  badly-scoring 1-viewer video ~14% — the same inversion wearing a smaller hat.)
- `PENALTY_DEADBAND` (0.1) makes the noise band just under 1.0 free, so the ordinary
  below-the-band-mean video is left alone no matter how many viewers it has.
- An **unknown** viewer count never demotes: a caller that can't say how much evidence
  there is doesn't get to punish on it. (`viewers` is therefore projected alongside
  `score` everywhere the multiplier is used — `utils/retentionRank.js` and the pool worker.)

Replayed over the live table, discover-side (`W=1.5`):

| | old | new |
|---|---|---|
| demoted below ×1 | 674 (64.6%) | **20 (1.9%)** |
| boosted above ×1 | 364 | **364** *(untouched)* |
| rescued from an unjustified demotion | — | **654** |
| worst video with real evidence (relQ 0.415, 54 viewers) | ×0.400 | **×0.400** *(still floored)* |

A genuinely bad video with real viewers still sinks exactly as hard as it did. What stops
happening is punishing a video for the crime of having been watched once. As watch data
grows, more videos cross the evidence floor and the demotion machinery arms itself —
without anyone re-tuning it.

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
| `RETENTION_ENGAGED_PCT` | `30` | `watchedPct` ≥ this = "watched a meaningful chunk" |
| `RETENTION_BAYES_M` | `30` | prior strength (higher = more cautious) |
| `RETENTION_W_PCT / _COMPLETION / _ENGAGED / _HOOK / _REPLAY` | `0.5 / 0.3 / 0.25 / 0.2 / 0.1` | raw-quality weights |
| `RETENTION_WEIGHT` | `0.6` | how hard retention tilts a feed |
| `RETENTION_MIN_MULT / _MAX_MULT` | `0.5 / 2` | multiplier clamp |
| `RETENTION_PENALTY_MIN_VIEWERS` | `3` | at/below this many distinct viewers, retention can only BOOST |
| `RETENTION_PENALTY_FULL_VIEWERS` | `10` | full demotion weight from here up |
| `RETENTION_PENALTY_DEADBAND` | `0.1` | how far below `relQ=1` is free |
| `RETENTION_FOLLOW_HALFLIFE_H` | `168` | recency half-life for the follow feed |

Set `RETENTION_WEIGHT=0` (or `RETENTION_ENABLED=false`) to make the whole thing a
no-op instantly, without a code change. To disable **only** the demotion side, set
`RETENTION_PENALTY_MIN_VIEWERS` absurdly high — retention becomes boost-only.

---

# Curation signals — the manual votes (`utils/curation.js`)

Everything else in the ranking is either **passive** (views, watch time) or **on-chain**
(upvotes, rewards). These three are a person deliberately doing something about one video:

| Signal | The act | Source |
|---|---|---|
| `reshares` | put it on their own blog | `reshares` |
| `saves` | added it to a playlist / **Watch Later** | `playlists.items` |
| `tags` | labelled its topic alongside their upvote | `viewer-tags` |

These are **3Speak reshares, not Hive reblogs** — the `reshares` collection is written by
the playlists service when a user hits Reshare in the app.

All three are keyed by **Hive author/permlink**, and all three are **distinct-actor**
counts: adding one video to three of your own playlists is still one person caring.

```
curationBoost = min(CAP, 1 + Wr·ln(1+reshares) + Ws·ln(1+saves) + Wt·ln(1+tags))
```

At one of each: reshare +17%, save +21%, tag +14%; all three together ≈ +52%. Log-damped
and hard-capped because these signals are **sparse and high-precision** — live, only 226
videos carry any curation at all and the top distinct-actor count is **2**. A single act
must lift a video without letting one motivated person mint a #1 slot.

### Self-curation does not count — and this is load-bearing

An author resharing / saving / tagging their own video is not a signal, it's a lever.
Those rows are dropped in the aggregation, and that is not a nicety:

> **476** videos sit in some playlist. Only **15** sit in a playlist belonging to someone
> other than their author.

3Speak playlists are overwhelmingly creators collecting their *own* videos into albums and
series. Counting self-saves would have let any creator lift their entire back catalogue by
~21% by making one playlist of it. After the exclusion: 134 videos with a reshare, 87 with
a viewer tag, 15 with a save.

Watch Later needs no special case — it *is* a playlist (a private one named "Watch Later"),
and a global distinct-saver count is exactly what makes the signal count for **other**
viewers rather than only the person who saved it.

### Where it applies, and the double-counting trap

| Feed | How reshares are scored | Curation adds |
|---|---|---|
| Discover / Interests | inside `curationBoost` (all three) | reshares + saves + tags |
| Trending (`/feeds/trendingSorted`) | **additively**, `TRENDING_RESHARE_WEIGHT` | saves + tags only (`reshareWeight: 0`) |
| Shorts (`/shortssorted`) | **additively**, `RESHARE_WEIGHT` | saves + tags only (`reshareWeight: 0`) |

Trending and shorts already had a tuned additive reshare term. Folding reshares into their
multiplicative curation boost as well would pay twice for the same act, so the reshare
weight is explicitly zeroed there. Discover has no additive term, so it takes all three.

**All three feeds now read the reshare COUNT from the same curation map.** Trending and
shorts each used to run their own per-request `reshares` aggregation, which was redundant
(the map already holds the whole collection) and, worse, *semantically different*: it counted
**rows**, including an author's reshares of **their own** video — the exact lever the map's
self-exclusion exists to close. One source, one meaning. Two consequences worth knowing:

- **Self-reshares no longer buy trending score.** Videos whose reshares were their author's
  will lose that additive term.
- **Reshared legacy videos now count at all.** The old lookup silently dropped any candidate
  missing from the embed-permlink map (`.filter(Boolean)`), so a pure-legacy video — no embed
  doc — scored 0 reshares no matter how many people reshared it.

**Legacy playlists are not counted.** The old app wrote `playlists.list` as an array of
`videos._id` ObjectId refs — a schema nothing writes any more (951 historic items). Teaching
the ranking a second, differently-shaped join for a frozen signal isn't worth it; if those
saves are wanted, backfill them into `items`.

### Performance

The three collections are tiny, so the counts are built as **one small map held in-process**
behind `CURATION_CACHE_MS` — not a per-request lookup by candidate key. The bounded `$or`
version cost ~370ms per feed request against a map that fits in a few KB. A save taking up
to 5 minutes to count is fine: this is a ranking nudge, not a read-your-writes surface.
A broken pipeline degrades to *no boost*, leaving every feed exactly as it was.

| Var | Default | Meaning |
|---|---|---|
| `CURATION_ENABLED` | `true` | master switch |
| `CURATION_CACHE_MS` | `300000` | in-process count-map TTL |
| `CURATION_RESHARE_WEIGHT` | `0.25` | (was `DISCOVER_RESHARE_WEIGHT` — same value, so discover's tuning is unchanged) |
| `CURATION_SAVE_WEIGHT` | `0.3` | playlist / Watch Later saves |
| `CURATION_TAG_WEIGHT` | `0.2` | viewer tags |
| `CURATION_MAX_BOOST` | `2.5` | hard cap on the stacked boost |

---

# Follow boost (`utils/followBoost.js`)

Videos by creators you follow rank higher in **every** feed — discover, interests, trending,
shorts and the related rail — not just the dedicated follow feed (`/feed/:username`).

A follow is the strongest standing preference a viewer ever gives us, so it earns a real
multiplier (`FOLLOW_BOOST`, ×1.6). It is deliberately **below the interest multiplier**
(2.0 global / 2.5 discover): following someone means *"show me more of them"*, not *"show me
only them"*, and discover must not quietly collapse into a follow feed. It is a **boost**;
shorts' `?followedby=` remains the hard filter, and the two are independent.

Matched on the **Hive author**, which is who the viewer actually follows — an embed's `owner`
is the asset uploader and is not always the same account. (The pool worker now stores `author`
on every pool doc for exactly this.)

### It never blocks the request

The following list comes from Hive (`condenser_api.get_following`) and is cached in-process
for 10 minutes. Discover answers in ~0.12s; a cold Hive RPC can take longer than the entire
request, and Hive nodes go down. So a cache **miss** does not stall the feed — it returns
"no boost" for that one request and warms the set in the background. The client loads several
rows per page, so the next request already has it. A **stale** set is served while it refreshes.

Live check — real follow lists against the 2913-entry discover pool:

| user | following | in the pool | entries lifted ×1.6 |
|---|---|---|---|
| taskmaster4450le | 82 | 11 | 27 |
| starkerz | 296 | 16 | 50 |
| theycallmedan | 485 | 66 | 188 |

⚠️ **The shorts sort cache is keyed per user because of this.** `/shortssorted` freezes its
ranked list into a cache; now that the ranking contains a per-user boost, that key carries
`user:<currentuser>` on its own rather than folded into the hide-watched segment — a caller
with `hidewatched=0` still gets a follow-boosted list, and that list is still theirs alone.

### `?currentuser=` is untrusted — two guards

That query param is unauthenticated and now sits on the hottest routes in the API, where a
cache miss fires a paged Hive RPC and allocates a Set of up to several thousand usernames.
So `getFollowSet()`:

1. **rejects anything that isn't a possible Hive account name** before touching the network,
   so nobody can point us at our own RPC nodes with garbage; and
2. holds the sets in an **LRU capped at `FOLLOW_BOOST_MAX_USERS`** — an uncapped map would be
   an unauthenticated memory leak (loop over random usernames, watch RSS climb).

Touching an entry reorders the LRU but deliberately does **not** reset its TTL clock, or a
continuously-active user's follow set would never be refreshed.

| Var | Default | Meaning |
|---|---|---|
| `FOLLOW_BOOST` | `1.6` | multiplier for a followed creator's video (`1` = off) |
| `FOLLOW_BOOST_TTL_MS` | `600000` | follow-set cache TTL |
| `FOLLOW_BOOST_MAX_USERS` | `5000` | LRU cap on cached follow sets |

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
base           = freshness × newBoost × curationBoost × retention   (precomputed hourly)
discover_score = base × interest × follow × jitter                  (per request)
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

**1. freshness** — half-life decay, floored. Still the **weakest** driver (~2.68×):
fresh uploads matter but must not dominate a discovery feed. It hits the floor at
~3.7 days, after which a 4-day-old and a 4-year-old video are equal on age and are
separated only by quality, interest and reshares.
```
freshness = max(0.5 ^ (ageHours / DISCOVER_HALFLIFE_H), DISCOVER_FRESH_FLOOR)
```
The FLOOR *is* the fresh-vs-old spread: `1 / FLOOR`. It was raised from 0.65 (1.54×)
to **0.43 (2.33×)** — a 1.5× stronger recency bias — because the top of discover was
carrying too many years-old videos. Measured over the top 24 across 3 seeds: videos
older than a year went **22% → 13%**, under-30-days **72% → 79%**.

**2. newBoost** — a modest lift for really fresh uploads so they get first traction
before any retention data exists. Tapers **linearly** to 1.0 across the grace
window (a hard cliff would drop a video ~43% the minute it crossed the boundary):
```
newBoost = 1 + (DISCOVER_NEW_BOOST − 1) · max(0, 1 − ageHours/DISCOVER_NEW_GRACE_H)
```

**3. curationBoost** — the manual votes: reshares + playlist/Watch-Later saves + viewer
tags, log-damped and hard-capped. Real curation signals, but popularity ones, so they lift
and never run away. See *Curation signals* above; reshares kept their previous weight, so
this factor is a superset of the old `reshareBoost` rather than a retune of it.
```
curationBoost = min(CAP, 1 + Wr·ln(1+reshares) + Ws·ln(1+saves) + Wt·ln(1+tags))
```

**4. retention** — `× clamp(1 + W·(relQ−1), MIN, MAX)` from the retention worker.
Here `W = 1.5`, **amplifying** the spread: `relQ` is compressed near 1.0 by the
Bayesian prior (live range ≈ 0.63–1.24), so at `W=1.0` retention would move a video
only ~2× — a rounding error next to the others. At 1.5 the spread is ≈0.44–1.37.
A video with no retention record gets exactly `×1` — never a penalty.

**5. interest** — `× DISCOVER_INTEREST_MULTIPLIER` (2.5, vs the global 2.0) when
the video's merged own+transcription tags match `?interests=`. Applied per request
(it's user-specific), against the `tags` array baked into each pool doc.

**6. follow** — `× FOLLOW_BOOST` (1.6) when the video's Hive author is one the caller
follows. Per request; see *Follow boost* above.

Plus **jitter** — seeded `× [1−J, 1+J]` (J = 0.15) so the row breathes between loads.

## Driver strength (the point of the tuning)

```
retention 3.1x  >  freshness 2.68x  >  interest 2.5x  ≈  curation 2.5x  >  follow 1.6x
```
Freshness is no longer last, but it is still below retention — a great old video
**can** outrank a fresh one, which is the whole point of a discovery feed. Follow sits
lowest on purpose: it tilts discover toward people you already read without turning it
into a second follow feed.

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
`new_boost`, `curation_boost`, `reshares`, `saves`, `viewer_tags`, `follow_match`,
`retention_mult`, `retention_relq`, `retention_viewers`, `interest_match` and
`pool_src` in the response (stripped otherwise).

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
| `DISCOVER_FRESH_FLOOR` | 0.43 | minimum freshness. `1/FLOOR` = the fresh-vs-old spread |
| `DISCOVER_NEW_GRACE_H` | 12 | "really fresh" window |
| `DISCOVER_NEW_BOOST` | 1.15 | lift at age 0, tapering to 1.0 |
| `DISCOVER_INTEREST_MULTIPLIER` | 2.5 | interest-match multiplier |
| `DISCOVER_RETENTION_WEIGHT` | 1.5 | amplifies the relQ spread |
| `DISCOVER_RETENTION_MIN_MULT` | 0.4 | retention lower bound |
| `DISCOVER_RETENTION_MAX_MULT` | 2.5 | retention upper bound |
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

## Dead videos: the `unavailable` shadow-ban

A video whose media is gone is worse than no video — it takes a feed slot and plays
nothing. When the frontend hits a hard 404 on a manifest (a card's hover preload, or
a fatal player error on the watch page) it POSTs `/video/report-unavailable`. A
confirmed-dead video gets `unavailable: true` on its source doc and is excluded from
**every** feed — the filter `unavailableMatch()` is spread at exactly the same ~35
query sites as `feedAgeMatch()`. The post and the watch page still work; it just
stops being recommended.

**The client report is a HINT, never a verdict.** 3Speak migrates content off the hot
IPFS zone (`hotipfs-3speak-1`) after a while, so a perfectly healthy old video 404s
there while `ipfs.3speak.tv` still serves it. Banning on a single-gateway 404 would
silently gut the archive, and nobody would notice until it was too late. So the
server re-checks the manifest **itself, across every gateway**, and bans only when
all of them return a definite 404. A timeout / 5xx / connection error is NOT evidence
of absence — a gateway being down is not the video being gone — so anything
inconclusive aborts the ban.

The CID is read from OUR doc, never from the client's `url` (kept only as a
diagnostic), so a caller cannot point us at an unrelated 404 to ban someone. The
worst a malicious client can do is make us re-check a healthy video and conclude it
is fine. Reports are collapsed to one real check per video per hour.

On ban we also evict the video from `discover-pool` / `interest-pool`, which are
rebuilt on a cron and would otherwise keep serving it until the next rebuild.

Audit trail: the `video-unavailable` collection records the cid, the per-gateway
verdicts, who reported it and when. `GET /video/unavailable-stats` returns the count.

## `?topic=<tag>` — recommended shorts on the watch page

The watch page interleaves a shorts rail into its recommendation list, and asks for
shorts about the same thing as the video being watched. It does **not** cost an extra
lookup: `/feeds/related` already returns `currentTopic` (the winning topic it resolved
for that video), and the client passes it straight back as `?topic=`.

This is a **boost** (`RELATED_TOPIC_MULT`, ×3.0 — the same constant `/feeds/related`
uses for videos), never a filter. A narrow topic has very few shorts, and a hard
filter would leave the rail empty or half-full; a partly-relevant rail beats no rail.
Measured at `limit=12`: `topic=music` returns 7/12 on-topic vs 1/12 unweighted, and
`topic=gaming` — a thin topic — still returns a **full** rail with 2/12 on-topic
rather than collapsing.

`winner_tag` is carried through the sort cache onto each short in the response, so the
resolved topic is visible to the client (and to `?debug`).

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
