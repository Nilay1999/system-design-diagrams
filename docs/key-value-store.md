# Distributed Key-Value Store

> Build a Dynamo/Cassandra-style store: `put(key, value)` and `get(key)` across hundreds of nodes, always writable, with consistency you can tune per request.

## Requirements

### Functional
- `put(key, value)`, `get(key)`, `delete(key)`; values up to ~1 MB.
- Optional per-key TTL.

### Non-functional
- **Horizontally scalable** to petabytes and millions of ops/s.
- **Highly available** for writes, even during node or network failures (AP in CAP terms).
- **Tunable consistency** per request.
- Low latency: single-digit ms p99.
- Automatic failure detection and recovery; no single point of failure.

## Core techniques at a glance

| Problem | Technique |
| --- | --- |
| Partitioning data | Consistent hashing with virtual nodes |
| High availability for writes | Leaderless replication, sloppy quorum, hinted handoff |
| Consistency tuning | Quorum `N`, `W`, `R` |
| Conflicting versions | Vector clocks or last-write-wins (LWW) timestamps |
| Permanent failures | Anti-entropy with Merkle trees |
| Membership & failure detection | Gossip protocol + phi-accrual detector |
| Fast writes on disk | LSM tree: commit log → memtable → SSTables |
| Fast negative lookups | Bloom filters per SSTable |

## Partitioning: consistent hashing

- Hash keys onto a ring `[0, 2¹²⁸)`. Each node owns the arc up to its position.
- **Virtual nodes** (e.g. 256 tokens per physical node) spread load evenly and let bigger machines take more tokens.
- Adding/removing a node moves only ~`1/N` of the keys, and the work is spread over many peers.

## Replication

- Each key is stored on the **first N distinct physical nodes** clockwise from its hash — the *preference list*.
- Place replicas in **different racks/AZs** (rack-aware placement).
- Any node can act as the **coordinator** for a request; clients can also be "smart" and route directly to a replica.

### Quorums

With `N` replicas, a write waits for `W` acks and a read for `R` responses:

| Setting | Behaviour |
| --- | --- |
| `W + R > N` (e.g. N=3, W=2, R=2) | Read and write sets overlap → read sees the latest acknowledged write (absent failures/sloppy quorum) |
| `W = 1` | Fastest writes, weakest durability |
| `R = 1` | Fastest reads, may be stale |
| `W = N` | Every replica must be up to write |

Cassandra exposes this as consistency levels `ONE`, `QUORUM`, `LOCAL_QUORUM`, `ALL`.

### Sloppy quorum & hinted handoff
If a preference-list node is down, the coordinator writes to the next healthy node with a **hint** ("this belongs to node C"). When C recovers, the hint is handed back. Writes stay available; consistency is temporarily weaker.

## Conflict resolution

Concurrent writes on different replicas can diverge.

- **Last-write-wins (LWW):** keep the value with the highest timestamp. Simple; silently drops concurrent updates; needs reasonably synced clocks.
- **Vector clocks:** each version carries `{node: counter}`; if neither dominates, both *siblings* are returned and the client merges (e.g. union of shopping carts).
- **CRDTs:** data types (counters, sets, maps) that merge automatically and deterministically.

## Read path

1. Coordinator sends the read to `R` (or all `N`) replicas.
2. Returns once `R` respond; picks the newest version (or siblings).
3. **Read repair:** stale replicas are updated in the background.

## Write path (inside a node — LSM tree)

1. Append to the **commit log** (sequential disk write → durability).
2. Insert into the in-memory **memtable** (sorted structure).
3. When the memtable is full, flush it as an immutable **SSTable** on disk.
4. **Compaction** merges SSTables, discards overwritten values and expired **tombstones**.

Reads check the memtable, then SSTables newest → oldest, using a **Bloom filter** per SSTable to skip files that definitely don't contain the key, plus a sparse index to find the block.

## Failure handling

| Failure | Mechanism |
| --- | --- |
| Transient node failure | Sloppy quorum + hinted handoff |
| Permanent failure / missed writes | **Anti-entropy:** replicas compare **Merkle trees** per key range and sync only differing ranges |
| Failure detection | **Gossip:** each node periodically exchanges heartbeat tables with random peers; phi-accrual detector marks nodes suspect/dead |
| Datacenter outage | Replicate across DCs; use `LOCAL_QUORUM` to avoid cross-DC latency |

## Deletes

Deletes write a **tombstone** rather than removing data (otherwise a replica that missed the delete would resurrect the value). Tombstones are purged by compaction after a grace period longer than the maximum expected repair interval.

## Estimation example

- 1 PB of data, RF = 3 → 3 PB raw. At 4 TB usable per node → ~750 nodes.
- 1 M writes/s at ~1 KB → 1 GB/s of client writes, 3 GB/s after replication, or ~4 MB/s of commit-log traffic per node across 750 nodes — easy for SSDs.

## Trade-offs

- **AP vs CP:** this design favours availability. For CP (etcd, Spanner, CockroachDB), use a consensus protocol (Raft/Paxos) per range with a leader — writes need a majority and are unavailable in the minority partition.
- **LSM vs B-tree:** LSM = fast writes, compaction overhead and read amplification; B-tree = faster reads, in-place writes.
- **Client-side vs server-side conflict resolution:** siblings push complexity to clients but lose no data.
