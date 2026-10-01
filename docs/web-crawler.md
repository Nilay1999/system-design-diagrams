# Web Crawler

> Crawl billions of pages for a search engine: discover URLs, fetch politely, skip duplicates, store content, and keep it fresh.

## The problem in one minute

A crawler is a loop: take a URL, download the page, store it, pull out its links, and add new links to the list of URLs to visit. Written naively, it's a few dozen lines. At the scale of the web, every step becomes its own problem:

- **Which URL next?** There are tens of billions of known URLs, most of them junk. The crawler has to spend its bandwidth on important and changed pages.
- **Politeness.** Hitting one website with hundreds of requests per second is effectively a denial-of-service attack. Each host must see at most a gentle, steady trickle of requests.
- **Duplicates.** The same URL appears millions of times in links, and ~30 % of pages are copies or near-copies of other pages.
- **Hostile and broken content.** Infinite calendars, session IDs in URLs, 10 GB "pages", servers that answer one byte per second.
- **Freshness.** Pages change at wildly different rates; recrawling everything equally wastes most of the budget.

| Decision | Choice | Why |
| --- | --- | --- |
| Frontier | Two-level (Mercator): priority front queues + one-host-per-queue back queues | Important pages first, and politeness by construction |
| Politeness | One request in flight per host, delay ≈ 10× last response time, honour `robots.txt` | Never overload a site |
| URL dedup | Normalise, Bloom filter, then an exact URL store | Fast "definitely new", exact when unsure |
| Content dedup | SHA-256 for exact copies, SimHash for near-duplicates | Don't store or index the same page twice |
| Distribution | Partition by host hash across crawler nodes | Politeness and caches stay local, no coordination |
| Storage | WARC files in object storage + page metadata in a wide-column DB | Cheap bulk storage; fast lookups per URL |
| Freshness | Recrawl by estimated change rate, with conditional GETs | Spend bandwidth where content actually changes |

## Requirements

### Functional

- Start from seed URLs (and sitemaps); discover and follow links.
- Download HTML (and other types if needed: PDFs, images); optionally render JavaScript-heavy pages.
- Store raw content and metadata for the indexing pipeline.
- Recrawl pages according to how often they change.
- Respect `robots.txt`, `noindex`/`nofollow`, and site owners' crawl-rate preferences.

### Non-functional

| Property | Target |
| --- | --- |
| Throughput | 1 B pages per month (~400 pages/s, ~800 peak) |
| Politeness | Never more than one concurrent request per host; configurable delays |
| Robustness | Survive malformed HTML, slow or malicious servers, spider traps |
| Scalability | Add crawler nodes to increase throughput linearly |
| Extensibility | Plug in new content types and processors |
| Freshness | Important pages re-fetched within hours; the long tail within weeks |

## Capacity estimation

- **Fetch rate:** 1 B pages ÷ 30 days ÷ 86,400 s ≈ **400 pages/s**, ~800 at peak.
- **Bandwidth:** 400 pages/s × ~500 KB (page plus some resources) ≈ **200 MB/s ≈ 1.6 Gbps**. HTML alone is ~100 KB and compresses well.
- **Storage:** 1 B × 500 KB ≈ **500 TB/month** raw; compressed HTML-only is ~50–100 TB/month. Keeping 5 years of history: tens of PB → object storage.
- **Frontier:** 10–100 B known URLs × ~100 bytes ≈ **1–10 TB** — on disk, with small in-memory buffers.
- **URL-seen Bloom filter:** 10 B URLs at a 1 % false-positive rate needs ~9.6 bits per URL ≈ **12 GB** of RAM — fits on a few machines.
- **Connections:** with typical page fetch times of ~1 s and 400 pages/s, you need ~400 concurrent fetches on average; in practice thousands, because slow servers hold connections open. Async I/O (not a thread per connection).
- **DNS:** 400 lookups/s if uncached; most hosts repeat, so a local cache cuts this to a few per second.

## Interfaces

The crawler is an internal system; its "API" is its inputs and outputs:

```text
input:  seed list, sitemaps, recrawl schedule, per-host policies (max rate, blocked paths)
output: WARC records   { url, fetch_time, status, headers, body }         → content store
        page metadata  { url_hash, url, status, content_hash, simhash, last_crawl, next_crawl, change_rate }
        link graph     { from_url_hash, to_url_hash, anchor_text }         → ranking signals
admin:  POST /hosts/{host}/policy { "max_qps": 0.5 }    # e.g. after a site owner complains
        POST /urls { "url": "…", "priority": "high" }     # manual injection
```

## Data model

