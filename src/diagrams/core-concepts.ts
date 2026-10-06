import { Diagram, Sequence, type DiagramSpec } from "./dsl";

function storageEngines() {
  return new Diagram("Storage engines: B-tree vs LSM", "Both log every write first; they differ in how data is organised afterwards", { icons: false })
    .zone("B-tree (PostgreSQL, InnoDB): update pages in place", ["bw", "wal1", "root", "inner1", "inner2", "leaf1", "leaf2", "leaf3"], "#1971c2")
    .zone("LSM tree (Cassandra, RocksDB): append, then merge in the background", ["lw", "wal2", "mem", "l0a", "l0b", "l1", "l2"], "#e67700")
    .node("bw", "Write: UPDATE id = 42", 0, 1, "client")
    .node("wal1", "WAL (fsync)", 1, 0.2, "storage", { detail: "sequential append" })
    .node("root", "Root page", 2, 0, "db", { detail: "in buffer pool" })
    .node("inner1", "Inner page", 1.5, 1.1, "db", { detail: "keys 1–5,000" })
    .node("inner2", "Inner page", 2.5, 1.1, "db", { detail: "keys 5,001–…" })
    .node("leaf1", "Leaf 1–40", 1, 2.1, "db")
    .node("leaf2", "Leaf 41–80", 2, 2.1, "db", { detail: "row 42 rewritten in place", highlight: true })
    .node("leaf3", "Leaf …", 3, 2.1, "db")
    .edge("bw", "wal1", "1. log")
    .edge("bw", "root", "2. descend", { via: [[1, 0.9]] })
    .edge("root", "inner1")
    .edge("root", "inner2", undefined, { none: true })
    .edge("inner1", "leaf1", undefined, { none: true })
    .edge("inner1", "leaf2")
    .edge("inner2", "leaf3", undefined, { none: true })
    .panel(
      "B-tree trade-offs",
      ["3–4 levels cover billions of rows (fanout ~500)", "Fast point reads and range scans", "Random writes; page splits", "Simple locking: one place per key"],
      3.6,
      0.4,
      { width: 330, tone: "info" },
    )

    .node("lw", "Write: PUT k = v", 0, 4, "client")
    .node("wal2", "Commit log (fsync)", 1, 3.3, "storage", { detail: "sequential append" })
    .node("mem", "Memtable", 1, 4.6, "cache", { detail: ["sorted, in memory", "skip list / red-black tree"] })
    .node("l0a", "SSTable (L0)", 2, 4, "db", { detail: "newest, immutable" })
    .node("l0b", "SSTable (L0)", 2, 5.1, "db", { detail: "older" })
    .node("l1", "Level 1", 3, 4.5, "db", { detail: "10× bigger, no overlap" })
    .node("l2", "Level 2", 4, 4.5, "db", { detail: "10× bigger again" })
    .edge("lw", "wal2", "1. log")
    .edge("lw", "mem", "2. insert")
    .edge("mem", "l0a", "3. flush when full", { async: true })
    .edge("l0a", "l1", "compaction", { async: true })
    .edge("l0b", "l1", undefined, { async: true })
    .edge("l1", "l2", "compaction", { async: true })
    .panel(
      "Read path for key k",
      ["Memtable", "Each SSTable newest → oldest", "Bloom filter per SSTable skips ~99 % of files", "Block index + block cache find the row", "Deletes are tombstones until compaction"],
      5,
      3.3,
      { width: 340, numbered: true },
    )
    .panel(
      "LSM trade-offs",
      ["Very high write throughput (sequential I/O)", "Reads may touch several files", "Compaction costs I/O and space", "Great for writes, time series, huge datasets"],
      5,
      5,
      { width: 340, tone: "warn" },
    )
    .build();
}

