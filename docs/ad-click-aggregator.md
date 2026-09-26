# Ad Click Aggregator

> Record every click on an ad, aggregate clicks per ad per minute, and let advertisers query their numbers. Billing depends on this, so counts must be accurate and fraud-resistant.

## Requirements

### Functional
- Users click an ad → they're redirected to the advertiser's page, and the click is recorded.
- Advertisers query click counts per ad (or campaign) over time ranges at **minute** granularity.
- (Often) filter by country, device, publisher.

### Non-functional
- **Scale:** 10 k clicks/s average, 100 k/s peak. Billions of clicks per day.
- **Freshness:** dashboards within ~1 minute.
- **Correctness:** no lost clicks, no double counts. Final numbers are used for billing.
- **Fault tolerant:** replay from raw data if the pipeline breaks.
- Query latency < 1 s for advertiser dashboards.

## Estimation

| Metric | Assumption | Result |
| --- | --- | --- |
| Clicks | 1 B/day | ~12k/s avg, ~100k/s peak |
| Raw event | ~200 B | ~200 GB/day raw → S3 |
| Aggregates | 2 M active ads × 1,440 min | ≤ 2.9 B rows/day worst case; most ads get few clicks per minute, so far fewer rows exist |

## API

```http
GET /click?ad_id=…&imp=<impression_id>&sig=<hmac>   → 302 Location: advertiser URL (and log the click)

GET /v1/ads/{ad_id}/clicks?from=…&to=…&granularity=minute&group_by=country
```

## Data model

```text
raw_click (click_id, impression_id, ad_id, campaign_id, user_id?, ip, ua, country, ts)   -- immutable log
agg_minute (ad_id, minute_ts, country, clicks)   -- OLAP table, primary key (ad_id, minute_ts, country)
```

## High-level design

1. **Click service**: validates the signed redirect URL, writes the click event to **Kafka** (partitioned by `ad_id`), and returns `302` right away. Logging must not slow the redirect.
2. **Speed layer:** a **Flink** job consumes the stream, deduplicates on `impression_id`, and aggregates counts in **1-minute tumbling windows** (event time, with watermarks for late events). It upserts results into an **OLAP store** (ClickHouse/Druid/Pinot).
3. **Batch layer:** all raw clicks are archived to **S3**. An hourly/daily **Spark** job recomputes exact aggregates from raw data and **overwrites** the speed-layer numbers for that period. This is the reconciliation step used for billing.
4. **Query service** reads pre-aggregated minute rows (and hourly/daily rollups) for dashboards.

## Deep dives

### Exactly-once counting
- The **click service** must not lose events: Kafka `acks=all`, and the producer retries idempotently.
- **Duplicates** come from user double-clicks, retries and bots. Deduplicate on `impression_id` (one billable click per impression) with keyed state in Flink (TTL ~1 h), or in Redis.
- **Flink checkpoints + a transactional/idempotent sink** make the stream exactly-once: on failure, it rewinds to the last checkpoint and replays Kafka offsets, and upserts by `(ad_id, minute)` make rewrites idempotent.

### Event time vs processing time
Clicks can arrive late (mobile offline, network delay). Aggregate by **event time**, use **watermarks** (e.g. allow 1–5 min lateness), and let the batch job correct anything later than that.

### Hot ads
A viral ad can overwhelm one Kafka partition or Flink task. Salt the key (`ad_id#0..N`) for pre-aggregation, then combine the partial counts in a second stage.

### Click fraud
Signed impression IDs (clicks without a real impression are rejected), IP/device rate limits, bot detection models, and blocklists. Suspected fraud is flagged and excluded in the batch layer before billing.

### Storage & querying
- Columnar OLAP with pre-aggregation handles fast `GROUP BY` over time ranges.
- Roll up minute → hour → day and drop fine granularity after N days to control storage.

### Why Lambda (or Kappa)?
- **Lambda:** stream for freshness, batch for correctness. Two code paths.
- **Kappa:** stream only. Recompute by replaying Kafka (long retention) through a new job version. Simpler code, but replays are heavy.
Billing systems often keep the batch reconciliation anyway as an audit trail.

## Scaling & reliability

- Stateless click services behind a LB, and Kafka partitions scale ingestion.
- Flink parallelism equals the partition count. State is checkpointed to S3.
- If the stream job is down, Kafka buffers events (retention ≥ recovery time), so nothing is lost.
- Monitor Kafka lag, watermark delay, and discrepancies between the stream and batch results.

## Trade-offs

- **Freshness vs accuracy:** minute-fresh approximate numbers, then hourly/daily exact numbers.
- **Dedup window size:** longer windows catch more duplicates but hold more state.
- **Pre-aggregation vs raw queries:** pre-aggregated rows are fast and cheap, but can't answer new dimensions. Keep the raw data for ad-hoc analysis.
