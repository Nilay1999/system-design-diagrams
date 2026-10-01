# URL Shortener

> Turn `https://example.com/some/very/long/path?with=params` into `https://sho.rt/aB3xK9Q`, and redirect billions of clicks with single-digit-millisecond latency.

## The problem in one minute

A URL shortener has two jobs that look nothing alike:

- **Creating** a short link is rare (tens of writes per second), but it must never hand out the same code twice.
- **Redirecting** is extremely common (thousands to tens of thousands of reads per second), and every millisecond counts, because the redirect sits in front of someone else's page load.

Because the two paths are so different, the design keeps them apart: separate services, separate scaling, and a redirect path that never depends on anything slow (analytics, safety checks, the key generator).

| Decision | Choice | Why |
| --- | --- | --- |
| Code format | 7 characters of base62 | 3.5 trillion codes, far more than we need, and short enough to type |
| Code generation | Pre-leased ID ranges + a reversible shuffle | No coordination per request, no collisions, codes are not guessable |
| Storage | Key-value store partitioned by `code` | Every read is a single-key lookup |
| Read path | CDN → Redirect service → Redis → DB | Over 90 % of reads never reach the database |
| Redirect status | `302` by default, `301` as an option | `302` keeps analytics accurate, `301` offloads more traffic |
| Analytics | Async click events into Kafka → Flink → ClickHouse | Analytics can fail without breaking redirects |

## Requirements

### Functional

- Create a short URL for a long URL.
  - Optional **custom alias** (`sho.rt/launch`), first come, first served.
  - Optional **expiry date**, after which the link returns `410 Gone`.
- Redirect `GET /{code}` to the original URL.
- **Click analytics** for the link owner: total clicks, clicks over time, top countries, referrers, and devices.
- List, disable, and delete your own links.

**Out of scope:** link previews, QR codes, editing the destination of an existing link (we treat links as immutable, which makes caching much simpler), and paid-tier features such as branded domains.

### Non-functional

| Property | Target | Notes |
| --- | --- | --- |
| Redirect latency | p99 < 20 ms at the service, p50 < 5 ms | Excludes internet round trips |
| Availability | 99.99 % for redirects | A broken redirect breaks every page and email that embeds it |
| Durability | A created link must never be lost | Replicate across availability zones before acknowledging |
| Uniqueness | Two long URLs must never get the same code | Unless the same owner asks for dedup |
| Enumeration | Codes should not be guessable in sequence | Otherwise private links can be scraped |
| Analytics freshness | Within about 1 minute | Eventually consistent is fine |

## Capacity estimation

Assumptions: 100 million new links per month, a 100 : 1 read-to-write ratio, links kept for 5 years.

**Writes**

- 100 M links ÷ (30 days × 86,400 s) ≈ **40 writes/s** on average.
- Traffic is bursty, so plan for about 5× the average: **~200 writes/s** at peak.

**Reads**

- 100 × 40 = **~4,000 redirects/s** on average, **~20,000/s** at peak.
- About 10 billion redirects a month.

**Storage**

- One record is roughly 500 bytes: a 7-byte code, a long URL averaging 100–200 bytes (up to 2 KB), owner id, timestamps, and index overhead.
- 100 M × 12 months × 5 years = **6 billion links**.
- 6 B × 500 B ≈ **3 TB** before replication, about 9 TB with 3 replicas. This fits comfortably in a small DynamoDB table or a Cassandra cluster of 6–9 nodes.

**Cache**

- Link popularity follows a power law: a small set of links gets most clicks.
- Caching the hottest 20 % of links clicked each day: 4,000 × 86,400 ≈ 350 M clicks/day. If about 100 M distinct links are clicked daily, 20 % is 20 M links × 500 B ≈ **10 GB**. Budgeting generously for Redis overhead and growth, **~70 GB** is plenty. That's one small Redis cluster.

**Analytics**

- 10 B click events a month × ~200 bytes ≈ 2 TB/month of raw events. Raw events live in Kafka for 7 days and in cheap object storage after that. Only per-minute rollups go into ClickHouse, which is roughly 100× smaller.

**Code length**

| Length | Codes available (62ⁿ) | Enough for 6 B links? |
| --- | --- | --- |
| 6 | 5.7 × 10¹⁰ (57 billion) | Yes, but only ~10× headroom |
| 7 | 3.5 × 10¹² (3.5 trillion) | Yes, ~500× headroom |
| 8 | 2.2 × 10¹⁴ | Overkill |

