import { Diagram, Sequence, type DiagramSpec } from "../dsl";

function operatorLoop() {
  return new Diagram("CRD + controller = Operator", "A CRD teaches Kubernetes a new kind of object; an Operator watches those objects and does an expert's job, forever")
    .node("crd", "CRD clusters.postgresql.cnpg.io", 0, 0, "object", { detail: "adds a new API type", icon: "file" })
    .node("cr", "Cluster orders-db", 0, 1.3, "object", { detail: "instances: 3 · storage 50Gi · backups to S3", icon: "postgres" })
    .node("op", "CloudNativePG operator", 1.4, 1.3, "control", { detail: "watch → compare → act", icon: "workflow" })
    .node("pods", "PostgreSQL pods + PVCs", 2.8, 0.3, "service", { detail: "1 primary, 2 replicas", icon: "postgres" })
    .node("svc", "Services -rw / -ro", 2.8, 1.3, "edge", { detail: "apps always reach the current primary" })
    .node("job", "Backups", 2.8, 2.3, "worker", { detail: "base backups + WAL archive", icon: "aws-s3" })
    .edge("crd", "cr", "defines")
    .edge("op", "cr", "watch", { both: true })
    .edge("op", "pods", "creates, heals")
    .edge("op", "svc", "points at primary")
    .edge("op", "job", "schedules")
    .panel("Sushi-counter analogy", ["Add 'sushi order' to the order form (CRD) and hire a sushi master who watches for those orders and knows what to do when the rice cooker breaks (Operator)."], 4.15, 0.3, {
      width: 340,
      tone: "warn",
    })
    .build();
}

function cnpgFailover() {
  return new Sequence("Automatic failover", "The primary dies at 9 PM. The operator does what an on-call DBA would, in seconds")
    .actor("app", "orders-api", "service")
    .actor("svc", "Service orders-db-rw", "edge")
    .actor("op", "CNPG operator", "control", { icon: "workflow" })
    .actor("p1", "orders-db-1 (primary)", "service", { icon: "postgres" })
    .actor("p2", "orders-db-2 (replica)", "service", { icon: "postgres" })
    .msg("p1", "p1", "node failure", { error: true })
    .msg("app", "svc", "writes fail for a few seconds", { error: true })
    .msg("op", "p2", "health checks: primary gone → promote the most up-to-date replica")
    .msg("p2", "op", "now primary", { reply: true })
    .msg("op", "svc", "repoint orders-db-rw to orders-db-2")
    .msg("app", "svc", "reconnect (connection pool retries) → writes succeed")
    .msg("op", "p1", "later: rebuild orders-db-1 as a new replica")
    .note("This is the same reconcile loop Kubernetes uses everywhere, applied to your database's runbook.", ["app", "p2"], "good")
    .build();
}

function ecosystem() {
  const d = new Diagram("Much of the ecosystem is 'a CRD plus a controller'", "Operators you'll meet in real jobs, and the custom objects you write for them");
  const pairs: [string, string, string, string][] = [
    ["Kafka, KafkaTopic", "Strimzi", "Kafka clusters, topics and users", "kafka"],
    ["Certificate, Issuer", "cert-manager", "TLS certificates, auto-renewed", "lock"],
    ["ServiceMonitor", "Prometheus Operator", "what to scrape", "prometheus"],
    ["ExternalSecret", "External Secrets Operator", "secrets from AWS / Vault", "key"],
    ["Application", "Argo CD", "point the cluster at Git", "git-branch"],
    ["NodePool", "Karpenter", "which nodes to launch", "server"],
    ["ScaledObject", "KEDA", "event-driven scaling", "scale"],
  ];
  pairs.forEach(([kind, controller, job, icon], i) => {
    const col = i % 2 === 0 ? 0 : 2.6;
    const row = Math.floor(i / 2) * 1.05;
    d.node(`k${i}`, kind, col, row, "object", { icon: "file" })
      .node(`c${i}`, controller, col + 1.2, row, "control", { detail: job, icon: icon as never })
      .edge(`c${i}`, `k${i}`, "watches");
  });
  return d
    .panel("Write your own", ["Kubebuilder or Operator SDK (Go). A ScheduledScaling CRD that scales Deployments before the dinner rush is a great portfolio project."], 2.6, 3.15, {
      width: 400,
      tone: "info",
    })
    .build();
}

export default [
  { id: "operator-loop", name: "How an Operator works", build: operatorLoop },
  { id: "cnpg-failover", name: "Automatic failover", build: cnpgFailover },
  { id: "ecosystem", name: "Operators you'll meet", build: ecosystem },
] satisfies DiagramSpec[];
