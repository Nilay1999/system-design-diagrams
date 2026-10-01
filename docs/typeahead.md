# Search Autocomplete

> As the user types "sys", suggest the 5–10 most popular completions ("system design", "systemctl", …) in well under 100 ms.

## The problem in one minute

Autocomplete has a brutal latency budget: people type a character every ~150 ms, so suggestions must appear faster than that, including the network. You can't search a database of 100 million queries on every keystroke. The trick is to **precompute** the answer for every prefix: a trie where each node already stores its top-k completions. A lookup then walks a few nodes and returns a stored list.

Precomputed answers are expensive to update, so the system is split in two:

- an **online path** that only reads precomputed, in-memory data (plus caches at every layer), and
- an **offline pipeline** that counts queries from search logs and rebuilds the tries every hour or day, with a small **real-time layer** for trending topics.

| Decision | Choice | Why |
| --- | --- | --- |
| Data structure | Trie (radix trie) with top-k cached at every node | O(prefix length) lookups |
| Freshness | Rebuild offline hourly/daily + a real-time trending layer | Cheap reads, fresh enough |
| Ranking signal | Query counts with time decay (+ trending, + personal) | Popular now beats popular years ago |
| Sharding | By prefix ranges sized from traffic, not by letter | "s" gets 10× the traffic of "x" |
| Caching | Client, CDN, service | Most keystrokes never reach a trie server |
| Deploys | Immutable snapshots, blue/green swap | Zero downtime; instant rollback |
| Safety | Filter at build time + serve-time kill list | Offensive suggestions are removable within minutes |

## Requirements

### Functional

- Given a prefix, return the top k (e.g. 10) suggestions, ranked by popularity.
- Suggestions reflect trends: daily updates for most, near-real-time for breaking topics.
- Per-language/locale suggestions.
- Optional: personalisation (my recent searches), spelling tolerance.
- Never suggest offensive, dangerous, or personal-data completions.

### Non-functional

| Property | Target |
| --- | --- |
| Latency | p99 < 100 ms end to end; < 10 ms inside the service |
| Availability | Very high — stale suggestions are acceptable, errors and blank boxes are not |
| Freshness | Global suggestions within a day; trending within ~15 minutes |
| Scale | 20k requests/s peak, 100 M distinct queries |

## Capacity estimation

- **Searches:** 10 M daily users × 10 searches = **100 M searches/day**.
- **Requests:** an average query is ~20 characters, but debouncing (only send after ~100 ms without typing) cuts requests to ~6 per search → **600 M requests/day ≈ 7k/s**, ~20k/s at peak.
- **Caching:** most requests are for short, popular prefixes. With client caching (previous prefixes) and CDN caching (short prefixes), the service might see only 20–40 % of requests.
- **Distinct queries:** after dropping rare ones (seen fewer than N times) and unsafe ones, keep the top **100 M** queries.
- **Trie size:** 100 M queries × ~20 chars = 2 B characters, but shared prefixes collapse most of them. With ~500 M nodes and a top-10 list of 4-byte IDs per node, plus child pointers, roughly **50–100 GB** → a handful of shards, each replicated.
- **Offline data:** 100 M queries/day of logs × ~100 bytes = 10 GB/day. Easy for Spark/Flink.

## API

```http
GET /v1/suggest?q=sys&limit=10&locale=en-US
Cache-Control: public, max-age=300

200 OK
{
  "prefix": "sys",
  "suggestions": [
    { "text": "system design", "type": "global" },
    { "text": "systemctl", "type": "global" },
    { "text": "sysco earnings", "type": "trending" },
    { "text": "system design interview", "type": "personal" }
  ]
}
```

- Use `GET` so responses are cacheable by browsers and CDNs. Normalise the prefix (lowercase, trimmed, Unicode-normalised) **before** building the URL so caches aren't fragmented.
- Personalised results make responses user-specific, which breaks shared caching. Keep the shared global response cacheable and merge personal results on the client (or in a separate, uncached call).

## Data model

**Offline:**

