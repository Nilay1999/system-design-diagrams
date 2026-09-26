import { Diagram } from "./dsl";

export default function typeahead() {
  return new Diagram("Search Autocomplete", "Serve precomputed top-k per prefix online; rebuild it offline from query logs")
    .zone("Online query path (p99 < 100 ms)", 0, 0, 5, 1, "#1971c2")
    .zone("Offline pipeline (hourly / daily)", 0, 2.1, 5, 1, "#e8590c")
    .node("client", "Search box (debounce 100 ms)", 0, 0, "client")
    .node("cdn", "Browser / CDN cache (short TTL)", 1, 0, "edge")
    .node("svc", "Autocomplete service", 2, 0, "service")
    .node("trie", "Trie servers (in-memory, sharded by prefix)", 3, 0, "cache", { w: 1.1 })
    .node("snap", "Trie snapshots (S3)", 4.2, 0, "storage")
    .node("logs", "Query log stream (Kafka)", 0, 2.1, "queue")
    .node("agg", "Aggregator (Spark / Flink)", 1, 2.1, "worker")
    .node("freq", "Query frequency table", 2, 2.1, "db")
    .node("build", "Trie builder (top-k per node)", 3, 2.1, "worker")
    .node("filter", "Blocklist / safety filter", 4.2, 2.1, "service")
    .edge("client", "cdn", "GET /suggest")
    .edge("cdn", "svc", "miss")
    .edge("svc", "trie", "top-k(prefix)")
    .edge("snap", "trie", "load on deploy", { async: true })
    .edge("client", "logs", "submitted queries", { async: true })
    .edge("logs", "agg", undefined, { async: true })
    .edge("agg", "freq", "counts")
    .edge("freq", "build")
    .edge("build", "filter")
    .edge("filter", "snap", "publish", { async: true })
    .build();
}
