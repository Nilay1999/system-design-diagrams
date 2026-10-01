import { Diagram, Sequence, type DiagramSpec } from "./dsl";

function architecture() {
  return new Diagram("Distributed Message Queue — architecture", "Kafka-style: topics split into partitions; each partition is a replicated, append-only log")
    .zone("Controller quorum (KRaft / Raft)", ["c1", "c2", "c3"], "#1971c2")
    .zone("Brokers (RF 3)", ["b1", "b2", "b3"], "#e8590c")
    .zone("Consumer group 'billing'", ["ca1", "ca2"], "#0c8599")
    .zone("Consumer group 'analytics'", ["cb1"], "#0c8599")
    .node("c1", "Controller 1", 1.2, -1.4, "service", { w: 0.8, detail: "active" })
    .node("c2", "Controller 2", 1.95, -1.4, "service", { w: 0.8, detail: "standby" })
    .node("c3", "Controller 3", 2.7, -1.4, "service", { w: 0.8, detail: "standby" })
    .node("prod", "Producers", 0, 1, "client", { detail: ["batch per partition", "key → hash → partition"] })
    .node("schema", "Schema registry", 0, 2.4, "service", { detail: "Avro / Protobuf versions" })
    .node("b1", "Broker 1", 1.5, 0, "queue", { detail: ["P0 leader", "P1, P2 follower"] })
    .node("b2", "Broker 2", 1.5, 1, "queue", { detail: ["P1 leader", "P0, P2 follower"] })
    .node("b3", "Broker 3", 1.5, 2, "queue", { detail: ["P2 leader", "P0, P1 follower"] })
    .node("tier", "Tiered storage", 1.5, 3.3, "storage", { detail: ["S3: closed segments", "cheap long retention"] })
    .node("ca1", "Consumer 1", 3, 0.2, "worker", { detail: "owns P0, P1" })
    .node("ca2", "Consumer 2", 3, 1.2, "worker", { detail: "owns P2" })
    .node("cb1", "Consumer 1", 3, 2.6, "worker", { detail: "owns P0, P1, P2" })
    .edge("c2", "b1", "metadata, leader election", { async: true })
    .edge("prod", "b1", "produce P0")
    .edge("prod", "b2", "P1")
    .edge("prod", "b3", "P2")
    .edge("prod", "schema", "register / look up")
    .edge("b1", "b2", "follower fetch", { async: true })
    .edge("b1", "ca1", "fetch(P0, offset)")
    .edge("b2", "ca1")
    .edge("b3", "ca2")
    .edge("b3", "cb1", "every group reads everything")
    .edge("b3", "tier", "offload", { async: true })
    .panel(
      "Sizing (example)",
      ["1 M msgs/s × 1 KB = 1 GB/s in, 3 GB/s with RF 3", "7 days retention ≈ 600 TB × 3 = 1.8 PB", "~100 MB/s writes per broker → ~30 brokers (more for reads + headroom)", "Partitions ≥ peak consumer parallelism (e.g. 200)"],
      4.1,
      -0.2,
      { width: 420, tone: "info" },
    )
    .panel(
      "Guarantees",
      ["Order is per partition, never per topic", "acks=all + min.insync.replicas=2 → no loss when 1 broker dies", "Within a group, one consumer per partition", "Commit after processing → at-least-once"],
      4.1,
      1.5,
      { width: 420 },
    )
    .build();
}

function producePath() {
  return new Sequence("Produce path — acks=all, idempotent producer", "How a record becomes durable, and why a retry doesn't create a duplicate", { gap: 250 })
    .actor("p", "Producer", "client")
    .actor("l", "P1 leader (broker 2)", "queue")
    .actor("f1", "Follower (broker 1)", "queue")
    .actor("f3", "Follower (broker 3)", "queue")
    .actor("c", "Consumer", "worker")
    .msg("p", "p", "key 'user-42' → murmur2 % 3 = P1; add to P1's batch; wait linger.ms (5 ms) or 64 KB")
    .msg("p", "l", "ProduceRequest(P1, batch, producerId 7, seq 120–149, acks=all)")
    .msg("l", "l", "check seq follows 119; append to active segment (page cache); LEO = 5,000,150")
    .par("followers pull, like consumers", "l", "f3")
    .msg("f1", "l", "Fetch(P1, from offset 5,000,120)")
    .msg("l", "f1", "records 120–149", { reply: true })
    .msg("f3", "l", "Fetch(P1, from offset 5,000,120)")
    .msg("l", "f3", "records 120–149", { reply: true })
    .end()
    .msg("l", "l", "all ISR members reached 5,000,150 → high watermark = 5,000,150")
    .msg("l", "p", "ack: offsets 5,000,120–149", { reply: true })
    .msg("c", "l", "Fetch(P1, 5,000,100) → gets records only below the high watermark")
    .alt("the ack was lost and the producer retries", "p", "l")
    .msg("p", "l", "same batch again: producerId 7, seq 120–149")
    .msg("l", "p", "duplicate sequence → ack with the original offsets, no second append", { reply: true })
    .end()
    .note("A follower that falls more than replica.lag.time.max.ms (30 s) behind is dropped from the ISR, so one slow broker can't stall acks=all writes.", ["l", "f3"], "info")
    .build();
}

