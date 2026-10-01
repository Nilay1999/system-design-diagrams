# Leaderboard & Top-K

> Two closely related questions: **"What is my exact rank among 50 M players, right now?"** (a game leaderboard) and **"What are the top 10 trending songs/hashtags/videos in the last hour?"** (heavy hitters at huge scale).

## The problem in one minute

Both problems are about ranking, but at very different shapes:

- **Leaderboard:** a moderate number of updates (hundreds to thousands per second), but every player wants an **exact** answer to "what's my rank?" A SQL `COUNT(*) WHERE score > mine` scans millions of rows per request. A **sorted set** (Redis) answers rank and range queries in O(log n), and 50 M members fit in a few GB of memory.
- **Trending top-K:** millions of events per second across millions of distinct items, but nobody can tell if the #7 song's count is off by 0.1 %. Exact counting per item would need huge state; instead use a **streaming approximation** (Count-Min Sketch + a heap) and correct it later with an exact batch job.

| Decision | Leaderboard | Trending |
| --- | --- | --- |
| Accuracy | Exact | Approximate, corrected hourly |
| Core structure | Redis sorted set (skip list + hash) | Count-Min Sketch + min-heap per window |
| Source of truth | Durable score history DB | Raw event archive |
| Update path | Score service writes DB + `ZADD GT` | Kafka → Flink windows → merge |
| Read path | `ZREVRANK`, `ZREVRANGE`; top-100 cached for 1 s | Precomputed top-K per window and region |
| Scaling past one node | Shard by score range (or by user + scatter-gather) | Partition by item; merge partial top-Ks |

## Requirements

### Functional

- Submit a score for a user in a game/season/contest.
- Get the **top N** (e.g. top 100).
- Get a **user's rank** and the players around them (±5).
- Time-bounded boards: daily, weekly, season; friends-only boards.
- **Trending:** top K items by count over sliding windows (last 5 minutes, 1 hour, 24 hours), per region.

### Non-functional

| Property | Leaderboard | Trending |
| --- | --- | --- |
| Freshness | Updates visible within ~1 s | A few seconds to a minute stale |
| Latency | p99 < 50 ms for rank queries | p99 < 50 ms (precomputed) |
| Accuracy | Exact | Approximate is fine |
| Scale | 50 M players/season, ~600 updates/s (10× at events) | 1–10 M events/s, millions of distinct items |
| Integrity | Resist cheating | Resist manipulation (bots) |

## Capacity estimation

**Leaderboard**

- 5 M daily players × 10 games/day = 50 M scores/day ≈ **600 updates/s**, bursts of ~6k/s during events.
- Sorted set memory: ~50 M members × (member string ~10 B + score 8 B + skip-list and hash overhead ~60–80 B) ≈ **4–5 GB** — one Redis node (with a replica).
- Reads: if 5 M players check the board ~5 times a day, ~300 reads/s average, much higher at events. The top-100 is the same for everyone → cache it.

**Trending**

- 1–10 M events/s. Exact counts for 50 M distinct items per window = 50 M counters per window × many windows → too much state and too much sorting.
- A Count-Min Sketch with ε = 0.001, δ = 0.01 needs ~14k counters (**~55 KB**) per window per partition, regardless of item count.

## API

```http
POST /v1/scores
{ "match_id": "m-8842", "user_id": "123", "board": "season42", "score": 1850, "signature": "…" }
→ 202 Accepted

GET /v1/leaderboards/season42/top?limit=100
GET /v1/leaderboards/season42/users/123?around=5
→ { "rank": 48212, "score": 1850, "neighbours": [ { "rank": 48207, "user": "…", "score": 1852 }, … ] }

GET /v1/leaderboards/season42/friends/123

GET /v1/trending?window=1h&region=IN&limit=10
→ { "items": [ { "id": "song-77", "count": 412300, "approx": true } ], "as_of": "…" }
```

## Data model

```text
-- durable (leaderboard truth)
scores       (match_id PK, user_id, board, score, achieved_at, accepted, reason)
best_scores  (board, user_id) PK, best_score, achieved_at        -- optional materialised view

-- Redis
lb:season42              ZSET  member = user id, score = composite (see ties)
lb:daily:2026-09-27      ZSET  with EXPIRE after 2 days
lb:weekly:2026-W39       ZSET
top:season42             cached JSON of the top 100, refreshed every second

-- trending
trending:{window}:{region}   list of (item_id, approx_count), overwritten each minute
```

