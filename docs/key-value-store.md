# Distributed Key-Value Store

> Build a Dynamo/Cassandra-style store: `put(key, value)` and `get(key)` across hundreds of nodes, always writable, with consistency you can tune per request.

## The problem in one minute

One machine can't hold petabytes or serve millions of operations per second, so data must be **spread** over many machines (partitioning) and **copied** to several of them (replication) so it survives failures. Once data is copied, copies can disagree, machines can fail silently, and the network can split the cluster. A Dynamo-style store answers each of these problems with a specific, well-known technique:

| Problem | Technique | Where to look |
| --- | --- | --- |
| Which node stores which key? | Consistent hashing with virtual nodes | [Ring & replication](#diagram/ring) |
| Keep data safe when nodes fail | Replicate each key on N nodes in different racks | [Ring & replication](#diagram/ring) |
| Trade latency against consistency per request | Quorums: N, W, R | [Write path](#diagram/write-path) |
| Stay writable when a replica is down | Sloppy quorum + hinted handoff | [Write path](#diagram/write-path) |
| Replicas that disagree | Vector clocks (or last-write-wins) + read repair | [Read path & repair](#diagram/read-path) |
| Replicas that missed data for a long time | Anti-entropy with Merkle trees | [Anti-entropy & gossip](#diagram/anti-entropy) |
| Who is alive? | Gossip + phi-accrual failure detector | [Anti-entropy & gossip](#diagram/anti-entropy) |
| Fast writes on disk | LSM tree: commit log → memtable → SSTables | [Storage engine](#diagram/storage-engine) |
| Fast "not found" | Bloom filter per SSTable | [Storage engine](#diagram/storage-engine) |

## Requirements

### Functional

- `put(key, value, context?)`, `get(key)`, `delete(key)`.
- Keys up to 256 bytes, values up to ~1 MB (larger blobs belong in object storage).
- Optional per-key TTL.
- Per-request consistency level (`ONE`, `QUORUM`, `ALL`, `LOCAL_QUORUM`).

### Non-functional

| Property | Target |
| --- | --- |
| Scale | Petabytes of data, millions of operations per second, hundreds to thousands of nodes |
| Availability | Always writable, even during node failures and network partitions (AP in CAP terms) |
| Latency | p99 < 10 ms for single-key reads and writes within a data centre |
| Durability | An acknowledged write survives the loss of any single node (or rack) |
| Operations | Add or remove nodes without downtime; no single point of failure; no central master |

**Not in scope:** multi-key transactions, secondary indexes, range queries across partitions. (Cassandra adds clustering keys for ranges *within* a partition — see the Chat System topic for how that is used.)

## Capacity estimation

Example: **1 PB** of data, **1 M writes/s** and **2 M reads/s**, average value 1 KB, replication factor 3.

- **Raw storage:** 1 PB × 3 replicas = 3 PB. LSM compaction needs free space (up to 50 % for size-tiered compaction, ~10 % for leveled). With 8 TB usable per node and ~60 % target fill: 3 PB ÷ (8 TB × 0.6) ≈ **625 nodes**.
- **Write bandwidth:** 1 M × 1 KB = 1 GB/s from clients; × 3 replicas = 3 GB/s cluster-wide ≈ **5 MB/s per node** of commit-log writes. SSDs handle hundreds of MB/s, so the real cost is compaction, which rewrites data several times (write amplification of 10–30× for leveled compaction).
- **Operations per node:** (1 M × 3 + 2 M × 2) ÷ 625 ≈ **11k ops/s per node**, comfortably within what one node can do.
- **Memory:** Bloom filters at 1 % false positives need ~10 bits per key. 1 PB ÷ 1 KB = 10¹² keys × 3 replicas × 10 bits ≈ 3.75 TB of filters total, ~6 GB per node. Keep them in RAM.

## API

```text
put(key, value, context?, consistency = QUORUM, ttl?) -> OK | Timeout
get(key, consistency = QUORUM)                      -> [(value, context)]   // >1 item = siblings
delete(key, context?, consistency = QUORUM)          -> OK
```

The **context** is the opaque version information (a vector clock) returned by the last `get`. Passing it back on `put` tells the store which version the client is replacing, so the store can tell an update from a concurrent write.

## Data layout

| Level | What it is |
| --- | --- |
| Ring | Hash space `[0, 2¹²⁸)` (MD5) or `[−2⁶³, 2⁶³)` (Murmur3 in Cassandra) |
| Token / vnode | A point on the ring; each physical node owns ~256 of them |
| Partition | The keys whose hashes fall between one token and the next |
| Replica set | The N distinct physical nodes clockwise from the key's hash, in different racks |
| On disk | Per node: commit log + memtable + SSTables, each SSTable with a Bloom filter, a sparse index and data blocks |

Each stored record carries: `key`, `value` (or a tombstone marker), `version` (vector clock or timestamp), and optional `ttl`.

## High-level architecture

There is no master. Every node runs the same software and can do every job:

- **Coordinator:** whichever node receives a client request (or the first replica, for a smart client) coordinates it: finds the replicas, forwards, waits for the quorum, reconciles versions.
- **Replica:** stores data for the ranges it owns.
- **Membership participant:** gossips the cluster state.

Clients either connect to any node (which then coordinates) or use a **smart client** that knows the ring and sends each request straight to a replica, saving a network hop.

## Partitioning with consistent hashing

See [Ring & replication](#diagram/ring).

1. Hash the key onto the ring.
2. Walk clockwise to the first token; the node that owns it is the first replica.
3. Keep walking until you have N **distinct physical nodes in different racks**. That is the key's **preference list** (`user:42 → F, A, B` in the diagram).

**Why virtual nodes?** With one token per node, arcs have very different sizes, so load is uneven. And when a node joins, it takes data from only one neighbour, which then does all the streaming work. With ~256 tokens per node:

- Each node owns many small arcs scattered around the ring, so load averages out.
- A new node takes a little data from *every* existing node, so rebalancing is fast and spread out.
- A more powerful machine can take more tokens.

**Adding a node** moves only about `1/N_nodes` of the data. Compare with `hash(key) mod N`, where changing N moves almost every key.

## Replication and quorums

Each key has N replicas (usually 3). A write is sent to all N, and the coordinator waits for **W** acknowledgements. A read asks replicas and waits for **R** responses.

| Setting (N = 3) | Behaviour |
| --- | --- |
| W = 2, R = 2 | W + R > N, so every read overlaps the most recent successful write. The usual default |
| W = 1, R = 1 | Fastest; reads can be stale; a write acknowledged by one node can be lost if it dies |
| W = 3, R = 1 | Fast reads, but a single replica down blocks writes |
| W = 1, R = 3 | Fast writes, slow and fragile reads |

**Caveat:** W + R > N gives "read your latest write" only when the same N nodes are used. Sloppy quorums (below) and concurrent writes weaken it. This is why Dynamo-style stores are described as *eventually consistent with tunable knobs*, not strongly consistent.

**Multiple data centres:** set N per DC (e.g. 3 in each of 2 DCs) and use `LOCAL_QUORUM` (2 of the 3 local replicas) to avoid a cross-DC round trip on every request. Remote DCs catch up asynchronously.

## Write path

See [Write path](#diagram/write-path).

1. The client sends `put(key, value, context)` to the coordinator.
2. The coordinator builds a new version: it increments its own entry in the vector clock from the context.
3. It writes locally (if it's a replica) and sends the write to the other replicas **in parallel**.
4. Each replica appends to its **commit log** (sequential write, fsynced every few ms or per write depending on the durability setting) and inserts into the **memtable**. It then acknowledges. No disk seek, no read before write.
5. As soon as W replicas have acknowledged, the coordinator answers the client. The remaining replicas continue in the background.

### Sloppy quorum and hinted handoff

If a replica in the preference list is down, a strict quorum would fail the write. Instead:

1. The coordinator writes to the **next healthy node** on the ring, with a **hint**: "this belongs to node B".
2. That node keeps the write in a hints table and keeps checking (via gossip) whether B is back.
3. When B returns, it hands the hinted writes over and deletes them.

Writes stay available through node failures. The price: for a while, a read quorum might not include the node holding the latest value.

Hints are kept only for a window (e.g. 3 hours). If a node is down longer, **anti-entropy repair** brings it up to date instead.

## Read path

See [Read path & repair](#diagram/read-path).

1. The coordinator asks one replica for the full value and others for a **digest** (a hash) to save bandwidth.
2. When R responses arrive, it compares them.
3. If they match, return the value.
4. If one version is strictly newer (its clock dominates), return it and send it to the stale replicas in the background: **read repair**.
5. If versions are **concurrent** (neither clock dominates), return all of them as **siblings** and let the client merge.

## Conflict resolution

Two clients can update the same key at the same time on different replicas (especially during a partition). The store must decide what the value is afterwards.

### Vector clocks

A vector clock is a list of `(node, counter)` pairs. Each coordinator increments its own counter when it creates a version.

- `{F:8, A:3}` **descends from** `{F:7, A:3}` — every counter is ≥. The older version can be discarded.
- `{F:8, A:3}` and `{F:7, A:4}` are **concurrent** — neither dominates. Both are kept as siblings.

The client reads both siblings, merges them in an application-specific way (for a shopping cart: union of items), and writes the result with a context that covers both. Clocks are trimmed when they get long (oldest entries dropped), which can occasionally create false conflicts but never loses a real one silently.

### Last-write-wins (LWW)

Keep the version with the highest timestamp. Cassandra does this per column. It is simple and needs no client merging, but concurrent updates are **silently lost**, and clock skew between nodes decides the winner. Fine for data where "latest wins" is the real semantics (a user's profile photo), dangerous for counters or collections.

### CRDTs

Conflict-free replicated data types (counters, sets, maps, registers) are designed so that any two versions merge into the same result regardless of order. Riak offers them as data types; they remove the need for client merge code at the cost of limited operations.

## Failure detection and membership

See [Anti-entropy & gossip](#diagram/anti-entropy).

- **Gossip:** every second, each node picks a random peer and exchanges its view of the cluster: for each node, a heartbeat counter, its status, and its tokens. Information spreads to all nodes in O(log N) rounds, without any central server.
- **Phi-accrual failure detector:** instead of a fixed timeout, each node tracks the distribution of heartbeat arrival times for each peer and computes a suspicion level φ. When φ passes a threshold (e.g. 8), the peer is considered down. This adapts to slow networks and avoids flapping.
- **Transient vs permanent failure:** a node that stops responding is only *marked down*; its data is not moved. Permanent removal (decommissioning) is an explicit operator action, because moving terabytes of data because of a 30-second network blip would be disastrous.

## Anti-entropy with Merkle trees

Read repair only fixes keys that are read. Keys that are rarely read, on a replica that missed writes, need **anti-entropy**.

1. Each replica builds a Merkle tree over each key range: leaves are hashes of small key ranges; each parent is the hash of its children.
2. Two replicas compare root hashes. If they match, the whole range is identical and nothing moves.
3. If not, they compare children and descend only into branches that differ.
4. Finally, they stream just the keys in the differing leaf ranges.

The work is proportional to the amount of difference, not to the size of the data. Operators typically run a full repair on each range at least once per `gc_grace_seconds` (see deletes below).

## Storage engine: the LSM tree

See [Storage engine (LSM)](#diagram/storage-engine).

**Writes**

1. Append to the **commit log** (for crash recovery).
2. Insert into the **memtable**, a sorted in-memory structure (skip list or red-black tree).
3. When the memtable reaches ~64 MB, freeze it and **flush** it to disk as an immutable, sorted **SSTable** (sorted string table). The commit log segment can then be deleted.
4. **Compaction** merges SSTables in the background, keeping only the newest version of each key and dropping expired data and old tombstones.

**Reads**

1. Check the memtable(s).
2. Check SSTables from newest to oldest. For each, the **Bloom filter** answers "definitely not here" or "maybe here" in about a microsecond. Only "maybe" files are read.
3. A **sparse index** (one entry per ~64 KB block) finds the right block; the block is read and searched. A **block cache** and **row cache** keep hot data in memory.

**Compaction strategies**

| Strategy | How | Good for | Cost |
| --- | --- | --- | --- |
| Size-tiered | Merge SSTables of similar size | Write-heavy workloads | Reads may check many files; needs up to 50 % free disk |
| Leveled | Levels L0, L1, L2 … each 10× bigger; SSTables in a level don't overlap | Read-heavy, update-heavy | More write amplification |
| Time-window | Group by write time; drop whole files when TTL expires | Time series with TTL | Only fits time-ordered data |

**LSM vs B-tree:** an LSM tree turns random writes into sequential ones, which makes writes very fast; the costs are compaction work and reads that may touch several files. A B-tree (PostgreSQL, InnoDB) updates in place: reads are faster and more predictable, but random writes are slower.

## Deletes and tombstones

You can't just remove a key from one replica: a replica that missed the delete would later "resurrect" the value through read repair or anti-entropy. Instead, a delete writes a **tombstone** — a special marker with a timestamp — which replicates like any other write.

Tombstones are removed by compaction only after `gc_grace_seconds` (e.g. 10 days). Repairs must run more often than that, so every replica sees the tombstone before it disappears. A workload that deletes a lot (e.g. using the store as a queue) builds up tombstones that slow reads — a well-known anti-pattern.

## Scaling operations

- **Adding a node:** it picks tokens, announces itself via gossip, and **streams** the data for its new ranges from the current owners. It serves reads for a range only after streaming finishes. Throttle streaming so it doesn't hurt live traffic.
- **Removing a node:** decommission streams its ranges to the next owners first.
- **Replacing a dead node:** a new node takes over the dead node's tokens and rebuilds its data from the other replicas.
- **Hot partitions:** a single hot key goes to only N nodes no matter how big the cluster is. Mitigate in the application: cache it, or split it (`key#0` … `key#9`) and combine on read.

## Failure modes

| Failure | What happens | Mechanism |
| --- | --- | --- |
| One node down briefly | Writes continue via hinted handoff; reads use other replicas | Sloppy quorum, hints |
| Node down for hours | Hints expire | Anti-entropy repair when it returns, or replace the node |
| Disk corruption | Bad SSTable | Checksums per block; rebuild from replicas |
| Rack or AZ outage | Up to one replica per key lost (rack-aware placement) | Quorum still reachable with N = 3 across 3 racks |
| Network partition | Both sides may accept writes (with sloppy quorum) | Conflicts resolved by vector clocks / LWW afterwards |
| Whole DC outage | Local quorum impossible in that DC | Clients fail over to another DC; `LOCAL_QUORUM` there |
| Slow node (not dead) | Tail latency rises | Speculative retry: after the p99 time, send the read to another replica too |

## Observability

- Read/write latency per consistency level (p50, p99, p999).
- Pending hints, pending compactions, SSTables per read (read amplification).
- Tombstones scanned per read (warn above a threshold).
- Repair progress and the time since each range was last repaired.
- Disk usage headroom (compaction needs spare space), dropped mutations, gossip state changes.

## Trade-offs to discuss

- **AP vs CP.** This design favours availability. For strong consistency (etcd, Spanner, CockroachDB, TiKV), each key range has a leader elected with a consensus protocol (Raft or Paxos). Writes need a majority; the minority side of a partition can't write. Reads from the leader are linearizable.
- **Vector clocks vs LWW.** Vector clocks never lose concurrent updates but push merge logic to clients. LWW is simple but silently drops writes.
- **Smart client vs proxy coordinator.** Smart clients save a hop but must track ring changes; a coordinator hop is simpler for clients.
- **LSM vs B-tree.** Write-optimised vs read-optimised; see the storage engine section.

## Interview follow-up questions

- **Why not `hash(key) mod N`?** Adding one node would move almost every key. Consistent hashing moves ~1/N.
- **What does W + R > N actually guarantee?** Overlap between the write set and read set, when both are drawn from the same N nodes. It does not give linearizability (concurrent writes, sloppy quorum, read-repair races).
- **How do you implement a counter?** Not with LWW (increments are lost). Use a CRDT counter (a per-node count, summed on read) or a separate linearizable store.
- **How would you add strong consistency for some keys?** Run a consensus group (e.g. Paxos-based lightweight transactions in Cassandra) for those operations only, accepting higher latency.
- **How do you avoid a hot partition?** Choose keys with high cardinality; add a random or time-based suffix; cache hot keys in front.
