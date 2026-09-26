# URL Shortener

> Turn `https://example.com/some/very/long/path?with=params` into `https://sho.rt/aB3xK9`, and redirect billions of clicks with single-digit-millisecond latency.

## Requirements

### Functional
- Create a short URL for a long URL; optionally a **custom alias** and **expiry**.
- Redirect `GET /{code}` to the original URL.
- Basic **click analytics** (count, referrer, geography) for the link owner.
- Optionally delete/disable a link.

### Non-functional
- **Very read-heavy** — assume 100:1 reads to writes.
- Redirect latency p99 < 20 ms at the service (excluding the internet).
- High availability (99.99 %) — a broken redirect breaks every page embedding it.
- Short codes must be **unique** and **not easily enumerable** (optional, but a common requirement).

## Estimation

| Metric | Assumption | Result |
| --- | --- | --- |
| New URLs | 100 M / month | ≈ 40 writes/s avg, ~200/s peak |
| Redirects | 100 : 1 | ≈ 4,000 reads/s avg, ~20k/s peak |
| Retention | 5 years | 6 B URLs |
| Record size | code + URL + metadata ≈ 500 B | ≈ 3 TB total |
| Cache | 20 % of daily hot links | ≈ 70 GB of RAM — one small Redis cluster |

**Code length:** base62 with 7 characters gives 62⁷ ≈ 3.5 × 10¹² codes — ~500× our 5-year need.

## API design

```http
POST /api/v1/urls
Authorization: Bearer <token>
{ "long_url": "https://…", "custom_alias": "launch", "expires_at": "2027-01-01T00:00:00Z" }

201 Created
{ "code": "aB3xK9", "short_url": "https://sho.rt/aB3xK9" }
```

```http
GET /aB3xK9
302 Found
Location: https://example.com/some/very/long/path
```

```http
GET /api/v1/urls/aB3xK9/stats?from=…&to=…
```

**301 vs 302:** `301 Moved Permanently` is cached by browsers, which saves load but hides repeat clicks from analytics. Use **302** (or 307) when analytics matter; 301 when pure offload matters.

## Data model

```text
urls
  code         PK  (string, 7 chars)
  long_url         (string, up to 2 KB)
  owner_id
  created_at
  expires_at       (nullable, TTL index)
  is_active
```

Access is a pure key lookup, so a **key-value / wide-column store** (DynamoDB, Cassandra) partitioned by `code` scales linearly. A relational DB also works at this scale if you shard by `code`.

To deduplicate identical long URLs per user, add a secondary index on `hash(long_url) + owner_id` — optional, and it costs an extra write.

## High-level design

See the diagram. There are two independent paths:

1. **Write path:** client → gateway → *Shorten service* → gets a unique key from the *Key Generation Service* → conditional insert into the URL store.
2. **Read path:** client → gateway → *Redirect service* → Redis → (on miss) URL store → `302`. A click event is emitted asynchronously to Kafka for analytics so the redirect never waits on analytics.

## Deep dives

### Generating unique short codes

| Approach | How | Pros | Cons |
| --- | --- | --- | --- |
| Hash + truncate | `base62(md5(url))[:7]` | Stateless, same URL → same code | Collisions must be detected and retried |
| Global counter + base62 | Auto-increment ID → base62 | No collisions, short | Counter is a bottleneck/SPOF; codes are sequential (enumerable) |
| **Pre-allocated ranges (KGS)** | A coordinator (ZooKeeper/DB row) hands each server a range of 1M IDs; server encodes locally | No coordination per request, no collisions | Unused IDs lost on crash (acceptable) |
| Pre-generated random keys | Offline job fills a table of unused random codes; servers claim batches | Non-sequential, O(1) | Extra storage and a claim protocol |

A good default: **range-based counter** mixed through a reversible permutation (e.g. a Feistel network or multiplication by a large odd constant modulo 62⁷) so codes are unique *and* non-sequential.

**Custom aliases** go through the same table with a conditional insert (`PutItem … attribute_not_exists(code)`); a conflict returns `409`.

### Caching the read path
- Cache-aside in Redis with an LRU policy; popularity follows a power law, so a small cache has a very high hit rate (>90 %).
- Put hot redirects at the **CDN edge** too (with a short TTL) for global latency.
- Negative-cache unknown codes briefly to absorb scans for random codes.

### Expiry and deletion
- Store `expires_at`; the redirect service checks it (cheap) and a background job/TTL index removes rows.
- On delete, **invalidate the cache** entry (write-then-delete-cache).

### Analytics
- Emit `{code, ts, ip, user_agent, referrer}` to Kafka.
- Stream consumers enrich (geo-IP, device parsing) and aggregate per minute into ClickHouse/Druid.
- Owners query pre-aggregated rollups, never raw events.

## Scaling & reliability

- Redirect service is stateless — scale horizontally behind the LB.
- Partition the URL store by `code`; hashing spreads load evenly.
- Replicate across AZs; multi-region active-active works because writes never conflict (codes are unique per range).
- If Kafka is down, drop or buffer analytics events locally — **never fail the redirect**.

## Security & abuse

- Rate-limit creation per user/IP (see *Distributed Rate Limiter*).
- Scan destination URLs against malware/phishing lists (Google Safe Browsing) at creation and periodically.
- Non-sequential codes prevent enumeration of private links.

## Trade-offs to discuss

- **Consistency:** a newly created link must be readable immediately by its creator — read from the primary or write-through the cache on creation.
- **Code length vs. capacity:** 6 chars (62⁶ ≈ 57 billion codes) may be enough; 7 gives headroom.
- **Same long URL → same code?** Saves storage but leaks that someone else shortened it and complicates per-user analytics. Most services generate a new code per request.
