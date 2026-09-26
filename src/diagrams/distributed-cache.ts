import { Diagram } from "./dsl";

export default function distributedCache() {
  return new Diagram("Distributed Cache", "Client-side consistent hashing over primary/replica shards, cache-aside in front of the DB")
    .zone("Cache cluster", 2, 0, 2, 3, "#e03131")
    .node("app", "App servers (client lib + local L1 cache)", 0, 1, "client", { h: 1.2 })
    .node("config", "Cluster config (etcd) shard map", 1, -0.6, "service")
    .node("s1", "Shard A primary", 2, 0, "cache")
    .node("s2", "Shard B primary", 2, 1, "cache")
    .node("s3", "Shard C primary", 2, 2, "cache")
    .node("r1", "Shard A replica", 3, 0, "cache")
    .node("r2", "Shard B replica", 3, 1, "cache")
    .node("r3", "Shard C replica", 3, 2, "cache")
    .node("db", "Database (source of truth)", 1, 2.8, "db")
    .edge("config", "app", "topology", { async: true })
    .edge("app", "s1", "get / set")
    .edge("app", "s2")
    .edge("app", "s3")
    .edge("s1", "r1", "replicate", { async: true })
    .edge("s2", "r2", "replicate", { async: true })
    .edge("s3", "r3", "replicate", { async: true })
    .edge("app", "db", "on miss")
    .steps(
      "Read path (cache-aside)",
      [
        "hash(key) on the ring → owning shard",
        "Hit → return; miss → read DB",
        "SET with TTL (+ jitter) to repopulate",
        "Writes: update DB, then DELETE the key",
      ],
      4.5,
      0,
    )
    .build();
}
