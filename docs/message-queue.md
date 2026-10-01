# Distributed Message Queue

> Design Kafka: a durable, horizontally scalable log that producers append to and many independent consumers read at their own pace.

## The problem in one minute

Services need to hand work and events to each other without being tightly coupled: the order service shouldn't have to wait for billing, email, search and analytics to finish before answering the user. A message queue sits in between. Producers write messages and move on; consumers process them when they can.

A **log-based** queue like Kafka goes further: it keeps messages for days, lets any number of independent consumer groups read the same stream, and lets a consumer **replay** from any point. To do that at millions of messages per second, the log is split into **partitions** spread across brokers, and each partition is **replicated**.

| Decision | Choice | Why |
| --- | --- | --- |
| Storage model | Append-only, partitioned log on disk | Sequential I/O is fast; retention and replay come for free |
| Unit of order and parallelism | The partition | Order within a key is kept; partitions scale horizontally |
| Replication | Leader + followers per partition; in-sync replica set (ISR) | No loss of acknowledged data when a broker dies |
| Metadata and leader election | A Raft quorum of controllers (KRaft) | No external ZooKeeper; fast failover |
| Consumption | Pull, with offsets tracked per consumer group | Slow consumers just fall behind; they don't slow producers |
| Delivery | At-least-once by default; exactly-once with idempotent producers + transactions | Pick per use case |

## Requirements

### Functional

- Producers publish messages to named **topics**. A message has an optional key, a value, headers, and a timestamp.
- Consumers subscribe to topics as part of a **consumer group**. Every group sees every message; inside a group, each message is processed by one consumer.
- Messages are **retained** for a configured time or size (e.g. 7 days) regardless of whether they were consumed, and can be **replayed** from any offset or timestamp.
- **Ordering** is guaranteed for messages with the same key.
- **Log compaction** (optional per topic): keep only the latest value for each key forever — useful for changelogs and state.

### Non-functional

| Property | Target |
| --- | --- |
| Throughput | Millions of messages/s per cluster; scale by adding brokers |
| Durability | No loss of acknowledged messages when any one broker fails |
| Latency | p99 produce-to-consume under ~10 ms in the common case |
| Availability | Survive broker failures and rolling upgrades without downtime |
| Scale | Thousands of topics, hundreds of thousands of partitions |

## Capacity estimation

Example: **1 M messages/s** at **1 KB** average, replication factor **3**, **7-day** retention.

- **Ingress:** 1 M × 1 KB = **1 GB/s** from producers.
- **Disk writes:** × 3 replicas = **3 GB/s** across the cluster.
- **Egress:** each consumer group reads 1 GB/s. With 3 groups plus 2 follower fetches: 3 + 2 = **5 GB/s** of network out.
- **Storage:** 1 GB/s × 86,400 × 7 ≈ **600 TB**, × 3 ≈ **1.8 PB**. With compression (lz4/zstd, often 3–5× for JSON) the real footprint is much smaller.
- **Brokers:** a broker comfortably handles ~100–200 MB/s of writes and a few hundred MB/s of reads, with maybe 20–40 TB of disk. That's roughly **30–60 brokers** for throughput; storage would need ~50–90 brokers — or far fewer with **tiered storage**, which keeps only recent segments on local disk and moves the rest to S3.
- **Partitions:** size for the peak parallelism of the biggest consumer group. If processing one message takes 5 ms, one consumer handles ~200 msg/s; for 100k msg/s on a topic you need ≥ 500 consumers, so ≥ 500 partitions.

## API

```text
// Producer
produce(topic, key, value, headers) -> Future<(partition, offset)>
flush()
beginTransaction() / sendOffsetsToTransaction() / commitTransaction()

// Consumer
subscribe(group_id, [topics])
poll(timeout)                -> [records]                // each: topic, partition, offset, key, value, ts
commitSync(offsets) / commitAsync(offsets)
seek(partition, offset) / offsetsForTimes(ts)            // replay

// Admin
createTopic(name, partitions, replication_factor, configs)
```

Important producer settings:

| Setting | Typical value | Effect |
| --- | --- | --- |
| `acks` | `all` | Wait for all in-sync replicas before acknowledging |
| `enable.idempotence` | `true` | Broker de-duplicates producer retries |
| `linger.ms` / `batch.size` | 5 ms / 64 KB | Batch messages per partition for throughput |
| `compression.type` | `zstd` or `lz4` | Compress whole batches |
| `max.in.flight.requests.per.connection` | ≤ 5 | Keeps ordering with idempotence on |

## Core concepts and data layout

| Concept | Meaning |
| --- | --- |
| Topic | A named stream, e.g. `orders` |
| Partition | One ordered, append-only log; the unit of parallelism, ordering and replication |
| Offset | A message's position in its partition (0, 1, 2 …) |
| Broker | A server that hosts partition replicas |
| Leader / follower | Each partition has one leader (serves produce and fetch) and followers that copy it |
| ISR | In-sync replicas: the leader plus followers that are caught up |
| High watermark | The highest offset copied to every ISR member; consumers only read below it |
| Consumer group | Consumers sharing a subscription; partitions are divided among them |
| Segment | A partition is stored as a series of files; only the last (active) one is written |

On disk, a partition is a directory ([Inside a partition](#diagram/partition)):

```text
orders-1/
  00000000000000000000.log        # records with offsets 0 – 4,999,999 (closed)
  00000000000000000000.index      # sparse: every ~4 KB, offset -> byte position in .log
  00000000000000000000.timeindex  # timestamp -> offset, for seek-by-time
  00000000000005000000.log        # active segment, appends go here
  00000000000005000000.index
  00000000000005000000.timeindex
  leader-epoch-checkpoint         # which leader epoch started at which offset
```

To find offset 5,000,120: pick the segment by file name (binary search), use its sparse index to jump near the right byte position, then scan forward a few records.

Retention works on whole segments: when a closed segment is older than the retention period, the file is deleted. **Compacted** topics instead rewrite old segments keeping only the latest record per key (a record with a null value, a *tombstone*, deletes the key).

## High-level architecture

See the [Architecture](#diagram/architecture) diagram.

- **Producers** choose the partition: `murmur2(key) mod partitions`, or a sticky round-robin for keyless messages. They batch records per partition and send batches to each partition's leader.
- **Brokers** append batches to the leader's active segment. Followers fetch from the leader continuously, exactly like consumers do.
- **Controllers** (three or five, in a Raft quorum) store cluster metadata — topics, partitions, replica assignments, ISR lists — and elect partition leaders when brokers fail. Brokers follow the metadata log.
- **Consumers** in a group are assigned partitions by a **group coordinator** (a broker). They **pull** batches from the offsets they last committed and commit new offsets to an internal compacted topic, `__consumer_offsets`.
- A **schema registry** stores message schemas (Avro/Protobuf) and enforces compatible evolution, so producers can't break consumers.
- **Tiered storage** offloads closed segments to object storage for cheap long retention.

## Produce path

See [Produce path](#diagram/produce-path).

1. The producer hashes the key to a partition and appends the record to that partition's in-memory batch.
2. When the batch is full (`batch.size`) or `linger.ms` passes, it sends a `ProduceRequest` to the partition leader. With idempotence on, the batch carries a **producer ID** and **sequence numbers**.
3. The leader checks the sequence numbers (rejecting gaps, acknowledging duplicates without re-appending), then appends the batch to the active segment. The write goes to the OS page cache; Kafka doesn't fsync each write, relying on replication for durability.
4. Followers fetch the new records. Each follower's fetch position tells the leader how far it has replicated.
5. When every ISR member has the batch, the leader advances the **high watermark** and (with `acks=all`) acknowledges the producer.
6. Consumers can now read the records.

### Why appending to a log is fast

- **Sequential I/O** only: no random seeks.
- The **page cache** serves recent data, so most consumer reads never touch disk.
- **Zero-copy** (`sendfile`) moves bytes from page cache to socket without copying them through the application.
- **Batching and compression** end to end: the producer compresses a batch, the broker stores it as-is, the consumer decompresses.

### Durability settings

| `acks` | Meaning | Can lose data when |
| --- | --- | --- |
| `0` | Don't wait for anything | Any failure |
| `1` | Leader wrote it | The leader dies before followers copy it |
| `all` + `min.insync.replicas=2` | All ISR members have it, and the ISR has at least 2 | Two brokers fail at the same time |

If the ISR shrinks below `min.insync.replicas`, `acks=all` producers get an error instead of silently writing to a single copy. That's the right behaviour: the application learns durability is at risk.

## Consume path and consumer groups

See [Consume & rebalance](#diagram/consume-path).

- Each partition is assigned to **exactly one consumer** in a group, so a group's parallelism is capped by the partition count. Extra consumers sit idle.
- Consumers loop: `poll` → process → commit offsets.
- **Committing** records "this group has processed partition P up to offset O". After a crash, the partition's new owner starts from the last committed offset.
- **Rebalancing** happens when consumers join, leave, or stop sending heartbeats (e.g. a long GC pause exceeds `max.poll.interval.ms`). The older *eager* protocol revoked every partition from every consumer; the **cooperative incremental** protocol only moves the partitions that change owner.
- **Static membership** (`group.instance.id`) lets a consumer restart without triggering a rebalance, which makes rolling deploys smooth.

### Delivery semantics

| Semantics | How | Risk |
| --- | --- | --- |
| At-most-once | Commit the offset **before** processing | A crash after commit loses messages |
| **At-least-once** (default) | Process, **then** commit | A crash before commit reprocesses messages → consumers must be idempotent |
| Exactly-once (within Kafka) | Idempotent producer + transactions: output records and input offsets committed atomically | Only covers effects inside Kafka |

**Making consumers idempotent** (needed for at-least-once): upsert by a natural key; keep a table of processed event IDs and skip duplicates; or store the processed offset in the same database transaction as the side effect, and seek to it on restart.

## Ordering

- Order is guaranteed **within a partition** only. To keep all events for a user in order, use `user_id` as the key.
- **Adding partitions** changes `hash(key) mod partitions`, so new messages for a key may go to a different partition than old ones, breaking per-key order across the change. Choose partition counts with headroom up front.
- **Retries can reorder** batches if several are in flight; the idempotent producer prevents this.
- Hot keys: a single very active key goes to one partition and one consumer. If that's too much, split the key (`user_42#3`) and accept losing strict order for it, or reduce per-message work.

## Replication and failure handling

See [Inside a partition](#diagram/partition).

- A follower that hasn't caught up within `replica.lag.time.max.ms` (e.g. 30 s) is removed from the ISR, so one slow broker can't stall `acks=all` writes. It rejoins when it catches up.
- When a leader dies, the controller elects a new leader **from the ISR**. Every ISR member has every committed record, so nothing acknowledged is lost.
- **Leader epochs** let followers find exactly where their log diverged from the new leader and truncate uncommitted records, instead of guessing from the high watermark.
- **Unclean leader election** (allowing an out-of-sync replica to become leader) trades data loss for availability. Keep it off for anything important.
- **Rack awareness:** place the replicas of each partition in different racks/AZs.

| Failure | Effect | Handling |
| --- | --- | --- |
| Broker dies | Its leaderships move; producers/consumers refresh metadata | Controller elects new leaders from ISR in seconds |
| Slow follower | ISR shrinks | Alert; replace or fix the broker |
| Controller dies | Metadata operations pause briefly | Raft quorum elects a new active controller |
| AZ outage | Up to one replica per partition lost | Rack-aware placement keeps a majority available |
| Consumer crashes | Its partitions pause until reassigned | Rebalance after `session.timeout.ms` |
| Consumer bug (poison message) | Consumer stuck on one message | Retry topics + dead-letter topic |
| Disk full | Broker stops accepting writes | Retention by size, tiered storage, alerts at 70 % |

## Retries, delays and dead letters

See [Retries & exactly-once](#diagram/retries).

A log has no per-message acknowledgement, delay or priority: a consumer can't skip one message and come back later without blocking the partition. The common pattern:

1. On failure, the consumer publishes the message to `orders.retry.1m` with a "not before" timestamp header, commits the original offset, and moves on.
2. A retry consumer reads `orders.retry.1m`, pauses the partition until the head message is due, and reprocesses it.
3. Repeated failures go to `orders.retry.10m`, then to `orders.dlq` (dead-letter topic).
4. The DLQ raises alerts; an operator tool inspects messages and re-publishes them after a fix.

This loses strict per-key ordering for retried messages. If ordering matters more than throughput, retry in place with backoff and block the partition instead.

## Exactly-once processing

For read-process-write pipelines entirely inside Kafka (e.g. Kafka Streams):

1. `beginTransaction()`
2. Read from the input topic and compute results.
3. Produce results to output topics.
4. `sendOffsetsToTransaction(input offsets, group)`
5. `commitTransaction()` — output records and the input offsets become visible together, or not at all.

Downstream consumers set `isolation.level=read_committed` to skip aborted records. Anything outside Kafka (an HTTP call, an email, a database write) still needs its own idempotency, because Kafka can't roll back an email.

## Queue vs log

| | Traditional queue (RabbitMQ, SQS) | Log (Kafka, Pulsar, Kinesis) |
| --- | --- | --- |
| After consumption | Message deleted | Retained until retention expires |
| Multiple readers | Competing consumers share work | Many independent groups each read everything |
| Ordering | Per queue, often relaxed | Per partition, strict |
| Per-message ack, delay, priority | Yes | No — offsets only |
| Replay | No | Yes |
| Scaling a consumer group | Add consumers freely | Capped by partition count |
| Best for | Task queues, RPC-style work distribution | Event streams, change data capture, analytics, event sourcing |

## Observability

| Metric | Why |
| --- | --- |
| **Consumer lag** per group and partition | The key health signal: how far behind consumers are, in messages and in time |
| Under-replicated partitions | Durability at risk |
| ISR shrink/expand rate | Flaky brokers or network |
| Produce/fetch request latency p99 | User-facing latency |
| Bytes in/out per broker, disk usage | Capacity planning, imbalance |
| Offline partitions | No leader: an outage for those partitions |
| Rebalance frequency | Unstable consumers |

Alert on lag measured **in time** ("billing is 5 minutes behind") rather than messages, and make sure retention is much longer than the worst lag you might see; otherwise a slow consumer loses data when old segments are deleted.

## Trade-offs to discuss

- **Partition count:** more partitions mean more parallelism, but more open files, more metadata, longer leader elections, and more memory for producer batches. Tens to a few hundred per topic is typical.
- **`acks=all` vs latency:** a few extra milliseconds per write for no data loss on single failures.
- **Retention vs cost:** long retention enables replay and backfills; tiered storage makes it cheap.
- **Kafka vs a managed queue (SQS):** SQS needs no operations and handles per-message retries and delays natively, but has no replay, no multiple consumer groups, and weaker ordering. Choose Kafka for event streams, SQS for simple job queues.
- **Pull vs push:** pull lets consumers control their pace and batch efficiently; push (RabbitMQ) gives lower latency for small volumes but needs flow control to avoid overwhelming consumers.

## Interview follow-up questions

- **How do you guarantee order for a user's events?** Key by `user_id`; idempotent producer to prevent reordering on retries; never change the partition count for that topic.
- **A consumer takes 2 seconds per message and lag grows. What do you do?** Add partitions and consumers (if order allows), process in parallel inside a consumer with per-key ordering, batch downstream writes, or move slow work to another queue.
- **How would you implement delayed messages?** Retry/delay topics per delay bucket, or a separate scheduler service (see the Job Scheduler topic).
- **How would you migrate a topic to more partitions without breaking order?** Create a new topic, dual-write or bridge, drain consumers of the old topic, then switch.
- **What happens if two consumers in a group think they own the same partition?** Generation IDs (fencing) make the coordinator reject commits from the stale owner, but its side effects may still happen twice — another reason for idempotent consumers.
