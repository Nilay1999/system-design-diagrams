# Proximity Service (Yelp / Google Places)

> Given a user's location and a radius, return nearby businesses (restaurants, fuel stations, …) quickly and ranked well.

## Requirements

### Functional
- Search nearby businesses by location + radius (0.5 km – 20 km), optional category/filters.
- View business details, photos and reviews.
- Business owners add/update/delete listings (changes visible by next day is acceptable).

### Non-functional
- **Low latency:** p99 < 200 ms for search.
- **Read-heavy:** searches vastly outnumber business updates.
- High availability, scalable to global peaks.

## Estimation

| Metric | Assumption | Result |
| --- | --- | --- |
| Businesses | 200 M | ~200 M × 1 KB ≈ 200 GB details; geo index only needs `(id, lat, lng)` ≈ 5 GB |
| Searches | 100 M DAU × 5 searches/day | ~5,800 QPS avg, ~20k peak |
| Writes | Business updates | Low (tens/s) |

The geo index is small enough to **fit in memory** on every search server. That observation drives the design.

## API

```http
GET /v1/search/nearby?lat=12.97&lng=77.59&radius=2000&category=cafe&cursor=…
→ { "businesses": [ { "id", "name", "distance_m", "rating" } ], "cursor": … }

GET  /v1/businesses/{id}
POST /v1/businesses        PUT /v1/businesses/{id}        DELETE /v1/businesses/{id}
```

## Geospatial indexing options

| Option | How it works | Pros | Cons |
| --- | --- | --- | --- |
| Naive lat/lng range query | `WHERE lat BETWEEN … AND lng BETWEEN …` | Trivial | Two 1-D indexes intersect poorly; slow at scale |
| **Geohash** | Interleave lat/lng bits → base32 string; shared prefix = same cell | Works in any KV/SQL index (`LIKE 'tdr1%'`) | Boundary issues, so query the 8 neighbours too; fixed cell sizes |
| **Quadtree** | Recursively split cells until each has ≤ N businesses | Adapts to density (Manhattan vs desert) | In-memory tree, rebuilt on changes |
| Google S2 / Uber H3 | Hierarchical cells on the sphere (Hilbert curve / hexagons) | Accurate, good region covering | More complex |
| PostGIS / Elasticsearch geo | R-tree / BKD-tree built in | Least custom code | Operating a search cluster |

**Geohash precision:** length 4 ≈ 39 km × 19.5 km, 5 ≈ 4.9 km × 4.9 km, 6 ≈ 1.2 km × 0.61 km. Pick the precision from the radius.

## Data model

```text
businesses  (business_id, name, lat, lng, category, address, hours, rating, …)   -- source of truth
geo_index   (geohash_6, business_id)   PK (geohash_6, business_id)                -- or an in-memory quadtree
```

## High-level design

1. **Search service** (stateless, many replicas) holds the geo index **in memory** (or reads a replicated Redis/DB index).
2. For a query: choose a geohash precision from the radius, compute the user's cell plus its **8 neighbours**, collect candidate IDs, filter by exact **haversine distance** and category, then rank.
3. **Hydrate** the top results from the business details cache (backed by the business DB's read replicas).
4. **Business service** handles owner CRUD against the primary DB.
5. An **index builder** consumes changes (CDC) or rebuilds nightly, publishing a new index that search servers hot-swap.

## Deep dives

### Not enough results
If the cells return fewer than *k* results, **expand the search**: use a shorter geohash prefix (a bigger cell), or walk up one level in the quadtree.

### Quadtree details
- Build: start with the whole world, split any node with > 100 businesses into 4 children. For 200 M businesses that's ~2 M leaves, which takes minutes to build and a few GB of memory.
- Query: descend to the leaf containing the point, then gather neighbouring leaves until you have enough results.
- Updates: rebuild nightly, or apply incremental inserts under a lock. Blue/green-swap servers to avoid cold starts.

### Ranking
Distance plus rating, popularity, open-now, personalization and ads. Retrieve a few hundred candidates geographically, then re-rank.

### Caching
- Cache search results by `(geohash_6, category)`, not raw coordinates, since nearby users share cells.
- Business details are cached aggressively. Invalidate them on owner updates.

### Multi-region
Deploy search servers in each region with a full copy of the index (it's small). Route users to the nearest region. Business writes go to the primary region and replicate.

## Trade-offs

- **Geohash in DB vs in-memory quadtree:** the DB index is simpler and consistent. The quadtree is faster and adapts to density, but needs rebuild logic.
- **Freshness vs simplicity:** next-day index updates are fine per the requirements. Real-time needs incremental index updates.
- **Precision:** smaller cells mean fewer false candidates but more cells to scan.