We choose **7 characters**. The extra headroom also makes random guessing hopeless: with 6 B of 3.5 T codes in use, a random guess hits a real link only 0.17 % of the time.

## API design

### Create a link

```http
POST /api/v1/urls
Authorization: Bearer <token>
Idempotency-Key: 5f1c3a7e-…
Content-Type: application/json

{
  "long_url": "https://example.com/some/very/long/path?with=params",
  "custom_alias": "launch",          // optional
  "expires_at": "2027-01-01T00:00:00Z" // optional
}
```

```http
201 Created
{
  "code": "launch",
  "short_url": "https://sho.rt/launch",
  "long_url": "https://example.com/some/very/long/path?with=params",
  "expires_at": "2027-01-01T00:00:00Z",
  "created_at": "2026-09-27T09:30:00Z"
}
```

| Status | When |
| --- | --- |
| `201 Created` | Link created (or an identical retry with the same `Idempotency-Key`) |
| `400 Bad Request` | Not a valid `http`/`https` URL, longer than 2 KB, or alias has illegal characters |
| `401 Unauthorized` | Missing or invalid token |
| `409 Conflict` | The custom alias is already taken |
| `422 Unprocessable Entity` | The destination is flagged as malware or phishing |
| `429 Too Many Requests` | Creation rate limit exceeded; see `Retry-After` |

### Redirect

```http
GET /aB3xK9Q

302 Found
Location: https://example.com/some/very/long/path?with=params
Cache-Control: private, max-age=60
```

Returns `404 Not Found` for unknown codes and `410 Gone` for expired or disabled links.

**301 or 302?** A `301 Moved Permanently` is cached by the browser forever, so repeat clicks never reach us. That saves load, but those clicks disappear from analytics and you can never disable the link for that browser. A `302 Found` (or `307`) is not cached permanently, so every click is counted. We default to `302` and offer `301` as an owner setting for people who care more about speed than stats.

### Manage and report

```http
GET    /api/v1/urls?cursor=…&limit=50            # my links, newest first
DELETE /api/v1/urls/{code}                        # soft delete: status = disabled
GET    /api/v1/urls/{code}/stats?from=…&to=…&granularity=hour
```

Stats response:

```json
{
  "code": "aB3xK9Q",
  "total_clicks": 18234,
  "series": [{ "ts": "2026-09-27T09:00:00Z", "clicks": 412 }, "…"],
  "top_countries": [{ "country": "IN", "clicks": 6120 }, "…"],
  "top_referrers": [{ "referrer": "twitter.com", "clicks": 3301 }, "…"]
}
```

## Data model

