import { Diagram, Sequence, type DiagramSpec } from "./dsl";

function architecture() {
  return new Diagram("Ad Click Aggregator — architecture", "Lambda: a stream gives minute-fresh numbers, a batch job recomputes exact, fraud-filtered numbers for billing")
    .zone("Speed layer (≈ 1 min fresh)", ["flink", "olap"], "#e8590c")
    .zone("Batch layer (hourly / daily, exact)", ["s3", "spark", "final"], "#1971c2")
    .node("user", "User", 0, 0.8, "client", { detail: "clicks an ad" })
    .node("click", "Click service", 1.1, 0.8, "service", { detail: ["verify signed URL", "log, then 302 redirect"] })
    .node("adv", "Advertiser site", 1.1, -0.4, "external")
    .node("kafka", "Kafka: clicks", 2.2, 0.8, "queue", { detail: ["partitioned by ad_id", "retention 7 days"] })
    .node("flink", "Flink job", 3.3, 0.3, "worker", { detail: ["dedup by impression_id", "1-min event-time windows"] })
    .node("olap", "OLAP store", 4.4, 0.3, "db", { detail: ["ClickHouse / Druid", "(ad, minute, country)"] })
    .node("s3", "Raw click archive", 3.3, 1.9, "storage", { detail: "S3, Parquet, hourly files" })
    .node("spark", "Spark batch", 4.4, 1.9, "worker", { detail: ["exact counts", "fraud-filtered"] })
    .node("final", "Billing aggregates", 5.5, 1.9, "db", { detail: "final, audited" })
    .node("query", "Query service", 5.5, 0.3, "service", { detail: "minute / hour / day rollups" })
    .node("dash", "Advertiser dashboard", 6.6, 0.3, "client")
    .node("fraud", "Fraud models", 2.2, 2.4, "service", { detail: ["IP / device rates", "bot scores"] })
    .edge("user", "click", "GET /click?imp=…&sig=…")
    .edge("click", "adv", "302")
    .edge("click", "kafka", "event (acks=all)", { async: true })
    .edge("kafka", "flink", undefined, { async: true })
    .edge("flink", "olap", "upsert")
    .edge("kafka", "s3", "Kafka Connect", { async: true })
    .edge("s3", "spark")
    .edge("spark", "final")
    .edge("spark", "olap", "overwrite period", { async: true })
    .edge("olap", "query")
    .edge("query", "dash")
    .edge("fraud", "spark", "flags", { via: [[2.2, 3.1], [4.4, 3.1]] })
    .panel(
      "Scale",
      ["1 B clicks / day ≈ 12k/s, 100k/s peak", "~200 B per raw click → 200 GB / day", "2 M active ads; most get few clicks per minute", "Dashboards < 1 s; data ≤ 1 min old"],
      0,
      2,
      { width: 380, tone: "info" },
    )
    .build();
}

function clickPath() {
  return new Sequence("The click", "The redirect must be fast and the event must never be lost", { gap: 240 })
    .actor("u", "Browser", "client")
    .actor("c", "Click service", "service")
    .actor("k", "Kafka", "queue")
    .actor("a", "Advertiser site", "external")
    .msg("u", "c", "GET /click?ad=ad-9&imp=imp-5521&ts=…&sig=hmac(…)")
    .msg("c", "c", "verify HMAC (impression really served by us), check expiry")
    .break("bad signature or expired", "u", "c")
    .msg("c", "u", "302 to the ad anyway, but log as invalid (not billable)", { error: true })
    .end()
    .msg("c", "c", "build event {click_id, impression_id, ad_id, campaign, ip, ua, country, event_ts}")
    .msg("c", "k", "produce (key = ad_id, idempotent producer, acks=all)", { async: true })
    .alt("Kafka slow or unavailable", "c", "k")
    .msg("c", "c", "append to a local disk spool; a sidecar replays it later", { error: true })
    .end()
    .msg("c", "u", "302 Location: advertiser URL", { reply: true })
    .msg("u", "a", "GET landing page")
    .note("The user is never kept waiting on analytics: producing is asynchronous with a bounded buffer, and the disk spool covers outages.", ["u", "k"], "info")
    .build();
}