## Part 1: real-time leaderboard

See [Leaderboard architecture](#diagram/architecture).

### Why not SQL?

`SELECT COUNT(*) FROM scores WHERE score > :mine` has to count every row above you — for a mid-ranked player, millions of rows per request, under constant updates. Indexes make top-N cheap but not arbitrary ranks. You could maintain rank counters, but every score change shifts the rank of thousands of players.

### Redis sorted sets

A sorted set combines a **skip list** (ordered by score, with span counts so rank can be computed while walking) and a **hash map** (member → score). Both updates and rank queries are **O(log n)**.

```text
ZADD      lb:season42 GT 1850 user:123       # only update if the new score is greater
ZREVRANGE lb:season42 0 99 WITHSCORES        # top 100
ZREVRANK  lb:season42 user:123               # my rank, 0-based
ZREVRANGE lb:season42 48206 48216 WITHSCORES # players around me
ZCOUNT    lb:season42 1850 +inf              # how many at or above a score
```

### Submitting and reading

See [Submit & read](#diagram/flows).

1. The **game server** (not the client — clients can't be trusted) reports the match result, signed.
2. The score service verifies the signature, checks sanity bounds (a score impossible for the match length), rate-limits per user, and deduplicates by `match_id`.
3. It inserts the score into the durable history, then `ZADD GT` into the season, daily and weekly sets in one pipeline.
4. Reads go to the leaderboard service: `ZREVRANK` for my rank, `ZREVRANGE` for my neighbours.
5. The top-100 is computed once per second and served from memory or even a CDN.

### Ties

Two players with 1,850 points: who ranks higher? Usually the one who got there first. Encode a tiebreaker into the sorted-set score:

```text
composite = score × 10¹⁰ + (MAX_TS − achieved_at_seconds)
```

Redis scores are 64-bit floats with 53 bits of exact integer precision (~9 × 10¹⁵), so check the range: scores up to ~900,000 with a 10¹⁰ multiplier fit. For larger scores, use a smaller time resolution or store ties in a secondary structure.

### Time-bounded and friends boards

- One key per period (`lb:daily:2026-09-27`) with `EXPIRE`. Update the season, weekly and daily keys on every score, or build weekly from dailies with `ZUNIONSTORE … AGGREGATE MAX`.
- **Friends boards:** a player has ~100–500 friends. Fetch friends' scores with `ZMSCORE` from the season set and sort in the service — no extra sorted set needed.

### Durability and rebuild

Redis persistence (AOF/RDB) plus a replica covers most failures. If the sorted set is lost anyway, a rebuild job replays the best score per user from the history DB with bulk `ZADD`s — 50 M members take minutes. Because every accepted score is in the database first, nothing is lost.

### Scaling beyond one Redis node

See [Sharding ranks](#diagram/sharding). One Redis sorted set comfortably handles ~100 M members and tens of thousands of ops/s. Beyond that:

- **Shard by score range** (e.g. ≥ 2,000 / 1,000–1,999 / < 1,000). A global rank = rank inside my shard + the total size of all higher shards (kept in a small counter table or computed with `ZCARD`). Top-N only touches the highest shard. The downside: a user whose score crosses a boundary moves between shards, and boundaries must be rebalanced as the score distribution shifts.
- **Shard by user hash:** even load and simple updates, but top-N needs a scatter-gather merge, and an exact rank needs `ZCOUNT` on every shard.
- **Approximate ranks:** outside the top 10k, show "top 3 %" instead of an exact number. Precompute score percentiles every minute. Players rarely care whether they're #1,204,331 or #1,204,390.

## Part 2: trending top-K (heavy hitters)

See [Trending top-K](#diagram/trending).

### The pipeline (Lambda architecture)

1. Events (plays, views, hashtag uses) flow into **Kafka**, partitioned by item ID so all events for an item land in one partition.
2. **Flink** tasks keep, per partition and per one-minute **tumbling window**, a Count-Min Sketch and a min-heap of the partition's top K.
3. At the end of each minute, partial top-K lists are merged into a global top-K. Because items are partitioned, an item's count lives in exactly one partition, so merging is just "take the best K of the union".
4. Longer windows are built from minute buckets: the last hour = the sum of the last 60 minute buckets (sketches can be added cell by cell).
5. Results are written to the top-K store, per window and region; the API serves them with a short cache.
6. **Batch correction:** the raw events are archived to object storage; an hourly Spark job computes exact counts and overwrites the approximate results for completed windows.

### Count-Min Sketch + heap

See [Count-Min Sketch](#diagram/sketch).

- A **Count-Min Sketch** is a `d × w` matrix of counters with `d` independent hash functions. To add item x, increment one counter in each row (`row i, column h_i(x)`). To estimate x's count, take the **minimum** of those d counters.
- Collisions only ever add, so the estimate is never too low; with `w = ⌈e/ε⌉` and `d = ⌈ln(1/δ)⌉`, the overestimate is at most `ε × total events` with probability `1 − δ`.
- Memory is fixed — ~55 KB for ε = 0.001, δ = 0.01 — no matter how many distinct items appear.
- The sketch can't list items, so keep a **min-heap of size K** with the current best estimates. After each update, if x's estimate beats the heap's smallest entry, replace it.

### Alternatives

- **Space-Saving / Misra-Gries:** keep only k counters; when a new item arrives and all counters are taken, replace the smallest one and inherit its count (+1). Deterministic error bounds, and it directly yields the top items.
- **Exact counting:** `INCR` per item in Redis and a periodic sort works for thousands of items, not millions of events per second.
- **Trending ≠ most popular:** "trending" usually means *growing fastest* — compare the current window's count with a baseline (e.g. the same hour last week) and rank by the ratio or a z-score, so perennial hits don't always win.

## Scaling and reliability

- Leaderboard writes go through the durable store first, so Redis can always be rebuilt.
- The top-N cache means read spikes during tournaments don't hit Redis.
- Trending tasks are stateless apart from windowed state that Flink checkpoints; a failed task restarts from the checkpoint and Kafka offsets.

### Failure modes

| Failure | Impact | Handling |
| --- | --- | --- |
| Redis primary fails | Brief write/read errors | Replica promotion; score service retries writes from its outbox |
| Redis data lost | Leaderboard empty | Rebuild from score history |
| Cheating / impossible scores | Unfair boards | Server-authoritative results, signatures, bounds, anomaly review, score removal (`ZREM` + history flag) |
| Event spike for one item (viral) | One Kafka partition hot | Pre-aggregate in producers (count locally for a second before sending); split hot keys |
| Bot-driven trending manipulation | Fake trends | Count distinct users, rate-limit per user, anomaly detection before publishing |

## Observability

- Score submission latency and rejection reasons.
- Time from accepted score to visible rank.
- Redis memory, ops/s, command latency.
- Trending: window completion lag, sketch error estimates vs batch-exact results (track the difference).

## Trade-offs to discuss

- **Exact vs approximate:** exact ranks where users care (their own position), approximate where nobody can tell (trending counts, ranks beyond the top 10k).
- **Single Redis vs sharded:** a single sorted set is simple up to ~100 M members; sharding complicates rank queries.
- **Window granularity:** finer buckets give smoother sliding windows but more state and more merges.
- **Write-through vs event-driven updates:** updating Redis in the request is simpler and faster to show; consuming score events from Kafka decouples the systems at the cost of a small delay.

## Interview follow-up questions

- **How do you reset a season?** Start writing to a new key (`lb:season43`) at the boundary; keep the old key read-only for history, then archive it.
- **How would you show "you moved up 3 places"?** Store the previous rank with the score submission and compare after `ZADD`.
- **What if the score is "lowest time wins" (a race)?** Use `ZRANGE`/`ZRANK` (ascending) instead of the `REV` variants, and `ZADD LT`.
- **How do you prevent a hot key when a million people view the top-100?** Cache the rendered top-100 per second in memory and at the CDN.
- **How would you compute trending per city for 10,000 cities?** Key windows by region; keep sketches per region only for regions with enough traffic, and roll small regions up to their country.