See the tables in [Key generation & data model](#diagram/key-generation).

### `urls` (DynamoDB or Cassandra)

| Column | Type | Notes |
| --- | --- | --- |
| `code` | string | **Partition key.** 7 characters, or a custom alias up to 30 |
| `long_url` | string | Up to 2 KB, stored normalised |
| `owner_id` | string | Secondary index `owner_id + created_at` for "my links" |
| `created_at` | number | Epoch milliseconds |
| `expires_at` | number, nullable | DynamoDB TTL attribute: expired rows are deleted automatically |
| `status` | string | `active` or `disabled` |
| `redirect_type` | number | `301` or `302` |
| `url_hash` | string, optional | `sha256(long_url)` for optional per-owner dedup |

**Why a key-value store?** Every hot query is "get one row by `code`". There are no joins and no range scans on the hot path. A key-value store partitioned by `code` spreads load evenly (codes are effectively random) and scales by adding partitions. A relational database also works at this size (3 TB, 200 writes/s), but you would have to shard it yourself by `code` sooner or later.

### Access patterns

| Pattern | Query | Frequency |
| --- | --- | --- |
| Redirect | Get by `code` | Very high, served mostly from cache |
| Create | Conditional put on `code` (only if absent) | Low |
| My links | Query index by `owner_id`, newest first, paginated | Low |
| Stats | Range scan on `(code, minute)` in ClickHouse | Low |
| Expiry | TTL deletes, or a sweeper scanning `expires_at` | Background |

### `clicks_per_minute` (ClickHouse)

A `SummingMergeTree` table ordered by `(code, minute)` with columns for country, referrer domain, device type, and a click count. ClickHouse merges rows with the same key in the background by adding their counts, so the stream processor can simply insert partial counts.

## High-level architecture

Open the [Architecture](#diagram/architecture) diagram alongside this section.

| Component | Responsibility | Technology | How it scales |
| --- | --- | --- | --- |
| CDN / edge | TLS termination close to users, GeoDNS, short-lived caching of hot redirects | CloudFront, Fastly, Cloudflare | Global PoPs |
| API gateway | Authentication, per-user and per-IP rate limits, request routing | Envoy, Kong, AWS API Gateway | Horizontal |
| Redirect service | Resolve code → URL, check status and expiry, emit a click event | Go or Rust, stateless | Horizontal; autoscale on CPU and RPS |
| Shorten service | Validate URL, check safety, get a code, store the link | Any language, stateless | Horizontal; low traffic |
| Key generation service (KGS) | Hand out ranges of 1 million unique IDs | Small service on ZooKeeper / etcd | Barely loaded: one call per million links |
| Redis cluster | Cache `code → {long_url, expires_at, status}` | Redis Cluster, LRU eviction | Add shards |
| URL store | Durable source of truth | DynamoDB or Cassandra, RF = 3 | Add partitions |
| Kafka `clicks` topic | Buffer click events | Kafka, partitioned by `code` | Add partitions and brokers |
| Stream processor | Enrich (geo-IP, user-agent parsing) and aggregate per minute | Flink | Add task slots |
| ClickHouse | Store rollups for stats queries | ClickHouse | Shard by `code` |
| Expiry sweeper | Remove expired links and their cache entries | Cron worker | Single leader |
| Safe Browsing | Detect malware and phishing destinations | Google Safe Browsing API or an internal list | External |

## Request flows

### Redirect (hot path)

Follow along in the [Redirect flow](#diagram/redirect-flow) diagram.

1. The browser requests `GET https://sho.rt/aB3xK9Q`. GeoDNS sends it to the nearest CDN edge.
2. If the edge has a fresh cached response for this code (popular links only, TTL ~60 s), it returns the `302` immediately. Clicks served at the edge are counted from CDN access logs.
3. Otherwise the edge forwards the request to the Redirect service in the nearest region.
4. The service reads `url:aB3xK9Q` from Redis. More than 90 % of requests stop here.
5. On a cache miss, it reads the row from the URL store and writes it into Redis with a 24-hour TTL. If the code does not exist, it caches a special "not found" marker for 60 seconds. This stops bots that scan random codes from hammering the database.
6. If the link is unknown, expired, or disabled, it returns `404` or `410`.
7. It puts a click event `{code, ts, ip, user_agent, referrer}` into an in-memory buffer that a background thread flushes to Kafka. The request never waits for Kafka.
8. It returns `302 Found` with the `Location` header.

**Latency budget (p99):** Redis round trip ~1 ms, database read on a miss ~5–10 ms, service overhead ~1–2 ms. Well under the 20 ms target.

### Create (cold path)

Follow along in the [Create flow](#diagram/create-flow) diagram.

1. The client sends `POST /api/v1/urls` with an `Idempotency-Key`.
2. The gateway checks the token and the rate limit (for example, 100 links per hour for free users).
3. The Shorten service normalises the URL: lowercase the scheme and host, drop the default port, reject non-`http(s)` schemes such as `javascript:`, and enforce the 2 KB limit.
4. It checks the destination with Safe Browsing. Flagged URLs get a `422`.
5. **Custom alias:** a conditional write `PutItem(code = alias) IF attribute_not_exists(code)`. If someone already owns the alias, the database rejects the write and we return `409`.
6. **Generated code:** take the next ID from the server's local range, shuffle it, encode it in base62, and do the same conditional write. The condition should never fail for generated codes, but keeping it costs nothing and protects against bugs.
7. Write the new mapping into Redis (write-through), so the creator's first test click is fast and consistent.
8. Store the response under the idempotency key for 24 hours, then return `201`.

## Deep dives

### 1. Generating unique short codes

| Approach | How it works | Pros | Cons |
| --- | --- | --- | --- |
| Hash and truncate | `base62(md5(long_url))[:7]` | Stateless; the same URL always gets the same code | Collisions happen (birthday paradox) and must be detected and retried; you can't give two owners separate links for one URL |
| Single global counter | Auto-increment ID → base62 | Simple, no collisions, shortest codes | The counter is a bottleneck and a single point of failure; codes are sequential and easy to enumerate |
| Random codes + check | Generate 7 random characters, insert if absent | Not guessable, no coordination | Every insert risks a collision, which gets more likely as the table fills |
| Pre-generated key table | An offline job fills a table of unused random codes; servers claim batches | Not guessable, O(1) per request | Extra storage and a claim protocol to get right |
| **Leased ID ranges + shuffle** | Servers lease blocks of 1 M IDs; each ID is shuffled and base62-encoded locally | No per-request coordination, no collisions, not guessable | IDs left in a crashed server's range are lost (harmless) |

**How the range lease works** (see the [deep-dive diagram](#diagram/key-generation)):

1. ZooKeeper (or etcd, or a single database row) stores one number: the next free range, e.g. `4,812`.
2. When a Shorten instance starts, or has used 90 % of its current range, it asks KGS for a new range. KGS does an atomic compare-and-set from `4,812` to `4,813` and returns range `4,812`, which means IDs `4,812,000,000` to `4,812,999,999`.
3. The instance hands out IDs from memory with no further coordination. At 200 writes/s spread over a few instances, one range lasts hours.

**Why shuffle?** Sequential IDs produce sequential codes (`aB3xK9Q`, `aB3xK9R`, …), so anyone can walk through all links. A **Feistel network** is a reversible shuffle: it maps every number in `[0, 62⁷)` to a different number in the same range, so uniqueness is preserved, but neighbouring inputs produce unrelated outputs.

```python
def permute(n: int, rounds: int = 4) -> int:
    # Balanced Feistel network over two halves; cycle-walk until inside [0, 62**7).
    while True:
        left, right = divmod(n, HALF)          # HALF = 2**21; 2**42 > 62**7, so every code fits
        for r in range(rounds):
            left, right = right, left ^ (hash32(right, KEY[r]) % HALF)
        n = left * HALF + right
        if n < 62**7:
            return n

def encode(n: int) -> str:
    alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
    out = []
    for _ in range(7):
        n, rem = divmod(n, 62)
        out.append(alphabet[rem])
    return "".join(reversed(out))
```

The keys are secret, so outsiders cannot reverse the shuffle.

### 2. Caching the read path

- **Cache-aside with LRU.** The Redirect service reads Redis first and fills it on a miss. With power-law popularity, a cache holding a few percent of links serves over 90 % of reads.
- **Links are immutable,** so there is no invalidation problem for normal links. Only delete and disable need to remove the cache entry (the Shorten service deletes the key after updating the database).
- **Negative caching.** Unknown codes are cached as "not found" for 60 seconds. Without this, a bot trying random codes would turn every request into a database read.
- **Hot keys.** A viral link can get 100k+ requests/s. The CDN edge absorbs most of it. As a second layer, each Redirect instance keeps a tiny in-process LRU (a few thousand entries, 5-second TTL), so a single Redis shard never sees the full blast.
- **Cache stampede.** When a hot key expires, many requests miss at once. Use request coalescing (only one request per instance fetches from the database; the rest wait for it) and add random jitter to TTLs.

### 3. Expiry and deletion

- Store `expires_at`. The Redirect service checks it on every request (it's already in the cached value), so an expired link stops working at exactly the right moment even if the row still exists.
- DynamoDB TTL or a nightly sweeper deletes expired rows later, to reclaim space.
- On delete, set `status = disabled` first (soft delete), remove the Redis key, and purge the CDN path. Hard-delete the row after a grace period.

### 4. Analytics pipeline

1. The Redirect service batches click events in memory and sends them to Kafka every 50–100 ms. The topic is partitioned by `code`, so events for one link stay in order.
2. Flink enriches each event: geo-IP lookup for the country, user-agent parsing for the device type, and the referrer reduced to its domain.
3. Flink counts per `(code, minute, country, referrer, device)` in a 1-minute tumbling window and writes the counts to ClickHouse.
4. The Stats service queries the rollups. Owners never touch raw events, so queries stay fast.
5. Bot filtering: drop known crawler user-agents, and count one click per `(ip, code)` per few seconds to damp refresh spam.

If Kafka is unavailable, the buffer fills and the oldest events are dropped. Analytics loses a little data, but redirects keep working. That is the right trade-off for this product.

### 5. Custom aliases

- Allowed characters `[A-Za-z0-9_-]`, 3–30 characters long.
- Keep a reserved list (`api`, `admin`, `login`, `help`, offensive words).
- Custom aliases share the table with generated codes. A generated code is always exactly 7 characters, so a custom alias with a different length can never collide with future generated codes. For 7-character aliases the conditional write handles any clash.

## Scaling and reliability

- **Stateless services** scale horizontally behind the load balancer. Redirect instances autoscale on CPU and request rate.
- **Database:** partition by `code`. Codes are effectively random, so load spreads evenly with no hot partitions except viral links, which the caches absorb.
- **Multi-region:** run the redirect path active-active in several regions. Each region has its own Redis and a replica of the URL store (DynamoDB global tables or multi-DC Cassandra). Writes can go to any region because codes never conflict: each region leases ranges from the same KGS, or each region owns a separate slice of the ID space.
- **Replication lag:** a link created in one region might not have reached another region yet. If a redirect misses in the local region, fall back to reading from the home region before returning `404`.

### Failure modes

| Failure | Impact | Mitigation |
| --- | --- | --- |
| Redis node down | Higher DB load and latency for that shard | Replica promotion; database sized to survive losing the cache for a while |
| Whole cache cold (after a restart) | Burst of DB reads | Warm the cache from yesterday's top links before taking traffic |
| URL store partition unavailable | Redirects for some codes fail on cache miss | Multi-AZ replication; serve stale cached entries past their TTL |
| KGS / ZooKeeper down | New ranges can't be leased | Each server holds a range lasting hours, so creation continues; alert long before ranges run out |
| Kafka down | Click events lost | Local buffer, then drop; never block redirects |
| Safe Browsing API down | Can't check new URLs | Accept and queue for a re-check within minutes; disable if flagged |
| Region outage | Users in that region see errors | GeoDNS health checks move traffic to the next closest region |

## Security and abuse

- **Rate-limit creation** per user and per IP (see the Distributed Rate Limiter topic). Anonymous creation gets much tighter limits.
- **Malicious destinations:** check with Safe Browsing on creation and re-scan popular links periodically. Offer a public "report this link" endpoint. Disabled links show a warning page instead of redirecting.
- **Enumeration:** shuffled codes plus rate limits on 404s per IP make scraping impractical.
- **Open redirect abuse:** only `http` and `https` destinations. Never `javascript:`, `data:` or `file:`.
- **Preview page:** support `sho.rt/aB3xK9Q+` to show the destination without redirecting, so cautious users can inspect it.

## Observability

| Signal | Why it matters | Alert threshold (example) |
| --- | --- | --- |
| Redirect p50 / p99 latency | Core user experience | p99 > 20 ms for 5 minutes |
| Redirect error rate (5xx) | Availability SLO | > 0.1 % |
| Cache hit ratio | A drop means more DB load | < 85 % |
| 404 rate per IP | Scanning bots | Spike vs baseline |
| KGS range headroom | Time until servers run out of IDs | < 2 hours of IDs left |
| Kafka produce failures / dropped events | Analytics completeness | > 1 % dropped |
| End-to-end analytics lag | Freshness of stats | > 5 minutes |

## How the design evolves

1. **MVP (one region, ~1k redirects/s):** a single Postgres with `code` as the primary key, one app serving both paths, a Redis cache, a counter + base62 for codes. This works fine at small scale.
2. **Growth (~20k redirects/s):** split the Redirect and Shorten services, add the CDN, move to leased ID ranges with a shuffle, send clicks through Kafka to ClickHouse instead of updating counters in the main database.
3. **Global scale:** active-active regions, DynamoDB global tables or multi-DC Cassandra, per-region caches, edge caching for viral links, dedicated abuse detection.

## Trade-offs to discuss

- **Consistency after create.** A newly created link must work immediately for its creator. Write-through to the cache and read from the primary (or strongly consistent reads) on a cache miss for very new links.
- **Same long URL, same code?** Dedup saves a little storage but leaks information ("someone already shortened this") and mixes analytics between owners. Most services create a new code per request and only dedup within one owner, if at all.
- **CDN caching vs. analytics accuracy.** Caching redirects at the edge makes viral links nearly free to serve, but you then have to count clicks from CDN logs, which arrive with delay.
- **SQL vs. NoSQL.** At 3 TB and 200 writes/s, sharded Postgres works. A managed key-value store removes the sharding work and scales further. Both are defensible; pick the one your team can operate.

## Interview follow-up questions

- **How would you let owners change the destination of a link?** Treat edits as rare writes that invalidate the Redis key and purge the CDN. Lower the CDN TTL for editable links and never use `301` for them, since browsers cache `301` forever.
- **How do you stop someone from creating a billion links?** Per-account quotas, rate limits, CAPTCHA for anonymous creation, and anomaly detection on creation rates.
- **What if the code space ran out?** Move to 8 characters. Old 7-character codes stay valid because code length is not assumed anywhere on the read path.
- **How would you support 1 million redirects/s for a single viral link?** The CDN edge cache handles most of it. Behind it, the in-process cache on each Redirect instance means Redis sees at most a few requests per instance per second for that key.
- **How do you count unique visitors?** HyperLogLog per link per day. It uses about 12 KB per counter and has around 1 % error.
