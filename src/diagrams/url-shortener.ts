import { Diagram, Sequence, type DiagramSpec } from "./dsl";

function architecture() {
  return new Diagram("URL Shortener — architecture", "Two independent paths: a hot, read-only redirect path and a low-volume create path (~100 : 1)")
    .zone("Data tier", ["redis", "urls"], "#e67700")
    .zone("Analytics pipeline (async, never blocks a redirect)", ["kafka", "flink", "clickhouse", "cleanup"], "#e8590c")
    .panel(
      "Scale targets",
      ["100 M new links / month (~40 writes/s, 200/s peak)", "10 B redirects / month (~4k reads/s, 20k/s peak)", "p99 redirect < 20 ms inside the data centre", "6 B links over 5 years ≈ 3 TB"],
      0,
      -1.3,
      { width: 520, tone: "info" },
    )
    .node("visitor", "Visitor's browser", 0, 0, "client", { detail: "clicks sho.rt/aB3xK9" })
    .node("creator", "Link creator", 0, 2, "client", { detail: "web app or REST API" })
    .node("cdn", "CDN / edge PoPs", 1, 0, "edge", { detail: ["TLS, GeoDNS", "caches hot redirects ~60 s"] })
    .node("gw", "API gateway", 1, 2, "edge", { detail: ["auth (OAuth / API key)", "rate limit per user + IP"] })
    .node("redirect", "Redirect service", 2, 0, "service", { detail: ["stateless, autoscaled", "checks expiry + status"] })
    .node("safe", "Safe Browsing API", 2, 1, "external", { detail: "malware / phishing lookup" })
    .node("shorten", "Shorten service", 2, 2, "service", { detail: ["validate + normalise URL", "custom alias, expiry"] })
    .node("stats", "Stats service", 2, 3.3, "service", { detail: "per-link click reports" })
    .node("kgs", "Key generation service", 3, 2.1, "service", { detail: ["leases ranges of 1 M ids", "state in ZooKeeper / etcd"] })
    .node("redis", "Redis cluster", 3, -0.9, "cache", { detail: ["code → long URL", "LRU, ~70 GB, 1 replica"] })
    .node("urls", "URL store", 3, 0.9, "db", { detail: ["DynamoDB / Cassandra", "partition key = code"] })
    .node("kafka", "Kafka: clicks", 4, 0, "queue", { detail: "partitioned by code" })
    .node("cleanup", "Expiry sweeper", 4, 1.1, "worker", { detail: "deletes expired links" })
    .node("flink", "Stream processor", 5, 0, "worker", { detail: ["Flink: geo-IP, UA parse", "1-min rollups"] })
    .node("clickhouse", "ClickHouse", 5, 1.3, "db", { detail: "clicks per code per minute" })
    .edge("visitor", "cdn", "GET /aB3xK9")
    .edge("cdn", "redirect", "miss")
    .edge("redirect", "redis", "1. get")
    .edge("redirect", "urls", "2. on miss")
    .edge("redirect", "kafka", "click event", { async: true })
    .edge("creator", "gw", "POST /urls")
    .edge("gw", "shorten")
    .edge("gw", "stats", "GET /stats")
    .edge("shorten", "safe", "check")
    .edge("shorten", "kgs", "next range")
    .edge("shorten", "urls", "insert if absent")
    .edge("kafka", "flink", undefined, { async: true })
    .edge("flink", "clickhouse", "upsert rollups")
    .edge("stats", "clickhouse", "query rollups")
    .edge("cleanup", "urls", "scan / TTL")
    .build();
}

function redirectFlow() {
  return new Sequence("Redirect flow", "GET /aB3xK9 — the path that must stay fast and available")
    .actor("browser", "Browser", "client")
    .actor("cdn", "CDN edge", "edge")
    .actor("svc", "Redirect service", "service")
    .actor("redis", "Redis", "cache")
    .actor("db", "URL store", "db")
    .actor("kafka", "Kafka", "queue")
    .msg("browser", "cdn", "GET https://sho.rt/aB3xK9")
    .alt("popular link cached at the edge", "browser", "svc")
    .msg("cdn", "browser", "302 Location: <long URL> (from edge cache)", { reply: true })
    .note("Edge hits are counted later from CDN access logs, so analytics still see them.", "cdn")
    .else("edge miss")
    .msg("cdn", "svc", "forward GET /aB3xK9")
    .end()
    .msg("svc", "redis", "GET url:aB3xK9")
    .alt("cache hit (> 90 % of requests)", "svc", "db")
    .msg("redis", "svc", "{long_url, expires_at, status}", { reply: true })
    .else("cache miss")
    .msg("svc", "db", "GetItem(code = aB3xK9)")
    .msg("db", "svc", "row, or not found", { reply: true })
    .msg("svc", "redis", "SET url:aB3xK9 … EX 86400 (not found → cache '∅' for 60 s)")
    .end()
    .break("not found, expired or disabled", "browser", "svc")
    .msg("svc", "cdn", "404 Not Found / 410 Gone", { error: true })
    .end()
    .msg("svc", "kafka", "click {code, ts, ip, user_agent, referrer}", { async: true })
    .note("Fire-and-forget into a local buffer. If Kafka is down the event is dropped — the redirect never waits.", ["svc", "kafka"])
    .msg("svc", "cdn", "302 Found, Location: <long URL>, Cache-Control: private, max-age=60", { reply: true })
    .msg("cdn", "browser", "302 Found", { reply: true })
    .build();
}

