import { Diagram, Sequence, type DiagramSpec } from "./dsl";

function architecture() {
  return new Diagram("Web Crawler — architecture", "A loop: frontier → fetch → parse → dedupe → store, and new links flow back into the frontier")
    .node("seeds", "Seed URLs", 0, 0, "client", { detail: "curated + sitemaps" })
    .node("frontier", "URL frontier", 1, 0, "queue", { detail: ["priority + per-host politeness", "billions of URLs on disk"] })
    .node("fetch", "Fetchers", 2.2, 0, "worker", { detail: ["async HTTP, 1k conns / node", "timeouts, size limits"] })
    .node("dns", "DNS cache", 2.2, -1.2, "cache", { detail: "local async resolver" })
    .node("robots", "robots.txt cache", 3.3, -1.2, "cache", { detail: "per host, refreshed daily" })
    .node("parse", "Parser / renderer", 3.3, 0, "worker", { detail: ["HTML → text + links", "headless Chrome if needed"] })
    .node("cseen", "Content seen?", 4.4, 0, "service", { detail: ["SHA-256 exact", "SimHash near-dup"] })
    .node("store", "Content store", 5.5, 0, "storage", { detail: ["WARC files in S3", "~500 TB / month"] })
    .node("index", "Indexing pipeline", 5.5, 1.3, "service", { detail: "search index, ranking signals" })
    .node("extract", "Link extractor", 3.3, 1.3, "worker", { detail: "absolute URLs" })
    .node("filter", "URL filter", 2.2, 1.3, "service", { detail: ["normalise, block lists", "trap heuristics"] })
    .node("useen", "URL seen?", 1, 1.3, "service", { detail: ["Bloom filter", "+ URL DB for truth"] })
    .node("meta", "Page metadata", 4.4, 2.5, "db", { detail: ["status, last crawl, hash", "next crawl time"] })
    .node("recrawl", "Recrawl scheduler", 1, 2.5, "worker", { detail: "due pages by change rate" })
    .edge("seeds", "frontier")
    .edge("frontier", "fetch", "next URL")
    .edge("fetch", "dns")
    .edge("fetch", "robots")
    .edge("fetch", "parse", "HTML")
    .edge("parse", "cseen")
    .edge("cseen", "store", "new content")
    .edge("store", "index", undefined, { async: true })
    .edge("parse", "extract", "links")
    .edge("extract", "filter")
    .edge("filter", "useen")
    .edge("useen", "frontier", "unseen URLs")
    .edge("cseen", "meta", "record")
    .edge("meta", "recrawl", "due pages", { async: true })
    .edge("recrawl", "frontier", undefined, { async: true, via: [[0.3, 2.5], [0.3, 0.9]] })
    .panel(
      "Scale",
      ["1 B pages / month ≈ 400 pages/s (800 peak)", "~500 KB per page → ~200 MB/s ≈ 1.6 Gbps", "10–100 B known URLs in the frontier", "~30 % of fetched pages are duplicates"],
      0,
      3.6,
      { width: 400, tone: "info" },
    )
    .build();
}

