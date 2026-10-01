# Ad Click Aggregator

> Record every click on an ad, aggregate clicks per ad per minute, and let advertisers query their numbers. Billing depends on this, so counts must be accurate and fraud-resistant.

## The problem in one minute

Every ad click is money: advertisers pay per click, so the counts end up on invoices. The system must:

1. **Never slow down the user.** The click is a redirect to the advertiser's site; logging it must not add visible latency.
2. **Never lose or double-count a click**, even though every component retries and users double-click.
3. **Show near-real-time numbers** (within about a minute) on dashboards, while producing **exact, fraud-filtered numbers** for billing.

Those last two goals pull in different directions, so the design uses the **Lambda architecture**: a streaming job produces fresh, very-nearly-right numbers every minute; a batch job later recomputes exact numbers from the immutable raw data and overwrites them. The raw click log is the source of truth for everything.

| Decision | Choice | Why |
| --- | --- | --- |
| Click capture | Signed click URL → click service logs to Kafka, then `302` | Fast redirect; only real impressions are billable |
| Transport | Kafka, partitioned by `ad_id`, `acks=all`, idempotent producer | Durable, ordered per ad, replayable |
| Dedup | One billable click per `impression_id` (Flink keyed state, TTL 1 h) | Double clicks and retries don't count twice |
| Aggregation | 1-minute tumbling windows on **event time** with watermarks | Count clicks in the minute they happened |
| Exactly-once | Flink checkpoints + upserts keyed by `(ad, minute, dims)` | Replays overwrite instead of adding |
| Correctness for billing | Hourly/daily Spark job over the raw archive, with fraud filtering | Exact, auditable numbers |
| Serving | Pre-aggregated rows in ClickHouse/Druid; minute → hour → day rollups | Sub-second dashboard queries |

## Requirements

### Functional

- A user clicks an ad → they are redirected to the advertiser's landing page, and the click is recorded.
- Advertisers query click counts per ad, campaign, or advertiser over time ranges, at minute granularity, filtered or grouped by country, device, and publisher.
- Billing uses the final daily counts.
- Detect and exclude fraudulent clicks.

### Non-functional

| Property | Target |
| --- | --- |
| Scale | 1 B clicks/day: ~12k/s average, ~100k/s peak |
| Redirect latency | < 50 ms added by the click service |
| Freshness | Dashboards reflect clicks within ~1 minute |
| Correctness | No lost clicks; no double counts; billing numbers exact and reproducible |
| Recovery | Any aggregate can be recomputed from raw data |
| Query latency | < 1 s for dashboard queries |

## Capacity estimation

- **Clicks:** 1 B/day ÷ 86,400 ≈ **12k/s**, with peaks around **100k/s** (prime time, big events).
- **Raw events:** ~200 bytes each → **200 GB/day**, ~70 TB/year uncompressed; Parquet compression brings that down ~5–10×.
- **Kafka:** 100k/s × 200 B = 20 MB/s at peak — modest. Retention of 7 days (~1.4 TB × replication) lets the stream job be down for days without data loss.
- **Aggregates:** 2 M active ads × 1,440 minutes = 2.9 B possible minute rows/day, but most ads get zero clicks in most minutes, so real rows are one to two orders of magnitude fewer. Adding dimensions (country × device) multiplies rows; keep dimension sets small at minute granularity.
- **Dedup state:** impressions clicked in the last hour: 12k/s × 3,600 ≈ 43 M IDs × ~50 B ≈ **2 GB** of keyed state across the Flink cluster.

## API

**Click (public):**

```http
GET /click?ad=ad-9&imp=imp-5521&pub=p-3&ts=1790000000&sig=4f2a…
302 Found
Location: https://advertiser.example/landing?utm_source=…
```

The URL is generated when the ad is served. `sig = HMAC(secret, ad | imp | pub | ts)`, so a click can't be forged for an impression we never served, and the parameters can't be tampered with.

**Reporting (advertisers):**

```http
GET /v1/reports/clicks?advertiser=adv-1&campaign=c-4&from=2026-09-27T00:00Z&to=2026-09-27T12:00Z
    &granularity=minute&group_by=country,device
→ 200 { "rows": [ { "ts": "2026-09-27T09:00Z", "country": "IN", "device": "mobile", "clicks": 1204 } ],
        "freshness": "2026-09-27T12:00:30Z", "final_through": "2026-09-26T23:59Z" }
```

