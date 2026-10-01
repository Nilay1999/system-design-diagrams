import { Diagram, Sequence, type DiagramSpec } from "./dsl";

function architecture() {
  return new Diagram("Real-time leaderboard — architecture", "Durable score history is the truth; Redis sorted sets answer top-N and 'my rank' in O(log n)")
    .zone("Serving", ["lbsvc", "redis", "topcache"], "#e03131")
    .node("game", "Game servers", 0, 0.8, "client", { detail: ["server-authoritative results", "signed match reports"] })
    .node("score", "Score service", 1.1, 0.8, "service", { detail: ["validate + anti-cheat", "idempotent per match_id"] })
    .node("hist", "Score history", 1.1, 2.1, "db", { detail: ["every accepted score", "source of truth"] })
    .node("redis", "Redis sorted sets", 2.3, 0.8, "cache", { detail: ["lb:season42, lb:daily:…", "50 M members ≈ 5 GB"] })
    .node("lbsvc", "Leaderboard service", 3.4, 0.8, "service", { detail: ["top-N, my rank, around me", "friends boards"] })
    .node("topcache", "Top-100 cache", 3.4, -0.4, "cache", { detail: "rebuilt every 1 s" })
    .node("player", "Players", 4.5, 0.8, "client", { detail: "app / web" })
    .node("rebuild", "Rebuild job", 2.3, 2.1, "worker", { detail: "replay history if Redis is lost" })
    .node("anti", "Anti-cheat review", 0, 2.1, "worker", { detail: "outliers → quarantine" })
    .edge("game", "score", "match result")
    .edge("score", "hist", "insert")
    .edge("score", "redis", "ZADD GT")
    .edge("lbsvc", "redis", "ZREVRANK")
    .edge("lbsvc", "topcache")
    .edge("player", "lbsvc", "GET /leaderboard")
    .edge("hist", "rebuild", undefined, { async: true })
    .edge("rebuild", "redis", "bulk ZADD", { async: true })
    .edge("score", "anti", "suspicious", { async: true })
    .panel(
      "Scale",
      ["50 M players per season, 5 M daily", "~600 score updates/s average, 10× at events", "Top-100 read by everyone → cache it for 1 s", "Rank queries p99 < 50 ms"],
      4.5,
      -0.4,
      { width: 380, tone: "info" },
    )
    .build();
}

function flows() {
  return new Sequence("Submitting a score & reading ranks", "Write-through to the durable store and the sorted set; reads never touch the database", { gap: 250 })
    .actor("g", "Game server", "client")
    .actor("s", "Score service", "service")
    .actor("db", "Score history", "db")
    .actor("r", "Redis", "cache")
    .actor("lb", "Leaderboard service", "service")
    .actor("p", "Player", "client")
    .msg("g", "s", "POST /scores {match_id, user 123, score 1,850, signature}")
    .msg("s", "s", "verify signature, sanity bounds, per-user rate; dedupe by match_id")
    .msg("s", "db", "INSERT score (match_id unique)")
    .msg("s", "r", "ZADD lb:season42 GT 1850.000017 user:123 (tiebreak in decimals)")
    .msg("s", "r", "ZADD lb:daily:2026-09-27 GT … (same pipeline)")
    .msg("s", "g", "202 accepted", { reply: true })
    .phase("Reading")
    .msg("p", "lb", "GET /leaderboard/season42/me")
    .msg("lb", "r", "ZREVRANK lb:season42 user:123")
    .msg("r", "lb", "rank 48,211 (0-based)", { reply: true })
    .msg("lb", "r", "ZREVRANGE lb:season42 48206 48216 WITHSCORES")
    .msg("r", "lb", "11 neighbours with scores", { reply: true })
    .msg("lb", "p", "you are #48,212 — players just above and below you", { reply: true })
    .note("Top-100 is identical for everyone, so it is computed once per second and served from memory / CDN.", ["lb", "p"], "info")
    .build();
}

