# Building Blocks & Interview Framework

> Almost every large system is a recombination of the same dozen components. Learn them once, then learn *when* each one earns its place.

## How to approach a design

A repeatable loop works for interviews and real design reviews alike. The time split below is for a 45-minute interview; in a real design review, the same steps become sections of the design document.

| Step | Time | What you produce | Questions to ask |
| --- | --- | --- | --- |
| 1. Clarify requirements | ~5 min | Functional scope, non-functional targets, what is out of scope | Who are the users? What are the 3 most important features? Read-heavy or write-heavy? How fresh must data be? |
| 2. Estimate | ~5 min | Average and peak QPS, storage per year, bandwidth, cache size | How many daily active users? How many actions per user per day? How big is each object? |
| 3. API and data model | ~5 min | Endpoints with inputs and outputs, main tables and their keys | What does the client call? What is the primary access pattern? |
| 4. High-level design | ~10 min | A boxes-and-arrows diagram that covers every functional requirement | Walk one read and one write through the diagram |
| 5. Deep dives | ~15 min | 2–3 of the hardest parts in detail: bottlenecks, failure modes, trade-offs | Where is the hot spot? What breaks at 10×? What happens when X fails? |
| 6. Wrap-up | ~5 min | Summary, known weaknesses, what you would do next | What would you monitor? What would you build in v2? |

### Rules of thumb

- **Design for the requirements you wrote down.** If a component doesn't serve a requirement, remove it. Every box on the diagram should have a reason you can say out loud.
- **Say the trade-off out loud.** "I'm choosing X, which costs Y, because Z matters more here." Interviewers score reasoning, not the final picture.
- **Start simple, then scale.** A single server and database that works beats a sharded mesh that doesn't. Show the simple version first, then evolve it with the numbers from your estimate.
- **Follow the data.** For every piece of data, know who writes it, who reads it, how often, and how fresh it must be. Most design decisions fall out of those four answers.
- **Separate the hot path from everything else.** The request the user is waiting on should touch as few components as possible. Push everything else (emails, analytics, indexing) to queues.

## Back-of-the-envelope cheat sheet

### Traffic

| Quantity | Value |
| --- | --- |
| Seconds per day | 86,400 ≈ 10⁵ |
| 1 M requests / day | ≈ 12 requests/s on average |
| 100 M requests / day | ≈ 1,200 requests/s on average |
| Peak vs average | Plan for 2–3× (consumer apps), up to 10× for flash events |
| Seconds per month | ≈ 2.6 × 10⁶ |

A quick method: **daily active users × actions per user per day ÷ 10⁵ = average QPS.** For example, 50 M DAU × 20 feed loads ÷ 10⁵ = 10,000 reads/s.

### Latency numbers

| Operation | Time | What it means in practice |
| --- | --- | --- |
| L1 cache reference | ~1 ns | |
| Main memory reference | ~100 ns | In-process caches are ~1,000× faster than a network call |
| Read 1 MB sequentially from memory | ~3 µs | |
| SSD random read | ~16–100 µs | |
| Read 1 MB sequentially from SSD | ~50 µs–1 ms | |
| Round trip within a data centre | ~0.5 ms | A Redis call costs ~0.5–1 ms, mostly network |
| Read 1 MB sequentially from HDD | ~5–20 ms | |
| Round trip across a continent | ~50–80 ms | |
| Round trip across oceans | ~150 ms | Why multi-region matters for global users |

### Storage and sizes

| Thing | Rough size |
| --- | --- |
| A UUID / 64-bit ID | 16 B / 8 B |
| A tweet-like text post with metadata | ~1 KB |
| A compressed photo | 200 KB – 2 MB |
| One minute of 1080p video | ~50–100 MB |
| A single Postgres node (comfortable) | 1–5 TB, ~10k simple writes/s |
| A single Redis node | ~25–100 GB, ~100k ops/s |
| A single Kafka broker | ~100 MB/s writes |

### Availability

| SLA | Downtime per year | Downtime per month |
| --- | --- | --- |
| 99 % | 3.65 days | 7.2 hours |
| 99.9 % | 8.8 hours | 43 minutes |
| 99.99 % | 53 minutes | 4.3 minutes |
| 99.999 % | 5 minutes | 26 seconds |

Dependencies **in series** multiply: if a request needs two services that are each 99.9 % available, the request succeeds 99.9 % × 99.9 % ≈ 99.8 % of the time. Redundant copies **in parallel** improve availability: two independent 99 % replicas give 1 − 0.01² = 99.99 %.

