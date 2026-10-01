import { Diagram, Sequence, type DiagramSpec } from "./dsl";

function architecture() {
  return new Diagram("Search Autocomplete — architecture", "Serve precomputed top-k lists from memory; rebuild them offline from search logs")
    .zone("Online path (< 100 ms)", ["cdn", "svc", "shardmap", "t1", "t2", "trend"], "#2f9e44")
    .zone("Offline pipeline (hourly / daily)", ["kafka", "agg", "counts", "builder", "filter"], "#e8590c")
    .node("client", "Client", 0, 0.8, "client", { detail: ["debounce ~100 ms", "local cache per prefix"] })
    .node("cdn", "CDN / edge cache", 1.1, 0.8, "edge", { detail: "short prefixes, TTL 5 min" })
    .node("svc", "Autocomplete service", 2.2, 0.8, "service", { detail: ["merge global + trending", "+ personal, filter"] })
    .node("shardmap", "Shard map", 2.2, -0.4, "cache", { detail: "prefix range → shard" })
    .node("t1", "Trie shard 'a–ca'", 3.3, 0.3, "service", { detail: ["in-memory trie + top-k", "3 replicas"] })
    .node("t2", "Trie shard 'sy–sz'", 3.3, 1.4, "service", { detail: ["in-memory trie + top-k", "3 replicas"] })
    .node("trend", "Trending layer", 2.2, 2, "cache", { detail: ["Redis: last-hour top-k", "per prefix (short)"] })
    .node("search", "Search service", 0, 2.6, "service", { detail: "logs submitted queries" })
    .node("kafka", "Kafka: queries", 1.1, 3.3, "queue", { detail: "query, locale, ts" })
    .node("agg", "Aggregator", 2.2, 3.3, "worker", { detail: ["Flink: counts per window", "time decay"] })
    .node("counts", "Query counts", 3.3, 3.3, "db", { detail: "decayed score per query" })
    .node("builder", "Trie builder", 4.4, 3.3, "worker", { detail: "Spark: build trie + top-k" })
    .node("filter", "Safety filter", 5.5, 3.3, "service", { detail: "blocklist + classifier" })
    .node("snap", "Snapshots", 5.5, 1.9, "storage", { detail: ["S3, versioned", "one file per shard"] })
    .edge("client", "cdn", "GET /suggest?q=sys")
    .edge("cdn", "svc", "miss")
    .edge("svc", "shardmap")
    .edge("svc", "t1")
    .edge("svc", "t2", "top-k('sys')")
    .edge("svc", "trend")
    .edge("search", "kafka", undefined, { async: true })
    .edge("kafka", "agg", undefined, { async: true })
    .edge("agg", "counts")
    .edge("agg", "trend", "hot now", { async: true })
    .edge("counts", "builder")
    .edge("builder", "filter")
    .edge("filter", "snap", "publish")
    .edge("snap", "t2", "load (blue/green)", { async: true })
    .panel(
      "Scale",
      ["10 M daily users × 10 searches = 100 M searches/day", "~6 requests per search after debouncing ≈ 7k/s, 20k/s peak", "Top 100 M distinct queries after filtering", "Trie with cached top-10 ≈ tens of GB → a few shards"],
      5.5,
      0.3,
      { width: 400, tone: "info" },
    )
    .build();
}

function query() {
  return new Sequence("Typing \"sys\"", "Each keystroke is cheap: caches answer most, a single shard answers the rest", { gap: 230 })
    .actor("u", "User", "client")
    .actor("c", "Client", "client")
    .actor("cdn", "CDN", "edge")
    .actor("s", "Autocomplete service", "service")
    .actor("t", "Trie shard 'sy–sz'", "service")
    .actor("tr", "Trending layer", "cache")
    .msg("u", "c", "types 's', 'y', 's' within 200 ms")
    .msg("c", "c", "debounce: send only 'sys'; cancel the in-flight 'sy' request")
    .alt("'sys' already in the local cache", "u", "c")
    .msg("c", "u", "show cached suggestions instantly", { reply: true })
    .end()
    .msg("c", "cdn", "GET /suggest?q=sys&locale=en-US")
    .alt("popular prefix cached at the edge", "c", "s")
    .msg("cdn", "c", "suggestions (cached ≤ 5 min)", { reply: true })
    .else("miss")
    .msg("cdn", "s", "forward")
    .par("fetch in parallel", "s", "tr")
    .msg("s", "t", "top-10 at node 'sys' — walk 3 nodes, read the stored list")
    .msg("s", "tr", "trending for 'sys' in the last hour")
    .end()
    .msg("s", "s", "merge (trending boosts), drop blocked terms (serve-time kill list)")
    .msg("s", "cdn", "10 suggestions, Cache-Control: max-age=300", { reply: true })
    .msg("cdn", "c", "suggestions", { reply: true })
    .end()
    .msg("c", "u", "render; highlight the matching prefix", { reply: true })
    .note("Logged-in users: the service also merges a few matches from the user's own recent searches (kept client-side or in a small per-user store).", ["c", "tr"], "info")
    .build();
}

