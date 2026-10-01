import { Diagram, Sequence, type DiagramSpec } from "./dsl";

const RING = { col: 2, row: 1.5, r: 300 };

function ring() {
  const d = new Diagram("Partitioning & replication", "Consistent-hash ring with virtual nodes; each key lives on the next N = 3 distinct nodes clockwise");
  const at = (angle: number) => d.onCircle(RING.col, RING.row, RING.r, angle);
  const names = ["A", "B", "C", "D", "E", "F"];
  const racks = ["rack 1", "rack 2", "rack 3", "rack 1", "rack 2", "rack 3"];
  d.circle(RING.col, RING.row, RING.r, "#2f9e44");
  names.forEach((n, i) => {
    const [c, r] = at(i * 60);
    const replica = n === "F" ? "coordinator + replica 1" : n === "A" ? "replica 2" : n === "B" ? "replica 3" : "tokens: 256 vnodes";
    d.node(n.toLowerCase(), `Node ${n}`, c, r, "db", { detail: [racks[i], replica] });
  });
  const [kc, kr] = at(270);
  d.node("key", "hash('user:42')", kc + 0.05, kr, "external", { w: 0.85 })
    .node("client", "Client", -0.5, 0.1, "client", { detail: "smart client: knows the ring" })
    .edge("client", "f", "put(user:42)")
    .edge("key", "f", "next node clockwise")
    .edge("f", "a", "replicate")
    .edge("f", "b", "replicate")
    .edge("c", "d", "gossip", { async: true, both: true })
    .panel(
      "How placement works",
      [
        "Hash each key to a point on the ring [0, 2¹²⁸)",
        "Walk clockwise; the first N distinct physical nodes (in different racks) form the preference list",
        "user:42 → F, A, B",
        "Each physical node owns ~256 small arcs (virtual nodes), so load is even and a new node takes a little from everyone",
        "Adding or removing a node moves only ~1/N of the keys",
      ],
      3.6,
      0,
      { width: 440, numbered: true, tone: "info" },
    )
    .panel(
      "Tunable consistency (N = 3)",
      ["W = 2, R = 2 → W + R > N: reads overlap the latest write", "W = 1, R = 1 → fastest, may read stale data", "W = 3 → any replica down blocks writes", "Cassandra: ONE, QUORUM, LOCAL_QUORUM, ALL"],
      3.6,
      1.9,
      { width: 440 },
    );
  return d.build();
}

function writePath() {
  return new Sequence("Write path — quorum W = 2", "put(user:42, v) with one replica temporarily down", { gap: 230 })
    .actor("client", "Client", "client")
    .actor("f", "Node F (coordinator)", "db")
    .actor("a", "Node A (replica 2)", "db")
    .actor("b", "Node B (replica 3)", "db")
    .actor("c", "Node C (fallback)", "db")
    .msg("client", "f", "put(user:42, v, context = vector clock from last read)")
    .msg("f", "f", "new clock {F:8, A:3}; append to commit log, write memtable")
    .par("send to the other replicas in parallel", "f", "c")
    .msg("f", "a", "replicate(user:42, v, clock)")
    .msg("f", "b", "replicate(user:42, v, clock)", { error: true })
    .note("B is down: the failure detector already marked it suspect, or the request times out.", "b", "bad")
    .end()
    .msg("a", "f", "ack", { reply: true })
    .msg("f", "client", "OK — 2 acks (F itself + A) ≥ W", { reply: true })
    .phase("Sloppy quorum + hinted handoff")
    .msg("f", "c", "store(user:42, v) with hint 'belongs to B'")
    .msg("c", "c", "keep in a local hints table")
    .loop("until B is back (gossip says so)", "c", "c")
    .msg("c", "c", "retry every few seconds")
    .end()
    .msg("c", "b", "hand off hinted writes", { async: true })
    .msg("c", "c", "delete hints once B acks")
    .note("If B stays down longer than the hint window (e.g. 3 h), anti-entropy with Merkle trees repairs it instead.", ["b", "c"], "info")
    .build();
}

function readPath() {
  return new Sequence("Read path — quorum R = 2 with read repair", "Replicas may disagree; the coordinator reconciles and fixes stale copies", { gap: 240 })
    .actor("client", "Client", "client")
    .actor("f", "Node F (coordinator)", "db")
    .actor("a", "Node A", "db")
    .actor("b", "Node B", "db")
    .msg("client", "f", "get(user:42), consistency = QUORUM")
    .par("full read from one replica, digest from the others", "f", "b")
    .msg("f", "a", "read(user:42)")
    .msg("f", "b", "digest(user:42)")
    .end()
    .msg("a", "f", "v2, clock {F:8, A:3}", { reply: true })
    .msg("b", "f", "digest of v1, clock {F:7, A:3}", { reply: true })
    .alt("one version's clock dominates the other", "client", "b")
    .msg("f", "client", "v2 (newest)", { reply: true })
    .msg("f", "b", "read repair: write v2", { async: true })
    .else("concurrent versions (neither clock dominates)")
    .msg("f", "client", "siblings [v2, v2'] + merged context", { reply: true })
    .msg("client", "client", "merge (e.g. union of cart items)")
    .msg("client", "f", "put(user:42, merged, context)")
    .end()
    .note("With last-write-wins instead of vector clocks, the highest timestamp simply wins — simpler, but concurrent updates are silently lost.", ["client", "b"], "warn")
    .build();
}

