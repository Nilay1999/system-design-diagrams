import { Diagram } from "./dsl";

export default function adClickAggregator() {
  return new Diagram("Ad Click Aggregator", "Lambda-style: streaming minute counts for freshness, batch recompute for correctness")
    .zone("Speed layer", 1, -0.9, 4.4, 2.4, "#1971c2")
    .zone("Batch layer (reconciliation)", 2, 1.9, 2, 1, "#e8590c")
    .node("browser", "Browser (ad click)", 0, 0.5, "client")
    .node("click", "Click service (log + 302)", 1, 0.5, "service")
    .node("kafka", "Click stream (Kafka) key = ad_id", 2, 0.5, "queue")
    .node("flink", "Stream aggregator (Flink, 1-min windows)", 3, 0.5, "worker")
    .node("dedup", "Dedup state (impression_id)", 3, -0.9, "cache")
    .node("olap", "OLAP store (ClickHouse) ad_id × minute", 4.3, 0.5, "db", { w: 1.1 })
    .node("s3", "Raw click archive (S3)", 2, 1.9, "storage")
    .node("spark", "Batch recompute (Spark, hourly)", 3, 1.9, "worker")
    .node("query", "Query service", 4.3, 1.9, "service")
    .node("advertiser", "Advertiser dashboard", 5.5, 1.9, "client")
    .edge("browser", "click", "click")
    .edge("click", "kafka", undefined, { async: true })
    .edge("kafka", "flink", undefined, { async: true })
    .edge("flink", "dedup", "seen?")
    .edge("flink", "olap", "upsert counts")
    .edge("kafka", "s3", "archive", { async: true })
    .edge("s3", "spark")
    .edge("spark", "olap", "overwrite hour")
    .edge("query", "olap")
    .edge("advertiser", "query", "clicks by ad / minute")
    .build();
}
