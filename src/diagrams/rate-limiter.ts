import { Diagram } from "./dsl";

export default function rateLimiter() {
  return new Diagram("Distributed Rate Limiter", "Token bucket per (client, rule) held in Redis, checked atomically with a Lua script")
    .zone("Gateway fleet", 1, 0.5, 1, 2, "#6741d9")
    .node("client", "Client", 0, 1, "client")
    .node("gw1", "Gateway + limiter middleware", 1, 0.5, "edge")
    .node("gw2", "Gateway + limiter middleware", 1, 1.5, "edge")
    .node("redis", "Redis cluster (buckets, sharded by key)", 2.4, 0, "cache", { w: 1.2 })
    .node("api", "Backend services", 2.4, 2, "service")
    .node("rules", "Rules config (YAML / DB)", 1, 3, "db")
    .node("events", "Throttle events", 2.4, 3.2, "queue")
    .node("metrics", "Metrics & alerting", 3.4, 3.2, "worker")
    .edge("client", "gw1", "request / 429")
    .edge("client", "gw2")
    .edge("gw1", "redis", "EVALSHA", { both: true })
    .edge("gw2", "redis", undefined, { both: true })
    .edge("gw1", "api")
    .edge("gw2", "api", "allowed")
    .edge("rules", "gw2", "hot reload", { async: true })
    .edge("gw2", "events", "throttled", { async: true })
    .edge("events", "metrics", undefined, { async: true })
    .steps(
      "Per request",
      [
        "Build key: rule + client id (API key / user / IP)",
        "Lua: refill tokens by elapsed time, try to take 1",
        "Allowed → forward; headers X-RateLimit-Remaining",
        "Denied → 429 + Retry-After",
        "Redis down → fail open (or local fallback limit)",
      ],
      3.9,
      0.6,
    )
    .build();
}
