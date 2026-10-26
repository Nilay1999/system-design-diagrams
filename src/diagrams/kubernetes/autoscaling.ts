import { Diagram, Sequence, type DiagramSpec } from "../dsl";

function threeLayers() {
  return new Diagram("Three layers of autoscaling", "More pods (HPA, KEDA), bigger pods (VPA), and more machines when pods don't fit (Karpenter, Cluster Autoscaler)")
    .node("ms", "metrics-server", 0, 0, "worker", { detail: "CPU / memory, every 15s", icon: "gauge" })
    .node("lag", "Kafka consumer lag", 0, 1.3, "queue", { detail: "50,000 messages waiting", icon: "kafka" })
    .node("hpa", "HPA", 1.3, 0, "control", { detail: "more waiters", icon: "scale" })
    .node("keda", "KEDA", 1.3, 1.3, "control", { detail: "watch the queue outside, even scale to zero", icon: "scale" })
    .node("vpa", "VPA", 1.3, 2.6, "control", { detail: "a bigger tray: right-size requests", icon: "gauge" })
    .node("dep", "Deployments", 2.6, 0.65, "object", { detail: "replicas, requests", icon: "layers" })
    .node("pending", "Pending pods", 3.9, 0.65, "service", { detail: "no room on any node", highlight: true })
    .node("karp", "Karpenter / Cluster Autoscaler", 3.9, 2, "control", { detail: "another dining hall", icon: "server" })
    .node("nodes", "New nodes (EC2)", 5.2, 2, "worker", { detail: "Spot or On-Demand", icon: "aws-ec2" })
    .edge("ms", "hpa")
    .edge("lag", "keda")
    .edge("hpa", "dep", "replicas")
    .edge("keda", "dep", "replicas")
    .edge("vpa", "dep", "requests")
    .edge("dep", "pending", "new pods")
    .edge("karp", "pending", "watches")
    .edge("karp", "nodes", "launches")
    .edge("nodes", "pending", "scheduled", { async: true })
    .panel("Don't mix", ["VPA and HPA on the same CPU/memory metric fight each other. Many teams run VPA with updateMode: Off as a recommender."], 2.6, 2.6, {
      width: 360,
      tone: "warn",
    })
    .build();
}

function hpaLoop() {
  return new Sequence("The HPA control loop", "Every 15 seconds: read the metric, compute the desired replicas, change the Deployment")
    .actor("hpa", "HPA controller", "control", { icon: "scale" })
    .actor("ms", "metrics-server", "worker", { icon: "gauge" })
    .actor("dep", "Deployment orders-api", "object", { icon: "layers" })
    .loop("every 15s", "hpa", "dep")
    .msg("hpa", "ms", "average CPU of orders-api pods?")
    .msg("ms", "hpa", "90% of their CPU requests (4 pods)", { reply: true })
    .msg("hpa", "hpa", "desired = ceil(4 × 90 / 60) = 6 (target 65% → 6)")
    .msg("hpa", "dep", "scale replicas 4 → 6 (within minReplicas 3, maxReplicas 30)")
    .end()
    .phase("Load drops at 11 PM")
    .msg("hpa", "hpa", "desired = 3, but scaleDown stabilizationWindowSeconds 300: wait 5 minutes to avoid flapping")
    .msg("hpa", "dep", "scale 6 → 3")
    .note("Utilization is a percentage of the pod's CPU REQUEST. No requests → the HPA shows <unknown> and does nothing.", ["hpa", "dep"], "warn")
    .build();
}

function dinnerRush() {
  return new Sequence("FoodDash at 8:30 PM", "Pods and nodes scale together, then shrink back when dinner is over")
    .actor("users", "Hungry customers", "client", { icon: "users" })
    .actor("hpa", "HPA", "control", { icon: "scale" })
    .actor("sched", "Scheduler", "control", { icon: "clock" })
    .actor("karp", "Karpenter", "control", { icon: "server" })
    .actor("aws", "AWS EC2", "external", { icon: "aws-ec2" })
    .actor("pods", "orders-api pods", "service")
    .msg("users", "pods", "orders rise; CPU passes 65%")
    .msg("hpa", "pods", "replicas 6 → 14")
    .msg("sched", "sched", "9 placed, 5 don't fit → Pending")
    .msg("karp", "aws", "launch 2 right-sized nodes (Spot where allowed)")
    .msg("aws", "karp", "nodes ready in ~1–2 minutes", { reply: true })
    .msg("sched", "pods", "bind the 5 pending pods; they pass readiness and join the Service")
    .phase("11 PM")
    .msg("hpa", "pods", "load drops; after the 5-minute window, 14 → 6")
    .msg("karp", "aws", "consolidate: move pods, remove spare nodes")
    .note("Autoscaling isn't instant (new nodes + JVM warm-up). For known peaks, pre-scale with a scheduled minimum, e.g. a KEDA cron trigger at 7:45 PM.", ["users", "pods"], "info")
    .build();
}

function kedaKafka() {
  return new Diagram("KEDA on Kafka consumer lag", "CPU is a poor signal for a consumer: it can sit at 20% while 50,000 messages wait")
    .node("topic", "order-events", 0, 1, "queue", { detail: "12 partitions · lag 6,000", icon: "kafka" })
    .node("keda", "KEDA ScaledObject", 1.35, -0.25, "control", { detail: "lagThreshold 500, min 0, max 12", icon: "scale" })
    .node("pods", "notification-worker ×12", 1.35, 1, "service", { detail: "one partition each" })
    .node("idle", "pod 13", 1.35, 2.25, "service", { detail: "would sit idle: no partition left", highlight: true })
    .edge("keda", "topic", "reads lag")
    .edge("keda", "pods", "scale 0–12")
    .edge("topic", "pods", "consume")
    .panel(
      "Why cap at 12",
      ["In a consumer group, a partition is read by only one consumer. With 12 partitions, consumer 13 gets nothing.", "Need more throughput? Add partitions ahead of a sale, not pods during it."],
      2.7,
      0,
      { width: 380, tone: "info" },
    )
    .panel("Database too", ["30 pods × 20 connections = 600 connections: more than PostgreSQL allows. Use PgBouncer or RDS Proxy."], 2.7, 1.45, {
      width: 380,
      tone: "warn",
    })
    .build();
}

export default [
  { id: "three-layers", name: "Three layers", build: threeLayers },
  { id: "hpa-loop", name: "HPA loop", build: hpaLoop },
  { id: "dinner-rush", name: "8:30 PM rush", build: dinnerRush },
  { id: "keda-kafka", name: "KEDA on Kafka", build: kedaKafka },
] satisfies DiagramSpec[];
