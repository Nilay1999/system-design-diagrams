import { Diagram } from "./dsl";

export default function urlShortener() {
  return new Diagram("URL Shortener", "Write path: create alias · Read path: 301/302 redirect (~100:1 read/write)")
    .zone("Analytics (async)", 3, 3, 3, 1, "#e8590c")
    .node("client", "Client", 0, 1, "client")
    .node("lb", "API gateway / LB", 1, 1, "edge")
    .node("shorten", "Shorten service", 2, 0, "service")
    .node("redirect", "Redirect service", 2, 2, "service")
    .node("kgs", "Key generation service (pre-allocated ranges)", 3, -0.6, "service", { h: 1.2 })
    .node("cache", "Redis cache (hot codes)", 3, 2, "cache")
    .node("db", "URL store (DynamoDB / Cassandra) code → long URL", 4, 1, "db", { h: 1.3 })
    .node("events", "Click events (Kafka)", 3, 3, "queue")
    .node("consumer", "Stream consumer", 4, 3, "worker")
    .node("olap", "Analytics DB (ClickHouse)", 5, 3, "db")
    .edge("client", "lb", "POST /urls\nGET /{code}")
    .edge("lb", "shorten", "create")
    .edge("lb", "redirect", "resolve")
    .edge("shorten", "kgs", "next key")
    .edge("shorten", "db", "insert if absent")
    .edge("redirect", "cache", "1. lookup")
    .edge("redirect", "db", "2. on miss")
    .edge("redirect", "events", "click", { async: true })
    .edge("events", "consumer", undefined, { async: true })
    .edge("consumer", "olap", "aggregate")
    .steps(
      "Redirect flow",
      [
        "GET /aB3xK9 hits the LB",
        "Redirect service checks Redis",
        "On miss, read DB and populate cache",
        "Respond 302 Location: <long URL>",
        "Emit click event asynchronously",
      ],
      5.3,
      -0.4,
    )
    .build();
}
