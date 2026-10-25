import { Diagram, Sequence, type DiagramSpec } from "../dsl";

function architecture() {
  return new Diagram("StatefulSet: PostgreSQL", "Each pod keeps a permanent name, its own DNS record and its own disk, even when it is restarted or moved")
    .node("sts", "StatefulSet postgres", 2.3, -1.25, "object", { detail: "serviceName: postgres · volumeClaimTemplates", icon: "layers" })
    .node("client", "orders-api", 0, 1, "service", { detail: "connects to postgres-0.postgres.fooddash" })
    .node("svc", "Headless Service postgres", 1.15, 1, "edge", { detail: "clusterIP: None → a DNS name per pod" })
    .node("p0", "postgres-0", 2.3, 0, "service", { detail: "always 'postgres-0', even after a restart", icon: "postgres" })
    .node("p1", "postgres-1", 2.3, 1, "service", { icon: "postgres" })
    .node("p2", "postgres-2", 2.3, 2, "service", { icon: "postgres" })
    .node("d0", "data-postgres-0", 3.5, 0, "storage", { detail: "50Gi gp3, re-attached forever" })
    .node("d1", "data-postgres-1", 3.5, 1, "storage")
    .node("d2", "data-postgres-2", 3.5, 2, "storage")
    .edge("sts", "p0", "creates 0 → 1 → 2, in order")
    .edge("client", "svc", "DNS lookup")
    .edge("svc", "p0")
    .edge("svc", "p1")
    .edge("svc", "p2")
    .edge("p0", "d0", "own disk")
    .edge("p1", "d1")
    .edge("p2", "d2")
    .panel(
      "Lockers, not a coat rack",
      ["A Deployment is a coat rack: any coat on any hook. A StatefulSet is a row of numbered lockers: locker 1 always holds the same person's things, even if its door is replaced."],
      0,
      2.25,
      { width: 520, tone: "warn" },
    )
    .build();
}

function orderedOps() {
  return new Sequence("Ordered operations", "A StatefulSet starts, updates and stops pods one at a time, in a fixed order")
    .actor("ctrl", "StatefulSet controller", "control", { icon: "workflow" })
    .actor("p0", "postgres-0", "service", { icon: "postgres" })
    .actor("p1", "postgres-1", "service", { icon: "postgres" })
    .actor("p2", "postgres-2", "service", { icon: "postgres" })
    .phase("Scale 0 → 3: start in order, each Ready before the next")
    .msg("ctrl", "p0", "create + PVC data-postgres-0")
    .msg("p0", "ctrl", "Ready", { reply: true })
    .msg("ctrl", "p1", "create + PVC data-postgres-1")
    .msg("p1", "ctrl", "Ready", { reply: true })
    .msg("ctrl", "p2", "create + PVC data-postgres-2")
    .phase("Rolling update: highest number first")
    .msg("ctrl", "p2", "replace with the new image, wait for Ready")
    .msg("ctrl", "p1", "replace, wait for Ready")
    .msg("ctrl", "p0", "replace last (partition: N lets you update only pods ≥ N first)")
    .phase("A pod dies")
    .msg("p1", "p1", "deleted or crashed", { error: true })
    .msg("ctrl", "p1", "recreate with the same name; re-attach data-postgres-1: rows still there")
    .phase("Scale 3 → 1: stop in reverse")
    .msg("ctrl", "p2", "delete (PVC kept)")
    .msg("ctrl", "p1", "delete (PVC kept)")
    .note("PVCs survive scale-down and deletion to protect your data, and you keep paying for them until you delete them yourself.", ["ctrl", "p2"], "warn")
    .build();
}

function comparison() {
  return new Diagram("Deployment vs StatefulSet", "Interchangeable replicas vs replicas that each have an identity")
    .zone("Deployment: orders-api", ["dsvc", "d1", "d2", "d3"], "#2f9e44")
    .zone("StatefulSet: kafka", ["k0", "k1", "k2", "kd0", "kd1", "kd2"], "#9c36b5")
    .node("dsvc", "ClusterIP Service", 0, 1, "edge", { detail: "any pod will do" })
    .node("d1", "orders-api-7d9f-x2k4q", 1.1, 0, "service", { detail: "random name" })
    .node("d2", "orders-api-7d9f-m81zp", 1.1, 1, "service", { detail: "started in parallel" })
    .node("d3", "orders-api-7d9f-q7c3d", 1.1, 2, "service", { detail: "no disk of its own" })
    .node("k0", "kafka-0", 2.5, 0, "service", { detail: "kafka-0.kafka.fooddash", icon: "kafka" })
    .node("k1", "kafka-1", 2.5, 1, "service", { detail: "kafka-1.kafka.fooddash", icon: "kafka" })
    .node("k2", "kafka-2", 2.5, 2, "service", { detail: "kafka-2.kafka.fooddash", icon: "kafka" })
    .node("kd0", "data-kafka-0", 3.6, 0, "storage")
    .node("kd1", "data-kafka-1", 3.6, 1, "storage")
    .node("kd2", "data-kafka-2", 3.6, 2, "storage")
    .edge("dsvc", "d1")
    .edge("dsvc", "d2")
    .edge("dsvc", "d3")
    .edge("k0", "kd0")
    .edge("k1", "kd1")
    .edge("k2", "kd2")
    .panel(
      "Differences",
      [
        "Names: random hash vs ordinal (-0, -1, -2)",
        "Start/stop: parallel vs ordered (unless podManagementPolicy: Parallel)",
        "Storage: shared or none vs one PVC per pod, kept on scale-down",
        "Network: Service VIP only vs a stable DNS name per pod",
        "Updates: surge-based vs reverse ordinal, with partition",
      ],
      0,
      3.1,
      { width: 760, tone: "info" },
    )
    .build();
}

function operatorBoundary() {
  return new Diagram("What a StatefulSet does NOT do", "Kubernetes gives identity and storage. Database know-how lives in an Operator, or you use a managed database")
    .node("sts", "StatefulSet", 0, 0, "object", { icon: "layers" })
    .node("op", "Operator (CloudNativePG, Strimzi)", 1.4, 0, "control", { icon: "workflow" })
    .node("rds", "Managed DB (RDS, MSK)", 2.8, 0, "external", { icon: "aws-rds" })
    .panel("Gives you", ["Stable names and DNS", "One disk per pod, re-attached", "Ordered start, stop and update"], 0, 0.75, { width: 300, tone: "good" })
    .panel("Never does", ["Replication between pods", "Promote a replica when the primary dies", "Backups, safe upgrades"], 0, 1.65, { width: 300, tone: "bad" })
    .panel("Adds the expert runbook", ["Sets up replication", "Automatic failover, updates the Service", "Backups to S3, rolling upgrades", "Uses StatefulSets or pods under the hood"], 1.4, 0.75, {
      width: 300,
      tone: "info",
    })
    .panel("Often the senior answer", ["Keep stateless apps in Kubernetes; let AWS run the database.", "“It depends, and here's the trade-off” wins interviews."], 2.8, 0.75, {
      width: 300,
      tone: "warn",
    })
    .build();
}

export default [
  { id: "architecture", name: "PostgreSQL StatefulSet", build: architecture },
  { id: "ordered-ops", name: "Ordered operations", build: orderedOps },
  { id: "comparison", name: "Deployment vs StatefulSet", build: comparison },
  { id: "operator-boundary", name: "What it doesn't do", build: operatorBoundary },
] satisfies DiagramSpec[];
