# Ride Sharing

> Uber/Lyft-style: riders request a ride, the system finds a nearby available driver in seconds, and both see each other move on the map in real time.

## Requirements

### Functional
- Rider sees nearby drivers and a fare estimate; requests a ride.
- System matches the request to a suitable nearby driver; the driver accepts or declines.
- Real-time location tracking for both sides during the trip.
- Trip lifecycle: requested → matched → driver arriving → in progress → completed → paid.
- Surge pricing when demand exceeds supply.

### Non-functional
- Matching latency: a driver offer within a few seconds.
- Location updates are high-volume and ephemeral; trips and payments must be durable and consistent.
- Highly available per city; one city's outage shouldn't affect others.
- A driver must never be assigned two trips at once.

## Estimation

| Metric | Assumption | Result |
| --- | --- | --- |
| Active drivers | 5 M online at peak | Location update every 4 s → **~1.25 M writes/s** |
| Rides | 20 M/day | ~230 ride requests/s avg, ~1k/s peak |
| Location payload | ~100 B | ~125 MB/s ingest |

Location writes dominate — the design centres on them.

## API

```http
POST /v1/rides/estimate   { pickup, dropoff }            → fare, eta
POST /v1/rides            { pickup, dropoff, product }    → ride_id, status
GET  /v1/rides/{id}                                          → status, driver, eta
PUT  /v1/drivers/me/location  (WebSocket stream preferred) { lat, lng, heading, ts }
POST /v1/offers/{id}/accept | /decline
```

## Data model

```text
trips        (trip_id, rider_id, driver_id, status, pickup, dropoff, fare, timestamps)   -- sharded by city/region
drivers      (driver_id, vehicle, rating, status[OFFLINE|AVAILABLE|OFFERED|ON_TRIP])
geo index    H3 cell → set(driver_id)   and   driver_id → {lat, lng, cell, ts}         -- in memory (Redis)
```

## Geospatial indexing

To answer "available drivers within 2 km", index positions by **cell**:

| Option | Notes |
| --- | --- |
| **Geohash** | Base32 string; prefixes = containing squares; cells distort near poles; neighbours need care at boundaries |
| **Quadtree** | Adaptive: dense areas subdivide further; in-memory tree must be rebuilt/updated |
| **Google S2** | Hilbert-curve cells on a sphere; good for range covering |
| **Uber H3** | Hexagonal cells; every neighbour is equidistant, making `k-ring` searches clean |

Query: compute the rider's cell, fetch drivers in the cell + its `k-ring` of neighbours, filter by exact distance, expand `k` if too few.

## High-level design

1. **Driver apps** stream GPS every ~4 s over WebSocket to the gateway → **location service**.
2. The location service updates the driver's cell in the **geo index** (removing it from the old cell when it moves) and publishes to a **location stream** (Kafka) for trip tracking, ETAs, analytics, and surge.
3. **Rider** requests a ride → **trip service** creates the trip (`REQUESTED`) and gets a fare quote from **pricing**.
4. **Matching/dispatch** queries the geo index for nearby available drivers, ranks them by **ETA** (road-network routing, not straight-line distance), and sends an **offer** to the best driver through the gateway.
5. Driver accepts within ~10 s → trip `MATCHED`; otherwise offer the next candidate.
6. During the trip, the rider's app receives the driver's location from the stream via the gateway.

## Deep dives

### Preventing double assignment
- Atomically transition driver status `AVAILABLE → OFFERED` (Redis `SET … NX` lock with TTL, or conditional DB update) before sending an offer.
- If the offer times out or is declined, release it back to `AVAILABLE`.
- Batch matching (collect requests for ~1–2 s and solve an assignment problem) gives better global outcomes than greedy per-request matching in dense areas.

### Handling 1.25 M location writes/s
- Keep the latest position **in memory** only; don't write every ping to a durable DB.
- Shard the geo index by region/cell; each shard handles a city or part of one.
- Persist trip-time breadcrumbs asynchronously from Kafka (for billing disputes and safety).

### Surge pricing
Stream processing computes demand (requests) vs supply (available drivers) per cell per minute; pricing applies a multiplier with smoothing to avoid oscillation.

### ETA
A routing engine over the road graph (contraction hierarchies), adjusted with live traffic from recent trip speeds; ML models correct for pickup/dropoff delays.

### Consistency where it matters
Trip state is a **state machine** in a strongly consistent store; transitions are validated (`IN_PROGRESS` only from `DRIVER_ARRIVED`). Payment happens after completion via an idempotent payment flow (see *Payment System*).

## Scaling & reliability

- **Cell-based architecture:** deploy per-region stacks; a city's data lives in its region.
- Geo index is rebuildable: if a shard dies, drivers' next pings (≤ 4 s) repopulate it.
- WebSocket edge servers are stateful; on failure clients reconnect with backoff.
- Degrade gracefully: if ETA service is slow, fall back to straight-line distance ranking.

## Trade-offs

- **Update interval:** 4 s pings balance freshness vs battery/bandwidth.
- **Cell size:** small cells = precise but more cells to scan; large cells = fewer lookups but more filtering.
- **Greedy vs batched matching:** latency vs global efficiency.
