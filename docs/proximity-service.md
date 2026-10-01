# Proximity Service (Yelp / Google Places)

> Given a user's location and a radius, return nearby businesses (restaurants, fuel stations, …) quickly and ranked well.

## The problem in one minute

"Find cafés within 2 km of me" is a **two-dimensional range query**, and ordinary database indexes are one-dimensional: an index on latitude finds a horizontal strip of the planet, an index on longitude finds a vertical strip, and intersecting two huge strips is slow. Geospatial indexes solve this by mapping 2-D space onto cells that can be looked up like ordinary keys — **geohashes**, **quadtrees**, or cell systems like **S2** and **H3**.

The second key observation is size: 200 million businesses × (ID + latitude + longitude) is only **~5 GB**. The whole geo index fits in memory on every search server. Searches never need a network hop to find candidates; the database is only for business details and owner edits.

| Decision | Choice | Why |
| --- | --- | --- |
| Geo index | Geohash cells (or a quadtree) held in memory on each search server | Fast, simple, fits in RAM |
| Query | User's cell + 8 neighbours, then exact distance filter, then rank | Correct at cell edges; exact results |
| Details | Separate store (Postgres) + Redis cache of business cards | Big data stays out of the search path |
| Freshness | Owner edits → CDC → index builder; nightly rebuild + incremental updates | "Visible by next day" is acceptable; faster is a bonus |
| Caching | Results cached by `(cell, category)`, not raw coordinates | Nearby users share cache entries |
| Regions | Full index copy in every region | Low latency everywhere; index is small |

## Requirements

### Functional

- Search nearby businesses by location and radius (0.5–20 km), with optional category, "open now", price, and rating filters.
- Page through results.
- View business details: address, hours, photos, reviews.
- Business owners add, update, and remove listings. Changes may take until the next day to appear in search (faster is better).

### Non-functional

| Property | Target |
| --- | --- |
| Latency | p99 < 200 ms for search |
| Read/write ratio | Extremely read-heavy: ~20k searches/s vs tens of listing updates/s |
| Availability | 99.99 % for search; owner edits can tolerate brief outages |
| Accuracy | Results within the radius; no business wrongly missing near cell edges |
| Scale | 200 M businesses worldwide, 100 M daily users |

## Capacity estimation

- **Searches:** 100 M DAU × 5 searches/day = 500 M/day ≈ **5,800/s** average, **~20k/s** at peak.
- **Businesses:** 200 M × ~1 KB of details ≈ **200 GB** (plus photos in object storage and reviews in their own service).
- **Geo index:** 200 M × (8-byte ID + 2 × 8-byte coordinates) ≈ **5 GB**; with geohash keys and overhead, maybe 10 GB → fits in memory on every search server.
- **Writes:** owners update listings rarely — tens per second globally.
- **Search servers:** if one server handles ~2k searches/s (in-memory lookup + ranking + cache calls), 20k/s needs ~10 servers per region at peak, plus headroom.

## API

```http
GET /v1/search/nearby?lat=12.9716&lng=77.5946&radius=2000&category=cafe&open_now=true&limit=20&cursor=…

200 OK
{
  "businesses": [
    { "id": "b-481", "name": "Third Wave Coffee", "distance_m": 340, "rating": 4.5,
      "review_count": 1832, "price": "$$", "open_now": true, "photo": "https://cdn…/b-481.jpg" }
  ],
  "next_cursor": "…"
}
```

```http
GET    /v1/businesses/{id}               # full details
POST   /v1/businesses                    # owner creates a listing
PUT    /v1/businesses/{id}               # owner edits
DELETE /v1/businesses/{id}
```

**Pagination:** the cursor encodes the query (cell set, filters) and the position in the ranked list, so page 2 uses the same candidate set instead of recomputing with a slightly different location.

## Data model

```sql
CREATE TABLE businesses (            -- source of truth (PostgreSQL, sharded by business_id if needed)
  business_id  BIGINT PRIMARY KEY,
  name         TEXT,
  lat          DOUBLE PRECISION,
  lng          DOUBLE PRECISION,
  geohash      CHAR(12),             -- computed on write
  category     TEXT,
  address      TEXT,
  hours        JSONB,
  price_level  SMALLINT,
  rating       REAL,
  review_count INT,
  updated_at   TIMESTAMPTZ
);
CREATE INDEX ON businesses (substring(geohash, 1, 6), category);
```

The search servers don't read this table directly. They load an **index snapshot** built from it:

```text
geo index (in memory):  geohash_6 → [ (business_id, lat, lng, category_bits, rating) … ]
details cache (Redis):  business:{id} → compact "card" JSON used on the results page
```

Keeping a few small ranking fields (category, rating) in the index lets the server filter and pre-rank without touching the cache for every candidate.

## Geospatial indexing options

| Option | How it works | Pros | Cons |
| --- | --- | --- | --- |
| Lat/lng range query | `WHERE lat BETWEEN … AND lng BETWEEN …` | Trivial | Two 1-D indexes intersect poorly; slow at scale |
| **Geohash** | Interleave latitude and longitude bits → base32 string; a shared prefix means the same cell | Works with any sorted index (`LIKE 'tdr1e%'`); easy to shard and cache | Fixed cell sizes; must also search neighbouring cells |
| **Quadtree** | Recursively split a cell into 4 until it holds ≤ N businesses | Adapts to density (dense city vs empty desert) | Custom in-memory structure; rebuild logic |
| S2 (Google) / H3 (Uber) | Hierarchical cells on the sphere (Hilbert curve squares / hexagons) | Accurate near poles; good covering of circles and polygons | More complex libraries |
| PostGIS / Elasticsearch geo | R-trees / BKD-trees built in | Least custom code; rich queries | Another cluster to run; may be slower than in-memory lookups |

Any of these is a good interview answer if you explain the trade-offs. This design uses **geohash** for simplicity and discusses the quadtree as the density-adaptive alternative.

## High-level architecture

