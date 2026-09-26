import { Diagram } from "./dsl";

export default function fundamentals() {
  return new Diagram("Generic scalable web architecture", "The building blocks most designs are assembled from")
    .zone("Edge", 1, 0, 1, 4, "#6741d9")
    .zone("Stateless app tier (auto-scaled)", 2, 1, 1, 2, "#2f9e44")
    .zone("Data tier", 3, 0.5, 2, 3.2, "#e67700")
    .node("client", "Web / Mobile client", 0, 1.5, "client")
    .node("dns", "DNS (GeoDNS)", 1, 0, "edge")
    .node("lb", "Load balancer (L7)", 1, 1.5, "edge")
    .node("cdn", "CDN", 1, 3, "edge")
    .node("app1", "App server 1", 2, 1, "service")
    .node("app2", "App server N", 2, 2, "service")
    .node("blob", "Object storage (S3)", 2, 3.6, "storage")
    .node("cache", "Cache (Redis)", 3, 0.5, "cache")
    .node("db", "Primary DB", 3, 1.6, "db")
    .node("replica", "Read replicas", 4, 1.6, "db")
    .node("queue", "Message queue", 3, 2.7, "queue")
    .node("worker", "Background workers", 4, 2.7, "worker")
    .edge("client", "dns", "1. resolve")
    .edge("client", "lb", "2. HTTPS")
    .edge("client", "cdn", "static assets")
    .edge("cdn", "blob", "origin pull")
    .edge("lb", "app1")
    .edge("lb", "app2")
    .edge("app1", "cache", "read-through")
    .edge("app1", "db", "writes")
    .edge("app2", "db")
    .edge("db", "replica", "replication", { async: true })
    .edge("app2", "queue", "enqueue job", { async: true })
    .edge("queue", "worker", "consume", { async: true })
    .steps(
      "Scaling levers",
      [
        "Scale the app tier horizontally; keep it stateless",
        "Cache hot reads close to the app",
        "Offload reads to replicas",
        "Shard the primary when writes outgrow one node",
        "Move slow work to queues + workers",
        "Serve static bytes from the CDN",
      ],
      5.3,
      0.3,
    )
    .build();
}
