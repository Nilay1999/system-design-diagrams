import { Diagram, type DiagramSpec } from "../dsl";

function studyPlan() {
  const d = new Diagram("8-week plan to CKAD", "10–12 hours a week. Each week ends with a checkpoint you can actually test", { icons: false });
  const weeks: [string, string][] = [
    ["Foundations, architecture, pods", "Explain the kubectl apply flow aloud in 3 minutes"],
    ["Deployments, Services, DNS", "Debug a broken Service selector in under 5 minutes"],
    ["Config, Secrets, StatefulSets", "Run your own Spring Boot app with config + Postgres"],
    ["Scheduling, scaling, security", "Write HPA, PDB, Role and NetworkPolicy YAML from memory"],
    ["Troubleshooting + Helm; start the capstone", "Fix 10 'break it' scenarios using only kubectl"],
    ["Gateway API, KEDA, Argo CD in the capstone", "Capstone deploys from Git with one command"],
    ["Observability, failure tests; first killer.sh", "Simulator score noted, weak domains listed"],
    ["Timed drills, review weak spots", "Sit CKAD; publish the capstone repo"],
  ];
  weeks.forEach(([read, check], i) => {
    const col = (i % 4) * 1.2;
    const row = i < 4 ? 0 : 1.6;
    d.node(`w${i}`, `Week ${i + 1}`, col, row, i === 7 ? "service" : "object", { detail: [read, `✓ ${check}`] });
    if (i > 0 && i !== 4) d.edge(`w${i - 1}`, `w${i}`);
  });
  return d
    .edge("w3", "w4", undefined, { via: [[3.6, 0.8], [0, 0.8]] })
    .panel("Exam technique", ["alias k=kubectl; export do='--dry-run=client -o yaml'", "Generate YAML, never write it from scratch", "Check the context in every question", "Skip low-value questions taking more than 5 minutes"], 4.9, 0, {
      width: 380,
      tone: "info",
    })
    .build();
}

function capstone() {
  return new Diagram("Capstone: an end-to-end project", "A small event-driven platform deployed the way a production team would")
    .zone("kind or EKS cluster", ["gw", "orders", "pg", "kafka", "inv", "redis", "argo", "obs"], "#326ce5")
    .node("git", "GitHub: code + Helm chart", 0, 2.2, "client", { detail: "Actions: build, Trivy scan, push", icon: "git-branch" })
    .node("gw", "Gateway API", 1.4, 0, "edge", { detail: "HTTPRoute, 90/10 canary" })
    .node("orders", "orders-api (Spring Boot)", 2.6, 0, "service", { detail: "HPA, probes, PDB, topology spread" })
    .node("pg", "PostgreSQL", 3.85, 0, "db", { detail: "CloudNativePG operator", icon: "postgres" })
    .node("kafka", "Kafka", 2.6, 1.2, "queue", { detail: "Strimzi operator", icon: "kafka" })
    .node("inv", "inventory-service (Node/Go)", 3.85, 1.2, "service", { detail: "KEDA on consumer lag" })
    .node("redis", "Redis", 5.05, 1.2, "cache")
    .node("argo", "Argo CD", 1.4, 2.2, "control", { detail: "syncs from Git", icon: "refresh" })
    .node("obs", "Prometheus + Grafana + OTel", 3.85, 2.4, "worker", { icon: "grafana" })
    .edge("gw", "orders", "/orders")
    .edge("orders", "pg", "writes")
    .edge("orders", "kafka", "OrderCreated", { async: true })
    .edge("kafka", "inv", undefined, { async: true })
    .edge("inv", "redis", "cache")
    .edge("git", "argo", "pull", { async: true })
    .panel(
      "Prove it works",
      ["Kill pods and a node during a load test: 0 failed requests", "Default-deny NetworkPolicies, restricted Pod Security, one ServiceAccount per app", "External Secrets with a local Vault (bonus)", "docs/architecture.md: diagram, decisions, failure tests"],
      0,
      3.45,
      { width: 560, tone: "good" },
    )
    .build();
}

function answerShape() {
  return new Diagram("How to reason through a scenario", "Think at three depths: definitions, mechanisms and judgement. Aim for the last two", { icons: false })
    .node("req", "1. Requirements", 0, 0, "client", { detail: "traffic, availability target, data" })
    .node("arch", "2. Architecture", 1.15, 0, "object", { detail: "draw it: the diagram tabs are your practice" })
    .node("prim", "3. Kubernetes primitives", 2.3, 0, "control", { detail: "which objects, and why" })
    .node("fail", "4. Failure modes", 3.45, 0, "service", { detail: "node, zone, dependency, bad deploy", highlight: true })
    .node("obs", "5. Observability", 4.6, 0, "worker", { detail: "how you'd know, SLO alerts" })
    .edge("req", "arch")
    .edge("arch", "prim")
    .edge("prim", "fail")
    .edge("fail", "obs")
    .panel(
      "Example: payments at 99.95% on EKS",
      [
        "3 AZs, topology spread, PDB, maxUnavailable 0",
        "HPA + Karpenter headroom, business-critical priority",
        "Idempotency keys, outbox for events",
        "RDS Multi-AZ instead of an in-cluster database",
        "SLO-based alerts on checkout errors and p99",
      ],
      0,
      0.85,
      { width: 560, tone: "info" },
    )
    .panel("Lab vs production", ["A lab is not production. Test failures in the capstone, but expect real traffic to surprise you."], 1.85, 0.85, {
      width: 380,
      tone: "warn",
    })
    .build();
}

export default [
  { id: "study-plan", name: "8-week plan", build: studyPlan },
  { id: "capstone", name: "Capstone project", build: capstone },
  { id: "answer-shape", name: "Answering scenarios", build: answerShape },
] satisfies DiagramSpec[];
