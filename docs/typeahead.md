# Search Autocomplete

> As the user types "sys", suggest the 5–10 most popular completions ("system design", "systemctl", …) in well under 100 ms.

## Requirements

### Functional
- Given a prefix, return the top *k* (e.g. 10) suggestions ranked by popularity.
- Suggestions update as query trends change (hourly or daily is fine; "trending" can be near real time).
- Optional: personalisation, spelling tolerance, multiple languages.

### Non-functional
- **Latency:** p99 < 100 ms end to end (users type ~1 char per 150 ms).
- **High availability;** stale suggestions are acceptable, errors are not.
- Filter offensive/unsafe suggestions.

## Estimation

| Metric | Assumption | Result |
| --- | --- | --- |
| Searches | 10 M DAU × 10 searches/day | 100 M searches/day |
| Keystroke requests | ~20 chars/query, debounced to ~6 requests | ~600 M requests/day ≈ 7k/s avg, ~20k/s peak |
| Distinct queries | Keep top 10–100 M after filtering | Trie with cached top-k fits in tens of GB → shard across a few servers |

## API

```http
GET /v1/suggest?q=sys&limit=10&locale=en-US
200 OK
{ "prefix": "sys", "suggestions": ["system design", "systemctl", "system of a down", …] }
```

## Core data structure: trie with cached top-k

- A **trie** stores every query as a path of characters.
- Naively, answering a prefix means walking the whole subtree — too slow.
- **Precompute** at each node the top-k completions (by frequency) beneath it. Lookup becomes: walk `len(prefix)` nodes → return the stored list. **O(prefix length)**.
- Trade memory for speed: each node stores k references; limit max prefix length (e.g. 50 chars).

An alternative with the same idea: a **key-value map** `prefix → top-k list` for every prefix up to length L. Simple to shard and to store in Redis/DynamoDB.

## High-level design

Two halves (see diagram):

### Online query path
1. Client debounces keystrokes (~100 ms) and caches responses locally.
2. CDN/browser caches `GET /suggest?q=…` for popular prefixes with a short TTL (minutes).
3. The autocomplete service routes to the **trie server shard** owning the prefix and returns the precomputed list.

### Offline pipeline
1. Submitted queries stream into Kafka (the search service logs them).
2. An aggregator (Spark/Flink) counts query frequencies per time window, applying **time decay** so recent popularity matters more.
3. A trie builder constructs the trie with top-k at every node.
4. A safety filter removes blocked terms.
5. The snapshot is published to object storage; trie servers load it (blue/green swap) on a schedule.

## Deep dives

### Sharding
- By first character(s) of the prefix — but letters are skewed ("s" ≫ "x"). Use a **shard map** built from historical traffic so each shard gets balanced load (e.g. `a–ab`, `ac–am`, …).
- Replicate each shard for availability and read throughput.

### Freshness and trending
- Rebuilding the full trie daily is simple. For trending topics, maintain a small **real-time layer** (last-hour counts from a streaming job) and merge it with the static top-k at query time.

### Ranking signals
Frequency with decay, recency, click-through rate on suggestions, locale, and (optionally) user history. Personalised suggestions are merged client- or server-side with global ones.

### Filtering
Maintain a blocklist and classifier; remove at build time, and keep a fast **kill switch** that filters at serve time for newly flagged terms.

### Fuzzy matching
Support typos with edit-distance-1 expansions for short prefixes or a separate n-gram index — at higher cost.

## Scaling & reliability

- Trie servers are read-only between loads → trivially replicated and cacheable.
- If the pipeline fails, keep serving the last good snapshot.
- Client-side and CDN caching absorb a large share of traffic for short prefixes.

## Trade-offs

- **Trie vs prefix → list map:** trie is more memory-efficient for shared prefixes; the map is simpler to store in a generic KV store.
- **Freshness vs cost:** hourly rebuilds vs streaming updates.
- **Precomputed top-k** makes reads O(1)-ish but makes updates expensive — the reason updates happen offline.
