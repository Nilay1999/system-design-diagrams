import { Diagram, Sequence, type DiagramSpec } from "./dsl";

function architecture() {
  return new Diagram("Distributed Rate Limiter — architecture", "A token bucket per (rule, client) in Redis, checked atomically by every gateway in < 1 ms")
    .zone("Gateway fleet (stateless)", ["gw1", "gw2", "gw3"], "#6741d9")
    .zone("Control plane", ["admin", "rulesdb", "push"], "#1971c2")
    .node("client", "Clients", 0, 1, "client", { detail: "API keys, users, IPs" })
    .node("edge", "Edge / CDN", 0, 2.4, "edge", { detail: ["L3/L4 DDoS shield", "coarse per-IP limits"] })
    .node("gw1", "Gateway 1", 1.2, 0, "edge", { detail: ["local pre-limiter", "rules cached in memory"] })
    .node("gw2", "Gateway 2", 1.2, 1, "edge", { detail: ["local pre-limiter", "rules cached in memory"] })
    .node("gw3", "Gateway N", 1.2, 2, "edge", { detail: ["local pre-limiter", "rules cached in memory"] })
    .node("redis", "Redis Cluster", 2.5, -0.6, "cache", { w: 1.25, detail: ["3 shards × (primary + replica)", "key → hash slot → shard", "~100k checks/s per shard"] })
    .node("api", "Backend services", 2.5, 1, "service", { detail: "only see admitted traffic" })
    .node("kafka", "Kafka: throttle events", 2.5, 2.3, "queue", { detail: "rule, key, count" })
    .node("abuse", "Abuse detection + dashboards", 3.6, 2.3, "worker", { detail: "auto-block, alerts" })
    .node("admin", "Admin UI / API", 0.3, 3.6, "client", { detail: "edit limits per plan" })
    .node("rulesdb", "Rules store", 1.3, 3.6, "db", { detail: "versioned YAML / DB" })
    .node("push", "Config push", 2.3, 3.6, "service", { detail: "etcd watch / pub-sub" })
    .edge("client", "edge", "HTTPS")
    .edge("edge", "gw1")
    .edge("edge", "gw2")
    .edge("edge", "gw3")
    .edge("gw1", "redis", "EVALSHA", { both: true })
    .edge("gw2", "redis", undefined, { both: true })
    .edge("gw1", "api")
    .edge("gw2", "api", "allowed")
    .edge("gw3", "api")
    .edge("gw3", "kafka", "429s", { async: true })
    .edge("kafka", "abuse", undefined, { async: true })
    .edge("admin", "rulesdb", "save")
    .edge("rulesdb", "push", "on change")
    .edge("push", "gw3", "hot reload", { async: true })
    .panel(
      "Key = rule id + client id",
      ["rl:{api-per-key}:key_8f2c → shard by hash tag in { }", "One key's bucket lives on one shard, so the Lua script is atomic", "Each request may match 2–3 rules (per second, per day, per endpoint) — pipelined in one round trip"],
      3.7,
      0.45,
      { width: 400, tone: "info" },
    )
    .build();
}

function checkFlow() {
  return new Sequence("Checking a request", "Every gateway does this before forwarding; the budget is < 1 ms at p99")
    .actor("client", "Client", "client")
    .actor("gw", "Gateway", "edge")
    .actor("local", "Local pre-limiter", "service")
    .actor("redis", "Redis shard", "cache")
    .actor("api", "Backend", "service")
    .actor("kafka", "Kafka", "queue")
    .msg("client", "gw", "GET /v1/orders  (X-API-Key: key_8f2c)")
    .msg("gw", "gw", "match rules from in-memory cache → [100/s burst 200, 50k/day]")
    .msg("gw", "local", "try take 1 locally")
    .break("local budget empty (abusive hot key)", "client", "local")
    .msg("gw", "client", "429 — rejected without touching Redis", { error: true })
    .end()
    .msg("gw", "redis", "pipeline: EVALSHA token_bucket × 2 rules (cost 1, now)")
    .alt("Redis answers in time", "gw", "redis")
    .msg("redis", "gw", "[allowed=1, remaining=57] [allowed=1, remaining=41,230]", { reply: true })
    .else("timeout after 5 ms or Redis down")
    .msg("gw", "gw", "fail open, but apply a conservative local-only limit; emit metric")
    .end()
    .alt("every rule allows", "client", "api")
    .msg("gw", "api", "forward request")
    .msg("api", "gw", "200 OK", { reply: true })
    .msg("gw", "client", "200 + X-RateLimit-Limit: 100, -Remaining: 57, -Reset: 1", { reply: true })
    .else("any rule denies")
    .msg("gw", "client", "429 Too Many Requests, Retry-After: 1", { error: true })
    .msg("gw", "kafka", "throttle event {rule, key, ts}", { async: true })
    .end()
    .build();
}

