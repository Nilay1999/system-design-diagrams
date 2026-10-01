# Ride Sharing

> Uber/Lyft-style: riders request a ride, the system finds a nearby available driver in seconds, and both see each other move on the map in real time.

## The problem in one minute

Ride sharing mixes two very different kinds of data:

- **Driver locations:** millions of drivers each send a GPS ping every few seconds — over a million writes per second. Each position is useful for only a few seconds and is replaced by the next one. It needs to be fast, not durable.
- **Trips and payments:** far fewer events, but each one matters. A driver must never be assigned two trips; a trip must never skip from "requested" to "completed"; a rider must never be charged twice.

So the design keeps locations **in memory**, indexed by hexagonal map cells per city, and streams them to whoever needs them; while trips live in a **strongly consistent** store with an explicit state machine. Matching sits between the two: it reads nearby available drivers from the in-memory index, ranks them by real road ETA, **locks** one, and offers the trip.

| Decision | Choice | Why |
| --- | --- | --- |
| Location storage | Latest position only, in memory (Redis per city), with TTL | 1.25 M writes/s; old positions are worthless |
| Geo index | H3 hexagonal cells → set of available drivers | Uniform neighbours make "nearby" a clean ring search |
| Location fan-out | Kafka stream keyed by driver | Trip tracking, surge, ETA models, breadcrumbs consume independently |
| Matching | Candidates by k-ring → rank by road ETA → lock driver → offer with timeout | Fast, fair, no double assignment |
| Trips | State machine with conditional updates in a sharded SQL store | Consistency where it matters |
| Deployment | Cell-based: per-region stacks, data partitioned by city | One city's outage doesn't affect others |
| Connections | WebSockets to both apps | Push offers and live locations |

## Requirements

### Functional

- Rider sees nearby cars and a fare estimate; requests a ride (product: economy, XL, …).
- The system finds a suitable nearby driver; the driver accepts or declines.
- Both parties see live locations and ETA during pickup and the trip.
- Trip lifecycle: requested → matched → driver arriving → arrived → in progress → completed → paid; cancellations with fees.
- Surge pricing when demand exceeds supply in an area.
- Ratings, receipts, trip history.

### Non-functional

| Property | Target |
| --- | --- |
| Matching latency | First offer to a driver within ~2–5 s of the request |
| Location freshness | Rider sees the driver's position with < 5 s delay |
| Consistency | A driver is never on two trips; trip transitions are valid; payments happen once |
| Availability | Per-city isolation; the rest of the world keeps working if one region fails |
| Scale | 5 M drivers online at peak, 20 M rides/day |

## Capacity estimation

- **Location writes:** 5 M online drivers ÷ 4 s per ping ≈ **1.25 M writes/s**. At ~100 bytes per ping, **~125 MB/s** of ingest.
- **Location memory:** 5 M drivers × ~200 B (position, cell, status, timestamps) ≈ **1 GB** — tiny, but the write rate needs sharding (by city).
- **Rides:** 20 M/day ≈ **230 requests/s** average, ~1k/s at peak. Each request triggers a few geo queries, dozens of ETA calculations, and a few offers.
- **Trip storage:** 20 M × ~2 KB ≈ 40 GB/day ≈ 15 TB/year.
- **Breadcrumbs:** a 20-minute trip at one point per 4 s = 300 points × 100 B = 30 KB per trip → 600 GB/day, written asynchronously to cheap storage (for disputes and safety).
- **WebSockets:** ~5 M drivers + a few million active riders → ~10 M concurrent connections → hundreds of gateway servers.

## API

```http
POST /v1/rides/estimate   { "pickup": {lat,lng}, "dropoff": {lat,lng}, "product": "economy" }
→ { "fare_min": 210, "fare_max": 260, "currency": "INR", "surge": 1.4, "eta_pickup_s": 240, "quote_id": "q-9" }

POST /v1/rides            { "quote_id": "q-9", "pickup": …, "dropoff": …, "payment_method": "pm-1" }
Idempotency-Key: 5b2…
→ 202 { "trip_id": "t-42", "status": "REQUESTED" }

GET  /v1/rides/t-42        → status, driver, vehicle, live ETA
POST /v1/rides/t-42/cancel

# driver side (over WebSocket)
→ { "type": "location", "lat": …, "lng": …, "heading": 87, "speed": 11.2, "ts": … }
← { "type": "offer", "offer_id": "o-7", "trip_id": "t-42", "pickup": …, "eta_s": 180, "expires_in_s": 10 }
→ { "type": "accept", "offer_id": "o-7" }
POST /v1/driver/status     { "status": "AVAILABLE" | "OFFLINE" }
POST /v1/rides/t-42/arrived | /start | /complete
```

The **quote ID** locks in the fare the rider saw for a few minutes, so surge changes between estimate and request don't surprise them.

## Data model

