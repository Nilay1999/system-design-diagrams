import { Diagram } from "./dsl";

export default function messageQueue() {
  return new Diagram("Distributed Message Queue", "Kafka-style: partitioned, replicated append-only logs; consumers pull by offset")
    .zone("Broker cluster", 1.5, 0, 1, 3, "#e8590c")
    .node("producers", "Producers", 0, 1, "client")
    .node("controller", "Controller (KRaft quorum) metadata, leader election", 1.5, -1.3, "service", { w: 1.1 })
    .node("b1", "Broker 1 P0 leader · P2 follower", 1.5, 0, "queue")
    .node("b2", "Broker 2 P1 leader · P0 follower", 1.5, 1, "queue")
    .node("b3", "Broker 3 P2 leader · P1 follower", 1.5, 2, "queue")
    .node("tiered", "Tiered storage (S3) old segments", 1.5, 3.3, "storage")
    .node("cgA", "Consumer group A (billing)", 3.1, 0.5, "worker")
    .node("cgB", "Consumer group B (analytics)", 3.1, 1.5, "worker")
    .edge("producers", "b1", "produce")
    .edge("producers", "b2", "key → partition")
    .edge("producers", "b3")
    .edge("controller", "b1", undefined, { async: true })
    .edge("b1", "cgA", "fetch(offset)")
    .edge("b2", "cgA")
    .edge("b2", "cgB")
    .edge("b3", "cgB", "fetch(offset)")
    .edge("b3", "tiered", "offload", { async: true })
    .steps(
      "Guarantees",
      [
        "Ordering per partition, not per topic",
        "acks=all + min.insync.replicas=2 → no loss on 1 failure",
        "Each partition read by one consumer per group",
        "Consumers commit offsets → at-least-once",
        "Idempotent producer + transactions → exactly-once",
      ],
      4.3,
      -0.3,
    )
    .build();
}