function streaming() {
  return new Sequence("Stream aggregation, exactly once", "Dedupe, window by event time, checkpoint, and upsert idempotently", { gap: 250 })
    .actor("k", "Kafka", "queue")
    .actor("f", "Flink task (ad_id range)", "worker")
    .actor("st", "Keyed state", "cache")
    .actor("cp", "Checkpoint store", "storage")
    .actor("o", "OLAP store", "db")
    .msg("k", "f", "click imp-5521, ad-9, event_ts 12:00:41")
    .msg("f", "st", "seen imp-5521 in the last hour?")
    .alt("duplicate (double click, retry)", "f", "st")
    .msg("f", "f", "drop — one billable click per impression")
    .else("new")
    .msg("f", "st", "remember imp-5521 (TTL 1 h); window[ad-9, 12:00–12:01, IN] += 1")
    .end()
    .msg("k", "f", "… watermark advances to 12:01:30 (allowed lateness 30 s)")
    .msg("f", "o", "upsert (ad-9, 12:00, IN) = 1,204 — same key on replay, so replays are harmless")
    .loop("every 30 s", "f", "cp")
    .msg("f", "cp", "checkpoint: Kafka offsets + keyed state (S3)")
    .end()
    .msg("k", "f", "late click event_ts 11:58:10 (after its window closed)")
    .msg("f", "f", "side output → late-events topic; the batch job counts it", { error: true })
    .note("On failure Flink restarts from the last checkpoint and re-reads Kafka from the stored offsets. Because the sink upserts absolute window counts, re-emitted results overwrite rather than add.", ["f", "o"], "warn")
    .build();
}

function windows() {
  return new Diagram("Deep dive — event time, windows & watermarks", "Clicks are counted in the minute they happened, not the minute they arrived")
    .zone("Tumbling 1-minute windows for ad-9 (event time)", ["w1", "w2", "w3"], "#1971c2")
    .node("w1", "12:00 – 12:01", 0, 0, "db", { detail: ["1,204 clicks", "closed + emitted"] })
    .node("w2", "12:01 – 12:02", 1.1, 0, "db", { detail: ["876 clicks so far", "open"] })
    .node("w3", "12:02 – 12:03", 2.2, 0, "db", { detail: "open" })
    .node("wm", "Watermark 12:01:30", 1.1, 1.3, "service", { detail: ["'no event older than this is expected'", "= max event time seen − 30 s"] })
    .node("late", "Click from 11:58:10", 0, 1.3, "client", { highlight: true, detail: "phone was offline" })
    .node("side", "Late events", 0, 2.6, "queue", { detail: "counted by the batch job" })
    .node("salt", "Hot ad-7 (viral)", 2.2, 1.3, "client", { detail: "100k clicks/s on one key" })
    .node("pre", "Pre-aggregate ad-7#0 … #15", 2.2, 2.6, "worker", { detail: "16 sub-keys, then sum" })
    .edge("wm", "w1", "closes")
    .edge("late", "side", "window already closed")
    .edge("salt", "pre", "salted keys")
    .panel(
      "Choosing the lateness",
      ["Longer allowed lateness → more accurate stream numbers, but windows emit later and state is held longer", "Typical: 30 s – 5 min for dashboards", "Anything later is fixed by the batch recomputation"],
      3.4,
      -0.2,
      { width: 460, tone: "info" },
    )
    .panel(
      "Rollups",
      ["Minute rows kept 7 days", "Hour rows kept 13 months", "Day rows kept forever", "Raw clicks in S3 for audits and new dimensions"],
      3.4,
      1.4,
      { width: 460 },
    )
    .build();
}

function dataModel() {
  return new Diagram("Data model", "Immutable raw events, then pre-aggregated tables at increasing granularity")
    .table(
      "raw",
      "raw_clicks  (S3 Parquet, partitioned by hour)",
      ["click_id        uuid", "impression_id   signed, unique per ad view", "ad_id, campaign_id, advertiser_id", "publisher_id", "user_id / device_id (hashed)", "ip, user_agent, country", "event_ts, received_ts", "fraud_score, valid"],
      0,
      0,
      { kind: "storage" },
    )
    .table(
      "minute",
      "agg_minute  (ClickHouse)",
      ["ad_id", "minute_ts", "country", "device_type", "clicks            UInt64", "ENGINE ReplacingMergeTree(version)", "ORDER BY (ad_id, minute_ts, country, device_type)"],
      1.8,
      0,
    )
    .table(
      "billing",
      "billing_daily  (PostgreSQL)",
      ["advertiser_id, campaign_id", "day", "valid_clicks, invalid_clicks", "cost = Σ clicks × CPC", "computed_by_job_run", "status: provisional | final"],
      1.8,
      2.2,
    )
    .edge("raw", "minute", "stream + batch")
    .edge("raw", "billing", "batch only")
    .panel(
      "Why ReplacingMergeTree",
      ["The stream and the batch both write (ad, minute) rows", "A higher version replaces a lower one when parts merge", "Queries use FINAL (or argMax) to read the latest version", "So the batch can overwrite stream numbers without deletes"],
      3.7,
      0,
      { width: 420, tone: "info" },
    )
    .build();
}

export default [
  { id: "architecture", name: "Architecture", build: architecture },
  { id: "click-path", name: "The click", build: clickPath },
  { id: "streaming", name: "Stream aggregation", build: streaming },
  { id: "windows", name: "Windows & watermarks", build: windows },
  { id: "data-model", name: "Data model", build: dataModel },
] satisfies DiagramSpec[];