function crawlOne() {
  return new Sequence("Crawling one URL", "Politeness checks first, conditional GET to save bandwidth, dedupe before storing", { gap: 230 })
    .actor("f", "Frontier", "queue")
    .actor("w", "Fetcher", "worker")
    .actor("dns", "DNS cache", "cache")
    .actor("rob", "robots.txt cache", "cache")
    .actor("host", "example.com", "external")
    .actor("p", "Parser + dedup", "worker")
    .actor("s", "Content store", "storage")
    .msg("w", "f", "next URL (from a host that is due)")
    .msg("f", "w", "https://example.com/blog/post-17", { reply: true })
    .msg("w", "dns", "resolve example.com (cached, TTL-aware)")
    .msg("w", "rob", "allowed? crawl-delay?")
    .break("disallowed by robots.txt", "f", "rob")
    .msg("w", "f", "mark URL blocked; skip", { error: true })
    .end()
    .msg("w", "host", "GET /blog/post-17, If-None-Match: \"etag-9\", User-Agent: MyBot (+contact URL)")
    .alt("304 Not Modified", "w", "host")
    .msg("host", "w", "304", { reply: true })
    .msg("w", "f", "unchanged → lower this page's recrawl rate")
    .else("200 OK")
    .msg("host", "w", "HTML (≤ 10 MB, 30 s timeout)", { reply: true })
    .msg("w", "p", "page + headers")
    .msg("p", "p", "normalise text; SHA-256; SimHash (64-bit)")
    .msg("p", "s", "append to current WARC file (if not a duplicate)")
    .msg("p", "f", "extracted, normalised, unseen links")
    .else("429 / 503 / timeout")
    .msg("w", "f", "back off this host (double its delay); retry later", { error: true })
    .end()
    .msg("w", "f", "host next allowed at now + max(1 s, 10 × response time)")
    .build();
}

function frontier() {
  return new Diagram("Deep dive — the URL frontier", "Front queues decide what matters most; back queues make sure each host sees at most one request at a time")
    .node("in", "Incoming URLs", 0, 1.5, "client", { detail: "from link extraction + recrawls" })
    .node("prio", "Prioritiser", 1, 1.5, "service", { detail: ["PageRank, domain quality", "change rate, depth"] })
    .zone("Front queues (priority)", ["f1", "f2", "f3"], "#e8590c")
    .node("f1", "F1 — high", 2, 0.5, "queue")
    .node("f2", "F2 — medium", 2, 1.5, "queue")
    .node("f3", "F3 — low", 2, 2.5, "queue")
    .node("sel", "Biased selector", 3, 1.5, "service", { detail: "picks F1 most often, never starves F3" })
    .zone("Back queues (one host each)", ["b1", "b2", "b3"], "#2f9e44")
    .node("b1", "example.com", 4.1, 0.5, "queue", { detail: "next fetch 12:00:01.2" })
    .node("b2", "news.site", 4.1, 1.5, "queue", { detail: "next fetch 12:00:00.4" })
    .node("b3", "blog.io", 4.1, 2.5, "queue", { detail: "next fetch 12:00:03.0" })
    .node("heap", "Min-heap of next fetch times", 5.2, 1.5, "cache", { detail: "pop the earliest due host" })
    .node("threads", "Fetcher threads", 5.2, 2.8, "worker")
    .edge("in", "prio")
    .edge("prio", "f1")
    .edge("prio", "f2")
    .edge("prio", "f3")
    .edge("f1", "sel")
    .edge("f2", "sel")
    .edge("f3", "sel")
    .edge("sel", "b1", "host → queue map")
    .edge("sel", "b2")
    .edge("sel", "b3")
    .edge("b2", "heap")
    .edge("heap", "threads", "due host's next URL")
    .panel(
      "Rules",
      [
        "A back queue holds URLs of exactly one host; when it empties, refill it from the front queues",
        "At most one request in flight per host; delay between requests ≈ 10 × last response time (min 1 s), or robots Crawl-delay",
        "Everything is on disk with small in-memory head/tail buffers — the frontier holds billions of URLs",
      ],
      0,
      3.3,
      { width: 620, tone: "info" },
    )
    .build();
}