```text
query_counts   (query, locale, hour) → count                       -- from search logs
query_scores   (query, locale) → decayed_score, first_seen, flags  -- input to the builder
```

**Online (in memory):** a trie per shard. Each node:

```text
node {
  children: map<char, node>      -- or a sorted array for compactness
  top_k: [query_id × 10]         -- best completions under this node, by score
  is_terminal: bool              -- a complete query ends here
}
query_table: query_id → text, score
```

**Alternative:** a flat key-value map `prefix → top-k list` for every prefix up to length L (e.g. 20). It uses more memory (every prefix stored separately) but can live in any KV store (Redis, DynamoDB) with no custom server.

## High-level architecture

See the [Architecture](#diagram/architecture) diagram.

| Component | Responsibility |
| --- | --- |
| Client | Debounce, cancel stale requests, cache responses per prefix, render |
| CDN | Cache responses for popular prefixes for a few minutes |
| Autocomplete service | Route to the right shard, merge global + trending + personal, apply the kill list |
| Shard map | Prefix range → trie shard |
| Trie shards | In-memory tries with cached top-k, replicated |
| Trending layer | Redis: top-k per short prefix over the last hour, from a streaming job |
| Search service | Logs submitted queries (not keystrokes) to Kafka |
| Aggregator | Counts queries per time window (Flink) |
| Trie builder | Builds per-shard tries with top-k (Spark) |
| Safety filter | Blocklist, classifier, PII detection, minimum-count threshold |
| Snapshot store | Versioned trie files in object storage |

## Query flow

See [Query flow](#diagram/query).

1. The user types `s`, `y`, `s` quickly. The client **debounces**: it waits ~100 ms after the last keystroke, sends only `sys`, and cancels the in-flight request for `sy`.
2. If `sys` is in the client's local cache, suggestions appear instantly.
3. Otherwise the request goes to the CDN. Popular prefixes are answered at the edge.
4. On a CDN miss, the autocomplete service looks up the shard for `sys`, and in parallel asks the trie shard for the top-10 at node `sys` and the trending layer for hot queries under `sys`.
5. The trie shard walks 3 nodes and returns the stored list — microseconds.
6. The service merges (trending items get a boost), removes anything on the serve-time kill list, and returns with `Cache-Control: max-age=300`.
7. The client renders, highlighting the typed prefix.

## Deep dives

### 1. Trie with cached top-k

See [Trie with top-k](#diagram/trie).

- Without caching, answering `s` means visiting every query that starts with `s` — millions of nodes. Too slow.
- With top-k cached at each node, lookup is: walk `len(prefix)` nodes, return the list. **O(prefix length)**, independent of how many queries exist.
- **Building top-k:** process nodes bottom-up; each node's top-k is the best k among its own terminal query (if any) and its children's top-k lists — a small k-way merge per node.
- **Memory savings:** a radix trie merges chains of single-child nodes (`s→y→s→t→e→m` becomes one edge "system"); store query IDs rather than strings in top-k lists; cap depth at ~30 characters (people rarely type longer before choosing).

### 2. Ranking and time decay

Raw all-time counts favour old queries forever. Use a decayed score:

```text
score(q) = Σ over hours h  count(q, h) × 0.5 ^ (age(h) / half_life)      # e.g. half_life = 7 days
```

Other signals: click-through rate on the suggestion itself (a suggestion that's shown a lot but never picked should drop), locale, freshness boosts, and for logged-in users their own history.

### 3. Freshness and trending

- The full rebuild is batch (hourly or daily) — simple and robust.
- For breaking news, a streaming job computes top-k for short prefixes over the last hour (a count-min sketch + heap per prefix, or exact counts for a bounded set of prefixes) and writes them to Redis.
- At query time, the service merges trending results into the static list with a boost. Trending entries also pass the safety filter — and get extra scrutiny, since sudden spikes are where abuse shows up.

### 4. Sharding and replication

- Sharding by first letter is badly skewed: `s`, `c`, `p` get far more traffic than `x`, `q`, `z`.
- Instead, build a **shard map of prefix ranges** from last week's traffic, so each shard gets roughly equal load: `a–ab`, `ac–am`, …, `sy–sz`.
- Each shard has several replicas behind a load balancer. Tries are read-only between deploys, so replicas never need to coordinate.

### 5. Build and deploy

See [Build & deploy](#diagram/pipeline).

1. Normalise and dedupe queries (count each user at most once per query per hour, to stop one user or bot from inflating a query).
2. Compute decayed scores; drop queries below a minimum count.
3. Run the safety filter.
4. Build one trie per shard, serialise to a compact file with a checksum, and upload as an immutable, versioned snapshot.
5. **Blue/green:** new replicas load and warm the snapshot, pass health checks (sample queries, size sanity checks), and then the load balancer switches traffic. Rolling back means switching back.

If the pipeline fails, the servers keep serving the last good snapshot — stale but correct.

### 6. Safety

- Build time: blocklist, a classifier for hateful/sexual/violent content, PII detection (phone numbers, addresses), and a minimum number of distinct users per query (so one person can't plant a suggestion).
- Serve time: a **kill list** that ops can update within minutes (pushed to all service instances) for newly flagged suggestions — without waiting for a rebuild.
- Legal and policy requests (defamation) go through the same kill list.

### 7. Fuzzy matching and other languages

- **Typos:** for short prefixes, also look up prefixes within edit distance 1 (a few extra lookups), or use a separate n-gram or symmetric-delete index — at higher cost.
- **CJK languages:** input methods produce characters differently; tokenise by characters and pinyin/romaji mappings.
- One trie per locale; route by `locale`.

## Scaling and reliability

- Trie servers are stateless and read-only between loads → add replicas for throughput.
- Most traffic is absorbed by client and CDN caches.
- Degrade gracefully: if trending or personalisation is slow, return global suggestions; if everything fails, the client shows nothing (never an error dialog).

### Failure modes

| Failure | Impact | Handling |
| --- | --- | --- |
| A trie replica dies | Fewer replicas for that shard | Load balancer drops it; autoscale |
| Bad snapshot (corrupt, empty) | Garbage or no suggestions | Checksums and sanity checks before switching; instant rollback |
| Pipeline delayed | Suggestions get stale | Serve last snapshot; alert on snapshot age |
| Trending job pollution (bot attack) | Abusive trending suggestions | Distinct-user thresholds, anomaly detection, kill list |
| Hot prefix | One shard overloaded | CDN + in-process cache for top prefixes; more replicas |

## Observability

- Latency per layer (client-measured end-to-end, CDN, service, shard).
- CDN and client cache hit rates.
- Suggestion click-through rate (the quality metric) and "no suggestion shown" rate.
- Snapshot age per shard; build duration; kill-list size.

## Trade-offs to discuss

- **Trie vs prefix → list map:** tries share prefixes and save memory; the map is simpler and fits any KV store.
- **Freshness vs cost:** hourly rebuilds plus a trending layer vs full streaming updates of the trie (complex, rarely worth it).
- **Personalisation vs caching:** personal suggestions defeat shared caches; keep them as a separate, small merge.
- **Precomputed top-k:** makes reads trivially fast but updates expensive — the reason updates are offline.

## Interview follow-up questions

- **Why not use a search engine like Elasticsearch with prefix queries?** It works at small scale, but top-k by popularity for short prefixes means scanning huge posting lists per keystroke; precomputation wins at scale.
- **How would you support "mid-word" matching (typing "design" suggests "system design")?** Index each query under every word start, not just the query start (more memory), or use an n-gram index.
- **How do you stop someone from manipulating suggestions?** Count distinct users, not raw counts; rate-limit per user; detect sudden unnatural spikes.
- **How do you handle a brand-new query that suddenly matters (breaking news)?** The trending layer picks it up within minutes and is merged at query time.
- **What changes for a mobile keyboard's next-word prediction?** The model runs on-device with a small language model; the server only ships model updates.