function storageEngine() {
  return new Diagram("Inside a storage node — LSM tree", "Writes are sequential appends; reads merge memtable and SSTables, skipping files with Bloom filters")
    .zone("Memory", ["mem", "imm", "bloom"], "#e03131")
    .zone("Disk", ["log", "l0", "l1", "l2"], "#e67700")
    .node("w", "write(k, v)", 0, 0, "client")
    .node("log", "Commit log", 1, 0, "storage", { detail: ["append-only, fsync", "replayed after a crash"] })
    .node("mem", "Memtable", 2, 0, "cache", { detail: ["sorted (skip list)", "~64 MB"] })
    .node("imm", "Immutable memtable", 3, 0, "cache", { detail: "being flushed" })
    .node("l0", "L0 SSTables", 3, 1.3, "db", { detail: "freshly flushed, may overlap" })
    .node("l1", "L1 SSTables", 3, 2.5, "db", { detail: "10× bigger, no overlap" })
    .node("l2", "L2 SSTables", 3, 3.7, "db", { detail: "10× bigger again" })
    .node("r", "read(k)", 0, 2.5, "client")
    .node("bloom", "Bloom filters + sparse index", 1.6, 2.5, "cache", { detail: ["one per SSTable", "'definitely not here' in ~1 µs"] })
    .edge("w", "log", "1. append")
    .edge("log", "mem", "2. insert")
    .edge("mem", "imm", "full")
    .edge("imm", "l0", "3. flush")
    .edge("l0", "l1", "compaction", { async: true })
    .edge("l1", "l2", "compaction", { async: true })
    .edge("r", "bloom", "memtables first, then newest → oldest")
    .edge("bloom", "l1", "only files that may hold k")
    .panel(
      "Things to explain",
      [
        "Updates never overwrite in place: a newer SSTable shadows older ones",
        "Deletes write a tombstone; compaction drops it after gc_grace (e.g. 10 days) so a replica that missed the delete can't resurrect the value",
        "Leveled compaction: less read amplification, more write amplification. Size-tiered: the opposite",
        "Bloom filter at 1 % false positives costs ~10 bits per key",
      ],
      4.2,
      0.8,
      { width: 440, tone: "info" },
    )
    .build();
}

function antiEntropy() {
  const d = new Diagram("Anti-entropy & membership", "Replicas compare Merkle trees to find the few key ranges that differ; gossip spreads membership");
  const tree = (p: string, col: number, bad: boolean) =>
    d
      .node(`${p}root`, `root ${bad ? "7c1e" : "9f3a"}`, col + 0.6, 0, "worker", { highlight: bad })
      .node(`${p}l`, "keys 0–50 %", col, 1, "worker", { w: 0.8, detail: "hash a41b" })
      .node(`${p}r`, "keys 50–100 %", col + 1.2, 1, "worker", { w: 0.8, highlight: bad, detail: `hash ${bad ? "e902" : "33d0"}` })
      .node(`${p}r1`, "50–75 %", col + 0.75, 2, "worker", { w: 0.7, detail: "hash 0bb2" })
      .node(`${p}r2`, "75–100 %", col + 1.55, 2, "worker", { w: 0.7, highlight: bad, detail: `hash ${bad ? "51fe" : "c7aa"}` })
      .edge(`${p}root`, `${p}l`, undefined, { none: true })
      .edge(`${p}root`, `${p}r`, undefined, { none: true })
      .edge(`${p}r`, `${p}r1`, undefined, { none: true })
      .edge(`${p}r`, `${p}r2`, undefined, { none: true });
  d.zone("Replica A's Merkle tree", ["aroot", "al", "ar", "ar1", "ar2"], "#0c8599");
  d.zone("Replica B's Merkle tree", ["broot", "bl", "br", "br1", "br2"], "#c92a2a");
  tree("a", 0, false);
  tree("b", 2.5, true);
  return d
    .panel(
      "Comparing trees",
      [
        "Roots differ → compare children",
        "Left halves match → skip half the keys at once",
        "Descend only into differing branches",
        "Stream just the keys in 75–100 % from A to B",
        "Cost is proportional to the differences, not the data size",
      ],
      0,
      2.9,
      { width: 400, numbered: true, tone: "info" },
    )
    .panel(
      "Gossip + failure detection",
      [
        "Every second each node sends its membership table (node → heartbeat counter, status, tokens) to a random peer",
        "News reaches all N nodes in O(log N) rounds",
        "Phi-accrual detector: suspicion rises smoothly with the time since the last heartbeat, instead of a fixed timeout",
        "Seed nodes help new nodes join; permanent removal is an explicit admin action",
      ],
      1.35,
      2.9,
      { width: 460 },
    )
    .build();
}

export default [
  { id: "ring", name: "Ring & replication", build: ring },
  { id: "write-path", name: "Write path", build: writePath },
  { id: "read-path", name: "Read path & repair", build: readPath },
  { id: "storage-engine", name: "Storage engine (LSM)", build: storageEngine },
  { id: "anti-entropy", name: "Anti-entropy & gossip", build: antiEntropy },
] satisfies DiagramSpec[];