function dedup() {
  return new Diagram("Deep dive — deduplication & freshness", "Skip URLs we already know, pages we already have, and pages that haven't changed")
    .zone("URL seen?", ["norm", "bloom", "urldb"], "#1971c2")
    .node("norm", "Normalise URL", 0, 0, "service", { detail: ["lowercase host, drop #fragment", "sort query, strip session ids"] })
    .node("bloom", "Bloom filter", 1.1, 0, "cache", { detail: ["10 B URLs, 1 % FP ≈ 12 GB", "'definitely new' → enqueue"] })
    .node("urldb", "URL DB", 2.2, 0, "db", { detail: "exact answer when Bloom says 'maybe'" })
    .edge("norm", "bloom")
    .edge("bloom", "urldb", "maybe seen")
    .zone("Content seen?", ["sha", "simhash", "nd"], "#0c8599")
    .node("sha", "Exact: SHA-256", 0, 1.6, "service", { detail: "of normalised text" })
    .node("simhash", "Near-dup: SimHash", 1.1, 1.6, "service", { detail: ["64-bit fingerprint", "similar pages → similar bits"] })
    .node("nd", "Fingerprint index", 2.2, 1.6, "db", { detail: ["Hamming distance ≤ 3", "split into 4 × 16-bit blocks"] })
    .edge("sha", "simhash", "not exact dup")
    .edge("simhash", "nd", "lookup")
    .panel(
      "Recrawl scheduling",
      [
        "Estimate each page's change rate λ from its history (changed 3 of the last 10 visits)",
        "Next visit ≈ proportional to 1/λ: news home pages every few minutes, old docs every few months",
        "Boost pages that are popular, linked from fresh pages, or in sitemaps with new lastmod",
        "Conditional GET (ETag / If-Modified-Since) makes unchanged pages cost ~1 KB",
      ],
      3.3,
      -0.2,
      { width: 460, numbered: true, tone: "info" },
    )
    .panel(
      "Spider traps",
      ["Cap URL length (e.g. 2 KB) and path depth", "Cap pages per host per cycle", "Detect repeating path segments and endless calendars", "Timeouts and max body size per fetch"],
      3.3,
      1.6,
      { width: 460, tone: "warn" },
    )
    .build();
}

function distributed() {
  return new Diagram("Distributed crawl", "Partition by host so politeness is enforced locally; forward discovered URLs to their owner in batches")
    .zone("Crawler node 1 — hosts with hash % 3 = 0", ["n1f", "n1w"], "#2f9e44")
    .zone("Crawler node 2 — hosts with hash % 3 = 1", ["n2f", "n2w"], "#2f9e44")
    .zone("Crawler node 3 — hosts with hash % 3 = 2", ["n3f", "n3w"], "#2f9e44")
    .node("n1f", "Frontier shard", 0, 0, "queue", { detail: "its hosts only" })
    .node("n1w", "Fetch + parse", 1, 0, "worker")
    .node("n2f", "Frontier shard", 0, 1.5, "queue", { detail: "its hosts only" })
    .node("n2w", "Fetch + parse", 1, 1.5, "worker")
    .node("n3f", "Frontier shard", 0, 3, "queue", { detail: "its hosts only" })
    .node("n3w", "Fetch + parse", 1, 3, "worker")
    .node("bus", "URL exchange", 2.4, 1.5, "queue", { detail: ["Kafka topic per node", "batched, deduped"] })
    .node("coord", "Coordinator", 2.4, 0, "service", { detail: ["host → node map", "consistent hashing"] })
    .edge("n1f", "n1w")
    .edge("n2f", "n2w")
    .edge("n3f", "n3w")
    .edge("n1w", "bus", "links for other nodes", { async: true })
    .edge("bus", "n2f", "their URLs", { async: true, via: [[2.4, 2.25], [0, 2.25]] })
    .edge("n3w", "bus", undefined, { async: true })
    .panel(
      "Why partition by host",
      [
        "All URLs of a host live on one node → the per-host politeness delay needs no coordination",
        "DNS and robots.txt caches are naturally local",
        "Adding a node moves only some hosts (consistent hashing)",
        "Place nodes in regions near the hosts they crawl to cut latency",
      ],
      3.5,
      0,
      { width: 460, tone: "info" },
    )
    .build();
}

export default [
  { id: "architecture", name: "Architecture", build: architecture },
  { id: "crawl-one", name: "Crawl one URL", build: crawlOne },
  { id: "frontier", name: "URL frontier", build: frontier },
  { id: "dedup", name: "Dedup & freshness", build: dedup },
  { id: "distributed", name: "Distributed crawl", build: distributed },
] satisfies DiagramSpec[];