```text
page_meta     (url_hash PK, url, host, status, content_sha256, simhash,
               last_crawl_at, next_crawl_at, change_rate, etag, last_modified, depth)
               -- Bigtable / HBase / Cassandra, keyed by reversed host + path for locality
host_meta     (host PK, robots_txt, robots_fetched_at, crawl_delay, avg_response_ms,
               error_rate, pages_this_cycle, node_owner)
links         (from_url_hash, to_url_hash, anchor_text, seen_at)
warc files    s3://crawl/2026/09/27/node-17/000123.warc.gz  (many pages per file)
```

**Reversed host keys** (`com.example.www/blog/post-17`) keep a site's pages next to each other in a sorted store, which makes per-site scans (recrawl, analysis) efficient.

## High-level architecture

See the [Architecture](#diagram/architecture) diagram.

| Component | Responsibility |
| --- | --- |
| URL frontier | Holds URLs to visit; decides what's next based on priority and host politeness |
| Fetchers | Async HTTP clients; DNS via a local cache; check `robots.txt`; enforce timeouts and size limits |
| DNS cache | Local resolver with caching and asynchronous lookups |
| robots.txt cache | Per-host rules, refreshed daily |
| Parser / renderer | Extract text, metadata, and links; headless browser for pages that need JavaScript |
| Content-seen check | Exact (SHA-256) and near-duplicate (SimHash) detection |
| Content store | WARC files in object storage |
| Link extractor + URL filter | Absolute URLs, normalisation, block lists, trap detection |
| URL-seen check | Bloom filter + exact URL store |
| Page metadata | Status and schedule per URL |
| Recrawl scheduler | Re-inserts pages into the frontier when they're due |
| Indexing pipeline | Downstream consumer: builds the search index |

## Crawling one URL

See [Crawl one URL](#diagram/crawl-one).

1. A fetcher asks the frontier for a URL from a host that is due (its politeness delay has passed).
2. It resolves the host through the DNS cache.
3. It checks the host's cached `robots.txt`. If the path is disallowed, the URL is marked blocked and skipped.
4. It sends `GET` with `If-None-Match`/`If-Modified-Since` from the last crawl, a descriptive `User-Agent` with a contact URL, a 30 s timeout, and a 10 MB size cap.
5. **304 Not Modified:** nothing to download; the page's estimated change rate goes down.
6. **200 OK:** the parser normalises the content, computes SHA-256 and SimHash, and checks for duplicates. New content is appended to the current WARC file; metadata is updated; extracted links go through filtering and the URL-seen check into the frontier.
7. **429 / 503 / timeouts:** the host's delay doubles (exponential backoff) and the URL is retried later.
8. The host's next allowed fetch time is set to `now + max(1 s, 10 × response time)`, or the `Crawl-delay` from `robots.txt`.

## Deep dives

### 1. The URL frontier

See [URL frontier](#diagram/frontier). The classic design comes from the Mercator crawler:

- **Front queues (priority).** A prioritiser scores each URL — using PageRank-like importance of the page or domain, estimated change rate, depth from the site root, and whether it's in a sitemap — and puts it into one of F queues. A biased selector takes from high-priority queues more often but never starves the low ones.
- **Back queues (politeness).** Each back queue contains URLs of **one host only**, tracked in a `host → queue` map. A min-heap holds each back queue's "next allowed fetch time". A fetcher thread pops the heap's earliest entry, waits until it's due, fetches one URL from that queue, and pushes the queue back with a new time.
- When a back queue empties, it's refilled from the front queues (possibly assigning a new host).
- Everything lives mostly **on disk**, with in-memory buffers at each queue's head and tail.

This structure guarantees at most one outstanding request per host, and that important URLs are fetched first.

### 2. Politeness and robots.txt

- Fetch `robots.txt` per host before crawling it, cache it for ~24 h, and follow `Disallow`, `Allow`, and `Crawl-delay`.
- Adapt to the server: if responses slow down, increase the delay. Treat `429` and `503` as "back off now".
- Identify the crawler clearly (`User-Agent: MyBot/1.0 (+https://example.com/bot)`), publish its IP ranges, and provide an opt-out.
- Separate limits per **IP** as well as per host: many small sites share one server.

### 3. Deduplication

See [Dedup & freshness](#diagram/dedup).

**URL-level:**

1. **Normalise:** lowercase scheme and host, remove default ports and `#fragments`, resolve `../`, sort query parameters, strip known tracking and session parameters (`utm_*`, `sessionid`).
2. **Bloom filter:** "definitely not seen" answers need no disk I/O. A false positive (~1 %) means a small fraction of new URLs are wrongly skipped — acceptable at web scale, or reduce with a bigger filter.
3. **URL store:** for "maybe seen", check the exact store.

**Content-level:**

- **Exact duplicates:** hash the normalised text (SHA-256). Mirrors and `www`/non-`www` copies collapse.
- **Near-duplicates:** pages that differ only by ads, dates, or navigation. **SimHash** turns a page into a 64-bit fingerprint where similar pages have fingerprints differing in only a few bits. Two pages are near-duplicates if their Hamming distance is ≤ 3.
- **Fast lookup of "within 3 bits":** split each fingerprint into 4 blocks of 16 bits. If two fingerprints differ in ≤ 3 bits, at least one block matches exactly (pigeonhole), so index each block and only compare candidates that share a block.

### 4. Freshness and recrawling

- Keep a short change history per page and estimate its change rate λ (e.g. changed on 3 of the last 10 visits).
- Schedule the next visit roughly proportional to `1/λ`, weighted by importance: a news home page every few minutes, a static documentation page every few months.
- Sitemaps with `lastmod`, RSS feeds, and fresh inbound links are strong hints that a page changed.
- Conditional GETs make "no change" cost about 1 KB instead of the full page.

### 5. Spider traps and bad content

- Cap URL length (e.g. 2 KB) and path depth.
- Cap pages fetched per host per crawl cycle, scaled by the host's importance.
- Detect repeating path segments (`/a/b/a/b/a/b/…`) and endless calendars (`?date=` going forward forever).
- Enforce timeouts, maximum body size, and allowed content types.
- Watch for **soft 404s** — pages that return 200 with "not found" content — using content similarity.

### 6. JavaScript rendering

Some pages only produce their content with JavaScript. Rendering with a headless browser costs 10–100× more CPU than parsing HTML. Render **selectively**: when the raw HTML has little text but many scripts, or for hosts known to need it. Run rendering as a separate pool with its own queue.

### 7. DNS

DNS lookups can take tens to hundreds of milliseconds, and many HTTP libraries resolve synchronously, blocking a thread. Run a local caching resolver on each node, resolve asynchronously, and prefetch DNS for hosts about to become due.

## Distribution

See [Distributed crawl](#diagram/distributed).

- Partition the URL space **by host** (consistent hashing on the host name) across crawler nodes. All URLs for a host live on one node, so the node enforces politeness locally without asking anyone.
- When a node extracts links belonging to other nodes' hosts, it batches them and sends them through a URL exchange (a Kafka topic per node), deduplicating within the batch first.
- DNS and `robots.txt` caches are naturally local to the node that owns the host.
- Adding a node moves only a slice of hosts. Place nodes in several regions and assign them hosts that are geographically close.

## Scaling and reliability

- **Fetchers** are I/O-bound: scale by adding connections (async I/O) before adding machines.
- **Parsers** are CPU-bound: scale separately.
- **Frontier and metadata** are the stateful parts: checkpoint frontier queues to disk; the metadata store is replicated.
- If a node dies, its hosts are reassigned; its in-progress frontier is rebuilt from the checkpoint plus page metadata (`next_crawl_at`).

### Failure modes

| Failure | Impact | Handling |
| --- | --- | --- |
| Crawler node dies | Its hosts pause | Consistent hashing reassigns hosts; frontier restored from checkpoint |
| Slow host | Connections tied up | Per-fetch timeouts; lower that host's priority |
| Site owner complains | Reputation risk | Per-host policy override (e.g. 0.1 req/s) applied immediately |
| Spider trap | Budget wasted on junk | Per-host page caps, depth limits, pattern detection |
| Bloom filter lost | Re-crawl of known URLs | Rebuild from the URL store; it's a cache |
| Content store write errors | Pages not saved | Buffer WARC locally and retry; the page stays due in metadata |

## Observability

- Pages fetched/s by status code; bytes/s.
- Frontier size by priority; age of the oldest due URL.
- Per-host error rate and response time; hosts in backoff.
- Duplicate rates (URL-level and content-level).
- Freshness: fraction of important pages crawled within their target interval.

## Trade-offs to discuss

- **BFS vs prioritised crawl:** breadth-first is simple but spends effort on low-value pages; prioritisation focuses on what matters for search quality.
- **Rendering JavaScript:** better coverage at a much higher cost — do it selectively.
- **Bloom filter false positives:** some new URLs are never crawled; tune the filter size against memory.
- **Freshness vs coverage:** a fixed bandwidth budget is split between recrawling known pages and discovering new ones.

## Interview follow-up questions

- **How would you crawl only one site very quickly?** You can't, politely — the politeness limit caps it. Ask the site for a sitemap or a data feed instead.
- **How do you detect that a page is important before you've crawled it?** Inbound link counts and the importance of linking pages, domain reputation, sitemap presence, depth from the home page.
- **How do you handle pages behind logins?** Don't — a search crawler only crawls public content.
- **How would you change the design to crawl images or PDFs?** Content-type routing to separate processors, different size limits and storage; the frontier and politeness stay the same.
- **How do you prevent crawling the same page under different URLs?** URL normalisation, `rel=canonical`, and content-level dedup.