function sharding() {
  return new Diagram("Deep dive — beyond one Redis node", "Shard by score range so a global rank = rank inside my shard + everyone in higher shards")
    .zone("Score-range shards (with counts kept in a small table)", ["s1", "s2", "s3"], "#e03131")
    .node("s1", "Shard A: score ≥ 2,000", 0, 0, "cache", { detail: "ZCARD = 120,000" })
    .node("s2", "Shard B: 1,000 – 1,999", 1.2, 0, "cache", { detail: ["ZCARD = 9.6 M", "user:123 is #48,092 here"] })
    .node("s3", "Shard C: < 1,000", 2.4, 0, "cache", { detail: "ZCARD = 40 M" })
    .node("q", "Rank of user:123", 1.2, 1.4, "service", { detail: ["120,000 + 48,092", "= #168,092 globally"] })
    .edge("s1", "q", "count above")
    .edge("s2", "q", "rank in shard")
    .panel(
      "Score-range sharding",
      ["Top-N reads only the highest shard", "A score update may move a user between shards (remove + add)", "Rebalance boundaries as the score distribution shifts (usually at season start)"],
      3.6,
      -0.3,
      { width: 420, tone: "info" },
    )
    .panel(
      "Alternative: shard by user hash",
      ["Even load, simple updates", "Top-N: take top-N from every shard and merge", "Exact rank: sum ZCOUNT(score, +inf) from every shard — scatter-gather per request", "Often combined with approximate ranks (top 1 %, top 5 %) outside the top 10k"],
      3.6,
      1.2,
      { width: 420 },
    )
    .build();
}

function trending() {
  return new Diagram("Trending top-K — architecture", "Millions of events per second: approximate counts in a stream, exact counts in batch (Lambda)")
    .zone("Speed layer (seconds, approximate)", ["kafka", "flink", "merge", "topk"], "#e8590c")
    .node("events", "Events", 0, 0.8, "client", { detail: ["plays, views, hashtags", "1–10 M / s"] })
    .node("kafka", "Kafka", 1.1, 0.8, "queue", { detail: "partitioned by item id" })
    .node("flink", "Flink tasks", 2.2, 0.8, "worker", { detail: ["per partition, per minute:", "Count-Min Sketch + heap"] })
    .node("merge", "Global merge", 3.3, 0.8, "worker", { detail: ["combine partial top-K", "1 h = sum of 60 minutes"] })
    .node("topk", "Top-K store", 4.4, 0.8, "cache", { detail: ["Redis, one key per", "window + region"] })
    .node("api", "Trending API", 5.5, 0.8, "service", { detail: "cached 10 s" })
    .node("s3", "Raw event archive", 1.1, 2.3, "storage", { detail: "S3 / data lake" })
    .node("spark", "Exact counts", 2.2, 2.3, "worker", { detail: ["Spark hourly / daily", "overwrites approximate"] })
    .edge("events", "kafka")
    .edge("kafka", "flink")
    .edge("flink", "merge", "partial top-K")
    .edge("merge", "topk")
    .edge("topk", "api")
    .edge("kafka", "s3", "archive", { async: true })
    .edge("s3", "spark")
    .edge("spark", "topk", "corrected results", { via: [[4.4, 2.3]] })
    .build();
}

function sketch() {
  return new Diagram("Deep dive — Count-Min Sketch + heap", "Fixed memory no matter how many distinct items; estimates can only be too high, never too low")
    .table(
      "cms",
      "Count-Min Sketch: d = 4 rows × w = 2,000 counters",
      ["         col 17   col 403  col 1,288  …", "h1(x) →   ·        912      ·", "h2(x) →   950      ·        ·", "h3(x) →   ·        ·        915", "h4(x) →   ·        1,004    ·", "", "add(x):  +1 in one counter per row", "count(x) = min(912, 950, 915, 1,004) = 912"],
      0,
      0,
      { kind: "cache" },
    )
    .node("heap", "Min-heap of size K = 100", 2.5, 0.3, "service", { detail: ["current top-100 estimates", "root = smallest (#100)"] })
    .node("new", "Item x arrives", 2.5, -0.9, "client", { detail: "estimate 912 after update" })
    .node("decide", "912 > heap root (870)?", 2.5, 1.5, "service", { detail: "yes → pop root, push x" })
    .edge("new", "heap")
    .edge("heap", "decide")
    .panel(
      "Sizing",
      ["Error ≤ ε × total events with probability 1 − δ", "w = ⌈e / ε⌉, d = ⌈ln(1/δ)⌉", "ε = 0.001, δ = 0.01 → w ≈ 2,718, d = 5 → ~14k counters ≈ 55 KB", "Merge two sketches by adding matrices cell by cell"],
      0,
      2.4,
      { width: 520, tone: "info" },
    )
    .panel(
      "Alternatives",
      ["Space-Saving / Misra-Gries: keep only k counters, deterministic error bounds", "Exact INCR per item: fine for thousands of items, not millions of events/s", "Sliding windows: keep per-minute sketches and add the last 60"],
      2.5,
      2.4,
      { width: 470 },
    )
    .build();
}

export default [
  { id: "architecture", name: "Leaderboard architecture", build: architecture },
  { id: "flows", name: "Submit & read", build: flows },
  { id: "sharding", name: "Sharding ranks", build: sharding },
  { id: "trending", name: "Trending top-K", build: trending },
  { id: "sketch", name: "Count-Min Sketch", build: sketch },
] satisfies DiagramSpec[];
