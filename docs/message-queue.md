# Distributed Message Queue

> Design Kafka: a durable, horizontally scalable log that producers append to and many independent consumers read at their own pace.

## Requirements

### Functional
- Producers publish messages to **topics**; consumers subscribe and read them.
- Multiple independent **consumer groups** each see every message. Within a group, each message is processed by one consumer.
- Messages are **retained** for a configurable time (e.g. 7 days) and can be **replayed**.
- Ordering guaranteed for messages with the same key.

### Non-functional
- **High throughput:** millions of messages/s; scale by adding brokers.
- **Durability:** no loss of acknowledged messages when a broker fails.
- **Low latency:** single-digit ms end to end in the common case.
- Configurable delivery semantics: at-most-once, at-least-once, exactly-once.

## Estimation

| Metric | Assumption | Result |
| --- | --- | --- |
| Ingest | 1 M msg/s × 1 KB | 1 GB/s in, ×3 replication = 3 GB/s of disk writes |
| Retention | 7 days | ~600 TB × 3 replicas ≈ 1.8 PB |
| Brokers | ~20 TB per broker | ~90 brokers, or fewer with tiered storage to S3 |

## Core concepts

| Concept | Meaning |
| --- | --- |
| **Topic** | Named stream of messages |
| **Partition** | Ordered, append-only log; unit of parallelism and ordering |
| **Offset** | Position of a message in a partition |
| **Broker** | Server hosting partition replicas |
| **Leader / follower** | Each partition has one leader handling reads/writes; followers replicate |
| **ISR** | In-sync replicas: followers caught up with the leader |
| **Consumer group** | Set of consumers sharing a subscription; partitions are divided among them |

## API

```text
produce(topic, key, value, headers) → (partition, offset)
subscribe(group_id, topics)
poll(timeout)                         → batch of records
commit(offsets)                       → store progress per partition
```

## High-level design

- **Producers** choose a partition by `hash(key) mod partitions` (or round robin when there is no key) and batch messages per partition.
- **Brokers** append batches to the partition's **segment files** on disk and replicate them to followers.
- A **controller** (a KRaft Raft quorum in modern Kafka, ZooKeeper in older versions) stores cluster metadata and elects partition leaders.
- **Consumers** in a group are assigned partitions, **pull** records from the offset they last committed, and commit new offsets.
- Old segments are deleted after retention, compacted (keeping only the latest value per key), or offloaded to **tiered storage**.

## Deep dives

### Why a log on disk is fast
- **Sequential writes** to append-only segments. Disks and SSDs handle sequential I/O extremely well.
- Rely on the **OS page cache** instead of an in-process cache.
- **Zero-copy** (`sendfile`) from page cache to socket when serving consumers.
- **Batching and compression** end to end (producer → broker → consumer).
- Each partition has an **offset index** and a **time index** per segment for fast seeks.

### Replication and durability
- A follower fetches from the leader like a consumer. A follower that lags beyond a threshold is removed from the ISR.
- The **high watermark** is the highest offset replicated to all ISR members. Consumers only see messages below it.
- Producer `acks`:
  - `acks=0`: fire and forget. Fastest, and messages can be lost.
  - `acks=1`: the leader wrote it. Lost if the leader dies before replication.
  - `acks=all` with `min.insync.replicas=2`: survives one broker failure with no loss.
- Leader failure: the controller elects a new leader **from the ISR** only (unclean election disabled), so no committed data is lost.

### Consumer groups and rebalancing
- Each partition goes to exactly one consumer in the group, so parallelism is capped at the partition count.
- When consumers join or leave, the group coordinator **rebalances**. Cooperative/incremental rebalancing avoids stop-the-world pauses.
- Committed offsets are stored in an internal compacted topic (`__consumer_offsets`).

### Delivery semantics
| Semantics | How |
| --- | --- |
| At-most-once | Commit offset **before** processing |
| At-least-once (default) | Process, **then** commit, and make consumers idempotent |
| Exactly-once | **Idempotent producer** (producer ID + sequence numbers dedupe retries) + **transactions** (atomically write outputs and commit input offsets) |

### Ordering
Ordering holds within a partition only. To keep a user's events in order, key by `user_id`. Adding partitions later changes the key → partition mapping, so plan partition counts up front.

### Backpressure and slow consumers
Consumers pull, so a slow consumer just falls behind. Monitor **consumer lag** and alert on it. Retention must exceed the worst expected lag, or the consumer will miss data.

### Delayed messages, retries, DLQ
The log doesn't support per-message delay. Implement retries with **retry topics** (`orders.retry.1m`, `orders.retry.10m`) and a **dead-letter topic** for poison messages.

## Queue vs log

| | Traditional queue (RabbitMQ, SQS) | Log (Kafka, Pulsar, Kinesis) |
| --- | --- | --- |
| Message after consumption | Deleted | Retained, replayable |
| Multiple consumers | Competing consumers | Many independent groups |
| Ordering | Per queue (often relaxed) | Per partition |
| Per-message ack / delay / priority | Yes | No (offset-based) |
| Best for | Task distribution | Event streaming, CDC, analytics |

## Trade-offs

- **More partitions:** more parallelism, but more open files, longer failovers and more metadata.
- **acks=all:** durability at a few ms of extra latency.
- **Retention vs cost:** tiered storage keeps long history cheaply at a small read-latency cost.
