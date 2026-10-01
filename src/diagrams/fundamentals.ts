import { Diagram, Sequence, type DiagramSpec } from "./dsl";

function reference() {
  return new Diagram("Reference web architecture", "The building blocks most designs are assembled from, and what each one is for")
    .zone("Edge", ["dns", "lb", "cdn"], "#6741d9")
    .zone("Stateless services (autoscaled)", ["gw", "users", "orders", "search"], "#2f9e44")
    .zone("Data tier", ["redis", "db", "replica", "kafka", "worker", "index"], "#e67700")
    .node("client", "Web / mobile clients", 0, 1.5, "client", { detail: "browser, iOS, Android" })
    .node("dns", "GeoDNS", 1, 0, "edge", { detail: ["latency-based routing", "health-checked failover"] })
    .node("lb", "WAF + L7 load balancer", 1, 1.5, "edge", { detail: ["TLS termination", "least-connections"] })
    .node("cdn", "CDN", 1, 3, "edge", { detail: ["static assets, media", "cache at edge PoPs"] })
    .node("blob", "Object storage", 2, 3.3, "storage", { detail: ["S3 / GCS", "images, video, backups"] })
    .node("gw", "API gateway", 2, 1.5, "edge", { detail: ["authN, rate limits", "routing, versioning"] })
    .node("users", "User service", 3, 0.5, "service", { detail: "profiles, sessions" })
    .node("orders", "Order service", 3, 1.5, "service", { detail: "transactions" })
    .node("search", "Search service", 3, 2.5, "service", { detail: "full-text queries" })
    .node("redis", "Redis", 4, -0.3, "cache", { detail: ["hot reads, sessions", "rate-limit counters"] })
    .node("db", "Primary DB", 4, 1, "db", { detail: ["PostgreSQL", "all writes"] })
    .node("replica", "Read replicas", 5, 1, "db", { detail: "async, seconds of lag" })
    .node("kafka", "Kafka / SQS", 4, 2.3, "queue", { detail: "events + async jobs" })
    .node("worker", "Workers", 5, 2.3, "worker", { detail: ["emails, thumbnails", "search indexing"] })
    .node("index", "Search index", 4, 3.5, "db", { detail: "Elasticsearch" })
    .edge("client", "dns", "1. resolve")
    .edge("client", "lb", "2. HTTPS")
    .edge("client", "cdn", "static files")
    .edge("cdn", "blob", "origin pull")
    .edge("lb", "gw")
    .edge("gw", "users")
    .edge("gw", "orders")
    .edge("gw", "search")
    .edge("users", "redis", "cache-aside")
    .edge("users", "db", "read / write")
    .edge("orders", "db", "txn")
    .edge("orders", "kafka", "OrderCreated", { async: true })
    .edge("db", "replica", "WAL stream", { async: true })
    .edge("kafka", "worker", "consume", { async: true })
    .edge("worker", "index", "index docs")
    .edge("search", "index", "query")
    .panel(
      "Cross-cutting (not drawn)",
      ["Metrics, logs, traces for every box", "Service discovery + config / secrets", "CI/CD with canary deploys", "Multi-AZ everything; multi-region for the critical path"],
      6,
      0,
      { width: 330 },
    )
    .panel(
      "Where each request goes",
      ["Static bytes: CDN → object storage", "Reads: service → cache → replica", "Writes: service → primary (in a transaction)", "Slow work: event → queue → worker"],
      6,
      1.3,
      { width: 330, tone: "info" },
    )
    .build();
}

function lifecycle() {
  return new Sequence("Life of a request", "What happens between a tap in the app and a row in the database", { gap: 220 })
    .actor("client", "Client", "client")
    .actor("dns", "GeoDNS", "edge")
    .actor("cdn", "CDN", "edge")
    .actor("lb", "Load balancer", "edge")
    .actor("app", "App server", "service")
    .actor("cache", "Redis", "cache")
    .actor("db", "Database", "db")
    .actor("queue", "Queue", "queue")
    .msg("client", "dns", "resolve api.example.com")
    .msg("dns", "client", "IP of nearest healthy region (TTL 60 s)", { reply: true })
    .msg("client", "cdn", "GET /static/app.3f9a.js")
    .msg("cdn", "client", "200 from edge cache (content-hashed name, cached for a year)", { reply: true })
    .phase("A read request")
    .msg("client", "lb", "GET /api/items/42 over TLS (keep-alive connection)")
    .msg("lb", "app", "forward to a healthy instance")
    .msg("app", "cache", "GET item:42")
    .alt("cache hit", "app", "db")
    .msg("cache", "app", "cached JSON", { reply: true })
    .else("cache miss")
    .msg("app", "db", "SELECT … WHERE id = 42 (on a read replica)")
    .msg("db", "app", "row", { reply: true })
    .msg("app", "cache", "SET item:42 EX 300 (TTL with jitter)")
    .end()
    .msg("app", "client", "200 OK + ETag", { reply: true })
    .phase("A write request")
    .msg("client", "lb", "POST /api/orders + Idempotency-Key")
    .msg("lb", "app", "forward")
    .msg("app", "db", "BEGIN; INSERT order; INSERT outbox event; COMMIT (on the primary)")
    .msg("app", "cache", "DEL keys the write made stale")
    .msg("app", "client", "201 Created", { reply: true })
    .msg("db", "queue", "outbox relay publishes OrderCreated", { async: true })
    .note("Emails, search indexing and analytics happen later in workers, off the user's critical path.", ["db", "queue"])
    .build();
}