function isolation() {
  return new Sequence("Isolation anomalies", "Two classic races that snapshot isolation alone does not stop, and how to fix each one", { gap: 380 })
    .actor("t1", "Transaction A", "service")
    .actor("db", "Database", "db")
    .actor("t2", "Transaction B", "service")
    .phase("Lost update: two read-modify-write cycles on one row")
    .msg("t1", "db", "SELECT likes FROM post WHERE id = 1  → 10")
    .msg("t2", "db", "SELECT likes FROM post WHERE id = 1  → 10")
    .msg("t1", "db", "UPDATE post SET likes = 11; COMMIT")
    .msg("t2", "db", "UPDATE post SET likes = 11; COMMIT", { error: true })
    .note("Two likes, but the count only rose by one. Fix: atomic UPDATE likes = likes + 1, SELECT … FOR UPDATE, or an optimistic version check.", ["t1", "t2"], "bad")
    .phase("Write skew: same reads, different rows, broken invariant")
    .note("Invariant: at least one doctor on call. Alice and Bob are both on call.", ["t1", "t2"], "info")
    .msg("t1", "db", "SELECT count(*) WHERE on_call  → 2 (Alice)")
    .msg("t2", "db", "SELECT count(*) WHERE on_call  → 2 (Bob)")
    .msg("t1", "db", "UPDATE doctors SET on_call = false WHERE name = 'Alice'; COMMIT")
    .msg("t2", "db", "UPDATE doctors SET on_call = false WHERE name = 'Bob'; COMMIT", { error: true })
    .note("Each transaction wrote a different row, so there's no write-write conflict to detect. Result: nobody on call.", ["t1", "t2"], "bad")
    .phase("Fixes for write skew")
    .alt("lock the rows you read")
    .msg("t1", "db", "SELECT … WHERE on_call FOR UPDATE (locks Alice + Bob)")
    .msg("t2", "db", "SELECT … FOR UPDATE: blocks until A commits, then sees count = 1 and refuses")
    .else("SERIALIZABLE isolation (SSI)")
    .msg("db", "t2", "ERROR: could not serialize access, retry the transaction", { error: true })
    .else("materialise the conflict")
    .msg("t1", "db", "lock a shared row (e.g. one row per shift) or use a unique constraint")
    .end()
    .build();
}

function raft() {
  return new Sequence("Raft: election and log replication", "A five-node cluster tolerates two failures; every decision needs a majority of three", { gap: 230 })
    .actor("client", "Client", "client")
    .actor("n1", "Node 1", "service", { icon: "server" })
    .actor("n2", "Node 2", "service", { icon: "server" })
    .actor("n3", "Node 3", "service", { icon: "server" })
    .actor("n4", "Node 4", "service", { icon: "server" })
    .actor("n5", "Node 5", "service", { icon: "server" })
    .phase("Leader election (term 7 → 8)")
    .note("No heartbeat from the old leader within Node 1's randomised timeout (150–300 ms).", ["n1", "n5"], "info")
    .msg("n1", "n1", "term = 8, become candidate, vote for self")
    .par("RequestVote(term 8, lastLogIndex 41, lastLogTerm 7)", "n1", "n5")
    .msg("n1", "n2", "RequestVote")
    .msg("n1", "n3", "RequestVote")
    .msg("n1", "n4", "RequestVote")
    .end()
    .msg("n2", "n1", "vote granted (my log isn't newer)", { reply: true })
    .msg("n3", "n1", "vote granted", { reply: true })
    .msg("n1", "n1", "3 of 5 votes: majority, so I'm leader for term 8")
    .msg("n1", "n5", "AppendEntries heartbeat (term 8) to everyone", { async: true })
    .phase("Log replication")
    .msg("client", "n1", "SET x = 5")
    .msg("n1", "n1", "append entry 42 (term 8) to the local log")
    .par("AppendEntries(prevIndex 41, entry 42)", "n1", "n5")
    .msg("n1", "n2", "AppendEntries #42")
    .msg("n1", "n3", "AppendEntries #42")
    .msg("n1", "n5", "AppendEntries #42")
    .end()
    .msg("n2", "n1", "ok", { reply: true })
    .msg("n3", "n1", "ok", { reply: true })
    .msg("n1", "n1", "stored on 3 of 5 → entry 42 committed; apply to state machine")
    .msg("n1", "client", "OK", { reply: true })
    .msg("n1", "n5", "next heartbeat carries commitIndex = 42; followers apply it", { async: true })
    .note("Node 4 is partitioned and Node 5 is slow. Neither blocks progress. When Node 4 returns with an old term, it steps down and the leader backfills its log.", ["n4", "n5"])
    .note("Safety: any two majorities overlap, so every future leader already has entry 42.", ["n1", "n3"], "good")
    .build();
}

