import { Diagram, Sequence, type DiagramSpec } from "./dsl";

function architecture() {
  return new Diagram("Distributed Cache — architecture", "Clients hash keys straight to the owning shard; each shard has a replica in another AZ")
    .zone("Cache cluster — 16 shards (3 shown)", ["s1", "s2", "s3", "r1", "r2", "r3"], "#e03131")
    .zone("Invalidation from the database log", ["cdc", "kafka", "inval"], "#e8590c")
    .node("app", "App servers", 0, 1, "client", { detail: ["client library: ring / slot map", "L1 in-process cache (1–5 s)"] })
    .node("config", "Cluster config", 0, -0.4, "service", { detail: ["etcd / Redis Cluster bus", "shard map + health"] })
    .node("s1", "Shard A primary", 1.4, 0, "cache", { detail: "AZ-1 · slots 0–5460" })
    .node("s2", "Shard B primary", 1.4, 1, "cache", { detail: "AZ-2 · slots 5461–10922" })
    .node("s3", "Shard C primary", 1.4, 2, "cache", { detail: "AZ-3 · slots 10923–16383" })
    .node("r1", "Shard A replica", 2.5, 0, "cache", { detail: "AZ-2" })
    .node("r2", "Shard B replica", 2.5, 1, "cache", { detail: "AZ-3" })
    .node("r3", "Shard C replica", 2.5, 2, "cache", { detail: "AZ-1" })
    .node("db", "Database", 0.6, 3.3, "db", { detail: ["source of truth", "PostgreSQL / MySQL"] })
    .node("cdc", "CDC reader", 1.7, 3.3, "worker", { detail: "Debezium tails the binlog" })
    .node("kafka", "Kafka", 2.7, 3.3, "queue", { detail: "row-change events" })
    .node("inval", "Invalidator", 3.7, 3.3, "worker", { detail: "row → cache keys → DEL" })
    .edge("config", "app", "topology push", { async: true })
    .edge("app", "s1", "GET / SET")
    .edge("app", "s2")
    .edge("app", "s3")
    .edge("s1", "r1", "async repl", { async: true })
    .edge("s2", "r2", "async repl", { async: true })
    .edge("s3", "r3", "async repl", { async: true })
    .edge("app", "db", "on miss / writes")
    .edge("db", "cdc", "binlog", { async: true })
    .edge("cdc", "kafka", undefined, { async: true })
    .edge("kafka", "inval", undefined, { async: true })
    .edge("inval", "s3", "DEL keys")
    .panel(
      "Sizing (example)",
      ["Working set: 1 B keys × ~1 KB ≈ 1 TB of RAM", "64 GB usable per node → 16 primaries + 16 replicas", "5 M reads/s + 0.5 M writes/s ≈ 350k ops/s per primary (pipelined)", "Target hit rate > 95 %: the DB sees < 250k reads/s"],
      3.6,
      -0.3,
      { width: 430, tone: "info" },
    )
    .panel(
      "Eviction when memory is full",
      ["allkeys-lru (sampled): default", "allkeys-lfu: very skewed popularity", "volatile-ttl: only keys with a TTL", "maxmemory at ~75 % of RAM: leave room for fork + fragmentation"],
      3.6,
      1.25,
      { width: 430 },
    )
    .build();
}

function cacheAside() {
  return new Sequence("Cache-aside reads, writes, and the stale-set race", "Why writers DELETE instead of SET, and how leases close the last gap", { gap: 240 })
    .actor("reader", "App (reader)", "service")
    .actor("writer", "App (writer)", "service")
    .actor("cache", "Cache shard", "cache")
    .actor("db", "Database", "db")
    .phase("Normal read miss")
    .msg("reader", "cache", "GET user:42")
    .msg("cache", "reader", "nil (miss)", { reply: true })
    .msg("reader", "db", "SELECT * FROM users WHERE id = 42")
    .msg("db", "reader", "row (version 7)", { reply: true })
    .msg("reader", "cache", "SET user:42 v7 EX 300 + random jitter")
    .phase("Write")
    .msg("writer", "db", "UPDATE users SET … WHERE id = 42 → version 8")
    .msg("writer", "cache", "DEL user:42 (after the commit)")
    .phase("The race (without leases)")
    .msg("reader", "cache", "GET user:42 → miss")
    .msg("reader", "db", "read → v8")
    .msg("writer", "db", "UPDATE → v9")
    .msg("writer", "cache", "DEL user:42 (nothing to delete)")
    .msg("reader", "cache", "SET user:42 v8 — stale until the TTL expires", { error: true })
    .phase("Fix: lease tokens (memcache-style)")
    .msg("reader", "cache", "GET user:42 → miss + lease token L1")
    .msg("writer", "cache", "DEL user:42 → also invalidates lease L1")
    .msg("reader", "cache", "SET user:42 v8 with lease L1 → rejected")
    .note("Other fixes: short TTLs, a second delayed DEL (~1 s later), or CDC-driven invalidation so every write path deletes.", ["reader", "db"], "info")
    .build();
}

