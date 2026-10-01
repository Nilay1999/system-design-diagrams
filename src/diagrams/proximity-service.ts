import { Diagram, Sequence, type DiagramSpec } from "./dsl";

function architecture() {
  return new Diagram("Proximity Service — architecture", "The geo index is small enough to live in memory on every search server; details come from a cache")
    .zone("Read path (≈ 20k searches/s)", ["lb", "search", "rank", "cache"], "#2f9e44")
    .zone("Write path (tens of updates/s)", ["biz", "primary", "cdc", "builder", "snap"], "#e8590c")
    .node("user", "User app", 0, 0.6, "client", { detail: "lat, lng, radius, filters" })
    .node("lb", "Geo LB", 1.1, 0.6, "edge", { detail: "nearest region" })
    .node("search", "Search service", 2.2, 0.6, "service", { detail: ["in-memory geo index", "loads index snapshots"] })
    .node("rank", "Ranker", 3.3, -0.4, "service", { detail: "distance, rating, open now" })
    .node("cache", "Details cache", 3.3, 0.9, "cache", { detail: ["Redis: business_id → card", "result cache by cell"] })
    .node("replica", "Business DB replicas", 3.3, 1.75, "db", { detail: "read-only" })
    .node("owner", "Business owner", 0, 2.4, "client", { detail: "edit listing" })
    .node("biz", "Business service", 1.1, 2.4, "service", { detail: "CRUD, validation" })
    .node("primary", "Business DB primary", 2.2, 2.4, "db", { detail: ["PostgreSQL", "source of truth"] })
    .node("cdc", "Change stream", 3.3, 2.4, "queue", { detail: "CDC → Kafka" })
    .node("builder", "Index builder", 4.4, 2.4, "worker", { detail: ["nightly full rebuild", "+ incremental updates"] })
    .node("snap", "Index snapshots", 4.4, 3.6, "storage", { detail: ["versioned, per region", "servers hot-swap them"] })
    .edge("user", "lb", "GET /search/nearby")
    .edge("lb", "search")
    .edge("search", "rank", "candidates")
    .edge("search", "cache", "hydrate top 20")
    .edge("cache", "replica")
    .edge("owner", "biz", "PUT /businesses/{id}")
    .edge("biz", "primary", "write")
    .edge("primary", "replica", "replication", { async: true })
    .edge("primary", "cdc", undefined, { async: true })
    .edge("cdc", "builder", undefined, { async: true })
    .edge("builder", "snap", "publish")
    .edge("cdc", "cache", "invalidate", { async: true, via: [[3.95, 2.4], [3.95, 0.9]] })
    .panel(
      "Why in memory",
      ["200 M businesses × (id 8 B + lat/lng 16 B) ≈ 5 GB", "Fits on every search server → no network hop for geo lookup", "Full details (~200 GB) stay in DB + cache"],
      4.4,
      -0.4,
      { width: 400, tone: "info" },
    )
    .build();
}

function searchFlow() {
  return new Sequence("A nearby search", "Pick a cell size from the radius, scan the cell and its 8 neighbours, filter exactly, rank, hydrate", { gap: 240 })
    .actor("u", "User app", "client")
    .actor("s", "Search service", "service")
    .actor("idx", "In-memory index", "cache")
    .actor("r", "Ranker", "service")
    .actor("c", "Details cache", "cache")
    .msg("u", "s", "GET /search/nearby?lat=12.9716&lng=77.5946&radius=2000&category=cafe")
    .msg("s", "s", "radius 2 km → geohash precision 5 (≈ 4.9 × 4.9 km cells); user cell = tdr1v")
    .msg("s", "idx", "ids in tdr1v + its 8 neighbours, category = cafe")
    .msg("idx", "s", "~1,400 candidates", { reply: true })
    .msg("s", "s", "exact haversine distance; drop those > 2 km → 610 left")
    .opt("fewer than 20 results", "s", "idx")
    .msg("s", "idx", "expand: precision 4 (bigger cells) or the next quadtree level")
    .end()
    .msg("s", "r", "score by distance, rating, reviews, open-now, personal signals")
    .msg("r", "s", "top 20 ids", { reply: true })
    .msg("s", "c", "MGET business cards for 20 ids")
    .msg("c", "s", "name, rating, photo URL, hours (misses read from replicas)", { reply: true })
    .msg("s", "u", "results + cursor", { reply: true })
    .note("Result caching: key by (cell, category, sort) — not raw coordinates — so nearby users share cache entries.", ["s", "c"], "info")
    .build();
}