The response says which part of the range is **final** (batch-corrected) and which is **provisional** (stream), so advertisers know which numbers may still change.

## Data model

See [Data model](#diagram/data-model).

```text
raw_clicks (S3 Parquet, partitioned by hour)
  click_id, impression_id, ad_id, campaign_id, advertiser_id, publisher_id,
  user/device id (hashed), ip, user_agent, country, device_type,
  event_ts, received_ts, fraud_score, valid

agg_minute (ClickHouse, ReplacingMergeTree(version))
  ad_id, minute_ts, country, device_type, clicks, version
  ORDER BY (ad_id, minute_ts, country, device_type)

agg_hour, agg_day   same shape, coarser time; longer retention

billing_daily (PostgreSQL)
  advertiser_id, campaign_id, day, valid_clicks, invalid_clicks, cost, job_run_id, status
```

**Why `ReplacingMergeTree(version)`?** Both the stream and the batch write rows for the same `(ad, minute, dims)`. A row with a higher version replaces lower ones when ClickHouse merges parts; queries use `FINAL` (or `argMax`) to read the latest. So the batch job can overwrite stream numbers for a period just by inserting with a higher version — no deletes.

## High-level architecture

See the [Architecture](#diagram/architecture) diagram.

| Component | Responsibility |
| --- | --- |
| Click service | Verify the signed URL, emit the click event, return `302` immediately; spool to local disk if Kafka is unavailable |
| Kafka `clicks` | Durable buffer, partitioned by `ad_id`, 7-day retention |
| Flink job (speed layer) | Dedupe, filter obvious fraud, window by event time, upsert minute aggregates |
| OLAP store | Pre-aggregated rows for dashboards (ClickHouse, Druid or Pinot) |
| Raw archive | Every click in S3 (via Kafka Connect), immutable |
| Spark job (batch layer) | Hourly/daily exact recomputation with full fraud scoring; overwrites the period |
| Fraud models | IP/device rate features, bot detection, blocklists; feed both layers |
| Query service | Picks the right rollup table for the requested range and granularity |
| Billing | Reads final daily aggregates; produces invoices |

## The click path

See [The click](#diagram/click-path).

1. The browser requests the signed click URL.
2. The click service verifies the HMAC and the timestamp. An invalid signature still redirects (the user shouldn't be punished) but the event is marked invalid and never billed.
3. It builds the event and hands it to an idempotent Kafka producer (`acks=all`) asynchronously, with a bounded in-memory buffer.
4. If Kafka is slow or down, the event goes to a local disk spool that a sidecar replays later — the redirect is never blocked and the click isn't lost.
5. It returns `302` to the advertiser's landing page.

## Stream aggregation

See [Stream aggregation](#diagram/streaming).

1. Flink reads the `clicks` topic; each task owns a range of partitions (and therefore of ads).
2. **Dedup:** keyed state remembers `impression_id`s seen in the last hour. Repeats (double clicks, retries, replays) are dropped.
3. **Window:** increment the count for `(ad, event-time minute, country, device)`.
4. **Watermarks** track how far event time has progressed (max event time seen minus the allowed lateness, e.g. 30 s). When the watermark passes the end of a minute, the window's count is final for the stream and is **upserted** to the OLAP store.
5. **Late events** (after their window closed) go to a side output; the batch job counts them.
6. Flink **checkpoints** Kafka offsets and keyed state every ~30 s. After a crash, it restarts from the last checkpoint and re-reads Kafka from those offsets; because the sink upserts absolute window counts keyed by the window, re-emitted results overwrite rather than add. That's end-to-end exactly-once in effect.

## Deep dives

### 1. Exactly-once, end to end

Every hop has a failure mode, and each is covered:

| Hop | Risk | Protection |
| --- | --- | --- |
| Browser → click service | Double click, browser retry | Dedup by `impression_id` downstream |
| Click service → Kafka | Lost event on crash; duplicate on retry | `acks=all`, idempotent producer, disk spool |
| Kafka → Flink | Reprocessing after restart | Checkpointed offsets + state |
| Flink → OLAP | Duplicate writes on replay | Upsert keyed by `(ad, minute, dims)` |
| Everything | Unknown bugs | Batch recomputation from raw data; stream-vs-batch reconciliation alerts |

### 2. Event time vs processing time

See [Windows & watermarks](#diagram/windows). A click that happened at 11:58 on a phone in a tunnel might arrive at 12:05. Counting it in the minute it **arrived** (processing time) would make numbers depend on network conditions and replays. Counting by **event time** gives stable, reproducible numbers. Watermarks decide how long to wait for stragglers; a longer allowed lateness means more accurate stream numbers but later results and more state. The batch job has no lateness limit.

Clock skew: event time comes from our own click service (`received_ts` is our clock), so it's trustworthy; client-side timestamps are only used as a hint.

### 3. Hot ads

A viral ad sends all its clicks to one Kafka partition and one Flink task. Fixes:

- **Key salting:** aggregate on `ad_id#k` for k in 0..15 in a first stage, then sum the 16 partial counts in a second stage.
- **Local pre-aggregation** in the click service: count per ad for a second and emit counts (only for the speed layer — the raw archive still keeps every click).

### 4. Click fraud

- **Signed impressions:** a click must reference an impression we actually served, within a time limit.
- **Rate features:** clicks per IP, per device, per publisher, per ad per minute; sudden spikes from one source.
- **Bot detection:** user-agent patterns, headless browser signals, known data-centre IP ranges.
- **Behavioural models:** time from impression to click (too fast = bot), landing-page bounce patterns.
- The stream applies cheap rules; the batch job applies full models and marks clicks invalid before billing. Advertisers see "invalid clicks" separately.

### 5. Serving queries fast

- Store pre-aggregated rows in a columnar OLAP store sorted by `(ad_id, time)`, so a query for one ad over a day reads a small contiguous range.
- The query service picks the table by granularity and range: minute rows for the last 7 days, hourly rows for older ranges, daily rows for long reports.
- Cache popular dashboard queries for ~30 s.

### 6. Lambda vs Kappa

- **Lambda (this design):** stream for freshness plus batch for correctness — two code paths to keep consistent.
- **Kappa:** stream only; to fix numbers, deploy a new job version and replay Kafka (needs long retention).
- Billing systems usually keep a batch reconciliation anyway, as an independent audit trail and because fraud models run better in batch with full context.

## Scaling and reliability

- Click services are stateless and horizontally scaled behind a load balancer, in several regions.
- Kafka partitions scale ingestion; Flink parallelism matches the partition count; state is checkpointed to S3.
- If the stream job is down, Kafka holds the events (7-day retention), and the job catches up when it restarts.

### Failure modes

| Failure | Impact | Handling |
| --- | --- | --- |
| Kafka unavailable | Clicks can't be published | Disk spool on click servers, replayed later |
| Flink job crash | Dashboards stop updating | Restart from checkpoint; catch up from Kafka |
| OLAP store slow | Dashboards slow | Cached queries; read replicas; rollups |
| Bug in stream logic | Wrong provisional numbers | Batch overwrite; reconciliation alert; replay with fixed job |
| Viral ad | Hot partition | Key salting, pre-aggregation |
| Late data beyond lateness | Stream undercounts slightly | Batch includes it |

## Observability

- Click service latency and error rate; spool size.
- Kafka consumer lag and **watermark delay** (event time vs wall clock).
- Dedup drop rate (a spike can indicate a bug or an attack).
- **Stream vs batch discrepancy** per hour — should be tiny; alert if above ~0.1 %.
- Invalid-click rate per publisher (fraud signal).

## Trade-offs to discuss

- **Freshness vs accuracy:** minute-fresh provisional numbers, then exact final numbers hours later.
- **Dedup window:** a longer window catches more duplicates but holds more state.
- **Pre-aggregation vs raw queries:** pre-aggregated rows are fast and cheap but can't answer questions about new dimensions; keep raw data for ad-hoc analysis.
- **Lambda vs Kappa:** two code paths vs expensive replays.

## Interview follow-up questions

- **An advertiser disputes yesterday's bill. What do you do?** Recompute from the immutable raw archive with the recorded job version and fraud model; the result must be reproducible.
- **How would you add impressions and click-through rate?** Same pipeline for impression events; join clicks to impressions by `impression_id` (stream join with a time bound, or in batch).
- **How do you add a new dimension (e.g. OS version) retroactively?** Backfill aggregates from the raw archive with a batch job.
- **How do you handle a region outage?** Click services in other regions keep logging to their own Kafka; clusters mirror to a central one; aggregates are keyed so merging regions is a sum.
- **Why not count clicks directly in the OLAP store with inserts?** You can at small scale; at 100k/s with dedup and fraud logic, a stream processor is the right place for that state.
