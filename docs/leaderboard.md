# Leaderboard & Top-K

> Two closely related questions: **"What is my exact rank among 50 M players, right now?"** (game leaderboard) and **"What are the top 10 trending songs/hashtags/videos in the last hour?"** (heavy hitters at huge scale).

## Requirements

### Functional
- Submit a score for a user (in a game, contest, season).
- Get the **top N** (e.g. top 100) leaderboard.
- Get a **user's rank** and the players around them (±5).
- Trending: top K items by count over sliding windows (last 1 min / 1 h / 24 h).

### Non-functional
- Leaderboard updates visible in near real time (< 1 s).
- Rank queries p99 < 50 ms.
- Trending lists can be approximate and a few seconds stale, but must scale to millions of events/s.

## Estimation

| Metric | Assumption | Result |
| --- | --- | --- |
| Players | 50 M monthly active, 5 M DAU | Sorted set of 50 M members ≈ a few GB in Redis |
| Score updates | 5 M DAU × 10 games | ~600 updates/s avg, spikes 10× |
| Trending events | Views/plays | 1–10 M events/s → exact per-item counting is too expensive |

## Part 1: real-time leaderboard

### Why not SQL?
`SELECT COUNT(*) FROM scores WHERE score > :mine` scans a huge range for every rank request. Indexes help top-N, but not "what's my rank" at 50 M rows under constant updates.

### Redis sorted sets
A sorted set is a skip list plus a hash map: O(log n) updates and rank queries.

```text
ZADD   lb:season42 GT 1850 user:123     -- keep the best score only (GT = only if greater)
ZREVRANGE lb:season42 0 99 WITHSCORES   -- top 100
ZREVRANK  lb:season42 user:123          -- my rank (0-based)
ZREVRANGE lb:season42 (rank-5) (rank+5) -- players around me
```

### Design
1. **Score service** validates the score (anti-cheat: server-authoritative game results, signed payloads) and writes it to a **durable score history DB**.
2. It updates the Redis sorted set (`ZADD GT`).
3. The **leaderboard service** serves top-N (cached for ~1 s, since everyone requests the same thing) and per-user rank.
4. If Redis is lost, rebuild the sorted set from the history DB.

### Ties
Make the score unique by encoding a tiebreaker, e.g. `score * 10^10 + (MAX_TS - achieved_at)`, so earlier achievers rank higher.

### Scaling beyond one Redis node
- **Shard by score range** (0–999, 1,000–1,999, …): a user's rank = their rank within the shard + the sizes of all higher shards. Rebalance when distributions shift.
- **Shard by user hash** and scatter-gather top-N: take the top N from each shard and merge. Exact rank then requires summing counts above a score from every shard (`ZCOUNT`).
- For very large boards, show **approximate ranks** (percentile buckets) to anyone outside the top 10k.

### Time-bounded leaderboards
Use a key per period (`lb:daily:2026-09-27`, `lb:weekly:2026-W39`) with expiry. Build a weekly board by `ZUNIONSTORE`-ing daily sets, or update both keys on each score.

## Part 2: trending top-K (heavy hitters)

Counting every item exactly across millions of events/s and sorting is too expensive. Use streaming approximation.

### Count-Min Sketch + min-heap
- **Count-Min Sketch:** a `d × w` matrix of counters with *d* hash functions. Increment one cell per row. The estimate is the **minimum** across rows. It overestimates, never underestimates. Memory is fixed (a few MB) regardless of the number of distinct items.
- Keep a **min-heap of size K** of the current best estimates. When an item's estimate beats the heap minimum, replace it.

### Design
1. Events (plays, views, hashtags) flow into **Kafka**, partitioned by item.
2. **Stream processors** (Flink) keep a sketch + heap per partition per **tumbling window** (e.g. 1 minute). Each window's partial top-K is merged into a global top-K.
3. Longer windows (1 h, 24 h) are **merged from minute windows** (sliding = sum of the last 60 buckets).
4. Results go to a **top-K store** (Redis/DB) that the API reads.
5. A **batch job** (Spark over the raw event archive) computes exact counts hourly/daily and overwrites the approximate results. This is the Lambda architecture: fast and approximate, then slow and exact.

### Alternatives
- **Space-Saving / Misra-Gries**: deterministic heavy-hitter algorithms with bounded error.
- Exact per-item counting in a KV store (`INCR`) plus periodic sorting works for thousands of items, not millions of events/s.

## Trade-offs

- **Exact vs approximate:** exact ranks for leaderboards (users care), approximate for trending (nobody can tell).
- **Single Redis vs sharded:** a single sorted set is simple up to ~100 M members. Beyond that, sharding complicates rank queries.
- **Window granularity:** smaller buckets give smoother sliding windows but more state.
