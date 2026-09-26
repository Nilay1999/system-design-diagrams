import { Diagram } from "./dsl";

export default function keyValueStore() {
  return new Diagram("Distributed Key-Value Store", "Leaderless, consistent-hash ring, N=3 replicas, tunable W/R quorums")
    .zone("Consistent-hash ring (virtual nodes)", 2, 0, 3, 3, "#2f9e44")
    .zone("Inside every storage node (LSM tree)", 2, 4.2, 3, 1, "#e67700")
    .node("client", "Client (smart or via proxy)", 0, 1, "client")
    .node("coord", "Coordinator (any node that owns the key)", 1, 1, "service", { h: 1.2 })
    .node("b", "Node B (replica 1)", 2, 0, "db")
    .node("c", "Node C (replica 2)", 3, 0, "db")
    .node("a", "Node A", 4, 0, "db")
    .node("e", "Node E (replica 3)", 2, 2, "db")
    .node("f", "Node F", 3, 2, "db")
    .node("d", "Node D", 4, 2, "db")
    .node("wal", "Commit log (WAL)", 2, 4.2, "storage")
    .node("mem", "Memtable", 3, 4.2, "cache")
    .node("sst", "SSTables + Bloom filters", 4, 4.2, "db")
    .edge("client", "coord", "put / get")
    .edge("coord", "b", "replicate")
    .edge("coord", "c", "replicate")
    .edge("coord", "e", "replicate")
    .edge("a", "d", "gossip", { async: true, both: true })
    .edge("c", "f", "gossip", { async: true, both: true })
    .edge("wal", "mem", "1. append")
    .edge("mem", "sst", "2. flush")
    .steps(
      "Guarantees",
      [
        "W + R > N → read sees latest write",
        "Hinted handoff covers temporary failures",
        "Merkle-tree anti-entropy repairs replicas",
        "Vector clocks / LWW resolve conflicts",
        "Gossip + phi-accrual detects failures",
      ],
      5.3,
      0,
    )
    .build();
}