```text
-- durable, strongly consistent, sharded by city
trips      (trip_id PK, city_id, rider_id, driver_id, status, product, quote_id,
            pickup, dropoff, requested_at, matched_at, started_at, completed_at,
            fare_estimate, fare_final, surge, cancel_reason, version)
drivers    (driver_id PK, city_id, vehicle, rating, status, current_trip_id)
riders     (rider_id PK, rating, default_payment_method)
quotes     (quote_id PK, rider_id, fare, surge, expires_at)

-- in memory (Redis cluster per city)
driver:{id}          HASH lat, lng, heading, cell, status, ts          (EXPIRE 30 s)
cell:{h3_res9}       SET  of AVAILABLE driver ids
lock:driver:{id}     STRING trip_id                                    (SET NX EX 15)

-- streams and archives
location stream      Kafka, keyed by driver_id
breadcrumbs          (trip_id, ts) → lat, lng   (wide-column store / S3)
```

## High-level architecture

See the [Architecture](#diagram/architecture) diagram.

| Component | Responsibility |
| --- | --- |
| WebSocket gateway | Long-lived connections to both apps; push offers, locations, status |
| Location service | Validate and de-noise pings, snap to roads, maintain the geo index, publish to the stream |
| Geo index | Per city: H3 cell → available drivers; driver → latest position |
| Location stream | Kafka; consumers for trip tracking, surge, ETA training, breadcrumbs |
| Trip service | Trip state machine; idempotent APIs; emits trip events |
| Dispatch / matching | Find candidates, rank by ETA, lock, offer, handle accept/decline/timeout |
| Routing / ETA | Road-graph routing with live traffic and ML corrections |
| Pricing / surge | Fare quotes; surge multipliers per cell from demand vs supply |
| Payments | Charge after completion (see the Payment System topic) |

## Location updates

See [Location updates](#diagram/location).

1. The driver app sends a ping every ~4 s (more often when moving fast or on a trip; batched when the signal is poor).
2. The gateway routes it to the location service for the driver's city.
3. The service discards out-of-order pings, filters GPS noise, snaps the point to the road network, and computes the H3 cell.
4. If the driver moved to a new cell, it atomically removes them from the old cell's set and adds them to the new one (only if `AVAILABLE`).
5. It updates `driver:{id}` with a 30-second TTL — a driver whose app dies disappears from the index automatically.
6. It publishes the ping to Kafka. If the driver is on a trip, the trip tracker pushes the position and a fresh ETA to the rider.

No durable database write happens per ping. The index is rebuildable: if a Redis shard dies, the next round of pings (≤ 4 s) repopulates it.

## Requesting a ride and matching

See [Request & match](#diagram/matching).

1. The rider requests with a quote ID and an idempotency key; the trip is created as `REQUESTED`.
2. Dispatch gets available drivers from the pickup cell and its k = 1 ring, expanding to k = 2, 3 if there are too few.
3. It asks the ETA service for road ETAs for the ~20 nearest by straight line (a driver 300 m away across a river may be 10 minutes by road).
4. It ranks by ETA, plus driver rating, acceptance rate, and fairness (drivers who've waited longest).
5. It **locks** the best driver: `SET lock:driver:d-7 t-42 NX EX 15`, and moves them from `AVAILABLE` to `OFFERED` (removing them from cell sets so no other request picks them).
6. It sends the offer; the driver has ~10 s.
7. **Accept:** the trip moves `REQUESTED → MATCHED` with a conditional update; the driver becomes `ON_TRIP`; the rider is notified.
8. **Decline or timeout:** release the lock, return the driver to `AVAILABLE`, and offer the next candidate. After ~60 s with no match, tell the rider no drivers are available.

## Deep dives

### 1. H3 and nearby search

See [H3 cells & matching](#diagram/h3).

- H3 divides the world into hexagons at 16 resolutions. At resolution 9, a cell is about 0.1 km² (edge ~175 m).
- Every hexagon has **6 neighbours at the same distance**. With squares (geohash), 4 neighbours share an edge and 4 touch only at corners and are ~41 % farther — so ring searches are lumpier.
- `k-ring(cell, k)` returns all cells within k steps: 1, 7, 19, 37… cells. Expand until there are enough candidates, then filter by exact distance and rank by ETA.
- Surge, demand forecasting and pricing also aggregate by H3 cell, so one cell system serves everything.

### 2. Never assigning a driver twice

- The lock (`SET NX` with TTL) is the gate: two concurrent requests can both see d-7 as a candidate, but only one can lock them.
- Driver status transitions are conditional (`AVAILABLE → OFFERED` only if currently `AVAILABLE`).
- The lock has a TTL so a crashed dispatcher can't strand a driver as "offered" forever.
- The final assignment is a conditional update on the trip (`WHERE status = 'REQUESTED'`) and the driver (`WHERE current_trip_id IS NULL`) in one transaction — the database is the last line of defence.

### 3. Greedy vs batched matching

- **Greedy:** match each request immediately to its best driver. Lowest latency, simple.
- **Batched:** collect requests in a zone for 1–2 s and solve an assignment problem (minimise total pickup ETA, e.g. Hungarian algorithm or min-cost flow). In dense areas this gives noticeably shorter pickups overall, because the greedy choice for one rider can take the only nearby driver from another rider who had no alternative.
- Many systems batch in dense city centres and match greedily elsewhere.

### 4. Trip state machine

See [Trip state machine](#diagram/trip-states).

```sql
UPDATE trips
SET status = 'IN_PROGRESS', started_at = now(), version = version + 1
WHERE trip_id = 't-42' AND status = 'ARRIVED';
-- 0 rows updated → invalid or duplicate transition; return the current state
```

- Only valid transitions are allowed; retries are harmless because a repeated transition finds the trip already in the new state.
- Each transition writes an outbox event → notifications, receipts, analytics, driver earnings.
- Cancellation fees depend on state and timing (e.g. free within 2 minutes of matching, a fee after the driver has arrived and waited).

### 5. ETA

- A routing engine computes shortest paths on the road graph quickly using precomputation (contraction hierarchies).
- Edge weights come from live traffic: recent trips' speeds per road segment, from the location stream.
- ML models correct the raw route time for pickup/drop-off delays, time of day, and weather.
- ETAs are cached per (origin cell, destination cell) for a minute for estimates; precise ETAs are computed for the few candidates in matching.

### 6. Surge pricing

- A streaming job counts, per H3 cell per minute, open requests (demand) and available drivers (supply).
- A multiplier is computed from the ratio, **smoothed** over time and across neighbouring cells so prices don't flicker or create sharp borders.
- Surge is shown in quotes and locked by the quote ID.
- Surge also nudges supply: the driver app shows heat maps of high-surge cells.

### 7. Cell-based deployment

- Partition everything by city/region: location index, dispatch, trips.
- Each region runs a full stack; a city is served by one region at a time (with a standby).
- A region failure affects only its cities; failover moves them to the standby region. Active trips continue from the durable trip store; the location index repopulates from pings.

## Scaling and reliability

- **Location writes:** shard by city (and by cell ranges within huge cities); Redis handles ~100k+ ops/s per shard.
- **Gateways** are stateful (connections); on failure clients reconnect with jittered backoff.
- **Degrade gracefully:** if the ETA service is slow, rank by straight-line distance; if surge computation lags, use the last multiplier.

### Failure modes

| Failure | Impact | Handling |
| --- | --- | --- |
| Geo index shard lost | Drivers in that area invisible for a few seconds | Next pings repopulate it |
| Dispatcher crashes mid-offer | Driver stuck as `OFFERED` | Lock TTL expires; driver returns to `AVAILABLE` |
| Driver app loses connectivity | Stale position | TTL removes them from matching; on a trip, the rider sees "last seen" |
| Duplicate ride request (retry) | Two trips | Idempotency key on `POST /rides` |
| Trip DB primary fails | Trip transitions stall | Failover; apps retry transitions idempotently |
| Region outage | Cities in that region offline | Standby region takes over; trips resume from the durable store |

## Security and safety

- Verify driver identity and vehicle; detect GPS spoofing (impossible speeds, mock-location flags).
- Share masked phone numbers through a proxy.
- Store trip breadcrumbs for safety investigations; emergency button with live location sharing.

## Observability

- Time to first offer, time to match, match rate, offer acceptance rate.
- Location ping lag (device timestamp vs server receive).
- ETA accuracy (predicted vs actual pickup time).
- Driver utilisation and rider wait times per city.
- Surge multiplier distribution (detect runaway feedback loops).

## Trade-offs to discuss

- **Ping interval:** 4 s balances freshness against battery and bandwidth; adaptive intervals do better.
- **Cell size:** small cells are precise but need more lookups; large cells mean more candidates to filter.
- **Greedy vs batched matching:** latency vs global efficiency.
- **In-memory index vs database:** speed vs durability — acceptable because positions are replaced every few seconds.

## Interview follow-up questions

- **How would you support pooled rides (shared trips)?** Matching must consider detours for existing passengers: candidate generation along the current route, and an insertion cost for adding a new pickup/drop-off.
- **How do you handle airports (queues of drivers)?** A FIFO queue per airport geofence instead of pure distance ranking.
- **What if a driver accepts two offers at once (race)?** Impossible by design: only one lock can exist per driver, and the trip assignment is conditional.
- **How do you estimate the fare before the trip?** Route distance and time from the ETA service × rates × surge, locked in a quote.
- **How do you scale to a new city launch?** Cell-based stacks: provision the city in a region, load its road graph, and route its traffic there.