function consumePath() {
  return new Sequence("Consume path & rebalancing", "Consumers pull at their own pace and commit offsets; the group coordinator divides partitions", { gap: 250 })
    .actor("c1", "Consumer 1", "worker")
    .actor("c2", "Consumer 2 (new)", "worker")
    .actor("gc", "Group coordinator", "service")
    .actor("b", "Partition leaders", "queue")
    .actor("db", "Side effects (DB)", "db")
    .loop("steady state: c1 owns P0, P1, P2", "c1", "db")
    .msg("c1", "b", "Fetch(P0 @ 812, P1 @ 77, P2 @ 1,904), max 1 MB")
    .msg("b", "c1", "batch of records (zero-copy from page cache)", { reply: true })
    .msg("c1", "db", "process: idempotent upsert keyed by (partition, offset) or event id")
    .msg("c1", "gc", "commit offsets → __consumer_offsets topic")
    .end()
    .phase("A consumer joins (cooperative incremental rebalance)")
    .msg("c2", "gc", "JoinGroup('billing')")
    .msg("gc", "c1", "rebalance: please rejoin")
    .msg("c1", "gc", "JoinGroup — I currently own P0, P1, P2 (keep working meanwhile)")
    .msg("gc", "c1", "new plan: give up P2", { reply: true })
    .msg("c1", "gc", "commit P2's offset, revoke P2")
    .msg("gc", "c2", "you own P2, start at its committed offset", { reply: true })
    .msg("c2", "b", "Fetch(P2 @ 1,950)")
    .note("Only P2 pauses. Older 'eager' rebalancing stopped every consumer in the group until the new assignment was ready.", ["c1", "b"], "info")
    .build();
}

function partitionInternals() {
  return new Diagram("Deep dive — inside a partition", "A partition is a directory of segment files; replication state is tracked with offsets")
    .table(
      "log",
      "orders-1/  (on broker 2, leader)",
      [
        "00000000000000000000.log        closed, offsets 0 – 4,999,999",
        "00000000000000000000.index      sparse: offset → byte position",
        "00000000000000000000.timeindex  timestamp → offset",
        "00000000000005000000.log        ACTIVE, appends go here",
        "00000000000005000000.index",
        "00000000000005000000.timeindex",
        "leader-epoch-checkpoint         epoch → start offset",
      ],
      0,
      0,
      { kind: "queue" },
    )
    .panel(
      "Why appending to a file is fast",
      [
        "Sequential writes only: no seeks, great on SSD and HDD",
        "Writes land in the OS page cache; fsync is left to replication for durability",
        "Consumers reading recent data hit the page cache, not the disk",
        "sendfile() copies page cache → socket without entering the JVM (zero-copy)",
        "Producers compress whole batches; brokers store them as-is",
      ],
      2.35,
      0,
      { width: 470, tone: "info" },
    )
    .node("leader", "Leader (broker 2)", 0, 2.5, "queue", { detail: "log end offset 5,000,150" })
    .node("f1", "Follower (broker 1)", 1, 2.5, "queue", { detail: ["LEO 5,000,150", "in ISR"] })
    .node("f3", "Follower (broker 3)", 2, 2.5, "queue", { highlight: true, detail: ["LEO 4,998,000", "lagging > 30 s → out of ISR"] })
    .node("hw", "High watermark", 1, 3.8, "service", { detail: ["= min LEO of the ISR = 5,000,150", "consumers read below this"] })
    .edge("f1", "leader", "fetch", { async: true })
    .edge("f3", "leader", "fetch", { async: true, via: [[1, 1.8]] })
    .edge("leader", "hw", "advances")
    .panel(
      "Leader failure",
      [
        "Controller picks a new leader from the ISR only (unclean election off)",
        "Every ISR member has all committed records, so nothing acknowledged is lost",
        "Followers truncate anything above the new leader's epoch start, then re-fetch",
        "If min.insync.replicas can't be met, producers with acks=all get errors instead of silently losing data",
      ],
      3.1,
      2.2,
      { width: 470, tone: "warn" },
    )
    .build();
}

function retries() {
  return new Diagram("Retries, dead letters & exactly-once", "A log has no per-message delay or ack, so retries are modelled as more topics")
    .zone("Non-blocking retries", ["main", "worker", "r1", "rw1", "r2", "dlq"], "#e8590c")
    .node("main", "orders", 0, 0, "queue", { detail: "main topic" })
    .node("worker", "Order consumer", 1, 0, "worker", { detail: "on failure: publish to retry topic, commit, move on" })
    .node("r1", "orders.retry.1m", 2, 0, "queue", { detail: "records carry 'not before' time" })
    .node("rw1", "Retry consumer", 2, 1.2, "worker", { detail: "pause partition until due" })
    .node("r2", "orders.retry.10m", 1, 1.2, "queue", { detail: "second attempt failed" })
    .node("dlq", "orders.dlq", 0, 1.2, "queue", { highlight: true, detail: "poison messages" })
    .node("ops", "Alert + replay tool", 0, 2.4, "client", { detail: "inspect, fix, re-publish" })
    .edge("main", "worker")
    .edge("worker", "r1", "fail")
    .edge("r1", "rw1")
    .edge("rw1", "r2", "fail again")
    .edge("r2", "dlq", "after N tries")
    .edge("dlq", "ops")
    .panel(
      "Exactly-once for read → process → write (Kafka Streams / transactions)",
      [
        "beginTransaction()",
        "consume from 'orders', compute results",
        "produce results to 'invoices' (idempotent producer)",
        "sendOffsetsToTransaction(input offsets)",
        "commitTransaction()  — outputs + offsets become visible atomically",
        "Consumers of 'invoices' use isolation.level=read_committed",
        "Side effects outside Kafka (emails, HTTP) still need idempotency keys",
      ],
      2.9,
      -0.2,
      { width: 480, numbered: true, tone: "info" },
    )
    .build();
}

export default [
  { id: "architecture", name: "Architecture", build: architecture },
  { id: "produce-path", name: "Produce path", build: producePath },
  { id: "consume-path", name: "Consume & rebalance", build: consumePath },
  { id: "partition", name: "Inside a partition", build: partitionInternals },
  { id: "retries", name: "Retries & exactly-once", build: retries },
] satisfies DiagramSpec[];
