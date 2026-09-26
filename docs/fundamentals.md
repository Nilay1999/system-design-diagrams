# Building Blocks & Interview Framework

> Almost every large system is a recombination of the same dozen components. Learn them once, then learn *when* each one earns its place.

## How to approach a design

A repeatable four-step loop works for interviews and real design reviews alike:

| Step | Time (45 min interview) | Output |
| --- | --- | --- |
| 1. Clarify requirements | ~5 min | Functional scope, non-functional targets (latency, availability, consistency), scale numbers |
| 2. Estimate | ~5 min | QPS (avg + peak), storage/year, bandwidth, memory for caches |
| 3. High-level design | ~15 min | API, data model, boxes-and-arrows diagram covering every functional requirement |
| 4. Deep dive | ~20 min | Bottlenecks, failure modes, trade-offs for the 2–3 hardest parts |

Rules of thumb:

- **Design for the requirements you wrote down.** If a component doesn't serve one, remove it.
- **Say the trade-off out loud.** "I'm choosing X, which costs Y, because Z matters more here."
- **Start simple, then scale.** A single server + DB that works beats a sharded mesh that doesn't.

## Back-of-the-envelope cheat sheet

| Quantity | Value |
| --- | --- |
| Seconds per day | ~86,400 ≈ 10⁵ |
| 1 M requests/day | ≈ 12 QPS average |
| 100 M requests/day | ≈ 1,200 QPS average (peak ≈ 2–3× avg) |
| L1 cache reference | ~1 ns |
| Main memory reference | ~100 ns |
| Read 1 MB sequentially from memory | ~3 µs |
| SSD random read | ~16 µs–100 µs |
| Round trip within a datacenter | ~0.5 ms |
| Read 1 MB sequentially from SSD | ~50 µs–1 ms |
| Round trip across continents | ~150 ms |

Availability budgets: **99.9 %** ≈ 8.8 h downtime/year, **99.99 %** ≈ 53 min/year, **99.999 %** ≈ 5 min/year. Components in series multiply availabilities (two 99.9 % dependencies ≈ 99.8 %); redundant components in parallel improve them.

## Core building blocks

### DNS & GeoDNS
Maps names to IPs. GeoDNS / latency-based routing sends users to the nearest region. TTLs control how quickly failover propagates — short TTLs mean faster failover but more lookups.

### Load balancers
- **L4** (TCP/UDP): fast, protocol-agnostic, can't route by URL.
- **L7** (HTTP): routes by path/header/cookie, terminates TLS, does retries and health checks.
- Algorithms: round robin, least connections, consistent hashing (for cache affinity or sticky sessions).
- Remove the LB as a single point of failure with an active/passive pair or anycast.

### CDN
Caches static (and increasingly dynamic) content at edge PoPs. **Pull CDNs** fetch from origin on first miss; **push CDNs** are pre-populated. Use content-hashed filenames so you never have to invalidate.

### Stateless application tier
Keep session state out of app servers (in a cookie/JWT or Redis) so any instance can serve any request. This is what makes horizontal auto-scaling trivial.

### Caching

| Pattern | How it works | Watch out for |
| --- | --- | --- |
| Cache-aside (lazy) | App reads cache → on miss reads DB and fills cache | Stale data until TTL; thundering herd on hot-key expiry |
| Read-through | Cache library loads from DB on miss | Same as above, simpler app code |
| Write-through | Writes go to cache and DB synchronously | Higher write latency |
| Write-behind | Write to cache, flush to DB asynchronously | Data loss if cache dies before flush |

Eviction: LRU is the default; LFU for skewed popularity. Mitigate stampedes with **request coalescing**, **jittered TTLs**, and **stale-while-revalidate**.

### Databases

- **Relational (PostgreSQL, MySQL):** strong consistency, joins, transactions. Scale reads with replicas, writes with sharding.
- **Key-value (DynamoDB, Redis):** O(1) access by key, trivially partitioned.
- **Wide-column (Cassandra, Bigtable):** high write throughput, partition key + clustering key; great for time series and messages.
- **Document (MongoDB):** flexible schemas, nested data.
- **Search (Elasticsearch/OpenSearch):** inverted indexes for full-text and faceting.
- **Graph (Neo4j):** multi-hop relationship queries.
- **OLAP (ClickHouse, BigQuery, Druid):** columnar scans and aggregations.

### Replication
- **Leader–follower:** simple; followers serve reads with replication lag. Failover must avoid split-brain.
- **Multi-leader:** writes in several regions; requires conflict resolution.
- **Leaderless (Dynamo):** quorum reads/writes (`W + R > N`), hinted handoff, read repair.

### Sharding (partitioning)
- **Range-based:** efficient range scans, risk of hot spots (e.g. time-ordered keys).
- **Hash-based:** even spread, no range scans.
- **Consistent hashing with virtual nodes:** adding/removing a node only moves ~1/N of keys.
- Pick a shard key that matches the dominant access pattern and has high cardinality. Cross-shard queries and transactions are the price.

### Message queues & streams
- **Queues (SQS, RabbitMQ):** each message consumed by one worker; great for job distribution.
- **Logs/streams (Kafka, Kinesis, Pulsar):** ordered per partition, replayable, many independent consumer groups.
- They decouple producers from consumers, absorb bursts, and let slow work happen asynchronously.
- Delivery is realistically **at-least-once**, so consumers must be **idempotent**.

### Object storage
S3/GCS/Azure Blob: cheap, 11 nines durability, unlimited scale. Store large blobs here and keep only metadata in the database. Use **pre-signed URLs** so clients upload/download directly.

## CAP and PACELC

- **CAP:** during a network **P**artition you choose **C**onsistency (reject some requests) or **A**vailability (serve possibly stale data).
- **PACELC:** **E**lse (no partition) you still trade **L**atency against **C**onsistency.
- Most real systems choose per operation: payments need linearizability; like counts can be eventually consistent.

## Consistency models (strongest → weakest)

1. **Linearizable** – behaves like a single copy.
2. **Sequential / causal** – everyone sees causally related writes in order.
3. **Read-your-writes / monotonic reads** – session guarantees, often enough for UX.
4. **Eventual** – replicas converge if writes stop.

## Reliability patterns

- **Timeouts + retries with exponential backoff and jitter.** Never retry without a timeout.
- **Idempotency keys** so retries don't duplicate side effects.
- **Circuit breakers** to stop hammering a failing dependency.
- **Bulkheads** – isolate resource pools per dependency/tenant.
- **Rate limiting and load shedding** to protect the system under overload.
- **Graceful degradation** – serve cached/partial results instead of errors.
- **Health checks, redundancy across AZs/regions, and runbooks.**

## Observability

- **Metrics** (RED: Rate, Errors, Duration; USE: Utilisation, Saturation, Errors).
- **Logs** (structured, with request IDs).
- **Traces** (distributed tracing across services).
- Alert on **SLO burn rate**, not on individual host symptoms.

## Common interview follow-ups

- How does the design change at 10× and 100× traffic?
- What happens when component X fails? When a whole region fails?
- Where are the hot keys / hot partitions?
- How do you migrate the schema or re-shard with zero downtime?
- How do you test, deploy, and roll back safely?