See the [Architecture](#diagram/architecture) diagram.

| Component | Responsibility |
| --- | --- |
| Geo load balancer | Route users to the nearest region |
| Search service | Holds the geo index in memory; finds candidates; filters by exact distance; calls the ranker; hydrates results |
| Ranker | Scores candidates: distance, rating, review count, open now, personalisation, ads |
| Details cache | Business cards for results pages; result cache by cell and filters |
| Business service | Owner CRUD with validation (address geocoding, duplicate detection) |
| Business DB | Source of truth; primary for writes, replicas for reads |
| Change stream | CDC from the DB into Kafka |
| Index builder | Nightly full rebuild plus incremental updates; publishes versioned snapshots |

## A nearby search

See [Nearby search](#diagram/search-flow).

1. The app sends location, radius and filters.
2. The search service picks a geohash precision whose cell size is at least the radius: for 2 km, precision 5 (~4.9 km × 4.9 km cells). The user's cell is, say, `tdr1e`.
3. It collects candidates from `tdr1e` **and its 8 neighbours**. Without the neighbours, a café 50 m away but across a cell boundary would be missed.
4. It computes the exact **haversine** distance for each candidate and drops those outside the radius, and applies filters (category, open now).
5. If fewer than the requested number remain, it **expands**: use a lower precision (bigger cells), or climb one quadtree level, and repeat.
6. The ranker orders the remaining candidates; the service takes the top 20.
7. It fetches the 20 business cards from the cache in one `MGET` (misses go to read replicas).
8. It returns results with a cursor. The ranked candidate list is cached briefly under the cursor so the next page is consistent.

## Deep dives

### 1. Geohash in detail

See [Geohash cells](#diagram/geohash).

- **Encoding:** alternately take one bit from longitude and one from latitude (each bit halves the remaining range), then encode every 5 bits as one base32 character.
- **Precision:**

| Length | Cell size (at the equator) |
| --- | --- |
| 4 | 39 km × 19.5 km |
| 5 | 4.9 km × 4.9 km |
| 6 | 1.2 km × 0.61 km |
| 7 | 153 m × 153 m |

- **Neighbours:** computed with simple lookup tables per character position (odd-length hashes lay characters out in an 8×4 grid, even-length ones in 4×8). The 8 neighbours of `tdr1e` are `tdr1f`, `tdr1g`, `tdr1u`, `tdr1d`, `tdr1s`, `tdr16`, `tdr17`, `tdr1k`.
- **Edge cases:** cells near the poles and the 180° meridian are distorted or wrap around — use a library that handles them.
- **Storing it:** any sorted index works: a query for a cell is a prefix scan. In memory, a hash map from `geohash_6` to a list of businesses is enough; coarser precisions can be derived by grouping.

### 2. Quadtree in detail

See [Quadtree](#diagram/quadtree).

- **Build:** start with one node covering the world. Any node with more than 100 businesses is split into four children, recursively. Dense city centres end up with tiny cells (a few hundred metres); deserts and oceans stay as huge cells.
- **Size:** 200 M ÷ 100 ≈ 2 M leaves, ~2.7 M nodes in total. The IDs dominate memory (~1.6 GB); the tree itself is ~100 MB. Building from scratch takes a few minutes.
- **Query:** descend to the leaf containing the user (depth ~20), then gather neighbouring leaves (walk up and across) until you have enough results within the radius.
- **Updates:** rebuild into a new tree and swap the pointer atomically; or insert/delete in place under a lock for urgent changes (e.g. a closed business). Roll out new versions server by server to avoid all servers rebuilding at once.
- **Why it helps:** with fixed geohash cells, a 2 km search in Manhattan scans tens of thousands of candidates, while the same search in a village returns almost nothing. A quadtree keeps the number of candidates per cell roughly constant.

### 3. Not enough (or too many) results

- **Too few:** expand to a bigger cell (shorter geohash) or a wider quadtree neighbourhood, up to the maximum radius, and tell the user the search was widened.
- **Too many:** in dense areas a 20 km radius could return 100k candidates. Cap candidates per cell by pre-ranking (the index stores rating), and rely on the ranker to pick the best few hundred.

### 4. Ranking

Retrieve geographically (a few hundred candidates), then re-rank with: distance (with a decay curve, not linear), rating and review count (Bayesian average so a single 5-star review doesn't win), open now, price match, personal history, and sponsored placements. The ranker has a strict time budget; if it's slow, fall back to distance + rating.

### 5. Caching

- **Result cache:** key by `(geohash_6 of the user, radius bucket, category, filters)`. Users within the same cell share entries. TTL of a few minutes (opening hours change results).
- **Details cache:** business cards keyed by ID, invalidated from the change stream when an owner edits.
- Photos come from a CDN.

### 6. Keeping the index fresh

- Owner edits go to the primary DB. CDC publishes the change to Kafka.
- The index builder applies incremental updates to the next snapshot (or pushes small deltas to search servers) and does a full rebuild nightly to correct any drift.
- New snapshots are versioned; servers load them in the background and swap atomically. A bad snapshot is rolled back by pointing to the previous version.

### 7. Multi-region

The index is small, so every region holds a complete copy. Users are routed to the nearest region. Owner writes go to the primary region and replicate; search freshness across regions is the same "within hours" target.

## Scaling and reliability

- Search servers are stateless apart from the loaded index → add replicas for throughput.
- Hot areas (a festival, a stadium) mostly hit the same cells → the result cache absorbs them.
- If the ranker or cache is slow, degrade to simpler ranking and fewer details rather than failing.

### Failure modes

| Failure | Impact | Handling |
| --- | --- | --- |
| Search server dies | Less capacity | Load balancer removes it; autoscaling |
| Bad index snapshot | Wrong or missing results | Sanity checks (counts per region) before rollout; instant rollback |
| Details cache down | Slower hydration | Read replicas; circuit breaker; return fewer fields |
| Business DB primary down | Owners can't edit | Failover; search unaffected (uses the in-memory index) |
| CDC lag | Edits appear late | Acceptable within the requirement; alert on lag |

## Observability

- Search latency by stage (candidates, filter, rank, hydrate).
- Candidates scanned per query (a spike means a precision/density problem).
- Index snapshot age and size per region.
- Result click-through rate (ranking quality).
- Cache hit rates.

## Trade-offs to discuss

- **Geohash in a database vs in-memory quadtree:** the database index is simpler and always consistent; the in-memory quadtree is faster and adapts to density but needs build and rollout logic.
- **Freshness vs simplicity:** next-day index updates are easy; real-time needs incremental updates and more careful concurrency.
- **Cell precision:** smaller cells mean fewer false candidates but more cells to look up for a large radius.
- **Geohash vs H3/S2:** geohash is simple and works in any key-value store; H3's hexagons have uniform neighbours (better for analytics and ride-sharing), S2 handles the sphere more accurately.

## Interview follow-up questions

- **How do you support "search along my route"?** Cover the route polyline with cells (S2/H3 region covering), query those cells, and rank by detour distance.
- **How do you search by polygon (a neighbourhood boundary)?** Cover the polygon with cells, then check exact point-in-polygon for candidates.
- **How would you handle moving objects (delivery drivers)?** That's a different problem: very high write rates, short TTLs, in-memory cell maps updated every few seconds — see the Ride Sharing topic.
- **Why not just use Elasticsearch?** A perfectly good choice at moderate scale; the in-memory design wins when you need the lowest latency and highest throughput with a small index.
- **How do you rank a new business with no reviews?** Use priors (category averages), boost exploration slightly, and let early engagement signals adjust it.