function trie() {
  return new Diagram("Deep dive — trie with cached top-k", "Every node stores the best completions beneath it, so a lookup is one walk down the prefix")
    .node("root", "(root)", 0, 1.5, "service", { w: 0.7 })
    .node("s", "s", 1, 1.5, "service", { w: 0.9, detail: ["1. system design", "2. spotify", "3. snow"] })
    .node("sy", "sy", 2, 1.5, "service", { w: 0.9, detail: ["1. system design", "2. sydney", "3. systemctl"] })
    .node("sys", "sys", 3, 1.5, "service", { highlight: true, w: 0.9, detail: ["1. system design 5.1 M", "2. systemctl 1.2 M", "3. sysco 0.9 M"] })
    .node("syst", "syst", 4, 0.6, "service", { w: 0.9, detail: ["1. system design", "2. systemctl", "3. system of a down"] })
    .node("sysc", "sysc", 4, 2.4, "service", { w: 0.9, detail: ["1. sysco", "2. syscall"] })
    .node("leaf1", "…system design", 5, 0.1, "db", { w: 0.9, detail: "count 5.1 M (end of query)" })
    .node("leaf2", "…systemctl", 5, 1.1, "db", { w: 0.9, detail: "count 1.2 M" })
    .edge("root", "s")
    .edge("s", "sy")
    .edge("sy", "sys")
    .edge("sys", "syst")
    .edge("sys", "sysc")
    .edge("syst", "leaf1")
    .edge("syst", "leaf2")
    .panel(
      "Why cache top-k at every node",
      [
        "Without it, 'sys' means visiting every query under that node — millions for short prefixes",
        "With it, a lookup is O(prefix length): walk 3 nodes, return the stored list",
        "Cost: k entries per node and expensive updates — so the trie is built offline, not updated per search",
        "Store ids / pointers to query strings, not copies, to save memory",
      ],
      0,
      3.4,
      { width: 560, numbered: true, tone: "info" },
    )
    .panel(
      "Memory estimate",
      ["100 M queries × ~20 chars ≈ 2 G characters, but shared prefixes collapse most nodes", "~500 M nodes × (children + top-10 ids) ≈ 50–100 GB", "Cap prefix depth at ~30 chars; cap nodes per shard; compress with a radix trie"],
      2,
      3.4,
      { width: 460 },
    )
    .build();
}

function pipeline() {
  return new Diagram("Deep dive — building & shipping the trie", "Counts with time decay, safety filtering, sharding by traffic, and zero-downtime swaps")
    .node("logs", "Query logs", 0, 0, "queue", { detail: "submitted searches only" })
    .node("clean", "Normalise", 1, 0, "worker", { detail: ["lowercase, trim, dedupe", "per user per hour"] })
    .node("count", "Windowed counts", 2, 0, "worker", { detail: "per query per hour" })
    .node("decay", "Decayed score", 3, 0, "db", { detail: "score = Σ count × 0.5^(age / 7 days)" })
    .node("safe", "Safety filter", 4, 0, "service", { detail: ["blocklist, PII, classifier", "min count threshold"] })
    .node("build", "Build per shard", 4, 1.4, "worker", { detail: ["prefix ranges from traffic", "top-k bottom-up"] })
    .node("s3", "Snapshot v2026-09-27-14", 3, 1.4, "storage", { detail: "one file per shard + checksum" })
    .node("green", "Green replicas", 2, 1.4, "service", { detail: ["load v…14 in the background", "warm up, verify"] })
    .node("blue", "Blue replicas", 2, 2.6, "service", { detail: "still serving v…13" })
    .node("lb", "Shard LB", 1, 2, "edge", { detail: "switch traffic when green is healthy" })
    .edge("logs", "clean")
    .edge("clean", "count")
    .edge("count", "decay")
    .edge("decay", "safe")
    .edge("safe", "build")
    .edge("build", "s3")
    .edge("s3", "green", "download")
    .edge("lb", "green", "new")
    .edge("lb", "blue", "old")
    .panel(
      "Sharding by traffic, not alphabet",
      ["'s' gets ~10× the traffic of 'x'", "Split by prefix ranges sized from last week's traffic: a–ab, ac–am, …, sy–sz", "Hot short prefixes are also served from the CDN and a small in-memory cache"],
      3.1,
      2.5,
      { width: 470, tone: "info" },
    )
    .build();
}

export default [
  { id: "architecture", name: "Architecture", build: architecture },
  { id: "query", name: "Query flow", build: query },
  { id: "trie", name: "Trie with top-k", build: trie },
  { id: "pipeline", name: "Build & deploy", build: pipeline },
] satisfies DiagramSpec[];
