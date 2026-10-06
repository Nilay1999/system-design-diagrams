# Core Concepts: Data & Distributed Systems

> The ideas the other topics take for granted: how databases store and protect data, how machines agree when the network lies, and the data structures and maths behind the trade-offs.

## How to use this page

The case-study topics use phrases like "LSM tree", "write skew", "fencing token", "Raft", "saga" and "HyperLogLog" in passing. This page explains each one well enough for you to defend it in an interview. It assumes Building Blocks (what the components are) and Networking Fundamentals (what an arrow costs).

## Storage engines

See [Storage engines: B-tree vs LSM](#diagram/storage-engines).

Every durable store starts with the same rule: **write to an append-only log first** (the write-ahead log, WAL), `fsync` it, then acknowledge. After a crash, the engine replays the log. Engines differ in how they organise data *after* the log.

### B-trees (PostgreSQL, MySQL InnoDB, most relational databases)

- Data lives in fixed-size **pages** (8–16 KB) arranged as a balanced tree. A lookup reads about log_fanout(N) pages. With a fanout of ~500, **3–4 levels cover billions of rows**, and the top levels stay in memory.
- Updates change pages **in place**, after logging to the WAL. A page is cached in the **buffer pool**, so hot data costs no disk I/O.
- Good for: **reads, range scans, transactions**. Every key has one location, which makes locking simple.
- Costs: random writes, and a page split when a page fills. Sequential keys (auto-increment, time) fill the last page quickly. Random keys (UUIDv4) scatter writes across the tree and bloat the index.

### LSM trees (Cassandra, RocksDB, ScyllaDB, HBase, the DynamoDB storage layer)

1. A write goes to the WAL and to an in-memory sorted **memtable**. Writes are always sequential and very fast.
2. When the memtable is full (e.g. 64 MB), it's flushed as an immutable sorted file, an **SSTable**.
3. A read checks the memtable, then SSTables from newest to oldest. A **Bloom filter** per SSTable skips files that can't contain the key.
4. **Compaction** merges SSTables in the background. It drops overwritten values and expired **tombstones** (deletes are writes).

| Compaction | How | Good for | Cost |
| --- | --- | --- | --- |
| Size-tiered | Merge files of similar size | Write-heavy loads | A key can be in many files (read and space amplification) |
| Leveled | Each level is 10× the previous; key ranges don't overlap within a level | Read-heavy loads | More rewriting (write amplification) |
| Time-window | Group files by time; drop whole files when TTL expires | Time series, TTL data | Only fits append-mostly time data |

### The three amplifications

| | B-tree | LSM tree |
| --- | --- | --- |
| Write amplification (bytes written to disk ÷ bytes written by the app) | Medium: page rewrites + WAL | High with leveled compaction (10–30×), but all sequential |
| Read amplification (I/Os per read) | Low (1–2 with a warm cache) | Higher; Bloom filters and caches hide most of it |
| Space amplification | Pages ~70 % full | Stale versions until compaction |

You can't minimise all three at once (the RUM conjecture). **Rule of thumb:** relational / read-heavy / transactional workloads → B-tree; write-heavy, append-heavy, huge datasets → LSM.

### Row vs column storage

**Row stores** keep all columns of a row together, which suits OLTP: fetch or update one order. **Column stores** (ClickHouse, BigQuery, Parquet files) keep each column together. A query that reads 3 of 100 columns touches about 3 % of the data, and similar values compress 5–20×. They're good for scans and aggregates, and slow for single-row updates. That's why analytics data is copied into a separate store rather than queried on the primary.

## Indexes

An index is a second copy of data sorted differently, to make one access pattern fast. **Every index speeds up some reads and slows down every write.**

| Index | Structure | Use |
| --- | --- | --- |
| Primary / clustered | The table is stored in key order (InnoDB, SQL Server) | Lookups and ranges by primary key |
| Secondary | Maps column value → primary key or row location | Lookups by other columns |
| Composite `(a, b, c)` | Sorted by a, then b, then c | Queries on `a`, `a+b`, `a+b+c`. **Not** `b` alone (the leftmost-prefix rule). Put equality columns first, then the range column |
| Covering | Index includes every column the query needs | Answers from the index alone, no table lookup |
| Partial | Only rows matching a predicate (`WHERE status = 'pending'`) | Small, hot subsets such as job queues |
| Hash | Hash table | Equality only, no ranges |
| Inverted | Term → list of documents | Full-text search, tags |
| Geospatial | R-tree, geohash, S2/H3 cells | "Within 2 km of me" (see the Proximity Service topic) |

**In a sharded database,** a secondary index is either:
- **Local:** each shard indexes its own rows. Writes are cheap, but a query by that column must **scatter-gather** to every shard.
- **Global:** the index is itself partitioned by the indexed value. Reads go to one partition, but every write updates another partition, usually **asynchronously**, so the index can lag (DynamoDB GSIs work this way).

Habits: run `EXPLAIN` on the main queries; index foreign keys; watch out for indexes on low-cardinality columns and for unused indexes, which cost writes and memory for nothing.

## Transactions and ACID

| Letter | Means | Really guaranteed by |
| --- | --- | --- |
| **A**tomicity | All of the transaction's writes happen, or none do | WAL + rollback (abort on any error) |
| **C**onsistency | Invariants hold (balances ≥ 0, foreign keys valid) | Mostly **your** constraints and code; the database enforces only the constraints you declare |
| **I**solation | Concurrent transactions don't see each other's half-done work | Locks and/or MVCC, **at the chosen isolation level** |
| **D**urability | Committed data survives a crash | `fsync` of the WAL; replication for machine loss |

### Isolation levels and anomalies

See [Isolation anomalies](#diagram/isolation-anomalies) for lost update and write skew step by step.

| Anomaly | What happens | Example |
| --- | --- | --- |
| Dirty read | Read another transaction's uncommitted write | You see a transfer that later rolls back |
| Non-repeatable read | Read the same row twice and get different values | A report sums an account twice and gets two totals |
| Phantom | Re-run a range query and new rows appear | "Count bookings for seat 12A" changes mid-transaction |
| Lost update | Two read-modify-write cycles; one overwrites the other | Two clicks each add 1 to a counter; it only goes up by 1 |
| Write skew | Two transactions read the same data, then write **different** rows, together breaking an invariant | Two doctors both see "2 on call" and both go off call, leaving 0 |

| Level | Prevents | Default in |
| --- | --- | --- |
| Read uncommitted | Nothing much | Rarely used |
| Read committed | Dirty reads | **PostgreSQL**, Oracle, SQL Server |
| Repeatable read / snapshot isolation | + non-repeatable reads, most phantoms; Postgres also detects lost updates | **MySQL InnoDB** (its version still allows some lost updates and write skew) |
| Serializable | Everything: the result equals *some* serial order | CockroachDB, FoundationDB; opt-in elsewhere |

**MVCC** (multi-version concurrency control): writers create new row versions instead of overwriting, and each transaction reads a consistent **snapshot**. Readers never block writers. Old versions are cleaned up later (Postgres `VACUUM`; long-running transactions stop cleanup and bloat tables).

**Serializable snapshot isolation (SSI)**, which Postgres uses for `SERIALIZABLE`, runs optimistically and aborts transactions whose read/write dependencies form a cycle. So **your code must retry serialization failures**.

## Concurrency control

| Technique | How | When |
| --- | --- | --- |
| Atomic operation | `UPDATE stock SET qty = qty - 1 WHERE id = 7 AND qty > 0` | Best when the logic fits in one statement; no read-modify-write race |
| Pessimistic lock | `SELECT … FOR UPDATE`, then update, then commit | High contention, short transactions (seat holds, ledger rows). Lock rows **in a consistent order** to avoid deadlocks |
| Optimistic (CAS / version) | Read `version = 5`; `UPDATE … SET …, version = 6 WHERE id = ? AND version = 5`; if 0 rows changed, retry | Low contention, long user "think time" (editing a profile), HTTP `If-Match` |
| Materialise the conflict | Create a row to lock, e.g. one row per (room, time slot) | Fixes write skew when there's no existing row to lock |
| Unique constraint | Let the database reject the second insert | "Username taken", idempotency keys, one booking per seat |

**Deadlocks:** T1 locks A then wants B, while T2 locks B then wants A. Databases detect the cycle and abort one transaction. Prevent deadlocks by locking in a fixed order and keeping transactions short. Never call a remote service while holding a database lock.

### Distributed locks and fencing

A lock service (Redis, etcd, ZooKeeper) grants a **lease**: a lock with a TTL, so a crashed holder can't block everyone forever. The danger: the holder pauses (a GC pause, a VM migration), its lease expires, someone else gets the lock, and then the first holder wakes up and writes anyway.

The fix is a **fencing token**: the lock service hands out an increasing number with each grant, and the storage system **rejects writes carrying a token older than the newest one it has seen**. Without fencing, a distributed lock is only an optimisation. Use it to avoid duplicate work, never to guarantee correctness. Redis-based locks (Redlock) don't give you fencing tokens; etcd and ZooKeeper do (revision / zxid).

## Data modelling

- **Normalise** (each fact stored once, joined at read time) for write correctness and flexibility. **Denormalise** (copy data to where it's read) for read speed at scale. You then pay for keeping the copies in sync, usually with events.
- **Model for access patterns** in NoSQL. Write down the queries first, then design keys so each query is one partition read. In Cassandra, the partition key decides *where* data lives and the clustering key decides *the order within the partition*. Keep partitions bounded (e.g. bucket chat messages by `(channel_id, month)`).
- **Avoid N+1 queries:** fetching 50 posts and then each author separately is 51 round trips. Batch them (`WHERE id IN (…)`) or use a loader.
- **Pagination:** `OFFSET 100000` scans and throws away 100k rows, and pages shift when rows are inserted. **Cursor / keyset pagination** (`WHERE (created_at, id) < (?, ?) ORDER BY … LIMIT 50`) is O(page) and stable.
- **Soft deletes, audit history and event sourcing:** append facts and derive state when you need history or auditability (ledgers, collaborative editing). The cost is more complex reads and snapshots.

## Time, clocks and ordering

- **Physical clocks drift.** Quartz drifts ~10–100 ppm (up to ~8 s per day at the high end). NTP keeps servers within ~1–10 ms, on a bad day ~100 ms, and it can **step the clock backwards**. Never order events across machines by wall-clock time, and measure durations with a **monotonic clock**.
- **Last-writer-wins by timestamp silently drops writes** when clocks disagree. That's acceptable for a cache, not for money.
- **Lamport clocks:** a counter that each node increments on every event and sets to `max(local, received) + 1` on each message. It gives a total order consistent with causality. It can't tell you whether two events were concurrent.
- **Vector clocks:** one counter per node. They detect concurrency: if neither vector dominates the other, the writes conflict and the app must merge them (Dynamo-style stores; see the Key-Value Store topic).
- **Hybrid logical clocks (HLC):** physical time plus a logical counter. Close to wall time, and causally ordered (CockroachDB, YugabyteDB).
- **TrueTime (Spanner):** GPS and atomic clocks give an uncertainty interval, and a commit *waits out* the uncertainty (~7 ms) so timestamps are globally ordered. You buy external consistency with hardware and latency.

## Failure models

- **Partial failure** is what makes distributed systems hard. One node, link or disk fails while the rest keep running.
- **You can't distinguish slow from dead.** A timeout means "no answer yet", not "didn't happen". The request may have succeeded. That's why retries need idempotency.
- **Crash-stop / crash-recovery:** most designs assume nodes crash and maybe come back with their disk intact. **Byzantine** faults (lying or malicious nodes) matter only for blockchains and some aerospace systems.
- **Gray failures:** a node passes health checks but serves errors or is 10× slower. Detect them with passive outlier detection and client-side latency tracking.
- **Process pauses:** GC, swapping and VM steal can freeze a process for seconds. Any "I'm the leader" belief must be re-checked, and fenced.
- **Split brain:** two nodes both believe they're the leader. Prevent it with majority quorums and fencing, never with "the other side didn't answer, so I'm in charge".

## Consensus

See [Raft: election and log replication](#diagram/raft).

**Consensus** gets a group of nodes to agree on a value, or on a sequence of values (a replicated log), despite crashes and message loss. Uses:
- **Leader election:** which node is the Kafka controller, the database primary, or the scheduler leader.
- **Configuration and service discovery** (etcd for Kubernetes).
- **Distributed locks with fencing**, and unique ID allocation.
- **Strongly consistent replicated stores** (Spanner, CockroachDB and TiKV run a Raft group per data range).

### Raft in five points

1. **Terms:** time is divided into numbered terms, with at most one leader per term. A node that sees a higher term steps down.
2. **Election:** a follower that hears no heartbeat within a **randomised timeout** (150–300 ms) becomes a candidate, increments the term, votes for itself and asks for votes. A node votes once per term, and only for a candidate whose log is **at least as up to date** as its own. A **majority** wins.
3. **Log replication:** clients send writes to the leader, which appends them to its log and sends `AppendEntries` to followers.
4. **Commit:** once a **majority** has stored an entry, the leader marks it committed, applies it to its state machine and replies to the client. Followers apply it later.
5. **Safety:** any two majorities overlap, so a new leader always has every committed entry.

**Cluster size:** 2f + 1 nodes tolerate f failures. 3 nodes tolerate 1, 5 tolerate 2. Even sizes add cost without adding tolerance. Every write needs a majority round trip, so consensus clusters stay **small (3–5 nodes)** and are used for **metadata and coordination**, not bulk data (unless sharded into many groups). **Paxos** solves the same problem (ZooKeeper's ZAB is a close relative). **FLP** proves no algorithm can guarantee progress in a fully asynchronous network, so real systems rely on timeouts.

## Distributed transactions

See [2PC vs saga](#diagram/two-phase-commit).

### Two-phase commit (2PC)

1. **Prepare:** the coordinator asks every participant "can you commit?". Each one durably writes the change plus a "prepared" record, holds its locks, and votes yes or no.
2. **Commit / abort:** if every vote is yes, the coordinator logs the decision and tells everyone to commit. Otherwise it tells everyone to abort.

The weakness: **blocking**. A participant that voted yes **must wait** for the decision while still holding locks. If the coordinator dies at that moment, the participants are stuck until it recovers. 2PC also costs extra round trips and fsyncs, and every participant must be up. It's used inside one database system (Spanner, CockroachDB, XA between databases and queues), rarely across independent services.

### Sagas

A saga splits a business transaction into **local transactions**, each paired with a **compensating action** that semantically undoes it (refund a charge, release a reservation). If step 3 fails, run the compensations for steps 2 and 1.

- **Orchestration:** a central coordinator (a workflow engine such as Temporal or Step Functions) drives the steps. Easier to follow, test and monitor.
- **Choreography:** each service reacts to the previous one's events. Looser coupling, but the flow is hard to see once it has more than a few steps.
- Sagas give **no isolation**: other requests can see intermediate states. Design for that with pending statuses, semantic locks, or by putting the step that can fail first.
- Every step and compensation must be **idempotent and retryable**. Pair sagas with the **transactional outbox** (see Building Blocks) so "update my DB and emit an event" is atomic.

## Delivery semantics and idempotency

| Guarantee | How | Risk |
| --- | --- | --- |
| At most once | Send once, never retry | Messages lost |
| At least once | Retry until acknowledged | **Duplicates**, which is the normal case for queues, webhooks and retries |
| Exactly once | At least once + **idempotent processing** (dedupe by ID, or atomically commit the output with the input offset) | Only within one system's boundary; end to end, it's at least once + dedupe |

Making operations idempotent:
- **Natural idempotency:** `SET status = 'shipped'`, `PUT`, upserts.
- **Idempotency keys:** store `(key → result)` in the same transaction as the effect, and return the stored result for repeats.
- **Dedupe tables / processed-message IDs**, with a TTL longer than the longest retry window.
- **Conditional writes:** version checks, `INSERT … ON CONFLICT DO NOTHING`.

## Generating unique IDs

See [ID generation](#diagram/id-generation).

| Scheme | Size | Sortable by time | Coordination | Notes |
| --- | --- | --- | --- | --- |
| DB auto-increment | 64 bit | Yes | Single writer | Simple; a bottleneck and single point of failure at scale; leaks your volume to competitors |
| Ticket server / range allocation | 64 bit | Roughly | Fetch a block of 1,000 IDs at a time | Few round trips; gaps after a crash |
| UUIDv4 | 128 bit | No | None | Random inserts hurt B-tree locality and cache hit rate |
| **UUIDv7** / ULID | 128 bit | Yes (ms prefix) | None | **Good default today**: unique without coordination and index-friendly |
| **Snowflake** | 64 bit | Yes (ms) | Assign each worker a unique ID once | 41 b time + 10 b worker + 12 b sequence = 4,096 IDs/ms/worker; breaks if the clock moves backwards |
| Hash of content | 128–256 bit | No | None | Deduplication (file chunks, content-addressed storage) |
| base62 short codes | 6–8 chars | No | Counter or random + collision check | URL shorteners: 62⁷ ≈ 3.5 × 10¹² |

## Partitioning with hashing

- **`hash(key) mod N`:** an even spread, but changing N moves ~all keys.
- **Consistent hashing:** nodes and keys sit on a ring, and each key belongs to the next node clockwise. Adding a node moves ~1/N of keys. **Virtual nodes** (100–256 per server) smooth out the load and let bigger machines take more (see the Distributed Cache topic).
- **Rendezvous (highest random weight) hashing:** for each key, score every node with `hash(key, node)` and pick the highest. Also moves only ~1/N, with no ring to maintain. Good for small node sets.
- **Jump consistent hash:** no memory, perfectly even, but nodes can only be added or removed at the end. Good for numbered shards.
- **Fixed many partitions:** create 1,024 logical partitions up front and map partitions → nodes. Rebalancing moves whole partitions, and the key → partition mapping never changes (Kafka, Elasticsearch, Couchbase).

## Probabilistic data structures

These trade a small, known error for huge memory savings.

| Structure | Answers | Memory | Error | Used for |
| --- | --- | --- | --- | --- |
| **Bloom filter** | "Is X in the set?" | ~10 bits per item for 1 % false positives | False positives only; never false negatives | Skip SSTables, "URL already crawled?", "username maybe taken" |
| Counting / cuckoo filter | Same, plus delete | A bit more than Bloom | Same | Sets that change |
| **Count-Min sketch** | "How often has X appeared?" | Width × depth counters (e.g. a few MB) | Overestimates only | Heavy hitters, trending hashtags, per-key rate limiting |
| **HyperLogLog** | "How many distinct items?" | **12 KB for billions** of items | ~0.81 % standard error | Unique visitors, distinct-count dashboards (Redis `PFADD`) |
| Top-K (heavy keeper, space-saving) | "What are the K most frequent?" | O(K) | Approximate counts | Leaderboards over streams |
| t-digest / HDR histogram | "What's the p99?" | KBs | Bounded relative error | Latency percentiles that can be merged across hosts |

**Bloom filter sizing:** for *n* items and false-positive rate *p*, bits m ≈ −n·ln p / (ln 2)² and hash functions k ≈ (m/n)·ln 2. So 1 % needs ~9.6 bits per item and 7 hashes, and 0.1 % needs ~14.4 bits per item.

### Other structures that come up

- **Skip list:** a sorted linked list with express lanes, O(log n). Redis sorted sets and many memtables use one.
- **Merkle tree:** a hash tree over data ranges. Compare the roots, then walk down only the branches that differ, to find divergent replicas cheaply (anti-entropy in Dynamo and Cassandra; Git; certificate transparency).
- **Trie:** a prefix tree for autocomplete (see the Search Autocomplete topic).
- **Geohash / quadtree / S2 / H3:** turn 2-D locations into 1-D keys or cells for proximity search.
- **Ring buffer:** a fixed-size circular queue for bounded logs, metrics windows and lock-free producer/consumer queues.
- **Inverted index, LSM, B-tree:** see above.

## Performance maths

- **Little's law:** *L = λ × W*. Concurrent requests in flight = arrival rate × time in system. At 2,000 req/s and 50 ms latency, 100 requests are in flight. That sizes **thread pools and connection pools**: a DB pool of 20 connections at 5 ms per query caps out at ~4,000 queries/s.
- **Queueing:** as utilisation ρ approaches 1, waiting time grows like 1/(1 − ρ). At 50 % busy the queueing delay ≈ 1× the service time, at 90 % ≈ 9×, at 99 % ≈ 99×. **Run at 60–70 % utilisation at peak** so bursts don't turn into latency spikes.
- **Amdahl's law:** if 10 % of the work is serial, no amount of parallelism gives more than a 10× speedup. Hunt down the serial bottleneck (a single lock, the primary, one hot partition).
- **Tail at scale:** fan-out multiplies tail latency (see Networking Fundamentals). Hedge requests, set deadlines, and cut the fan-out.
- **Batching:** amortises per-request overhead (syscalls, fsyncs, round trips) at the cost of latency. Kafka producers, group commit and DataLoader all batch.

## APIs and serialization

### API styles

| | REST (JSON over HTTP) | gRPC (Protobuf over HTTP/2) | GraphQL |
| --- | --- | --- | --- |
| Best for | Public APIs, CRUD resources, cacheable reads | Internal service-to-service calls, streaming, polyglot microservices | Client-driven data fetching across many entities (mobile, BFF) |
| Contract | OpenAPI (optional) | `.proto` file (required), generated clients | Schema (required) |
| Payload | Text, human-readable | Binary, 3–10× smaller, faster to parse | JSON |
| Streaming | SSE / WebSocket alongside | Built in: server, client and bidirectional streams | Subscriptions |
| HTTP caching | Easy (GET + Cache-Control / ETag) | Hard | Hard (usually POST); use persisted queries |
| Gotchas | Over- and under-fetching, chatty clients | Browsers need gRPC-Web; needs L7 load balancing | N+1 resolvers, expensive queries (limit depth and cost) |

API design habits:
- Use nouns for resources, plural collections and **cursor pagination**.
- Return consistent error bodies, with machine-readable codes.
- Accept **idempotency keys** on POST.
- Version with `/v1` or a header, and only change in **additive** ways within a version.
- Send rate-limit headers (`RateLimit-Remaining`, `Retry-After`).
- Use `202 Accepted` + a status URL for long jobs.

### Serialization formats and schema evolution

| Format | Schema | Size / speed | Evolution |
| --- | --- | --- | --- |
| JSON | None (JSON Schema optional) | Large, slow-ish, readable | Anything goes, so readers must be defensive |
| Protobuf / Thrift | Required, numbered fields | Small, fast | Add fields with new numbers; never reuse or renumber; removed fields become `reserved` |
| Avro | Required; writer's schema travels with the data or sits in a registry | Small; no field tags | Reader and writer schemas resolved by name; defaults needed for added fields |
| MessagePack / CBOR | None | Binary JSON | Same as JSON |
| Parquet / ORC | Columnar files | Excellent compression for analytics | Add nullable columns |

**Compatibility:** *backward* means new readers can read old data, and *forward* means old readers can read new data. Rolling deploys run old and new code side by side, so you need **both**. Add fields as optional with defaults, never change a field's type or meaning, and use a **schema registry** to enforce the rules for Kafka topics.

## Batch and stream processing

- **Batch** (Spark, warehouse SQL) processes a bounded dataset. It's simple, cheap and easy to re-run, but the results are hours old.
- **Stream** (Flink, Kafka Streams) processes unbounded events continuously, with results in seconds. It's harder: state, late events, exactly-once.
- **Event time vs processing time:** events arrive late and out of order (a phone offline on a plane). **Windows** (tumbling, sliding, session) group by event time. **Watermarks** say "I've probably seen everything before time T", and allowed lateness decides what happens to stragglers.
- **Lambda architecture** runs both a stream path (fast, approximate) and a batch path (slow, exact) that overwrites it. **Kappa** uses the stream path only, and re-processes by replaying the log. See the Ad Click Aggregator topic.

## Security basics every design needs

- **AuthN vs AuthZ:** who you are (passwords, OAuth 2.0 / OIDC, passkeys) vs what you may do (RBAC, ABAC, per-resource ACLs). Check authorisation **on every request, server-side**, at the object level ("can user 7 read order 99?").
- **Sessions vs tokens:** server sessions (an opaque ID in a cookie, state in Redis) revoke instantly. **JWTs** are verified without a lookup, but can't be revoked before they expire. Keep them short-lived (5–15 min) and pair them with refresh tokens.
- **Passwords:** hash with a slow, salted function (Argon2id, bcrypt, scrypt). Never use plain SHA-256.
- **Encryption:** in transit (TLS everywhere, mTLS inside), at rest (disk/KMS encryption; envelope encryption for sensitive fields). Keep secrets in a secrets manager, never in code or env files in Git.
- **Least privilege:** scoped IAM roles per service, private subnets, short-lived credentials.
- **Abuse:** rate limits, input validation, protection against SSRF in URL fetchers (block internal IP ranges, as the Web Crawler topic does), and audit logs for sensitive actions.

## Common interview follow-ups

- **B-tree or LSM for this workload?** State the read/write ratio and the access pattern. Write-heavy and append-only → LSM. Read-heavy with ranges and transactions → B-tree.
- **What isolation level do you need, and what anomaly worries you?** Name it (lost update on a counter, write skew on seat booking). Then fix it with an atomic update, `SELECT FOR UPDATE`, a unique constraint, or serializable isolation with retries.
- **How do two services stay consistent without 2PC?** A saga with compensations, the outbox for reliable events, and idempotent consumers. Accept and design for intermediate states.
- **Why 3 or 5 nodes for etcd / ZooKeeper, not 4?** Majority quorums: 4 tolerates the same single failure as 3, at more cost.
- **How do you stop a paused ex-leader from corrupting data?** Leases plus fencing tokens checked by the storage layer.
- **How would you count unique daily visitors across 1 B events?** HyperLogLog per day (12 KB each), mergeable across shards and days. Use exact counts only where billing depends on them.
- **Your service runs at 90 % CPU and latency is spiking. Why?** Queueing: utilisation near 1 makes waiting time explode. Add capacity, shed load, or cut the service time.