## Core building blocks

Open [Reference architecture](#diagram/architecture) to see where each block sits.

### DNS and GeoDNS

DNS maps a name to IP addresses. **GeoDNS** or latency-based routing returns the IP of the nearest healthy region. The record's **TTL** controls how quickly clients notice a change: a short TTL (30–60 s) means faster failover but more DNS lookups. Some clients and resolvers ignore TTLs, so DNS failover is never instant; anycast (one IP announced from many places) fails over faster.

### Load balancers

| Type | Works on | Can do | Can't do |
| --- | --- | --- | --- |
| L4 (TCP/UDP) | IP + port | Very fast, any protocol, long-lived connections (WebSockets, gRPC) | Route by URL or header |
| L7 (HTTP) | Full request | Route by path/header/cookie, TLS termination, retries, compression | Handle non-HTTP protocols |

Algorithms: **round robin** (simple), **least connections** (good when request costs vary), **consistent hashing** (sends the same key to the same server, useful for cache affinity), and **power of two choices** (pick two random servers, use the less loaded one — nearly as good as least-connections with less coordination).

The load balancer itself must not be a single point of failure: run an active/passive pair with a floating IP, or use a managed LB or anycast.

### CDN

A content delivery network caches content at edge locations close to users.

- **Pull CDN:** the edge fetches from your origin on the first miss. Easy to set up.
- **Push CDN:** you upload content to the CDN ahead of time. Good for large, predictable files such as video.
- Use **content-hashed file names** (`app.3f9a.js`) with long cache lifetimes, so you never need to invalidate: a new version gets a new name.
- Modern CDNs also cache API responses for a few seconds and run code at the edge (auth checks, A/B routing).

### Stateless application tier

Keep session state out of app servers — in a signed cookie/JWT or in Redis — so any instance can serve any request. This makes horizontal auto-scaling and rolling deploys easy. If a server keeps state (e.g. WebSocket connections), you need a way to find which server holds what (see the Chat System topic).

### Caching

| Pattern | How it works | Watch out for |
| --- | --- | --- |
| Cache-aside (lazy loading) | App reads cache; on a miss it reads the DB and fills the cache | Stale data until TTL or invalidation; stampede on hot-key expiry |
| Read-through | A cache library loads from the DB on a miss | Same as cache-aside, simpler app code |
| Write-through | Writes go to the cache and the DB together | Higher write latency; caches data nobody reads |
| Write-behind (write-back) | Write to the cache, flush to the DB later | Data loss if the cache dies before flushing |
| Refresh-ahead | Refresh popular keys before they expire | Wasted work if prediction is wrong |

- **Eviction:** LRU is the default. LFU suits very skewed popularity. TTLs bound staleness.
- **Invalidation:** on a write, update the DB first, then **delete** the cache key (don't update it — two concurrent writers can leave the cache with the older value).
- **Stampedes:** when a hot key expires, thousands of requests miss at once. Fix with request coalescing (one request refills, the rest wait), jittered TTLs, and stale-while-revalidate.
- **Where to cache:** browser → CDN → API gateway → in-process memory → distributed cache (Redis) → database buffer pool. The closer to the user, the faster, but the harder to invalidate.

See the Distributed Cache topic for a full design.

### Databases

| Family | Examples | Strengths | Typical use |
| --- | --- | --- | --- |
| Relational | PostgreSQL, MySQL | Transactions, joins, constraints, mature tooling | Orders, payments, users, anything with invariants |
| Key-value | DynamoDB, Redis | O(1) access by key, easy to partition | Sessions, URL maps, carts, feature flags |
| Wide-column | Cassandra, ScyllaDB, Bigtable | Very high write throughput, partition + clustering keys | Messages, time series, activity logs |
| Document | MongoDB, Firestore | Flexible, nested records | Product catalogues, user-generated content |
| Search | Elasticsearch, OpenSearch | Inverted index for full-text, facets, relevance | Search boxes, log search |
| Graph | Neo4j, Neptune | Multi-hop relationship queries | Social graphs, fraud rings, recommendations |
| OLAP / columnar | ClickHouse, BigQuery, Druid | Fast scans and aggregations over billions of rows | Analytics dashboards, reporting |
| Time series | Prometheus, InfluxDB, TimescaleDB | Compression and queries over timestamps | Metrics, IoT |

A good default: **start with PostgreSQL** unless you have a specific reason not to (very high write rates, huge scale on a simple key access pattern, full-text search, analytics). Add specialised stores alongside it, fed by events, rather than replacing it.

### Replication

See [Replication & sharding](#diagram/replication-sharding).

- **Leader–follower (primary–replica):** one node accepts writes and streams its log to followers. Followers serve reads but may lag behind by milliseconds to seconds. Failover must make sure the old leader stops accepting writes (fencing), or you get **split-brain** — two leaders accepting conflicting writes.
- **Synchronous vs asynchronous:** synchronous replication waits for a follower before acknowledging, so no acknowledged write is lost if the leader dies, but writes are slower and stall if the follower is slow. Many systems use **semi-synchronous**: one follower synchronous, the rest asynchronous.
- **Multi-leader:** a leader in each region accepts writes locally. Needs conflict resolution (last-writer-wins, merge functions, or CRDTs).
- **Leaderless (Dynamo-style):** clients write to several replicas directly. With N replicas, writing to W and reading from R where **W + R > N** guarantees the read set overlaps the latest write. Repairs happen via read repair, hinted handoff and anti-entropy (see the Key-Value Store topic).

### Sharding (partitioning)

| Strategy | How | Pros | Cons |
| --- | --- | --- | --- |
| Range | Key ranges per shard (A–F, G–M, …) | Range scans are efficient | Hot spots with sequential keys (timestamps) |
| Hash | `hash(key) mod N` | Even spread | Changing N moves almost every key; no range scans |
| Consistent hashing | Keys and nodes on a hash ring; virtual nodes | Adding a node moves only ~1/N of keys | Slightly more complex routing |
| Directory / lookup | A table maps key → shard | Full control, can move single tenants | The directory is another service to scale and keep available |
| Geographic | Shard by region | Data residency, low latency | Uneven load between regions |

Choose a shard key that has **high cardinality**, spreads load **evenly**, and matches the **main query**, so most requests touch one shard. The price of sharding: cross-shard queries need scatter-gather, cross-shard transactions need sagas or two-phase commit, and re-sharding needs a careful migration (double-write, backfill, verify, switch reads, switch writes).

### Message queues and streams

| | Queue (SQS, RabbitMQ) | Log / stream (Kafka, Kinesis, Pulsar) |
| --- | --- | --- |
| Consumption | Each message goes to one worker, then is deleted | Messages are kept; each consumer group tracks its own position |
| Ordering | Best effort (FIFO queues exist, with lower throughput) | Strict order within a partition |
| Replay | No | Yes, rewind the offset |
| Best for | Distributing independent jobs | Event streams feeding many consumers, change data capture |

Both decouple producers from consumers, absorb bursts, and let slow work happen asynchronously. In practice delivery is **at-least-once**, so consumers must be **idempotent**: processing the same message twice must have the same effect as processing it once (use a unique message ID and a "processed" table, or naturally idempotent writes such as upserts).

The **transactional outbox** pattern solves "update the DB and publish an event" atomically: write the event into an `outbox` table in the same transaction as the business change, and have a relay publish rows from that table to the queue.

### Object storage

S3, GCS and Azure Blob are cheap, extremely durable (eleven nines), and scale without limit. Store large blobs (images, video, backups, logs) there and keep only metadata in the database. Use **pre-signed URLs** so clients upload and download directly, without streaming bytes through your servers. Use lifecycle rules to move old data to cheaper tiers.

### Search indexes

An inverted index maps each word to the list of documents containing it. Search engines add ranking (BM25, learned ranking), typo tolerance, facets, and aggregations. Keep the database as the source of truth and feed the index asynchronously (change data capture or events). Accept that search results can lag writes by a second or two.

## CAP and PACELC

- **CAP:** when the network is **P**artitioned, a replicated system must choose between **C**onsistency (refuse some requests so nobody sees stale data) and **A**vailability (answer every request, possibly with stale data). Partitions will happen, so the real choice is C or A *during a partition*.
- **PACELC:** **E**lse (no partition), you still trade **L**atency against **C**onsistency, because waiting for replicas to agree takes time.
- Real systems choose **per operation**, not per system. A payment must be strongly consistent; a like count can be eventually consistent; a shopping cart prefers availability and merges conflicts later.

## Consistency models (strongest to weakest)

1. **Linearizable:** the system behaves as if there were one copy of the data and every operation happened at a single instant. Needed for locks, leader election, unique usernames, account balances.
2. **Sequential / causal:** everyone sees causally related writes in the same order (a reply never appears before the message it replies to).
3. **Session guarantees:** *read-your-writes* (you always see your own updates), *monotonic reads* (you never see time go backwards). Often enough for good UX; implement by routing a user's reads to the leader for a few seconds after they write, or by tracking the replication position they have seen.
4. **Eventual:** if writes stop, replicas converge. Cheap and highly available, but readers can see old or out-of-order values.

## Reliability patterns

| Pattern | What it does | Detail |
| --- | --- | --- |
| Timeouts | Stop waiting on a slow dependency | Every network call needs one. Set it from the dependency's p99.9, not a round number |
| Retries with backoff + jitter | Recover from transient failures | Exponential backoff (100 ms, 200 ms, 400 ms …) with random jitter so clients don't retry in lockstep; cap total attempts |
| Retry budgets | Stop retries from multiplying load during an outage | e.g. retries may add at most 10 % extra traffic |
| Idempotency keys | Make retries safe | The server stores the result under the key and returns it for repeats |
| Circuit breaker | Stop calling a dependency that is failing | Closed → open after N failures → half-open to probe → closed |
| Bulkheads | Isolate failures | Separate thread/connection pools per dependency or tenant |
| Rate limiting + load shedding | Protect the system under overload | Reject early and cheaply (429 / 503) rather than time out slowly |
| Graceful degradation | Keep the core working | Serve cached or partial results; turn off non-essential features |
| Redundancy | Survive machine, zone and region failures | At least N+1 capacity per zone; test failover regularly |
| Backpressure | Slow producers when consumers fall behind | Bounded queues; reject or block when full |

## Observability

- **Metrics:** use **RED** for services (Rate, Errors, Duration) and **USE** for resources (Utilisation, Saturation, Errors).
- **Logs:** structured JSON, with a request ID on every line so one request can be followed across services.
- **Traces:** distributed tracing (OpenTelemetry) shows where time goes across service hops.
- **SLOs:** define an objective (99.9 % of requests succeed in under 300 ms) and alert on the **error-budget burn rate**, not on individual host symptoms like high CPU.

## Walking a request through the system

The [Life of a request](#diagram/request-lifecycle) diagram follows one read and one write.

**A read:**

1. The client resolves the API hostname through GeoDNS and gets the nearest healthy region.
2. Static assets come from the CDN. Their file names contain a content hash, so they can be cached for a year.
3. The API request reaches the load balancer over a reused TLS connection. The LB picks a healthy app instance.
4. The app checks Redis. On a hit it returns immediately. On a miss it reads from a replica, fills the cache with a jittered TTL, and returns.

**A write:**

1. The client sends `POST` with an idempotency key, so a retry after a timeout won't create a duplicate.
2. The app writes the business row and an outbox event in one transaction on the primary.
3. It deletes cache keys the write made stale, and returns `201`.
4. An outbox relay publishes the event to a queue; workers send emails, update search, and feed analytics later.

## The scaling journey

See the [Scaling journey](#diagram/scaling-journey) diagram. Each step solves a specific, measured limit:

| Stage | Add | Because |
| --- | --- | --- |
| 1 | One server | You have a prototype and few users |
| 2 | Separate DB host, a cache | App and DB compete for CPU/RAM; repeated reads are expensive |
| 3 | Load balancer + stateless app pool, read replicas, CDN | One app server can't keep up; reads dominate |
| 4 | Sharded DB, queues + workers | Writes outgrow one primary; slow work blocks requests |
| 5 | Multiple regions | Global latency, disaster recovery, data residency |

Don't jump to stage 4 in an interview unless the numbers from your estimate require it. Explaining *why* you need each step is worth more than drawing every box.

## Common interview follow-ups

- **How does the design change at 10× and 100× traffic?** Identify the first component to hit its limit (usually the database's write path or a hot key) and how you'd relieve it.
- **What happens when component X fails? When a whole region fails?** Walk the request path and say what the user sees.
- **Where are the hot keys or hot partitions?** Celebrity users, viral items, the current time bucket.
- **How do you migrate a schema or re-shard with zero downtime?** Expand–migrate–contract: add new columns/tables, double-write, backfill, switch reads, stop old writes, remove old structures.
- **How do you deploy safely?** Canary a small percentage, watch SLOs, roll back automatically. Use feature flags to separate deploying code from turning features on.
- **How would you test this?** Load tests at 2× expected peak, chaos testing (kill instances, add latency), and game days for regional failover.