function scalingJourney() {
  return new Diagram("The scaling journey", "Add each piece only when the previous stage hits a real limit", { gridY: 200 })
    .panel("Stage 1 — one box", ["Web, app and DB on one machine", "Fine for a prototype or < 1k users", "Move on when CPU / RAM is shared badly"], 0, -0.3, { width: 290 })
    .node("c1", "Clients", 1, 0, "client")
    .node("s1", "Single server", 2, 0, "service", { detail: "web + app + DB" })
    .edge("c1", "s1")

    .panel("Stage 2 — split data out", ["DB on its own host, add a cache", "Vertical scaling buys a lot of time", "Move on when one app server can't keep up"], 0, 1.2, { width: 290 })
    .node("c2", "Clients", 1, 1.5, "client")
    .node("a2", "App server", 2, 1.5, "service")
    .node("k2", "Cache", 3, 1.05, "cache")
    .node("d2", "Database", 3, 1.95, "db", { detail: "own host" })
    .edge("c2", "a2")
    .edge("a2", "k2")
    .edge("a2", "d2")

    .panel("Stage 3 — horizontal app tier", ["Stateless app servers behind a LB", "Read replicas + CDN offload reads", "Move on when writes outgrow one primary"], 0, 2.9, { width: 290 })
    .node("c3", "Clients", 1, 3.2, "client")
    .node("lb3", "Load balancer", 2, 3.2, "edge")
    .node("a3", "App × N", 3, 3.2, "service", { detail: "stateless, autoscaled" })
    .node("k3", "Cache cluster", 4, 2.75, "cache")
    .node("p3", "Primary", 4, 3.65, "db")
    .node("r3", "Replicas", 5, 3.65, "db")
    .edge("c3", "lb3")
    .edge("lb3", "a3")
    .edge("a3", "k3")
    .edge("a3", "p3")
    .edge("p3", "r3", undefined, { async: true })

    .panel("Stage 4 — partition everything", ["Shard the DB by a high-cardinality key", "Queues absorb bursts and slow work", "Several regions for latency + disaster recovery"], 0, 4.6, { width: 290 })
    .node("c4", "Clients", 1, 5, "client")
    .node("g4", "GeoDNS", 2, 5, "edge")
    .node("rg4", "Region stack × 2+", 3, 5, "service", { detail: "LB + apps + cache" })
    .node("sh4", "DB shards", 4, 4.55, "db", { detail: "by user_id, each replicated" })
    .node("q4", "Queue", 4, 5.45, "queue")
    .node("w4", "Workers", 5, 5.45, "worker")
    .edge("c4", "g4")
    .edge("g4", "rg4")
    .edge("rg4", "sh4")
    .edge("rg4", "q4", undefined, { async: true })
    .edge("q4", "w4", undefined, { async: true })
    .build();
}

function dataDistribution() {
  return new Diagram("Replication & sharding", "Replication copies the same data for availability and reads; sharding splits data for write scale")
    .zone("Leader–follower replication", ["app", "primary", "r1", "r2"], "#e67700")
    .zone("Hash sharding", ["router", "sh1", "sh2", "sh3"], "#1971c2")
    .node("app", "App", 0, 0.5, "service")
    .node("primary", "Primary", 1, 0, "db", { detail: "accepts all writes" })
    .node("r1", "Replica 1", 2, 0, "db", { detail: "same AZ, sync" })
    .node("r2", "Replica 2", 2, 1, "db", { detail: "other AZ, async" })
    .edge("app", "primary", "writes")
    .edge("app", "r2", "reads (may lag)")
    .edge("primary", "r1", "sync commit")
    .edge("primary", "r2", "async", { async: true })
    .node("router", "Router / client library", 0, 2.8, "service", { detail: "shard = hash(user_id) → ring" })
    .node("sh1", "Shard 1", 1.2, 2.2, "db", { detail: "users hash 0–33 %" })
    .node("sh2", "Shard 2", 1.2, 3.1, "db", { detail: "users hash 33–66 %" })
    .node("sh3", "Shard 3", 1.2, 4, "db", { detail: "users hash 66–100 %" })
    .edge("router", "sh1")
    .edge("router", "sh2")
    .edge("router", "sh3")
    .panel(
      "Replication modes",
      [
        "Leader–follower: simple, one writer; failover must fence the old leader (no split-brain)",
        "Multi-leader: a writer per region; needs conflict resolution (last-writer-wins, CRDTs)",
        "Leaderless (Dynamo): any replica takes writes; quorum W + R > N gives overlap",
      ],
      3.1,
      0,
      { width: 420 },
    )
    .panel(
      "Choosing a shard key",
      [
        "High cardinality and even spread (user_id, order_id)",
        "Matches the main query so it hits one shard",
        "Avoid monotonic keys (timestamps) with range sharding: every write lands on the last shard",
        "Cross-shard joins and transactions become expensive",
      ],
      2.5,
      2.2,
      { width: 400, tone: "info" },
    )
    .panel(
      "Re-sharding without downtime",
      ["Consistent hashing / many virtual shards", "Double-write, backfill, verify, cut over", "Move reads first, then writes"],
      3.8,
      2.2,
      { width: 330, tone: "warn" },
    )
    .build();
}

export default [
  { id: "architecture", name: "Reference architecture", build: reference },
  { id: "request-lifecycle", name: "Life of a request", build: lifecycle },
  { id: "scaling-journey", name: "Scaling journey", build: scalingJourney },
  { id: "replication-sharding", name: "Replication & sharding", build: dataDistribution },
] satisfies DiagramSpec[];
