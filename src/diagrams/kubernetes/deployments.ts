import { Diagram, Sequence, type DiagramSpec } from "../dsl";

function ownership() {
  return new Diagram("Deployment → ReplicaSet → Pods", "You edit the Deployment. It keeps one ReplicaSet per version of the pod template; each ReplicaSet keeps N pods alive")
    .node("dep", "Deployment orders-api", 0, 1.35, "object", { detail: ["replicas: 3", "strategy: RollingUpdate"], icon: "layers" })
    .node("rsOld", "ReplicaSet orders-api-7d9f8", 1.35, 0.35, "object", { detail: "v1.4 · scaled to 0, kept for rollback", icon: "boxes" })
    .node("rsNew", "ReplicaSet orders-api-5c6b2", 1.35, 2.35, "object", { detail: "v1.5 · wants 3, has 3", icon: "boxes" })
    .node("p1", "orders-api-5c6b2-x2k4q", 2.7, 1.35, "service", { icon: "box" })
    .node("p2", "orders-api-5c6b2-m81zp", 2.7, 2.35, "service", { icon: "box" })
    .node("p3", "orders-api-5c6b2-q7c3d", 2.7, 3.35, "service", { icon: "box" })
    .edge("dep", "rsOld", "owns")
    .edge("dep", "rsNew", "owns")
    .edge("rsNew", "p1", "selector: app + pod-template-hash")
    .edge("rsNew", "p2")
    .edge("rsNew", "p3")
    .panel(
      "Who does what",
      [
        "ReplicaSet = the supervisor: 'always 3 on the floor'. One sick? Start a replacement. 4 showed up? Send one home.",
        "Deployment = HR: brings in newly trained agents a few at a time, keeps old ReplicaSets for instant rollback.",
        "Only a pod-template change (image, env, annotation) creates a new ReplicaSet. Changing replicas does not.",
      ],
      2.7,
      -0.15,
      { width: 380, tone: "info" },
    )
    .build();
}

function rollingUpdate() {
  return new Sequence("Rolling update: 4 replicas, maxSurge 1, maxUnavailable 0", "Updating orders-api from 1.4 to 1.5 without ever dropping below 4 ready pods")
    .actor("you", "You / CI", "client")
    .actor("dc", "Deployment controller", "control", { icon: "workflow" })
    .actor("old", "ReplicaSet v1.4", "object", { icon: "boxes" })
    .actor("new", "ReplicaSet v1.5", "object", { icon: "boxes" })
    .actor("svc", "Service endpoints", "edge")
    .msg("you", "dc", "kubectl set image deploy/orders-api app=fooddash/orders-api:1.5.0")
    .msg("dc", "new", "template changed → create ReplicaSet v1.5 (replicas 0)")
    .loop("until all 4 run 1.5", "dc", "svc")
    .msg("dc", "new", "scale up +1 (5 pods total: 4 old + 1 new, that's maxSurge)")
    .msg("new", "svc", "new pod passes readiness and stays Ready for minReadySeconds → added", { async: true })
    .msg("dc", "old", "scale down −1 (back to 4)")
    .end()
    .alt("a new pod never becomes Ready", "you", "svc")
    .msg("dc", "dc", "rollout stops; old pods keep serving (maxUnavailable 0)")
    .msg("dc", "you", "after progressDeadlineSeconds: Progressing=False, ProgressDeadlineExceeded", { error: true })
    .msg("you", "dc", "kubectl rollout undo: Kubernetes never rolls back by itself")
    .end()
    .note("The readiness probe is the safety gate. Without it, a broken version counts as 'successful' the moment its container starts.", ["you", "svc"], "warn")
    .build();
}

function strategies() {
  const d = new Diagram("Release strategies compared", "All four move traffic from v1.4 to v1.5; they differ in risk, cost and how fast you can undo");
  const rows: [string, string, string, string, string, string[], "good" | "warn" | "info" | "bad"][] = [
    ["roll", "Rolling update (default)", "v1.4 pods, shrinking", "v1.5 pods, growing", "most → some", ["Replace a few at a time, gated by readiness.", "Cost: none extra. Catch: both versions live at once."], "good"],
    ["rec", "Recreate", "v1.4: all killed first", "v1.5: starts after", "nothing (downtime)", ["Kill everything, then start the new version.", "For apps that can't run two versions at once."], "bad"],
    ["bg", "Blue / green", "blue: v1.4, full size", "green: v1.5, full size", "flip the selector", ["Two Deployments; switch the Service selector.", "Instant switch and rollback; double capacity during the switch."], "info"],
    ["can", "Canary", "stable v1.4", "canary v1.5", "95% / 5%", ["Small share first, watch error rate and latency, then 25% → 50% → 100%.", "Gateway API weights, Argo Rollouts or Flagger automate it."], "warn"],
  ];
  rows.forEach(([id, title, oldLabel, newLabel, split, notes, tone], i) => {
    const b = i * 1.85;
    d.zone(title, [`${id}Svc`, `${id}Old`, `${id}New`], "#868e96")
      .node(`${id}Svc`, "Service", 0, b + 0.35, "edge", { w: 0.75 })
      .node(`${id}Old`, oldLabel, 1.05, b, "service", { w: 0.9 })
      .node(`${id}New`, newLabel, 1.05, b + 0.7, "service", { w: 0.9, highlight: id === "rec" })
      .edge(`${id}Svc`, `${id}Old`)
      .edge(`${id}Svc`, `${id}New`, split)
      .panel(title, notes, 2.15, b - 0.05, { width: 420, tone });
  });
  return d.build();
}

function expandContract() {
  return new Diagram("Expand and contract", "During a rollout, v1.4 and v1.5 share one database. Rename a column in one step and every old pod breaks")
    .node("s1", "Release 1.5: expand", 0, 0, "service", { detail: "ADD COLUMN total_amount; write both columns" })
    .node("s2", "Backfill Job", 1.2, 0, "worker", { detail: "copy amount → total_amount for old rows" })
    .node("s3", "Release 1.6", 2.4, 0, "service", { detail: "read total_amount" })
    .node("s4", "Release 1.7: contract", 3.6, 0, "service", { detail: "DROP COLUMN amount" })
    .edge("s1", "s2")
    .edge("s2", "s3")
    .edge("s3", "s4")
    .table("t1", "orders (1.4 + 1.5 live)", ["order_id      PK", "amount        1.4 reads", "total_amount  1.5 writes"], 0, 0.85)
    .table("t2", "orders (backfilled)", ["order_id      PK", "amount", "total_amount  filled"], 1.2, 0.85)
    .table("t3", "orders (1.6 live)", ["order_id      PK", "amount        unused", "total_amount  read"], 2.4, 0.85)
    .table("t4", "orders (final)", ["order_id      PK", "total_amount"], 3.6, 0.85)
    .panel(
      "What breaks without it",
      ["Release 1.5 renames amount → total_amount in one migration. Every 1.4 pod still serving traffic fails immediately.", "Same rule for API contracts and Kafka message schemas: stay backward-compatible for at least one version."],
      0,
      2.05,
      { width: 700, tone: "bad" },
    )
    .build();
}

export default [
  { id: "ownership", name: "Deployment → ReplicaSet → Pods", build: ownership },
  { id: "rolling-update", name: "Rolling update", build: rollingUpdate },
  { id: "strategies", name: "Release strategies", build: strategies },
  { id: "expand-contract", name: "Expand & contract", build: expandContract },
] satisfies DiagramSpec[];
