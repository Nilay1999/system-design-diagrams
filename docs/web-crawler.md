# Web Crawler

> Crawl billions of pages for a search engine: discover URLs, fetch politely, skip duplicates, store content, and keep it fresh.

## Requirements

### Functional
- Start from seed URLs; discover and follow links.
- Download HTML (optionally render JS), store raw content for indexing.
- Recrawl pages based on how often they change.

### Non-functional
- **Scale:** 1 B pages/month.
- **Politeness:** never overload a host; respect `robots.txt`.
- **Robustness:** tolerate malformed HTML, slow servers, spider traps.
- **Extensible:** plug in new content types or processors.

## Estimation

| Metric | Assumption | Result |
| --- | --- | --- |
| Throughput | 1 B pages / 30 days | ~400 pages/s avg, ~800 peak |
| Page size | 500 KB avg (HTML ~100 KB compressed) | ~500 TB/month raw; ~30 PB over 5 years |
| Bandwidth | 400 × 500 KB | ~200 MB/s ≈ 1.6 Gbps |
| URL frontier | 10–100 B known URLs | Must live on disk, with in-memory buffers |

## High-level design

The crawler is a **loop** (see diagram):

1. **URL frontier** hands out the next URL, respecting priority and per-host politeness.
2. **Fetchers** resolve DNS (cached), check `robots.txt` (cached), download the page.
3. **Parser** validates and extracts text/HTML (optionally a headless browser for JS-heavy pages).
4. **Content-seen?** check drops duplicate/near-duplicate content.
5. New content goes to the **content store**, which feeds the **indexing pipeline**.
6. **Link extractor** pulls `href`s; the **URL filter** normalises them and drops blocked/unwanted ones.
7. **URL-seen?** check drops URLs already known; the rest re-enter the frontier.

## Deep dives

### URL frontier: priority + politeness

A two-level design (from the Mercator crawler):

- **Front queues (priority):** a prioritiser assigns each URL to one of *F* queues based on PageRank, domain importance, and change frequency. A selector picks from higher-priority queues more often.
- **Back queues (politeness):** each back queue contains URLs of **one host only**. A mapping table `host → back queue` plus a min-heap of "next allowed fetch time" per queue guarantees **one outstanding request per host** and a delay between requests.

The frontier is mostly on disk (billions of URLs) with in-memory head/tail buffers per queue.

### Politeness
- Fetch and cache `robots.txt` per host (refresh daily); honour `Disallow` and `Crawl-delay`.
- Default delay ~1 s (or a multiple of the last response time) between requests to the same host.
- Back off on 429/503; identify the crawler with a proper `User-Agent` and contact URL.

### Deduplication
- **URL-level:** normalise (lowercase host, strip fragments, sort query params, remove session IDs) then check a **Bloom filter** (fast, small false-positive rate) backed by a persistent URL store for exact answers.
- **Content-level:** exact duplicates via a checksum (e.g. SHA-256 of normalised content); near-duplicates via **SimHash** (64-bit fingerprints; pages within Hamming distance ≤ 3 are near-dupes). ~30 % of the web is duplicate content.

### DNS
DNS resolution can take tens to hundreds of ms and is often synchronous in libraries — run a **local caching resolver** and resolve asynchronously ahead of fetches.

### Freshness / recrawl
- Track per-page change history; estimate change rate λ and schedule recrawls proportional to it (news homepages: minutes; static docs: months).
- Use conditional GETs (`If-Modified-Since`, `ETag`) to save bandwidth.

### Spider traps and bad content
- Limit URL length and path depth; cap pages per host per crawl cycle.
- Detect infinite calendars / session-ID loops via pattern heuristics.
- Filter by content type and size; enforce timeouts on slow servers.

## Distribution

- Partition the frontier **by host hash** so each crawler node owns a set of hosts — politeness is enforced locally without coordination.
- Nodes forward discovered URLs belonging to other partitions (batched).
- Place crawler nodes in multiple regions, crawling hosts that are geographically close.

## Storage

- Raw pages in object storage in **WARC** files (many pages per file), keyed by URL hash + fetch time.
- Metadata (status, last crawl, fingerprint, next crawl time) in a wide-column store (Bigtable/HBase/Cassandra).

## Trade-offs

- **BFS vs prioritised crawl:** pure BFS finds breadth but wastes effort on junk; priority queues focus on valuable pages.
- **Rendering JS:** far more expensive (a headless browser per page) — do it selectively for pages that need it.
- **Bloom filter false positives** mean a few new URLs are never crawled; acceptable at scale, or use a larger filter.
