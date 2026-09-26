import { Diagram } from "./dsl";

export default function webCrawler() {
  return new Diagram("Web Crawler", "A loop: frontier → fetch → parse → dedupe → extract links → back to frontier")
    .node("seeds", "Seed URLs", 0, 0, "client")
    .node("frontier", "URL frontier (priority front queues + per-host back queues)", 1, 0, "queue", { h: 1.4 })
    .node("dns", "DNS cache", 2, -1.3, "cache")
    .node("robots", "robots.txt cache", 3, -1.3, "cache")
    .node("fetch", "Fetchers (async HTTP)", 2, 0, "worker")
    .node("parse", "Parser / renderer", 3, 0, "worker")
    .node("seen", "Content seen? (SimHash)", 4, 0, "cache")
    .node("store", "Content store (S3 / WARC)", 5, 0, "storage")
    .node("index", "Indexing pipeline", 5, 1.6, "worker")
    .node("extract", "Link extractor", 4, 1.6, "worker")
    .node("filter", "URL filter & normalizer", 3, 1.6, "service")
    .node("urlseen", "URL seen? (Bloom filter + DB)", 2, 1.6, "cache")
    .edge("seeds", "frontier")
    .edge("frontier", "fetch", "next URL")
    .edge("fetch", "dns")
    .edge("fetch", "robots")
    .edge("fetch", "parse", "HTML")
    .edge("parse", "seen", "fingerprint")
    .edge("seen", "store", "new content")
    .edge("store", "index", undefined, { async: true })
    .edge("seen", "extract", "unique pages")
    .edge("extract", "filter", "hrefs")
    .edge("filter", "urlseen", "canonical URLs")
    .edge("urlseen", "frontier", "unseen → enqueue", { async: true })
    .steps(
      "Politeness",
      [
        "One back queue per host, one fetcher per queue",
        "Honour robots.txt and Crawl-delay",
        "Adaptive delay on 429 / slow responses",
        "Priority from PageRank, freshness, change rate",
      ],
      0,
      2.8,
    )
    .build();
}
