import { Diagram } from "./dsl";

export default function proximityService() {
  return new Diagram("Proximity Service", "Read-heavy geo search: a precomputed geohash index answers \"what's near me\"")
    .node("user", "Mobile / web user", 0, 1, "client")
    .node("lb", "Load balancer", 1, 1, "edge")
    .node("search", "Location-based search service", 2, 0.3, "service")
    .node("biz", "Business service (CRUD, owners)", 2, 2.1, "service")
    .node("geo", "Geo index (geohash → ids, in memory)", 3, -0.4, "cache", { w: 1.1 })
    .node("cache", "Business details cache", 3, 0.9, "cache")
    .node("db", "Business DB (primary + read replicas)", 3, 2.1, "db", { w: 1.1 })
    .node("builder", "Index builder (CDC / nightly)", 4.3, 0.9, "worker")
    .edge("user", "lb", "search")
    .edge("lb", "search")
    .edge("lb", "biz", "owner updates")
    .edge("search", "geo", "1. nearby cells")
    .edge("search", "cache", "2. hydrate")
    .edge("biz", "db", "write")
    .edge("db", "builder", "changes", { async: true })
    .edge("builder", "geo", "rebuild", { async: true })
    .build();
}