function hotKeys() {
  return new Diagram("Stampedes & hot keys", "Protect the database when a hot key expires, and protect one shard from one very hot key")
    .zone("Stampede: a hot key expires", ["reqs", "cache1", "lock", "db1", "stale"], "#e03131")
    .node("reqs", "10,000 requests", 0, 0.5, "client", { detail: "all miss at the same moment" })
    .node("cache1", "Cache", 1, 0.5, "cache", { detail: "product:99 just expired" })
    .node("lock", "Lock key", 2, 0, "cache", { detail: "SET lock:product:99 NX EX 5" })
    .node("db1", "Database", 3, 0, "db", { detail: "exactly 1 query" })
    .node("stale", "Everyone else", 2, 1.1, "service", { detail: ["serve the stale copy", "or wait 50 ms and retry"] })
    .edge("reqs", "cache1", "GET")
    .edge("cache1", "lock", "winner")
    .edge("lock", "db1", "recompute")
    .edge("cache1", "stale", "losers")
    .panel(
      "Also",
      ["Jittered TTLs: 300 s ± 10 % so keys don't expire together", "Early refresh (XFetch): recompute with rising probability as expiry nears", "Stale-while-revalidate: keep value + soft TTL; refresh in background"],
      3.4,
      0.9,
      { width: 400, tone: "info" },
    )
    .zone("Hot key: one key gets 500k reads/s", ["apps", "l1", "k1", "k2", "k3"], "#1971c2")
    .node("apps", "App servers", 0, 3, "client", { detail: "200 instances" })
    .node("l1", "L1 in-process cache", 1, 3, "service", { detail: ["TTL 2 s, 10k entries", "absorbs ~99 %"] })
    .node("k1", "celebrity:7#0", 2, 2.4, "cache", { detail: "shard A" })
    .node("k2", "celebrity:7#1", 2, 3.4, "cache", { detail: "shard D" })
    .node("k3", "celebrity:7#2", 2, 4.4, "cache", { detail: "shard G" })
    .edge("apps", "l1", "get")
    .edge("l1", "k1")
    .edge("l1", "k2", "random copy")
    .edge("l1", "k3")
    .panel(
      "Finding hot keys",
      ["redis-cli --hotkeys (LFU counters)", "Client-side sampling of key frequencies", "Per-shard CPU skew alarms", "Big keys too: split collections, UNLINK instead of DEL"],
      3.1,
      2.8,
      { width: 400 },
    )
    .build();
}

function reshard() {
  return new Sequence("Resharding & failover (Redis Cluster)", "Slots move one at a time; clients follow MOVED / ASK redirects and refresh their slot map", { gap: 250 })
    .actor("client", "Client library", "client")
    .actor("a", "Node A (source)", "cache")
    .actor("d", "Node D (new)", "cache")
    .actor("ar", "Node A's replica", "cache")
    .phase("Moving slot 1234 from A to D")
    .msg("a", "d", "MIGRATE keys of slot 1234 in batches (slot marked MIGRATING on A, IMPORTING on D)")
    .msg("client", "a", "GET user:42 (slot 1234)")
    .alt("key not yet moved", "client", "d")
    .msg("a", "client", "value", { reply: true })
    .else("key already moved")
    .msg("a", "client", "-ASK 1234 node-D", { reply: true })
    .msg("client", "d", "ASKING; GET user:42")
    .msg("d", "client", "value", { reply: true })
    .end()
    .msg("a", "d", "slot 1234 done → cluster now says D owns it")
    .msg("client", "a", "GET user:42")
    .msg("a", "client", "-MOVED 1234 node-D → client updates its slot map", { reply: true })
    .phase("Primary failure")
    .msg("ar", "ar", "no heartbeat from A for node_timeout (e.g. 5 s)")
    .msg("ar", "ar", "majority of primaries agree A is failed → promote self")
    .note("Replication is async, so writes A acknowledged in the last moment may be lost. Acceptable for a cache — the DB is the source of truth.", ["a", "ar"], "warn")
    .msg("client", "ar", "requests for A's slots (after MOVED or map refresh)")
    .build();
}

export default [
  { id: "architecture", name: "Architecture", build: architecture },
  { id: "cache-aside", name: "Cache-aside & races", build: cacheAside },
  { id: "hot-keys", name: "Stampedes & hot keys", build: hotKeys },
  { id: "resharding", name: "Resharding & failover", build: reshard },
] satisfies DiagramSpec[];