function createFlow() {
  return new Sequence("Create flow", "POST /api/v1/urls — correctness matters more than speed here", { gap: 235 })
    .actor("user", "Link creator", "client")
    .actor("gw", "API gateway", "edge")
    .actor("svc", "Shorten service", "service")
    .actor("safe", "Safe Browsing", "external")
    .actor("kgs", "KGS", "service")
    .actor("db", "URL store", "db")
    .actor("redis", "Redis", "cache")
    .msg("user", "gw", "POST /api/v1/urls {long_url, custom_alias?, expires_at?} + Idempotency-Key")
    .msg("gw", "gw", "verify token, rate limit (429 if over)")
    .msg("gw", "svc", "create(user_id, request)")
    .msg("svc", "svc", "normalise URL, check length ≤ 2 KB and http/https scheme")
    .msg("svc", "safe", "lookup(long_url)")
    .break("URL is flagged", "user", "safe")
    .msg("svc", "user", "422 Unprocessable — unsafe destination", { error: true })
    .end()
    .alt("custom alias requested", "svc", "db")
    .msg("svc", "db", "PutItem(code = alias) IF attribute_not_exists(code)")
    .opt("alias already taken", "svc", "db")
    .msg("db", "svc", "ConditionalCheckFailed → 409 Conflict", { error: true })
    .end()
    .else("generate a code")
    .msg("svc", "svc", "id = next id from the local range")
    .opt("range under 10 % left", "svc", "kgs")
    .msg("svc", "kgs", "lease next range (background prefetch)", { async: true })
    .end()
    .msg("svc", "svc", "code = base62(permute(id)) → 'aB3xK9Q'")
    .msg("svc", "db", "PutItem(code) IF attribute_not_exists(code)")
    .end()
    .msg("db", "svc", "OK", { reply: true })
    .msg("svc", "redis", "SET url:<code> (write-through: the first click is a cache hit)")
    .msg("svc", "user", "201 Created {code, short_url}", { reply: true })
    .note("A retry with the same Idempotency-Key returns the same 201 body instead of creating a second link.", ["user", "svc"], "info")
    .build();
}

function keyGeneration() {
  return new Diagram("Deep dive — key generation & data model", "Unique, non-guessable codes with no coordination on the request path")
    .zone("Key generation service", ["zk", "kgs"], "#2f9e44")
    .node("zk", "ZooKeeper / etcd", 0, 0, "db", { detail: ["/kgs/next_range = 4,812", "updated with compare-and-set"] })
    .node("kgs", "KGS", 0, 1.4, "service", { detail: "hands out range N → ids N×10⁶ … N×10⁶ + 999,999" })
    .node("s1", "Shorten #1", 1.2, 0.3, "service", { detail: ["range 4,810", "next id 4,810,000,517"] })
    .node("s2", "Shorten #2", 1.2, 1.4, "service", { detail: ["range 4,811", "next id 4,811,000,090"] })
    .node("s3", "Shorten #3", 1.2, 2.5, "service", { detail: ["range 4,812 (just leased)", "next id 4,812,000,000"] })
    .edge("kgs", "zk", "CAS +1")
    .edge("s1", "kgs", "lease", { async: true })
    .edge("s2", "kgs", "lease", { async: true })
    .edge("s3", "kgs", "lease", { async: true })
    .panel(
      "From id to code (inside each Shorten instance)",
      [
        "id = 4,810,000,517 (unique across all servers)",
        "p = feistel_permute(id) over [0, 62⁷) — a reversible shuffle, so neighbouring ids give unrelated codes",
        "code = base62(p) padded to 7 chars → 'aB3xK9Q'",
        "62⁷ ≈ 3.5 × 10¹² codes: ~500× the 6 B we need in 5 years",
        "A crashed server loses the rest of its range — fine, the space is huge",
      ],
      2.3,
      0,
      { width: 470, numbered: true, tone: "info" },
    )
    .table(
      "urls",
      "urls  (DynamoDB)",
      [
        "code        S   partition key",
        "long_url    S   ≤ 2 KB",
        "owner_id    S   GSI: owner_id + created_at",
        "created_at  N   epoch ms",
        "expires_at  N   DynamoDB TTL attribute",
        "status      S   active | disabled",
        "url_hash    S   optional per-owner dedup",
      ],
      0,
      3.4,
    )
    .table(
      "rollups",
      "clicks_per_minute  (ClickHouse)",
      [
        "code      String",
        "minute    DateTime",
        "country   LowCardinality(String)",
        "referrer  String",
        "device    LowCardinality(String)",
        "clicks    UInt64",
        "ENGINE = SummingMergeTree",
        "ORDER BY (code, minute)",
      ],
      1.55,
      3.4,
      { kind: "db" },
    )
    .panel(
      "Access patterns",
      [
        "Redirect: get by code — single-key read, cached",
        "Create: conditional put on code",
        "My links: GSI query by owner_id, newest first",
        "Stats: range scan on (code, minute) in ClickHouse",
      ],
      2.95,
      3.4,
      { width: 380 },
    )
    .build();
}

export default [
  { id: "architecture", name: "Architecture", build: architecture },
  { id: "redirect-flow", name: "Redirect flow", build: redirectFlow },
  { id: "create-flow", name: "Create flow", build: createFlow },
  { id: "key-generation", name: "Key generation & data model", build: keyGeneration },
] satisfies DiagramSpec[];
