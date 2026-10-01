import { Diagram, Sequence, type DiagramSpec } from "./dsl";

function architecture() {
  return new Diagram("Ride Sharing — architecture", "Ephemeral, high-volume location data lives in memory per city; trips and payments live in durable, consistent stores")
    .zone("Real-time location (in memory, per city)", ["loc", "geo", "stream"], "#e03131")
    .zone("Trip lifecycle (durable)", ["trip", "trips", "dispatch", "pricing"], "#2f9e44")
    .node("driver", "Driver app", 0, 0, "client", { detail: "GPS every 4 s" })
    .node("rider", "Rider app", 0, 2, "client", { detail: "request, track, pay" })
    .node("gw", "WebSocket gateway", 1.1, 1, "edge", { detail: ["sticky connections", "push offers + locations"] })
    .node("loc", "Location service", 2.2, 0, "service", { detail: ["validate, snap to road", "update cell membership"] })
    .node("geo", "Geo index", 3.3, -0.5, "cache", { detail: ["Redis per city", "H3 cell → available drivers"] })
    .node("stream", "Location stream", 3.3, 0.6, "queue", { detail: "Kafka, keyed by driver" })
    .node("trip", "Trip service", 2.2, 2, "service", { detail: ["trip state machine", "idempotent requests"] })
    .node("trips", "Trips DB", 2.2, 3.2, "db", { detail: ["sharded by city", "strongly consistent"] })
    .node("dispatch", "Dispatch / matching", 3.3, 2, "service", { detail: ["candidates by ETA", "lock driver, send offer"] })
    .node("pricing", "Pricing + surge", 3.3, 3.2, "service", { detail: "demand / supply per cell" })
    .node("eta", "Routing / ETA", 4.5, 2, "service", { detail: ["road graph + live traffic", "ML corrections"] })
    .node("consumers", "Stream consumers", 4.5, 0.6, "worker", { detail: ["trip tracking to riders", "surge, breadcrumbs"] })
    .node("pay", "Payments", 1.1, 3.2, "external", { detail: "charge after trip" })
    .edge("driver", "gw", "WS", { both: true })
    .edge("rider", "gw", "WS", { both: true })
    .edge("gw", "loc", "pings")
    .edge("loc", "geo", "move cell")
    .edge("loc", "stream", undefined, { async: true })
    .edge("stream", "consumers", undefined, { async: true })
    .edge("gw", "trip", "request ride")
    .edge("trip", "trips")
    .edge("trip", "dispatch", "find driver")
    .edge("dispatch", "geo", "nearby", { via: [[4.05, 2], [4.05, -0.5]] })
    .edge("dispatch", "eta")
    .edge("trip", "pricing", "quote")
    .edge("trips", "pay", "completed", { async: true })
    .panel(
      "Scale",
      ["5 M drivers online at peak × 1 ping / 4 s ≈ 1.25 M location writes/s", "20 M rides / day ≈ 230 requests/s, ~1k/s peak", "~100 B per ping → ~125 MB/s ingest", "Location writes dominate the design"],
      5.6,
      -0.5,
      { width: 400, tone: "info" },
    )
    .build();
}

function locationFlow() {
  return new Sequence("Location updates", "1.25 M pings per second: keep only the latest position in memory, stream the rest", { gap: 240 })
    .actor("d", "Driver app", "client")
    .actor("gw", "Gateway", "edge")
    .actor("l", "Location service", "service")
    .actor("g", "Geo index (city shard)", "cache")
    .actor("k", "Location stream", "queue")
    .actor("r", "Rider app (on trip)", "client")
    .msg("d", "gw", "ping {lat, lng, heading, speed, ts} every 4 s (batched if the signal is poor)")
    .msg("gw", "l", "forward (routed by driver's city)")
    .msg("l", "l", "drop if older than the last ping; snap to road; compute H3 cell (res 9)")
    .alt("cell changed", "l", "g")
    .msg("l", "g", "SREM cell:8928308280fffff d-7; SADD cell:8928308283fffff d-7 (MULTI)")
    .end()
    .msg("l", "g", "HSET driver:d-7 lat lng cell status ts; EXPIRE 30 s")
    .msg("l", "k", "location event (key = driver id)", { async: true })
    .opt("driver is on a trip", "k", "r")
    .msg("k", "gw", "trip tracker picks it up", { async: true })
    .msg("gw", "r", "driver position + updated ETA", { async: true })
    .end()
    .note("No durable write per ping. A driver with no ping for 30 s expires from the index automatically; trip breadcrumbs are stored asynchronously from the stream.", ["l", "k"], "info")
    .build();
}