function geohash() {
  const d = new Diagram("Deep dive — geohash cells", "Nearby places share a geohash prefix; always search the user's cell and its 8 neighbours", { gridX: 240, gridY: 120 });
  // For odd-length geohashes the last character comes from this 8 × 4 layout:
  //   b c f g u v y z / 8 9 d e s t w x / 2 3 6 7 k m q r / 0 1 4 5 h j n p
  // so the neighbours of "e" are f g u / d s / 6 7 k.
  const cells = [
    ["tdr1f", "tdr1g", "tdr1u"],
    ["tdr1d", "tdr1e", "tdr1s"],
    ["tdr16", "tdr17", "tdr1k"],
  ];
  cells.forEach((row, r) =>
    row.forEach((cell, c) => {
      const centre = r === 1 && c === 1;
      d.node(cell, cell, c, r, centre ? "client" : "worker", { w: 0.95, detail: centre ? "user is here" : "neighbour" });
    }),
  );
  d.circle(1.0, 1, 190, "#e03131");
  return d
    .table(
      "precision",
      "Geohash precision",
      ["length  cell size (at equator)", "4       39 km  × 19.5 km", "5       4.9 km × 4.9 km", "6       1.2 km × 0.61 km", "7       153 m  × 153 m"],
      3.3,
      -0.1,
      { kind: "storage" },
    )
    .panel(
      "How it works",
      [
        "Interleave the bits of longitude and latitude, then encode 5 bits per base32 character",
        "Each extra character makes the cell ~32× smaller; a shared prefix means a shared cell",
        "Edge problem: two points 10 m apart can sit in different cells — so search the 8 neighbours too",
        "Pick the precision whose cell is at least as big as the radius (red circle)",
        "Index: (geohash_6, business_id) in any sorted store; a cell query is a prefix scan",
      ],
      3.3,
      1.45,
      { width: 470, numbered: true, tone: "info" },
    )
    .build();
}

function quadtree() {
  return new Diagram("Deep dive — quadtree", "Split any cell holding more than 100 businesses into 4; dense cities get small cells, deserts stay large")
    .node("world", "World", 2, 0, "service", { detail: "200 M businesses" })
    .node("nw", "NW quadrant", 0, 1.2, "service", { w: 0.9, detail: "split" })
    .node("ne", "NE quadrant", 1.4, 1.2, "service", { w: 0.9, detail: "split" })
    .node("sw", "SW quadrant", 2.8, 1.2, "service", { w: 0.9, detail: "48 → leaf (ocean)" })
    .node("se", "SE quadrant", 4.2, 1.2, "service", { w: 0.9, detail: "split" })
    .node("l1", "…", 0, 2.4, "db", { w: 0.6 })
    .node("city", "Bengaluru centre", 1.4, 2.4, "service", { highlight: true, w: 0.9, detail: "split 9 more levels" })
    .node("leaf", "Leaf: 200 m cell", 1.4, 3.6, "db", { w: 0.9, detail: "87 businesses (≤ 100)" })
    .node("leaf2", "Leaf: 12 km cell", 4.2, 2.4, "db", { w: 0.9, detail: "63 businesses (rural)" })
    .edge("world", "nw", undefined, { none: true })
    .edge("world", "ne", undefined, { none: true })
    .edge("world", "sw", undefined, { none: true })
    .edge("world", "se", undefined, { none: true })
    .edge("nw", "l1", undefined, { none: true })
    .edge("ne", "city", undefined, { none: true })
    .edge("city", "leaf", undefined, { none: true })
    .edge("se", "leaf2", undefined, { none: true })
    .panel(
      "Numbers",
      ["200 M businesses ÷ 100 per leaf ≈ 2 M leaves, ~2.7 M nodes", "Memory ≈ ids (1.6 GB) + nodes (~100 MB) → a few GB", "Build from scratch: a few minutes per server", "Query: descend to the leaf (depth ~20), then visit neighbouring leaves until k results"],
      5.2,
      0,
      { width: 420, tone: "info" },
    )
    .panel(
      "Keeping it fresh",
      ["Nightly rebuild into a new tree, then swap the pointer", "Incremental insert / delete under a lock for urgent changes", "Roll out new index versions server by server (blue/green) to avoid cold starts"],
      5.2,
      1.9,
      { width: 420 },
    )
    .build();
}

export default [
  { id: "architecture", name: "Architecture", build: architecture },
  { id: "search-flow", name: "Nearby search", build: searchFlow },
  { id: "geohash", name: "Geohash cells", build: geohash },
  { id: "quadtree", name: "Quadtree", build: quadtree },
] satisfies DiagramSpec[];