function algorithms() {
  return new Diagram("Deep dive — algorithms", "Token bucket for bursty APIs; sliding window counter for 'N per minute' rules")
    .zone("Token bucket (capacity b = 10, refill r = 5 / s)", ["refill", "bucket", "req", "ok", "deny"], "#2f9e44")
    .node("refill", "Refill", 0, 0, "worker", { detail: "+ r × elapsed seconds, capped at b" })
    .node("req", "Request (cost 1)", 0, 1.3, "client")
    .node("bucket", "Bucket", 1, 0.65, "cache", { detail: ["tokens = 7.0", "last = 12:00:03.200"] })
    .node("ok", "Allow", 2, 0, "service", { detail: "tokens → 6.0" })
    .node("deny", "429", 2, 1.3, "external", { detail: "Retry-After = (1 − tokens) / r" })
    .edge("refill", "bucket", "lazily, per call")
    .edge("req", "bucket", "take 1")
    .edge("bucket", "ok", "tokens ≥ 1")
    .edge("bucket", "deny", "tokens < 1")
    .panel(
      "token_bucket.lua (atomic in Redis)",
      [
        "local tokens, ts = HMGET(key, 'tokens', 'ts')",
        "tokens = min(cap, tokens + (now - ts) * rate)",
        "allowed = tokens >= cost",
        "if allowed then tokens = tokens - cost end",
        "HSET(key, 'tokens', tokens, 'ts', now)",
        "PEXPIRE(key, cap / rate * 1000 + 1000)",
        "return {allowed, tokens}",
      ],
      3,
      -0.2,
      { width: 400, mono: true },
    )
    .zone("Sliding window counter (limit 100 / minute)", ["prev", "cur", "est"], "#1971c2")
    .node("prev", "Previous minute", 0, 3.2, "db", { detail: ["12:00 – 12:01", "count = 84"] })
    .node("cur", "Current minute", 1, 3.2, "db", { detail: ["12:01 – 12:02", "count = 36, 25 % elapsed"] })
    .node("est", "Estimate", 2, 3.2, "service", { detail: ["36 + 84 × 0.75 = 99", "99 < 100 → allow"] })
    .edge("prev", "est", "weight 0.75", { via: [[1, 4.1]] })
    .edge("cur", "est", "weight 1")
    .panel(
      "Why not a fixed window?",
      [
        "INCR count:{minute} allows 100 at 12:00:59 and 100 more at 12:01:00",
        "That is 200 requests in 2 seconds — double the limit at every boundary",
        "The sliding counter smooths this with two integers per key",
        "A sliding log (sorted set of timestamps) is exact but stores every request",
      ],
      3,
      2.7,
      { width: 400, tone: "warn" },
    )
    .build();
}

function multiRegion() {
  return new Diagram("Scaling & failure handling", "Per-region budgets keep checks local; usage syncs asynchronously for an approximate global cap")
    .zone("Region us-east (60 % of global budget)", ["gwa", "ra"], "#1971c2")
    .zone("Region eu-west (40 % of global budget)", ["gwb", "rb"], "#1971c2")
    .node("gdns", "GeoDNS", 0, 1, "edge", { detail: "users go to nearest region" })
    .node("gwa", "Gateways", 1, 0.3, "edge", { detail: "check local Redis only" })
    .node("ra", "Redis (us-east)", 2, 0.3, "cache", { detail: "limit × 0.6" })
    .node("gwb", "Gateways", 1, 1.9, "edge", { detail: "check local Redis only" })
    .node("rb", "Redis (eu-west)", 2, 1.9, "cache", { detail: "limit × 0.4" })
    .node("sync", "Usage sync", 3.1, 1.1, "worker", { detail: ["every 1–5 s", "rebalances shares by demand"] })
    .edge("gdns", "gwa")
    .edge("gdns", "gwb")
    .edge("gwa", "ra", "< 1 ms", { both: true })
    .edge("gwb", "rb", "< 1 ms", { both: true })
    .edge("ra", "sync", "usage", { async: true })
    .edge("rb", "sync", "usage", { async: true })
    .panel(
      "Failure modes",
      [
        "Redis shard down → fail open with a local limit of (rule ÷ gateway count) × 2",
        "Login / OTP endpoints → fail closed: security beats availability",
        "Hot key (one abusive client) → local pre-limiter absorbs it before Redis",
        "Rules store down → gateways keep the last good rules in memory",
        "Clock skew → take 'now' from Redis TIME inside the script",
      ],
      4.1,
      0,
      { width: 460, tone: "bad" },
    )
    .panel(
      "Rate limiting vs load shedding",
      ["Rate limiting: fairness per client (you used your quota)", "Load shedding: protect the server regardless of client (CPU > 90 % → drop low-priority traffic)", "Production systems use both"],
      4.1,
      1.7,
      { width: 460, tone: "info" },
    )
    .build();
}

export default [
  { id: "architecture", name: "Architecture", build: architecture },
  { id: "check-flow", name: "Checking a request", build: checkFlow },
  { id: "algorithms", name: "Algorithms", build: algorithms },
  { id: "scaling", name: "Multi-region & failures", build: multiRegion },
] satisfies DiagramSpec[];