function matchFlow() {
  return new Sequence("Requesting a ride & matching", "Lock the driver before offering; if they decline or time out, release and try the next", { gap: 225 })
    .actor("r", "Rider", "client")
    .actor("t", "Trip service", "service")
    .actor("p", "Pricing", "service")
    .actor("m", "Dispatch", "service")
    .actor("g", "Geo index", "cache")
    .actor("e", "ETA", "service")
    .actor("d", "Driver", "client")
    .msg("r", "t", "POST /rides {pickup, dropoff, product} + Idempotency-Key")
    .msg("t", "p", "quote (surge ×1.4 in this cell)")
    .msg("t", "t", "INSERT trip REQUESTED")
    .msg("t", "r", "202 {trip_id, fare estimate}", { reply: true })
    .msg("t", "m", "match(trip)")
    .msg("m", "g", "available drivers in pickup cell + k-ring(1); expand to k = 2, 3 if too few")
    .msg("m", "e", "road ETA for the 20 nearest by straight line")
    .msg("m", "m", "rank by ETA, rating, acceptance rate")
    .loop("until a driver accepts or the search times out (~60 s)", "m", "d")
    .msg("m", "g", "lock: SET lock:driver:d-7 trip-42 NX EX 15  (status AVAILABLE → OFFERED)")
    .msg("m", "d", "offer trip-42 (pickup, ETA, fare) — 10 s to respond")
    .alt("accept", "m", "d")
    .msg("d", "m", "accept", { reply: true })
    .msg("m", "t", "UPDATE trip SET status = MATCHED, driver = d-7 WHERE status = REQUESTED")
    .else("decline or no answer in 10 s")
    .msg("m", "g", "release lock; d-7 back to AVAILABLE; try the next driver", { error: true })
    .end()
    .end()
    .msg("t", "r", "driver assigned: name, car, ETA", { reply: true })
    .build();
}

function tripStates() {
  return new Diagram("Trip state machine", "Every transition is a conditional update in a strongly consistent store")
    .node("req", "REQUESTED", 0, 1, "service", { detail: "fare quoted" })
    .node("matched", "MATCHED", 1.1, 1, "service", { detail: "driver locked to trip" })
    .node("arriving", "DRIVER_ARRIVING", 2.2, 1, "worker", { detail: "live ETA to pickup" })
    .node("arrived", "ARRIVED", 3.3, 1, "worker", { detail: "waiting fee after 2 min" })
    .node("progress", "IN_PROGRESS", 4.4, 1, "worker", { detail: "route + breadcrumbs" })
    .node("done", "COMPLETED", 5.5, 1, "service", { detail: "final fare computed" })
    .node("paid", "PAID", 5.5, 2.3, "service", { detail: "idempotent charge" })
    .node("cancel", "CANCELLED", 1.6, 2.4, "external", { highlight: true, detail: "by rider / driver / no drivers" })
    .edge("req", "matched", "accept")
    .edge("matched", "arriving")
    .edge("arriving", "arrived", "at pickup")
    .edge("arrived", "progress", "start")
    .edge("progress", "done", "end")
    .edge("done", "paid")
    .edge("req", "cancel")
    .edge("matched", "cancel")
    .edge("arrived", "cancel", "no-show")
    .panel(
      "Rules",
      [
        "UPDATE trips SET status='IN_PROGRESS' WHERE trip_id=? AND status='ARRIVED' — 0 rows means an invalid or duplicate transition",
        "Driver status mirrors the trip: AVAILABLE → OFFERED → ON_TRIP → AVAILABLE",
        "Cancellation fees depend on the state and elapsed time",
        "Each transition emits an event (outbox) for notifications, receipts, analytics",
      ],
      0,
      3.4,
      { width: 700, tone: "info" },
    )
    .build();
}

function h3() {
  const d = new Diagram("Deep dive — H3 cells & matching", "Hexagons have six equidistant neighbours, so 'search nearby' is a clean ring expansion");
  d.circle(1.2, 1.4, 200, "#adb5bd");
  d.node("c0", "Rider's cell", 1.28, 1.4, "client", { w: 0.75, detail: "k = 0: 2 drivers" });
  for (let i = 0; i < 6; i++) {
    const [c, r] = d.onCircle(1.2, 1.4, 200, i * 60);
    d.node(`c${i + 1}`, `k = 1 cell ${i + 1}`, c + 0.08, r, "worker", { w: 0.75, detail: i === 2 ? "4 drivers" : i === 4 ? "1 driver" : "0 drivers" });
  }
  return d
    .panel(
      "k-ring search",
      [
        "Resolution 9 hexagons are ~0.1 km² (edge ≈ 175 m)",
        "Look up the rider's cell (k = 0), then its ring of 6 (k = 1), then 12 more (k = 2)… until there are enough candidates",
        "Filter by exact distance, then rank by road ETA (a driver across a river is 'near' but slow)",
        "Hexagon neighbours are all the same distance away; square cells have diagonal neighbours that are 41 % farther",
      ],
      2.8,
      0,
      { width: 470, numbered: true, tone: "info" },
    )
    .panel(
      "Greedy vs batched matching",
      [
        "Greedy: each request takes the best driver right now — lowest latency",
        "Batched: collect requests for 1–2 s in a zone and solve an assignment problem (minimise total ETA) — better overall pickups in dense areas",
        "Either way, lock drivers before offering",
      ],
      2.8,
      1.9,
      { width: 470 },
    )
    .build();
}

export default [
  { id: "architecture", name: "Architecture", build: architecture },
  { id: "location", name: "Location updates", build: locationFlow },
  { id: "matching", name: "Request & match", build: matchFlow },
  { id: "trip-states", name: "Trip state machine", build: tripStates },
  { id: "h3", name: "H3 cells & matching", build: h3 },
] satisfies DiagramSpec[];