function twoPhaseCommit() {
  return new Sequence("2PC vs saga", "Atomic commit across participants, and the compensating alternative used between services", { gap: 280 })
    .actor("coord", "Coordinator", "service")
    .actor("orders", "Orders DB", "db")
    .actor("payments", "Payments", "service", { icon: "credit-card" })
    .actor("inventory", "Inventory", "service", { icon: "warehouse" })
    .phase("Two-phase commit")
    .msg("coord", "coord", "log BEGIN txn 991")
    .par("phase 1: prepare", "coord", "inventory")
    .msg("coord", "orders", "PREPARE 991")
    .msg("coord", "payments", "PREPARE 991")
    .msg("coord", "inventory", "PREPARE 991")
    .end()
    .note("Each participant writes the change and a 'prepared' record durably, keeps its locks, and votes. After voting yes it cannot back out on its own.", ["orders", "inventory"], "info")
    .msg("orders", "coord", "YES", { reply: true })
    .msg("payments", "coord", "YES", { reply: true })
    .msg("inventory", "coord", "YES", { reply: true })
    .msg("coord", "coord", "log COMMIT 991 (the decision point)")
    .par("phase 2: commit", "coord", "inventory")
    .msg("coord", "orders", "COMMIT")
    .msg("coord", "payments", "COMMIT")
    .msg("coord", "inventory", "COMMIT")
    .end()
    .note("If the coordinator crashes after PREPARE, participants are stuck holding locks until it recovers: 2PC is a blocking protocol.", ["coord", "inventory"], "bad")
    .phase("Saga (orchestrated): local transactions + compensations")
    .msg("coord", "orders", "create order (PENDING); commit locally")
    .msg("coord", "payments", "charge card (idempotency key) → ok")
    .msg("coord", "inventory", "reserve items → OUT OF STOCK", { error: true })
    .break("compensate completed steps in reverse order")
    .msg("coord", "payments", "refund charge (idempotent)")
    .msg("coord", "orders", "mark order CANCELLED")
    .end()
    .note("No locks are held across services, but other requests can see the PENDING order. Steps and compensations must be idempotent; use the outbox for reliable events.", ["coord", "inventory"], "warn")
    .build();
}

function idGeneration() {
  return new Diagram("ID generation", "Unique IDs without a single bottleneck: Snowflake layout and the alternatives")
    .table(
      "snow",
      "Snowflake ID (64 bits)",
      [
        "bit  63      : 0 (sign, keeps IDs positive)",
        "bits 62–22   : 41 b  ms since custom epoch (~69 years)",
        "bits 21–12   : 10 b  worker id (1,024 workers)",
        "bits 11–0    : 12 b  sequence (4,096 per ms per worker)",
        "",
        "id = (ts - epoch) << 22 | worker << 12 | seq",
      ],
      0,
      0,
      { kind: "service" },
    )
    .node("zk", "Coordination (etcd / ZooKeeper)", 0.4, 2.1, "edge", { detail: "hands out worker ids once, at startup" })
    .node("w1", "ID worker 1", 1.6, 1.6, "service", { detail: "worker = 1" })
    .node("w2", "ID worker 2", 1.6, 2.6, "service", { detail: "worker = 2" })
    .node("app", "App servers", 2.8, 2.1, "client", { detail: "or embed the generator as a library" })
    .edge("zk", "w1", "lease id", { async: true })
    .edge("zk", "w2", "lease id", { async: true })
    .edge("app", "w1", "next id", { both: true })
    .edge("app", "w2", undefined, { both: true })
    .panel(
      "Snowflake failure modes",
      [
        "Clock moves backwards → duplicate IDs: refuse to issue, or wait it out",
        "Two workers with the same id → duplicates: lease ids, fence on restart",
        "Over 4,096 IDs in one ms: spin until the next ms",
        "IDs reveal creation time and roughly your volume",
      ],
      2.6,
      0,
      { width: 400, tone: "warn" },
    )
    .panel(
      "Choosing a scheme",
      [
        "One database, modest scale: auto-increment / sequence",
        "Default for new systems: UUIDv7 or ULID (time-ordered, no coordination)",
        "Need 64-bit, k-sorted, very high rate: Snowflake",
        "Short public codes: counter ranges or random base62 + uniqueness check",
        "Dedup by content: SHA-256 of the bytes",
      ],
      0,
      3.3,
      { width: 470, tone: "info" },
    )
    .panel(
      "Why random IDs hurt B-trees",
      [
        "UUIDv4 inserts land on random leaf pages",
        "More page splits, a cold buffer pool, a bigger index",
        "Time-ordered IDs append to the right-most page",
      ],
      1.65,
      3.3,
      { width: 380 },
    )
    .build();
}

export default [
  { id: "storage-engines", name: "B-tree vs LSM", build: storageEngines },
  { id: "isolation-anomalies", name: "Isolation anomalies", build: isolation },
  { id: "raft", name: "Raft consensus", build: raft },
  { id: "two-phase-commit", name: "2PC vs saga", build: twoPhaseCommit },
  { id: "id-generation", name: "ID generation", build: idGeneration },
] satisfies DiagramSpec[];
